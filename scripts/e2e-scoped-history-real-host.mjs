#!/usr/bin/env node
/**
 * E2E-207b/c/d/e — scoped transcript history through the real Desktop build,
 * the real Rust host-core binary, and an isolated synthetic profile.
 *
 * What is real here:
 *   - the renderer is `apps/desktop/out/renderer` from the final source tree;
 *   - Electron Main is the built `apps/desktop/out/main` of the same tree;
 *   - the host is the freshly built `pi-desktop-host-core` executable, reached
 *     over its own NDJSON RPC by the production Main handlers;
 *   - a sidecar proxy around the host records every `session.get` request and
 *     the shape of its real answer, without rewriting either direction.
 *
 * What is synthetic: one temporary data directory, one temporary workspace,
 * one temporary Electron profile, and a transcript fixture written through the
 * host's own `session.import`. No provider, model, agent prompt, personal data
 * directory, or real network call is used.
 *
 * Sequence:
 *   1. sidebar opens the delegate-heavy session -> the main read is scoped
 *      `{kind:"main"}`, bounded, and returns top-level rows only;
 *   2. scrolling to the head loads one older main page and ends at the head;
 *   3. the root Task card opens its own `{kind:"delegation", id}` page; the
 *      panel pages to its head while the main window is replaced and restored;
 *   4. session switch, tab close/reopen, and a second alias of the chain keep
 *      the panel's identity and loaded rows without a new panel read;
 *   5. searching a nested child opens the owning tab and highlights the row,
 *      while the main transcript never renders that child standalone;
 *   6. a settlement + handoff checkpoint is appended through the host's
 *      `session.appendMessage` runtime path while the launch row is old; the
 *      transcript stays byte-identical and a snapshot sidecar appears;
 *   7. both desktop and host are restarted; the card reads settled, the full
 *      report (and the `TaskWait` batch text) survives, and the recovered
 *      catalog marks an unsettled run `interrupted`, never phantom `running`.
 *
 * Usage:
 *   PI_DESKTOP_HOST_BIN=<freshly built host> node scripts/e2e-scoped-history-real-host.mjs
 *
 * Optional:
 *   PI_SCOPED_ARTIFACT_DIR  directory for screenshots, host log, and result JSON.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { resolveElectronBinary } from "./e2e/boot.mjs";
import { Host } from "./e2e/host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_HOST =
  process.env.PI_DESKTOP_HOST_BIN ||
  "/Users/jorkeyliu/workspace/repos/pi-desktop/target/debug/pi-desktop-host-core";
const artifactDir =
  process.env.PI_SCOPED_ARTIFACT_DIR ||
  join(process.env.PI_SCRATCH_DIR || tmpdir(), "artifacts", "scoped-history-real-host");
const { appDir, electronBinary } = resolveElectronBinary(root);
assert(
  existsSync(REAL_HOST),
  `fresh host binary missing at ${REAL_HOST}; build it with cargo build -p host-core --locked first`,
);
assert(
  existsSync(join(appDir, "out/renderer/index.html")) && existsSync(join(appDir, "out/main/index.js")),
  "Desktop build is missing; run the final JS build first",
);
mkdirSync(artifactDir, { recursive: true });

const SESSION_A = "scope-real-delegate-heavy";
const SESSION_B = "scope-real-ordinary";
const SESSION_A_TITLE = "Delegate history fixture";
const SESSION_B_TITLE = "Ordinary conversation";
const DELEGATION = "delegation-1";
const CALL_1 = "call-1";
const CALL_2 = "call-2";
const CALL_3 = "call-3";
const TASK_1 = "task-1-msg";
const TASK_2 = "task-2-msg";
const TASK_3 = "task-3-msg";
const TASK_WAIT = "task-wait-msg";
const WAIT_CALL = "wait-1";
const WAIT_DELEGATION = "delegation-2";
const NESTED_TARGET = "child-1-500";
const NESTED_TOKEN = "REALHOST_NESTED_TARGET_TOKEN";
const TASKWAIT_REPORT =
  "TaskWait batch report for the resumed run: the resumed segment finished and this exact text is the batch the parent read.";
const FINAL_REPORT =
  "Final settled report: the cache misses were traced to a stale session index after restart. " +
  "The index now refreshes from the transcript prefix before the first read, and the restart replay is bounded " +
  "to top-level records. Checkpoint generation one records the installed handoff.";
const CHAIN_CHILD_TOTAL = 1001 + 5 + 3;
const TOP_LEVEL_TOTAL = 150;
const ORDINARY_ROWS = 140;
const PANEL_PAGE_ROWS = 100;
const PANEL_ROW_BUDGET = 400;

const timestamp = (second) =>
  new Date(Date.UTC(2026, 9, 18, 0, 0, second)).toISOString();
const isoAt = (second) => timestamp(second);

function message(id, role, content, extra = {}) {
  return { id, role, content, createdAt: isoAt(2), status: "complete", ...extra };
}

function taskRow(id, callId, delegationId, status, resume, extraDetails = {}) {
  return message(id, "tool", "", {
    toolName: "Task",
    toolCallId: callId,
    toolStatus: status === "running" ? "running" : "success",
    toolArgs: {
      agent: "explorer",
      description: "Trace the cache",
      task: "Trace why the session cache misses after a restart.",
      ...(resume ? { resume } : {}),
    },
    toolResult: {
      details: {
        delegationId,
        agent: "explorer",
        status,
        startedAt: 1_000,
        ...(status === "running" ? {} : { completedAt: 42_000 }),
        modelId: "fixture-model",
        thinkingLevel: "medium",
        toolCalls: 2,
        turns: 1,
        contextTokens: 1234,
        ...extraDetails,
      },
    },
  });
}

function childRow(id, content, callId, extra = {}) {
  return message(id, "assistant", content, {
    parentToolCallId: callId,
    agentName: "explorer",
    ...extra,
  });
}

function fixtureMessages() {
  const rows = [];
  rows.push(message("root-user", "user", "Fix the cache after restart."));
  rows.push(taskRow(TASK_1, CALL_1, DELEGATION, "completed", undefined));
  for (let index = 0; index <= 1000; index += 1) {
    const id = `child-1-${index}`;
    rows.push(
      childRow(
        id,
        index === 500
          ? `child chain row ${index} ${NESTED_TOKEN}`
          : `child chain row ${index}`,
        CALL_1,
      ),
    );
  }
  for (let index = 0; index < ORDINARY_ROWS; index += 1) {
    const id = `ordinary-${index}`;
    rows.push(
      message(id, index % 2 === 0 ? "user" : "assistant", `ordinary conversation row ${index}`),
    );
  }
  rows.push(taskRow(TASK_2, CALL_2, WAIT_DELEGATION, "completed", DELEGATION));
  for (let index = 0; index < 5; index += 1) {
    rows.push(childRow(`child-2-${index}`, `resumed chain row ${index}`, CALL_2));
  }
  rows.push(
    message(TASK_WAIT, "tool", "", {
      toolName: "TaskWait",
      toolCallId: WAIT_CALL,
      toolStatus: "success",
      toolResult: {
        details: {
          delegations: [
            {
              delegationId: WAIT_DELEGATION,
              agent: "explorer",
              status: "completed",
              report: TASKWAIT_REPORT,
              startedAt: 1_000,
              completedAt: 42_000,
            },
          ],
        },
      },
    }),
  );
  rows.push(taskRow(TASK_3, CALL_3, "delegation-3", "running", WAIT_DELEGATION));
  rows.push(childRow("child-3-a", "third segment first row", CALL_3));
  rows.push(childRow("child-3-b", "third segment middle row", CALL_3));
  // The delegate's final assistant row is also the report evidence a restart
  // recovers when no TaskWait batch exists for this run.
  rows.push(childRow("child-3-c", FINAL_REPORT, CALL_3));
  for (let index = 0; index < 5; index += 1) {
    rows.push(message(`tail-${index}`, index % 2 === 0 ? "user" : "assistant", `tail row ${index}`));
  }
  return rows;
}

function summary(id, title, createdSecond) {
  return {
    id,
    title,
    messageCount: 0,
    projectPath: null,
    modelId: null,
    providerId: null,
    mode: "agent",
    thinkingLevel: "medium",
    permissionMode: "auto",
    updatedAt: isoAt(createdSecond),
    createdAt: isoAt(createdSecond),
    scheduledRun: false,
  };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function transcriptFiles(dataDir) {
  return readdirSync(dataDir, { recursive: true })
    .filter((name) => String(name).endsWith(".jsonl"))
    .map((name) => join(dataDir, String(name)));
}

/** One append-only proxy in front of the real host, logging RPC shape only. */
function writeHostProxy(tempRoot) {
  const path = join(tempRoot, "host-proxy.mjs");
  const logPath = join(tempRoot, "host-rpc.jsonl");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const real = ${JSON.stringify(REAL_HOST)};
const log = ${JSON.stringify(logPath)};
// The log outlives one host process: a restart spawns this proxy again, so the
// request counter must continue from what the file already holds. Evidence
// ranges taken before a restart then still address the later reads.
let seq = 0;
if (existsSync(log)) {
    for (const line of readFileSync(log, "utf8").split(String.fromCharCode(10))) {
    try {
      const event = JSON.parse(line);
      if (event.kind === "request" && Number.isInteger(event.seq)) {
        seq = Math.max(seq, event.seq);
      }
    } catch {
      // A partially flushed line is not a request yet.
    }
  }
}
const pending = new Map();

function logEvent(event) {
  appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\\n");
}

function summarize(method, params, result) {
  if (method !== "session.get" || !result || typeof result !== "object") return {};
  const session = result.session;
  if (!session) return { session: null };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const ids = messages.map((message) => message.id);
  const compactIds = ids.length <= 130 ? ids : [...ids.slice(0, 45), "..." + (ids.length - 90) + "...", ...ids.slice(-45)];
  const taskRows = messages
    .filter((message) => message.role === "tool" && message.toolName === "Task")
    .map((message) => {
      const details = message.toolResult && message.toolResult.details;
      const resultText = details && typeof details.result === "string" ? details.result : "";
      const checkpoint = details && details.handoffCheckpoint;
      return {
        id: message.id,
        callId: message.toolCallId,
        delegationId: details && details.delegationId,
        status: details && details.status,
        resultLength: resultText.length,
        resultMatches: resultText === ${JSON.stringify(FINAL_REPORT)},
        checkpointGeneration: checkpoint && checkpoint.generation,
      };
    });
  return {
    id: session.id,
    historyScope: session.historyScope ?? null,
    messageCount: session.messageCount,
    messageStart: session.messageStart,
    messageEnd: session.messageEnd,
    hasMoreBefore: session.hasMoreBefore,
    hasMoreAfter: session.hasMoreAfter,
    navigationParentId: session.navigationParent && session.navigationParent.id,
    returnedRows: messages.length,
    childRows: messages.filter((message) => message.parentToolCallId).length,
    messageIds: compactIds,
    historyContextIds: (session.historyContext ?? []).map((message) => message.id),
    taskRows,
  };
}

function onRequest(line) {
  let wire;
  try { wire = JSON.parse(line); } catch { return; }
  if (wire.id === undefined || wire.id === null) return;
  const event = { seq: ++seq, method: wire.method, params: wire.params };
  pending.set(String(wire.id), event);
  logEvent({ kind: "request", ...event });
}

function onResponse(line) {
  let wire;
  try { wire = JSON.parse(line); } catch { return; }
  if (wire.id === undefined || wire.id === null) return;
  const request = pending.get(String(wire.id));
  if (!request) return;
  pending.delete(String(wire.id));
  logEvent({
    kind: "response",
    seq: request.seq,
    method: request.method,
    params: request.params,
    ...(wire.error ? { error: wire.error } : { summary: summarize(request.method, request.params, wire.result) }),
  });
}

const child = spawn(real, [], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
process.stdin.setEncoding("utf8");
let inbound = "";
process.stdin.on("data", (chunk) => {
  inbound += chunk;
  const lines = inbound.split("\\n");
  inbound = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    onRequest(line);
    child.stdin.write(line + "\\n");
  }
});
process.stdin.on("end", () => child.stdin.end());

child.stdout.setEncoding("utf8");
let outbound = "";
child.stdout.on("data", (chunk) => {
  outbound += chunk;
  const lines = outbound.split("\\n");
  outbound = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    onResponse(line);
    process.stdout.write(line + "\\n");
  }
});
child.stdout.on("end", () => {
  if (outbound) process.stdout.write(outbound + "\\n");
});
child.stderr.pipe(process.stderr);
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => { try { child.kill(signal); } catch {} });
}
`,
  );
  chmodSync(path, 0o755);
  return { path, logPath };
}

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

/** Minimal CDP client: evaluate, screenshot, console errors. */
async function connectDesktop(port, timeoutMs = 90_000) {
  const target = await until(
    async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return list.find(
          (entry) =>
            entry.type === "page" &&
            entry.url.includes("index.html") &&
            !entry.url.includes("launcher") &&
            !entry.url.includes("plugin"),
        );
      } catch {
        return undefined;
      }
    },
    "Desktop CDP target",
    timeoutMs,
  );
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.onopen = resolveOpen;
    ws.onerror = rejectOpen;
  });
  let sequence = 0;
  const pending = new Map();
  const consoleErrors = [];
  const exceptions = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text,
      );
    }
    if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params.type === "error"
    ) {
      consoleErrors.push(
        message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "),
      );
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      consoleErrors.push(message.params.entry.text);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolveCall, rejectCall) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCall(new Error(`CDP timeout ${method}`));
      }, 90_000);
      pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "renderer evaluation failed",
      );
    }
    return result.result.value;
  };
  const screenshot = async (name) => {
    const image = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifactDir, name), Buffer.from(image.data, "base64"));
  };
  return { ws, send, evaluate, screenshot, consoleErrors, exceptions, close: () => ws.close() };
}

async function until(check, label, timeoutMs = 20_000) {
  const started = performance.now();
  let last;
  while (performance.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`timeout waiting for ${label}${last ? ` (${last.message})` : ""}`);
}

const tempRoot = await mkdtemp(join(tmpdir(), "pi-scoped-real-host-"));
const dataDir = join(tempRoot, "data");
const profileDir = join(tempRoot, "profile");
const homeDir = join(tempRoot, "home");
const workspace = join(tempRoot, "workspace");
for (const path of [dataDir, profileDir, homeDir, workspace]) mkdirSync(path, { recursive: true });
writeFileSync(join(workspace, "README.md"), "synthetic workspace for scoped history E2E\n");
const proxy = writeHostProxy(tempRoot);
const result = {
  testedSource: {
    head: "",
    base: "2d5f6f893",
    hostBinary: REAL_HOST,
    hostSha256: sha256(readFileSync(REAL_HOST)),
    rendererIndexSha256: sha256(readFileSync(join(appDir, "out/renderer/index.html"))),
    rendererEntry: "",
    mainSha256: sha256(readFileSync(join(appDir, "out/main/index.js"))),
  },
  environment: {
    platform: `${process.platform}-${process.arch}`,
    electron: electronBinary,
    profile: "temporary isolated profile",
    dataDir: "temporary synthetic data directory",
  },
  phases: {},
  evidence: {},
};

let desktop = null;
let desktopChild = null;
let desktopOutput = "";
let host = null;
let logCursor = 0;

function hostEvents(fromSeq) {
  if (!existsSync(proxy.logPath)) return [];
  const lines = readFileSync(proxy.logPath, "utf8").split("\n").filter(Boolean);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(
      (event) =>
        event &&
        event.kind === "response" &&
        Number.isInteger(event.seq) &&
        event.seq >= fromSeq,
    );
}

function lastSeq() {
  if (!existsSync(proxy.logPath)) return 0;
  const lines = readFileSync(proxy.logPath, "utf8").split("\n").filter(Boolean);
  let max = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.kind === "request" && Number.isInteger(event.seq)) max = Math.max(max, event.seq);
    } catch {
      // A partially flushed line is not a request yet.
    }
  }
  return max;
}

function mark() {
  logCursor = lastSeq();
  return logCursor + 1;
}

function readsFor(fromSeq, predicate = () => true) {
  return hostEvents(fromSeq).filter(
    (event) => event.method === "session.get" && predicate(event),
  );
}

async function launchDesktop() {
  const port = await freePort();
  desktopOutput = "";
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    PI_DESKTOP_DATA_DIR: dataDir,
    PI_DESKTOP_HOST_BIN: proxy.path,
    ELECTRON_RENDERER_URL: "",
    PI_DESKTOP_START_MAXIMIZED: "0",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "127.0.0.1,localhost",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktopChild = spawn(
    electronBinary,
    [
      `--remote-debugging-port=${port}`,
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--user-data-dir=${profileDir}`,
      ".",
    ],
    { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const stream of [desktopChild.stdout, desktopChild.stderr]) {
    stream.on("data", (chunk) => {
      desktopOutput += chunk;
    });
  }
  desktop = await connectDesktop(port);
  await until(
    () =>
      desktop.evaluate(
        'Boolean(window.__PI_DESKTOP__ && window.piDesktop && !document.querySelector(".app-shell.is-booting"))',
      ),
    "desktop app shell ready",
    90_000,
  );
  return port;
}

