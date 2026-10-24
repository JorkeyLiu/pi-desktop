import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createEventsSlice } = await import("../src/stores/slices/events-slice.ts");
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");

/**
 * A tool call is named by the model before its arguments exist and before
 * anything runs. These tests drive the renderer's real event projection (the
 * store slice for the visible session, the session runtime for a background
 * one) and assert what the transcript shows at each step: the call appears at
 * its chronological position as soon as its identity settles, becomes the
 * executing row in place, keeps that position across a steering message, and
 * disappears when the attempt never runs it.
 */

const START = Date.parse("2026-10-13T00:00:00.000Z");

const message = (id, role, content = "", extra = {}) => ({
  id,
  role,
  content,
  createdAt: new Date(START).toISOString(),
  ...extra,
});

const baseState = (messages) => ({
  activeSessionId: "active",
  messages,
  retainedSessionIds: ["active", "background"],
  retainedTranscripts: { active: messages, background: [] },
  runningSessions: { active: true, background: true },
  sessionHistory: {},
  pendingPermissions: {},
  pendingAsks: {},
  planningStates: {},
  planCheckpoints: {},
  pendingPlans: {},
  sessions: [],
  sessionCompactions: {},
  sessionTodos: {},
  agentStatuses: {},
  latestTurnResults: {},
  sessionOutcomes: {},
  pluginViews: [],
  isRunning: true,
  refreshSessions: async () => {},
  refreshQueuedPrompts: async () => {},
  restorePendingPlan: async () => {},
  showToast: () => {},
  openWorkPanelTabForSession: () => {},
});

function harness(messages = [], background = []) {
  let runtime;
  let state = baseState(messages);
  const access = {
    get: () => state,
    set: (patch) => {
      const previous = state;
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next === state) return;
      state = { ...state, ...next };
      runtime?.syncTranscriptProjection(state, previous);
    },
  };
  runtime = createSessionRuntime(access);
  runtime.cacheSessionTranscript("active", messages);
  runtime.cacheSessionTranscript("background", background);
  const slice = createEventsSlice({
    ...access,
    runtime,
    withoutRecordKey: (record, key) => {
      const next = { ...record };
      delete next[key];
      return next;
    },
    sessionModeForPlanningState: () => "agent",
    openPlanArtifact() {},
    notifyInteractivePrompt() {},
    flushPendingSessionConfiguration: async () => {},
    assistantErrorMessage: (error) => message("error-row", "assistant", error.message, { status: "error" }),
    withCompactionMark: (marks, mark) => [...(marks ?? []), mark],
  });
  Object.assign(state, slice);
  const at = (offset) => START + offset * 1000;
  return {
    ...access,
    runtime,
    send: (event, options = {}) =>
      state.handleAgentEvent({
        sessionId: options.sessionId ?? "active",
        ts: at(options.at ?? 1),
        turnId: "turn",
        event,
        ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
        ...(options.nestedParentToolCallId
          ? { nestedParentToolCallId: options.nestedParentToolCallId }
          : {}),
        ...(options.agentName ? { agentName: options.agentName } : {}),
      }),
    rows: () => state.messages,
    last: () => state.messages.at(-1),
  };
}

const assistantStart = (id = "answer") => ({
  type: "message_start",
  message: message(id, "assistant", "", { status: "streaming" }),
});
const assistantEnd = (id = "answer", status = "complete") => ({
  type: "message_end",
  message: message(id, "assistant", "", { status }),
});
const prepared = (toolCallId = "call-1", toolName = "Bash", extra = {}) => ({
  type: "tool_prepare",
  toolCallId,
  toolName,
  ...extra,
});
const started = (toolCallId = "call-1", toolName = "Bash", args = { command: "ls" }) => ({
  type: "tool_start",
  toolCallId,
  toolName,
  args,
});

