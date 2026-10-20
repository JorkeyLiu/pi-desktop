#!/usr/bin/env node
/**
 * The composer's running-subagent dock, driven in an isolated Chromium
 * renderer with the application's own stylesheet.
 *
 * The fixture mounts the production `Composer`, so the probe checks the dock in
 * its real slot above the input, with the production store, stop control, tab
 * action and i18n. Only the preload bridge is stubbed: it records the one IPC
 * call Stop makes.
 *
 * The dock is measured against the built renderer stylesheet alone — the same
 * asset links the application's `index.html` loads. Nothing from `src/styles` is
 * copied into the page: a source partial appended after the built CSS would
 * reverse the real import order and hide a cascade defect. The probe fails fast
 * when the build predates the dock's own rules, and it asserts that the fixture
 * page carries exactly those links and no stylesheet of its own.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const artifactDir = process.env.PI_SUBAGENT_DOCK_ARTIFACT_DIR ?? tmpdir();
const temp = await mkdtemp(join(tmpdir(), "pi-subagent-dock-"));

/**
 * The composer reaches the voice stack, which imports its worklet files with
 * Vite's `?url` suffix. The dock never touches them, so they resolve to an
 * inert data URL instead of a built asset.
 */
const viteUrlStub = {
  name: "vite-url-stub",
  setup(build) {
    build.onResolve({ filter: /\?url$/ }, (args) => ({
      path: args.path,
      namespace: "vite-url-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "vite-url-stub" }, () => ({
      contents: 'export default "data:text/javascript,";',
      loader: "js",
    }));
  },
};

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/subagent-dock.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"MODE":"production"}',
    },
    loader: { ".css": "empty" },
    plugins: [viteUrlStub],
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"),
      "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });

  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(
    css.length,
    "Build the app renderer once (pnpm --filter @pi-desktop/desktop build) before this check",
  );
  // The gate is the built stylesheet itself: whatever the shipped app loads is
  // what the probe measures. An old build that predates the dock's own rules is
  // reported as stale rather than papered over with the source partial.
  const builtCss = (
    await Promise.all(
      css.map((href) => readFile(join(renderer, href.replace(/^\.?\//, "")), "utf8")),
    )
  ).join("\n");
  for (const rule of [
    /\.subagent-dock-row\{/,
    /\.subagent-dock-row>\.subagent-dock-row-main\{/,
    /\.subagent-dock-row>\.subagent-dock-row-main:hover:not\(:disabled\)/,
  ]) {
    assert.match(
      builtCss,
      rule,
      "the built renderer CSS is stale or lacks the dock's own row-action rules: rebuild it before running this probe",
    );
  }
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });

  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Subagent dock</title>${css
      .map((path) => `<link rel="stylesheet" href="${path}">`)
      .join("")}<script src="renderer.js"></script>`,
  );

  await writeFile(
    join(temp, "main.cjs"),
    `
const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");
app.setPath("userData", path.join(__dirname, "profile"));
/*
 * Real key events, not synthetic clicks: Chromium only performs a button's
 * native Enter/Space activation for input that came through its input
 * pipeline, which is exactly what the dock's keyboard contract claims.
 */
async function pressKey(contents, key) {
  const dbg = contents.debugger;
  const attached = dbg.isAttached();
  if (!attached) dbg.attach("1.3");
  const spec =
    key === "Enter"
      ? { key: "Enter", code: "Enter", virtual: 13, text: String.fromCharCode(13) }
      : key === "Tab"
        ? { key: "Tab", code: "Tab", virtual: 9, text: null }
        : { key: " ", code: "Space", virtual: 32, text: " " };
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.virtual,
    nativeVirtualKeyCode: spec.virtual,
    modifiers: 0,
  };
  try {
    const down = spec.text === null ? { type: "keyDown" } : { type: "keyDown", text: spec.text };
    await dbg.sendCommand("Input.dispatchKeyEvent", Object.assign(down, base));
    await dbg.sendCommand("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base));
  } finally {
    if (!attached) dbg.detach();
  }
}
/*
 * A real pointer move, not a synthetic event: Chromium only owns :hover for
 * input that came through its input pipeline, which is what the row's paint
 * claim is about.
 */
async function hover(contents, point) {
  const dbg = contents.debugger;
  const attached = dbg.isAttached();
  if (!attached) dbg.attach("1.3");
  try {
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      clickCount: 0,
    });
  } finally {
    if (!attached) dbg.detach();
  }
}
/*
 * A real pointer button press and release, not a synthetic event: the pressed
 * paint claim is about Chromium's own :active state.
 */
async function mouse(contents, type, point) {
  const dbg = contents.debugger;
  const attached = dbg.isAttached();
  if (!attached) dbg.attach("1.3");
  try {
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  } finally {
    if (!attached) dbg.detach();
  }
}
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 720, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  const phases = {};
  const run = (phase) => window.webContents.executeJavaScript("globalThis.subagentDockProbePhase('" + phase + "')");
  const shot = async (name) => {
    const image = await window.webContents.capturePage();
    await writeFile(path.join(${JSON.stringify(artifactDir)}, name), image.toPNG());
  };
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    /*
     * The page must load the production stylesheets and nothing else: a source
     * partial linked or inlined here would reverse the real import order.
     */
    const audit = await window.webContents.executeJavaScript(
      "(() => ({ links: [...document.querySelectorAll('link[rel=stylesheet]')].map((link) => link.getAttribute('href')), styles: document.querySelectorAll('style').length }))()",
    );
    assert.deepEqual(
      audit.links,
      ${JSON.stringify(css)},
      "the probe page must load the built renderer stylesheets and nothing else",
    );
    assert.equal(audit.styles, 0, "no fixture stylesheet may be layered over the production CSS");
    phases.collapsed = await run("collapsed");
    await shot("subagent-dock-collapsed.png");
    phases.expanded = await run("expand");
    await shot("subagent-dock-expanded.png");
    phases.actions = await run("actions");
    await shot("subagent-dock-actions.png");
    // Hover paint: a real pointer over the row's open action, then away again.
    phases.hoverPrepare = await run("hover-prepare");
    await hover(window.webContents, phases.hoverPrepare.facts.hoverPoint);
    phases.hover = await run("hover-check");
    await shot("subagent-dock-hover.png");
    // Pressed paint: the same real pointer held down on the same action, with
    // the sibling row still resting beside it.
    await mouse(window.webContents, "mousePressed", phases.hoverPrepare.facts.hoverPoint);
    phases.pressed = await run("pressed-check");
    await shot("subagent-dock-pressed.png");
    await mouse(window.webContents, "mouseReleased", phases.hoverPrepare.facts.hoverPoint);
    await hover(window.webContents, { x: 4, y: 4 });
    phases.hoverAway = await run("hover-away");
    // Keyboard paint: walk the real Tab order from the disclosure onto the row's
    // open action, then on to the stop control of the same row.
    window.webContents.focus();
    phases.focusPrepare = await run("focus-prepare");
    for (let step = 0; step < 8; step += 1) {
      await pressKey(window.webContents, "Tab");
      const active = await run("active");
      if (String(active.facts.activeElement ?? "").includes("subagent-dock-row-main")) break;
    }
    phases.focusRow = await run("focus-row");
    await shot("subagent-dock-focus.png");
    await pressKey(window.webContents, "Tab");
    phases.focusStop = await run("focus-stop");
    // Keyboard activation: focus the first row, press Enter, then the second row's Space.
    phases.keyboardEnterPrepare = await run("keys-enter-prepare");
    await pressKey(window.webContents, "Enter");
    phases.keyboardEnter = await run("keys-enter-check");
    phases.keyboardSpacePrepare = await run("keys-space-prepare");
    await pressKey(window.webContents, " ");
    phases.keyboardSpace = await run("keys-space-check");
    phases.drive = await run("drive");
    console.log("SUBAGENT_DOCK_PROBE " + JSON.stringify({ ok: true, phases }));
    app.quit();
  } catch (error) {
    console.error("SUBAGENT_DOCK_PROBE " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)], phases }));
    app.exit(1);
  }
});
`,
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      output += data;
    });
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("SUBAGENT_DOCK_PROBE "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("SUBAGENT_DOCK_PROBE ".length));
  console.log("SUBAGENT_DOCK_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
  for (const [phase, value] of Object.entries(result.phases ?? {})) {
    assert.deepEqual(value.failures ?? [], [], `subagent dock checks failed: ${phase}`);
  }
  console.log(
    "SUBAGENT_DOCK_PROBE screenshots " +
      [
        join(artifactDir, "subagent-dock-collapsed.png"),
        join(artifactDir, "subagent-dock-expanded.png"),
        join(artifactDir, "subagent-dock-actions.png"),
        join(artifactDir, "subagent-dock-hover.png"),
        join(artifactDir, "subagent-dock-pressed.png"),
        join(artifactDir, "subagent-dock-focus.png"),
      ].join(" "),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
