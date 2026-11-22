import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The CDP layer is a controllable stub; browser-host.ts itself is real.
register(new URL("./helpers/browser-cdp-stub-hook.mjs", import.meta.url).href);
const { BrowserHost } = await import("../electron/main/browser-host.ts");
const { BrowserCdp } = await import("./helpers/browser-cdp-stub.mjs");

const settled = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ immediateRoots = true } = {}) {
  const roots = [], loads = [], panes = [], published = [], reveals = [];
  const createPane = (onState) => {
    let state = null;
    const wc = { isDestroyed: () => false };
    const pane = {
      visible: false, disposed: false, boundsSet: [],
      setWindow: () => {},
      setBounds(bounds) { this.boundsSet.push({ ...bounds }); },
      setVisible(value) { this.visible = value; },
      getState: () => state,
      getWebContents: () => (pane.disposed ? null : wc),
      invalidateNavigation: () => {},
      captureScreenshot: (run) => run(wc),
      navigateAndWait(target, _fileRoot) {
        const done = deferred();
        loads.push({ target, pane, finish() {
          state = { url: target, title: target, isLoading: false, canGoBack: false, canGoForward: false };
          onState(state); done.resolve(state);
        }, fail: () => done.resolve(null) });
        return done.promise;
      },
      dispose() { this.visible = false; this.disposed = true; },
    };
    panes.push(pane);
    return pane;
  };
  const host = new BrowserHost({
    createPane, isPluginLoaded: () => true,
    getFileRoots(sessionId) {
      if (immediateRoots) return Promise.resolve([`/projects/${sessionId}`]);
      const done = deferred(); roots.push({ sessionId, ...done }); return done.promise;
    },
    getScratchDir: () => null,
    onState: (state) => published.push(state),
    onRevealView: (sessionId, tabId) => reveals.push({ sessionId, tabId }),
  });
  host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible: true,
    bounds: { x: 100, y: 20, width: 400, height: 600 },
  });
  host.setGuestHole("pi.browser", { x: 0, y: 30, width: 400, height: 570 });
  return { host, roots, loads, panes, published, reveals };
}

