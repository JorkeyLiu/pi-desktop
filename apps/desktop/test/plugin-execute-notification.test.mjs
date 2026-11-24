import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createHostRuntime } = await import("../electron/main/runtime/host.ts");
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);

// `plugins.execute` crosses a language boundary: host-core writes the payload in
// Rust, the main process reads it back by field name, and nothing type-checks the
// two against each other. A field dropped from the Rust side is invisible to
// every other check — the receiver throws on the first missing name, the tool
// never runs, and host-core waits out its RPC timeout. So read the field list
// from the Rust source and drive the real receiver with it.
const rustSource = readFileSync(
  join(here, "..", "..", "..", "crates", "host-core", "src", "rpc", "mod.rs"),
  "utf8",
);

/**
 * Field names of the `plugins.execute` notification payload, taken from the
 * `json!({ ... })` literal in host-core. Brace matching ignores nesting; the
 * payload holds no braces inside strings or comments, so a simple depth count is
 * enough and any future nesting still keeps the top-level names correct.
 */
function pluginExecutePayloadFields(source) {
  const notification = source.indexOf('"plugins.execute"');
  assert.ok(notification >= 0, "the plugins.execute notification is gone");
  const literal = source.indexOf("json!({", notification);
  assert.ok(literal >= 0, "the plugins.execute payload literal is gone");
  const open = source.indexOf("{", literal);
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  assert.ok(end > open, "the plugins.execute payload literal is unbalanced");
  return [...source.slice(open + 1, end).matchAll(/^\s*"([A-Za-z][A-Za-z0-9]*)":/gm)].map(
    (match) => match[1],
  );
}

const FIELDS = pluginExecutePayloadFields(rustSource);

const SESSION_ID = "session-1";
const TURN_ID = "turn-1";

const VALUE_BY_FIELD = {
  executionId: "exec-1",
  sessionId: SESSION_ID,
  turnId: TURN_ID,
  toolCallId: "call-1",
  toolName: "demo_echo",
  args: { message: "hello" },
  mode: "agent",
  planSafeActions: [],
};

const TOOL_NAME = VALUE_BY_FIELD.toolName;

/**
 * The dispatch gate is the real coordination instance in the main process, and
 * whether a call may run depends on the identity it carries, so the fixture
 * builds the real instance instead of stubbing `isTurnDispatchable`: a stub would
 * decide that question itself. `activeTurn` seeds the session's live turn;
 * leaving it out models a session whose turn has already ended.
 */
function fixture({ activeTurn } = {}) {
  const calls = [];
  const invocations = [];
  let notification = null;

  const activeTurns = new Map();
  if (activeTurn !== undefined) activeTurns.set(SESSION_ID, activeTurn);
  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });

  const host = {
    onNotification: (handler) => {
      notification = handler;
    },
    onExit() {},
    async call(method, params) {
      calls.push({ method, params });
      return {};
    },
  };

  const runtime = createHostRuntime({
    // The notification handler ignores anything from a host generation that is
    // no longer current, so the fake must be the live one.
    runtimeState: { host, sidecar: null, agentHostBridge: null },
    dataDir: "/tmp/pi-desktop-test",
    logger: { app() {}, child: () => ({ app() {} }), flushChild() {} },
    persistenceOutbox: { size: () => 0, flush: async () => undefined },
    activeToolCalls: new Map(),
    activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
    sessionProjects: new Map(),
    plugins: {
      getTools: () => [
        {
          fullName: TOOL_NAME,
          pluginId: "demo",
          execute: async (args, ctx) => {
            invocations.push({ args, ctx });
            return { echoed: true };
          },
        },
      ],
      drainToasts: () => [],
    },
    userMcp: { callTool: async () => null },
    pluginActiveInProject: () => true,
    sendToRenderer() {},
    emitAgentEvent() {},
    togglePluginLauncher: async () => undefined,
    finishTurn: async () => undefined,
    isTurnDispatchable: coordination.isTurnDispatchable,
    // The combined dispatch predicate main passes in production: a live
    // parent turn dispatches, and so does a live independent child run the
    // continuation path registered. Inert until host.ts consults it.
    isPluginDispatchable: coordination.isPluginDispatchable,
    // The in-flight acceptance a continuation published: the gate awaits it
    // before failing a first tool call that beat the sidecar response.
    pendingChildAcceptance: coordination.pendingChildAcceptance,
    finishApprovedExecution: async () => undefined,
    activeTurns,
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    importLegacyScheduled: async () => undefined,
    superviseRestart: async () => undefined,
    isQuitting: () => false,
    ensureSystemProxyRelay: async () => "socks5://system-auto:test@127.0.0.1:1",
  });
  runtime.wireHost(host);

  return {
    calls,
    invocations,
    coordination,
    notify: (method, params) => notification(method, params),
  };
}