test("a call is shown while its arguments stream and becomes the executing row in place", () => {
  const h = harness([message("user-1", "user", "List the files.")]);
  h.send(assistantStart(), { at: 1 });
  h.send(prepared(), { at: 2 });

  const preparing = h.last();
  assert.equal(h.rows().length, 3);
  assert.equal(preparing.id, "call-1");
  assert.equal(preparing.role, "tool");
  assert.equal(preparing.toolName, "Bash");
  assert.equal(preparing.toolStatus, "preparing");
  assert.equal(preparing.status, "streaming");
  assert.equal(preparing.createdAt, new Date(START + 2000).toISOString());
  // Nothing executed yet: no arguments and no result exist.
  assert.equal(preparing.toolArgs, undefined);
  assert.equal(preparing.toolResult, undefined);

  h.send(assistantEnd(), { at: 3 });
  h.send(started(), { at: 4 });

  const executing = h.rows()[2];
  assert.equal(h.rows().length, 3, "the executing call does not add a row");
  assert.equal(executing.id, "call-1", "the row keeps its id");
  assert.equal(executing.createdAt, preparing.createdAt, "the row keeps its creation time");
  assert.equal(executing.toolStatus, "running");
  assert.deepEqual(executing.toolArgs, { command: "ls" });

  h.send({ type: "tool_end", toolCallId: "call-1", result: { stdout: "a" }, isError: false }, { at: 5 });
  assert.equal(h.rows().length, 3);
  assert.equal(h.rows()[2].id, "call-1");
  assert.equal(h.rows()[2].toolStatus, "success");
});

test("the end of argument generation stops the pulse before execution starts", () => {
  const h = harness([message("user-1", "user", "Go.")]);
  h.send(assistantStart(), { at: 1 });
  h.send(prepared(), { at: 2 });
  const streaming = h.last();
  assert.equal(streaming.toolArgsComplete, undefined, "arguments are still streaming");

  // Argument generation ends here. Execution can still be delayed behind the
  // rest of the reply, so the row must stop breathing on its own.
  h.send(prepared("call-1", "Bash", { ready: true }), { at: 3 });
  const complete = h.last();
  assert.equal(h.rows().length, 3, "completion edits the same row");
  assert.equal(complete.id, "call-1");
  assert.equal(complete.createdAt, streaming.createdAt, "the row keeps its creation time");
  assert.equal(complete.toolStatus, "preparing", "nothing has executed yet");
  assert.equal(complete.toolArgsComplete, true);
  assert.equal(complete.toolArgs, undefined, "completion never invents arguments");

  // Execution then takes the row over in place and clears the marker that kept
  // the preparing presentation.
  h.send(started(), { at: 4 });
  const executing = h.rows()[2];
  assert.equal(h.rows().length, 3, "the executing call does not add a row");
  assert.equal(executing.id, "call-1");
  assert.equal(executing.createdAt, streaming.createdAt);
  assert.equal(executing.toolStatus, "running");
  assert.equal(executing.toolArgsComplete, undefined);
  assert.deepEqual(executing.toolArgs, { command: "ls" });
});

test("a call whose identity arrives with its arguments is placed already complete", () => {
  const h = harness([message("user-1", "user", "Delegate this.")]);
  h.send(assistantStart(), { at: 1 });
  // The provider reports the whole call at once: no identity frame preceded it,
  // so the row appears complete and never pulses.
  h.send(
    prepared("task-1", "Task", { ready: true, taskTitle: "Audit the parser" }),
    { at: 2 },
  );
  const row = h.last();
  assert.equal(row.id, "task-1");
  assert.equal(row.toolStatus, "preparing");
  assert.equal(row.toolArgsComplete, true);
  assert.deepEqual(row.toolArgs, { description: "Audit the parser" });

  h.send(
    started("task-1", "Task", { agent: "explorer", description: "Audit the parser" }),
    { at: 3 },
  );
  assert.equal(h.rows().filter((entry) => entry.toolCallId === "task-1").length, 1);
  assert.equal(h.rows()[2].toolStatus, "running");
  assert.equal(h.rows()[2].createdAt, row.createdAt);
});

