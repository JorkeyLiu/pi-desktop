import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, WebContentsView } from "electron";
import { BrowserHost } from "../../apps/desktop/electron/main/browser-host";
import { BrowserPane } from "../../apps/desktop/electron/main/browser-view";

/**
 * Bounded BrowserPreview focus fixture (preview-focus work only).
 *
 * Reproduces the production preview lifecycle with real Electron:
 * shell window with a focused editable field -> main-process chrome
 * WebContentsView attach (plugin-view-host setVisible path) -> guest
 * surface attach + file/http navigation (browser-host applyGuest +
 * BrowserPane) -> repeat preview reusing the same session tab ->
 * live reload -> manual clicks round-trip.
 *
 * Self-triggering is eliminated by layout: logs, profile and results live
 * in the artifact root while ONLY preview files live in the watched
 * `preview/` subdirectory (live reload watches the preview file's dirname).
 * Set PREVIEW_OVER_HTTP=1 to serve the page over loopback instead of
 * file:// (no watcher path at all).
 *
 * Records DOM activeElement/value/selection, BrowserWindow and webContents
 * focus state before/after first open and reuse, a CDP-click
 * `before-input-event` probe, real keystroke delivery, and takeover with the
 * guard armed (native focus transfer driven directly plus synthetic press
 * delivery counts on `before-mouse-event`). Fails (ok:false) when the shell
 * loses focus it should keep, or when the guest stops being interactive.
 * Limits: direct OS-pointer click is not synthesized (no global automation
 * in CI); the takeover stage proves the armed production handler plus the
 * native transfer, not the full OS click path.
 */

const artifactDir = process.env.BROWSER_PREVIEW_FOCUS_ARTIFACT_DIR;
if (!artifactDir) throw new Error("BROWSER_PREVIEW_FOCUS_ARTIFACT_DIR is required");
const previewDir = join(artifactDir, "preview");
mkdirSync(previewDir, { recursive: true });
mkdirSync(join(artifactDir, "profile"), { recursive: true });
app.setPath("userData", join(artifactDir, "profile"));
const stage = (value: string) => appendFileSync(join(artifactDir, "progress.log"), `${value}\n`);

const OVER_HTTP = process.env.PREVIEW_OVER_HTTP === "1";
const SESSION = "preview-s1";
const TAB = "preview-tab-1";
 const CHROME_BOUNDS = { x: 560, y: 0, width: 540, height: 750 };
 const HOLE = { x: 0, y: 80, width: 480, height: 560 };

