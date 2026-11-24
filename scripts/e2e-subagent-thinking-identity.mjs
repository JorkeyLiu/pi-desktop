#!/usr/bin/env node
/**
 * The child's transcript tab keeps one stable row per (kind, message id).
 *
 * A historical assistant message carries both reasoning and text, so the
 * transcript emits a thinking row and an answer row for the same message id.
 * The fixture mounts the production `SubagentTranscriptTab` with the real
 * app store in a real Chromium renderer, expands the historical thinking row,
 * then drives the view rebuilds a live delegate causes — a streaming
 * thinking-only row that gains its answer, later appends, and a turn reorder —
 * and asserts every thinking node stays on its own message: no duplicated
 * previews, no lost expansion, no swallowed content. No provider, paid API or
 * running desktop is used. No geometry is asserted, so the fixture needs no
 * built stylesheet.
 */
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
const temp = await mkdtemp(join(tmpdir(), "pi-subagent-thinking-identity-"));

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/subagent-thinking-identity.tsx")],
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

  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'"><title>Child transcript row identity</title><script src="renderer.js"></script>`,
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 800, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.subagentThinkingIdentityProbe()");
    console.log("SUBAGENT_THINKING_IDENTITY_PROBE " + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error("SUBAGENT_THINKING_IDENTITY_PROBE " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)], facts: {} }));
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
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
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
    .find((entry) => entry.startsWith("SUBAGENT_THINKING_IDENTITY_PROBE "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("SUBAGENT_THINKING_IDENTITY_PROBE ".length));
  console.log("SUBAGENT_THINKING_IDENTITY_PROBE " + JSON.stringify(result, null, 2));
  assert.equal(code, 0, output.slice(-6000));
  assert.deepEqual(result.failures ?? [], [], "child transcript row identity checks failed");
} finally {
  await rm(temp, { recursive: true, force: true });
}