function fullPayload() {
  return Object.fromEntries(FIELDS.map((field) => [field, VALUE_BY_FIELD[field]]));
}

function payloadWithout(missing) {
  return Object.fromEntries(
    FIELDS.filter((field) => field !== missing).map((field) => [field, VALUE_BY_FIELD[field]]),
  );
}

async function dispatch(f, payload) {
  f.notify("plugins.execute", payload);
  await setImmediate();
  await setImmediate();
  return f.calls.filter((call) => call.method === "plugins.resolveExecution");
}

function assertRefused(resolved, expectedExecutionId) {
  assert.equal(resolved.length, 1, "host-core must be answered exactly once");
  assert.equal(resolved[0].params.ok, false, "the call must be refused");
  assert.equal(resolved[0].params.errorCode, "TOOL_TURN_CANCELLED");
  assert.equal(resolved[0].params.executionId, expectedExecutionId);
}

test("the host-core notification carries every field the receiver reads", () => {
  for (const field of ["executionId", "sessionId", "toolCallId", "toolName", "args", "turnId", "mode"]) {
    assert.ok(FIELDS.includes(field), `plugins.execute no longer sends ${field}`);
  }
  assert.equal(
    FIELDS.filter((field) => field === "turnId").length,
    1,
    "the turn identity must be sent exactly once",
  );
});

test("the live turn's payload runs the plugin tool and is answered", async () => {
  const f = fixture({ activeTurn: TURN_ID });
  const payload = fullPayload();

  const resolved = await dispatch(f, payload);

  assert.equal(resolved.length, 1, "host-core must be answered exactly once");
  assert.equal(
    resolved[0].params.ok,
    true,
    `the tool must run: ${JSON.stringify(resolved[0].params)}`,
  );
  assert.equal(resolved[0].params.executionId, payload.executionId);

  assert.equal(f.invocations.length, 1, "the plugin tool must be executed once");
  assert.deepEqual(f.invocations[0].args, payload.args);
  // The turn identity travels with the call, so a plugin can scope the work it
  // started to the turn `session:turnEnded` will name.
  assert.equal(f.invocations[0].ctx.turnId, payload.turnId);
  assert.equal(f.invocations[0].ctx.sessionId, payload.sessionId);
});

// A turn that no longer owns the session was already settled: its cancel lock is
// gone and its `session:turnEnded` has been announced, so nothing may start work
// on its behalf. The refusal is answered on the original execution id, otherwise
// host-core waits out its RPC timeout.
test("a payload naming a turn that no longer owns the session is refused", async () => {
  const f = fixture({ activeTurn: "turn-elsewhere" });
  const payload = fullPayload();

  assertRefused(await dispatch(f, payload), payload.executionId);
  assert.equal(f.invocations.length, 0, "a settled turn must not start a plugin side effect");
});

test("a payload for a turn that already ended is refused", async () => {
  // No live turn at all: the session's record was released when its
  // `session:turnEnded` went out.
  const f = fixture();
  const payload = fullPayload();

  assertRefused(await dispatch(f, payload), payload.executionId);
  assert.equal(f.invocations.length, 0);
});

// host-core types the turn identity as optional (`ToolsExecuteParams.turn_id`),
// but a call that names no turn cannot be attributed to one: main cannot tell it
// apart from a call belonging to a turn that already ended, and any resource it
// started could never be related to that turn's `session:turnEnded`. So the gate
// stays closed and the caller gets a failure instead of a silent new turn.
test("a payload without a turn identity is refused rather than executed", async () => {
  // The session's turn is live on purpose: the refusal must come from the missing
  // identity, not from an idle session.
  const f = fixture({ activeTurn: TURN_ID });
  const payload = payloadWithout("turnId");

  assertRefused(await dispatch(f, payload), payload.executionId);
  assert.equal(
    f.invocations.length,
    0,
    "a call that names no turn must not start a plugin side effect",
  );
});

