#!/usr/bin/env node
// Whole subagent lifecycle on the real backend path: real Rust host-core over
// its NDJSON RPC, the real agent sidecar process, and the real Electron Main
// IPC handlers. Only the provider transport (a local SSE server) and the launch
// binding are fixtures; no paid provider, no user app, no renderer.
//
// Decisive assertions (observable provider request counts + trigger points):
//  1. A session whose global subagent wakeup is `time:900` must NOT let a
//     stale per-call `TaskWait { timeoutSeconds:1, subagentWakeup:{time:1} }`
//     wake the parent before the child settles. Legacy per-call controls are
//     structurally ignored by the program coordinator. The bounded quiet
//     window below is a deadline observer, not a fixed sleep: the child stream
//     is held by the fixture and any early parent request fails immediately.
//     The exact-900s cadence guarantee is a unit/fake-timer concern; this E2E
//     proves only the bounded "no early wake" property.
//  2. An attached user steer enters only the child ledger; the child adopts it
//     in a later provider request and its report reaches the parent exactly
//     once, with no parent provider request while the child runs.
//  3. A delivered chain's direct user continuation runs detached: ZERO parent
//     provider requests, its own execution-turn accounting, and no detached
//     report in any parent context.
//  4. An explicit parent `Task(resume)` on the settled chain reattaches: the
//     resumed run's report is delivered back to the parent exactly once.
//  5. A stopped child settles `stopped` and delivers no report, yet its chain is
//     still continuable: an explicit direct continue starts a new run seeded
//     with the original task brief plus the new input (zero child rows), stays
//     `user`-owned with ZERO parent requests, and refuses a concurrent second
//     continue while the new run is still working.
//  6. A parent abort aborts its leftover child (`aborted`); a direct continue of
//     that aborted chain runs independently with no old-parent request or wake,
//     and a later explicit parent `Task(resume)` reattaches the chain as a new
//     parent-owned run whose report depends only on the new dependency.
//  7. An image-only steer of a live child and an image-only direct
//     continuation both travel Main handler -> real sidecar -> child provider
//     even though the child model's metadata declares text-only input; the
//     transcript keeps content-addressed refs, never the bytes, and a
//     continuation naming an ended turn is refused before any provider work.
//
// Requires a freshly built agent-runtime/sidecar dist that carries the program
// coordinator. A stale dist is detected from the emitted TaskWait tool schema
// and reported as BLOCKED (exit 4) instead of a false pass.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { IPC, PROTOCOL_VERSION } from "../packages/shared/dist/index.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));

// Rust's Windows known-folder lookup ignores HOME/USERPROFILE; refuse before a
// Host starts rather than risk touching real global agent documents.
if (process.platform === "win32") {
  throw new Error("Subagent lifecycle E2E requires Linux/macOS HOME isolation; no Host was started.");
}

class Blocked extends Error {}
const blocked = (message) => Object.assign(new Blocked(message), { __blocked: true });

const PHASE1_PROMPT = "PHASE1: run the no-early fixture.";
const PHASE2_PROMPT = "PHASE2: run the steer fixture.";
const PHASE4_PROMPT = "PHASE4: reattach the delivered chain.";
const PHASE5_PROMPT = "PHASE5: stop a child, then continue its chain explicitly.";
const PHASE6_PROMPT = "PHASE6: abort the parent, then continue the child independently.";
const PHASE6R_PROMPT = "PHASE6R: reattach the independently continued chain.";
const CONTINUE_PROMPT = "CONTINUE_FIXTURE: report the detached marker.";
const STEER_TEXT = "STEER_MARKER: adopt this steer before your final report.";
const REATTACH_TASK = "Reattach A fixture run.";
const STOP_TASK = "Delegate stop fixture.";
const STOP_CONTINUE_PROMPT = "CONTINUE_STOPPED: report after the child was stopped.";
const STOP_CONTINUE_BUSY_PROMPT = "CONTINUE_STOPPED_BUSY: must be refused.";
const PARENT_STOP_TASK = "Delegate parent-stop fixture.";
const PARENT_STOP_CONTINUE_PROMPT = "CONTINUE_PARENT_STOP: report after the parent was aborted.";
const REATTACH_STOP_TASK = "Reattach stop fixture run.";
const CHILD_A_REPORT = "Delegate A fixture report ALPHA.";
const CHILD_B_REPORT = "Delegate B fixture report BETA.";
const DETACHED_REPORT = "Detached continuation report GAMMA.";
const REATTACH_REPORT = "Reattach fixture report DELTA.";
const STOP_CONTINUE_REPORT = "Stopped-chain continuation report EPSILON.";
const PARENT_STOP_REPORT = "Independent continuation report ZETA.";
const REATTACH_STOP_REPORT = "Reattached stop-chain report ETA.";
const QUIET_WINDOW_MS = 2_500; // > stale timeoutSeconds:1, << the 900s program period
const IMAGE_STEER_TASK = "Delegate image steer fixture.";
const PHASE7_PROMPT = "PHASE7: steer a live child with an image, then continue its chain with an image.";
const IMAGE_STEER_REPORT = "Image steer fixture report KAPPA.";
const IMAGE_CONTINUE_REPORT = "Image continuation report LAMBDA.";
// A real 1x1 PNG: the bytes the handler inlines must be a decodable image.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=",
  "base64",
);
const PNG_BASE64 = PNG.toString("base64");
const CHILD_IMAGE_ATTACHMENT = { path: "child-steer.png", name: "child-steer.png", kind: "image", mimeType: "image/png" };

const root = mkdtempSync(join(tmpdir(), "pi-subagent-lifecycle-"));
const dataDir = join(root, "data");
const homeDir = join(root, "home");
const projectPath = join(root, "project");
for (const path of [dataDir, homeDir, projectPath]) mkdirSync(path);
writeFileSync(join(projectPath, "child-steer.png"), PNG);
const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PI_DESKTOP_DATA_DIR: dataDir,
  HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost" };

const requests = [];
const parentRequests = [];
const childRequests = [];
const parentObservers = new Set();
const events = [];
const handlers = new Map();
const pending = new Map();
const activeTurns = new Map();
const held = new Map(); // label -> { res, sse }
const finishedTurns = [];
let child, lines, bridge, provider, sessionId;
let eventWork = Promise.resolve();
let stderr = "";
let eventError;
let delegationA;
let delegationB;
let delegationS;
let delegationP;
let turnIdA;
let turnIdB;
let turnIdS;
let turnIdP;
let continuedStopped;
let continuedParentStop;
let delegationI;
let continuedImage;
let stepped = {};

