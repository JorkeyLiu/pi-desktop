/**
 * A topic whose physical tail is one long delegation chain must not open blank.
 *
 * The turn stream renders only top-level rows and hangs delegate rows under the
 * `Task` call that spawned them. A bounded tail read can therefore contain
 * nothing renderable at all — the user turn and the parent `Task` lie just
 * before the window — so the pane has no row to draw and no reader affordance
 * from which to ask for history. Selection must keep walking the existing
 * bounded pagination backwards until renderable history is inside the window or
 * the real head is reached, while keeping the collected delegate rows.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");
const { getTranscriptProjection } = await import(
  "../src/lib/transcript-projection.ts"
);
const { mergeOlderTranscriptWindow } = await import(
  "../src/lib/session-transcript-read.ts"
);

const stamp = (index) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();

const child = (index, parentToolCallId = "task-parent") => ({
  id: `child-${index}`,
  role: "tool",
  toolName: "Read",
  toolCallId: `read-${index}`,
  parentToolCallId,
  toolArgs: { path: `file-${index}.ts` },
  content: `read file-${index}`,
  createdAt: stamp(index),
});

const userRow = (index) => ({
  id: "u-start",
  role: "user",
  content: "Review the repository and delegate the work",
  createdAt: stamp(index),
});

const taskRow = (index) => ({
  id: "task-parent",
  role: "tool",
  toolName: "Task",
  toolCallId: "task-parent",
  toolArgs: { prompt: "delegate the review" },
  content: "delegated",
  createdAt: stamp(index),
});

const rows = (from, to, options = {}) =>
  Array.from({ length: to - from + 1 }, (_, offset) => {
    const index = from + offset;
    if (index === options.userAt) return userRow(index);
    if (index === options.taskAt) return taskRow(index);
    return child(index);
  });

const sessionPage = (id, messages, options = {}) => ({
  session: {
    id,
    title: "Delegation chain",
    messages,
    messageStart: options.messageStart ?? 0,
    ...(options.messageEnd === undefined ? {} : { messageEnd: options.messageEnd }),
    hasMoreBefore: options.hasMoreBefore === true,
    hasMoreAfter: options.hasMoreAfter === true,
    messageCount: options.messageCount ?? 400,
  },
});

function seedStore(id) {
  useAppStore.setState({
    sessions: [
      {
        id,
        title: "Delegation chain",
        mode: "agent",
        providerId: "p",
        modelId: "m",
        messageCount: 400,
      },
    ],
    activeSessionId: null,
    messages: [],
    sessionHistory: {},
    retainedSessionIds: [],
    retainedTranscripts: {},
    sessionMeta: {},
    sessionCompactions: {},
    planningStates: {},
    pendingPlans: {},
    notifications: [],
    sessionOutcomes: {},
    runningSessions: {},
    selectingSessionId: undefined,
    isRunning: false,
    page: "chat",
    workspace: null,
    activeProjectPath: undefined,
    draftConfiguration: null,
    navStack: [{ page: "chat", sessionId: id }],
    navIndex: 0,
    providers: [{ id: "p", enabled: true, authKind: "none", models: [{ id: "m" }] }],
    settings: { defaultProviderId: "p", defaultModelId: "m", defaultMode: "agent" },
    // The reads a selection would hydrate beside the transcript are not this claim.
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
  });
}

/** Serve `session.get` from physical pages keyed by the `messageBefore` cursor. */
function serve(t, pages, calls) {
  t.mock.method(api, "getSession", async (id, options) => {
    calls.push({ id, before: options?.messageBefore, limit: options?.messageLimit });
    const key = options?.messageBefore === undefined ? "tail" : String(options.messageBefore);
    const page = pages[key];
    assert.ok(page, `unexpected history read before ${key}`);
    return page;
  });
}

test("a child-only tail keeps reading backwards until a renderable turn arrives", async (t) => {
  const id = "topic-child-only-chain";
  seedStore(id);
  const calls = [];
  serve(
    t,
    {
      tail: sessionPage(id, rows(254, 353), {
        messageStart: 254,
        messageEnd: 353,
        hasMoreBefore: true,
        hasMoreAfter: false,
      }),
      "254": sessionPage(id, rows(154, 253), {
        messageStart: 154,
        hasMoreBefore: true,
      }),
      "154": sessionPage(id, rows(54, 153), {
        messageStart: 54,
        hasMoreBefore: true,
      }),
      "54": sessionPage(id, rows(0, 53, { userAt: 52, taskAt: 53 }), {
        messageStart: 0,
        hasMoreBefore: false,
      }),
    },
    calls,
  );

  await useAppStore.getState().selectSession(id);
  const state = useAppStore.getState();
  assert.equal(state.activeSessionId, id);
  const projection = getTranscriptProjection(state.messages);
  assert.ok(
    projection.entries.length > 0,
    "a selectable topic must render at least one transcript row",
  );
  assert.deepEqual(
    calls.map((call) => call.before),
    [undefined, 254, 154, 54],
    "the initial tail read is bounded and each older read uses the window cursor",
  );
  assert.ok(
    calls.slice(1).every((call) => call.limit === 100),
    "older reads stay bounded",
  );
  assert.ok(
    projection.visible.some((message) => message.id === "u-start"),
    "the older user turn is the visible history the pane opens on",
  );
  assert.ok(
    projection.entries.every(
      (entry) => entry.kind !== "message" || !entry.message.parentToolCallId,
    ),
    "delegate rows stay under their Task card instead of becoming rows",
  );
  assert.equal(
    state.messages.filter((message) => message.parentToolCallId).length,
    352,
    "every collected delegate row is preserved for the subagent transcript",
  );
  assert.deepEqual(
    state.sessionHistory[id],
    { messageStart: 0, hasMoreBefore: false, contentLimited: true },
    "the window keeps the oldest physical cursor and the exhausted head flag",
  );
});