test("a payload without a session identity is refused on the same grounds", async () => {
  const f = fixture({ activeTurn: TURN_ID });
  const payload = payloadWithout("sessionId");

  assertRefused(await dispatch(f, payload), payload.executionId);
  assert.equal(f.invocations.length, 0);
});

test("an mcprefixed tool keeps its own path", async () => {
  const f = fixture({ activeTurn: TURN_ID });
  const payload = { ...fullPayload(), toolName: "mcp_demo" };

  const resolved = await dispatch(f, payload);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].params.ok, true);
  assert.equal(f.invocations.length, 0, "an mcp tool never reaches the plugin runtime");
});

// A manually continued child runs with no live parent turn: the runtime
// stamps the retained (ended) parent turn for attribution and the run's own
// `childRunId` as the dispatch identity. Main dispatches exactly the child
// runs the continuation path registered — never a stale or missing parent,
// never an unknown or revoked child.

function childPayload(childRunId) {
  return { ...fullPayload(), childRunId };
}

test("the forwarded payload carries the independent child identity", () => {
  assert.ok(
    FIELDS.includes("childRunId"),
    "plugins.execute must forward the continued run's childRunId",
  );
});

test("a live independent child dispatches while its parent turn stays ended", async () => {
  const f = fixture();
  f.coordination.registerIndependentChildRun(SESSION_ID, "child-run-1");
  const payload = childPayload("child-run-1");

  const resolved = await dispatch(f, payload);

  assert.equal(resolved.length, 1, "host-core must be answered exactly once");
  assert.equal(resolved[0].params.ok, true, `the live child must run: ${JSON.stringify(resolved[0].params)}`);
  assert.equal(f.invocations.length, 1, "the plugin tool must be executed once");
  // The stamped turn is preserved for attribution; it authorizes nothing.
  assert.equal(f.invocations[0].ctx.turnId, TURN_ID);
});

test("a revoked child is refused even though its parent turn already ended", async () => {
  const f = fixture();
  f.coordination.registerIndependentChildRun(SESSION_ID, "child-run-1");
  f.coordination.revokeIndependentChildRun(SESSION_ID, "child-run-1");

  assertRefused(await dispatch(f, childPayload("child-run-1")), "exec-1");
  assert.equal(f.invocations.length, 0, "a settled child must not start a plugin side effect");
});

test("an unknown child identity is refused", async () => {
  const f = fixture();
  f.coordination.registerIndependentChildRun(SESSION_ID, "child-run-1");

  assertRefused(await dispatch(f, childPayload("child-run-other")), "exec-1");
  assert.equal(f.invocations.length, 0);
});

test("two child identities do not interfere", async () => {
  const f = fixture();
  f.coordination.registerIndependentChildRun(SESSION_ID, "child-run-1");
  f.coordination.registerIndependentChildRun(SESSION_ID, "child-run-2");
  f.coordination.revokeIndependentChildRun(SESSION_ID, "child-run-1");

  assertRefused(await dispatch(f, childPayload("child-run-1")), "exec-1");
  const resolved = await dispatch(f, childPayload("child-run-2"));
  assert.equal(resolved[resolved.length - 1].params.ok, true);
  assert.equal(f.invocations.length, 1);
});

test("parent turn finalization does not revoke the independent child", async () => {
  const f = fixture({ activeTurn: "parent-turn-live" });
  f.coordination.registerIndependentChildRun(SESSION_ID, "child-run-1");
  // A parent turn begins and ends while the child keeps running.
  f.coordination.releaseTurnClaims(SESSION_ID, "parent-turn-live");

  const resolved = await dispatch(f, childPayload("child-run-1"));
  assert.equal(resolved[0].params.ok, true, "the live child survives parent finalization");
  assert.equal(f.invocations.length, 1);
});

