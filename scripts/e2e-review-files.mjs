#!/usr/bin/env node
/**
 * The Review panel's per-file net change, rendered and driven in a real
 * Chromium renderer with the application's own built stylesheet: one row per
 * file the conversation touched, net totals including a lower bound when a file
 * cannot be counted, the specific reason a row has no line evidence, and the
 * file-level rollback that names every snapshot behind the row.
 *
 * The fixture mounts the production ReviewTab and store; only the IPC
 * transport is replaced. The runner bundles them, hands them the app's
 * stylesheet, drives the probe in an isolated Electron window with its own
 * profile, and writes a screenshot next to the probe result.
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
const artifactDir = process.env.PI_REVIEW_FILES_ARTIFACT_DIR ?? tmpdir();
const temp = await mkdtemp(join(tmpdir(), "pi-review-files-"));

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/review-files.tsx")],
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
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"),
      "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });

  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map(
    (match) => match[1],
  );
  assert(
    css.length,
    "Build the app with pnpm build:js before running this check",
  );
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });

  // The panel measures rules that only exist in the built stylesheet, so a
  // stale build fails here instead of passing against older CSS.
  const builtCss = (
    await Promise.all(css.map((path) => readFile(join(renderer, path), "utf8")))
  )
    .join("\n")
    .replace(/\s+/g, "");
  for (const rule of [
    ".review-change-card{",
    ".review-change-card-header{",
    ".diff-counts{",
    ".review-toolbar-counts{",
  ]) {
    assert(
      builtCss.includes(rule),
      `the built stylesheet is stale (missing ${rule}); build with pnpm build:js`,
    );
  }

  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Review files</title>${css
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
  const window = new BrowserWindow({ show: false, width: 720, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    const result = await window.webContents.executeJavaScript("globalThis.reviewFilesProbe()");
    const image = await window.webContents.capturePage();
    await writeFile(path.join(${JSON.stringify(artifactDir)}, "review-files.png"), image.toPNG());
    console.log("REVIEW_FILES_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error("REVIEW_FILES_PROBE " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)] }));
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
    .find((entry) => entry.startsWith("REVIEW_FILES_PROBE "));
  assert(
    line,
    `renderer returned no probe result (exit=${code}): ${output.slice(-3000)}`,
  );
  const result = JSON.parse(line.slice("REVIEW_FILES_PROBE ".length));
  console.log("REVIEW_FILES_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.deepEqual(result.failures ?? [], [], "review file checks failed");
  assert.equal(result.ok, true);
  console.log(
    "REVIEW_FILES_PROBE screenshot " + join(artifactDir, "review-files.png"),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
