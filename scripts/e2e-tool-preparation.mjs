#!/usr/bin/env node
/**
 * Tool-call preparation in a real renderer: the production transcript and
 * delegate tab, the production events slice, and the application's built
 * stylesheet, driven in an isolated Electron window with its own profile.
 *
 * The probe covers what a static render cannot: which element actually
 * animates, that argument completion stops it before execution, that the
 * executing row replaces the preparing row in place across a steering insert,
 * the reduced-motion rule, and the child tab's working indicator. The painted
 * frame is written next to the probe result.
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
  process.env.PI_TOOL_PREPARATION_ARTIFACT_DIR ?? tmpdir();
const temp = await mkdtemp(join(tmpdir(), "pi-tool-preparation-"));

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/tool-preparation.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"MODE":"production"}',
    },
    // The row's own stylesheet is the app's built one, linked below.
    loader: { ".css": "empty" },
    plugins: [
      {
        name: "local-url-assets",
        setup(build) {
          // The delegate composer imports the dormant voice worklet via Vite's
          // ?url form; keep a real local asset URL instead of failing the bundle.
          build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
            path: join(resolveDir, path.slice(0, -4)),
            namespace: "local-url-asset",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "local-url-asset" },
            async ({ path }) => ({ contents: await readFile(path), loader: "file" }),
          );
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

  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build the app with pnpm build:js before running this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });

  // The breath, the card's skeleton shimmer and their reduced-motion
  // suppression live only in the built stylesheet, so a stale build has to
  // fail here instead of passing.
  const builtCss = (
    await Promise.all(css.map((path) => readFile(join(renderer, path), "utf8")))
  )
    .join("\n")
    .replace(/\s+/g, "");
  const staleCss = [];
  for (const rule of [
    "@keyframessubagent-task-skeleton-shimmer{0%{background-position:90%0}to{background-position:10%0}",
    "animation:1slinearinfinitesubagent-task-skeleton-shimmer",
    ".subagent-task-skeleton-line.is-title{width:min(58%,240px);height:calc(var(--text-sm-plus)*var(--leading-body))}",
    ".subagent-task-skeleton-line.is-role{width:min(34%,140px);height:calc(var(--text-2xs)*var(--leading-normal))}",
    ".subagent-task-skeleton-line.is-metrics{width:min(46%,190px);height:calc(var(--text-2xs)*var(--leading-normal))}",
    "is-preparing>.subagent-task-card:disabled{opacity:1}",
    "@media(prefers-reduced-motion:reduce){.tool-row.is-preparing",
    "@media(prefers-reduced-motion:reduce){.subagent-task-skeleton-bar{animation:none",
  ]) {
    // A stale build is reported beside the renderer's own findings instead of
    // aborting the run: a stale stylesheet is exactly the failure that would
    // otherwise hide the geometry it broke.
    if (!builtCss.includes(rule)) {
      staleCss.push(
        `the built stylesheet is stale (missing ${rule.slice(0, 60)}…); build with pnpm build:js`,
      );
    }
  }

  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Tool preparation</title>${css
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
  const window = new BrowserWindow({ show: false, width: 1180, height: 860, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    const preparation = await window.webContents.executeJavaScript("globalThis.toolPreparationProbe()");
    await window.webContents.executeJavaScript("globalThis.toolPreparationScreenshotProbe()");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const image = await window.webContents.capturePage();
    const screenshot = path.join(${JSON.stringify(artifactDir)}, "tool-preparation.png");
    await writeFile(screenshot, image.toPNG());
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const reducedMotion = await window.webContents.executeJavaScript("globalThis.toolPreparationReducedMotionProbe()");
    window.webContents.debugger.detach();
    const result = {
      ...preparation,
      failures: [...${JSON.stringify(staleCss)}, ...(preparation.failures ?? [])],
      reducedMotion,
      screenshot,
      ok: preparation.ok && reducedMotion.ok && ${staleCss.length} === 0,
    };
    console.log("TOOL_PREPARATION_PROBE " + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error("TOOL_PREPARATION_PROBE " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)] }));
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
    .find((entry) => entry.startsWith("TOOL_PREPARATION_PROBE "));
  assert(
    line,
    `renderer returned no probe result (exit=${code}): ${output.slice(-4000)}`,
  );
  const result = JSON.parse(line.slice("TOOL_PREPARATION_PROBE ".length));
  console.log("TOOL_PREPARATION_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.deepEqual(result.failures ?? [], [], "tool preparation checks failed");
  assert.deepEqual(
    result.reducedMotion?.failures ?? [],
    [],
    "reduced-motion checks failed",
  );
  assert.equal(result.ok, true);
  console.log("TOOL_PREPARATION_PROBE screenshot " + result.screenshot);
} finally {
  await rm(temp, { recursive: true, force: true });
}
