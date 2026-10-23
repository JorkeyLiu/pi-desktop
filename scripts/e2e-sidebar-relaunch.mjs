#!/usr/bin/env node
/**
 * Desktop E2E: a project, its session, the persisted transcript and the manual
 * sidebar preference survive a renderer reload and Electron relaunches.
 *
 * Every fixture prerequisite is proven over the public IPC surface before the
 * renderer is asserted on: a fixture that never persisted must fail as a
 * prerequisite, never as a renderer row/timing symptom. The session is then
 * selected by clicking its rendered sidebar row, and the explicit clear uses
 * the renderer action the sidebar and Projects page call.
 *
 * The run records its own source/build identity and refuses to assert on
 * artifacts older than the renderer, Electron or host source it would test.
 * Clearing the project is proven on a development build, whose `projectGet`
 * seeds a workspace when none is set; the restart therefore asserts that the
 * fixture project is not resurrected and no session is restored, not that a
 * packaged build starts with a null workspace.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps/desktop");
const electronBin = join(appDir, "node_modules/.bin/electron");
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");
const SIDEBAR_COLLAPSED_KEY = "pi.desktop.sidebarCollapsed";
const MARKER_ID = "restart-marker";

let stage = "init";

const BUILD_SOURCES = {
  renderer: ["apps/desktop/src", "packages/shared/src"],
  electron: ["apps/desktop/electron", "packages/shared/src"],
  host: ["crates/host-core/src", "crates/host-core/Cargo.toml"],
};
const BUILD_ARTIFACTS = {
  rendererIndex: join(appDir, "out/renderer/index.html"),
  rendererAssets: join(appDir, "out/renderer/assets"),
  main: join(appDir, "out/main/index.js"),
  preload: join(appDir, "out/preload/index.cjs"),
  host: hostBinary,
};

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sha256File = (path) => sha256(readFileSync(path));

function newestEntry(target, filter = () => true) {
  if (!existsSync(target)) return null;
  const stat = statSync(target);
  if (!stat.isDirectory()) {
    return filter(target) ? { path: target, mtimeMs: stat.mtimeMs } : null;
  }
  let newest = null;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const candidate = newestEntry(join(target, entry.name), filter);
    if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) newest = candidate;
  }
  return newest;
}

/** The chunk `index.html` loads first; the other assets are lazy imports. */
function rendererEntryAsset() {
  if (!existsSync(BUILD_ARTIFACTS.rendererIndex)) return null;
  const html = readFileSync(BUILD_ARTIFACTS.rendererIndex, "utf8");
  const match = html.match(/src="\.\/assets\/([^"]+\.js)"/);
  return match ? join(BUILD_ARTIFACTS.rendererAssets, match[1]) : null;
}

function newestSource(roots) {
  let newest = null;
  for (const relative of roots) {
    const candidate = newestEntry(join(root, relative));
    if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) newest = candidate;
  }
  return newest;
}

/**
 * Refuse to assert on artifacts older than the source this checkout would test.
 * A skipped or cached build leaves the previous bundle in place, and a symlinked
 * build directory makes that stale output look like the current one.
 */
function verifyBuildFreshness() {
  const checks = [
    {
      label: "renderer bundle",
      source: newestSource(BUILD_SOURCES.renderer),
      artifacts: [
        BUILD_ARTIFACTS.rendererIndex,
        newestEntry(BUILD_ARTIFACTS.rendererAssets, (path) => path.endsWith(".js"))?.path,
      ].filter(Boolean),
    },
    {
      label: "electron main/preload",
      source: newestSource(BUILD_SOURCES.electron),
      artifacts: [BUILD_ARTIFACTS.main, BUILD_ARTIFACTS.preload],
    },
    {
      label: "host-core binary",
      source: newestSource(BUILD_SOURCES.host),
      artifacts: [BUILD_ARTIFACTS.host],
    },
  ];
  for (const check of checks) {
    const artifacts = check.artifacts.filter((path) => existsSync(path));
    assert.ok(artifacts.length > 0, `stale build preflight: no built artifacts for ${check.label}`);
    assert.ok(check.source, `stale build preflight: source files missing for ${check.label}`);
    const newest = artifacts
      .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
      .reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    assert.ok(
      check.source.mtimeMs <= newest.mtimeMs,
      `stale build preflight: ${check.source.path} (${new Date(check.source.mtimeMs).toISOString()}) is newer than ${newest.path} (${new Date(newest.mtimeMs).toISOString()}); rebuild from the repo root before running this fixture`,
    );
  }
}