test("a steering message sent during argument generation stays after the preparing row", () => {
  const h = harness([message("user-1", "user", "Start.")]);
  h.send(assistantStart(), { at: 1 });
  h.send(prepared(), { at: 2 });
  // Exactly what the optimistic steering insert does: the same canonical
  // upsert the queue slice calls, at the moment the user presses send.
  h.runtime.insertOptimisticUserMessage(
    "active",
    message("steer-1", "user", "Also check the docs.", { steering: true }),
  );
  assert.deepEqual(
    h.rows().map((row) => row.id),
    ["user-1", "answer", "call-1", "steer-1"],
  );
  // Arguments complete while the steering message stands after the row: the
  // preparing row still keeps its place.
  h.send(prepared("call-1", "Bash", { ready: true }), { at: 3 });
  assert.deepEqual(
    h.rows().map((row) => row.id),
    ["user-1", "answer", "call-1", "steer-1"],
  );

  h.send(assistantEnd(), { at: 4 });
  h.send(started(), { at: 5 });
  assert.deepEqual(
    h.rows().map((row) => row.id),
    ["user-1", "answer", "call-1", "steer-1"],
    "the executing call does not jump past the steering message",
  );
  assert.equal(
    h.rows().filter((row) => row.toolCallId === "call-1").length,
    1,
    "and it is still one row",
  );
});

test("a replayed tool_start updates the row instead of appending a duplicate", () => {
  const h = harness([message("user-1", "user", "Go.")]);
  h.send(assistantStart(), { at: 1 });
  h.send(prepared(), { at: 2 });
  h.send(started(), { at: 3 });
  h.send(started(), { at: 4 });
  assert.equal(h.rows().filter((row) => row.toolCallId === "call-1").length, 1);
  assert.equal(h.rows().length, 3);
});

test("an aborted or failed reply drops the calls it never ran", () => {
  for (const [label, settle] of [
    ["aborted message", (h) => h.send(assistantEnd("answer", "aborted"), { at: 3 })],
    ["failed message", (h) => h.send(assistantEnd("answer", "error"), { at: 3 })],
    [
      "terminal error event",
      (h) =>
        h.send(
          { type: "error", error: { code: "PROVIDER_ERROR", message: "stream failed" } },
          { at: 3 },
        ),
    ],
    ["closed turn", (h) => h.send({ type: "turn_end" }, { at: 3 })],
    ["ended run", (h) => h.send({ type: "agent_end", messageIds: [] }, { at: 3 })],
  ]) {
    const h = harness([message("user-1", "user", "Go.")]);
    h.send(assistantStart(), { at: 1 });
    h.send(prepared(), { at: 2 });
    // Arguments complete, but no execution ever follows.
    h.send(prepared("call-1", "Bash", { ready: true }), { at: 2 });
    assert.equal(h.rows().length, 3, `${label}: the row exists before the attempt ends`);
    settle(h);
    assert.equal(
      h.rows().some((row) => row.id === "call-1"),
      false,
      `${label}: the never-executed call is not history`,
    );
    assert.equal(
      h.rows().some((row) => row.toolStatus === "preparing"),
      false,
      `${label}: nothing stays in the preparing phase`,
    );
  }
});

test("a retry replaces the attempt's preparing row instead of stacking a second one", () => {
  const h = harness([message("user-1", "user", "Go.")]);
  h.send(assistantStart("answer"), { at: 1 });
  h.send(prepared("call-old"), { at: 2 });
  // The provider failed and the runtime retries into the same assistant
  // bubble: a fresh attempt starts with its own call ids.
  h.send({ type: "message_update", message: message("answer", "assistant", "", { status: "streaming" }) }, { at: 3 });
  h.send(assistantStart("answer"), { at: 4 });
  assert.equal(h.rows().filter((row) => row.toolStatus === "preparing").length, 0);
  h.send(prepared("call-new"), { at: 5 });
  h.send(started("call-new"), { at: 6 });
  assert.deepEqual(
    h.rows().map((row) => row.id),
    ["user-1", "answer", "call-new"],
  );
});

