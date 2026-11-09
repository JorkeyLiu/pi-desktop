#!/usr/bin/env node
/**
 * Native wheel input over the transcript's tool cards.
 *
 * The transcript, its scroll attribution, the production stylesheet, and every
 * card are the app's own code built from this checkout; only the history and the
 * host shell are fixtures. Wheel input is delivered by the Electron main process
 * as a real `mouseWheel` event, so what moves is decided by Chromium's own
 * scroll chaining and `overscroll-behavior` - never by a dispatched synthetic
 * `WheelEvent`, which proves nothing about the browser's default scroll.
 *
 * `apps/desktop/out/renderer` must be built from this checkout first.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = new URL("..", import.meta.url).pathname;
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? root, "transcript-tool-wheel-"));

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/transcript-tool-wheel.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": JSON.stringify({ DEV: false, MODE: "production" }),
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
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build Desktop in this checkout before running this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">` +
      `${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head>` +
      `<body><div id="root"></div><script src="renderer.js"></script></body></html>`,
  );

  const env = { ...process.env, PROBE_DIR: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electronBinary,
    [join(root, "scripts/e2e/transcript-tool-wheel-main.cjs")],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (output += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timer);
  }
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("TOOL_WHEEL_PROBE "));
  if (!line) {
    console.log(output.slice(-6000));
    assert.fail(`No probe result (exit=${code})`);
  }
  const result = JSON.parse(line.slice("TOOL_WHEEL_PROBE ".length));
  console.log(JSON.stringify({ environment: result.environment, steps: result.steps, failures: result.failures }, null, 1));
  assert.equal(result.failures.length, 0, `\n${result.failures.join("\n")}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
