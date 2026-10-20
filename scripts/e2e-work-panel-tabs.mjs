import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-work-panel-tabs-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/work-panel-tabs.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: {
      ".woff": "empty",
      ".woff2": "empty",
      ".ttf": "empty",
      ".png": "empty",
      ".svg": "empty",
    },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><title>Work panel tabs</title><body><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "preload.cjs"),
    `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("probeClickAt", (x, y) => ipcRenderer.invoke("probe:click", x, y));
`,
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  // Frameless, like the shipped window: native drag rectangles only exist in
  // that topology.
  const window = new BrowserWindow({ show: true, frame: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(__dirname, "preload.cjs") } });
  window.setAlwaysOnTop(true, "screen-saver");
  window.webContents.on("console-message", (event) => console.error(event.message));
  // Real window-level mouse input, not a synthesized DOM event: this is the
  // path where a native drag rectangle can withhold the press.
  ipcMain.handle("probe:click", async (event, x, y) => {
    window.webContents.sendInputEvent({ type: "mouseMove", x, y });
    window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    // Keyboard focus styling (:focus) only matches inside a focused document.
    app.focus({ steal: true });
    window.show();
    window.focus();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await window.webContents.executeJavaScript("globalThis.workPanelTabsProbe()");
    console.log("WORK_PANEL_TABS_PROBE " + JSON.stringify(result));
    app.exit(result?.ok === true ? 0 : 1);
  } catch (error) {
    console.error("WORK_PANEL_TABS_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
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
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
    });
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
    .find((line) => line.startsWith("WORK_PANEL_TABS_PROBE "));
  assert(line, `renderer returned no result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("WORK_PANEL_TABS_PROBE ".length));
  console.log(line);
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
