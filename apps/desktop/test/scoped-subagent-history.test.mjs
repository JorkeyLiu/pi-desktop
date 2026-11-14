/**
 * A delegate tab reads its own scoped history.
 *
 * The main conversation's page budget only covers its own top-level rows, so the
 * delegate panel cannot derive its conversation, availability, or identity from
 * the main window: a chain may be older than the window, and its child rows were
 * never in it. These tests drive the public store actions that the tab consumes
 * (and the pure view helpers) with a mocked transport, and cover the reader's
 * contract: one scoped read per chain, stable identity across resume aliases,
 * paging, errors, late answers, eviction, and live child rows.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");
const {
  SUBAGENT_HISTORY_BRIDGE_PAGES,
  SUBAGENT_HISTORY_BRIDGE_STALLED,
  SUBAGENT_HISTORY_LIMIT,
  SUBAGENT_HISTORY_MESSAGE_LIMIT,
  applySubagentHistoryPage,
  createSubagentHistoryEntry,
  findSubagentHistoryEntry,
  subagentHistoryMessages,
} = await import("../src/lib/subagent-history.ts");

const stamp = (index) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();

const taskRow = (callId, delegationId) => ({
  id: `${callId}-row`,
  role: "tool",
  toolName: "Task",
  toolCallId: callId,
  toolArgs: { prompt: "delegate" },
  toolResult: { delegationId },
  content: "delegated",
  createdAt: stamp(1),
});

const childRow = (index, parentToolCallId) => ({
  id: `child-${index}`,
  role: "tool",
  toolName: "Read",
  toolCallId: `read-${index}`,
  parentToolCallId,
  toolArgs: { path: `file-${index}.ts` },
  content: `read file-${index}`,
  createdAt: stamp(index),
});

const page = (id, messages, options = {}) => ({
  session: {
    id,
    title: "Conversation",
    messages,
    messageStart: options.messageStart ?? 0,
    hasMoreBefore: options.hasMoreBefore === true,
    hasMoreAfter: options.hasMoreAfter === true,
    messageCount: options.messageCount ?? 5000,
    ...(options.messageEnd !== undefined ? { messageEnd: options.messageEnd } : {}),
    ...(options.scope ? { historyScope: options.scope } : {}),
    ...(options.context ? { historyContext: options.context } : {}),
  },
});

const delegation = (id) => ({ kind: "delegation", id });

function seedStore(sessionId) {
  useAppStore.setState({
    sessions: [
      {
        id: sessionId,
        title: "Conversation",
        mode: "agent",
        providerId: "p",
        modelId: "m",
        messageCount: 5000,
      },
    ],
    activeSessionId: null,
    messages: [],
    sessionHistory: {},
    transcriptViews: {},
    subagentHistory: {},
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
    navStack: [{ page: "chat", sessionId }],
    navIndex: 0,
    providers: [{ id: "p", enabled: true, authKind: "none", models: [{ id: "m" }] }],
    settings: { defaultProviderId: "p", defaultModelId: "m", defaultMode: "agent" },
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
  });
}

test("opening a task reads one delegation-scoped page of its own chain", async (t) => {
  const sessionId = "topic-delegate";
  seedStore(sessionId);
  const calls = [];
  const context = [taskRow("call-1", "d1")];
  t.mock.method(api, "getSession", async (id, options) => {
    calls.push({ id, options });
    return page(
      id,
      [childRow(10, "call-1"), childRow(11, "call-1")],
      {
        messageStart: 10,
        hasMoreBefore: true,
        messageCount: 5000,
        scope: delegation("d1"),
        context,
      },
    );
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  const entry = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.equal(calls.length, 1, "opening the task is one read, not a parent-page scan");
  assert.deepEqual(calls[0].options.historyScope, { kind: "delegation", id: "d1" });
  assert.equal(calls[0].options.messageLimit, 100);
  assert.equal(calls[0].options.messageBefore, undefined);
  assert.equal(entry.status, "ready");
  assert.equal(entry.scoped, true);
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-10", "child-11"],
    "only the chain's child rows are the page",
  );
  assert.deepEqual(
    entry.context.map((message) => message.id),
    ["call-1-row"],
    "the root Task record travels outside the page budget for chain identity",
  );
  assert.equal(calls[0].options.contentLimit, 64 * 1024);
});

test("the delegate detail survives the main transcript being replaced", async (t) => {
  const sessionId = "topic-delegate-stable";
  seedStore(sessionId);
  t.mock.method(api, "getSession", async (id) =>
    page(id, [childRow(10, "call-1")], {
      messageStart: 10,
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
    }),
  );

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  const before = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.equal(before.status, "ready");

  // The reader moves to another conversation, and the window that used to hold
  // the Task card and its child rows is replaced with nothing at all.
  useAppStore.setState({ activeSessionId: "another-session", messages: [] });
  const state = useAppStore.getState();
  const after = findSubagentHistoryEntry(state.subagentHistory, sessionId, "d1");
  assert.ok(after, "the chain keeps its cached page");
  assert.equal(after.status, "ready", "availability does not depend on the main viewport");
  assert.deepEqual(
    after.messages.map((message) => message.id),
    ["child-10"],
    "loaded rows are still there",
  );
  const rows = subagentHistoryMessages(after, []);
  assert.deepEqual(rows.map((message) => message.id), ["call-1-row", "child-10"]);
});

test("an older call id resolves onto the canonical chain without a second read", async (t) => {
  const sessionId = "topic-delegate-alias";
  seedStore(sessionId);
  const calls = [];
  t.mock.method(api, "getSession", async (id, options) => {
    calls.push({ id, options });
    // The backend answers a request addressed by the older call id with the
    // canonical chain identity.
    return page(id, [childRow(10, "call-1")], {
      messageStart: 10,
      scope: delegation("d2"),
      context: [taskRow("call-1", "d2")],
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "call-1" });
  const entry = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "call-1",
  );
  assert.equal(entry.canonicalId, "d2", "the echoed canonical id is adopted");
  assert.deepEqual(calls[0].options.historyScope, { kind: "delegation", id: "call-1" });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d2" });
  const resolved = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d2",
  );
  assert.equal(resolved.tabKey, "call-1", "the same entry serves both identities");
  assert.equal(calls.length, 1, "the resumed chain reuses its loaded page");
  assert.deepEqual(
    useAppStore.getState().subagentHistory[sessionId]["d2"],
    undefined,
    "one chain never duplicates into two caches",
  );
});

test("older delegate paging reads the chain's own scope and keeps order", async (t) => {
  const sessionId = "topic-delegate-paging";
  seedStore(sessionId);
  const calls = [];
  t.mock.method(api, "getSession", async (id, options) => {
    calls.push({ id, options });
    if (options?.messageBefore === undefined) {
      return page(id, [childRow(12, "call-1"), childRow(13, "call-1")], {
        messageStart: 12,
        hasMoreBefore: true,
        scope: delegation("d1"),
        context: [taskRow("call-1", "d1")],
      });
    }
    return page(id, [childRow(10, "call-1"), childRow(11, "call-1")], {
      messageStart: 10,
      hasMoreBefore: false,
      scope: delegation("d1"),
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  await useAppStore.getState().loadOlderSubagentHistory({ sessionId, tabKey: "d1" });
  const entry = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].options.historyScope, { kind: "delegation", id: "d1" });
  assert.equal(calls[1].options.messageBefore, 12, "the entry's own cursor pages backward");
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-10", "child-11", "child-12", "child-13"],
    "older rows prepend in physical order",
  );
  assert.equal(entry.messageStart, 10);
  assert.equal(entry.hasMoreBefore, false);
});

test("a failed delegate read is an explicit error state that a retry clears", async (t) => {
  const sessionId = "topic-delegate-error";
  seedStore(sessionId);
  let failures = 1;
  t.mock.method(api, "getSession", async (id) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("host unavailable");
    }
    return page(id, [childRow(10, "call-1")], {
      messageStart: 10,
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(entry.status, "error");
  assert.equal(entry.error, "host unavailable");

  await useAppStore.getState().retrySubagentHistory({ sessionId, tabKey: "d1" });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(entry.status, "ready");
  assert.equal(entry.error, undefined);
  assert.deepEqual(entry.messages.map((message) => message.id), ["child-10"]);
});

test("a late answer never overwrites a tab or session that moved on", async (t) => {
  const sessionId = "topic-delegate-late";
  seedStore(sessionId);
  let resolveRead;
  const pending = new Promise((resolve) => {
    resolveRead = resolve;
  });
  t.mock.method(api, "getSession", async () => pending);

  const request = useAppStore
    .getState()
    .ensureSubagentHistory({ sessionId, tabKey: "d1" });
  // The tab is closed and its session's cached pages released before the
  // answer lands.
  useAppStore.setState({ subagentHistory: {} });
  resolveRead(
    page(sessionId, [childRow(10, "call-1")], {
        messageStart: 10,
        scope: delegation("d1"),
        context: [taskRow("call-1", "d1")],
      }),
  );
  await request;
  assert.deepEqual(
    useAppStore.getState().subagentHistory,
    {},
    "the answer was issued for a view that no longer exists",
  );
});

test("a scoped empty page is an empty delegate, not an error", async (t) => {
  const sessionId = "topic-delegate-empty";
  seedStore(sessionId);
  t.mock.method(api, "getSession", async (id) =>
    page(id, [], { messageCount: 5000, scope: delegation("d1") }),
  );

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  const entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(entry.status, "empty");
  assert.equal(entry.error, undefined);
});

test("live child rows join the delegate view without a second read", async (t) => {
  const sessionId = "topic-delegate-live";
  seedStore(sessionId);
  const calls = [];
  t.mock.method(api, "getSession", async (id, options) => {
    calls.push({ id, options });
    return page(id, [childRow(10, "call-1")], {
      messageStart: 10,
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  const entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  const live = [
    { ...childRow(10, "call-1"), content: "read file-10 (complete)" },
    childRow(20, "call-1"),
    // An unrelated row of the parent conversation.
    { id: "u-1", role: "user", content: "hello", createdAt: stamp(1) },
  ];
  const rows = subagentHistoryMessages(entry, live);
  assert.deepEqual(
    rows.map((message) => message.id),
    ["call-1-row", "child-10", "child-20"],
    "the chain's live child is merged and the parent's own row is not",
  );
  assert.equal(
    rows.find((message) => message.id === "child-10").content,
    "read file-10 (complete)",
    "the live row is authoritative for the id it replaces",
  );
  assert.equal(calls.length, 1, "live rows cost no history read");
});

test("an unopened chain is not read and the cache stays bounded", async (t) => {
  const sessionId = "topic-delegate-lru";
  seedStore(sessionId);
  const reads = [];
  t.mock.method(api, "getSession", async (id, options) => {
    reads.push(options.historyScope.id);
    return page(id, [childRow(10, options.historyScope.id)], {
      messageStart: 10,
      scope: options.historyScope,
      context: [taskRow(`call-${options.historyScope.id}`, options.historyScope.id)],
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "c1" });
  assert.equal(sessionId && reads.length, 1);
  assert.equal(
    Object.keys(useAppStore.getState().subagentHistory[sessionId]).length,
    1,
    "only the chain that was opened is read",
  );

  for (let index = 2; index <= SUBAGENT_HISTORY_LIMIT + 1; index += 1) {
    await useAppStore.getState().ensureSubagentHistory({
      sessionId,
      tabKey: `c${index}`,
    });
  }
  const bucket = useAppStore.getState().subagentHistory[sessionId];
  assert.equal(Object.keys(bucket).length, SUBAGENT_HISTORY_LIMIT, "the cache is bounded");
  assert.equal(bucket.c1, undefined, "the least recently read chain is evicted");
  assert.ok(bucket[`c${SUBAGENT_HISTORY_LIMIT + 1}`], "the newest chain stays");
});

test("a continuation opened after the page was read joins the open tab without a reread", async (t) => {
  const sessionId = "topic-delegate-continuation";
  seedStore(sessionId);
  const calls = [];
  t.mock.method(api, "getSession", async (id, options) => {
    calls.push({ id, options });
    return page(id, [childRow(10, "call-1")], {
      messageStart: 10,
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  const entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  // The reader continues the delegate while the tab is open. The runtime appends
  // a `Task(resume …)` call and streams the new segment's child rows; the page
  // was read before that segment existed, so only the live view names it.
  const continuation = {
    id: "call-2-row",
    role: "tool",
    toolName: "Task",
    toolCallId: "call-2",
    // The runtime links a continuation by its prior call id before the new
    // segment's own backend identity lands, and by delegation id afterwards.
    toolArgs: { resume: "call-1", prompt: "continue" },
    toolResult: { details: { delegationId: "d2" } },
    content: "continued",
    createdAt: stamp(30),
  };
  const live = [
    continuation,
    childRow(31, "call-2"),
    { ...childRow(32, "call-2"), role: "assistant", content: "second segment answer" },
  ];
  const rows = subagentHistoryMessages(entry, live);
  assert.deepEqual(
    rows.map((message) => message.id),
    ["call-1-row", "child-10", "call-2-row", "child-31", "child-32"],
    "the continued segment and its child rows join the tab that already held the chain",
  );
  assert.equal(calls.length, 1, "the continuation needs no second read");
  assert.equal(entry.scoped, true, "the page is still its own scoped read");
});

const hasRows = (entry) =>
  Boolean(entry && (entry.messages.length > 0 || entry.context.length > 0));

test("live child rows are owned by the chain and survive the main window being replaced", async (t) => {
  const sessionId = "topic-delegate-owned";
  seedStore(sessionId);
  let reads = 0;
  t.mock.method(api, "getSession", async (id) => {
    reads += 1;
    return page(id, [childRow(10, "call-1")], {
      messageStart: 10,
      messageEnd: 10,
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  // Mid-run: the parent stream emits the child's delta, then its next call and
  // the delegate's final answer. Every publication is a fresh live array.
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [
      taskRow("call-1", "d1"),
      { ...childRow(10, "call-1"), content: "read file-10 (streaming)" },
    ],
  });
  useAppStore.setState({
    messages: [
      taskRow("call-1", "d1"),
      { ...childRow(10, "call-1"), content: "read file-10" },
      childRow(20, "call-1"),
      {
        id: "child-21",
        role: "assistant",
        content: "final answer of the delegate",
        parentToolCallId: "call-1",
        createdAt: stamp(21),
      },
    ],
  });
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-10", "child-20", "child-21"],
    "the chain owns every live row that belongs to it",
  );
  assert.equal(
    entry.messages.at(-1).content,
    "final answer of the delegate",
    "the run's final row is owned, not only rendered",
  );
  assert.equal(entry.finalized, false, "live rows make the cached page stale");
  assert.equal(reads, 1, "live rows cost no history read");

  // The reader's main window is replaced by a top-level-only page: nothing in
  // it names the Task card or any child row.
  useAppStore.setState({
    messages: [{ id: "u-1", role: "user", content: "hello", createdAt: stamp(30) }],
  });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(entry.status, "ready", "availability does not follow the main window");
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-10", "child-20", "child-21"],
    "loaded and live rows survive the main window losing them",
  );
  assert.equal(entry.messages.at(-1).content, "final answer of the delegate");
  assert.deepEqual(
    subagentHistoryMessages(entry, []).map((message) => message.id),
    ["call-1-row", "child-10", "child-20", "child-21"],
    "the panel and its report read the same content",
  );
});

test("a chain touched by live rows refreshes its tail once on reopen", async (t) => {
  const sessionId = "topic-delegate-refresh";
  seedStore(sessionId);
  let reads = 0;
  t.mock.method(api, "getSession", async (id) => {
    reads += 1;
    if (reads === 1) {
      return page(id, [childRow(10, "call-1")], {
        messageStart: 10,
        messageEnd: 10,
        hasMoreAfter: true,
        scope: delegation("d1"),
        context: [taskRow("call-1", "d1")],
      });
    }
    return page(
      id,
      [
        childRow(20, "call-1"),
        {
          id: "child-21",
          role: "assistant",
          content: "durable final answer",
          parentToolCallId: "call-1",
          createdAt: stamp(21),
        },
      ],
      {
        messageStart: 20,
        messageEnd: 21,
        scope: delegation("d1"),
        context: [taskRow("call-1", "d1")],
      },
    );
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [
      taskRow("call-1", "d1"),
      { ...childRow(10, "call-1"), content: "read file-10 (streaming)" },
    ],
  });
  // The main window drops everything: the entry keeps the live delta it owns.
  useAppStore.setState({ messages: [] });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  const entry = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.equal(reads, 2, "a stale chain refreshes once when it is reopened");
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-10", "child-20", "child-21"],
    "the refresh keeps what the entry held and recovers the events it missed",
  );
  assert.equal(entry.messages.at(-1).content, "durable final answer");
  assert.equal(entry.finalized, true, "a durable read finalizes the entry");
  assert.equal(entry.hasMoreAfter, false, "the tail read states the real tail");
  assert.equal(entry.messageEnd, 21);

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  assert.equal(reads, 2, "a finalized chain costs no read on reopen");
});

test("a failed tail refresh keeps the chain available with its rows", async (t) => {
  const sessionId = "topic-delegate-refresh-failure";
  seedStore(sessionId);
  let reads = 0;
  t.mock.method(api, "getSession", async (id) => {
    reads += 1;
    if (reads === 1) {
      return page(id, [childRow(10, "call-1")], {
        messageStart: 10,
        messageEnd: 10,
        hasMoreAfter: true,
        scope: delegation("d1"),
        context: [taskRow("call-1", "d1")],
      });
    }
    if (reads === 2) throw new Error("host unavailable");
    return page(
      id,
      [
        childRow(20, "call-1"),
        {
          id: "child-21",
          role: "assistant",
          content: "durable final answer",
          parentToolCallId: "call-1",
          createdAt: stamp(21),
        },
      ],
      { messageStart: 20, messageEnd: 21, scope: delegation("d1") },
    );
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [taskRow("call-1", "d1"), { ...childRow(10, "call-1"), content: "streamed" }],
  });
  useAppStore.setState({ messages: [] });
  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(reads, 2);
  assert.equal(entry.status, "ready", "a failed refresh never flips the panel to unavailable");
  assert.equal(entry.error, "host unavailable", "the failure stays diagnosable");
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-10"],
    "a failed refresh never erases the rows it already had",
  );

  await useAppStore.getState().retrySubagentHistory({ sessionId, tabKey: "d1" });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  // The retry reads the tail page, then walks backward once to join the rows
  // between it and the page the entry already held.
  assert.equal(reads, 4, "the retry repeats the tail read and joins the gap");
  assert.equal(entry.status, "ready");
  assert.equal(entry.error, undefined);
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-10", "child-20", "child-21"],
  );
});

test("a chain the host no longer knows is unavailable, not an empty delegate", async (t) => {
  const sessionId = "topic-delegate-unknown";
  seedStore(sessionId);
  let reads = 0;
  t.mock.method(api, "getSession", async (id) => {
    reads += 1;
    if (reads === 1) return { session: null };
    // A real chain with no child rows answers with its scope echo and root
    // `Task` records instead of nothing.
    return page(id, [], {
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
      messageCount: 5000,
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(entry.status, "error", "a missing chain is unavailable");
  assert.equal(entry.error, "Subagent transcript is no longer available.");
  assert.equal(hasRows(entry), false);

  await useAppStore.getState().retrySubagentHistory({ sessionId, tabKey: "d1" });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(entry.status, "empty", "a known chain with no rows is an empty delegate");
  assert.equal(entry.error, undefined);
  assert.deepEqual(entry.context.map((message) => message.id), ["call-1-row"]);
});

test("a search range reaches newer rows without losing the target or loaded rows", async (t) => {
  const sessionId = "topic-delegate-search-forward";
  seedStore(sessionId);
  const calls = [];
  t.mock.method(api, "getSession", async (id, options = {}) => {
    calls.push({ id, options });
    if (options.messageAround) {
      return page(id, [childRow(10, "call-1"), childRow(11, "call-1")], {
        messageStart: 10,
        messageEnd: 12,
        hasMoreBefore: true,
        hasMoreAfter: true,
        scope: delegation("d1"),
        context: [taskRow("call-1", "d1")],
      });
    }
    if (options.messageBefore === 30) {
      // The page between the target range and the newest page. Without it the
      // panel would show `10, 11, 30, 31` as one conversation and silently drop
      // the rows that belong between them.
      return page(id, [childRow(20, "call-1"), childRow(21, "call-1")], {
        messageStart: 20,
        messageEnd: 22,
        hasMoreBefore: true,
        hasMoreAfter: true,
        scope: delegation("d1"),
      });
    }
    if (options.messageBefore === 20) {
      return page(id, [childRow(10, "call-1"), childRow(11, "call-1")], {
        messageStart: 10,
        messageEnd: 12,
        hasMoreBefore: true,
        hasMoreAfter: true,
        scope: delegation("d1"),
      });
    }
    return page(
      id,
      [
        childRow(30, "call-1"),
        {
          id: "child-31",
          role: "assistant",
          content: "the delegate's final answer",
          parentToolCallId: "call-1",
          createdAt: stamp(31),
        },
      ],
      { messageStart: 30, messageEnd: 32, scope: delegation("d1") },
    );
  });

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-11",
    query: "final answer",
    requestId: 7,
  });
  const opened = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.equal(calls[0].options.messageAround, "child-11", "the target range is read, not the chain");
  assert.equal(calls[0].options.messageBefore, undefined);
  assert.equal(calls[0].options.historyScope.id, "d1");
  assert.equal(opened.focus.messageId, "child-11");
  assert.deepEqual(
    opened.messages.map((message) => message.id),
    ["child-10", "child-11"],
  );
  assert.equal(opened.hasMoreAfter, true, "the range states that newer rows exist");
  assert.equal(opened.messageEnd, 12);

  await useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  const merged = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.equal(calls.length, 4, "the tail read and two bridge pages, and nothing more");
  assert.equal(calls[1].options.messageAround, undefined, "the tail read centers on nothing");
  assert.equal(calls[1].options.messageBefore, undefined);
  assert.deepEqual(
    calls.slice(2).map((call) => call.options.messageBefore),
    [30, 20],
    "the bridge walks backward from the newest page to the loaded range",
  );
  assert.deepEqual(
    merged.messages.map((message) => message.id),
    ["child-10", "child-11", "child-20", "child-21", "child-30", "child-31"],
    "every selected row between the target and the tail is represented",
  );
  assert.equal(merged.focus.messageId, "child-11", "the search target keeps its focus");
  assert.equal(merged.messageStart, 10, "the older cursor does not move forward");
  assert.equal(merged.messageEnd, 32);
  assert.equal(merged.hasMoreAfter, false, "the tail has been reached");
  assert.equal(merged.hasMoreBefore, true);
  assert.equal(merged.omittedAfterId, undefined, "the joined range states no omission");
  assert.deepEqual(
    subagentHistoryMessages(merged, []).map((message) => message.id),
    ["call-1-row", "child-10", "child-11", "child-20", "child-21", "child-30", "child-31"],
  );
});

test("a chain that grows past its row budget trims the oldest rows, never the focus row", () => {
  const entry = {
    ...createSubagentHistoryEntry("topic-delegate-cap", "d1", 1),
    focus: { messageId: "child-0", query: "", requestId: 1 },
  };
  const rows = Array.from({ length: SUBAGENT_HISTORY_MESSAGE_LIMIT + 20 }, (_, index) =>
    childRow(index, "call-1"),
  );
  const applied = applySubagentHistoryPage(
    entry,
    {
      id: "topic-delegate-cap",
      title: "Conversation",
      messages: rows,
      messageStart: 0,
      messageEnd: rows.length - 1,
      hasMoreBefore: false,
      hasMoreAfter: false,
      messageCount: rows.length,
      historyScope: delegation("d1"),
      historyContext: [taskRow("call-1", "d1")],
    },
    "initial",
    1,
  );
  assert.equal(applied.messages.length, SUBAGENT_HISTORY_MESSAGE_LIMIT, "the cache is bounded");
  assert.equal(
    applied.messages[0].id,
    "child-0",
    "the focused row is kept while the oldest others are trimmed",
  );
  assert.ok(applied.messages.at(-1).id.startsWith("child-"), "the newest rows stay");
});

/** Child rows for a set of physical message indexes. */
function childRows(indices) {
  return indices.map((index) => childRow(index, "call-1"));
}

