#!/usr/bin/env node
/**
 * The child's transcript tab jump-to-latest control, measured in a real
 * Chromium renderer with the application's own built stylesheet.
 *
 * The fixture mounts the production `SubagentTranscriptTab` inside the work
 * panel's own body, so the probe reads the pane's real scrollport, its real
 * composer and the real floating control. The claim is one geometry contract:
 * the control is horizontally centred just above the transcript viewport's
 * bottom edge — always above the composer, at any composer height (empty draft,
 * multi-line draft, staged image) and any panel width — and it still appears on
 * a real upward gesture, returns to the newest row when clicked, and hands the
 * view back to follow mode afterwards.
 *
 * The same assertions run against whatever source tree `PI_SUBAGENT_JUMP_ROOT`
 * names, so a pre-fix checkout reports the same claims as failures from its own
 * built stylesheet instead of from a stale build.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.PI_SUBAGENT_JUMP_ROOT
  ? join(process.env.PI_SUBAGENT_JUMP_ROOT)
  : here;
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const artifactDir = process.env.PI_SUBAGENT_JUMP_ARTIFACT_DIR ?? tmpdir();
const widths = [340, 620];
const probe = join(here, "scripts/e2e/subagent-transcript-jump.tsx");
const temp = await mkdtemp(join(tmpdir(), "pi-subagent-jump-"));

try {
  await build({
    entryPoints: [probe],
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
  assert(
    css.length,
    `Build the renderer of ${root} first (electron-vite build) before this check`,
  );
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });

  // A stale build would measure the old placement, so the rules this probe
  // asserts have to be the ones in the stylesheet it links. The pair is
  // reported rather than required: a pre-fix tree legitimately lacks the
  // viewport wrapper, and its measurement is the failure evidence.
  const builtCss = (
    await Promise.all(css.map((path) => readFile(join(renderer, path), "utf8")))
  )
    .join("\n")
    .replace(/\s+/g, "");
  const built = {
    root,
    viewportWrapper: builtCss.includes(".subagent-transcript-viewport{"),
    jumpAnchoredToViewport: /\.subagent-transcript-jump\{[^}]*bottom:8px/.test(builtCss),
    staleComposerVariable: builtCss.includes("--st-composer-dock-height"),
  };
  console.log("SUBAGENT_JUMP_BUILD " + JSON.stringify(built));

  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:"><title>Child transcript jump control</title>${css
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
  const run = (width) => window.webContents.executeJavaScript("globalThis.subagentTranscriptJumpProbe(" + width + ")");
  const shot = async (name) => {
    const image = await window.webContents.capturePage();
    await writeFile(path.join(${JSON.stringify(artifactDir)}, name), image.toPNG());
  };
  try {
    for (const width of ${JSON.stringify(widths)}) {
      // A fresh mount per width: the probe grows the composer, so the pane has
      // to start from the same empty draft every time.
      await window.loadFile(path.join(__dirname, "index.html"));
      await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
      phases[width] = await run(width);
      await shot("subagent-transcript-jump-" + width + ".png");
    }
    console.log("SUBAGENT_JUMP_PROBE " + JSON.stringify({ ok: true, phases }));
    app.quit();
  } catch (error) {
    console.error("SUBAGENT_JUMP_PROBE " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)], phases }));
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
    .find((entry) => entry.startsWith("SUBAGENT_JUMP_PROBE "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("SUBAGENT_JUMP_PROBE ".length));
  console.log("SUBAGENT_JUMP_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
  for (const [width, value] of Object.entries(result.phases ?? {})) {
    assert.deepEqual(value.failures ?? [], [], `child transcript jump checks failed at ${width}px`);
  }
  console.log(
    "SUBAGENT_JUMP_PROBE screenshots " +
      widths.map((width) => join(artifactDir, `subagent-transcript-jump-${width}.png`)).join(" "),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
