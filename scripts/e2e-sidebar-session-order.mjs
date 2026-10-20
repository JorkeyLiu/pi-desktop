import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-sidebar-session-order-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/sidebar-session-order.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".woff2": "dataurl" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><title>Sidebar session order</title><body><div id="root"></div><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.sidebarSessionOrderProbe()");
    console.log("SIDEBAR_SESSION_ORDER_PROBE " + JSON.stringify(result));
    app.exit(result?.ok === true ? 0 : 1);
  } catch (error) {
    console.error("SIDEBAR_SESSION_ORDER_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
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
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith("SIDEBAR_SESSION_ORDER_PROBE "));
  assert.ok(line, `probe did not run (exit ${code}):\n${stderr.slice(-2000)}`);
  const result = JSON.parse(line.slice("SIDEBAR_SESSION_ORDER_PROBE ".length));
  if (process.env.SIDEBAR_SESSION_ORDER_VERBOSE === "1") {
    for (const check of result.checks ?? []) {
      console.log(`${check.ok ? "ok  " : "FAIL"} ${check.label} ${JSON.stringify(check.detail)}`);
    }
  }
  for (const check of result.checks ?? []) {
    assert.ok(check.ok, `${check.label}: ${JSON.stringify(check.detail)}`);
  }
  assert.equal(result.ok, true, JSON.stringify(result.checks ?? result, null, 2));
  console.log(`sidebar session order: ${result.checks.length} checks passed`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