/**
 * A client-side model of a delegation-scoped read over a sparse physical
 * selection: a page holds at most 100 selected rows, `messageBefore` is the
 * physical exclusive cursor, and `messageStart`/`messageEnd` stay physical.
 * Only the transport is modelled; the reader under test is the real one.
 */
function sparseTransport({ calls, selected, window, context = [taskRow("call-1", "d1")] }) {
  return async (id, options = {}) => {
    calls.push({ id, options });
    if (options.messageAround) {
      return page(id, childRows(window), {
        messageStart: window[0],
        messageEnd: window.at(-1) + 1,
        hasMoreBefore: selected.some((index) => index < window[0]),
        hasMoreAfter: selected.some((index) => index > window.at(-1)),
        scope: delegation("d1"),
        context,
      });
    }
    const cursor = options.messageBefore;
    const eligible = cursor === undefined ? selected : selected.filter((index) => index < cursor);
    const slice = eligible.slice(-100);
    if (!slice.length) {
      return page(id, [], {
        messageStart: 0,
        messageEnd: 0,
        hasMoreBefore: false,
        hasMoreAfter: false,
        scope: delegation("d1"),
        context,
      });
    }
    return page(id, childRows(slice), {
      messageStart: slice[0],
      messageEnd: slice.at(-1) + 1,
      hasMoreBefore: selected.some((index) => index < slice[0]),
      hasMoreAfter: selected.some((index) => index > slice.at(-1)),
      scope: delegation("d1"),
      context,
    });
  };
}