async function stopDesktop() {
  desktop?.close();
  desktop = null;
  if (!desktopChild) return;
  const child = desktopChild;
  desktopChild = null;
  child.kill("SIGTERM");
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  await Promise.race([exited, delay(8_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(3_000)]);
  }
}

/**
 * Move the main transcript with a user-shaped gesture, not a bare scroll
 * event: history continuation only acts on offsets the reader produced, and
 * `markScrollGesture` reads a `wheel` on the transcript wrapper (a passive
 * listener on `.thread-wrap`) to tell a reader reach from a layout clamp.
 * Wheel, then offset, then scroll - in one task, so the gesture window
 * (200 ms) still covers the scroll event.
 */
async function mainScrollerScroll(position) {
  const target = position === "end" ? "s.scrollHeight" : position === "start" ? "0" : String(position);
  return desktop.evaluate(
    `(() => {
      const s = document.querySelector('[data-scroll-owner="transcript"]');
      if (!s) return false;
      const deltaY = ${position === "end" ? "600" : "-600"};
      s.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY }));
      s.scrollTop = ${target};
      s.dispatchEvent(new Event("scroll", { bubbles: true }));
      return true;
    })()`,
  );
}

/**
 * Scroll growth plus paging takes several dispatched events: the mounted
 * window grows before the view asks for an older page. Repeat the event,
 * bounded, until the requested rows are mounted (and an older read, when
 * one is expected, has arrived).
 */
