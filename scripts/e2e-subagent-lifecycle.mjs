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
//
// Requires a freshly built agent-runtime/sidecar dist that carries the program
// coordinator. A stale dist is detected from the emitted TaskWait tool schema
// and reported as BLOCKED (exit 4) instead of a false pass.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
const CONTINUE_PROMPT = "CONTINUE_FIXTURE: report the detached marker.";
const STEER_TEXT = "STEER_MARKER: adopt this steer before your final report.";
const REATTACH_TASK = "Reattach A fixture run.";
const CHILD_A_REPORT = "Delegate A fixture report ALPHA.";
const CHILD_B_REPORT = "Delegate B fixture report BETA.";
const DETACHED_REPORT = "Detached continuation report GAMMA.";
const REATTACH_REPORT = "Reattach fixture report DELTA.";
const QUIET_WINDOW_MS = 2_500; // > stale timeoutSeconds:1, << the 900s program period

const root = mkdtempSync(join(tmpdir(), "pi-subagent-lifecycle-"));
const dataDir = join(root, "data");
const homeDir = join(root, "home");
const projectPath = join(root, "project");
for (const path of [dataDir, homeDir, projectPath]) mkdirSync(path);
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
let turnIdA;
let turnIdB;
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
    if (role === "user" && prev === "user") throw new Error(`invalid provider role sequence: consecutive user messages (${payload.model})`);
  }
}

/** Deliveries of a report = requests whose newest message is that report's tool result. */
function countReportDeliveries(report) {
  return parentRequests.filter((request) => {
    const last = request.messages.at(-1);
    return last?.role === "tool" && textOf(last.content).includes(report);
  }).length;
}

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
  throw new Error(`unexpected parent request: ${text.slice(-200)}`);
}

function respondChild(payload, stream) {
  childRequests.push(payload);
  // Branch on the child's LATEST user message: a resumed chain replays earlier
  // tasks/continuations, so history text is ambiguous by design.
  const text = lastUserText(payload);
  if (text.includes("STEER_MARKER")) { stepped.childAdoptedSteer = true; return say(stream, CHILD_B_REPORT); }
  if (text.includes("Reattach A fixture")) return say(stream, REATTACH_REPORT);
  if (text.includes("CONTINUE_FIXTURE")) return say(stream, DETACHED_REPORT);
  if (text.includes("Delegate B fixture")) { held.set("B", { res: stream.res, stream }); return stream.hold(); }
  if (text.includes("Delegate A fixture")) { held.set("A", { res: stream.res, stream }); return stream.hold(); }
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
}, 90_000);

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
          subagentProviders: { "fixture/delegate-fixture": { ...provider, modelId: "delegate-fixture" } },
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

  // ---- Phase 4: explicit parent Task(resume) reattaches the report --------
  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: PHASE4_PROMPT }]);
  await until(() => childRequests.some((request) => allUserText(request).includes("Reattach A fixture")), "parent Task(resume) did not start a resumed child run");
  await until(() => parentRequests.some((request) => textOf(request.messages.at(-1)?.content).includes(REATTACH_REPORT)), "parent did not receive the reattached report");
  await eventWork;
  assert.equal(stepped.phase4Parent, "PARENT_RECEIVED_REATTACH_REPORT", "an explicit parent resume must deliver the report back to the parent");
  assert.equal(countReportDeliveries(REATTACH_REPORT), 1, "the reattached report must be delivered exactly once");
  await until(() => !activeTurns.has(sessionId), "phase 4 parent turn did not settle");

  await eventWork;
  assert.equal(eventError, undefined, `fixture error: ${eventError?.stack ?? ""}`);

  console.log(`PASS subagent lifecycle: ${JSON.stringify({
    globalWakeup: "time:900",
    phase1: { parentRequests: stepped.phase1ParentRequests, quietWindowMs: QUIET_WINDOW_MS, quietWindowParentRequests: stepped.quietWindowParentRequests, ignoredControls: ["timeoutSeconds:1", "subagentWakeup:time:1"], reportDeliveries: phase1ReportCount },
    phase2: { parentRequests: stepped.phase2ParentRequests, reportDeliveries: phase2ReportCount, steerParentRequests: 0, childAdopted: stepped.childAdoptedSteer },
    phase3: { delivery: continued.delivery, parentRequests: 0, executionTurnOwned: true },
    phase4: { parentReceivedReattach: stepped.phase4Parent === "PARENT_RECEIVED_REATTACH_REPORT", reportDeliveries: countReportDeliveries(REATTACH_REPORT) },
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
