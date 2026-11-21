#!/usr/bin/env node
/**
 * Delegate-tab parallel tools in a real Chromium renderer.
 *
 * Runs the `scripts/e2e/subagent-parallel-order.tsx` fixture in its own
 * isolated Electron window (own profile, no host process, no user data)
 * against the application's built stylesheet. The fixture mounts the
 * production `SubagentTranscriptTab` and drives real `AgentEvent`s through
 * the app store, sampling the painted `data-message-id` order and each
 * delegate row's bounding box frame by frame.
 *
 * Build the renderer first: `pnpm --filter @pi-desktop/desktop build`.
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
// The Electron runtime is provisioned once per host; this worktree reuses it by
// absolute path instead of downloading a second copy.
const electronBinary =
  process.env.PI_ELECTRON_BINARY ?? resolveElectronBinary(root).electronBinary;
const artifactDir = process.env.PI_SUBAGENT_PARALLEL_ORDER_ARTIFACT_DIR ?? tmpdir();
const temp = await mkdtemp(join(tmpdir(), "pi-subagent-parallel-order-"));

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/subagent-parallel-order.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"MODE":"production"}',
    },
    // The transcript's own stylesheet is the app's built one, linked below.
    loader: { ".css": "empty" },
    plugins: [
      {
        name: "local-url-assets",
        setup(build) {
          build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
            path: join(resolveDir, path.slice(0, -4)),
            namespace: "local-url-asset",
          }));
          build.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
            contents: await readFile(path),
            loader: "file",
          }));
        },
      },
    ],
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"),
      "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });

  // The geometry checks only mean something against the real transcript layers:
  // the row box, its internal padding and the thread width come from the built
  // stylesheet. Layout is measured, so a missing stylesheet has to fail loudly.
  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build the app with pnpm --filter @pi-desktop/desktop build before running this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  const builtCss = (
    await Promise.all(css.map((path) => readFile(join(renderer, path), "utf8")))
  )
    .join("\n")
    .replace(/\s+/g, "");
  for (const [selector, declaration] of [
    [".thread-scroll{", "overflow:auto"],
    [".thread-wrap{", "position:relative"],
  ]) {
    const start = builtCss.indexOf(selector);
    assert(
      start >= 0,
      `the built stylesheet is missing ${selector}; build with pnpm --filter @pi-desktop/desktop build`,
    );
    const block = builtCss.slice(start, builtCss.indexOf("}", start));
    assert(
      block.includes(declaration),
      `the built stylesheet rule ${selector} is missing ${declaration}`,
    );
  }

  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Subagent parallel tool call order</title>${css
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
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    const result = await window.webContents.executeJavaScript("globalThis.subagentParallelOrderProbe()");
    const image = await window.webContents.capturePage();
    const screenshot = path.join(${JSON.stringify(artifactDir)}, "subagent-parallel-order.png");
    await writeFile(screenshot, image.toPNG());
    result.screenshot = screenshot;
    console.log("SUBAGENT_PARALLEL_ORDER_PROBE " + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error("SUBAGENT_PARALLEL_ORDER_PROBE " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)] }));
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
    .find((entry) => entry.startsWith("SUBAGENT_PARALLEL_ORDER_PROBE "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("SUBAGENT_PARALLEL_ORDER_PROBE ".length));
  // The payload carries every sampled frame; a readable summary is what a log
  // needs, and the raw trace stays available for a deeper look.
  console.log(
    "SUBAGENT_PARALLEL_ORDER_SUMMARY " +
      JSON.stringify({
        ok: result.ok,
        failures: result.failures,
        scenarios: (result.scenarios ?? []).map((scenario) => ({
          label: scenario.label,
          failures: scenario.failureCount ?? (scenario.failures ?? []).length,
          stages: (scenario.stages ?? []).map((stage) => ({
            stage: stage.stage,
            frame: stage.frame,
            pair: stage.pair,
            tops: stage.tops,
            phase: stage.phase,
            entryPair: stage.entryPair,
            mergedPair: stage.mergedPair,
            instances: stage.instances,
            boxes: stage.boxes,
          })),
        })),
      }),
  );
  console.log("SUBAGENT_PARALLEL_ORDER_SCREENSHOT " + result.screenshot);
  if (process.env.PI_SUBAGENT_PARALLEL_ORDER_VERBOSE === "1") {
    console.log("SUBAGENT_PARALLEL_ORDER_PROBE " + JSON.stringify(result));
  }
  assert.equal(code, 0, output.slice(-6000));
  assert.deepEqual(result.failures ?? [], [], "subagent parallel call order checks failed");
  assert.equal(result.ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
