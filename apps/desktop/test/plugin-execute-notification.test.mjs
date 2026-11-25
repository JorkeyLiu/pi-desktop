/**
 * `plugins.execute` crosses a language boundary: host-core writes the payload
 * in Rust, the main process reads it back by field name, and nothing
 * type-checks the two against each other. A field dropped from the Rust side
 * is invisible to every other check — the receiver throws on the first missing
 * name, the tool never runs, and host-core waits out its RPC timeout. So the
 * field list below is read from the Rust source and driven through the real
 * receiver.
 *
 * The same receiver decides when a plugin tool may start. That decision is
 * per-call cancellation, not turn liveness: host-bound tool calls run on their
 * own identity, and a call the runtime cancelled — before dispatch, during the
 * session read, or while the plugin was running — must never start or answer
 * twice.
 */
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
const { createToolCancellationRegistry } = await import(
  "../electron/main/runtime/tool-cancellations.ts"
);

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
const TOOL_NAME = "plugin_demo_echo";

const VALUE_BY_FIELD = {
  executionId: "exec-1",
  sessionId: SESSION_ID,
  turnId: TURN_ID,
  toolCallId: "call-1",
  toolName: TOOL_NAME,
  args: { message: "hello" },
  mode: "agent",
  planSafeActions: [],
};

/**
 * The real host runtime over a fake host process and fake plugin/MCP runtimes,
 * with the real per-call cancellation registry. Only external boundaries are
 * faked: host-core's channel, the plugin runtime and the user's MCP servers.
 */
