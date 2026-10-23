#!/usr/bin/env node
/**
 * Desktop E2E: a project, its session and the persisted transcript survive a
 * renderer reload and Electron relaunches.
 *
 * Every fixture prerequisite is proven over the public IPC surface before the
 * renderer is asserted on: a fixture that never persisted must fail as a
 * prerequisite, never as a renderer row/timing symptom. The session is then
 * selected by clicking its rendered sidebar row, and the explicit clear uses
 * the renderer action the sidebar and Projects page call.
 *
 * The right panel is driven the way a user drives it: a transcript file
 * reference opens the host file tab, a transcript link to a loopback page opens
 * the browser tab, the strip's own buttons add and close a tab, and the shell
 * toggle collapses the dock. Restarts then prove the collapsed/expanded state,
 * ordered tabs, active tab, the real page load, and the file preview that only
 * a fresh read can produce. The page fixture is served from loopback only.
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
  writeFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps/desktop");
const electronBin = join(appDir, "node_modules/.bin/electron");
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");
const MARKER_ID = "restart-marker";
const PANEL_REF_ID = "panel-ref";
/** Fixtures the right-panel phase opens through real transcript references. */
const FIXTURE_FILE = "notes.md";
const FIXTURE_PAGE = "panel-fixture.html";
const PAGE_TITLE = "Right panel fixture";

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
/*
 * Right-panel stage helpers.
 *
 * The dock is only ever driven through the affordances a user has: transcript
 * references and links, the strip's own buttons and the shell toggle. Nothing
 * here writes panel state, so what the restarts assert is what the app itself
 * persisted.
 */
function writeProjectFixtures(projectDir, notesMarker) {
  writeFileSync(
    join(projectDir, FIXTURE_FILE),
    ["# Right panel notes", "second line", notesMarker, "fourth line"].join("\n"),
  );
}

/** Loopback-only page the transcript link opens in the work-panel browser. */
async function startFixtureServer() {
  const pageMarker = `panel fixture page ${Date.now()}`;
  const server = createHttpServer((request, response) => {
    if (request.url !== `/${FIXTURE_PAGE}`) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>${PAGE_TITLE}</title><body><h1 id="fixture">${pageMarker}</h1>`,
    );
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/${FIXTURE_PAGE}`,
    pageMarker,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** What the dock shows plus what it stored, read in the renderer. */
function panelStateExpression(sessionId) {
  return `(() => {
    const sessionId = ${JSON.stringify(sessionId)};
    const tabs = [...document.querySelectorAll("[data-work-panel-tab-id]")].map((node) => ({
      id: node.getAttribute("data-work-panel-tab-id"),
      label: node.querySelector(".work-panel-tab-label")?.textContent ?? null,
      active: node.classList.contains("active"),
    }));
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("pi.desktop.workPanel") ?? "null"); } catch {}
    const stored = saved?.sessions?.[sessionId] ?? null;
    return {
      open: !!document.querySelector(".work-panel:not([data-exiting='true'])"),
      togglePressed: document.querySelector(".app-work-panel-toggle")?.getAttribute("aria-pressed") ?? null,
      tabs,
      viewer: document.querySelector(".file-viewer")?.innerText ?? null,
      savedOpen: saved?.open ?? null,
      savedWidth: saved?.width ?? null,
      savedVersion: saved?.version ?? null,
      stored: stored
        ? {
            activeTabId: stored.activeTabId ?? null,
            tabs: (stored.tabs ?? []).map((tab) => ({
              id: tab.id,
              kind: tab.kind,
              resource: tab.resource ?? null,
              location: tab.location ?? null,
              line: tab.line ?? null,
            })),
          }
        : null,
    };
  })()`;
}

/** Click what an expression names, after proving the point is hit-testable. */
async function clickControl(cdp, expression, label) {
  /*
   * The tab strip scrolls the active tab into view on its own, so a point
   * measured once can land on a neighbour (the strip's close control) when that
   * scroll settles. Scroll only when the control is outside the viewport, and
   * click only after two consecutive reads agree on its position.
   */
  const read = () =>
    cdp.evaluate(`(() => {
      const element = ${expression};
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const visible =
        rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      if (!visible) {
        element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        return null;
      }
      const x = Math.round(rect.x + rect.width / 2);
      const y = Math.round(rect.y + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        inside: !!hit && (hit === element || element.contains(hit)),
      };
    })()`);
  let point = await pollUntil(cdp, read, label, 20_000, `no clickable element for ${label}`);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(80);
    const next = await read();
    if (next && next.x === point.x && next.y === point.y) {
      point = next;
      break;
    }
    point = next ?? point;
  }
  assert.equal(point.inside, true, `${label} is obscured at its click point: ${JSON.stringify(point)}`);
  await cdp.clickAt(point.x, point.y);
}

/** The native guest the work-panel browser attached for this URL. */
async function openGuest(port, url, label) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.url === url) ?? null;
  }, `${label} guest target`, 25_000);
  const guest = await Cdp.connect(target.webSocketDebuggerUrl);
  await guest.send("Runtime.enable");
  return { guest, target };
}

