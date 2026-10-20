#!/usr/bin/env node
/**
 * Isolated Composer model-chip geometry check. It compiles the application's
 * own stylesheet, renders the production toolbar controls in an offscreen
 * Electron window with its own profile, and measures the chip at the widths a
 * real chat column takes. It never connects to the user's app or providers.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const runtimeRequire = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = runtimeRequire("esbuild");
const vite = await import(pathToFileURL(require.resolve("vite")).href);
const { default: tailwind } = await import(
  pathToFileURL(require.resolve("@tailwindcss/vite")).href
);
const cache = join(root, ".cache/composer-model-chip");
await mkdir(cache, { recursive: true });
const temp = await mkdtemp(join(cache, "run-"));
const artifactDir = process.env.PI_MODEL_CHIP_ARTIFACT_DIR ?? tmpdir();
await mkdir(artifactDir, { recursive: true });

// The chip's width depends on the compiled stylesheet, so compile it here
// instead of trusting a build directory another writer may be filling.
const styles = await vite.build({
  configFile: false,
  root: desktop,
  logLevel: "error",
  plugins: [tailwind()],
  build: { write: false, rollupOptions: { input: join(desktop, "src/styles/globals.css") } },
});
const outputs = (Array.isArray(styles) ? styles : [styles]).flatMap(
  (result) => result.output,
);
const css = outputs.filter(
  (entry) => entry.type === "asset" && entry.fileName.endsWith(".css"),
);
assert(css.length > 0, "Production CSS was not compiled");
const compiledCss = css.map((entry) => entry.source).join("\n");
await writeFile(join(temp, "styles.css"), compiledCss);

// The stylesheet is compiled from source here, so the probe below is measured
// against the current rules rather than against a build another writer owns.

await build({
  entryPoints: [join(root, "scripts/e2e/composer-model-chip.tsx")],
  outfile: join(temp, "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
    react: join(desktop, "node_modules/react"),
    "react-dom": join(desktop, "node_modules/react-dom"),
    i18next: join(desktop, "node_modules/i18next"),
    "react-i18next": join(desktop, "node_modules/react-i18next"),
  },
  nodePaths: [join(desktop, "node_modules")],
});

await writeFile(
  join(temp, "index.html"),
  `<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styles.css"><body><script src="renderer.js"></script></body></html>`,
);

await writeFile(
  join(temp, "main.cjs"),
  `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
app.setPath("userData", path.join(__dirname, "profile"));
app.setPath("crashDumps", path.join(__dirname, "crashes"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1040,
    height: 900,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript(
      "globalThis.composerModelChipProbe()",
    );
    const image = await window.webContents.capturePage();
    const shot = path.join(${JSON.stringify(artifactDir)}, "composer-model-chip.png");
    await fs.writeFile(shot, image.toPNG());
    console.log("COMPOSER_MODEL_CHIP_SCREENSHOT " + shot);
    console.log("COMPOSER_MODEL_CHIP_PROBE " + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error(
      "COMPOSER_MODEL_CHIP_PROBE " +
        JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)] }),
    );
    app.exit(1);
  }
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
  .find((entry) => entry.startsWith("COMPOSER_MODEL_CHIP_PROBE "));
assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-3000)}`);
const result = JSON.parse(line.slice("COMPOSER_MODEL_CHIP_PROBE ".length));
console.log("COMPOSER_MODEL_CHIP_PROBE " + JSON.stringify(result, null, 2));
assert.equal(code, 0, output.slice(-6000));
assert.deepEqual(result.failures ?? [], [], "Composer model chip checks failed");
assert.equal(result.ok, true);
