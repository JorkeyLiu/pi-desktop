import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import test from "node:test";

// Electron is the external boundary; the preview focus watch in the
// production BrowserPane runs against these fakes, without opening a native
// window. The theft itself (guest `isFocused()` flipping true after the
// commit while the owner loses it) replays the isolated Electron fixture's
// runtime evidence: committing `loadURL` in the visible attached guest moves
// native focus after a variable delay, while the shell document keeps a
// stale `activeElement`. Event shapes follow the installed Electron 43
// types: keyboard on `before-input-event`, mouse on `before-mouse-event`,
// touch and tap gestures on `input-event`, focus loss on `blur`.
const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const shell = {
    openedPaths: [],
    openPath(path) { this.openedPaths.push(path); return Promise.resolve(""); },
    openExternal() { return Promise.resolve(); },
  };
  export class View {
    children = [];
    addChildView(view) { this.children.push(view); }
    removeChildView(view) { this.children.splice(this.children.indexOf(view), 1); }
    setVisible() {}
    setBounds() {}
  }
  export class WebContentsView extends View {
    static instances = [];
    constructor() {
      super();
      this.boundsSet = [];
      this.webContents = Object.assign(new EventEmitter(), {
        url: "https://fixture.invalid/previous",
        mainFrame: { processId: 7, routingId: 11 },
        pendingLoads: [],
        focused: false,
        focusCalls: 0,
        loadURL(url) {
          return new Promise((resolve, reject) => {
            this.pendingLoads.push({ url, resolve, reject });
          });
        },
        getURL() { return this.url; },
        getTitle: () => "fixture",
        isLoading: () => false,
        isDestroyed: () => false,
        isFocused() { return this.focused; },
        focus() { this.focusCalls += 1; this.focused = true; },
        reloadIgnoringCacheCalls: 0,
        reloadIgnoringCache() { this.reloadIgnoringCacheCalls += 1; },
        close: () => {},
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {} },
      });
      WebContentsView.instances.push(this);
    }
    setBounds(bounds) { this.boundsSet.push({ ...bounds }); }
  }
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserPane } = await import("../electron/main/browser-view.ts");
const { WebContentsView } = await import("electron");
const { EventEmitter } = await import("node:events");

function fakeContents(focused) {
  return Object.assign(new EventEmitter(), {
    focused,
    focusCalls: 0,
    isDestroyed: () => false,
    isFocused() { return this.focused; },
    focus() { this.focusCalls += 1; this.focused = true; },
  });
}

function fakeWindow(shellContents, extraViews = []) {
  const contentView = {
    children: [...extraViews],
    addChildView(view) { this.children.push(view); },
    removeChildView(view) { this.children.splice(this.children.indexOf(view), 1); },
  };
  return {
    webContents: shellContents,
    contentView,
    isDestroyed: () => false,
    isFocused: () => true,
  };
}

/** Drive one programmatic navigation to a commit; returns the guest wc. */
async function commit(pane, url) {
  const request = pane.navigateAndWait(url);
  const wc = WebContentsView.instances.at(-1).webContents;
  wc.url = `https://${new URL(url).host}${new URL(url).pathname}`;
  wc.pendingLoads.shift().resolve();
  return { state: await request, wc };
}

/** Replay the native theft the fixture observed: focus moves to the guest. */
function steal(shellContents, wc) {
  shellContents.focused = false;
  wc.focused = true;
  wc.emit("focus");
}

function harness(shellFocused) {
  const shellContents = fakeContents(shellFocused);
  const pane = new BrowserPane(() => {});
  pane.setWindow(fakeWindow(shellContents));
  return { pane, shellContents };
}

test("a programmatic navigation restores the owner after the guest steals focus", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { state, wc } = await commit(pane, "https://fixture.invalid/preview");
  assert.equal(state.url, "https://fixture.invalid/preview");
  assert.equal(shellContents.focusCalls, 0, "the commit itself focuses nothing");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "the theft side effect is undone exactly once");
});

test("no restore happens when nobody owned focus at arm time", async (t) => {
  const { pane, shellContents } = harness(false);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 0, "a user working in the preview keeps focus");
});