test("the tail sync bridges every sparse page between the target and the newest rows", async (t) => {
  const sessionId = "topic-delegate-sparse-bridge";
  seedStore(sessionId);
  const target = Array.from({ length: 10 }, (_, offset) => 1000 + offset);
  const blocks = [3000, 7000].map((start) =>
    Array.from({ length: 100 }, (_, offset) => start + offset),
  );
  const tail = Array.from({ length: 100 }, (_, offset) => 9900 + offset);
  // The physical transcript spans 1000…10000; only these rows belong to the chain.
  const selected = [...target, ...blocks.flat(), ...tail];
  const calls = [];
  t.mock.method(api, "getSession", sparseTransport({ calls, selected, window: target }));

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-1005",
    query: "final answer",
    requestId: 3,
  });
  await useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  const entry = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  const observed = calls.map((call) =>
    call.options.messageAround ? "around" : call.options.messageBefore ?? "tail",
  );
  assert.deepEqual(
    observed,
    ["around", "tail", 9900, 7000, 3000],
    "the tail read, then one backward read per sparse page, each in the chain's scope",
  );
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    [...target, ...blocks.flat(), ...tail].map((index) => `child-${index}`),
    "every selected row between the target and the tail is represented",
  );
  assert.equal(entry.focus.messageId, "child-1005", "the search target keeps its focus");
  assert.equal(entry.messageStart, 1000, "the oldest loaded row's cursor stays where it was");
  assert.equal(entry.messageEnd, 10000);
  assert.equal(entry.hasMoreAfter, false, "only a joined walk states the real tail");
  assert.equal(entry.hasMoreBefore, false);
  assert.equal(entry.omittedAfterId, undefined, "a joined range states no omission");
  assert.equal(
    subagentHistoryMessages(entry, []).map((message) => message.id).length,
    entry.messages.length + 1,
    "the joined rows read as one conversation under the chain's root Task",
  );
});