test("another live parent turn lends no identity to the child", async () => {
  const f = fixture({ activeTurn: "parent-turn-other" });
  f.coordination.registerIndependentChildRun(SESSION_ID, "child-run-1");
  f.coordination.revokeIndependentChildRun(SESSION_ID, "child-run-1");

  assertRefused(await dispatch(f, childPayload("child-run-1")), "exec-1");
  assert.equal(f.invocations.length, 0);
});

// F1: the acceptance and the first tool call travel different channels — the
// sidecar response and the host notification — so the tool call can arrive
// before the registration. The gate awaits the in-flight acceptance instead
// of failing closed; the wait is bounded by that call, never a grace window.

async function pollResolved(f, tries = 100) {
  for (let index = 0; index < tries; index += 1) {
    const resolved = f.calls.filter((call) => call.method === "plugins.resolveExecution");
    if (resolved.length > 0) return resolved;
    await setImmediate();
  }
  return f.calls.filter((call) => call.method === "plugins.resolveExecution");
}

test("a first tool call that beats the acceptance dispatches once registered", async () => {
  const f = fixture();
  let resolveAcceptance;
  const acceptance = new Promise((resolve) => {
    resolveAcceptance = resolve;
  });
  // The continuation path publishes its acceptance before the sidecar
  // response lands; the registration below runs in the acceptance's own
  // continuation, exactly as the agent-ipc handler does.
  f.coordination.trackPendingChildAcceptance(SESSION_ID, acceptance);
  const registered = acceptance.then((response) => {
    f.coordination.registerIndependentChildRun(SESSION_ID, response.delegationId);
  });
  f.notify("plugins.execute", childPayload("child-run-9"));
  resolveAcceptance({ accepted: true, delegationId: "child-run-9" });
  await registered;

  const resolved = await pollResolved(f);
  assert.equal(resolved.length, 1, "host-core must be answered exactly once");
  assert.equal(
    resolved[0].params.ok,
    true,
    `the live child must run: ${JSON.stringify(resolved[0].params)}`,
  );
  assert.equal(resolved[0].params.executionId, "exec-1");
  assert.equal(f.invocations.length, 1, "the plugin tool must be executed once");
});

test("an acceptance that registers nothing still fails closed", async () => {
  const f = fixture();
  let resolveAcceptance;
  const acceptance = new Promise((resolve) => {
    resolveAcceptance = resolve;
  });
  f.coordination.trackPendingChildAcceptance(SESSION_ID, acceptance);
  f.notify("plugins.execute", childPayload("child-run-9"));
  await setImmediate();
  // A settled idempotent retry resolves the acceptance without registering:
  // main refused the dead run, so the gate must too.
  resolveAcceptance({ accepted: true, delegationId: "child-run-9", live: false });

  const resolved = await pollResolved(f);
  assertRefused(resolved, "exec-1");
  assert.equal(f.invocations.length, 0, "an unregistered child must not start a plugin side effect");
});

test("a pending acceptance for another session does not authorize the call", async () => {
  const f = fixture();
  let resolveOther;
  const other = new Promise((resolve) => {
    resolveOther = resolve;
  });
  f.coordination.trackPendingChildAcceptance("session-other", other);
  try {
    assertRefused(await dispatch(f, childPayload("child-run-9")), "exec-1");
    assert.equal(f.invocations.length, 0);
  } finally {
    resolveOther({});
  }
});

// A rejected continuation acceptance still settles the tracked entry: the
// tracker converts the rejection to a settled void and cleans up, so the
// gate wakes, rechecks an unregistered run, and fails closed.
test("a rejected acceptance cleans up and still refuses the child call", async () => {
  const f = fixture();
  const acceptance = Promise.reject(new Error("sidecar gone"));
  f.coordination.trackPendingChildAcceptance(SESSION_ID, acceptance);
  f.notify("plugins.execute", childPayload("child-run-9"));
  const resolved = await pollResolved(f);
  assertRefused(resolved, "exec-1");
  assert.equal(f.invocations.length, 0, "a rejected acceptance registers nothing to dispatch");
  await setImmediate();
  assert.equal(
    f.coordination.pendingChildAcceptance(SESSION_ID),
    undefined,
    "the rejected acceptance must not linger",
  );
});