function fixture({ activeTurn, sessionGate, tools, mcp } = {}) {
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
  const toolCancellations = createToolCancellationRegistry();

  const host = {
    onNotification: (handler) => {
      notification = handler;
    },
    onExit() {},
    async call(method, params) {
      calls.push({ method, params });
      if (method === "session.get") {
        return sessionGate ? sessionGate(params) : { session: { mode: "agent" } };
      }
      return {};
    },
  };

  const runtime = createHostRuntime({
    runtimeState: { host, sidecar: null, agentHostBridge: null },
    dataDir: "/tmp/pi-desktop-test",
    logger: { app() {}, child: () => ({ app() {} }), flushChild() {} },
    persistenceOutbox: { size: () => 0, flush: async () => undefined },
    activeToolCalls: new Map(),
    activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
    sessionProjects: new Map(),
    plugins: {
      getTools: () =>
        tools ?? [
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
    userMcp: {
      callTool: async (...args) => {
        invocations.push({ mcp: true, args });
        return mcp ? mcp(...args) : null;
      },
    },
    pluginActiveInProject: () => true,
    sendToRenderer() {},
    emitAgentEvent() {},
    togglePluginLauncher: async () => undefined,
    finishTurn: async () => undefined,
    isTurnDispatchable: coordination.isTurnDispatchable,
    toolCancellations,
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
    toolCancellations,
    notify: (method, params) => notification(method, params),
    aborted: (toolCallId) => notification("tools.aborted", { sessionId: SESSION_ID, toolCallId }),
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

function resolved(f) {
  return f.calls.filter((call) => call.method === "plugins.resolveExecution");
}

/** Advance the receiver's awaits without a wall-clock sleep. */
async function settle(turns = 4) {
  for (let index = 0; index < turns; index += 1) await setImmediate();
}

async function waitFor(predicate) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await setImmediate();
  }
  throw new Error("the observed boundary never happened");
}

/** A plugin tool whose completion the test controls, honouring its signal. */
function pendingTool(name = TOOL_NAME) {
  const record = { name, ctx: undefined, started: false, settled: false };
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  record.tool = {
    fullName: name,
    pluginId: "demo",
    execute: async (_args, ctx) => {
      record.ctx = ctx;
      record.started = true;
      ctx?.signal?.addEventListener(
        "abort",
        () => {
          if (record.settled) return;
          record.settled = true;
          reject(Object.assign(new Error("tool call aborted"), { code: "TOOL_ABORTED" }));
        },
        { once: true },
      );
      return promise;
    },
  };
  record.complete = (value) => {
    if (record.settled) return;
    record.settled = true;
    resolve(value);
  };
  return record;
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
  assert.ok(
    !FIELDS.includes("childRunId"),
    "dispatch identity is per call, so the payload carries no run-authority field",
  );
});

// A host-bound tool call is admitted on its own identity. Whether a turn of the
// same session is live is irrelevant: the runtime may have finished the parent
// turn while a manually continued child, or a plain non-turn caller, still runs
// a legitimate tool.
test("a plugin tool dispatches with no live turn", async () => {
  const f = fixture({ activeTurn: undefined });
  const payload = fullPayload();

  f.notify("plugins.execute", payload);
  await settle();

  const answers = resolved(f);
  assert.equal(answers.length, 1, "host-core must be answered exactly once");
  assert.equal(answers[0].params.ok, true, JSON.stringify(answers[0].params));
  assert.equal(f.invocations.length, 1, "the plugin tool must be executed once");
  assert.deepEqual(f.invocations[0].args, payload.args);
  assert.equal(f.invocations[0].ctx.turnId, TURN_ID, "the turn stays attribution");
});

test("a call with no optional turn correlation dispatches", async () => {
  const f = fixture({ activeTurn: undefined });
  const payload = payloadWithout("turnId");

  f.notify("plugins.execute", payload);
  await settle();

  assert.equal(resolved(f)[0].params.ok, true);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.invocations[0].ctx.turnId, undefined);
});

// Tools are dispatched by plugin catalog presence, never by a hard-coded
// allow/deny list of tool names: a name the runtime never special-cased must
// reach its plugin exactly like any other.
test("the dispatch path has no tool-name whitelist", async () => {
  const seen = [];
  const f = fixture({
    tools: [
      {
        fullName: "plugin_demo_navigate",
        pluginId: "demo",
        execute: async (args, ctx) => {
          seen.push({ args, ctx });
          return { navigated: true };
        },
      },
    ],
  });
  const payload = { ...fullPayload(), toolName: "plugin_demo_navigate" };

  f.notify("plugins.execute", payload);
  await settle();

  assert.equal(resolved(f)[0].params.ok, true, JSON.stringify(resolved(f)[0].params));
  assert.equal(seen.length, 1, "an unlisted tool name still dispatches");
  assert.deepEqual(seen[0].args, payload.args);
});

// A cancel already recorded for this exact call means host-core has settled it
// with TOOL_ABORTED. Main must not start the side effect and must not answer
// again.
test("an abort recorded before the notification refuses the call once", async () => {
  const f = fixture();
  const payload = fullPayload();
  f.aborted(payload.toolCallId);

  f.notify("plugins.execute", payload);
  await settle();

  assert.equal(f.invocations.length, 0, "a cancelled call must not start");
  assert.equal(resolved(f).length, 0, "host-core already settled it on cancellation");

  // The tombstone is consumed by the refused call: a later call with a new
  // identity is untouched.
  f.notify("plugins.execute", { ...payload, executionId: "exec-2", toolCallId: "call-2" });
  await settle();
  assert.equal(resolved(f).length, 1);
  assert.equal(resolved(f)[0].params.executionId, "exec-2");
  assert.equal(f.invocations.length, 1);
});

test("an abort during the session read prevents the dispatch", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({ sessionGate: () => gate });
  const payload = payloadWithout("mode");

  f.notify("plugins.execute", payload);
  await waitFor(() =>
    f.calls.some((call) => call.method === "session.get"),
  );
  f.aborted(payload.toolCallId);
  assert.equal(f.invocations.length, 0, "nothing may start while the read is in flight");
  release({ session: { mode: "agent" } });
  await settle();

  assert.equal(f.invocations.length, 0, "an aborted call must not start after the read");
  assert.equal(resolved(f).length, 0);
});

// The plugin runtime already runs in main: the cancellation has to reach the
// invocation, not only the reply. The call settles once — no second answer for
// the late completion.
test("an abort while the plugin runs stops it and settles once", async () => {
  const pending = pendingTool();
  const f = fixture({ tools: [pending.tool] });
  const payload = fullPayload();

  f.notify("plugins.execute", payload);
  await waitFor(() => pending.started);
  assert.equal(pending.ctx.signal.aborted, false, "the signal starts clear");

  f.aborted(payload.toolCallId);
  await settle();

  assert.equal(pending.ctx.signal.aborted, true, "the invocation receives the cancel");
  assert.equal(resolved(f).length, 0, "host-core settles the cancelled call");
  // A late completion of the cancelled tool is ignored, not answered.
  pending.complete({ echoed: true });
  await settle();
  assert.equal(resolved(f).length, 0);
});