function runGit(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function describeArtifact(label, path) {
  if (!existsSync(path)) return { label, path, missing: true };
  const realPath = realpathSync(path);
  const stat = statSync(realPath);
  return {
    label,
    path,
    realPath,
    mtime: new Date(stat.mtimeMs).toISOString(),
    bytes: stat.size,
    sha256: stat.isFile() ? sha256File(realPath) : null,
  };
}

function untrackedSources() {
  const listed = runGit(["ls-files", "--others", "--exclude-standard"]) ?? "";
  const files = listed
    .split("\n")
    .filter(Boolean)
    .filter((path) => !path.startsWith("apps/desktop/out") && !path.startsWith("packages/shared/dist"))
    .sort();
  const digest = createHash("sha256");
  for (const file of files) {
    const full = join(root, file);
    digest.update(file).update("\0").update(existsSync(full) ? readFileSync(full) : Buffer.alloc(0));
  }
  return { files, sha256: digest.digest("hex") };
}

/** Record exactly which source and build served this run. */
function recordSourceIdentity() {
  let trackedDiff = "";
  try {
    trackedDiff = sha256(execFileSync("git", ["diff", "HEAD"], { cwd: root, maxBuffer: 256 * 1024 * 1024 }));
  } catch {
    trackedDiff = "unavailable";
  }
  const identity = {
    script: { path: fileURLToPath(import.meta.url), sha256: sha256File(fileURLToPath(import.meta.url)) },
    git: {
      base: runGit(["rev-parse", "HEAD"]),
      trackedDiffSha256: trackedDiff,
      untracked: untrackedSources(),
      status: (runGit(["status", "--porcelain"]) ?? "").split("\n").filter(Boolean),
    },
    artifacts: [
      describeArtifact("renderer index", BUILD_ARTIFACTS.rendererIndex),
      describeArtifact(
        "renderer entry chunk",
        rendererEntryAsset()
          ?? newestEntry(BUILD_ARTIFACTS.rendererAssets, (path) => path.endsWith(".js"))?.path
          ?? BUILD_ARTIFACTS.rendererAssets,
      ),
      describeArtifact("electron main", BUILD_ARTIFACTS.main),
      describeArtifact("electron preload", BUILD_ARTIFACTS.preload),
      describeArtifact("host-core", BUILD_ARTIFACTS.host),
    ],
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      electronBin,
      hostBinary,
      startedAt: new Date().toISOString(),
    },
  };
  console.log(`SOURCE IDENTITY ${JSON.stringify(identity)}`);
}

function normalizePath(value) {
  if (typeof value !== "string") return null;
  const forward = value.replace(/\\/g, "/");
  return forward.length > 1 ? forward.replace(/\/+$/, "") : forward;
}

