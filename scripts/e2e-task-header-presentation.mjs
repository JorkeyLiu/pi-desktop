#!/usr/bin/env node
/**
 * The unified task header: a targeted `TaskSteer` reuses the delivered
 * `TaskWait` compact header — left tool identity plus the plain recorded
 * agent, right target title tile plus the row state.
 *
 * The fixture mounts production components only; this runner bundles them,
 * hands them the app's stylesheet, drives the probe in an isolated Electron
 * window with its own profile at a wide and a narrow width, and writes a
 * screenshot per width next to the probe result. No real page, provider, or
 * network is touched: every result is a canned host payload shaped exactly
 * as pi-ai delivers it (`{ content, details }`).
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
const artifactDir = process.env.PI_TASK_HEADER_ARTIFACT_DIR ?? tmpdir();
const temp = await mkdtemp(join(tmpdir(), "pi-task-header-"));

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/task-header-presentation.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"MODE":"production"}',
    },
    // The rows' own stylesheet is the app's built one, linked below.
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
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build the app with pnpm build:js before running this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });

  // The scenario measures rules that only exist in the built stylesheet, so a
  // stale build has to fail here instead of passing against older CSS.
  const builtCss = (
    await Promise.all(css.map((path) => readFile(join(renderer, path), "utf8")))
  )
    .join("\n")
    .replace(/\s/g, "");
  for (const rule of [".tool-row-lifecycle{", ".tool-row-agent.is-delivered{"]) {
    assert(
      builtCss.includes(rule),
      `the built stylesheet is stale (missing ${rule}); build with pnpm build:js`,
    );
  }

  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Task header presentation</title>${css
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
  const window = new BrowserWindow({ show: false, width: 1320, height: 1500, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  const results = {};
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    for (const [mode, width, shot] of [["wide", 1320, "task-header-presentation-wide.png"], ["narrow", 480, "task-header-presentation-narrow.png"]]) {
      window.setSize(width, 1500);
      await new Promise((resolve) => setTimeout(resolve, 400));
      results[mode] = await window.webContents.executeJavaScript("globalThis.taskHeaderProbe(" + JSON.stringify(mode) + ")");
      const image = await window.webContents.capturePage();
      await writeFile(path.join(${JSON.stringify(artifactDir)}, shot), image.toPNG());
    }
    console.log("TASK_HEADER_PROBE " + JSON.stringify(results));
    app.quit();
  } catch (error) {
    console.error("TASK_HEADER_PROBE " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)] }));
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
    .find((entry) => entry.startsWith("TASK_HEADER_PROBE "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-3000)}`);
  const results = JSON.parse(line.slice("TASK_HEADER_PROBE ".length));
  const failures = Object.values(results).flatMap((result) => result?.failures ?? []);
  console.log("TASK_HEADER_PROBE " + JSON.stringify(results));
  assert.equal(code, 0, output.slice(-6000));
  assert.deepEqual(failures, [], "task header presentation checks failed");
  assert.equal(
    Object.values(results).every((result) => result?.ok === true),
    true,
  );
  console.log(
    "TASK_HEADER_PROBE screenshots " +
      join(artifactDir, "task-header-presentation-wide.png") +
      " " +
      join(artifactDir, "task-header-presentation-narrow.png"),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
