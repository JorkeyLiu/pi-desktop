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
const temp = await mkdtemp(join(tmpdir(), "pi-sidebar-pending-marker-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/sidebar-pending-marker.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".woff2": "dataurl" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  // The probe measures painted marks, so the real renderer stylesheet ships
  // beside the harness bundle.
  await build({
    // The status marks live in the sidebar pair plus the shared tokens and
    // base reset; importing globals.css would pull Tailwind utilities this
    // probe never exercises.
    stdin: {
      contents: [
        '@import "./tokens.css";',
        '@import "./base.css";',
        '@import "./ui-kit.css";',
        '@import "./sidebar-threads.css";',
        '@import "./sessions.css";',
      ].join("\n"),
      resolveDir: join(root, "apps/desktop/src/styles"),
      loader: "css",
    },
    outfile: join(temp, "styles.css"),
    bundle: true,
    loader: { ".png": "dataurl", ".svg": "dataurl", ".woff2": "dataurl" },
  });
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><title>Sidebar pending marker</title><link rel="stylesheet" href="styles.css"><body><div id="root"></div><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const emit = (phase, result) => console.log("SIDEBAR_PENDING_MARKER_PROBE " + JSON.stringify({ phase, ...result }));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  const load = () => window.loadFile(path.join(__dirname, "index.html"));
  try {
    await load();
    const idle = await window.webContents.executeJavaScript("globalThis.sidebarPendingMarkerIdleProbe()");
    emit("idle", idle);
    await load();
    const persistence = await window.webContents.executeJavaScript(
      "globalThis.sidebarPendingMarkerPersistenceProbe(" + JSON.stringify(idle.markedId) + ")",
    );
    emit("persistence", persistence);
    const focused = await window.webContents.executeJavaScript(
      "globalThis.sidebarPendingMarkerFocusMark('beta')",
    );
    if (!focused) throw new Error("could not focus the beta mark");
    for (const type of ["keyDown", "keyUp"]) {
      await window.webContents.sendInputEvent({ type: type === "keyDown" ? "rawKeyDown" : "keyUp", keyCode: "Enter" });
    }
    window.webContents.sendInputEvent({ type: "char", keyCode: "\\r" });
    const activation = await window.webContents.executeJavaScript("globalThis.sidebarPendingMarkerActivationProbe()");
    emit("activation", activation);
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await load();
    const reduced = await window.webContents.executeJavaScript("globalThis.sidebarPendingMarkerReducedMotionProbe()");
    emit("reduced", reduced);
    window.webContents.debugger.detach();
    const phases = [idle, persistence, activation, reduced];
    const ok = phases.every((phase) => (phase.checks ?? []).every((check) => check.ok));
    console.log("SIDEBAR_PENDING_MARKER_RESULT " + JSON.stringify({ ok }));
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error("SIDEBAR_PENDING_MARKER_PROBE_ERROR " + String(error?.stack ?? error));
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
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  const phases = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("SIDEBAR_PENDING_MARKER_PROBE ")) continue;
    phases.push(JSON.parse(line.slice("SIDEBAR_PENDING_MARKER_PROBE ".length)));
  }
  assert.ok(phases.length === 4, `probe phases did not run (exit ${code}):\n${stderr.slice(-2000)}`);
  let failed = 0;
  for (const phase of phases) {
    for (const check of phase.checks ?? []) {
      if (!check.ok) failed += 1;
      console.log(`${check.ok ? "ok  " : "FAIL"} [${phase.phase}] ${check.label} ${JSON.stringify(check.detail)}`);
    }
  }
  const result = stdout
    .split("\n")
    .find((entry) => entry.startsWith("SIDEBAR_PENDING_MARKER_RESULT "));
  assert.ok(result, `probe did not finish (exit ${code}):\n${stderr.slice(-2000)}`);
  const summary = JSON.parse(result.slice("SIDEBAR_PENDING_MARKER_RESULT ".length));
  assert.equal(failed, 0, `${failed} sidebar pending marker checks failed`);
  assert.equal(summary.ok, true);
  console.log("sidebar pending marker probe passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}