const previewPage = (title: string, marker: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${marker}</h1>
<button id="go" onclick="document.title='${marker}-clicked'">Tap me</button>
</body></html>`;

const editorPage = `<!doctype html><html><head><meta charset="utf-8"><title>shell</title></head>
<body><textarea id="composer" rows="4" cols="40">typed draft here</textarea></body></html>`;

async function domProbe(window: BrowserWindow) {
  return window.webContents.executeJavaScript(`(() => {
    const el = document.activeElement;
    const composer = document.getElementById('composer');
    return {
      active: el ? (el.id || el.tagName) : null,
      hasFocus: document.hasFocus(),
      value: composer ? composer.value : null,
      selStart: composer ? composer.selectionStart : null,
      selEnd: composer ? composer.selectionEnd : null,
    };
  })()`) as Promise<{ active: unknown; hasFocus: unknown; value: unknown; selStart: unknown; selEnd: unknown }>;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Failure { stage: string; expect: string; got: unknown }

async function run() {
  stage("app-ready");
  const failures: Failure[] = [];
  const check = (stageName: string, expect: string, actual: unknown, want: unknown) => {
    if (actual !== want) failures.push({ stage: stageName, expect, got: actual });
  };

  // Only preview files live in the watched directory.
  const previewFile = join(previewDir, "preview.html");
  const previewFile2 = join(previewDir, "preview2.html");
  writeFileSync(previewFile, previewPage("Sample preview", "preview body") + "\n");
  writeFileSync(previewFile2, previewPage("Second preview", "second body") + "\n");

  let server: ReturnType<typeof createServer> | null = null;
  let pageUrl = pathToFileURL(previewFile).toString();
  let pageUrl2 = pathToFileURL(previewFile2).toString();
  if (OVER_HTTP) {
    server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(request.url === "/second" ? previewPage("Second preview", "second body") : previewPage("Sample preview", "preview body"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    pageUrl = `http://127.0.0.1:${address.port}/preview`;
    pageUrl2 = `http://127.0.0.1:${address.port}/second`;
  }

  const window = new BrowserWindow({ width: 1100, height: 750, show: true, alwaysOnTop: true });
  const panes: BrowserPane[] = [];
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => {
      const pane = new BrowserPane(onState, onOpenUrl);
      panes.push(pane);
      return pane;
    },
    isPluginLoaded: () => true,
    getFileRoots: async () => [previewDir],
    onState: () => {},
    onRevealView: (sessionId, tabId) => {
      host.setChromeSession(sessionId, tabId ?? undefined);
      host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true, bounds: CHROME_BOUNDS });
    },
  });

  const guest = () => panes.at(-1)?.getWebContents() ?? null;
  let chrome: WebContentsView | null = null;

  /** Bounded guest stop-loading wait: resolves early if already unloaded. */
  const awaitStop = async (ms = 3000) => {
    const g = guest();
    if (!g || g.isDestroyed() || !g.isLoading()) return;
    await Promise.race([
      once(g, "did-stop-loading").then(() => undefined).catch(() => undefined),
      sleep(ms),
    ]);
  };
  /** Re-activate the window when the OS drops it: contents focus is only
   * meaningful (and theft only possible) while the window is active. */
  const ensureActive = async () => {
    for (let attempt = 0; attempt < 3 && !window.isFocused(); attempt++) {
      stage(`window-reactivate attempt=${attempt}`);
      window.show();
      window.focus();
      window.webContents.focus();
      await sleep(400);
    }
  };
  /** Poll native focus up to ~6s; stop early once a steal is confirmed. */
  const pollSteal = async (extra = 3) => {
    let stealAt: number | null = null;
    let quiet = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const g = guest();
      const stolen = !!g && !g.isDestroyed() && g.isFocused();
      if (stolen && stealAt === null) stealAt = (i + 1) * 100;
      if (stealAt !== null && ++quiet >= extra) break;
    }
    return stealAt;
  };

  const shellState = async () => {
    const dom = await domProbe(window);
    const g = guest();
    return {
      dom,
      windowFocused: window.isFocused(),
      shellFocused: !window.webContents.isDestroyed() && window.webContents.isFocused(),
      guestFocused: g && !g.isDestroyed() ? g.isFocused() : null,
      chromeFocused: chrome && !chrome.webContents.isDestroyed() ? chrome.webContents.isFocused() : null,
    };
  };
  /** Stage the full native focus triple so a failure self-diagnoses. */
  const snapFocus = async (label: string) => {
    const s = await shellState();
    stage(`${label} win=${s.windowFocused} shell=${s.shellFocused} guest=${s.guestFocused} chrome=${s.chromeFocused}`);
    return s;
  };

  try {
    await window.loadURL(`data:text/html,${encodeURIComponent(editorPage)}`);
    stage("shell-loaded");
    window.show();
    window.focus();
    window.webContents.focus();
    await window.webContents.executeJavaScript(`(() => {
      const composer = document.getElementById('composer');
      composer.focus();
      composer.setSelectionRange(6, 11);
    })()`);
    host.setWindow(window);
    let s = await snapFocus("baseline");
    check("baseline", "shell owns focus with selection 6-11", `${s.dom.active}/${s.dom.hasFocus}/${s.dom.selStart},${s.dom.selEnd}/${s.shellFocused}`, "composer/true/6,11/true");
    assert.equal(s.dom.value, "typed draft here");

    // Hidden navigation: nothing attached, no focus effect expected.
    const hiddenFirst = await host.navigate({ url: pageUrl }, "hidden-s", "hidden-t");
    assert(hiddenFirst, "hidden navigation commits");
    await sleep(1000);
    await ensureActive();
    s = await snapFocus("after-hidden-navigate");
     check("after-hidden-navigate", "shell keeps focus", `${s.shellFocused}/${s.guestFocused}`, "true/false");

    // First agent preview open: chrome attach, surface, hole, navigation.
    chrome = new WebContentsView();
    await chrome.webContents.loadURL("about:blank");
    window.contentView.addChildView(chrome);
    chrome.setBounds(CHROME_BOUNDS);
    host.setChromeSession(SESSION, TAB);
    host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true, bounds: CHROME_BOUNDS });
    host.setGuestHole("pi.browser", HOLE);
    await ensureActive();
    s = await snapFocus("after-attach-before-navigate");
    check("after-attach-before-navigate", "attach moves no focus", `${s.shellFocused}`, "true");

    const first = await host.navigate({ url: pageUrl }, SESSION, TAB);
    assert(first, "first preview navigation commits");
    await awaitStop();
    const stealAt = await pollSteal();
    await ensureActive();
    stage("first-open");
    s = await snapFocus("after-first-open");
    check("after-first-open", "shell keeps focus with selection 6-11", `${s.dom.active}/${s.dom.hasFocus}/${s.dom.selStart},${s.dom.selEnd}/${s.shellFocused}/${s.guestFocused}`, "composer/true/6,11/true/false");

    // CDP-driven agent click must not look like real user input to the watch.
    let inputEvents = 0;
    const g0 = guest()!;
    const countInput = () => { inputEvents += 1; };
    g0.on("before-input-event", countInput);
    const snap = await host.snapshot(SESSION, TAB);
    const button = snap.tree.match(/-\s+(e\d+)\s+.*Tap me/)?.[1];
    assert(button, "button uid parses from the snapshot tree");
    await host.click(button, SESSION, TAB);
    await sleep(300);
    g0.removeListener("before-input-event", countInput);
    const guestTitle = await host.evaluate("document.title", SESSION, TAB);

    // Live reload path: file save (watched dir) or explicit reload (http).
    if (!OVER_HTTP) {
      writeFileSync(previewFile, previewPage("Sample preview", "preview body live") + `\n<!-- touch ${Date.now()} -->\n`);
    } else {
      guest()!.reloadIgnoringCache();
    }
    await awaitStop();
    const reloadStealAt = await pollSteal();
    await ensureActive();
    stage("reloaded");
    s = await snapFocus("after-live-reload");
    check("after-live-reload", "shell keeps focus across live reload", `${s.shellFocused}/${s.guestFocused}`, "true/false");

    // Repeat preview reuses the session tab: same URL, then a different one.
    const paneCount = panes.length;
    assert(await host.navigate({ url: pageUrl }, SESSION, TAB), "repeat navigation commits");
    const reuseSameStealAt = await pollSteal();
    await ensureActive();
    s = await snapFocus("after-reuse-same-file");
    check("after-reuse-same-file", "shell keeps focus on reuse", `${s.shellFocused}/${s.guestFocused}`, "true/false");
    assert(await host.navigate({ url: pageUrl2 }, SESSION, TAB), "different-file navigation commits");
    const reuseDiffStealAt = await pollSteal();
    await ensureActive();
    s = await snapFocus("after-reuse-different-file");
    check("after-reuse-different-file", "shell keeps focus on different file", `${s.shellFocused}/${s.guestFocused}`, "true/false");
    check("pane-reuse", "repeat previews reuse the pane", panes.length, paneCount);

    // Navigation while the guest owns focus must not force the shell.
    // Window-level click probe: does a synthetic mouse event on the shell
    // contents at the guest's window position route through Views hit-testing
    // to the guest (firing its before-input-event), or is guest-level
    // dispatch the only faithful synthetic path? Diagnostic only.
    const guestCenterX = CHROME_BOUNDS.x + HOLE.x + Math.floor(HOLE.width / 2);
    const guestCenterY = CHROME_BOUNDS.y + HOLE.y + Math.floor(HOLE.height / 2);
    let windowClickInputEvents = 0;
    const countWindowClick = () => { windowClickInputEvents += 1; };
    guest()!.on("before-input-event", countWindowClick);
    window.webContents.sendInputEvent({ type: "mouseDown", x: guestCenterX, y: guestCenterY, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: guestCenterX, y: guestCenterY, button: "left", clickCount: 1 });
    await sleep(400);
    guest()!.removeListener("before-input-event", countWindowClick);
    const afterWindowClick = await snapFocus("window-click-probe");
    stage(`window-click-probe inputEvents=${windowClickInputEvents}`);
    // User takeover with the watch ARMED: no host.action() call here — the
    // chrome-UI action() path disarms production's watch, which would bypass
    // the guard under test. A real OS click transfers native focus to the
    // guest before its press reaches the renderer; synthetic dispatch moves
    // no native focus (measured: no focus move on sendInputEvent alone), so
    // the harness drives the native half directly with guest.focus() — the
    // same endpoint a Views hit-test resolves to — while the watch stays
    // armed. Direct OS-pointer click remains unproven in CI; this proves the
    // armed production handler plus the native transfer, not the full OS
    // path.
    const cx = HOLE.x + Math.floor(HOLE.width / 2);
    const cy = HOLE.y + Math.floor(HOLE.height / 2);
    let takeoverMouseEvents = 0;
    let takeoverFocusEvents = 0;
    const countTakeoverMouse = () => { takeoverMouseEvents += 1; };
    const countTakeoverFocus = () => { takeoverFocusEvents += 1; };
    guest()!.on("before-mouse-event", countTakeoverMouse);
    guest()!.on("focus", countTakeoverFocus);
    guest()!.focus();
    await sleep(400);
    const afterNativeHalf = await snapFocus("takeover-native-half");
    stage(`takeover-native-half shell=${afterNativeHalf.shellFocused} guest=${afterNativeHalf.guestFocused} focusEvents=${takeoverFocusEvents}`);
    // Input half: the user's press reaches the guest after the native
    // transfer (possibly after an eager restore already ran). The
    // production before-mouse-event handler then hands focus back to the
    // guest and disarms the watch.
    guest()!.sendInputEvent({ type: "mouseDown", x: cx - HOLE.x, y: cy - HOLE.y, button: "left", clickCount: 1 });
    guest()!.sendInputEvent({ type: "mouseUp", x: cx - HOLE.x, y: cy - HOLE.y, button: "left", clickCount: 1 });
    await sleep(400);
    guest()!.removeListener("before-mouse-event", countTakeoverMouse);
    guest()!.removeListener("focus", countTakeoverFocus);
    stage(`takeover-input-half mouseEvents=${takeoverMouseEvents}`);
    {
      const clicked = await snapFocus("after-manual-guest-click");
      check("after-manual-guest-click", "guest takes focus on real input", `${clicked.guestFocused}`, "true");
    }
     // View-local coordinates: the guest view starts at the hole origin (cx/cy
     // defined in the takeover stage above). The watch must only disarm on
     // real user input: record synthetic-input delivery on both the mouse and
     // keyboard channels, separately from the CDP click above.
     let syntheticInputEvents = 0;
     let syntheticMouseEvents = 0;
     const countSynthetic = () => { syntheticInputEvents += 1; };
     const countSyntheticMouse = () => { syntheticMouseEvents += 1; };
     guest()!.on("before-input-event", countSynthetic);
     guest()!.on("before-mouse-event", countSyntheticMouse);
     guest()!.sendInputEvent({ type: "mouseDown", x: cx - HOLE.x, y: cy - HOLE.y, button: "left", clickCount: 1 });
     guest()!.sendInputEvent({ type: "mouseUp", x: cx - HOLE.x, y: cy - HOLE.y, button: "left", clickCount: 1 });
     await sleep(400);
     guest()!.removeListener("before-input-event", countSynthetic);
     guest()!.removeListener("before-mouse-event", countSyntheticMouse);
     stage(`pre-guest-nav-synthetic inputEvents=${syntheticInputEvents} mouseEvents=${syntheticMouseEvents}`);
    s = await snapFocus("pre-guest-nav");
    assert(await host.navigate({ url: pageUrl }, SESSION, TAB), "navigation while guest focused commits");
    const guestNavStealAt = await pollSteal();
    await ensureActive();
    s = await snapFocus("navigate-while-guest-focused");
    check("navigate-while-guest-focused", "no yank back to the shell", `${s.shellFocused}/${s.guestFocused}`, "false/true");

    // Round trip: native focus back to the shell (the same endpoint an OS
    // click resolves to; synthetic dispatch moves no native focus), then a
    // real dispatched click plus a real keystroke into the composer.
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: "mouseDown", x: 60, y: 30, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: 60, y: 30, button: "left", clickCount: 1 });
    await sleep(400);
    s = await snapFocus("after-composer-click");
    check("after-composer-click", "shell owns focus again", `${s.dom.active}/${s.shellFocused}`, "composer/true");
    window.webContents.sendInputEvent({ type: "char", keyCode: "Z" });
    await sleep(300);
    const typed = await domProbe(window);
    check("real-typing", "keystroke lands in the composer", String(typed.value).includes("Z"), true);

    const report = {
      ok: failures.length === 0,
      failures,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      transport: OVER_HTTP ? "http" : "file",
      stealAtMs: stealAt,
      reloadStealAtMs: reloadStealAt,
      reuseSameStealAtMs: reuseSameStealAt,
      reuseDiffStealAtMs: reuseDiffStealAt,
      guestNavStealAtMs: guestNavStealAt,
      cdpInputEvents: inputEvents,
      syntheticInputEvents,
      syntheticMouseEvents,
      windowClickInputEvents,
      takeoverMouseEvents,
      takeoverFocusEvents,
      takeoverNativeShellFocused: afterNativeHalf.shellFocused,
      takeoverNativeGuestFocused: afterNativeHalf.guestFocused,
      windowClickShellFocused: afterWindowClick.shellFocused,
      windowClickGuestFocused: afterWindowClick.guestFocused,
      guestTitleAfterCdpClick: guestTitle,
      paneCount: panes.length,
      guestUrl: guest()?.getURL() ?? null,
      finalDom: typed,
      shellFocused: s.shellFocused,
      guestFocused: s.guestFocused,
      chromeFocused: (s as { chromeFocused: unknown }).chromeFocused,
      windowFocused: s.dom.hasFocus,
    };
    writeFileSync(join(artifactDir, "results.json"), JSON.stringify(report, null, 2));
    console.log(`BROWSER_PREVIEW_FOCUS ${JSON.stringify(report)}`);
    assert.equal(failures.length, 0, `focus regressions: ${JSON.stringify(failures)}`);
  } finally {
    host.dispose();
    chrome = null;
    if (!window.isDestroyed()) window.destroy();
    server?.close();
  }
}

app.whenReady().then(() => run()).then(
  () => app.exit(0),
  (error: unknown) => { stage(String(error)); console.error(error); app.exit(1); },
);
