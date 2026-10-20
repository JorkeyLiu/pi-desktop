#!/usr/bin/env node
/**
 * A path-heavy child transcript names its files.
 *
 * The fixture mounts the production `SubagentTranscriptTab` with production
 * `ToolRow` cards in a real Chromium renderer and the application's own built
 * stylesheet. A collapsed file row must print the file's own name — never the
 * directory, never an omission the row composed — while the whole path stays one
 * hover and one screen-reader description away. The same tab is opened, closed
 * and switched between sessions, and no element exists in a row to measure path
 * candidates.
 *
 * Usage: node scripts/e2e-tool-path-name.mjs
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
const rowCount = 120;
const widths = [280, 620];
const artifactDir = process.env.PI_TOOL_PATH_NAME_ARTIFACT_DIR;
const temp = await mkdtemp(join(tmpdir(), "pi-tool-path-name-"));

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/tool-path-name.tsx")],
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
  assert(
    css.length,
    "Build the app renderer once (pnpm --filter @pi-desktop/desktop build) before this check",
  );
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });

  const builtCss = (
    await Promise.all(css.map((path) => readFile(join(renderer, path), "utf8")))
  )
    .join("\n")
    .replace(/\s+/g, "");
  for (const rule of [
    ".tool-row-summary.is-path{",
    ".subagent-transcript-scroll{",
    ".subagent-transcript-list{",
  ]) {
    assert(
      builtCss.includes(rule),
      `the built stylesheet is stale (missing ${rule}); rebuild the desktop renderer`,
    );
  }
  // The measurement the row used to carry is gone from the stylesheet too.
  assert(
    !builtCss.includes(".tool-path-measure"),
    "the built stylesheet still styles a path measuring span",
  );

  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Tool path name</title>${css
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
    const result = await window.webContents.executeJavaScript("globalThis.toolPathNameRun(" + JSON.stringify(${JSON.stringify({ rowCount, widths })}) + ")");
    ${
      artifactDir
        ? `const image = await window.webContents.capturePage();\n    await writeFile(path.join(${JSON.stringify(artifactDir)}, "tool-path-name.png"), image.toPNG());`
        : ""
    }
    console.log("TOOL_PATH_NAME " + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error("TOOL_PATH_NAME " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)] }));
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
    .find((entry) => entry.startsWith("TOOL_PATH_NAME "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("TOOL_PATH_NAME ".length));
  console.log(
    "TOOL_PATH_NAME " +
      JSON.stringify({
        ok: result.ok,
        failures: result.failures,
        facts: result.facts,
        environment: {
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          platform: process.platform,
        },
      }),
  );
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(
    result.ok,
    true,
    `tool path name checks failed:\n${(result.failures ?? []).join("\n")}`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