const changed = () => { for (const check of [...parentObservers]) check(); };

function until(predicate, label, timeoutMs = 20_000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => { clearTimeout(timer); parentObservers.delete(check); error ? reject(error) : resolve(); };
    const check = () => {
      if (eventError) finish(eventError);
      else if (predicate()) finish();
    };
    const timer = setTimeout(() => finish(new Error(`${label}\n${stderr.slice(-2000)}\nlast parent request: ${JSON.stringify(parentRequests.at(-1)?.messages ?? []).slice(-1500)}`)), timeoutMs);
    parentObservers.add(check);
    check();
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Event-driven bounded observer: resolves after `ms` only when the parent has
 * issued no new provider request over the window; rejects the instant one
 * appears. No fixed sleep and no polling on the failure path.
 */
function observeNoParentRequest(ms, label) {
  const baseline = parentRequests.length;
  return new Promise((resolve, reject) => {
    const finish = (error) => { clearTimeout(timer); parentObservers.delete(check); error ? reject(error) : resolve(); };
    const check = () => {
      if (eventError) finish(eventError);
      else if (parentRequests.length !== baseline) {
        finish(new Error(`${label}: parent issued ${parentRequests.length - baseline} provider request(s) before the held child settled\n${stderr.slice(-1500)}`));
      }
    };
    const timer = setTimeout(() => finish(), ms);
    parentObservers.add(check);
  });
}

function send(message) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); }
function rpc(method, params) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}\n${stderr.slice(-2000)}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
const invoke = (channel, args) => {
  const handler = handlers.get(channel);
  assert.equal(typeof handler, "function", `Missing production Main handler: ${channel}`);
  return handler(...args);
};

