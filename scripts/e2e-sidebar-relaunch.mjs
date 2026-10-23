#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps/desktop");
const electronBin = join(appDir, "node_modules/.bin/electron");
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(read, label, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await read();
      if (last) return last;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "renderer evaluation failed");
    return result.result.value;
  }
  close() { this.ws.close(); }
}

async function openWindow(port) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type === "page" && item.url.includes("out/renderer/index.html") && !item.url.includes("surface="));
  }, "main renderer target");
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await waitFor(() => cdp.evaluate(`!document.querySelector(".startup-splash") && !!document.querySelector(".main-pane")`), "ready app shell");
  return cdp;
}

function launch(port, profileDir, dataDir) {
  return spawn(electronBin, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "."], {
    cwd: appDir,
    env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_HOST_BIN: hostBinary, PI_DESKTOP_START_MAXIMIZED: "0", ELECTRON_RENDERER_URL: "" },
    stdio: "ignore",
  });
}

async function quit(cdp, child) {
  cdp.close();
  try { process.kill(child.pid, "SIGTERM"); } catch {}
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(20_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(child.pid, "SIGKILL"); } catch {}
    throw new Error("Electron did not exit after SIGTERM");
  }
}

async function main() {
  assert.ok(existsSync(join(appDir, "out/main/index.js")), "built desktop app is required");
  assert.ok(existsSync(electronBin), `Electron binary missing: ${electronBin}`);
  assert.ok(existsSync(hostBinary), `host-core binary missing: ${hostBinary}`);
  const port = await freePort();
  const profileDir = mkdtempSync(join(tmpdir(), "pi-sidebar-profile-"));
  const dataDir = mkdtempSync(join(tmpdir(), "pi-sidebar-data-"));
  let child;
  let cdp;
  try {
    child = launch(port, profileDir, dataDir);
    cdp = await openWindow(port);
    let state = await cdp.evaluate(`({expanded: !!document.querySelector(".sidebar"), saved: localStorage.getItem("pi.desktop.sidebarCollapsed")})`);
    assert.equal(state.expanded, true, `fresh profile should render expanded: ${JSON.stringify(state)}`);
    assert.equal(state.saved, null, `fresh profile should have no saved choice: ${JSON.stringify(state)}`);
    console.log("PASS fresh disposable profile starts with expanded sidebar");

    await cdp.evaluate(`document.querySelector('.sidebar [data-nav="toggle-sidebar"]')?.click()`);
    await waitFor(() => cdp.evaluate(`!document.querySelector(".sidebar") && localStorage.getItem("pi.desktop.sidebarCollapsed") === "true"`), "manual collapse");
    console.log("PASS actual sidebar toggle collapses and saves true");
    await quit(cdp, child);
    cdp = null;
    child = launch(port, profileDir, dataDir);
    cdp = await openWindow(port);
    state = await cdp.evaluate(`({expanded: !!document.querySelector(".sidebar"), saved: localStorage.getItem("pi.desktop.sidebarCollapsed")})`);
    assert.deepEqual(state, { expanded: false, saved: "true" }, "collapsed choice should restore after Electron relaunch");
    console.log("PASS collapsed sidebar survives Electron quit and relaunch");

    await cdp.evaluate(`document.querySelector('.ct-lead [data-nav="toggle-sidebar"]')?.click() ?? document.querySelector('.ct-lead .ct-icon-btn')?.click()`);
    await waitFor(() => cdp.evaluate(`!!document.querySelector(".sidebar") && localStorage.getItem("pi.desktop.sidebarCollapsed") === "false"`), "manual expansion");
    console.log("PASS actual titlebar toggle reopens and saves false");
    await quit(cdp, child);
    cdp = null;
    child = launch(port, profileDir, dataDir);
    cdp = await openWindow(port);
    state = await cdp.evaluate(`({expanded: !!document.querySelector(".sidebar"), saved: localStorage.getItem("pi.desktop.sidebarCollapsed")})`);
    assert.deepEqual(state, { expanded: true, saved: "false" }, "expanded choice should restore after Electron relaunch");
    console.log("PASS expanded sidebar survives Electron quit and relaunch");
    await quit(cdp, child);
    cdp = null;
  } finally {
    if (cdp && child) await quit(cdp, child).catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