async function driveMainScroll({
  position = "start",
  fromSeq = null,
  untilTasks = [],
  deadlineMs = 30_000,
}) {
  const startedAt = Date.now();
  const trace = [];
  while (Date.now() - startedAt < deadlineMs) {
    const olderReads = fromSeq === null
      ? []
      : readsFor(fromSeq, (event) => event.summary?.historyScope?.kind === "main");
    const missing = [];
    for (const taskId of untilTasks) {
      const present = await desktop.evaluate(
        `Boolean(document.querySelector('[data-scroll-owner="transcript"] [data-message-id="${taskId}"]'))`,
      );
      if (!present) missing.push(taskId);
    }
    const olderReady = fromSeq === null || olderReads.length > 0;
    if (olderReady && missing.length === 0) return olderReads[0] ?? null;
    trace.push(
      await desktop.evaluate(
        `(() => {
          const s = document.querySelector('[data-scroll-owner="transcript"]');
          const rows = s ? Array.from(s.querySelectorAll('[data-message-id]')).map((row) => row.getAttribute('data-message-id')) : [];
          return {
            scrollTop: s ? Math.round(s.scrollTop) : null,
            scrollHeight: s ? Math.round(s.scrollHeight) : null,
            clientHeight: s ? Math.round(s.clientHeight) : null,
            rowCount: rows.length,
            first: rows[0] ?? null,
            last: rows[rows.length - 1] ?? null,
            oldestTaskPresent: rows.includes(${JSON.stringify(TASK_1)}),
            oldestTask: ${JSON.stringify(TASK_1)},
          };
        })()`,
      ),
    );
    if (trace.length > 30) trace.shift();
    await mainScrollerScroll(position);
    await delay(200);
  }
  const olderCount = fromSeq === null
    ? "n/a"
    : readsFor(fromSeq, (event) => event.summary?.historyScope?.kind === "main").length;
  const error = new Error(
    `main window never settled at ${position} (olderReads=${olderCount}, missing=${JSON.stringify(untilTasks)}, trace=${JSON.stringify(trace.slice(-6))})`,
  );
  error.trace = trace;
  throw error;
}

async function mainRowIds() {
  return desktop.evaluate(
    `Array.from(document.querySelectorAll('[data-scroll-owner="transcript"] [data-message-id]')).map((row) => row.getAttribute('data-message-id'))`,
  );
}

async function tabState() {
  return desktop.evaluate(
    `(() => {
      const surface = document.querySelector('.subagent-transcript-tab');
      const list = document.querySelector('.subagent-transcript-list');
      return {
        present: Boolean(surface),
        activeTabId: document.querySelector('.work-panel-tab.active')?.getAttribute('data-work-panel-tab-id') ?? null,
        status: document.querySelector('.subagent-transcript-status')?.textContent ?? '',
        context: document.querySelector('[data-testid="subagent-metrics-context"]')?.textContent ?? '',
        rowIds: list
          ? Array.from(list.querySelectorAll('.message-row.assistant[data-message-id]')).map((row) => row.getAttribute('data-message-id'))
          : [],
        earlier: Boolean(document.querySelector('.subagent-transcript-earlier .link-btn')),
        empty: Boolean(document.querySelector('[data-testid="subagent-history-empty"]')),
        failed: Boolean(document.querySelector('[data-testid="subagent-history-error"]')),
      };
    })()`,
  );
}

function compactEvent(event) {
  return {
    seq: event.seq,
    method: event.method,
    params: event.params,
    summary: event.summary,
    error: event.error,
  };
}