test("a programmatic navigation restores across repeated theft waves", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "the theft side effect is undone");
  assert.equal(wc.listenerCount("focus"), 1, "the focus listener stays attached for later waves");
  assert.equal(wc.listenerCount("before-mouse-event"), 1, "the racing press can still recover");
  assert.equal(wc.listenerCount("input-event"), 1, "the racing touch can still recover");
  // The native theft re-asserts guest focus after the restore: the same
  // listener restores again instead of leaving the shell stolen.
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 2, "a second theft wave is restored too");
  assert.equal(wc.listenerCount("focus"), 1, "restores never detach the focus listener");
  pane.setVisible(false);
  for (const event of ["focus", "before-mouse-event", "input-event"]) {
    assert.equal(wc.listenerCount(event), 0, "hide detaches every guest listener");
  }
  for (const event of ["before-input-event", "blur"]) {
    assert.equal(shellContents.listenerCount(event), 0, "hide detaches every owner listener");
  }
});

test("arming captures the shell owner even when the window reports inactive", async (t) => {
  // Headless and CI runs can report the window inactive at arm time while
  // the shell editor genuinely owns keyboard focus: activation flicker must
  // not arm the watch ownerless.
  const shellContents = fakeContents(true);
  const win = fakeWindow(shellContents);
  win.isFocused = () => false;
  const pane = new BrowserPane(() => {});
  pane.setWindow(win);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  win.isFocused = () => true;
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "the shell owner survives activation flicker at arm time");
});

test("an inactive window skips the restore but stays armed", async (t) => {
  const shellContents = fakeContents(true);
  const win = fakeWindow(shellContents);
  let active = true;
  win.isFocused = () => active;
  const pane = new BrowserPane(() => {});
  pane.setWindow(win);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  active = false;
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 0, "a backgrounded app is never yanked forward");
  assert.equal(wc.listenerCount("focus"), 1, "the skipped restore stays armed");
  active = true;
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "the theft is restored once the window is active");
});

test("a real mouse press into the guest disarms the watch permanently", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  assert.equal(wc.focusCalls, 1, "the press hands focus to the guest");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 0, "a manual click into the preview is never yanked back");
  for (const event of ["focus", "before-mouse-event", "input-event"]) {
    assert.equal(wc.listenerCount(event), 0, `the takeover removes the guest ${event} listener`);
  }
  for (const event of ["before-input-event", "blur"]) {
    assert.equal(shellContents.listenerCount(event), 0, `the takeover removes the owner ${event} listener`);
  }
});

test("a press after an eager restore hands focus back to the guest", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "the theft restore runs first");
  // The native focus transfer lands ahead of the input event: the user's
  // press arrives after the eager restore already returned focus.
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  assert.equal(wc.focusCalls, 1, "the press returns focus to the guest");
  assert.equal(wc.listenerCount("focus"), 0, "the recovery disarms the watch");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "no further restore runs after takeover");
});

test("hover input keeps the watch armed and moves no focus", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  wc.emit("before-mouse-event", {}, { type: "mouseMove" });
  assert.equal(wc.focusCalls, 0, "hover alone never moves focus");
  assert.equal(wc.listenerCount("focus"), 1, "hover does not disarm the theft watch");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "a later theft is still caught");
});

test("a touch press into the guest disarms through the input-event union", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  wc.emit("input-event", {}, { type: "touchStart" });
  assert.equal(wc.focusCalls, 1, "the touch press hands focus to the guest");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 0, "a touch takeover is never yanked back");
  assert.equal(wc.listenerCount("focus"), 0, "the takeover disarms the watch");
});

test("owner traversal keys followed by blur mark user traversal, not theft", async (t) => {
  for (const key of ["Tab", "F6"]) {
    const { pane, shellContents } = harness(true);
    t.after(() => pane.dispose());
    const { wc } = await commit(pane, "https://fixture.invalid/preview");
    shellContents.emit("before-input-event", {}, { type: "keyDown", key });
    shellContents.emit("blur");
    steal(shellContents, wc);
    assert.equal(shellContents.focusCalls, 0, `a ${key} traversal into the preview is never yanked back`);
    assert.equal(wc.listenerCount("focus"), 0, "the traversal disarms the watch");
    pane.dispose();
  }
});

