import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-sidebar-session-order-"));

/** The probe renders the real Sidebar, so it cascades the real row stylesheet. */
const styleFiles = ["tokens.css", "base.css", "sidebar-threads.css", "sessions.css"];
const styleRoot = join(root, "apps/desktop/src/styles");

const mainSource = `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.setPath("userData", path.join(__dirname, "profile"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A rendered 2px insertion line exists only when the cascade gave the row's
 * pseudo-element a box and a paint. Reading it from the row itself is the
 * runtime evidence a synthetic DragEvent alone can never produce.
 */
function lineVisible(pseudo, edge, row) {
  if (!pseudo || !row) return false;
  return (
    pseudo.content !== "none" &&
    pseudo.content !== "normal" &&
    pseudo.position === "absolute" &&
    pseudo.height === "2px" &&
    pseudo[edge] === "0px" &&
    pseudo.backgroundColor !== "rgba(0, 0, 0, 0)" &&
    pseudo.backgroundColor !== "transparent" &&
    Math.abs(parseFloat(pseudo.width) - (row.width - 8)) <= 2
  );
}

async function nativePhase(window) {
  const run = (code) => window.webContents.executeJavaScript(code);
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok, detail: detail === undefined ? null : detail });

  const setup = await run("globalThis.sidebarSessionOrderNativeDrag.setup()");
  check(
    "the native drag fixture renders its rows newest created first",
    setup.order.join(",") === "n-d,n-c,n-b,n-a",
    setup.order,
  );

  window.show();
  window.webContents.debugger.attach("1.3");
  const send = (params) => window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", params);
  const dragTo = async (from, to, steps) => {
    for (let step = 1; step <= steps; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      await send({ type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await sleep(8);
    }
  };

  await send({ type: "mousePressed", x: setup.source.x, y: setup.source.y, button: "left", buttons: 1, clickCount: 1 });
  await dragTo(setup.source, setup.targetBefore, 40);
  await sleep(80);
  const beforeZone = await run("globalThis.sidebarSessionOrderNativeDrag.sample()");

  check(
    "a native press and drag paints the running row as the dragged row",
    beforeZone.draggingId === setup.sourceId && beforeZone.draggingOpacity === "0.5",
    { draggingId: beforeZone.draggingId, opacity: beforeZone.draggingOpacity },
  );
  check(
    "no row moves until the drag is released",
    beforeZone.order.join(",") === "n-d,n-c,n-b,n-a",
    beforeZone.order,
  );
  check(
    "the pointer over the target's upper half marks it as a before drop",
    beforeZone.markedId === setup.targetId && String(beforeZone.markedClass).includes("is-drop-before"),
    { markedId: beforeZone.markedId, markedClass: beforeZone.markedClass },
  );
  check(
    "the row paints a 2px accent insertion line on its top edge",
    lineVisible(beforeZone.before, "top", beforeZone.row) && beforeZone.markedAfter.content === "none",
    { line: beforeZone.before, otherSlot: beforeZone.markedAfter, row: beforeZone.row },
  );

  if (process.env.PI_E2E_ARTIFACT_DIR) {
    fs.mkdirSync(process.env.PI_E2E_ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.PI_E2E_ARTIFACT_DIR, "sidebar-insertion-line.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
  }

  await dragTo(setup.targetBefore, setup.targetAfter, 8);
  await sleep(80);
  const afterZone = await run("globalThis.sidebarSessionOrderNativeDrag.sample()");
  check(
    "the pointer over the target's lower half moves the line to its bottom edge",
    String(afterZone.markedClass).includes("is-drop-after") &&
      lineVisible(afterZone.after, "bottom", afterZone.row) &&
      afterZone.markedBefore.content === "none",
    { markedClass: afterZone.markedClass, line: afterZone.after, otherSlot: afterZone.markedBefore },
  );

  await dragTo(setup.targetAfter, setup.targetBefore, 8);
  await sleep(60);
  await send({ type: "mouseReleased", x: setup.targetBefore.x, y: setup.targetBefore.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(200);
  await send({ type: "mouseReleased", x: setup.targetBefore.x, y: setup.targetBefore.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(600);

  const settled = await run("globalThis.sidebarSessionOrderNativeDrag.settle()");
  check(
    "the native drop lands the dragged row before its target",
    settled.order.join(",") === "n-b,n-d,n-c,n-a",
    settled.order,
  );
  check(
    "the drag style and both insertion slots are cleared after the drop",
    settled.stale.length === 0,
    settled.stale,
  );
  check("the native drop stores the manual order", settled.sort === "manual", settled.sort);
  check(
    "the native drop stores one rank per row",
    settled.ranks["n-b"] === 0 &&
      settled.ranks["n-d"] === 1 &&
      settled.ranks["n-c"] === 2 &&
      settled.ranks["n-a"] === 3,
    settled.ranks,
  );
  check(
    "the native drop order survives a restart",
    settled.restartOrder.join(",") === "n-b,n-d,n-c,n-a",
    settled.restartOrder,
  );

  window.webContents.debugger.detach();
  return { ok: checks.every((entry) => entry.ok), checks };
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const probe = await window.webContents.executeJavaScript("globalThis.sidebarSessionOrderProbe()");
    const native = await nativePhase(window);
    const result = { ok: probe.ok === true && native.ok, checks: [...probe.checks, ...native.checks] };
    console.log("SIDEBAR_SESSION_ORDER_PROBE " + JSON.stringify(result));
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error("SIDEBAR_SESSION_ORDER_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
});
`;

try {
  const styles = await Promise.all(
    styleFiles.map((file) => readFile(join(styleRoot, file), "utf8")),
  );
  await writeFile(join(temp, "app.css"), styles.join("\n"));
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
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="app.css"><title>Sidebar session order</title><body><div id="root"></div><script src="renderer.js"></script>',
  );
  await writeFile(join(temp, "main.cjs"), mainSource);
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