test("another execution's preparing rows are untouched by a turn boundary", () => {
  const h = harness([message("user-1", "user", "Delegate this.")]);
  h.send(assistantStart("answer"), { at: 1 });
  h.send(prepared("task-1", "Task", { taskTitle: "Audit the parser" }), { at: 2 });
  // A delegate's own call streams under the Task call.
  h.send(
    prepared("child-call", "Read"),
    { at: 3, parentToolCallId: "task-1", agentName: "explorer" },
  );
  const child = h.rows().find((row) => row.id === "child-call");
  assert.equal(child.parentToolCallId, "task-1");
  assert.equal(child.agentName, "explorer");
  assert.deepEqual(child.toolArgs, undefined);
  // The parent turn ends while the delegate is still writing its arguments:
  // the parent's own prepared call is dropped, the delegate's row is not.
  h.send({ type: "turn_end" }, { at: 4 });
  assert.equal(h.rows().some((row) => row.id === "task-1"), false);
  assert.equal(h.rows().some((row) => row.id === "child-call"), true);
  // The delegate's own turn boundary removes its row.
  h.send({ type: "turn_end" }, { at: 5, parentToolCallId: "task-1" });
  assert.equal(h.rows().some((row) => row.id === "child-call"), false);
});

test("a background session's preparing row lives in its own cached transcript", () => {
  const background = { sessionId: "background" };
  const h = harness([message("user-1", "user", "Go.")], []);
  h.send(assistantStart("answer"), { ...background, at: 1 });
  h.send(prepared("call-bg"), { ...background, at: 2 });
  const cached = () => h.runtime.sessionTranscriptCache.get("background");
  assert.equal(cached()?.some((row) => row.id === "call-bg" && row.toolStatus === "preparing"), true);
  assert.equal(h.rows().some((row) => row.id === "call-bg"), false, "the visible session is untouched");
  h.send(started("call-bg"), { ...background, at: 3 });
  const rows = cached();
  assert.equal(rows.filter((row) => row.toolCallId === "call-bg").length, 1);
  assert.equal(rows.find((row) => row.id === "call-bg").toolStatus, "running");
  h.send({ type: "turn_end" }, { ...background, at: 4 });
  assert.equal(
    h.runtime.sessionTranscriptCache.get("background").some((row) => row.id === "call-bg"),
    true,
    "an executed call stays",
  );
  h.send(prepared("call-bg-2"), { ...background, at: 5 });
  assert.equal(
    h.runtime.sessionTranscriptCache.get("background").some((row) => row.id === "call-bg-2"),
    true,
    "a background call is projected while its arguments stream",
  );
  h.send({ type: "agent_end", messageIds: [] }, { ...background, at: 6 });
  assert.equal(
    h.runtime.sessionTranscriptCache.get("background").some((row) => row.id === "call-bg-2"),
    false,
  );
});

test("the preparing row reaches the transcript at its chronological position", () => {
  const rows = [
    message("user-1", "user", "Read the file and delegate."),
    message("answer", "assistant", "", { status: "streaming" }),
    message("call-1", "tool", "", {
      toolCallId: "call-1",
      toolName: "Read",
      toolStatus: "preparing",
      status: "streaming",
    }),
    message("steer-1", "user", "Also the docs.", { steering: true }),
    message("call-2", "tool", "", {
      toolCallId: "call-2",
      toolName: "Task",
      toolStatus: "preparing",
      status: "streaming",
      toolArgs: { description: "Audit the parser" },
    }),
  ];
  const { entries, visible } = buildTranscriptEntries(rows);
  // An empty streaming assistant row is not a visible row of its own, so the
  // prepared call opens the turn at exactly the position it happened.
  assert.deepEqual(visible.map((row) => row.id), [
    "user-1",
    "call-1",
    "steer-1",
    "call-2",
  ]);
  // The steering message closes the turn exactly like any user row: the row
  // before it stays where it was, and the next call opens the next turn.
  assert.deepEqual(
    entries.map((entry) => (entry.kind === "message" ? `message:${entry.message.id}` : `turn:${entry.id}`)),
    ["message:user-1", "turn:call-1", "message:steer-1", "turn:call-2"],
  );
  const firstTurn = entries[1];
  assert.equal(firstTurn.parts[0].kind, "activity");
  assert.equal(firstTurn.parts[0].items[0].message.id, "call-1");
});