test("a run that finishes normally is answered once", async () => {
  const pending = pendingTool();
  const f = fixture({ tools: [pending.tool] });

  f.notify("plugins.execute", fullPayload());
  await waitFor(() => pending.started);
  pending.complete({ echoed: true });
  await settle();

  assert.equal(resolved(f).length, 1);
  assert.equal(resolved(f)[0].params.ok, true, JSON.stringify(resolved(f)[0].params));
});

test("an abort of one call leaves a sibling call and session untouched", async () => {
  const first = pendingTool("call-1");
  const second = pendingTool("call-2");
  const f = fixture({
    tools: [first.tool, second.tool].map((tool, index) => ({
      ...tool,
      pluginId: "demo",
      fullName: index === 0 ? "plugin_demo_echo" : "plugin_demo_other",
    })),
  });

  f.notify("plugins.execute", fullPayload());
  f.notify("plugins.execute", {
    ...fullPayload(),
    executionId: "exec-2",
    toolCallId: "call-2",
    toolName: "plugin_demo_other",
  });
  await waitFor(() => first.started && second.started);

  f.aborted("call-1");
  await settle();
  assert.equal(first.ctx.signal.aborted, true, "the cancelled call is aborted");
  assert.equal(second.ctx.signal.aborted, false, "the sibling call keeps running");

  second.complete({ echoed: true });
  await settle();
  assert.deepEqual(
    resolved(f).map((call) => call.params.executionId),
    ["exec-2"],
    "only the sibling is answered",
  );
  first.complete({ echoed: true });
  await settle();
  assert.equal(resolved(f).length, 1, "the cancelled call stays unanswered");
});

test("an mcp call receives the call signal and is answered once", async () => {
  const f = fixture({
    mcp: (_name, _args, _projectPath, _sessionId, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  const payload = { ...fullPayload(), toolName: "mcp_demo" };

  f.notify("plugins.execute", payload);
  await waitFor(() => f.invocations.length === 1);
  assert.ok(f.invocations[0].args[4] instanceof AbortSignal, "the user MCP call gets the signal");

  f.aborted(payload.toolCallId);
  await settle();
  assert.equal(resolved(f).length, 0, "the cancelled mcp call is settled by host-core");
});

// A real stop reaches the user's MCP call before `tools.aborted` is relayed
// here, so the rejection itself carries the cancellation: it must stay a
// cancellation, not be restated as a generic tool failure.
test("an mcp call rejected as aborted before the abort report keeps TOOL_ABORTED", async () => {
  const f = fixture({
    mcp: () => {
      throw Object.assign(new Error("mcp tool call aborted"), { code: "TOOL_ABORTED" });
    },
  });
  const payload = { ...fullPayload(), toolName: "mcp_demo" };

  f.notify("plugins.execute", payload);
  await settle();

  const answers = resolved(f);
  assert.equal(answers.length, 1, "the rejected call is answered exactly once");
  assert.equal(answers[0].params.ok, false);
  assert.equal(answers[0].params.errorCode, "TOOL_ABORTED");
  assert.equal(f.invocations.length, 1);
  assert.equal(f.invocations[0].mcp, true);
});

test("an mcp call rejected by its host services keeps the declared code", async () => {
  const f = fixture({
    mcp: () => {
      throw Object.assign(new Error("unknown mcp tool: mcp_demo"), {
        errorCode: "TOOL_NOT_FOUND",
      });
    },
  });
  const payload = { ...fullPayload(), toolName: "mcp_demo" };

  f.notify("plugins.execute", payload);
  await settle();

  const answers = resolved(f);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].params.errorCode, "TOOL_NOT_FOUND", "the mcp code is not collapsed");
});

test("an unknown plugin tool is still refused on its own execution id", async () => {
  const f = fixture({ tools: [] });
  const payload = fullPayload();

  f.notify("plugins.execute", payload);
  await settle();

  const answers = resolved(f);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].params.ok, false);
  assert.equal(answers[0].params.errorCode, "TOOL_NOT_FOUND");
});