test("an already renderable tail is served by a single bounded read", async (t) => {
  const id = "topic-renderable-tail";
  seedStore(id);
  const calls = [];
  serve(
    t,
    {
      tail: sessionPage(id, [...rows(254, 352), userRow(353)], {
        messageStart: 254,
        messageEnd: 353,
        hasMoreBefore: true,
        hasMoreAfter: true,
      }),
    },
    calls,
  );

  await useAppStore.getState().selectSession(id);
  const state = useAppStore.getState();
  assert.equal(calls.length, 1, "a normal topic must keep one read");
  assert.equal(state.messages.length, 100, "the tail is not widened unnecessarily");
  assert.ok(getTranscriptProjection(state.messages).entries.length > 0);
  assert.deepEqual(
    state.sessionHistory[id],
    { messageStart: 254, hasMoreBefore: true, contentLimited: true },
    "the original tail window metadata is preserved",
  );
});

test("an exhausted child-only history stops at the real head", async (t) => {
  const id = "topic-child-only-head";
  seedStore(id);
  const calls = [];
  serve(
    t,
    {
      tail: sessionPage(id, rows(100, 199), {
        messageStart: 100,
        messageEnd: 199,
        hasMoreBefore: true,
        hasMoreAfter: false,
      }),
      "100": sessionPage(id, rows(0, 99), {
        messageStart: 0,
        hasMoreBefore: false,
      }),
    },
    calls,
  );

  await useAppStore.getState().selectSession(id);
  const state = useAppStore.getState();
  assert.deepEqual(
    calls.map((call) => call.before),
    [undefined, 100],
    "reaching the head ends the backward walk",
  );
  assert.equal(state.activeSessionId, id);
  assert.equal(state.messages.length, 200, "both physical pages are kept");
  assert.equal(
    state.messages.filter((message) => message.parentToolCallId).length,
    200,
    "the collected delegate rows are intact",
  );
  assert.deepEqual(
    state.sessionHistory[id],
    { messageStart: 0, hasMoreBefore: false, contentLimited: true },
  );
});

test("a cursor that makes no progress cannot loop the reader", async (t) => {
  const id = "topic-stuck-cursor";
  seedStore(id);
  const calls = [];
  serve(
    t,
    {
      tail: sessionPage(id, rows(100, 199), {
        messageStart: 100,
        messageEnd: 199,
        hasMoreBefore: true,
      }),
      "100": sessionPage(id, rows(0, 99), {
        messageStart: 100,
        hasMoreBefore: true,
      }),
    },
    calls,
  );

  await useAppStore.getState().selectSession(id);
  assert.deepEqual(
    calls.map((call) => call.before),
    [undefined, 100],
    "a same-offset page is not followed by another identical request",
  );
  assert.equal(useAppStore.getState().activeSessionId, id);
});

test("merging an older page keeps the tail window and de-duplicates the boundary", () => {
  const tail = sessionPage("s", [child(2), child(3)], {
    messageStart: 2,
    messageEnd: 9,
    hasMoreBefore: true,
    hasMoreAfter: false,
    messageCount: 10,
  });
  const older = sessionPage(
    "s",
    [child(0), child(1), { ...child(2), content: "stale boundary copy" }],
    { messageStart: 0, hasMoreBefore: false },
  );

  const merged = mergeOlderTranscriptWindow(tail.session, older.session);
  assert.deepEqual(
    merged.messages.map((message) => message.id),
    ["child-0", "child-1", "child-2", "child-3"],
    "a row repeated at the page boundary keeps one chronological position",
  );
  assert.equal(
    merged.messages.find((message) => message.id === "child-2").content,
    "read file-2",
    "the tail's canonical value wins the duplicate",
  );
  assert.equal(merged.messageStart, 0, "the backward edge moves to the older page");
  assert.equal(merged.hasMoreBefore, false, "the older page owns the head flag");
  assert.equal(merged.messageEnd, 9, "the original tail end is preserved");
  assert.equal(merged.hasMoreAfter, false, "the original tail hasMoreAfter is preserved");
  assert.equal(merged.messageCount, 10, "the session summary stays intact");
  assert.equal(merged.title, "Delegation chain");
});

test("a non-progress page or a missing page cannot widen the window", () => {
  const tail = sessionPage("s", [child(3)], {
    messageStart: 3,
    hasMoreBefore: true,
  });
  assert.equal(
    mergeOlderTranscriptWindow(
      tail.session,
      sessionPage("s", [child(0)], { messageStart: 3, hasMoreBefore: true })
        .session,
    ),
    null,
    "a same-offset page offers no progress",
  );
  assert.equal(
    mergeOlderTranscriptWindow(
      tail.session,
      sessionPage("s", [child(0)], { messageStart: 4, hasMoreBefore: true })
        .session,
    ),
    null,
    "a forward-offset page cannot be read as older history",
  );
  assert.equal(mergeOlderTranscriptWindow(tail.session, null), null);
});