test("a tail sync that cannot move closer stops with an error and keeps its rows", async (t) => {
  const sessionId = "topic-delegate-stall";
  seedStore(sessionId);
  const calls = [];
  t.mock.method(api, "getSession", async (id, options = {}) => {
    calls.push({ id, options });
    if (options.messageAround) {
      return page(id, [childRow(10, "call-1"), childRow(11, "call-1")], {
        messageStart: 10,
        messageEnd: 12,
        hasMoreBefore: true,
        hasMoreAfter: true,
        scope: delegation("d1"),
        context: [taskRow("call-1", "d1")],
      });
    }
    // The scope answers the same newest page for every cursor it is sent.
    return page(id, [childRow(30, "call-1")], {
      messageStart: 30,
      messageEnd: 31,
      hasMoreBefore: true,
      hasMoreAfter: false,
      scope: delegation("d1"),
    });
  });

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-11",
    query: "",
    requestId: 1,
  });
  await useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  let entry = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.equal(calls.length, 3, "the tail read and one attempt that made no progress");
  assert.equal(entry.status, "ready", "the loaded rows stay available");
  assert.equal(entry.error, SUBAGENT_HISTORY_BRIDGE_STALLED);
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-10", "child-11"],
    "a stalled bridge never erases what the entry held",
  );
  assert.equal(entry.hasMoreAfter, true, "an unjoined gap is never stated as the tail");
  assert.equal(entry.retryDirection, "latest", "the failure names the read to repeat");

  await useAppStore.getState().retrySubagentHistory({ sessionId, tabKey: "d1" });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(calls.length, 5, "the retry repeats the same bounded attempt, not a loop");
  assert.equal(entry.error, SUBAGENT_HISTORY_BRIDGE_STALLED);
  assert.deepEqual(entry.messages.map((message) => message.id), ["child-10", "child-11"]);
  assert.equal(entry.hasMoreAfter, true);
});