// A call that never settles is a baseline failure, not a pass: race it so a
// hanging implementation fails fast instead of stalling the whole file.
function rejectsSoon(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} hung instead of failing clearly`)), 1_000);
  });
  return Promise.race([promise, timeout]).then(
    () => { throw new Error(`${label} resolved instead of failing`); },
    (error) => {
      clearTimeout(timer);
      assert.equal(error?.code, "UNAVAILABLE", `${label} fails clearly, got: ${error?.message ?? error}`);
    },
  );
}

async function open(h, sessionId, tabId, url) {
  const before = BrowserCdp.current;
  h.host.setChromeSession(sessionId, tabId, url);
  const cdp = BrowserCdp.current !== before ? BrowserCdp.current : before;
  if (h.roots.length) h.roots.at(-1)?.resolve?.(`/projects/${sessionId}`);
  await settled(); h.loads.at(-1).finish(); await settled();
  return cdp;
}

// Drive one immediate-root navigation to completion the way open() does.
async function navDone(h, input, sessionId, tabId) {
  const pending = h.host.navigate(input, sessionId, tabId);
  await settled();
  h.loads.at(-1).finish();
  await settled();
  return pending;
}

test("background navigation binds the caller's own page while another session stays visible", async () => {
  const h = harness();
  await open(h, "A", "a", "https://fixture.invalid/a");
  const cdpA = BrowserCdp.current;
  await open(h, "B", "b", "https://fixture.invalid/b");
  const cdpB = BrowserCdp.current;
  const loadsBefore = h.loads.length;

  // Caller A is in the background; B owns the visible hole.
  const state = await navDone(h, { url: "https://fixture.invalid/a-2" }, "A");
  assert.equal(state.url, "https://fixture.invalid/a-2");
  assert.equal(h.host.getContext().sessionId, "B", "execution must not move the presentation");
  assert.deepEqual(h.reveals, [], "execution must not request a reveal");
  assert.equal(h.loads.length, loadsBefore + 1, "exactly one new navigation for the caller's page");

  h.host.setChromeSession("A", "a");
  assert.equal(h.host.getState().url, "https://fixture.invalid/a-2");
  h.host.setChromeSession("B", "b");
  assert.equal(h.host.getState().url, "https://fixture.invalid/b", "B is untouched");
  assert.deepEqual(cdpB.calls, [], "no CDP touched B's page");
  assert.ok(cdpA instanceof BrowserCdp);
});

test("hidden snapshot/evaluate/click/fill/screenshot/console/cdp route to the caller's page", async () => {
  const h = harness();
  await open(h, "A", "a", "https://fixture.invalid/a");
  const cdpA = BrowserCdp.current;
  await open(h, "B", "b", "https://fixture.invalid/b");
  const cdpB = BrowserCdp.current;

  // A navigates while B is visible, then every read/write op targets A.
  await navDone(h, { url: "https://fixture.invalid/a-2" }, "A");
  h.host.setGuestHole("pi.browser", { x: 0, y: 30, width: 400, height: 570 });
  const snapshot = await h.host.snapshot("A");
  assert.equal(snapshot.url, "fixture://page");
  const evaluated = await h.host.evaluate("document.title", "A");
  assert.deepEqual(evaluated, { expression: "document.title" });
  await h.host.click("e1", "A");
  await h.host.fill("e2", "hello", "A");
  const shot = await h.host.screenshot({ fullPage: true }, "A");
  assert.equal(shot.mimeType, "image/jpeg");
  assert.deepEqual(h.host.console(undefined, "A"), { messages: [] });
  await h.host.cdpCommand("Page.enable", {}, "A");
  for (const method of ["snapshot", "evaluate", "click", "fill", "screenshot", "attach", "Page.enable"]) {
    assert.ok(cdpA.calls.includes(method), `A page saw ${method}`);
  }
  assert.deepEqual(cdpB.calls, [], "B's DOM was never observed or edited");
  assert.equal(h.host.getContext().sessionId, "B");
});

test("hidden operations work while the work panel itself is hidden, without reveal", async () => {
  const h = harness();
  await open(h, "A", "a", "https://fixture.invalid/a");
  await open(h, "B", "b", "https://fixture.invalid/b");
  h.host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible: false,
    bounds: { x: 100, y: 20, width: 400, height: 600 },
  });

  const state = await navDone(h, { url: "https://fixture.invalid/a-hidden" }, "A");
  assert.equal(state.url, "https://fixture.invalid/a-hidden");
  const snapshot = await h.host.snapshot("A");
  assert.equal(snapshot.url, "fixture://page");
  assert.deepEqual(h.reveals, [], "no reveal is requested for hidden execution");
});

test("calls with neither runtime session nor chrome context fail clearly", async () => {
  const h = harness();
  await rejectsSoon(h.host.navigate({ url: "https://fixture.invalid/nowhere" }), "context-less navigate");
  await rejectsSoon(h.host.snapshot(), "context-less snapshot");
  await rejectsSoon(h.host.evaluate("1+1"), "context-less evaluate");
  await rejectsSoon(h.host.click("e1"), "context-less click");
  await rejectsSoon(h.host.cdpCommand("Page.enable"), "context-less cdp");
  assert.equal(h.host.getState(), null);
  assert.equal(h.loads.length, 0, "a context-less call must not navigate any page");
});

test("concurrent async navigations stay pinned to their entry target across a foreground switch", async () => {
  const h = harness({ immediateRoots: false });
  h.host.setChromeSession("A", "a", "https://fixture.invalid/a-seed");
  h.host.setChromeSession("B", "b", "https://fixture.invalid/b-seed");
  h.roots.at(-1).resolve("/projects/B"); await settled(); h.loads.at(-1).finish(); await settled();
  h.roots.at(0).resolve("/projects/A"); await settled(); h.loads.at(-1).finish(); await settled();

  const navA = h.host.navigate({ url: "https://fixture.invalid/a-late" }, "A");
  const rootA = h.roots.at(-1);
  // Foreground switches to B while A's lookup is still in flight.
  h.host.setChromeSession("B", "b");
  const navB = h.host.navigate({ url: "https://fixture.invalid/b-late" }, "B");
  const rootB = h.roots.at(-1);
  rootB.resolve("/projects/B"); await settled(); h.loads.at(-1).finish(); await navB;
  rootA.resolve("/projects/A"); await settled(); h.loads.at(-1).finish(); await navA;

  assert.equal(h.host.getContext().sessionId, "B", "racing execution never moves the presentation");
  h.host.setChromeSession("A", "a");
  assert.equal(h.host.getState().url, "https://fixture.invalid/a-late");
  h.host.setChromeSession("B", "b");
  assert.equal(h.host.getState().url, "https://fixture.invalid/b-late");
});

test("closing a session and disposing the host release background pages and fail later calls", async () => {
  const h = harness();
  await open(h, "A", "a", "https://fixture.invalid/a");
  await open(h, "B", "b", "https://fixture.invalid/b");
  await navDone(h, { url: "https://fixture.invalid/a-2" }, "A");

  h.host.closeTab("A", "a");
  assert.equal(h.panes[0].disposed, true);
  await assert.rejects(h.host.snapshot("A"), (e) => e?.code === "UNAVAILABLE");

  await navDone(h, { url: "https://fixture.invalid/b-2" }, "B");
  h.host.closeSession("B");
  await assert.rejects(h.host.snapshot("B"), (e) => e?.code === "UNAVAILABLE");
  h.host.disposeGuest();
  assert.ok(h.panes.every((pane) => pane.disposed), "dispose releases every owned page");
  assert.equal(h.host.getState(), null);
});

test("a first snapshot or evaluate before navigation fails well", async () => {
  const h = harness();
  h.host.setChromeSession("B", "b", "https://fixture.invalid/b");
  if (h.roots.length) h.roots.at(-1)?.resolve?.("/projects/B");
  await settled(); h.loads.at(-1).finish(); await settled();

  await assert.rejects(h.host.snapshot("fresh"), (e) => e?.code === "UNAVAILABLE" && /navigate/i.test(e.message));
  await assert.rejects(h.host.evaluate("document.title", "fresh"), (e) => e?.code === "UNAVAILABLE");
  assert.equal(h.loads.length, 1, "a failed first read must not start a navigation");
});

test("background pages get a stable viewport without attaching or focusing", async () => {
  const h = harness();
  await open(h, "A", "a", "https://fixture.invalid/a");
  const paneA = h.panes.at(-1);
  await open(h, "B", "b", "https://fixture.invalid/b");
  paneA.boundsSet.length = 0;
  await navDone(h, { url: "https://fixture.invalid/a-2" }, "A");
  assert.equal(paneA.visible, false, "the background page is never attached");
  assert.ok(paneA.boundsSet.length > 0, "the background page is given a layout size");
  const last = paneA.boundsSet.at(-1);
  assert.ok(last.width >= 320 && last.width <= 3840, `sane width: ${last.width}`);
  assert.ok(last.height >= 240 && last.height <= 2160, `sane height: ${last.height}`);
  assert.equal(h.host.getContext().sessionId, "B");
});
