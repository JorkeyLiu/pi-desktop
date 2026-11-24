#!/usr/bin/env node
/** Rendered runtime evidence for the single secondary-window layer, in isolated Electron.

Mounts the production chat shell state, Settings/Extensions/Scheduled lazy
pages, shared dismissal path, Escape ownership, and retention behavior with
bundled production CSS. Only the preload boundary uses fixture data; all stores,
plates, pages, and styles are the shipped code paths.

Windows (viewport WxH, two runs): 1200x900 (preferred sizes) and 800x600
(near-fullscreen inset). Screenshots land in `$PI_SCRATCH_DIR`. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const urlAssets = {
  name: "local-url-assets",
  setup(buildRunner) {
    buildRunner.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
      path: join(resolveDir, path.slice(0, -4)),
      namespace: "local-url-asset",
    }));
    buildRunner.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
      contents: await readFile(path),
      loader: "file",
    }));
  },
};

const VIEWPORTS = [
  { width: 1200, height: 900 },
  { width: 800, height: 600 },
];

const scratch =
  process.env.PI_SCRATCH_DIR && process.env.PI_SCRATCH_DIR.length > 0
    ? process.env.PI_SCRATCH_DIR
    : tmpdir();

async function runOnce({ width, height }) {
  const temp = await mkdtemp(join(tmpdir(), "pi-secondary-windows-"));
  try {
    await build({
      entryPoints: [join(root, "scripts/e2e/secondary-windows.jsx")],
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": '"true"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      loader: { ".woff": "empty", ".woff2": "empty", ".ttf": "empty", ".png": "empty" },
      plugins: [
        urlAssets,
        {
          name: "secondary-windows-asset-stubs",
          setup(assetBuild) {
            assetBuild.onResolve({ filter: /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|webp|ico|avif|mp3|wav|ogg|flac)$/ }, ({ path, resolveDir }) => {
              if (path.startsWith(".")) {
                return { path: join(resolveDir, path.split("?")[0]), namespace: "secondary-windows-asset" };
              }
              return null;
            });
            assetBuild.onLoad({ filter: /.*/, namespace: "secondary-windows-asset" }, () => ({
              contents: "export default '';",
              loader: "js",
            }));
          },
        },
      ],
    });
    const renderer = join(root, "apps/desktop/out/renderer");
    const html = await readFile(join(renderer, "index.html"), "utf8");
    const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
    assert(css.length > 0, "Run pnpm build:js before this test");
    await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
    await writeFile(
      join(temp, "index.html"),
      `<!doctype html><html data-platform="darwin"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"><title>secondary windows</title>${css
        .map((path) => `<link rel="stylesheet" href="${path}">`)
        .join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`,
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
// Hidden by default: DOM focus assertions in the probe do not need OS-level
// window focus, so the run must never steal the user's focus. Opt back into a
// visible window only with PI_E2E_SHOW=1 for local debugging.
const E2E_VISIBLE = process.env.PI_E2E_SHOW === "1";
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: E2E_VISIBLE, width: ${width}, height: ${height},
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error("CONSOLE", event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.secondaryWindowsProbe({width:${width},height:${height}})");
    console.log("SECONDARY_WINDOWS " + JSON.stringify(result));
    const shots = [["settings", "light"], ["settings", "dark"], ["plugins", "light"], ["scheduled", "light"]];
    const shotInfo = [];
    for (const [kind, theme] of shots) {
      const info = await win.webContents.executeJavaScript("window.secondaryWindowsShot('" + kind + "','" + theme + "')");
      console.log("SECONDARY_WINDOWS_SHOT " + JSON.stringify(info));
      shotInfo.push(info);
      const shot = await win.capturePage();
      if (process.env.PI_SCRATCH_DIR) {
        const fs = require("node:fs");
        const path = require("node:path");
        fs.writeFileSync(path.join(process.env.PI_SCRATCH_DIR, "sw-${width}x${height}-" + kind + "-" + theme + ".png"), shot.toPNG());
      }
    }
    console.log("SECONDARY_WINDOWS_SHOTS " + JSON.stringify(shotInfo));
    app.exit(result.failures && result.failures.length ? 1 : 0);
  } catch (error) { console.error("MAIN_ERROR", error?.stack ?? String(error)); app.exit(1); }
  win.on("closed", () => app.exit(0));
});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output);
    const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("SECONDARY_WINDOWS "));
    assert(line, output);
    const result = JSON.parse(line.slice("SECONDARY_WINDOWS ".length));
    result.screenshot = null;
    const shotLine = output
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith("SECONDARY_WINDOWS_SHOTS "));
    assert(shotLine, `Screenshot stage produced no surface measurements${output}`);
    result.shots = JSON.parse(shotLine.slice("SECONDARY_WINDOWS_SHOTS ".length));
    assertSurfaceConsistency(result.shots);
    return result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * One shared surface for every destination. Settings, Extensions, and Scheduled
 * must paint the same computed background as each other and as the shared
 * `--ds-bg-primary` tone, keep their content root transparent so that tone is
 * what the user sees, and expose exactly one heading (the destination's own) —
 * no plate chrome title on top of the page header.
 */
function assertSurfaceConsistency(shots) {
  const light = shots.filter((shot) => shot.theme === "light");
  assert.equal(light.length, 3, "expected light-theme measurements for all three windows");
  const [first, ...rest] = light;
  for (const shot of rest) {
    assert.equal(
      shot.background,
      first.background,
      `${shot.kind} paints a different window surface than ${first.kind}`,
    );
  }
  for (const shot of shots) {
    assert.equal(
      shot.background,
      shot.sharedTone,
      `${shot.kind} (${shot.theme}) does not paint the shared window tone`,
    );
    assert.equal(
      shot.pageRootBackground,
      "rgba(0, 0, 0, 0)",
      `${shot.kind} repaints its own background inside the window`,
    );
    assert.equal(shot.h1Count, 1, `${shot.kind} must show exactly one destination heading`);
  }
}

const results = [];
for (const viewport of VIEWPORTS) results.push({ viewport, ...(await runOnce(viewport)) });
console.log(JSON.stringify(results, null, 2));

