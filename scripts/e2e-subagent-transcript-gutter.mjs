#!/usr/bin/env node
/**
 * The child's transcript tab in the work panel, measured in a real Chromium
 * renderer with the application's own built stylesheet.
 *
 * The fixture mounts the production `SubagentTranscriptTab`, so the probe reads
 * the pane's real scrollport, its real `ToolRow` cards and its real composer.
 * The claim is one geometry invariant: opening a long command detail makes the
 * child transcript overflow, and that overflow must not narrow the content or
 * move any row. The same measurements are repeated with the shipped
 * `scrollbar-gutter: stable` overridden to `auto` on that scrollport, which
 * records the pane's behavior before the rule — in the same renderer, with the
 * same content and the same app scrollbar styling.
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
const artifactDir =
  process.env.PI_SUBAGENT_TRANSCRIPT_GUTTER_ARTIFACT_DIR ?? tmpdir();
const widths = [340, 760];
const temp = await mkdtemp(join(tmpdir(), "pi-subagent-gutter-"));

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/subagent-transcript-gutter.tsx")],
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
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build the app renderer once (pnpm --filter @pi-desktop/desktop build) before this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });

  // A stale build would measure the old scrollport, so the rule has to be in
  // the built stylesheet this probe links.
  const builtCss = (
    await Promise.all(css.map((path) => readFile(join(renderer, path), "utf8")))
  )
    .join("\n")
    .replace(/\s+/g, "");
  for (const rule of [
    ".subagent-transcript-scroll{",
    ".subagent-transcript-scroll{scrollbar-gutter:stable",
    ".subagent-transcript-list{",
    ".tool-row-header{",
  ]) {
    assert(
      builtCss.includes(rule),
      `the built stylesheet is stale (missing ${rule}); rebuild the desktop renderer`,
    );
  }

  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Child transcript gutter</title>${css
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
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  const phases = {};
  const run = (width) => window.webContents.executeJavaScript("globalThis.subagentTranscriptGutterProbe(" + width + ")");
  const shot = async (name) => {
    const image = await window.webContents.capturePage();
    await writeFile(path.join(${JSON.stringify(artifactDir)}, name), image.toPNG());
  };
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    for (const width of ${JSON.stringify(widths)}) {
      phases[width] = await run(width);
      await shot("subagent-transcript-gutter-" + width + ".png");
    }
    console.log("SUBAGENT_GUTTER_PROBE " + JSON.stringify({ ok: true, phases }));
    app.quit();
  } catch (error) {
    console.error("SUBAGENT_GUTTER_PROBE " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)], phases }));
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
    .find((entry) => entry.startsWith("SUBAGENT_GUTTER_PROBE "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("SUBAGENT_GUTTER_PROBE ".length));
  console.log("SUBAGENT_GUTTER_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
  for (const [width, value] of Object.entries(result.phases ?? {})) {
    assert.deepEqual(value.failures ?? [], [], `child transcript gutter checks failed at ${width}px`);
  }
  console.log(
    "SUBAGENT_GUTTER_PROBE screenshots " +
      widths.map((width) => join(artifactDir, `subagent-transcript-gutter-${width}.png`)).join(" "),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