/** Prove the native page really rendered the loopback fixture content. */
async function assertGuestPage(port, url, expected, label) {
  const { guest, target } = await openGuest(port, url, label);
  try {
    const page = await waitFor(async () => {
      const state = await guest.evaluate(
        "({ title: document.title, text: document.body ? document.body.innerText : '' })",
      );
      return state && state.text.includes(expected) ? state : null;
    }, `${label} guest content`, 25_000);
    return { type: target.type, title: page.title };
  } finally {
    guest.close();
  }
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
  const notesMarker = `right panel notes ${Date.now()}`;
  writeProjectFixtures(projectDir, notesMarker);
  let child;
  let cdp;
  let fixtures;
  try {
    stage = "launch";
    fixtures = await startFixtureServer();
    const referenceContent =
      `Panel references: [open notes](${FIXTURE_FILE}:3) and [open page](${fixtures.url}).`;
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
            }, {
              id: ${JSON.stringify(PANEL_REF_ID)},
              role: "assistant",
              content: ${JSON.stringify(referenceContent)},
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
    const reference = (seed.messages ?? []).find((item) => item.id === PANEL_REF_ID);
    assert.ok(reference, `prerequisite failed [sessionGet]: panel reference message missing from ${JSON.stringify(seed.messages)}`);
    assert.equal(reference.role, "assistant", `prerequisite failed [sessionGet]: panel reference role ${JSON.stringify(reference.role)}`);
    assert.equal(
      reference.content,
      referenceContent,
      `prerequisite failed [sessionGet]: panel reference content ${JSON.stringify(reference.content)}`,
    );

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

    stage = "right-panel-open-from-transcript";
    // Everything below is a user affordance: transcript anchors, the strip's
    // own buttons and the shell toggle. No panel state is injected.
    const panelExpression = panelStateExpression(sessionId);
    const freshPanel = await cdp.evaluate(panelExpression);
    assert.equal(freshPanel.open, false, `work panel starts closed: ${JSON.stringify(freshPanel)}`);
    assert.equal(freshPanel.tabs.length, 0, `work panel starts without tabs: ${JSON.stringify(freshPanel)}`);

    await clickControl(
      cdp,
      '[...document.querySelectorAll(".main-pane a")].find((anchor) => anchor.textContent.trim() === "open notes")',
      "transcript file reference",
    );
    const filePanel = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const state = ${panelExpression};
        return state.open
          && state.stored?.activeTabId === "file:${FIXTURE_FILE}"
          && state.viewer?.includes(${JSON.stringify(notesMarker)})
          ? state
          : null;
      })()`),
      "host file tab opened from a transcript reference",
      25_000,
      panelExpression,
    );
    assert.deepEqual(
      filePanel.tabs.map((tab) => tab.id),
      [`file:${FIXTURE_FILE}`],
      `work panel strip after the file reference: ${JSON.stringify(filePanel)}`,
    );
    assert.equal(filePanel.tabs[0].active, true, `file tab is not the active tab: ${JSON.stringify(filePanel)}`);
    assert.equal(filePanel.savedVersion, 2, `panel preference version not stored: ${JSON.stringify(filePanel)}`);
    assert.equal(filePanel.savedOpen, true, `opening a file tab did not store the open panel: ${JSON.stringify(filePanel)}`);
    assert.deepEqual(
      filePanel.stored,
      {
        activeTabId: `file:${FIXTURE_FILE}`,
        tabs: [{ id: `file:${FIXTURE_FILE}`, kind: "file", resource: FIXTURE_FILE, location: null, line: 3 }],
      },
      `stored file tab: ${JSON.stringify(filePanel.stored)}`,
    );
    assert.ok(filePanel.viewer.includes(notesMarker), `file preview did not render the fixture: ${JSON.stringify(filePanel.viewer)}`);

    await clickControl(
      cdp,
      '[...document.querySelectorAll(".main-pane a")].find((anchor) => anchor.textContent.trim() === "open page")',
      "transcript loopback link",
    );
    const browserPanel = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const state = ${panelExpression};
        const browser = state.stored?.tabs?.[1];
        return state.open
          && browser
          && browser.resource === "pi.browser/browser"
          && browser.location === ${JSON.stringify(fixtures.url)}
          ? state
          : null;
      })()`),
      "browser tab opened from the transcript loopback link",
      25_000,
      panelExpression,
    );
    const browserTabId = browserPanel.stored.tabs[1].id;
    assert.equal(browserPanel.tabs.length, 2, `work panel strip after the link: ${JSON.stringify(browserPanel)}`);
    assert.equal(browserPanel.tabs[0].id, `file:${FIXTURE_FILE}`, `first tab is not the file tab: ${JSON.stringify(browserPanel)}`);
    assert.equal(browserPanel.tabs[1].id, browserTabId, `browser tab missing from the strip: ${JSON.stringify(browserPanel)}`);
    assert.equal(browserPanel.tabs[1].active, true, `browser tab is not the active tab: ${JSON.stringify(browserPanel)}`);
    assert.equal(browserPanel.stored.activeTabId, browserTabId, `stored active tab is not the browser: ${JSON.stringify(browserPanel)}`);
    const guest = await assertGuestPage(port, fixtures.url, fixtures.pageMarker, "work-panel browser tab");

    await clickControl(cdp, 'document.querySelector(".work-panel-new-tab")', "work panel new tab button");
    const newTabPanel = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const state = ${panelExpression};
        return state.tabs.length === 3 && state.tabs[2]?.id.startsWith("new:") ? state : null;
      })()`),
      "work panel new tab",
      20_000,
      panelExpression,
    );
    await clickControl(
      cdp,
      `document.querySelector(${JSON.stringify(`[data-work-panel-tab-id="${newTabPanel.tabs[2].id}"] .work-panel-tab-close`)})`,
      "work panel new tab close",
    );
    const closedPanel = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const state = ${panelExpression};
        return state.tabs.length === 2 && state.stored?.tabs?.length === 2 ? state : null;
      })()`),
      "explicit tab close",
      20_000,
      panelExpression,
    );
    assert.deepEqual(
      closedPanel.tabs.map((tab) => tab.id),
      [`file:${FIXTURE_FILE}`, browserTabId],
      `strip after the explicit close: ${JSON.stringify(closedPanel)}`,
    );
    assert.equal(closedPanel.stored.activeTabId, browserTabId, `closed tab kept selection: ${JSON.stringify(closedPanel)}`);

    await clickControl(cdp, 'document.querySelector(".app-work-panel-toggle")', "work panel toggle");
    const collapsedPanel = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const state = ${panelExpression};
        return !state.open && state.savedOpen === false && state.togglePressed === "false" ? state : null;
      })()`),
      "collapsed work panel",
      20_000,
      panelExpression,
    );
    assert.equal(collapsedPanel.togglePressed, "false", `toggle still reports an open panel: ${JSON.stringify(collapsedPanel)}`);
    assert.deepEqual(
      collapsedPanel.stored.tabs.map((tab) => tab.id),
      [`file:${FIXTURE_FILE}`, browserTabId],
      `collapsed panel lost its tabs: ${JSON.stringify(collapsedPanel)}`,
    );
    console.log(`PANEL EVIDENCE first-launch ${JSON.stringify({
      fileTab: filePanel.stored.tabs[0],
      browserTab: browserPanel.stored.tabs[1],
      guest,
      width: collapsedPanel.savedWidth,
    })}`);
    console.log("PASS transcript reference and loopback link open ordered file/browser tabs, an explicit tab close is stored, and the toggle collapses the panel");

    stage = "sidebar-toggle";
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
    await waitFor(() => cdp.evaluate(`!document.querySelector(".sidebar")`), "manual sidebar collapse");

    const expandTarget = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('[data-nav="toggle-sidebar"], .ct-lead .ct-icon-btn')]
        .find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0
            && candidate.disabled !== true
            && candidate.getAttribute("aria-disabled") !== "true";
        });
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    assert.ok(expandTarget, `sidebar expand control is not visible: ${JSON.stringify(expandTarget)}`);
    await cdp.clickAt(expandTarget.x, expandTarget.y);
    await waitFor(() => cdp.evaluate(`!!document.querySelector(".sidebar")`), "manual sidebar expansion");
    const toggledView = await pollUntil(
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
      "restored active session after a sidebar toggle",
      15_000,
      rendererDiagnostics(marker),
    );
    assert.equal(toggledView.running, false, "restored session must not resume a turn after a sidebar toggle");
    console.log("PASS sidebar toggle collapses and re-expands without touching the restored session");

    stage = "restart-1";
    await quit(cdp, child);
    cdp = null;
    child = launch(port, profileDir, dataDir);
    cdp = await openWindow(port);
    await waitFor(() => cdp.evaluate(`!!document.querySelector(".sidebar")`), "expanded sidebar after restart");
    const restartState = await cdp.evaluate(`({
      sidebar: !!document.querySelector(".sidebar"),
      selected: localStorage.getItem("pi.desktop.lastSelectedSessionId"),
      rowCount: document.querySelectorAll("[data-sidebar-session-row]").length,
      running: !!document.querySelector(".stop-btn"),
    })`);
    assert.equal(restartState.sidebar, true, `sidebar should start expanded after restart: ${JSON.stringify(restartState)}`);
    assert.equal(restartState.running, false, `restored session auto-executed after restart: ${JSON.stringify(restartState)}`);

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
      "restored active session after restart",
      15_000,
      rendererDiagnostics(marker),
    );
    assert.equal(restoredView.running, false, "restored session must not resume a turn after restart");

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
    console.log(`SELECTION EVIDENCE after-restart ${JSON.stringify({ selected: durable.selected, listedSessions: durable.listedSessions, restartState })}`);
    console.log("PASS project, session, transcript and expanded sidebar survive restart without auto-execution");

    stage = "right-panel-closed-restart";
    const closedRestart = await cdp.evaluate(panelExpression);
    assert.equal(closedRestart.open, false, `collapsed panel reopened after restart: ${JSON.stringify(closedRestart)}`);
    assert.equal(closedRestart.savedOpen, false, `collapsed state was not stored: ${JSON.stringify(closedRestart)}`);
    assert.deepEqual(
      closedRestart.stored?.tabs?.map((tab) => tab.id),
      [`file:${FIXTURE_FILE}`, browserTabId],
      `collapsed panel lost its tabs across the restart: ${JSON.stringify(closedRestart)}`,
    );

    await clickControl(cdp, 'document.querySelector(".app-work-panel-toggle")', "work panel toggle after restart");
    const reopened = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const state = ${panelExpression};
        return state.open && state.tabs.length === 2 ? state : null;
      })()`),
      "reopened work panel",
      25_000,
      panelExpression,
    );
    assert.deepEqual(
      reopened.tabs.map((tab) => tab.id),
      [`file:${FIXTURE_FILE}`, browserTabId],
      `reopened strip order: ${JSON.stringify(reopened)}`,
    );
    assert.equal(reopened.tabs[1].active, true, `reopened panel did not select the last active tab: ${JSON.stringify(reopened)}`);
    const reopenedGuest = await assertGuestPage(port, fixtures.url, fixtures.pageMarker, "reopened browser tab");
    // A tab is activated through its label: the tab's own close control sits at
    // the right edge, so a center-of-button click is not the user's target.
    await clickControl(
      cdp,
      `document.querySelector(${JSON.stringify(`[data-work-panel-tab-id="file:${FIXTURE_FILE}"] .work-panel-tab-label`)})`,
      "file tab label",
    );
    const reopenedFile = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const state = ${panelExpression};
        return state.stored?.activeTabId === "file:${FIXTURE_FILE}"
          && state.viewer?.includes(${JSON.stringify(notesMarker)})
          ? state
          : null;
      })()`),
      "file preview after reopening the panel",
      25_000,
      panelExpression,
    );
    console.log(`PANEL EVIDENCE reopened-after-collapse ${JSON.stringify({
      tabs: reopenedFile.stored.tabs.map((tab) => tab.id),
      guest: reopenedGuest,
    })}`);
    console.log("PASS a collapsed panel stays closed across restart with its tabs retained, and reopening shows both tabs and reloads the page");

    stage = "restart-2";
    await quit(cdp, child);
    cdp = null;
    child = launch(port, profileDir, dataDir);
    cdp = await openWindow(port);
    await waitFor(() => cdp.evaluate(`!!document.querySelector(".sidebar")`), "expanded sidebar after restart");
    const secondView = await pollUntil(
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
      currentWorkspace: document.querySelector("[data-current-workspace='true']")?.getAttribute("data-sidebar-project-group") ?? null,
      running: !!document.querySelector(".stop-btn"),
    })`);
    assert.equal(secondView.running, false, "restored session must not resume a turn");
    assert.equal(normalizePath(layout.currentWorkspace), canonicalProject, `active project lost after expanded restart: ${JSON.stringify(layout)}`);
    assert.equal(layout.running, false, `restored session auto-executed after expanded restart: ${JSON.stringify(layout)}`);
    console.log("PASS project, session and transcript survive a second Electron relaunch");

    stage = "right-panel-open-restart";
    // The file tab was active when this process quit, so a restored preview can
    // only come from a fresh file request the renderer actually read.
    const restoredPanel = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const state = ${panelExpression};
        return state.open
          && state.stored?.activeTabId === "file:${FIXTURE_FILE}"
          && state.viewer?.includes(${JSON.stringify(notesMarker)})
          ? state
          : null;
      })()`),
      "restored open panel with the active file tab preview",
      25_000,
      panelExpression,
    );
    assert.deepEqual(
      restoredPanel.tabs.map((tab) => tab.id),
      [`file:${FIXTURE_FILE}`, browserTabId],
      `restored strip order: ${JSON.stringify(restoredPanel)}`,
    );
    assert.equal(restoredPanel.savedOpen, true, `expanded panel was stored closed: ${JSON.stringify(restoredPanel)}`);
    assert.equal(restoredPanel.tabs[0].active, true, `restored active tab is not the file tab: ${JSON.stringify(restoredPanel)}`);
    assert.equal(
      restoredPanel.stored.tabs[1].location,
      fixtures.url,
      `restored browser tab lost its URL: ${JSON.stringify(restoredPanel.stored.tabs[1])}`,
    );

    await clickControl(
      cdp,
      `document.querySelector(${JSON.stringify(`[data-work-panel-tab-id="${browserTabId}"] .work-panel-tab-label`)})`,
      "browser tab label",
    );
    const restoredBrowser = await pollUntil(
      cdp,
      () => cdp.evaluate(`(() => {
        const state = ${panelExpression};
        return state.stored?.activeTabId === ${JSON.stringify(browserTabId)} ? state : null;
      })()`),
      "browser tab selected after restart",
      25_000,
      panelExpression,
    );
    const restoredGuest = await assertGuestPage(port, fixtures.url, fixtures.pageMarker, "restored browser tab");
    console.log(`PANEL EVIDENCE open-after-restart ${JSON.stringify({
      tabs: restoredBrowser.stored.tabs.map((tab) => tab.id),
      activeTabId: restoredBrowser.stored.activeTabId,
      viewer: restoredPanel.viewer ? restoredPanel.viewer.slice(0, 120) : null,
      guest: restoredGuest,
    })}`);
    console.log("PASS an expanded panel restores open with its active file tab freshly previewed and its browser URL loaded");

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
      selected: localStorage.getItem("pi.desktop.lastSelectedSessionId"),
      running: !!document.querySelector(".stop-btn"),
    })`);
    assert.equal(clearedView.activeId, null, `explicit project clear was resurrected: ${JSON.stringify(clearedView)}`);
    assert.equal(clearedView.markerVisible, false, `cleared transcript was resurrected: ${JSON.stringify(clearedView)}`);
    assert.notEqual(normalizePath(clearedView.currentWorkspace), canonicalProject, `cleared project became active again: ${JSON.stringify(clearedView)}`);
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
    if (fixtures) await fixtures.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`FAILED at stage=${stage}: ${error.message}`);
  process.exitCode = 1;
});
