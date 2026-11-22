import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../../apps/desktop/electron/main/browser-host";
import { BrowserPane } from "../../apps/desktop/electron/main/browser-view";

const artifactDir = process.env.BROWSER_BACKGROUND_ARTIFACT_DIR;
if (!artifactDir) throw new Error("BROWSER_BACKGROUND_ARTIFACT_DIR is required");
app.setPath("userData", join(artifactDir, "profile"));
const stage = (value: string) => appendFileSync(join(artifactDir, "progress.log"), `${value}\n`);
async function pollValue(read: () => Promise<unknown>, want: unknown, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const got = await read();
    if (got === want) return;
    if (Date.now() >= deadline) assert.equal(got, want, `${label} did not converge`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const pageA = (marker: string) => `<!doctype html><html><head><title>Session A</title></head>
  <body><h1>${marker}</h1>
  <button id="go" onclick="document.title='A-clicked'">Tap me</button>
  <input id="name" aria-label="Name">
  <a id="next" href="/a-next">Next page</a>
  </body></html>`;
const pageB = `<!doctype html><html><head><title>Session B</title></head>
  <body><h1>Session B</h1><p>foreground</p></body></html>`;

async function probe(artifactDir: string) {
  stage("app-ready");
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/b") response.end(pageB);
    else if (request.url === "/a2") response.end(pageA("Session A2"));
    else response.end(pageA("Session A"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const window = new BrowserWindow({ width: 1100, height: 750, show: true, alwaysOnTop: true });
  const panes: BrowserPane[] = [];
  const revealed: Array<{ sessionId: string; tabId?: string }> = [];
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => {
      const pane = new BrowserPane(onState, onOpenUrl);
      panes.push(pane);
      return pane;
    },
    isPluginLoaded: () => true,
    getFileRoots: async () => [],
    onState: () => {},
    onRevealView: (sessionId, tabId) => {
      revealed.push({ sessionId, tabId });
      host.setChromeSession(sessionId, tabId);
      host.setChromeSurface({
        pluginId: "pi.browser", viewId: "browser", visible: true,
        bounds: { x: 0, y: 0, width: 1000, height: 700 },
      });
    },
  });
  const checks: Record<string, unknown> = {};
  try {
    await window.loadURL(`data:text/html,${encodeURIComponent("<!doctype html><title>shell</title>")}`);
    stage("shell-loaded");
    host.setWindow(window);
    host.setChromeSurface({
      pluginId: "pi.browser", viewId: "browser", visible: true,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
    });
    host.setGuestHole("pi.browser", { x: 0, y: 0, width: 1000, height: 700 });

    // Two sessions with their own pages; B owns the visible foreground.
    host.setChromeSession("bg-a", "a");
    await host.navigate({ url: `${base}/a` }, "bg-a");
    // Control: clicking while the caller's page is visible mutates it.
    const controlSnap = await host.snapshot("bg-a");
    const controlBtn = controlSnap.tree.match(/-\s+(e\d+)\s+.*Tap me/)?.[1];
    assert(controlBtn, "control button uid parses from the snapshot tree");
    await host.click(controlBtn, "bg-a");
    assert.equal(await host.evaluate("document.title", "bg-a"), "A-clicked", "visible click control");
    host.setChromeSession("bg-b", "b");
    await host.navigate({ url: `${base}/b` }, "bg-b");
    stage("guest-loaded");
    assert.equal(host.getContext().sessionId, "bg-b");

    // Caller A executes entirely in the background.
    const moved = await host.navigate({ url: `${base}/a2` }, "bg-a");
    assert.equal(moved?.url, `${base}/a2`);
    assert.equal(host.getContext().sessionId, "bg-b", "navigation must not move the presentation");
    // A hidden renderer may populate its accessibility tree a beat after commit; poll briefly.
    let snapshot = { tree: "", url: "", title: "" };
    for (let i = 0; i < 50; i++) {
      snapshot = await host.snapshot("bg-a");
      if (/Tap me/.test(snapshot.tree)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(snapshot.tree, /Tap me/, "caller page exposes its controls");
    const button = snapshot.tree.match(/-\s+(e\d+)\s+.*Tap me/)?.[1];
    assert(button, "button uid parses from the snapshot tree");
    const field = snapshot.tree.match(/-\s+(e\d+)\s+.*Name/)?.[1];
    assert(field, "input uid parses from the snapshot tree");
    assert.equal(await host.evaluate("document.title", "bg-a"), "Session A");
    // A hidden click must produce a real DOM state change on the caller's page.
    await host.click(button, "bg-a");
    await pollValue(() => host.evaluate("document.title", "bg-a"), "A-clicked", "hidden button click");
    checks.backgroundClick = true;
    // Unknown uids fail before touching any page.
    await assert.rejects(host.click("e999", "bg-a"), (error: unknown) =>
      (error as { code?: string })?.code === "INVALID_ARGUMENT");
    checks.staleUid = true;
    await host.fill(field, "hello", "bg-a");
    assert.equal(await host.evaluate("document.getElementById('name').value", "bg-a"), "hello");
    const shot = await host.screenshot({ fullPage: true }, "bg-a");
    assert.equal(shot.mimeType, "image/jpeg");
    assert.ok(shot.data.length > 0, "background screenshot carries pixels");
    const messages = host.console(undefined, "bg-a");
    await host.cdpCommand("Page.enable", {}, "bg-a");
    assert.ok(Array.isArray(messages.messages), "console returns its message list");
    // Default link activation navigates the caller's hidden page.
    const resnap = await host.snapshot("bg-a");
    const link = resnap.tree.match(/-\s+(e\d+)\s+.*Next page/)?.[1];
    assert(link, "link uid parses from the snapshot tree");
    await host.click(link, "bg-a");
    await pollValue(() => host.evaluate("location.href", "bg-a"), `${base}/a-next`, "hidden link click");
    checks.backgroundLink = true;
    stage("background-executed");

    // The foreground session is untouched by every caller-side operation.
    assert.equal(await host.evaluate("document.title", "bg-b"), "Session B", "B is untouched");
    assert.equal(host.getState()?.url, `${base}/b`);
    assert.equal(host.getContext().sessionId, "bg-b");
    checks.revealRequests = revealed.length;
    assert.equal(revealed.length, 0, "execution must not request a reveal");
    checks.background = true;

    // Hidden work panel: execution still runs on the caller's page.
    host.setChromeSurface({
      pluginId: "pi.browser", viewId: "browser", visible: false,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
    });
    const hidden = await host.snapshot("bg-a");
    assert.match(hidden.tree, /Tap me/);
    assert.equal(revealed.length, 0, "hidden execution must not request a reveal");
    stage("hidden-executed");
    checks.hidden = true;

    // Explicit reveal restores the caller's session view.
    host.setChromeSurface({
      pluginId: "pi.browser", viewId: "browser", visible: true,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
    });
    await host.reveal("bg-a");
    assert.equal(host.getContext().sessionId, "bg-a");
    assert.equal(host.getState()?.url, `${base}/a-next`);
    stage("revealed");
    checks.reveal = true;

    // Lifecycle: closing a session releases its background page.
    host.setChromeSession("bg-b", "b");
    host.closeTab("bg-b", "b");
    await assert.rejects(host.snapshot("bg-b"), (error: unknown) =>
      (error as { code?: string })?.code === "UNAVAILABLE");
    host.disposeGuest();
    assert.equal(host.getState(), null);
    assert.ok(panes.length > 0 && panes.every((pane) => pane.getWebContents() === null), "dispose releases every owned page");
    stage("disposed");
    checks.lifecycle = true;

    const report = { electron: process.versions.electron, chrome: process.versions.chrome, checks };
    writeFileSync(join(artifactDir, "results.json"), JSON.stringify(report, null, 2));
    console.log(`BROWSER_BACKGROUND_EXECUTION ${JSON.stringify({ ok: true, ...report })}`);
  } finally {
    host.dispose();
    if (!window.isDestroyed()) window.destroy();
    server.close();
  }
}

app.whenReady().then(() => probe(artifactDir)).then(
  () => app.exit(0),
  (error: unknown) => { stage(String(error)); console.error(error); app.exit(1); },
);