function prerequisite(name, envelope) {
  if (!envelope || envelope.ok !== true) {
    throw new Error(`prerequisite failed [${name}]: envelope=${JSON.stringify(envelope)}`);
  }
  return envelope.data;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitFor(read, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (last) return last;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function pollUntil(cdp, read, label, timeoutMs, diagnostics) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  let observed = null;
  try {
    observed = await cdp.evaluate(diagnostics);
  } catch (error) {
    observed = `diagnostics failed: ${error.message}`;
  }
  throw new Error(`${label} not observed within ${timeoutMs}ms; observed=${JSON.stringify(observed)}`);
}

function rendererDiagnostics(marker) {
  return `(() => {
    const groups = [...document.querySelectorAll("[data-sidebar-project-group]")].map((group) => ({
      key: group.getAttribute("data-sidebar-project-group"),
      rows: group.querySelectorAll("[data-sidebar-session-row]").length,
    }));
    return {
      sidebar: !!document.querySelector(".sidebar"),
      groups,
      rowCount: document.querySelectorAll("[data-sidebar-session-row]").length,
      activeId: document.querySelector("[data-sidebar-session-row].active")?.getAttribute("data-sidebar-session-row") ?? null,
      currentWorkspace: document.querySelector("[data-current-workspace='true']")?.getAttribute("data-sidebar-project-group") ?? null,
      markerVisible: (document.querySelector(".main-pane")?.innerText ?? "").includes(${JSON.stringify(marker)}),
      running: !!document.querySelector(".stop-btn"),
      savedCollapsed: localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)}),
    };
  })()`;
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
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails.exception ?? result.exceptionDetails));
    return result.result.value;
  }
  async clickAt(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
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
  stage = "build-identity";
  verifyBuildFreshness();
  recordSourceIdentity();

  const port = await freePort();
  const profileDir = mkdtempSync(join(tmpdir(), "pi-workspace-profile-"));
  const dataDir = mkdtempSync(join(tmpdir(), "pi-workspace-data-"));
  const projectDir = mkdtempSync(join(tmpdir(), "pi-workspace-project-"));
  const canonicalProject = normalizePath(realpathSync(projectDir));
  const marker = `restored transcript ${Date.now()}`;
  const sessionTitle = `Restart session ${Date.now()}`;
  const createdAt = new Date().toISOString();
  let child;
  let cdp;
  try {
    stage = "launch";
    child = launch(port, profileDir, dataDir);
    cdp = await openWindow(port);

    stage = "fixture-prerequisites";
    const seed = await cdp.evaluate(`(async () => {
      const api = window.piDesktop;
      const channel = api.channels.invoke;
      const envelope = (raw) => ({
        ok: raw?.ok === true,
        data: raw?.data ?? null,
        errorMessage: raw?.error?.message ?? null,
        errorCode: raw?.error?.code ?? raw?.error?.errorCode ?? null,
      });
      const project = envelope(await api.invoke(channel.projectSet, ${JSON.stringify(projectDir)}));
      const create = envelope(await api.invoke(channel.sessionCreate, {
        projectPath: ${JSON.stringify(canonicalProject)},
        title: ${JSON.stringify(sessionTitle)},
      }));
      const sessionId = create.data?.session?.id ?? null;
      const replace = sessionId
        ? envelope(await api.invoke(channel.sessionReplaceMessages, {
            sessionId,
            messages: [{
              id: ${JSON.stringify(MARKER_ID)},
              role: "user",
              content: ${JSON.stringify(marker)},
              createdAt: ${JSON.stringify(createdAt)},
            }],
          }))
        : { ok: false, data: null, errorMessage: "sessionCreate returned no session id" };
      const list = envelope(await api.invoke(channel.sessionList));
      const get = sessionId
        ? envelope(await api.invoke(channel.sessionGet, { id: sessionId, messageLimit: 50 }))
        : { ok: false, data: null, errorMessage: "sessionCreate returned no session id" };
      return {
        project,
        create,
        replace,
        list,
        get,
        listing: Array.isArray(list.data?.sessions)
          ? list.data.sessions.map((item) => ({ id: item.id ?? null, projectPath: item.projectPath ?? null }))
          : null,
        messages: Array.isArray(get.data?.session?.messages)
          ? get.data.session.messages.map((item) => ({ id: item.id, role: item.role, content: item.content, createdAt: item.createdAt }))
          : null,
      };
    })()`);

    const projectData = prerequisite("projectSet(temp project path)", seed.project);
    const workspacePath = normalizePath(projectData?.workspace?.path);
    assert.equal(
      workspacePath,
      canonicalProject,
      `prerequisite failed [projectSet]: workspace.path ${JSON.stringify(workspacePath)} != canonical temp project ${JSON.stringify(canonicalProject)}`,
    );

    const created = prerequisite("sessionCreate", seed.create);
    const sessionId = created?.session?.id;
    assert.ok(
      typeof sessionId === "string" && sessionId.length > 0,
      `prerequisite failed [sessionCreate]: session id ${JSON.stringify(sessionId)}`,
    );
    assert.equal(
      normalizePath(created.session.projectPath),
      canonicalProject,
      `prerequisite failed [sessionCreate]: projectPath ${JSON.stringify(created.session.projectPath)} != ${JSON.stringify(canonicalProject)}`,
    );
    assert.equal(
      created.session.title,
      sessionTitle,
      `prerequisite failed [sessionCreate]: title ${JSON.stringify(created.session.title)} != ${JSON.stringify(sessionTitle)}`,
    );

    const replaced = prerequisite("sessionReplaceMessages", seed.replace);
    assert.equal(replaced?.ok, true, `prerequisite failed [sessionReplaceMessages]: host result ${JSON.stringify(replaced)}`);

    prerequisite("sessionList", seed.list);
    const listed = (seed.listing ?? []).find((item) => item.id === sessionId);
    assert.ok(listed, `prerequisite failed [sessionList]: session ${sessionId} missing from ${JSON.stringify(seed.listing)}`);
    assert.equal(
      normalizePath(listed.projectPath),
      canonicalProject,
      `prerequisite failed [sessionList]: projectPath ${JSON.stringify(listed.projectPath)} != ${JSON.stringify(canonicalProject)}`,
    );

    const detail = prerequisite("sessionGet({ id, messageLimit })", seed.get);
    assert.equal(detail?.session?.id, sessionId, `prerequisite failed [sessionGet]: session ${JSON.stringify(detail?.session?.id)} != ${sessionId}`);
    const persisted = (seed.messages ?? []).find((item) => item.id === MARKER_ID);
    assert.ok(persisted, `prerequisite failed [sessionGet]: marker message missing from ${JSON.stringify(seed.messages)}`);
    assert.equal(persisted.role, "user", `prerequisite failed [sessionGet]: marker role ${JSON.stringify(persisted.role)}`);
    assert.equal(persisted.content, marker, `prerequisite failed [sessionGet]: marker content ${JSON.stringify(persisted.content)}`);
    assert.equal(persisted.createdAt, createdAt, `prerequisite failed [sessionGet]: marker createdAt ${JSON.stringify(persisted.createdAt)}`);

    console.log(`SAFE FACTS ${JSON.stringify({ tempProjectDir: projectDir, canonicalProject, sessionId, listedSessionCount: seed.listing?.length ?? 0 })}`);
    console.log("PASS fixture project, session and transcript persisted through the public IPC surface");

    stage = "renderer-reload-hydration";
    await cdp.send("Page.enable");
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(() => cdp.evaluate(`!!document.querySelector(".main-pane") && !document.querySelector(".startup-splash")`), "app shell after renderer reload");
    const row = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const row = document.querySelector('[data-sidebar-session-row="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
        if (!row) return null;
        row.scrollIntoView({ block: "center" });
        const rect = row.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const x = Math.round(rect.x + Math.min(rect.width / 2, 120));
        const y = Math.round(rect.y + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          active: row.classList.contains("active"),
          pointerEvents: getComputedStyle(row).pointerEvents,
          disabled: row.getAttribute("aria-disabled") === "true" || !!row.querySelector(".thread-item-main[disabled]"),
          hitInsideRow: !!hit && row.contains(hit),
        };
      })()`),
      "sidebar session row after renderer reload",
      15_000,
      rendererDiagnostics(marker),
    );
    assert.equal(row.disabled, false, `sidebar session row is disabled: ${JSON.stringify(row)}`);
    assert.notEqual(row.pointerEvents, "none", `sidebar session row rejects pointer input: ${JSON.stringify(row)}`);
    assert.equal(row.hitInsideRow, true, `sidebar session row is obscured at its click point: ${JSON.stringify(row)}`);
    await cdp.clickAt(row.x, row.y);

    stage = "row-click-selects-session";
    const selected = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const active = document.querySelector("[data-sidebar-session-row].active");
        const main = document.querySelector(".main-pane");
        const state = {
          activeId: active?.getAttribute("data-sidebar-session-row") ?? null,
          markerVisible: !!main && main.innerText.includes(${JSON.stringify(marker)}),
          running: !!document.querySelector(".stop-btn"),
        };
        return state.activeId === ${JSON.stringify(sessionId)} && state.markerVisible ? state : null;
      })()`),
      "clicked session transcript after renderer reload",
      15_000,
      rendererDiagnostics(marker),
    );
    assert.equal(selected.markerVisible, true, `transcript marker not rendered: ${JSON.stringify(selected)}`);
    assert.equal(selected.running, false, "restored session must not resume a turn");
    console.log("PASS renderer reload hydration plus real sidebar row click renders the persisted transcript while idle");

    stage = "manual-sidebar-collapse";
    const collapseTarget = await cdp.evaluate(`(() => {
      const button = document.querySelector('.sidebar [data-nav="toggle-sidebar"]');
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
        : null;
    })()`);
    assert.ok(collapseTarget, `sidebar collapse control is not visible: ${JSON.stringify(collapseTarget)}`);
    await cdp.clickAt(collapseTarget.x, collapseTarget.y);
    await waitFor(
      () => cdp.evaluate(`!document.querySelector(".sidebar") && localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)}) === "true"`),
      "manual sidebar collapse persisted",
    );
    console.log(`SELECTION EVIDENCE before-quit ${JSON.stringify(await cdp.evaluate(`({
      collapsed: localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)}),
      selected: localStorage.getItem("pi.desktop.lastSelectedSessionId"),
    })`))}`);

    stage = "restart-1-collapsed";
    await quit(cdp, child);
    cdp = null;
    child = launch(port, profileDir, dataDir);
    cdp = await openWindow(port);
    await waitFor(
      () => cdp.evaluate(`!document.querySelector(".sidebar") && localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)}) === "true"`),
      "collapsed sidebar after restart",
    );
    const collapsedState = await cdp.evaluate(`({
      sidebar: !!document.querySelector(".sidebar"),
      saved: localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)}),
      selected: localStorage.getItem("pi.desktop.lastSelectedSessionId"),
      rowCount: document.querySelectorAll("[data-sidebar-session-row]").length,
      running: !!document.querySelector(".stop-btn"),
    })`);
    assert.equal(collapsedState.sidebar, false, `collapsed sidebar mounted after restart: ${JSON.stringify(collapsedState)}`);
    assert.equal(collapsedState.saved, "true", `collapsed preference lost after restart: ${JSON.stringify(collapsedState)}`);
    assert.equal(collapsedState.running, false, `restored session auto-executed after restart: ${JSON.stringify(collapsedState)}`);

    const durable = await cdp.evaluate(`(async () => {
      const api = window.piDesktop;
      const channel = api.channels.invoke;
      const envelope = (raw) => ({ ok: raw?.ok === true, data: raw?.data ?? null, errorMessage: raw?.error?.message ?? null });
      const project = envelope(await api.invoke(channel.projectGet));
      const get = envelope(await api.invoke(channel.sessionGet, { id: ${JSON.stringify(sessionId)}, messageLimit: 50 }));
      const list = envelope(await api.invoke(channel.sessionList));
      return {
        projectOk: project.ok,
        projectPath: project.data?.workspace?.path ?? null,
        getOk: get.ok,
        sessionProjectPath: get.data?.session?.projectPath ?? null,
        marker: Array.isArray(get.data?.session?.messages)
          && get.data.session.messages.some((item) => item.id === ${JSON.stringify(MARKER_ID)} && item.content === ${JSON.stringify(marker)}),
        listed: Array.isArray(list.data?.sessions)
          && list.data.sessions.some((item) => item.id === ${JSON.stringify(sessionId)} && item.projectPath === ${JSON.stringify(canonicalProject)}),
        listedSessions: Array.isArray(list.data?.sessions)
          ? list.data.sessions.map((item) => ({ id: item.id, projectPath: item.projectPath ?? null }))
          : null,
        selected: localStorage.getItem("pi.desktop.lastSelectedSessionId"),
        running: !!document.querySelector(".stop-btn"),
      };
    })()`);
    assert.equal(durable.projectOk, true, `projectGet failed after restart: ${JSON.stringify(durable)}`);
    assert.equal(normalizePath(durable.projectPath), canonicalProject, `active project lost after restart: ${JSON.stringify(durable)}`);
    assert.equal(durable.getOk, true, `sessionGet failed after restart: ${JSON.stringify(durable)}`);
    assert.equal(normalizePath(durable.sessionProjectPath), canonicalProject, `session project binding lost after restart: ${JSON.stringify(durable)}`);
    assert.equal(durable.marker, true, `persisted transcript marker missing after restart: ${JSON.stringify(durable)}`);
    assert.equal(durable.listed, true, `session missing from sessionList after restart: ${JSON.stringify(durable)}`);
    assert.equal(durable.running, false, `restored session auto-executed after restart: ${JSON.stringify(durable)}`);
    console.log(`SELECTION EVIDENCE after-restart ${JSON.stringify({ selected: durable.selected, listedSessions: durable.listedSessions, collapsedState })}`);
    console.log("PASS project, session, transcript and collapsed sidebar survive restart without auto-execution");

    stage = "restart-1-manual-expand";
    const expandProbe = await cdp.evaluate(`(() => {
      const candidates = [...document.querySelectorAll('[data-nav="toggle-sidebar"], .ct-lead .ct-icon-btn')]
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            slot: button.getAttribute("data-nav") ? "data-nav" : "ct-lead",
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            disabled: button.disabled === true || button.getAttribute("aria-disabled") === "true",
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          };
        });
      const target = candidates.find((candidate) => !candidate.disabled && candidate.width > 0 && candidate.height > 0);
      return { target: target ?? null, candidates };
    })()`);
    assert.ok(expandProbe.target, `sidebar expand control is not visible: ${JSON.stringify(expandProbe.candidates)}`);
    await cdp.clickAt(expandProbe.target.x, expandProbe.target.y);
    await waitFor(
      () => cdp.evaluate(`!!document.querySelector(".sidebar") && localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)}) === "false"`),
      "manual sidebar expansion persisted",
    );

    const expandedView = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const active = document.querySelector("[data-sidebar-session-row].active");
        const main = document.querySelector(".main-pane");
        const state = {
          activeId: active?.getAttribute("data-sidebar-session-row") ?? null,
          markerVisible: !!main && main.innerText.includes(${JSON.stringify(marker)}),
          running: !!document.querySelector(".stop-btn"),
        };
        return state.activeId === ${JSON.stringify(sessionId)} && state.markerVisible ? state : null;
      })()`),
      "restored active session after sidebar expansion",
      15_000,
      rendererDiagnostics(marker),
    );
    assert.equal(expandedView.running, false, "restored session must not resume a turn after expansion");
    console.log("PASS selected session and transcript render after manual sidebar expansion");

    stage = "restart-2-expanded";
    await quit(cdp, child);
    cdp = null;
    child = launch(port, profileDir, dataDir);
    cdp = await openWindow(port);
    await waitFor(() => cdp.evaluate(`!!document.querySelector(".sidebar")`), "expanded sidebar after restart");
    const restoredView = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const active = document.querySelector("[data-sidebar-session-row].active");
        const main = document.querySelector(".main-pane");
        const state = {
          activeId: active?.getAttribute("data-sidebar-session-row") ?? null,
          markerVisible: !!main && main.innerText.includes(${JSON.stringify(marker)}),
          running: !!document.querySelector(".stop-btn"),
        };
        return state.activeId === ${JSON.stringify(sessionId)} && state.markerVisible ? state : null;
      })()`),
      "restored active session after expanded restart",
      15_000,
      rendererDiagnostics(marker),
    );
    const layout = await cdp.evaluate(`({
      saved: localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)}),
      currentWorkspace: document.querySelector("[data-current-workspace='true']")?.getAttribute("data-sidebar-project-group") ?? null,
      running: !!document.querySelector(".stop-btn"),
    })`);
    assert.equal(restoredView.running, false, "restored session must not resume a turn");
    assert.equal(layout.saved, "false", `expanded preference lost after restart: ${JSON.stringify(layout)}`);
    assert.equal(normalizePath(layout.currentWorkspace), canonicalProject, `active project lost after expanded restart: ${JSON.stringify(layout)}`);
    assert.equal(layout.running, false, `restored session auto-executed after expanded restart: ${JSON.stringify(layout)}`);
    console.log("PASS project, session, transcript and expanded sidebar survive Electron relaunch");

    stage = "explicit-project-clear";
    // The sidebar and Projects page clear through this renderer action, which
    // owns the remembered selection. Reading the workspace back through
    // `projectGet` would re-seed a workspace in this development build, so the
    // cleared state is asserted on the stored preference and the rendered
    // surface, then on the restart.
    const cleared = await cdp.evaluate(`(async () => {
      await window.__PI_DESKTOP__.clearProject();
      return {
        savedSelection: localStorage.getItem("pi.desktop.lastSelectedSessionId"),
      };
    })()`);
    assert.equal(
      cleared.savedSelection,
      null,
      `explicit project clear kept the remembered session: ${JSON.stringify(cleared)}`,
    );
    const clearedHome = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const main = document.querySelector(".main-pane");
        const state = {
          currentWorkspace: document.querySelector("[data-current-workspace='true']")?.getAttribute("data-sidebar-project-group") ?? null,
          activeId: document.querySelector("[data-sidebar-session-row].active")?.getAttribute("data-sidebar-session-row") ?? null,
          markerVisible: !!main && main.innerText.includes(${JSON.stringify(marker)}),
          savedSelection: localStorage.getItem("pi.desktop.lastSelectedSessionId"),
        };
        return state.currentWorkspace === null && state.activeId === null && !state.markerVisible
          && state.savedSelection === null
          ? state
          : null;
      })()`),
      "home state immediately after explicit project clear",
      15_000,
      rendererDiagnostics(marker),
    );
    console.log(`SELECTION EVIDENCE after-explicit-clear ${JSON.stringify(clearedHome)}`);

    await quit(cdp, child);
    cdp = null;
    child = launch(port, profileDir, dataDir);
    cdp = await openWindow(port);

    stage = "restart-3-no-resurrection";
    await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const active = document.querySelector("[data-sidebar-session-row].active");
        const main = document.querySelector(".main-pane");
        const markerVisible = !!main && main.innerText.includes(${JSON.stringify(marker)});
        return !active && !markerVisible ? { active: false, markerVisible: false } : null;
      })()`),
      "cleared selection after restart",
      15_000,
      rendererDiagnostics(marker),
    );
    // This is a development build: `projectGet` seeds a workspace when none is
    // set, so the restart may show that substitute. The fixture project and the
    // cleared selection must still not come back.
    const clearedView = await cdp.evaluate(`({
      activeId: document.querySelector("[data-sidebar-session-row].active")?.getAttribute("data-sidebar-session-row") ?? null,
      markerVisible: (document.querySelector(".main-pane")?.innerText ?? "").includes(${JSON.stringify(marker)}),
      currentWorkspace: document.querySelector("[data-current-workspace='true']")?.getAttribute("data-sidebar-project-group") ?? null,
      saved: localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)}),
      selected: localStorage.getItem("pi.desktop.lastSelectedSessionId"),
      running: !!document.querySelector(".stop-btn"),
    })`);
    assert.equal(clearedView.activeId, null, `explicit project clear was resurrected: ${JSON.stringify(clearedView)}`);
    assert.equal(clearedView.markerVisible, false, `cleared transcript was resurrected: ${JSON.stringify(clearedView)}`);
    assert.notEqual(normalizePath(clearedView.currentWorkspace), canonicalProject, `cleared project became active again: ${JSON.stringify(clearedView)}`);
    assert.equal(clearedView.saved, "false", `sidebar preference changed by project clear: ${JSON.stringify(clearedView)}`);
    assert.equal(clearedView.selected, null, `cleared session selection was restored: ${JSON.stringify(clearedView)}`);
    assert.equal(clearedView.running, false, `cleared state auto-executed: ${JSON.stringify(clearedView)}`);

    const clearedDurable = await cdp.evaluate(`(async () => {
      const api = window.piDesktop;
      const get = await api.invoke(api.channels.invoke.sessionGet, { id: ${JSON.stringify(sessionId)}, messageLimit: 50 });
      return {
        ok: get?.ok === true,
        marker: Array.isArray(get?.data?.session?.messages)
          && get.data.session.messages.some((item) => item.id === ${JSON.stringify(MARKER_ID)} && item.content === ${JSON.stringify(marker)}),
      };
    })()`);
    assert.equal(clearedDurable.ok, true, `session lost after project clear: ${JSON.stringify(clearedDurable)}`);
    assert.equal(clearedDurable.marker, true, `transcript lost after project clear: ${JSON.stringify(clearedDurable)}`);
    console.log("PASS explicit project clear is not resurrected on restart while the session stays durable");
  } finally {
    if (cdp && child) await quit(cdp, child).catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAILED at stage=${stage}: ${error.message}`);
  process.exitCode = 1;
});
