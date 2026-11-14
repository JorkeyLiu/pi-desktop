#!/usr/bin/env node
/**
 * The delegate panel's history under a changing parent window, measured in a
 * real Chromium renderer with the application's own built stylesheet.
 *
 * The fixture mounts the production `SubagentTranscriptTab` inside the work
 * panel's own body and stubs only the preload bridge, which answers
 * `session.get` the way a scoped backend does and records every request. The
 * probe holds the parent conversation behind thousands of delegate child rows,
 * then replaces, reduces, restores, and pages that window while asserting the
 * panel's page, chain identity, and availability stay exactly as they were —
 * and that every read it spent was one bounded delegation-scoped page.
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
const artifactDir = process.env.PI_SCOPED_HISTORY_ARTIFACT_DIR ?? tmpdir();
const temp = await mkdtemp(join(tmpdir(), "pi-scoped-history-"));

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/scoped-subagent-history.tsx")],
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
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
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
  assert(css.length, `Build the renderer of ${root} first (electron-vite build) before this check`);
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });

  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:"><title>Scoped delegate history</title>${css
      .map((path) => `<link rel="stylesheet" href="${path}">`)
      .join("")}<script src="renderer.js"></script>`,
  );

  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    const result = await window.webContents.executeJavaScript("globalThis.scopedHistoryProbe()");
    const image = await window.webContents.capturePage();
    await writeFile(path.join(${JSON.stringify(artifactDir)}, "scoped-subagent-history.png"), image.toPNG());
    console.log("SCOPED_HISTORY_PROBE " + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error("SCOPED_HISTORY_PROBE " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)] }));
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
  const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
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
    .find((entry) => entry.startsWith("SCOPED_HISTORY_PROBE "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("SCOPED_HISTORY_PROBE ".length));
  console.log("SCOPED_HISTORY_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures ?? [], [], "scoped delegate history checks failed");
  console.log(
    "SCOPED_HISTORY_PROBE screenshot " + join(artifactDir, "scoped-subagent-history.png"),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