test("owner typing keys do not mark traversal: theft still restores", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  shellContents.emit("before-input-event", {}, { type: "keyDown", key: "x" });
  shellContents.emit("blur");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "typing in the shell is not traversal");
});

test("an owner traversal key without blur leaves the watch armed", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  shellContents.emit("before-input-event", {}, { type: "keyDown", key: "Tab" });
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "a key alone, with no focus loss, is not traversal");
});

test("re-arming replaces the previous watch: one listener set, one restore", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  await commit(pane, "https://fixture.invalid/first");
  await commit(pane, "https://fixture.invalid/second");
  const wc = WebContentsView.instances.at(-1).webContents;
  // The pane reuses one guest view: replacing the watch must not stack a
  // second listener set on it or on the still-focused shell owner.
  for (const event of ["focus", "before-mouse-event", "input-event"]) {
    assert.equal(wc.listenerCount(event), 1, `exactly one guest ${event} listener after re-arm`);
  }
  assert.equal(shellContents.listenerCount("before-input-event"), 1, "exactly one owner key listener after re-arm");
  assert.equal(shellContents.listenerCount("blur"), 1, "exactly one owner blur listener after re-arm");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "the current watch restores exactly once");
});

test("hiding the pane removes every watch listener", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  assert.equal(wc.listenerCount("focus"), 1);
  pane.setVisible(false);
  for (const event of ["focus", "before-mouse-event", "input-event"]) {
    assert.equal(wc.listenerCount(event), 0, `hide detaches the guest ${event} listener`);
  }
  for (const event of ["before-input-event", "blur"]) {
    assert.equal(shellContents.listenerCount(event), 0, `hide detaches the owner ${event} listener`);
  }
});

test("showing without a navigation re-arms with the current owner", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  pane.setVisible(false);
  pane.setVisible(true);
  assert.equal(wc.listenerCount("focus"), 1, "show re-arms after a hide");
  steal(shellContents, wc);
  assert.equal(shellContents.focusCalls, 1, "the re-armed watch still protects the shell");
});

test("the recorded owner can be another attached view, not just the shell", async (t) => {
  const shellContents = fakeContents(false);
  const chrome = new WebContentsView();
  chrome.webContents.focused = true;
  const pane = new BrowserPane(() => {});
  pane.setWindow(fakeWindow(shellContents, [chrome]));
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  chrome.webContents.focused = false;
  wc.focused = true;
  wc.emit("focus");
  assert.equal(chrome.webContents.focusCalls, 1, "the chrome URL bar regains focus");
  assert.equal(shellContents.focusCalls, 0, "the shell is left alone");
  assert.equal(wc.listenerCount("focus"), 1, "restores never detach the focus listener");
});

test("a live reload re-snapshots whoever owns focus now", async (t) => {
  const shellContents = fakeContents(true);
  const chrome = new WebContentsView();
  const pane = new BrowserPane(() => {});
  pane.setWindow(fakeWindow(shellContents, [chrome]));
  t.after(() => pane.dispose());
  const { wc } = await commit(pane, "https://fixture.invalid/preview");
  // The user moved into the preview chrome after the navigation armed the
  // watch on the shell: a file reload must restore the chrome, not the
  // stale shell owner.
  shellContents.focused = false;
  chrome.webContents.focused = true;
  wc.url = "file:///preview.html";
  pane.scheduleReload();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(wc.reloadIgnoringCacheCalls, 1, "the debounced reload still runs");
  chrome.webContents.focused = false;
  wc.focused = true;
  wc.emit("focus");
  assert.equal(chrome.webContents.focusCalls, 1, "the reload theft restores the current owner");
  assert.equal(shellContents.focusCalls, 0, "the stale navigation-time owner is left alone");
});

test("no restore happens when the guest never takes focus", async (t) => {
  const { pane, shellContents } = harness(true);
  t.after(() => pane.dispose());
  const { state } = await commit(pane, "https://fixture.invalid/preview");
  assert.equal(state.url, "https://fixture.invalid/preview");
  assert.equal(shellContents.focusCalls, 0, "an already-focused shell is left alone");
});