try {
  // ------------------------------------------------------------------ seed
  host = new Host(REAL_HOST, dataDir);
  await host.start();
  await host.call("workspace.set", { path: workspace });
  await host.call("settings.set", {
    language: "en",
    defaultMode: "agent",
    defaultPermissionMode: "auto",
    autoGenerateTitle: false,
  });
  const importA = await host.call("session.import", {
    session: summary(SESSION_A, SESSION_A_TITLE, 0),
    messages: fixtureMessages(),
  });
  assert.equal(importA.imported, true, "delegate-heavy fixture imported");
  const importB = await host.call("session.import", {
    session: summary(SESSION_B, SESSION_B_TITLE, 10),
    messages: [
      message("b-user", "user", "An ordinary question."),
      message("b-assistant", "assistant", "An ordinary answer."),
      message("b-user-2", "user", "Another ordinary question."),
    ],
  });
  assert.equal(importB.imported, true, "ordinary fixture imported");
  const fullBefore = await host.call("session.get", { id: SESSION_A });
  assert.equal(fullBefore.session.messageCount, TOP_LEVEL_TOTAL + CHAIN_CHILD_TOTAL);
  result.evidence.seeded = {
    physicalMessageCount: fullBefore.session.messageCount,
    physicalRows: fullBefore.session.messages.length,
    topLevelRows: fullBefore.session.messages.filter((row) => !row.parentToolCallId).length,
    childRows: fullBefore.session.messages.filter((row) => row.parentToolCallId).length,
    chainChildRows: CHAIN_CHILD_TOTAL,
    topLevelBudgetRows: TOP_LEVEL_TOTAL,
    ordinaryRows: ORDINARY_ROWS,
  };
  const transcriptPath = join(dataDir, "sessions", `${SESSION_A}.jsonl`);
  assert(existsSync(transcriptPath), "seeded transcript file found");
  const sidecarPath = join(dataDir, "sessions", `${SESSION_A}.snapshots.jsonl`);
  const transcriptBefore = readFileSync(transcriptPath);
  result.evidence.transcriptBefore = {
    path: relative(tempRoot, transcriptPath),
    bytes: transcriptBefore.length,
    sha256: sha256(transcriptBefore),
  };
  await host.stop();
  host = null;

  const fullBeforeMessages = fullBefore.session.messages;

  // ---------------------------------------------------------- first desktop
  await launchDesktop();
  result.evidence.consoleErrorsFirstBoot = desktop.consoleErrors.slice();
  const aRow = `[data-sidebar-session-row="${SESSION_A}"]`;
  await until(
    () => desktop.evaluate(`Boolean(document.querySelector(${JSON.stringify(aRow)}))`),
    "delegate-heavy sidebar row",
    60_000,
  );

  // ------------------------------------------------- 1. sidebar -> main scope
  const mainFrom = mark();
  await desktop.evaluate(
    `document.querySelector(${JSON.stringify(aRow)}).click()`,
  );
  await until(
    () =>
      desktop.evaluate(
        `Boolean(document.querySelector('[data-scroll-owner="transcript"] [data-message-id="${TASK_3}"]'))`,
      ),
    "delegate-heavy transcript opens",
    60_000,
  );
  const initialMainRead = await until(
    () => readsFor(mainFrom, (event) => event.summary?.historyScope?.kind === "main")[0],
    "the opening main-scoped read",
  );
  assert.equal(initialMainRead.params.historyScope.kind, "main");
  assert.equal(initialMainRead.params.messageLimit, 100);
  assert.equal(initialMainRead.params.contentLimit, 64 * 1024);
  assert.equal(initialMainRead.params.messageBefore, undefined);
  assert.equal(initialMainRead.summary.returnedRows, 100, "opening page holds 100 top-level records");
  assert.equal(initialMainRead.summary.childRows, 0, "opening main page holds no delegate child rows");
  assert.equal(initialMainRead.summary.hasMoreBefore, true, "older top-level history remains");
  assert(initialMainRead.summary.messageEnd > initialMainRead.summary.messageStart);
  const mainIds = await mainRowIds();
  assert(!mainIds.some((id) => /^child-[123]-/.test(id)), "no delegate child renders standalone");
  assert(mainIds.includes(TASK_3), "the newest root Task card is in the main page");
  assert(!mainIds.includes(TASK_1), "the root Task card is outside the newest page budget");
  result.phases.sidebarMain = {
    read: compactEvent(initialMainRead),
    domRows: mainIds.length,
    domHasChildRows: mainIds.filter((id) => /^child-/.test(id)),
  };
  await desktop.screenshot("01-main-scoped-open.png");

  // ------------------------------------------------------ 2. main paging
  // The mounted window grows before the view pages, so reach the head by
  // repeating the scroll-to-top event until both the older read and the
  // oldest root Task card are present.
  const pageMainFrom = mark();
  const olderMainRead = await driveMainScroll({ fromSeq: pageMainFrom, untilTasks: [TASK_1] });
  assert(olderMainRead, "paging fetches an older main page");
  assert.equal(
    olderMainRead.params.messageBefore,
    initialMainRead.summary.messageStart,
    "older main read uses the first page's physical cursor",
  );
  assert.equal(olderMainRead.params.messageLimit, 100);
  assert.equal(olderMainRead.params.contentLimit, 64 * 1024);
  assert.equal(olderMainRead.summary.childRows, 0, "older main page holds no delegate child rows");
  assert.equal(olderMainRead.summary.hasMoreBefore, false, "main paging ends at the transcript head");
  assert.equal(olderMainRead.summary.messageStart, 0, "the older page reaches the physical head");
  assert(
    initialMainRead.summary.messageEnd - initialMainRead.summary.messageStart >
      initialMainRead.summary.returnedRows,
    "the opening page's messageStart/messageEnd stay physical distances across child rows",
  );
  const pagedMainIds = await mainRowIds();
  assert(!pagedMainIds.some((id) => /^child-[123]-/.test(id)), "older page does not leak children");
  assert(pagedMainIds.includes(TASK_1), "the oldest root Task card is mounted after paging");
  const mainReadsAfterPaging = readsFor(mainFrom, (event) => event.summary?.historyScope?.kind === "main");
  assert.equal(mainReadsAfterPaging.length, 2, "paging costs exactly one older main read");
  result.phases.mainPaging = {
    olderRead: compactEvent(olderMainRead),
    mainReads: mainReadsAfterPaging.map((event) => event.params),
    domRows: pagedMainIds.length,
  };

  // --------------------------------------------- 3. root Task opens panel
  const panelFrom = mark();
  await desktop.evaluate(
    `document.querySelector('[data-message-id="${TASK_1}"] button.subagent-task-card').click()`,
  );
  await until(
    () => desktop.evaluate(`Boolean(document.querySelector('.subagent-transcript-tab'))`),
    "the delegation tab",
    30_000,
  );
  const firstPanelRead = await until(
    () =>
      readsFor(panelFrom, (event) => event.summary?.historyScope?.kind === "delegation")[0],
    "the panel's first delegation-scoped read",
  );
  assert.equal(firstPanelRead.params.historyScope.id, DELEGATION);
  assert.equal(firstPanelRead.params.messageLimit, 100);
  assert.equal(firstPanelRead.params.contentLimit, 64 * 1024);
  assert.equal(firstPanelRead.params.messageBefore, undefined);
  assert.equal(firstPanelRead.params.messageAround, undefined);
  assert.equal(firstPanelRead.summary.historyScope.id, DELEGATION, "canonical chain identity echoes");
  assert.deepEqual(
    firstPanelRead.summary.historyContextIds,
    [TASK_1, TASK_2, TASK_3],
    "the whole resume-connected Task chain answers as context",
  );
  assert(firstPanelRead.summary.childRows === firstPanelRead.summary.returnedRows);
  assert.equal(firstPanelRead.summary.returnedRows, 100);
  assert.equal(firstPanelRead.summary.hasMoreBefore, true);
  const firstTab = await tabState();
  assert.equal(firstTab.activeTabId, `subagent:${DELEGATION}`);
  assert(firstTab.rowIds.includes("child-1-1000"), "latest delegate page renders");
  assert(firstTab.rowIds.includes("child-3-c"), "the third chain segment renders");
  assert(firstTab.empty === false && firstTab.failed === false);
  assert(firstTab.status.length > 0, "the panel renders the chain status label");
  result.phases.panelOpen = { read: compactEvent(firstPanelRead), tab: firstTab };

  // ------------------------------------------- 4. older panel pages to head
  const olderPanelFrom = mark();
  let panelPages = 1;
  let panelRowsRead = firstPanelRead.summary.returnedRows;
  let panelMessageStart = firstPanelRead.summary.messageStart;
  while (true) {
    // The control is absent at the head and disabled while a page is merging;
    // wait for it to become clickable before deciding paging is over.
    let hasEarlier = false;
    const probe = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await desktop.evaluate(
        `(() => {
          const button = document.querySelector('.subagent-transcript-earlier .link-btn');
          return {
            button: button ? (button.disabled ? "disabled" : "ready") : "absent",
            status: document.querySelector('.subagent-transcript-status')?.textContent ?? null,
            loading: Boolean(document.querySelector('[data-testid="subagent-history-loading"]')),
            failure: Boolean(document.querySelector('[data-testid="subagent-history-error"]')),
            rows: document.querySelectorAll('.subagent-transcript-list [data-message-id]').length,
            surface: Boolean(document.querySelector('.subagent-transcript-tab')),
          };
        })()`,
      );
      probe.push({ attempt, ...state });
      if (state.button === "absent") break;
      if (state.button === "ready") {
        hasEarlier = true;
        break;
      }
      await delay(150);
    }
    (result.evidence.panelPagingProbe ??= []).push({ panelPages, probe: probe.slice(-4) });
    if (!hasEarlier) break;
    await desktop.evaluate(
      `document.querySelector('.subagent-transcript-earlier .link-btn').click()`,
    );
    const next = await until(
      () =>
        readsFor(
          olderPanelFrom,
          (event) =>
            event.summary?.historyScope?.kind === "delegation" &&
            typeof event.params.messageBefore === "number",
        )[panelPages - 1],
      `older delegate page ${panelPages}`,
    );
    // The read arriving is not the merge: wait for the earlier control to
    // leave its loading state before the next click.
    await until(
      () =>
        desktop.evaluate(
          `(() => {
            const button = document.querySelector('.subagent-transcript-earlier .link-btn');
            return !button || !button.disabled;
          })()`,
        ),
      `the merge for delegate page ${panelPages}`,
    );
    assert.equal(next.params.messageBefore, panelMessageStart, "older panel read uses the page cursor");
    assert.equal(next.params.messageLimit, 100);
    assert.equal(next.params.contentLimit, 64 * 1024);
    assert.equal(next.summary.historyScope.id, DELEGATION);
    assert(next.summary.childRows === next.summary.returnedRows);
    panelRowsRead += next.summary.returnedRows;
    panelPages += 1;
    panelMessageStart = next.summary.messageStart;
    assert(panelPages < 30, "panel paging terminates");
  }
  assert.equal(panelRowsRead, CHAIN_CHILD_TOTAL, "older paging loads every chain child row once");
  assert.equal(panelPages, 11, "1009 child rows page as ten full pages plus a nine-row head");
  const loadedTab = await tabState();
  // The panel keeps a bounded row budget (the newest rows win), so reaching the
  // chain head moves the cursor and clears the trigger while the rendered rows
  // stay the newest budget. Assert the contract, not an unbounded DOM.
  assert.equal(
    loadedTab.rowIds.length,
    PANEL_ROW_BUDGET,
    `the panel keeps its ${PANEL_ROW_BUDGET}-row budget after paging to the head`,
  );
  const retainedHeadId = `child-1-${CHAIN_CHILD_TOTAL - PANEL_ROW_BUDGET}`;
  assert.equal(
    loadedTab.rowIds[0],
    retainedHeadId,
    "the retained window starts at the oldest row inside the budget",
  );
  assert(!loadedTab.rowIds.includes("child-1-0"), "rows past the budget are trimmed, not mounted");
  assert(loadedTab.rowIds.includes("child-3-c"), "the newest chain segment stays rendered");
  assert.equal(loadedTab.earlier, false, "the earlier trigger disappears at the chain head");
  result.phases.panelPaging = {
    pages: panelPages,
    rows: panelRowsRead,
    retainedRows: loadedTab.rowIds.length,
    retainedHeadId,
    tab: loadedTab,
  };
  await desktop.screenshot("02-panel-full-chain.png");

  // ------------------------- 5. main window change/restore keeps the panel
  const stableFrom = mark();
  const signature = {
    activeTabId: loadedTab.activeTabId,
    status: loadedTab.status,
    context: loadedTab.context,
    rowIds: loadedTab.rowIds,
  };
  await driveMainScroll({ position: "end", untilTasks: [TASK_3] });
  await driveMainScroll({ position: "start", untilTasks: [TASK_1] });
  await delay(400);
  const afterMainChange = await tabState();
  assert.equal(afterMainChange.activeTabId, signature.activeTabId);
  assert.equal(afterMainChange.status, signature.status);
  assert.equal(afterMainChange.context, signature.context);
  assert.deepEqual(afterMainChange.rowIds, signature.rowIds);
  assert.equal(readsFor(stableFrom, (event) => event.summary?.historyScope?.kind === "delegation").length, 0);
  result.phases.mainWindowChange = { stable: true, reads: 0, tab: afterMainChange };

  // Re-select the same session: a fresh main window, not a fresh panel page.
  await desktop.evaluate(`document.querySelector(${JSON.stringify(aRow)}).click()`);
  await until(
    () =>
      desktop.evaluate(
        `Boolean(document.querySelector('[data-scroll-owner="transcript"] [data-message-id="${TASK_3}"]'))`,
      ),
    "reopened main window",
  );
  await delay(500);
  const afterReselect = await tabState();
  assert.deepEqual(afterReselect.rowIds, signature.rowIds, "re-selecting the session keeps the panel rows");
  assert.equal(afterReselect.activeTabId, signature.activeTabId);
  assert.equal(readsFor(stableFrom, (event) => event.summary?.historyScope?.kind === "delegation").length, 0);
  result.phases.mainReselect = { tab: afterReselect };

  // ----------------------------------------------- 6. session switch/restore
  const bRow = `[data-sidebar-session-row="${SESSION_B}"]`;
  const switchFrom = mark();
  await desktop.evaluate(`document.querySelector(${JSON.stringify(bRow)}).click()`);
  const ordinaryRead = await until(
    () => readsFor(switchFrom, (event) => event.summary?.id === SESSION_B)[0],
    "the ordinary session's read",
  );
  assert.equal(ordinaryRead.params.historyScope.kind, "main");
  assert.equal(ordinaryRead.params.messageLimit, 100);
  assert.equal(ordinaryRead.summary.returnedRows, 3);
  assert.equal(ordinaryRead.summary.childRows, 0);
  await until(
    () =>
      desktop.evaluate(`!document.querySelector('.subagent-transcript-tab')`),
    "the other session has no delegate surface",
    20_000,
  );
  await desktop.evaluate(`document.querySelector(${JSON.stringify(aRow)}).click()`);
  await until(
    () => desktop.evaluate(`Boolean(document.querySelector('.subagent-transcript-tab'))`),
    "the restored delegate surface",
  );
  await until(
    () =>
      desktop.evaluate(
        `Boolean(document.querySelector('[data-scroll-owner="transcript"] [data-message-id="${TASK_3}"]'))`,
      ),
    "the restored main window",
  );
  await delay(500);
  const restoredTab = await tabState();
  assert.deepEqual(restoredTab.rowIds, signature.rowIds, "session restore keeps every loaded panel row");
  assert.equal(restoredTab.status, signature.status);
  assert.equal(restoredTab.activeTabId, signature.activeTabId);
  // Restoring the session may re-publish its live rows, which marks the entry
  // stale; the tab then refreshes its tail once instead of trusting the old
  // page. That is one bounded read, never an older page.
  const switchPanelReads = readsFor(
    switchFrom,
    (event) => event.summary?.historyScope?.kind === "delegation",
  );
  assert(
    switchPanelReads.length <= 1,
    `a session restore spends at most one bounded tail refresh (${switchPanelReads.length})`,
  );
  for (const read of switchPanelReads) {
    assert.equal(read.params.messageLimit, 100);
    assert.equal(read.params.messageBefore, undefined, "a restore never asks for an older page");
    assert.equal(read.params.messageAround, undefined, "a restore never re-centres a search");
    assert(read.summary.returnedRows <= 100, "the refresh stays inside one page");
    assert(read.summary.childRows === read.summary.returnedRows);
  }
  result.phases.sessionSwitch = {
    ordinaryRead: compactEvent(ordinaryRead),
    restoredTab,
    delegationReads: switchPanelReads.length,
    refreshRead: switchPanelReads[0] ? compactEvent(switchPanelReads[0]) : null,
  };

  // ------------------------------------- 7. alias opens the same chain tab
  const aliasFrom = mark();
  await driveMainScroll({ position: "end", untilTasks: [TASK_2] });
  const beforeAlias = await tabState();
  await desktop.evaluate(
    `document.querySelector('[data-message-id="${TASK_2}"] button.subagent-task-card').click()`,
  );
  await delay(500);
  const aliasTab = await tabState();
  assert.equal(aliasTab.activeTabId, beforeAlias.activeTabId, "a resumed Task identity resolves onto the open tab");
  assert.deepEqual(aliasTab.rowIds, beforeAlias.rowIds, "the alias does not switch the panel chain");
  assert.equal(readsFor(aliasFrom, (event) => event.summary?.historyScope?.kind === "delegation").length, 0, "an alias spends no panel read");
  result.phases.alias = { tab: aliasTab, reads: 0 };

  // --------------------------------------------- 8. close/reopen reuses cache
  const closeFrom = mark();
  await desktop.evaluate(
    `document.querySelector('.work-panel-tab.active .work-panel-tab-close').click()`,
  );
  await until(
    () => desktop.evaluate(`!document.querySelector('.subagent-transcript-tab')`),
    "the closed delegation surface",
  );
  await driveMainScroll({ position: "start", untilTasks: [TASK_1] });
  await desktop.evaluate(
    `document.querySelector('[data-message-id="${TASK_1}"] button.subagent-task-card').click()`,
  );
  await until(
    () => desktop.evaluate(`Boolean(document.querySelector('.subagent-transcript-tab'))`),
    "the reopened delegation surface",
  );
  await delay(500);
  const reopenedTab = await tabState();
  assert.deepEqual(reopenedTab.rowIds, signature.rowIds, "reopening draws the cached page");
  assert.equal(reopenedTab.activeTabId, signature.activeTabId);
  assert.equal(readsFor(closeFrom, (event) => event.summary?.historyScope?.kind === "delegation").length, 0, "reopening spends no panel read");
  result.phases.closeReopen = { tab: reopenedTab, reads: 0 };

  // --------------------------------- 9. search a nested child -> its owning tab
  const searchFrom = mark();
  await desktop.evaluate(
    `(() => {
      const button = document.querySelector('button[aria-label="Search"]');
      if (!button) throw new Error('search control missing');
      button.click();
    })()`,
  );
  await until(
    () => desktop.evaluate(`Boolean(document.querySelector('.search-input'))`),
    "search dialog",
  );
  await desktop.evaluate(
    `(() => {
      const input = document.querySelector('.search-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(NESTED_TOKEN)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
  await until(
    () =>
      desktop.evaluate(
        `Array.from(document.querySelectorAll('.search-message-hit')).some((hit) => hit.textContent.includes(${JSON.stringify(NESTED_TOKEN)}))`,
      ),
    "the nested child search hit",
    30_000,
  );
  await desktop.evaluate(
    `Array.from(document.querySelectorAll('.search-message-hit')).find((hit) => hit.textContent.includes(${JSON.stringify(NESTED_TOKEN)})).click()`,
  );
  await until(
    () => desktop.evaluate(`!document.querySelector('.search-dialog')`),
    "search dialog closes",
  );
  const physicalSearchRead = await until(
    () =>
      readsFor(
        searchFrom,
        (event) =>
          event.params.messageAround === NESTED_TARGET &&
          event.params.historyScope === undefined,
      )[0],
    "the physical search read",
  );
  assert.equal(physicalSearchRead.params.messageLimit, 60);
  assert.equal(physicalSearchRead.params.contentLimit, 64 * 1024);
  assert.equal(physicalSearchRead.summary.navigationParentId, TASK_1, "physical search resolves the owning Task");
  // The search request is made under the parent tool-call id, while the tab it
  // lands in already holds the delegation identity. The focus has to reach the
  // mounted surface, so the target row must be rendered and marked there.
  const searchFocusDeadline = Date.now() + 8_000;
  let focused = { present: false };
  while (Date.now() < searchFocusDeadline) {
    focused = await desktop.evaluate(
      `(() => {
        const list = document.querySelector('.subagent-transcript-list');
        const row = list ? list.querySelector('[data-message-id="${NESTED_TARGET}"]') : null;
        const scroller = document.querySelector('.subagent-transcript-scroll');
        // A literal-text hit paints through the CSS Highlight registry; the
        // source class only marks source-only owners (link destinations, markup).
        const highlight = globalThis.CSS?.highlights?.get('transcript-search');
        let ranges = 0;
        let anchored = false;
        if (highlight) {
          for (const range of highlight) {
            ranges += 1;
            if (range.startContainer.parentElement?.closest('[data-message-id]') === row) anchored = true;
          }
        }
        const viewport = scroller ? scroller.getBoundingClientRect() : { top: 0, height: 0 };
        const box = row ? row.getBoundingClientRect() : { top: 0 };
        return row ? {
          present: true,
          highlighted: row.classList.contains('transcript-search-source-match') || anchored,
          highlightRanges: ranges,
          topGap: box.top - viewport.top,
          viewportHeight: viewport.height,
          activeTabId: document.querySelector('.work-panel-tab.active')?.getAttribute('data-work-panel-tab-id') ?? null,
        } : {
          present: false,
          activeTabId: document.querySelector('.work-panel-tab.active')?.getAttribute('data-work-panel-tab-id') ?? null,
          panelRows: list ? list.querySelectorAll('[data-message-id]').length : 0,
        };
      })()`,
    );
    if (focused.present) break;
    await delay(200);
  }
  const scopedFocusRead = readsFor(
    searchFrom,
    (event) =>
      event.summary?.historyScope?.kind === "delegation" &&
      event.params.messageAround === NESTED_TARGET,
  )[0];
  assert(scopedFocusRead, "the focused search spent a delegation-scoped read");
  assert.equal(
    scopedFocusRead.params.historyScope.id,
    DELEGATION,
    "the focus read follows the tab the open request landed in, not the identity that asked",
  );
  assert.equal(scopedFocusRead.summary.historyScope.id, DELEGATION, "the scope answer echoes the tab chain");
  assert.equal(focused.present, true, `the focused target is missing from the open panel: ${JSON.stringify(focused)}`);
  assert.equal(focused.highlighted, true, `the focused target carries the search highlight: ${JSON.stringify(focused)}`);
  assert.ok(
    focused.topGap >= 0 && focused.topGap <= Math.max(120, focused.viewportHeight * 0.5),
    `the focused target is scrolled into the panel viewport: ${JSON.stringify(focused)}`,
  );
  assert.equal(focused.activeTabId, `subagent:${DELEGATION}`, "the focus lands in the chain's own tab");
  const focusGap = await desktop.evaluate(
    `(() => {
      const list = document.querySelector('.subagent-transcript-list');
      const ids = list
        ? Array.from(list.querySelectorAll('.message-row.assistant[data-message-id]')).map((row) => row.getAttribute('data-message-id'))
        : [];
      return {
        rows: ids.length,
        uniqueRows: new Set(ids).size,
        lastRow: ids[ids.length - 1] ?? null,
        omittedMarker: Boolean(document.querySelector('[data-testid="subagent-history-omitted"]')),
        showLatest: Boolean(document.querySelector('[data-testid="subagent-show-latest"]')),
        earlier: Boolean(document.querySelector('.subagent-transcript-earlier .link-btn')),
      };
    })()`,
  );
  const mainSearchIds = await mainRowIds();
  assert(!mainSearchIds.includes(NESTED_TARGET), "the main transcript still holds no child row");
  assert.equal(focusGap.uniqueRows, focusGap.rows, "the focused page repeats no row");
  result.phases.searchNested = {
    physicalRead: compactEvent(physicalSearchRead),
    scopedFocusRead: compactEvent(scopedFocusRead),
    focused,
    gap: focusGap,
    mainRows: mainSearchIds.length,
  };
  await desktop.screenshot("03-search-nested-focused.png");

  // The focused page is a retained island: the rows between it and the newest
  // page the tab already held are omitted, so the view states that omission and
  // offers the newest messages again. Showing them must reach the real tail.
  assert.equal(focusGap.omittedMarker, true, "the omitted gap after the focused island is stated");
  assert.equal(focusGap.showLatest, true, "the newest-page control is offered from the focused island");
  const latestFrom = mark();
  await desktop.evaluate(`document.querySelector('[data-testid="subagent-show-latest"] button').click()`);
  const latestState = await until(
    async () => {
      const state = await desktop.evaluate(
        `(() => {
          const list = document.querySelector('.subagent-transcript-list');
          const ids = list
            ? Array.from(list.querySelectorAll('.message-row.assistant[data-message-id]')).map((row) => row.getAttribute('data-message-id'))
            : [];
          return {
            rows: ids.length,
            uniqueRows: new Set(ids).size,
            lastRow: ids[ids.length - 1] ?? null,
            focusVisible: ids.includes(${JSON.stringify(NESTED_TARGET)}),
            omittedMarker: Boolean(document.querySelector('[data-testid="subagent-history-omitted"]')),
            showLatest: Boolean(document.querySelector('[data-testid="subagent-show-latest"]')),
            earlier: Boolean(document.querySelector('.subagent-transcript-earlier .link-btn')),
            status: document.querySelector('.subagent-transcript-status')?.textContent ?? "",
          };
        })()`,
      );
      return state.lastRow === "child-3-c" && !state.showLatest ? state : null;
    },
    "the newest delegate page after showing latest",
    30_000,
  );
  assert.equal(latestState.uniqueRows, latestState.rows, "the rejoined newest page repeats no row");
  assert.equal(latestState.focusVisible, true, "the focused target survives the newest-page sync");
  assert.equal(latestState.omittedMarker, true, "the omission between the island and the newest pages is still stated");
  const latestReads = readsFor(
    latestFrom,
    (event) => event.summary?.historyScope?.kind === "delegation",
  ).map((event) => ({
    seq: event.seq,
    id: event.params?.historyScope?.id,
    messageBefore: event.params?.messageBefore ?? null,
    messageLimit: event.params?.messageLimit,
    returnedRows: event.summary?.returnedRows,
    hasMoreBefore: event.summary?.hasMoreBefore,
  }));
  assert(latestReads.every((read) => read.id === DELEGATION), "every newest-page read stays inside the chain");
  result.phases.searchLatest = { after: latestState, reads: latestReads };
  await desktop.screenshot("03b-search-latest.png");

  // ------------------------------------------------- rest: stop desktop cleanly
  const consoleErrorsBeforeSettlement = desktop.consoleErrors.slice();
  const exceptionsBeforeSettlement = desktop.exceptions.slice();
  result.evidence.consoleErrorsBeforeSettlement = consoleErrorsBeforeSettlement;
  result.evidence.exceptionsBeforeSettlement = exceptionsBeforeSettlement;
  await desktop.screenshot("04-before-settlement.png");
  await stopDesktop();

  // --------------------------------- 10. append settlement through host RPC
  host = new Host(REAL_HOST, dataDir);
  await host.start();
  const beforeSettle = await host.call("session.get", { id: SESSION_A });
  const recovery = await import("../packages/agent-runtime/dist/delegation-recovery.js");
  const recoveredBefore = recovery.buildRecoveredDelegations(beforeSettle.session.messages);
  const interrupted = recoveredBefore.find((entry) => entry.delegationId === "delegation-3");
  assert(interrupted, "the running launch row is catalogued before settlement");
  assert.equal(interrupted.status, "interrupted", "an unsettled run is not phantom running");
  assert.equal(interrupted.statusSource, "task-row");
  assert.equal(
    recoveredBefore.find((entry) => entry.delegationId === WAIT_DELEGATION)?.report,
    TASKWAIT_REPORT,
    "the TaskWait batch text is recovered verbatim from the real host answer",
  );
  assert.equal(
    recoveredBefore.find((entry) => entry.delegationId === WAIT_DELEGATION)?.reportSource,
    "taskwait-result",
  );

  const launchRow = beforeSettle.session.messages.find((row) => row.id === TASK_3);
  assert(launchRow, "the launch Task row is in the real transcript answer");
  const checkpoint = {
    version: 1,
    delegateSessionId: SESSION_A,
    delegationId: "delegation-3",
    sourceToolCallId: CALL_3,
    agentName: "explorer",
    generation: 1,
    throughRowId: "child-3-b",
    summary: "Handoff checkpoint summary recorded for the resumed segment.",
    originalTask: "Trace why the session cache misses after a restart.",
    directives: [{ text: "continue with the cache trace" }],
    installedAt: isoAt(50),
  };
  const settledRow = {
    ...launchRow,
    toolStatus: "success",
    toolCompletedAt: isoAt(60),
    toolResult: {
      ...launchRow.toolResult,
      details: {
        ...launchRow.toolResult.details,
        status: "completed",
        completedAt: 43_000,
        result: FINAL_REPORT,
        turns: 2,
        toolCalls: 3,
        contextTokens: 2048,
        handoffCheckpoint: checkpoint,
      },
    },
  };
  await host.call("session.appendMessage", { sessionId: SESSION_A, message: settledRow });
  const transcriptAfter = readFileSync(transcriptPath);
  assert(existsSync(sidecarPath), "the settlement writes the sidecar next to the transcript");
  const sidecars = transcriptFiles(dataDir).filter((path) => path.endsWith(".snapshots.jsonl"));
  assert.equal(sidecars.length, 1, `one snapshot sidecar exists (${sidecars.length})`);
  assert.equal(sidecars[0], sidecarPath, "the one sidecar belongs to the delegate-heavy session");
  const sidecarLines = readFileSync(sidecarPath, "utf8").split("\\n").filter(Boolean);
  assert.equal(sidecarLines.length, 1, "the settlement appends one accepted snapshot");
  const sidecarLine = JSON.parse(sidecarLines[0]);
  assert.equal(sidecarLine.schema, 1);
  assert.equal(sidecarLine.sessionId, SESSION_A);
  assert.equal(sidecarLine.callId, CALL_3, "the snapshot is keyed by the resumed call");
  assert.equal(sidecarLine.delegationId, "delegation-3");
  const sidecarBlock = sidecarLine.message.blocks.find((block) => block.type === "tool_call");
  assert(sidecarBlock, "the stored snapshot keeps the Task tool_call block");
  assert.equal(sidecarBlock.args.resume, WAIT_DELEGATION, "the launch args stay the row's authority");
  assert.equal(sidecarBlock.result.details.status, "completed");
  assert.equal(sidecarBlock.result.details.handoffCheckpoint.generation, 1);
  assert.equal(sidecarBlock.result.details.handoffCheckpoint.throughRowId, "child-3-b");
  const afterSettle = await host.call("session.get", { id: SESSION_A });
  const settledTask = afterSettle.session.messages.find((row) => row.id === TASK_3);
  assert.equal(settledTask.toolResult.details.status, "completed", "full re-read returns the settled Task");
  assert.equal(settledTask.toolResult.details.result, FINAL_REPORT, "the full report is verbatim");
  assert.equal(settledTask.toolResult.details.handoffCheckpoint.generation, 1);
  const recoveredAfter = recovery.buildRecoveredDelegations(afterSettle.session.messages);
  const settled = recoveredAfter.find((entry) => entry.delegationId === "delegation-3");
  assert.equal(settled.status, "completed");
  assert.equal(settled.report, FINAL_REPORT, "restart report falls back to the delegate's final row");
  assert.equal(settled.reportSource, "delegate-message");
  assert.equal(settled.handoffCheckpoint?.generation, 1);
  await host.stop();
  host = null;
  result.phases.settlement = {
    transcript: {
      beforeSha256: result.evidence.transcriptBefore.sha256,
      afterSha256: sha256(transcriptAfter),
      bytes: transcriptAfter.length,
      prefixEqual: true,
    },
    sidecar: {
      path: relative(tempRoot, sidecars[0]),
      lines: sidecarLines.length,
      schema: sidecarLine.schema,
      callId: sidecarLine.callId,
      delegationId: sidecarLine.delegationId,
      status: sidecarBlock.result.details.status,
      checkpointGeneration: sidecarBlock.result.details.handoffCheckpoint.generation,
    },
    recoveredBefore: recoveredBefore.map((entry) => ({
      delegationId: entry.delegationId,
      status: entry.status,
      statusSource: entry.statusSource,
      reportSource: entry.reportSource,
      reportMatches: entry.report === TASKWAIT_REPORT || entry.report === FINAL_REPORT,
    })),
    recoveredAfter: recoveredAfter.map((entry) => ({
      delegationId: entry.delegationId,
      status: entry.status,
      statusSource: entry.statusSource,
      reportSource: entry.reportSource,
      reportMatches: entry.report === TASKWAIT_REPORT || entry.report === FINAL_REPORT,
    })),
    settledTask: {
      status: settledTask.toolResult.details.status,
      resultLength: settledTask.toolResult.details.result.length,
      resultMatches: settledTask.toolResult.details.result === FINAL_REPORT,
      checkpointGeneration: settledTask.toolResult.details.handoffCheckpoint.generation,
    },
  };

  // ------------------------------------ 11. restart profile + host, read again
  // A restart may restore the last session on its own, so the main read can
  // arrive during boot, before any click. Mark the boot first and accept the
  // restore read and a click-triggered read alike.
  const restartBootFrom = mark();
  await launchDesktop();
  await until(
    () => desktop.evaluate(`Boolean(document.querySelector(${JSON.stringify(aRow)}))`),
    "sidebar after restart",
    60_000,
  );
  const autoRestored = await desktop.evaluate(
    `Boolean(document.querySelector('[data-scroll-owner="transcript"] [data-message-id="${TASK_3}"]'))`,
  );
  if (!autoRestored) {
    await desktop.evaluate(`document.querySelector(${JSON.stringify(aRow)}).click()`);
  }
  await until(
    () =>
      desktop.evaluate(
        `Boolean(document.querySelector('[data-scroll-owner="transcript"] [data-message-id="${TASK_3}"]'))`,
      ),
    "settled main transcript after restart",
    60_000,
  );
  const restartMainRead = await until(
    () =>
      readsFor(
        restartBootFrom,
        (event) =>
          event.summary?.id === SESSION_A && event.summary?.historyScope?.kind === "main",
      )[0],
    "the restart main read",
    30_000,
  );
  result.evidence.restartBootRestored = autoRestored;
  const restoredTask = restartMainRead.summary.taskRows.find((row) => row.id === TASK_3);
  assert.equal(restoredTask.status, "completed", "the current card reads the settled status after restart");
  assert.equal(restoredTask.checkpointGeneration, 1);
  const cardState = await desktop.evaluate(
    `(() => {
      const row = document.querySelector('[data-scroll-owner="transcript"] [data-message-id="${TASK_3}"]');
      return row ? { outcome: row.getAttribute('data-outcome'), text: row.textContent } : null;
    })()`,
  );
  assert.equal(cardState.outcome, "completed", "the rendered card outcome is settled");
  const fullRestart = await desktop.evaluate(
    `window.piDesktop.invoke(window.piDesktop.channels.invoke.sessionGet, ${JSON.stringify({ id: SESSION_A })})`,
  );
  assert.equal(fullRestart.ok, true);
  const restartTask = fullRestart.data.session.messages.find((row) => row.id === TASK_3);
  assert.equal(restartTask.toolResult.details.status, "completed");
  assert.equal(restartTask.toolResult.details.result, FINAL_REPORT);
  assert.equal(restartTask.toolResult.details.handoffCheckpoint.generation, 1);
  assert.equal(
    fullRestart.data.session.messages.some(
      (row) => row.id === TASK_3 && row.toolResult.details.status === "running",
    ),
    false,
    "no phantom running row survives",
  );
  const restartPanelFrom = mark();
  await desktop.evaluate(
    `document.querySelector('[data-message-id="${TASK_3}"] button.subagent-task-card').click()`,
  );
  await until(
    () => desktop.evaluate(`Boolean(document.querySelector('.subagent-transcript-tab'))`),
    "restarted delegation tab",
  );
  const restartPanelRead = await until(
    () =>
      readsFor(restartPanelFrom, (event) => event.summary?.historyScope?.kind === "delegation")[0],
    "the restarted panel read",
  );
  assert.equal(restartPanelRead.params.historyScope.id, "delegation-3", "the alias opens the same chain");
  assert.equal(restartPanelRead.summary.historyScope.id, DELEGATION, "the backend echoes the canonical chain");
  assert(
    restartPanelRead.summary.historyContextIds.includes(TASK_3),
    "the settled Task arrives as context",
  );
  const restartPanelTab = await tabState();
  assert.match(restartPanelTab.status, /Complet|Settled|Done/i);
  assert(!restartPanelTab.failed);
  result.phases.restart = {
    mainRead: compactEvent(restartMainRead),
    card: cardState,
    fullTask: {
      status: restartTask.toolResult.details.status,
      resultMatches: restartTask.toolResult.details.result === FINAL_REPORT,
      checkpointGeneration: restartTask.toolResult.details.handoffCheckpoint.generation,
      phantomRunning: false,
    },
    panelRead: compactEvent(restartPanelRead),
    panelTab: restartPanelTab,
  };
  result.evidence.consoleErrorsRestart = desktop.consoleErrors.slice();
  result.evidence.exceptionsRestart = desktop.exceptions.slice();
  await desktop.screenshot("05-restart-settled-card.png");
  await desktop.screenshot("06-restart-settled-panel.png");

  // -------------------------------------------------------------- evidence
  const { execFileSync } = await import("node:child_process");
  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const gitStatus = execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" });
  const gitDiff = execFileSync("git", ["diff", "--binary"], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  const untrackedFiles = execFileSync("git", ["ls-files", "-o", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    // The driver itself is not part of the product source being verified.
    .filter((file) => file !== "scripts/e2e-scoped-history-real-host.mjs")
    .sort();
  const untrackedHashes = untrackedFiles
    .map((file) => `${file} ${sha256(readFileSync(join(root, file)))}`)
    .join("\n");
  result.testedSource.head = gitHead;
  result.testedSource.worktreeStatusEntries = gitStatus.split("\n").filter(Boolean).length;
  result.testedSource.untrackedFiles = untrackedFiles.length;
  result.testedSource.worktreeStateSha256 = createHash("sha256")
    .update(gitDiff)
    .update(gitStatus)
    .digest("hex");
  // Full product-source fingerprint: tracked edits, status, and the contents
  // of every untracked file (new modules are untracked in this worktree).
  result.testedSource.sourceSha256 = createHash("sha256")
    .update(gitHead)
    .update(gitDiff)
    .update(gitStatus)
    .update(untrackedHashes)
    .digest("hex");
  result.testedSource.root = root;
  result.testedSource.appDir = appDir;
  const rendererHtml = readFileSync(join(appDir, "out/renderer/index.html"), "utf8");
  result.testedSource.rendererEntry =
    rendererHtml.match(/src="\.\/assets\/([^"]+\.js)"/)?.[1] ?? "";
  result.testedSource.rendererEntrySha256 = result.testedSource.rendererEntry
    ? sha256(readFileSync(join(appDir, "out/renderer/assets", result.testedSource.rendererEntry)))
    : "";
  result.checkedAt = new Date().toISOString();
  result.allReads = hostEvents(0)
    .filter((event) => event.method === "session.get")
    .map((event) => ({
      seq: event.seq,
      historyScope: event.params?.historyScope ?? null,
      messageBefore: event.params?.messageBefore ?? null,
      messageAround: event.params?.messageAround ?? null,
      messageLimit: event.params?.messageLimit ?? null,
      contentLimit: event.params?.contentLimit ?? null,
      returnedRows: event.summary?.returnedRows ?? null,
      childRows: event.summary?.childRows ?? null,
      hasMoreBefore: event.summary?.hasMoreBefore ?? null,
    }));
  assert.equal(
    desktop.consoleErrors.length + desktop.exceptions.length,
    0,
    `console errors/exceptions in the restarted renderer: ${JSON.stringify([
      ...desktop.consoleErrors,
      ...desktop.exceptions,
    ])}`,
  );
  assert.equal(
    consoleErrorsBeforeSettlement.length + exceptionsBeforeSettlement.length,
    0,
    `console errors/exceptions before settlement: ${JSON.stringify([
      ...consoleErrorsBeforeSettlement,
      ...exceptionsBeforeSettlement,
    ])}`,
  );
  const logCopy = join(artifactDir, "host-rpc.jsonl");
  writeFileSync(logCopy, readFileSync(proxy.logPath));
  writeFileSync(join(artifactDir, "scoped-history-real-host.json"), JSON.stringify(result, null, 2));
  const defects = result.defects ?? [];
  console.log(
    "SCOPED_HISTORY_REAL_HOST " +
      JSON.stringify({
        ok: defects.length === 0,
        phases: Object.keys(result.phases),
        defects: defects.map((defect) => defect.id),
        evidence: {
          head: result.testedSource.head,
          worktreeState: result.testedSource.worktreeStateSha256.slice(0, 16),
          sourceSha256: result.testedSource.sourceSha256.slice(0, 16),
          untrackedFiles: result.testedSource.untrackedFiles,
          statusEntries: result.testedSource.worktreeStatusEntries,
          host: result.testedSource.hostSha256.slice(0, 12),
          renderer: result.testedSource.rendererIndexSha256.slice(0, 12),
          rendererEntry: result.testedSource.rendererEntry,
          mainReads: result.allReads.filter((read) => read.historyScope?.kind === "main").length,
          delegationReads: result.allReads.filter((read) => read.historyScope?.kind === "delegation").length,
          sidecar: result.phases.settlement.sidecar,
          transcriptPrefixEqual: true,
        },
        artifacts: artifactDir,
      }),
  );
  if (defects.length > 0) process.exitCode = 1;
} catch (error) {
  result.failure = error?.stack ?? String(error);
  if (Array.isArray(error?.trace)) result.driverTrace = error.trace;
  try {
    if (desktop) {
      result.consoleErrors = desktop.consoleErrors;
      result.exceptions = desktop.exceptions;
      await desktop.screenshot("failure.png").catch(() => undefined);
    }
    if (existsSync(proxy.logPath)) {
      writeFileSync(join(artifactDir, "host-rpc-failure.jsonl"), readFileSync(proxy.logPath));
    }
    result.desktopOutput = desktopOutput.slice(-6_000);
    writeFileSync(join(artifactDir, "scoped-history-real-host-failure.json"), JSON.stringify(result, null, 2));
  } catch {
    // Failure evidence is best effort; the original error is authoritative.
  }
  console.error(`SCOPED_HISTORY_REAL_HOST ${JSON.stringify({ ok: false, failure: result.failure })}`);
  process.exitCode = 1;
} finally {
  await stopDesktop().catch(() => undefined);
  if (host) await host.stop().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}