function sse(res, payloadModel) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = () => ({ id: randomUUID(), object: "chat.completion.chunk", created: 1, model: payloadModel });
  return {
    res,
    delta: (delta, finish = null) => res.write(`data: ${JSON.stringify({ ...base(), choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`),
    finish: (delta, reason = "stop") => {
      res.write(`data: ${JSON.stringify({ ...base(), choices: [{ index: 0, delta, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    },
    hold: () => res.write(": fixture child stream held\n\n"),
  };
}
function toolCalls(stream, calls) {
  stream.finish({ role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, "tool_calls");
}
function say(stream, content) { stream.finish({ role: "assistant", content }, "stop"); }

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  return content == null ? "" : JSON.stringify(content);
}
const allUserText = (payload) => payload.messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
const lastUserText = (payload) => {
  const users = payload.messages.filter((m) => m.role === "user");
  return users.length ? textOf(users.at(-1).content) : "";
};
const hasToolResult = (payload, id) => payload.messages.some((m) => m.role === "tool" && m.tool_call_id === id);
function toolResultText(payload, id) {
  const message = payload.messages.find((m) => m.role === "tool" && m.tool_call_id === id);
  return message ? textOf(message.content) : "";
}
function extractDelegationId(payload) {
  for (const message of [...payload.messages].reverse()) {
    if (message.role !== "tool") continue;
    const match = textOf(message.content).match(/Delegation ([A-Za-z0-9_-]{6,}) started/);
    if (match) return match[1];
  }
  return undefined;
}
function assertRoleSequence(payload) {
  const messages = payload.messages;
  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1].role;
    const role = messages[i].role;
    if (role === "assistant" && prev === "assistant") throw new Error(`invalid provider role sequence: consecutive assistant messages (${payload.model})`);
    if (role === "system") throw new Error(`invalid provider role sequence: system message after index 0 (${payload.model})`);
    // Consecutive user turns are intentionally allowed: a resumed run seeds the
    // chain's brief and then appends this turn's task, and a chain stopped
    // before its first child message seeds that brief alone, so two user turns
    // in a row is the expected shape for those continuations.
  }
}

/** Deliveries of a report = requests whose newest message is that report's tool result. */
function countReportDeliveries(report) {
  return parentRequests.filter((request) => {
    const last = request.messages.at(-1);
    return last?.role === "tool" && textOf(last.content).includes(report);
  }).length;
}
/**
 * Image parts in the child's newest user message. The child's own inputs are
 * the only user turns this fixture can see, so this is the request-side half of
 * the image assertion.
 */
function lastUserImages(payload) {
  const users = payload.messages.filter((message) => message.role === "user");
  const last = users.at(-1);
  if (!last || !Array.isArray(last.content)) return [];
  return last.content.filter((part) => part?.type === "image_url");
}
const childImages = () => childRequests.filter((request) => lastUserImages(request).length > 0);

function respondParent(payload, stream) {
  parentRequests.push(payload);
  const text = lastUserText(payload);
  if (text.includes("PHASE1")) {
    if (!hasToolResult(payload, "task_a")) {
      return toolCalls(stream, [{ id: "task_a", name: "Task", args: { agent: "explorer", task: "Delegate A fixture" } }]);
    }
    if (!hasToolResult(payload, "wait_a")) {
      delegationA = extractDelegationId(payload);
      assert.ok(delegationA, "parent must observe the Task delegation id before waiting");
      // Deliberately stale legacy controls: the program coordinator must ignore them.
      return toolCalls(stream, [{ id: "wait_a", name: "TaskWait", args: { delegationIds: [delegationA], timeoutSeconds: 1, subagentWakeup: { kind: "time", value: 1 } } }]);
    }
    stepped.phase1WaitResult = toolResultText(payload, "wait_a");
    if (stepped.phase1WaitResult.includes(CHILD_A_REPORT)) { stepped.phase1Parent = "PARENT_RECEIVED_CHILD_REPORT"; return say(stream, "PARENT_RECEIVED_CHILD_REPORT"); }
    stepped.phase1Parent = "PARENT_EARLY_WAKE";
    return say(stream, "PARENT_EARLY_WAKE");
  }
  if (text.includes("PHASE4")) {
    if (!hasToolResult(payload, "task_c")) {
      return toolCalls(stream, [{ id: "task_c", name: "Task", args: { agent: "explorer", task: REATTACH_TASK, resume: delegationA } }]);
    }
    if (!hasToolResult(payload, "wait_c")) {
      const resumed = extractDelegationId(payload);
      assert.ok(resumed, "parent must observe the resumed delegation id before waiting");
      return toolCalls(stream, [{ id: "wait_c", name: "TaskWait", args: { delegationIds: [resumed] } }]);
    }
    stepped.phase4WaitResult = toolResultText(payload, "wait_c");
    if (stepped.phase4WaitResult.includes(REATTACH_REPORT)) { stepped.phase4Parent = "PARENT_RECEIVED_REATTACH_REPORT"; return say(stream, "PARENT_RECEIVED_REATTACH_REPORT"); }
    stepped.phase4Parent = "PARENT_UNEXPECTED";
    return say(stream, "PARENT_UNEXPECTED");
  }
  if (text.includes("PHASE2")) {
    if (!hasToolResult(payload, "task_b")) {
      return toolCalls(stream, [{ id: "task_b", name: "Task", args: { agent: "explorer", task: "Delegate B fixture" } }]);
    }
    if (!hasToolResult(payload, "wait_b")) {
      delegationB = extractDelegationId(payload);
      assert.ok(delegationB, "parent must observe the Task delegation id before waiting");
      return toolCalls(stream, [{ id: "wait_b", name: "TaskWait", args: { delegationIds: [delegationB] } }]);
    }
    stepped.phase2WaitResult = toolResultText(payload, "wait_b");
    if (stepped.phase2WaitResult.includes(CHILD_B_REPORT)) { stepped.phase2Parent = "PARENT_RECEIVED_STEER_REPORT"; return say(stream, "PARENT_RECEIVED_STEER_REPORT"); }
    stepped.phase2Parent = "PARENT_UNEXPECTED";
    return say(stream, "PARENT_UNEXPECTED");
  }
  if (text.includes("PHASE5")) {
    if (!hasToolResult(payload, "task_s5")) {
      return toolCalls(stream, [{ id: "task_s5", name: "Task", args: { agent: "explorer", task: STOP_TASK } }]);
    }
    if (!hasToolResult(payload, "wait_s5")) {
      delegationS = extractDelegationId(payload);
      assert.ok(delegationS, "phase 5 parent must observe the stop fixture delegation id before waiting");
      return toolCalls(stream, [{ id: "wait_s5", name: "TaskWait", args: { delegationIds: [delegationS] } }]);
    }
    stepped.phase5WaitResult = toolResultText(payload, "wait_s5");
    stepped.phase5Parent = stepped.phase5WaitResult.toLowerCase().includes("stopped")
      ? "PARENT_SAW_STOPPED"
      : "PARENT_UNEXPECTED";
    return say(stream, stepped.phase5Parent);
  }
  if (text.includes("PHASE6R")) {
    if (!hasToolResult(payload, "task_s6r")) {
      return toolCalls(stream, [{ id: "task_s6r", name: "Task", args: { agent: "explorer", task: REATTACH_STOP_TASK, resume: delegationP } }]);
    }
    if (!hasToolResult(payload, "wait_s6r")) {
      const resumed = extractDelegationId(payload);
      assert.ok(resumed, "phase 6R parent must observe the resumed delegation id before waiting");
      return toolCalls(stream, [{ id: "wait_s6r", name: "TaskWait", args: { delegationIds: [resumed] } }]);
    }
    stepped.phase6rWaitResult = toolResultText(payload, "wait_s6r");
    stepped.phase6rParent = stepped.phase6rWaitResult.includes(REATTACH_STOP_REPORT)
      ? "PARENT_RECEIVED_REATTACH_STOP_REPORT"
      : "PARENT_UNEXPECTED";
    return say(stream, stepped.phase6rParent);
  }
  if (text.includes("PHASE6")) {
    if (!hasToolResult(payload, "task_s6")) {
      return toolCalls(stream, [{ id: "task_s6", name: "Task", args: { agent: "explorer", task: PARENT_STOP_TASK } }]);
    }
    delegationP = extractDelegationId(payload);
    assert.ok(delegationP, "phase 6 parent must observe the parent-stop fixture delegation id");
    stepped.phase6ParentIdle = true;
    // End the parent tool loop without TaskWait: parent idle keeps the durable
    // turn open while the child runs, so a later parent abort owns both.
    return say(stream, "PHASE6_PARENT_IDLE");
  }
  if (text.includes("PHASE7")) {
    if (!hasToolResult(payload, "task_i7")) {
      return toolCalls(stream, [{ id: "task_i7", name: "Task", args: { agent: "explorer", task: IMAGE_STEER_TASK } }]);
    }
    if (!hasToolResult(payload, "wait_i7")) {
      delegationI = extractDelegationId(payload);
      assert.ok(delegationI, "phase 7 parent must observe the image steer delegation id before waiting");
      return toolCalls(stream, [{ id: "wait_i7", name: "TaskWait", args: { delegationIds: [delegationI] } }]);
    }
    stepped.phase7WaitResult = toolResultText(payload, "wait_i7");
    stepped.phase7Parent = stepped.phase7WaitResult.includes(IMAGE_STEER_REPORT)
      ? "PARENT_RECEIVED_IMAGE_STEER_REPORT"
      : "PARENT_UNEXPECTED";
    return say(stream, stepped.phase7Parent);
  }
  throw new Error(`unexpected parent request: ${text.slice(-200)}`);
}

function respondChild(payload, stream) {
  childRequests.push(payload);
  // Branch on the child's LATEST user message: a resumed chain replays earlier
  // tasks/continuations, so history text is ambiguous by design.
  const text = lastUserText(payload);
  // An image-only child input: the request body itself is the evidence that the
  // Main handler's prepared bytes reached this provider. The held stream marks
  // the live steer; otherwise this is the detached image continuation.
  if (lastUserImages(payload).length) {
    if (held.has("I")) { held.delete("I"); return say(stream, IMAGE_STEER_REPORT); }
    return say(stream, IMAGE_CONTINUE_REPORT);
  }
  if (text.includes("STEER_MARKER")) { stepped.childAdoptedSteer = true; return say(stream, CHILD_B_REPORT); }
  if (text.includes("Reattach A fixture")) return say(stream, REATTACH_REPORT);
  if (text.includes("Reattach stop fixture")) return say(stream, REATTACH_STOP_REPORT);
  if (text.includes("CONTINUE_FIXTURE")) return say(stream, DETACHED_REPORT);
  // A second continue while the chain runs is refused upstream, so its text
  // must never reach a provider; failing loudly keeps that assertion honest.
  if (text.includes("CONTINUE_STOPPED_BUSY")) throw new Error("a refused concurrent continue reached the provider");
  if (text.includes("CONTINUE_STOPPED")) { held.set("S2", { res: stream.res, stream }); return stream.hold(); }
  if (text.includes("CONTINUE_PARENT_STOP")) return say(stream, PARENT_STOP_REPORT);
  if (text.includes("Delegate B fixture")) { held.set("B", { res: stream.res, stream }); return stream.hold(); }
  if (text.includes("Delegate A fixture")) { held.set("A", { res: stream.res, stream }); return stream.hold(); }
  if (text.includes("Delegate image steer fixture")) { held.set("I", { res: stream.res, stream }); return stream.hold(); }
  if (text.includes("Delegate parent-stop fixture")) {
    held.set("P", { res: stream.res, stream });
    // The parent abort cancels this child's in-flight request; the release of
    // the held stream is the deterministic sync point for the continue below.
    stream.res.on("close", () => { if (held.get("P")?.res === stream.res) { held.delete("P"); changed(); } });
    return stream.hold();
  }
  if (text.includes("Delegate stop fixture")) { held.set("S", { res: stream.res, stream }); return stream.hold(); }
  throw new Error(`unexpected child request: ${text.slice(-200)}`);
}

async function respondModel(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  requests.push(payload);
  assertRoleSequence(payload);
  const stream = sse(res, payload.model);
  if (payload.model === "delegate-fixture") respondChild(payload, stream);
  else respondParent(payload, stream);
  changed();
}

const modelServer = createServer((req, res) => {
  void respondModel(req, res).catch((error) => { eventError = error; res.destroy(); changed(); });
});

let coordination;
async function finishTurn(id, reason, _errorCode, options = {}) {
  const turnId = options.turnId ?? activeTurns.get(id);
  if (!turnId || activeTurns.get(id) !== turnId) return;
  await host.call("session.endTurn", { turnId, status: reason, createNotification: false });
  activeTurns.delete(id);
  finishedTurns.push({ sessionId: id, turnId, reason });
  bridge?.agentHost.endTurn(id, turnId, reason === "aborted" ? "interrupted" : reason === "error" ? "failed" : "completed");
  changed();
}
async function ingest(envelope) {
  events.push(envelope);
  if (envelope.event.type === "message_end" && envelope.event.message.role === "user" && envelope.event.message.steering) {
    await host.call("session.appendMessage", { sessionId: envelope.sessionId, turnId: envelope.turnId, message: envelope.event.message });
  }
  if (!envelope.parentToolCallId && envelope.event.type === "agent_end") {
    await finishTurn(envelope.sessionId, "completed", undefined, { turnId: envelope.turnId });
  } else {
    bridge?.ingest(envelope);
  }
  changed();
}

// A fixture must never hang the suite: bound the whole run and clean up.
const watchdog = setTimeout(() => {
  console.error(`TIMEOUT subagent lifecycle after watchdog; step=${JSON.stringify(stepped)}`);
  process.exit(4);
}, 150_000);

const hostBinary = (() => {
  try { return resolveHostBinary(); } catch { return undefined; }
})();
let host;
let createAgentHostBridge;
let registerAgentIpc;
let createSessionCoordination;
let exitCode = 0;
try {
  if (!hostBinary) throw blocked("host-core binary missing; build crates/host-core (or set PI_DESKTOP_HOST_BIN) before running this lifecycle E2E.");
  try {
    ({ createAgentHostBridge } = await import("../apps/desktop/electron/main/agent-host-bridge.ts"));
    ({ registerAgentIpc } = await import("../apps/desktop/electron/main/ipc/agent-ipc.ts"));
    ({ createSessionCoordination } = await import("../apps/desktop/electron/main/runtime/session-coordination.ts"));
  } catch (error) {
    throw blocked(`backend dist is missing or internally inconsistent, so the Main/runtime modules cannot load; rebuild the workspace before running this lifecycle E2E: ${error?.message ?? error}`);
  }
  host = new Host(hostBinary, dataDir, { env });
  await host.start(PROTOCOL_VERSION);
  coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  provider = { id: "fixture", name: "Fixture", modelId: "fixture", baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
    apiKey: "", authKind: "none", apiStyle: "openai-chat", supportsReasoning: false, supportedThinkingLevels: ["off"] };

  child = spawn(process.execPath, [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8000); });
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "host.proxy") {
      void host.call(message.params.method, message.params.params).then(
        (result) => send({ id: message.id, result }),
        (error) => send({ id: message.id, error: { code: -32000, message: error.message, data: { errorCode: error.errorCode } } }),
      );
    } else if (message.id != null) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    } else if (message.method === "agent.event") {
      eventWork = eventWork.then(() => ingest(message.params)).catch((error) => { eventError = error; changed(); });
    }
  });

  const sidecar = { call: rpc, setProjectInstructionRoot() {}, clearProjectInstructionRoot() {}, clearVendorAuthBindings() {} };
  const childExecutionTurns = new Set();
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, getSidecar: () => sidecar, getAgentHostBridge: () => bridge,
    logger: { app() {} }, dataDir, activeTurns, childExecutionTurns, activeTurnUsages: new Map(),
    vendorOAuth: { async resolveAuth() { throw new Error("Fixture does not use OAuth"); } },
    agentExtensions: { cancelPrompts() {} }, cancelSessionTools() {}, persistenceOutbox: { async flush() {} },
    approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    acquireSessionOperation: coordination.acquireSessionOperation, isTurnDispatchable: coordination.isTurnDispatchable,
    lockAbortReason: coordination.lockAbortReason, finishTurn,
    async resolveAgentRuntimeLaunch(id) {
      return { providerId: provider.id, modelId: provider.modelId, projectPath,
        sidecarParams: { sessionId: id, mode: "agent", provider, projectPath, thinkingLevel: "off",
          // Global program wakeup: the exclusive timing owner for this session.
          subagentWakeup: { kind: "time", value: 900 },
          commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
          // The child model's catalog metadata declares text-only input, the way
          // a gateway mislabels a vision upstream: the handler's prepared image
          // must reach this provider's request anyway.
          subagentProviders: { "fixture/delegate-fixture": { ...provider, modelId: "delegate-fixture",
            modelConfig: {
              source: "generic",
              name: "Delegate Fixture (text-only metadata)",
              baseUrl: provider.baseUrl,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8_192,
            } } },
          subagents: ["explorer"].map((name) => ({ name, description: "Local fixture delegate", tools: ["Read"],
            prompt: "Answer the fixture task.", source: "builtin", model: { providerId: "fixture", modelId: "delegate-fixture" } })) } };
    },
    emitAgentEvent: (envelope) => bridge?.ingest(envelope), setNotificationViewingSessionId() {},
    async optionalWorkspaceRoot() { return projectPath; },
    composerCommandService: { async buildComposerCommands() { return []; } }, async loadComposerTemplatesCached() { return []; },
    async finishApprovedExecution() {}, async dispatchApprovedPlan() {}, async dispatchExecutionForProposal() {},
  });
  bridge = createAgentHostBridge({ channels: IPC.invoke, getHost: () => host, invoke,
    isSessionBusy: coordination.isSessionBusy, log() {}, onQueueChange: () => {} });
  await bridge.agentHost.start();

  sessionId = (await host.call("session.create", { title: "Subagent lifecycle fixture", mode: "agent", projectPath })).session.id;
  await host.call("session.configure", { id: sessionId, mode: "agent", permissionMode: "auto" });

  // ---- Phase 1: no early wake under stale per-call controls ---------------
  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: PHASE1_PROMPT }]);
  await until(() => activeTurns.has(sessionId), "phase 1 turn did not become active");
  turnIdA = activeTurns.get(sessionId);
  await until(() => held.has("A"), "child A stream was not held by the fixture");
  await until(() => parentRequests.length >= 2, "parent TaskWait request did not reach the provider");

  const waitTool = parentRequests[1].tools?.find((tool) => tool.function?.name === "TaskWait");
  assert.ok(waitTool, "the parent TaskWait request must advertise the TaskWait tool schema");
  const waitProps = waitTool.function?.parameters?.properties ?? {};
  if ("timeoutSeconds" in waitProps || "subagentWakeup" in waitProps) {
    throw blocked("agent-runtime dist predates the program coordinator: the emitted TaskWait schema still declares per-call timeoutSeconds/subagentWakeup. Rebuild packages/agent-runtime (and its dependents) before running this lifecycle E2E.");
  }

  await observeNoParentRequest(QUIET_WINDOW_MS, "no-early wake");
  stepped.quietWindowParentRequests = parentRequests.length;
  assert.equal(parentRequests.length, 2, "parent must stay at two requests while the child is held");

  held.get("A").stream.finish({ role: "assistant", content: CHILD_A_REPORT }, "stop");
  await until(() => parentRequests.length >= 3, "parent did not receive the child report after the child settled");
  await eventWork;
  assert.equal(stepped.phase1WaitResult?.includes(CHILD_A_REPORT), true, `TaskWait must return with the report, not a timeout: ${stepped.phase1WaitResult}`);
  assert.equal(stepped.phase1Parent, "PARENT_RECEIVED_CHILD_REPORT", "parent must process the child report");
  const phase1ReportCount = countReportDeliveries(CHILD_A_REPORT);
  assert.equal(phase1ReportCount, 1, "the child report must be delivered to the parent exactly once");
  assert.ok(parentRequests.length >= 3, "the parent must synthesize after the report");
  stepped.phase1ParentRequests = parentRequests.length;
  await until(() => !activeTurns.has(sessionId), "phase 1 parent turn did not settle");

  // ---- Phase 2: attached steer -> child adopts -> report once -------------
  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: PHASE2_PROMPT }]);
  await until(() => parentRequests.length >= 4, "phase 2 parent Task request did not reach the provider");
  await until(() => activeTurns.has(sessionId), "phase 2 turn did not become active");
  turnIdB = activeTurns.get(sessionId);
  await until(() => held.has("B"), "child B stream was not held by the fixture");
  await until(() => parentRequests.length >= 5, "phase 2 parent TaskWait request did not reach the provider");
  const beforeSteer = parentRequests.length;
  await invoke(IPC.invoke.agentSteerSubagent, [{ sessionId, delegationId: delegationB, expectedTurnId: turnIdB, content: STEER_TEXT }]);
  await delay(0);
  assert.equal(parentRequests.length, beforeSteer, "a child steer must not issue a parent provider request");

  held.get("B").stream.finish({ role: "assistant", content: "Interim acknowledgement." }, "stop");
  await until(() => childRequests.some((request) => allUserText(request).includes("STEER_MARKER")), "child did not adopt the steer into a provider request");
  await until(() => parentRequests.length >= 6, "parent did not receive the steered child report");
  await eventWork;
  assert.equal(stepped.childAdoptedSteer, true, "child must carry the steer before its final report");
  assert.equal(stepped.phase2Parent, "PARENT_RECEIVED_STEER_REPORT", "parent must process the steered child report");
  const phase2ReportCount = countReportDeliveries(CHILD_B_REPORT);
  assert.equal(phase2ReportCount, 1, "the steered child report must be delivered exactly once");
  const steerEcho = events.find((envelope) => envelope.parentToolCallId && envelope.event.type === "message_end" && envelope.event.message.role === "user" && textOf(envelope.event.message.content).includes(STEER_TEXT));
  assert.ok(steerEcho, "the steer echo must be attributed to the child transcript, never the parent context");
  stepped.phase2ParentRequests = parentRequests.length;
  await until(() => !activeTurns.has(sessionId), "phase 2 parent turn did not settle");

  // ---- Phase 3: delivered chain, detached user continuation ---------------
  const parentBeforeContinue = parentRequests.length;
  const continued = await invoke(IPC.invoke.agentContinueSubagent, [{ sessionId, delegationId: delegationA, content: CONTINUE_PROMPT }]);
  assert.equal(continued.delivery, "user", "a delivered chain must continue detached");
  assert.ok(continued.turnId, "the detached continuation must own an execution turn");
  assert.notEqual(continued.turnId, turnIdA, "detached execution turn must not reuse the parent turn");
  assert.notEqual(continued.turnId, turnIdB, "detached execution turn must not reuse another parent turn");
  await until(() => childRequests.some((request) => allUserText(request).includes("CONTINUE_FIXTURE")), "detached continuation did not start a child run");
  await until(() => !activeTurns.has(sessionId), "detached execution turn did not settle");
  await eventWork;
  assert.equal(parentRequests.length, parentBeforeContinue, "a detached continuation must issue ZERO parent provider requests");
  assert.ok(finishedTurns.some((turn) => turn.turnId === continued.turnId), "the detached execution turn must be opened and closed under its own id");
  assert.ok(finishedTurns.some((turn) => turn.turnId === turnIdA) && finishedTurns.some((turn) => turn.turnId === turnIdB), "parent turns must settle under their own ids, separate from the detached turn");
  assert.equal(parentRequests.some((request) => JSON.stringify(request.messages).includes(DETACHED_REPORT)), false, "the detached report must never enter the parent context");
  const detachedReport = events.find((envelope) => envelope.parentToolCallId && envelope.event.type === "message_end" && textOf(envelope.event.message.content).includes(DETACHED_REPORT));
  assert.ok(detachedReport, "the detached child report must be emitted on its own execution turn");
  assert.equal(detachedReport.turnId, continued.turnId, "the detached report must carry its own execution turn id");
  const detachedTerminal = events.find((envelope) => envelope.event.type === "agent_end" && envelope.turnId === continued.turnId);
  assert.ok(detachedTerminal, "the detached execution turn must end with its own terminal event");
  const marker = events.find((envelope) => envelope.event.type === "message_end" && envelope.event.message.role === "tool" && envelope.event.message.toolName === "Task" && envelope.event.message.toolArgs?.source === "user");
  assert.ok(marker, "the user continuation must persist a user-origin Task marker row");
  assert.equal(marker.event.message.toolArgs.resume, delegationA, "the user marker must resume the delivered chain");
  // The marker also names the run's OWN execution turn, which is the only
  // identity a reopened tab or a rebuilt renderer still has: the parent turn
  // ended before this continuation started.
  assert.equal(
    marker.event.message.toolResult?.details?.executionTurnId,
    continued.turnId,
    "the user marker must publish the detached run's execution turn",
  );
  assert.equal(
    marker.event.message.toolArgs.source,
    "user",
    "the user marker must state its delivery owner",
  );

  // ---- Phase 4: explicit parent Task(resume) reattaches the report --------
  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: PHASE4_PROMPT }]);
  await until(() => childRequests.some((request) => allUserText(request).includes("Reattach A fixture")), "parent Task(resume) did not start a resumed child run");
  await until(() => parentRequests.some((request) => textOf(request.messages.at(-1)?.content).includes(REATTACH_REPORT)), "parent did not receive the reattached report");
  await eventWork;
  assert.equal(stepped.phase4Parent, "PARENT_RECEIVED_REATTACH_REPORT", "an explicit parent resume must deliver the report back to the parent");
  assert.equal(countReportDeliveries(REATTACH_REPORT), 1, "the reattached report must be delivered exactly once");
  await until(() => !activeTurns.has(sessionId), "phase 4 parent turn did not settle");

  // ---- Phase 5: stopped child -> explicit continue ------------------------
  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: PHASE5_PROMPT }]);
  await until(() => activeTurns.has(sessionId), "phase 5 turn did not become active");
  turnIdS = activeTurns.get(sessionId);
  await until(() => held.has("S"), "child S stream was not held by the fixture");
  await until(() => delegationS, "phase 5 parent did not observe the stop fixture delegation id");
  const parentBeforeStop5 = parentRequests.length;
  await invoke(IPC.invoke.agentStopSubagents, [{ sessionId, delegationIds: [delegationS] }]);
  await until(() => parentRequests.length > parentBeforeStop5, "phase 5 parent did not resume after the child was stopped");
  await eventWork;
  assert.equal(stepped.phase5Parent, "PARENT_SAW_STOPPED", `TaskWait must return the stopped status, not a report: ${stepped.phase5WaitResult}`);
  assert.equal(stepped.phase5WaitResult?.includes(STOP_CONTINUE_REPORT), false, "a stopped run must not deliver a report");
  assert.equal(countReportDeliveries(STOP_CONTINUE_REPORT), 0, "no report exists for a stopped run");
  await until(() => !activeTurns.has(sessionId), "phase 5 parent turn did not settle");

  // The stopped chain is still continuable: an explicit direct continue starts
  // a new run seeded with the original task brief plus the new input, even
  // though the stopped-before-first-message run left zero child rows.
  const parentBeforeContinue5 = parentRequests.length;
  continuedStopped = await invoke(IPC.invoke.agentContinueSubagent, [{ sessionId, delegationId: delegationS, content: STOP_CONTINUE_PROMPT }]);
  assert.equal(continuedStopped.delivery, "user", "a stopped source must continue user-owned");
  assert.ok(continuedStopped.turnId, "the stopped-chain continuation must own an execution turn");
  assert.notEqual(continuedStopped.turnId, turnIdS, "the continuation must not reuse the stopped parent turn");
  await until(() => held.has("S2"), "the stopped-chain continuation child run did not start");
  // No concurrent chain: a second continue while the new run works is refused
  // and never reaches a provider request.
  const busyRejection = await invoke(IPC.invoke.agentContinueSubagent, [{ sessionId, delegationId: continuedStopped.delegationId, content: STOP_CONTINUE_BUSY_PROMPT }])
    .then(() => null, (error) => error);
  assert.ok(busyRejection, "a second continue while the chain runs must be refused");
  const busyText = `${busyRejection?.errorCode ?? ""} ${busyRejection?.message ?? busyRejection}`;
  assert.match(busyText, /BUSY|active turn/i, "the refusal must name the busy chain or session");
  held.get("S2").stream.finish({ role: "assistant", content: STOP_CONTINUE_REPORT }, "stop");
  await until(() => !activeTurns.has(sessionId), "the stopped-chain continuation did not settle");
  await eventWork;
  const stoppedContinueRequest = childRequests.find((request) => lastUserText(request).includes("CONTINUE_STOPPED"));
  assert.ok(stoppedContinueRequest, "the stopped-chain continuation must reach the fixture");
  assert.equal(allUserText(stoppedContinueRequest).includes(STOP_TASK), true, "the continuation must seed the original task brief despite zero child rows");
  assert.equal(childRequests.some((request) => allUserText(request).includes("CONTINUE_STOPPED_BUSY")), false, "a refused continue must not start a child run");
  assert.equal(parentRequests.length, parentBeforeContinue5, "continuing a stopped chain must issue ZERO parent provider requests");
  assert.equal(parentRequests.some((request) => JSON.stringify(request.messages).includes(STOP_CONTINUE_REPORT)), false, "a user-owned stopped-chain report must never enter the parent context");

  // ---- Phase 6: parent abort -> independent continue, no parent wake ------
  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: PHASE6_PROMPT }]);
  await until(() => activeTurns.has(sessionId), "phase 6 turn did not become active");
  turnIdP = activeTurns.get(sessionId);
  await until(() => held.has("P"), "child P stream was not held by the fixture");
  await until(() => delegationP, "phase 6 parent did not observe the parent-stop delegation id");
  await until(() => stepped.phase6ParentIdle === true, "phase 6 parent did not end its tool loop");
  const parentBeforeStop6 = parentRequests.length;
  await invoke(IPC.invoke.agentAbort, [{ sessionId, turnId: turnIdP }]);
  await until(() => !held.has("P"), "the aborted child stream was not released by the parent abort");
  await until(() => !activeTurns.has(sessionId), "the aborted parent turn did not settle");
  await eventWork;
  assert.equal(parentRequests.length, parentBeforeStop6, "aborting the parent must not issue a parent provider request");

  // The aborted chain is still continuable: a direct continue runs isolated
  // with no old-parent request or wake.
  continuedParentStop = await invoke(IPC.invoke.agentContinueSubagent, [{ sessionId, delegationId: delegationP, content: PARENT_STOP_CONTINUE_PROMPT }]);
  assert.equal(continuedParentStop.delivery, "user", "an aborted source must continue user-owned");
  assert.ok(continuedParentStop.turnId, "the independent continuation must own an execution turn");
  assert.notEqual(continuedParentStop.turnId, turnIdP, "the independent continuation must not reuse the aborted parent turn");
  await until(() => childRequests.some((request) => allUserText(request).includes("CONTINUE_PARENT_STOP")), "the independent continuation did not start a child run");
  await until(() => !activeTurns.has(sessionId), "the independent continuation did not settle");
  await eventWork;
  assert.equal(parentRequests.length, parentBeforeStop6, "the aborted parent must not be woken by the stop or the independent continuation");
  assert.equal(parentRequests.some((request) => JSON.stringify(request.messages).includes(PARENT_STOP_REPORT)), false, "an aborted chain's user-owned report must never enter the parent context");

  // An explicit parent Task(resume) reattaches the chain as a new parent-owned
  // run whose report depends only on the new dependency.
  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: PHASE6R_PROMPT }]);
  await until(() => childRequests.some((request) => allUserText(request).includes(REATTACH_STOP_TASK)), "phase 6R parent Task(resume) did not start a resumed child run");
  await until(() => parentRequests.some((request) => textOf(request.messages.at(-1)?.content).includes(REATTACH_STOP_REPORT)), "phase 6R parent did not receive the reattached report");
  await eventWork;
  assert.equal(stepped.phase6rParent, "PARENT_RECEIVED_REATTACH_STOP_REPORT", "an explicit parent resume must deliver the reattached stop-chain report");
  assert.equal(countReportDeliveries(REATTACH_STOP_REPORT), 1, "the reattached stop-chain report must be delivered exactly once");
  const reattachStopRequest = childRequests.find((request) => lastUserText(request).includes(REATTACH_STOP_TASK));
  assert.ok(reattachStopRequest, "the reattached run must reach the fixture");
  assert.equal(allUserText(reattachStopRequest).includes("CONTINUE_PARENT_STOP"), true, "the parent resume must reattach the independently continued chain");
  assert.equal(parentRequests.some((request) => JSON.stringify(request.messages).includes(PARENT_STOP_REPORT)), false, "the earlier user-owned report must never reach the parent after reattaching");
  await until(() => !activeTurns.has(sessionId), "phase 6R parent turn did not settle");
  // ---- Phase 7: Main handler -> sidecar -> child provider, images ----------
  // The launch fixture's child model declares text-only input metadata, the way
  // a gateway mislabels a vision upstream. This phase proves the production
  // handler's prepared bytes survive a real sidecar run and reach the child
  // provider's request anyway, while every transcript row keeps only its ref.
  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: PHASE7_PROMPT }]);
  await until(() => activeTurns.has(sessionId), "phase 7 turn did not become active");
  const turnIdI = activeTurns.get(sessionId);
  await until(() => held.has("I"), "image steer fixture child stream was not held");
  await until(() => delegationI, "phase 7 parent did not observe the image steer delegation id");
  const parentBeforeImageSteer = parentRequests.length;
  await invoke(IPC.invoke.agentSteerSubagent, [{
    sessionId, delegationId: delegationI, expectedTurnId: turnIdI, content: "",
    attachments: [CHILD_IMAGE_ATTACHMENT],
  }]);
  assert.equal(parentRequests.length, parentBeforeImageSteer, "an image-only steer must not issue a parent provider request");
  // Releasing the held stream is the deterministic point where the runtime
  // applies the queued steer and re-enters the provider with it.
  held.get("I").stream.finish({ role: "assistant", content: "Interim acknowledgement." }, "stop");
  await until(() => childImages().length >= 1, "the steered child did not adopt the image into a provider request");
  await until(() => stepped.phase7Parent === "PARENT_RECEIVED_IMAGE_STEER_REPORT", "parent did not receive the image steer report");
  await eventWork;
  const steeredImageRequest = childImages()[0];
  assert.equal(steeredImageRequest.model, "delegate-fixture", "the image must reach the delegate's own provider model");
  assert.equal(textOf(steeredImageRequest.messages.at(-1).content).trim(), "", "an image-only steer must reach the provider with no synthesized text");
  assert.equal(JSON.stringify(steeredImageRequest).includes(`data:image/png;base64,${PNG_BASE64}`), true, "the child provider request must carry the prepared image bytes");
  await until(() => !activeTurns.has(sessionId), "phase 7 parent turn did not settle");

  // A continuation naming a turn the session no longer owns is refused before
  // any provider work: ownership drift never becomes a silent new prompt.
  const requestsBeforeStaleContinue = requests.length;
  const staleContinue = await invoke(IPC.invoke.agentContinueSubagent, [{
    sessionId, delegationId: delegationS, content: "", expectedTurnId: turnIdS,
    attachments: [CHILD_IMAGE_ATTACHMENT],
  }]).then(() => null, (error) => error);
  assert.ok(staleContinue, "a continuation naming an ended turn must be refused");
  assert.equal(staleContinue.errorCode, "TURN_NOT_FOUND", `the refusal must name the ended turn: ${staleContinue.message}`);
  assert.equal(requests.length, requestsBeforeStaleContinue, "a refused continuation must not reach any provider");

  // Image-only direct continuation of the settled chain: the same full path,
  // detached, on a chain that no longer has a live parent turn.
  const parentBeforeImageContinue = parentRequests.length;
  continuedImage = await invoke(IPC.invoke.agentContinueSubagent, [{
    sessionId, delegationId: delegationS, content: "", attachments: [CHILD_IMAGE_ATTACHMENT],
  }]);
  assert.equal(continuedImage.delivery, "user", "an image-only continuation of a settled chain must run user-owned");
  assert.ok(continuedImage.turnId, "the image continuation must own an execution turn");
  assert.equal([turnIdA, turnIdB, turnIdS, turnIdP].includes(continuedImage.turnId), false, "the image continuation must not reuse a parent turn");
  await until(() => childImages().length >= 2, "the image continuation did not reach the child provider");
  await until(() => !activeTurns.has(sessionId), "the image continuation did not settle");
  await eventWork;
  const continuedImageRequest = childImages()[1];
  assert.equal(JSON.stringify(continuedImageRequest).includes(`data:image/png;base64,${PNG_BASE64}`), true, "the continuation request must carry the prepared image bytes");
  assert.equal(textOf(continuedImageRequest.messages.at(-1).content).trim(), "", "the image-only continuation must reach the provider with no synthesized text");
  assert.equal(parentRequests.length, parentBeforeImageContinue, "an image-only continuation must issue ZERO parent provider requests");
  assert.ok(finishedTurns.some((turn) => turn.turnId === continuedImage.turnId), "the image continuation must open and close its own execution turn");
  // The transcript keeps a content-addressed ref, never the bytes: both the
  // child row the handler echoes and the row the runtime persisted carry `ref`.
  const childImageRows = events.filter((envelope) =>
    envelope.parentToolCallId && envelope.event.type === "message_end" &&
    envelope.event.message.role === "user" && (envelope.event.message.attachments?.length ?? 0) > 0);
  assert.equal(childImageRows.length >= 2, true, "each image child input must echo its own transcript row");
  for (const envelope of childImageRows) {
    for (const attachment of envelope.event.message.attachments) {
      assert.match(attachment.ref, /^attachments\/[0-9a-f]{64}$/, `a child input row must carry a content-addressed ref: ${String(attachment.ref).slice(0, 40)}`);
    }
  }
  assert.equal(JSON.stringify(events).includes(PNG_BASE64), false, "child image bytes must never enter the transcript events");
  const persisted = await host.call("session.get", { id: sessionId, messageLimit: 200 });
  const persistedImageRows = (persisted.session?.messages ?? []).filter((message) =>
    message.role === "user" && (message.attachments?.length ?? 0) > 0);
  assert.equal(persistedImageRows.length >= 2, true, "the runtime must persist each child image input as a transcript row");
  for (const message of persistedImageRows) {
    for (const attachment of message.attachments) {
      assert.match(attachment.ref, /^attachments\/[0-9a-f]{64}$/, "a persisted child input must keep its ref");
    }
  }
  assert.equal(JSON.stringify(persistedImageRows).includes(PNG_BASE64), false, "a persisted child input must never store the image bytes");

  await eventWork;
  assert.equal(eventError, undefined, `fixture error: ${eventError?.stack ?? ""}`);

  console.log(`PASS subagent lifecycle: ${JSON.stringify({
    globalWakeup: "time:900",
    phase1: { parentRequests: stepped.phase1ParentRequests, quietWindowMs: QUIET_WINDOW_MS, quietWindowParentRequests: stepped.quietWindowParentRequests, ignoredControls: ["timeoutSeconds:1", "subagentWakeup:time:1"], reportDeliveries: phase1ReportCount },
    phase2: { parentRequests: stepped.phase2ParentRequests, reportDeliveries: phase2ReportCount, steerParentRequests: 0, childAdopted: stepped.childAdoptedSteer },
    phase3: { delivery: continued.delivery, parentRequests: 0, executionTurnOwned: true },
    phase4: { parentReceivedReattach: stepped.phase4Parent === "PARENT_RECEIVED_REATTACH_REPORT", reportDeliveries: countReportDeliveries(REATTACH_REPORT) },
    phase5: { parentSawStopped: stepped.phase5Parent === "PARENT_SAW_STOPPED", continueDelivery: continuedStopped.delivery, seededOriginalTask: true, concurrentRefused: true, parentRequests: 0 },
    phase6: { continueDelivery: continuedParentStop.delivery, parentRequestsThroughStopAndContinue: 0, reattachedReportDeliveries: countReportDeliveries(REATTACH_STOP_REPORT) },
    phase7: { imageSteerChildRequestBytes: true, imageContinueDelivery: continuedImage.delivery, imageContinueParentRequests: 0, persistedRefsOnly: true },
    requestCounts: { provider: requests.length, parent: parentRequests.length, child: childRequests.length },
    finishedTurns: finishedTurns.map((turn) => turn.turnId),
  })}`);
} catch (error) {
  if (error && error.__blocked) {
    console.error(`BLOCKED subagent lifecycle: ${error.message}`);
    exitCode = 4;
  } else {
    console.error(error?.stack ?? String(error));
    console.error(`DIAGNOSTIC ${JSON.stringify({
      step: stepped,
      heldKeys: [...held.keys()],
      parentCount: parentRequests.length,
      childCount: childRequests.length,
      childRequests: childRequests.map((request) => ({ model: request.model, user: allUserText(request).slice(0, 120) })),
      events: events.slice(-20).map((envelope) => ({ turnId: envelope.turnId, parentToolCallId: envelope.parentToolCallId, type: envelope.event.type, role: envelope.event.message?.role, content: textOf(envelope.event.message?.content).slice(0, 80) })),
    })}`);
    exitCode = 1;
  }
} finally {
  clearTimeout(watchdog);
  for (const entry of pending.values()) clearTimeout(entry.timer);
  for (const entry of held.values()) if (!entry.res.writableEnded) entry.res.destroy();
  try { lines?.close(); } catch {}
  if (child && child.exitCode === null) { const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await exited; }
  if (modelServer.listening) {
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(() => resolve()));
  }
  try { await host?.stop(); } catch {}
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = exitCode;