test("a gap wider than one sync keeps a contiguous newest window and states the omission", async (t) => {
  const sessionId = "topic-delegate-wide-gap";
  seedStore(sessionId);
  const target = [10, 11];
  const blocks = Array.from({ length: 23 }, (_, block) =>
    Array.from({ length: 100 }, (_, offset) => 100 + block * 100 + offset),
  );
  const selected = [...target, ...blocks.flat()];
  const calls = [];
  t.mock.method(api, "getSession", sparseTransport({ calls, selected, window: target }));

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-11",
    query: "",
    requestId: 2,
  });
  await useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  let entry = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.equal(
    calls.length,
    2 + SUBAGENT_HISTORY_BRIDGE_PAGES,
    "one tail read and no more than the bounded walk",
  );
  assert.ok(
    entry.messages.length <= SUBAGENT_HISTORY_MESSAGE_LIMIT,
    "the retained window stays inside the row budget",
  );
  assert.equal(entry.messages[0].id, "child-11", "the focus survives as its own retained range");
  assert.equal(entry.omittedAfterId, "child-11", "the omission is stated at the retained row");
  assert.deepEqual(
    entry.messages.slice(1, 3).map((message) => message.id),
    ["child-2200", "child-2201"],
    "the retained rows are one contiguous newest run",
  );
  assert.equal(entry.messages.length, 201, "the window leaves room for one older page");
  assert.equal(entry.messageStart, 2200, "older paging resumes at the window's own first row");
  assert.equal(entry.messageEnd, 2400);
  assert.equal(entry.hasMoreAfter, false, "the window reaches the tail");
  assert.equal(entry.hasMoreBefore, true, "the dropped rows are still reachable");

  await useAppStore.getState().loadOlderSubagentHistory({ sessionId, tabKey: "d1" });
  const paged = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.equal(
    calls.at(-1).options.messageBefore,
    2200,
    "ordinary paging walks the gap from the window's first row",
  );
  assert.equal(paged.omittedAfterId, "child-11", "the omission stays stated while the gap is paged");
  const view = subagentHistoryMessages(paged, []).map((message) => message.id);
  assert.deepEqual(
    view.slice(0, 3),
    ["call-1-row", "child-11", "child-2100"],
    "the page the window left out is read without skipping a row",
  );

  await useAppStore.getState().loadOlderSubagentHistory({ sessionId, tabKey: "d1" });
  assert.equal(calls.at(-1).options.messageBefore, 2100, "each step moves one page closer");
  const next = subagentHistoryMessages(
    findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1"),
    [],
  ).map((message) => message.id);
  assert.ok(next.includes("child-2050"), "repeated older paging keeps walking the gap's rows");
  assert.equal(next[1], "child-11", "the focus range is never dropped while the gap is paged");
});
