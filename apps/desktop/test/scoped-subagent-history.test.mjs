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
  SUBAGENT_HISTORY_LIMIT,
  SUBAGENT_HISTORY_LIVE_TAIL_LIMIT,
  SUBAGENT_HISTORY_PAGE_SIZE,
  applySubagentHistoryPage,
  applySubagentLiveRows,
  createSubagentHistoryEntry,
  findSubagentHistoryEntry,
  subagentHistoryIsFollowing,
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
test("a live Task whose durable row has not landed yet stays pending, then loads it", async (t) => {
  const sessionId = "topic-delegate-live-durable-race";
  seedStore(sessionId);
  const runningTask = { ...taskRow("call-1", "d1"), toolStatus: "running", status: "streaming" };
  const settledTask = { ...taskRow("call-1", "d1"), toolStatus: "success", status: "complete" };
  // The parent published the running `Task` card and its first child row before
  // host-core appended the `Task` row: the live tab exists, the durable chain
  // does not yet.
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [runningTask, childRow(10, "call-1")],
  });
  let reads = 0;
  t.mock.method(api, "getSession", async (id) => {
    reads += 1;
    if (reads === 1) return { session: null };
    return page(id, [childRow(10, "call-1")], {
      messageStart: 10,
      hasMoreBefore: true,
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(reads, 1);
  assert.equal(entry.status, "ready", "live rows are the delegate's own conversation");
  assert.equal(
    entry.error,
    undefined,
    "a chain whose durable Task row is still queued is not unavailable",
  );
  assert.equal(entry.pendingDurable, true, "the first durable read is still owed");
  assert.deepEqual(
    subagentHistoryMessages(entry, useAppStore.getState().messages).map((message) => message.id),
    ["call-1-row", "child-10"],
    "the text the reader sees is the live dispatch and its first row",
  );

  // The `Task` call settles. Its durable row is appended behind the completion
  // event; the tab reads its first durable page on that transition instead of
  // waiting for the reader to reopen it.
  useAppStore.setState({ messages: [settledTask, childRow(10, "call-1"), childRow(20, "call-1")] });
  await new Promise((resolve) => setImmediate(resolve));
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(reads, 2, "the settled Task converges the panel to its durable page");
  assert.equal(entry.error, undefined);
  assert.equal(entry.pendingDurable, false);
  assert.equal(entry.scoped, true, "the durable page replaced the pending live-only range");
  assert.equal(entry.messageStart, 10, "the first durable page adopts the chain's own cursor");
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-10", "child-20"],
    "the durable row and the live row that outran it are one conversation, not duplicates",
  );
});

test("a settled live Task the host still cannot resolve is unavailable", async (t) => {
  const sessionId = "topic-delegate-live-settled-unknown";
  seedStore(sessionId);
  const settledTask = { ...taskRow("call-1", "d1"), toolStatus: "success", status: "complete" };
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [settledTask, childRow(10, "call-1")],
  });
  t.mock.method(api, "getSession", async () => ({ session: null }));

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  const entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(entry.status, "error", "a settled chain the transcript lacks is a real miss");
  assert.equal(
    entry.error,
    "Subagent transcript is no longer available.",
    "a settled chain the durable transcript does not hold is a real miss",
  );
  assert.equal(entry.pendingDurable, false);
});
test("a pending chain survives the main window moving and converges on reactivation", async (t) => {
  const sessionId = "topic-delegate-live-window-move";
  seedStore(sessionId);
  const runningTask = { ...taskRow("call-1", "d1"), toolStatus: "running", status: "streaming" };
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [runningTask, childRow(10, "call-1")],
  });
  let reads = 0;
  t.mock.method(api, "getSession", async (id) => {
    reads += 1;
    if (reads === 1) return { session: null };
    return page(id, [childRow(10, "call-1")], {
      messageStart: 10,
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(entry.status, "ready");
  assert.equal(entry.pendingDurable, true);
  assert.equal(reads, 1);

  // The reader pages the main transcript to an older range, so the dispatch that
  // proves the chain exists is no longer in the window. That is not evidence the
  // chain is gone: the pending state stands and no row-by-row read is spent.
  useAppStore.setState({ messages: [{ ...childRow(60, "seed"), toolCallId: "seed-60" }] });
  await new Promise((resolve) => setImmediate(resolve));
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(reads, 1, "a window move is not a reason to read again");
  assert.equal(entry.status, "ready", "the live rows stay readable");
  assert.equal(entry.pendingDurable, true, "the first durable page is still owed");

  // Leaving the conversation and coming back re-offers it: the dispatch may have
  // settled while it was off screen and its durable row is on disk now.
  useAppStore.setState({ activeSessionId: "another-session", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [{ ...childRow(61, "seed"), toolCallId: "seed-61" }],
  });
  for (let step = 0; step < 4; step += 1) await new Promise((resolve) => setImmediate(resolve));
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(reads, 2, "one read per reactivation, not one per publication");
  assert.equal(entry.status, "ready");
  assert.equal(entry.error, undefined);
  assert.equal(entry.pendingDurable, false);
  assert.equal(entry.scoped, true, "the owed first durable page finally lands");
});

test("a reopened tab retries the owed page without the parent's window", async (t) => {
  const sessionId = "topic-delegate-live-reopen";
  seedStore(sessionId);
  const runningTask = { ...taskRow("call-1", "d1"), toolStatus: "running", status: "streaming" };
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [runningTask, childRow(10, "call-1")],
  });
  let reads = 0;
  t.mock.method(api, "getSession", async (id) => {
    reads += 1;
    if (reads === 1) return { session: null };
    return page(id, [childRow(10, "call-1"), childRow(20, "call-1")], {
      messageStart: 10,
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
    });
  });

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(reads, 1);
  assert.equal(entry.pendingDurable, true);

  // The reader pages the main transcript past the dispatch, then closes and
  // reopens the tab. That lifecycle point retries the owed page without
  // consulting the parent's window, and only once.
  useAppStore.setState({ messages: [{ ...childRow(60, "seed"), toolCallId: "seed-60" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, "a window move is not a reopen");
  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(reads, 2, "a reopen retries the owed page once, never per row");
  assert.equal(entry.status, "ready");
  assert.equal(entry.error, undefined);
  assert.equal(entry.pendingDurable, false);
  assert.equal(entry.scoped, true, "the reopened tab adopts the durable page");
});

test("a dispatch that settles while the first read is in flight rereads once", async (t) => {
  const sessionId = "topic-delegate-live-settle-during-read";
  seedStore(sessionId);
  const runningTask = { ...taskRow("call-1", "d1"), toolStatus: "running", status: "streaming" };
  const settledTask = { ...taskRow("call-1", "d1"), toolStatus: "success", status: "complete" };
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [runningTask, childRow(10, "call-1")],
  });
  let reads = 0;
  let releaseFirst;
  const firstAnswer = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  t.mock.method(api, "getSession", async (id) => {
    reads += 1;
    if (reads === 1) return firstAnswer;
    return page(id, [childRow(10, "call-1"), childRow(20, "call-1")], {
      messageStart: 10,
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
    });
  });

  const opening = useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  await new Promise((resolve) => setImmediate(resolve));
  // The dispatch ends while that read is still unanswered.
  useAppStore.setState({
    messages: [settledTask, childRow(10, "call-1"), childRow(20, "call-1")],
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst({ session: null });
  await opening;

  const entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(reads, 2, "one more read for the settlement the first answer never saw");
  assert.equal(entry.status, "ready");
  assert.equal(entry.error, undefined);
  assert.equal(entry.pendingDurable, false);
  assert.equal(entry.scoped, true);
  assert.deepEqual(
    subagentHistoryMessages(entry, useAppStore.getState().messages).map((message) => message.id),
    ["call-1-row", "child-10", "child-20"],
    "the durable page and the live tail are one conversation",
  );
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
  t.mock.method(api, "getSession", async (id, options = {}) => {
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
    if (options.messageBefore === 20) {
      // The range the refreshed window left behind is one ordinary older read.
      return page(id, [childRow(10, "call-1")], {
        messageStart: 10,
        messageEnd: 11,
        hasMoreBefore: false,
        hasMoreAfter: true,
        scope: delegation("d1"),
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
        hasMoreBefore: true,
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
  let entry = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.equal(reads, 2, "a stale chain refreshes once when it is reopened");
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-20", "child-21"],
    "the tail read replaces the target range instead of stating a gap",
  );
  assert.equal(entry.messages.at(-1).content, "durable final answer");
  assert.equal(entry.finalized, true, "a durable read finalizes the entry");
  assert.equal(entry.hasMoreAfter, false, "the tail read states the real tail");
  assert.equal(entry.messageEnd, 21);
  assert.equal(entry.hasMoreBefore, true, "the rows before the window stay reachable");

  // The interval the refresh left behind is reached by ordinary older paging,
  // from the refreshed window's own cursor.
  await useAppStore.getState().loadOlderSubagentHistory({ sessionId, tabKey: "d1" });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(reads, 3);
  assert.deepEqual(entry.pages.map((held) => held.start), [10, 20]);
  assert.deepEqual(entry.messages.map((message) => message.id), [
    "child-10",
    "child-20",
    "child-21",
  ]);
  assert.equal(entry.messageStart, 10);

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  assert.equal(reads, 3, "a finalized chain costs no read on reopen");
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
  // The retry repeats the read that failed: the tail page, once.
  assert.equal(reads, 3, "the retry repeats the tail read");
  assert.equal(entry.status, "ready");
  assert.equal(entry.error, undefined);
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    ["child-20", "child-21"],
    "the retried tail page becomes the contiguous window",
  );
  assert.equal(entry.pages.length, 1);
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

test("a search range switches the window to the target and newer rows page forward", async (t) => {
  const sessionId = "topic-delegate-search-forward";
  seedStore(sessionId);
  const calls = [];
  const selected = Array.from({ length: 1000 }, (_, index) => index);
  t.mock.method(
    api,
    "getSession",
    sparseTransport({
      calls,
      selected,
      window: Array.from({ length: 100 }, (_, offset) => 400 + offset),
    }),
  );
  const entryOf = () =>
    findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-450",
    query: "final answer",
    requestId: 7,
  });
  const opened = entryOf();
  assert.equal(calls[0].options.messageAround, "child-450", "the target range is read, not the chain");
  assert.equal(calls[0].options.messageBefore, undefined);
  assert.equal(calls[0].options.historyScope.id, "d1");
  assert.equal(opened.focus.messageId, "child-450");
  assert.deepEqual(opened.messages.map((message) => message.id), childRows(
    Array.from({ length: 100 }, (_, offset) => 400 + offset),
  ).map((row) => row.id));
  assert.equal(opened.messageStart, 400, "the window starts at the target's page");
  assert.equal(opened.messageEnd, 500);
  assert.equal(opened.hasMoreAfter, true, "the range states that newer rows exist");

  // Reaching the bottom pages forward, the direction the main transcript uses.
  await useAppStore.getState().loadNewerSubagentHistory({ sessionId, tabKey: "d1" });
  const forward = entryOf();
  assert.equal(calls.at(-1).options.messageBefore, 600, "the forward cursor is the window's end plus a page");
  assert.deepEqual(forward.pages.map((held) => held.start), [400, 500]);
  assert.equal(forward.messageEnd, 600);
  assert.equal(forward.messageStart, 400, "the target's page stays in the window");
  await useAppStore.getState().loadNewerSubagentHistory({ sessionId, tabKey: "d1" });
  assert.deepEqual(entryOf().pages.map((held) => held.start), [400, 500, 600]);

  // Jumping to the latest replaces the whole range: the reader asked for the
  // tail, not for the rows between the target and it.
  await useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  const merged = entryOf();
  assert.equal(calls.at(-1).options.messageBefore, undefined, "the latest read centers on nothing");
  assert.deepEqual(merged.pages.map((held) => held.start), [900], "the tail page is the window");
  assert.equal(merged.focus.messageId, "child-450", "the search target keeps its focus");
  assert.equal(merged.messageStart, 900);
  assert.equal(merged.messageEnd, 1000);
  assert.equal(merged.hasMoreAfter, false, "the tail has been reached");
  assert.equal(merged.hasMoreBefore, true);
  assert.equal("omittedAfterId" in merged, false, "the window states no omission: it is one range");
  const view = subagentHistoryMessages(merged, [])
    .map((message) => message.id)
    .filter((id) => id.startsWith("child-"));
  assert.ok(
    view.every((id, index) => id === `child-${900 + index}`),
    "the view is one contiguous interval after the jump",
  );
});

/*
 * A single answer wider than the page size is the range the read asked for.
 * A sparse page has no per-row physical index, so trimming rows off its oldest
 * side would leave the entry's older cursor naming rows it no longer holds —
 * the skip the contiguous window exists to prevent. The window therefore keeps
 * whole pages and this page stays whole; the declared page size (100) is what
 * bounds ordinary paging, and only a legacy answer wider than that reaches this
 * case.
 */
test("a single wide page is kept whole, and its own bounds stay the cursor", () => {
  const entry = {
    ...createSubagentHistoryEntry("topic-delegate-wide-page", "d1", 1),
    focus: { messageId: "child-0", query: "", requestId: 1 },
  };
  // Wider than one page: a legacy or already-joined answer is a range the
  // reader asked to see, so nothing trims it down to the page size.
  const rows = Array.from({ length: SUBAGENT_HISTORY_PAGE_SIZE * 4 + 20 }, (_, index) =>
    childRow(index, "call-1"),
  );
  const applied = applySubagentHistoryPage(
    entry,
    {
      id: "topic-delegate-wide-page",
      title: "Conversation",
      messages: rows,
      messageStart: 0,
      messageEnd: rows.length,
      hasMoreBefore: false,
      hasMoreAfter: false,
      messageCount: rows.length,
      historyScope: delegation("d1"),
      historyContext: [taskRow("call-1", "d1")],
    },
    "focus",
    1,
  );
  assert.equal(applied.messages.length, rows.length, "the wide page is kept whole");
  assert.equal(applied.messageStart, 0, "the older cursor is the page's own start");
  assert.equal(applied.messageEnd, rows.length, "the window's end is the page's own exclusive end");
  assert.equal(applied.hasMoreBefore, false);
  assert.equal(applied.hasMoreAfter, false);
  assert.equal(applied.pages.length, 1, "the window states the one page it holds");
  assert.equal(applied.pages[0].ids.length, rows.length);
  // What the cursor promises is exactly what the entry holds: the next older
  // read starts at the oldest physical row this window reaches, so no row
  // between the cursor and the page is skipped.
  const rendered = subagentHistoryMessages(applied, []).filter((row) => row.id.startsWith("child-"));
  assert.equal(rendered.length, rows.length);
  assert.equal(rendered[0].id, "child-0", "the focused row is not trimmed away");
  assert.equal(rendered.at(-1).id, `child-${rows.length - 1}`);
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

test("a latest page that overlaps the held window joins it instead of replacing it", () => {
  const detail = (start, count, extra = {}) => ({
    id: "topic-delegate-overlap",
    title: "Conversation",
    messages: childRows(Array.from({ length: count }, (_, offset) => start + offset)),
    messageStart: start,
    messageEnd: start + count,
    hasMoreBefore: start > 0,
    hasMoreAfter: false,
    messageCount: 5000,
    historyScope: delegation("d1"),
    historyContext: [taskRow("call-1", "d1")],
    ...extra,
  });
  let entry = createSubagentHistoryEntry("topic-delegate-overlap", "d1", 1);
  entry = applySubagentHistoryPage(entry, detail(600, 100), "initial", 1);
  entry = applySubagentHistoryPage(entry, detail(500, 100), "before", 2);
  assert.deepEqual(entry.pages.map((held) => held.start), [500, 600]);

  // The tail page starts inside the held range: its rows overlap what is
  // already here, so the two ranges are provably one interval.
  entry = applySubagentHistoryPage(entry, detail(650, 100), "latest", 3);
  assert.deepEqual(entry.pages.map((held) => held.start), [500, 600, 650]);
  assert.equal(entry.messageStart, 500, "the older cursor does not move");
  assert.equal(entry.messageEnd, 750, "the window now ends at the newest page");
  assert.equal(entry.hasMoreAfter, false);
  assert.equal(entry.hasMoreBefore, true);
  const view = subagentHistoryMessages(entry, [])
    .map((message) => message.id)
    .filter((id) => id.startsWith("child-"));
  assert.equal(view.length, 250, "the overlapping page adds its new rows only");
  assert.ok(
    view.every((id, index) => id === `child-${500 + index}`),
    "the joined rows are one contiguous selection",
  );
});

test("the jump to latest spends one read and never walks a gap", async (t) => {
  const sessionId = "topic-delegate-one-tail-read";
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
    // The scope answers the same newest page for every request it is sent.
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
  assert.equal(calls.length, 2, "the focus read and one tail read");
  assert.equal(entry.status, "ready", "the panel stays available");
  assert.equal(entry.error, undefined, "a distant tail is not an error");
  assert.deepEqual(entry.pages.map((held) => held.start), [30], "the tail page is the window");
  assert.deepEqual(entry.messages.map((message) => message.id), ["child-30"]);
  assert.equal(entry.hasMoreAfter, false, "the read states the real tail");

  // A second latest read re-reads the same page: it replaces the copy of that
  // range instead of doubling it or walking backwards again.
  await useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(calls.length, 3, "one read per latest request");
  assert.equal(entry.pages.length, 1);
  assert.deepEqual(entry.messages.map((message) => message.id), ["child-30"]);
});

test("forward paging reads from the window's own end and stops when a page gains nothing", async (t) => {
  const sessionId = "topic-delegate-forward";
  seedStore(sessionId);
  const calls = [];
  let stalled = true;
  const pageOf = (id, rows, extra) =>
    page(id, rows.map((index) => childRow(index, "call-1")), {
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
      ...extra,
    });
  t.mock.method(api, "getSession", async (id, options = {}) => {
    calls.push({ id, options });
    if (options.messageAround) {
      return pageOf(
        id,
        Array.from({ length: 100 }, (_, offset) => 100 + offset),
        { messageStart: 100, messageEnd: 200, hasMoreBefore: true, hasMoreAfter: true },
      );
    }
    if (stalled) {
      // The answer repeats rows the window already holds.
      return pageOf(
        id,
        Array.from({ length: 100 }, (_, offset) => 100 + offset),
        { messageStart: 100, messageEnd: 200, hasMoreBefore: true, hasMoreAfter: true },
      );
    }
    return pageOf(
      id,
      Array.from({ length: 100 }, (_, offset) => 200 + offset),
      { messageStart: 200, messageEnd: 300, hasMoreBefore: true, hasMoreAfter: false },
    );
  });

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-150",
    query: "",
    requestId: 1,
  });
  await useAppStore.getState().loadNewerSubagentHistory({ sessionId, tabKey: "d1" });
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(calls.length, 2, "the focus read and one forward read");
  assert.equal(
    calls.at(-1).options.messageBefore,
    300,
    "the forward page is asked for from the window's exclusive end plus one page",
  );
  assert.equal(entry.laterStalled, true, "a page that gained nothing stops the direction");
  assert.equal(entry.hasMoreAfter, true, "newer rows still exist beyond the window");
  assert.deepEqual(entry.pages.map((held) => held.start), [100]);
  assert.equal(entry.messages.length, 100, "the stalled answer never erases the window");
  assert.equal(entry.error, undefined, "a stall is not a read failure");

  stalled = false;
  await useAppStore.getState().loadNewerSubagentHistory({ sessionId, tabKey: "d1" });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(calls.length, 3);
  assert.deepEqual(entry.pages.map((held) => held.start), [100, 200], "the next page is joined");
  assert.equal(entry.messageStart, 100, "the older cursor does not move");
  assert.equal(entry.messageEnd, 300);
  assert.equal(entry.hasMoreAfter, false, "the joined page reached the tail");
  assert.equal(entry.laterStalled, undefined, "a page that moved the window clears the stall");
  assert.equal(entry.messages.length, 200);
});

test("a latest read past a wide gap starts the tail window and pages back through it", async (t) => {
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
  assert.deepEqual(
    calls.map((call) => (call.options.messageAround ? "around" : call.options.messageBefore ?? "tail")),
    ["around", "tail"],
    "the jump to latest is one tail read, not a walk across the gap",
  );
  assert.deepEqual(entry.pages.map((held) => held.start), [2300], "the tail page is the window");
  assert.equal(entry.messages.length, SUBAGENT_HISTORY_PAGE_SIZE, "the target's rows are not kept beside it");
  assert.equal(entry.messages[0].id, "child-2300");
  assert.equal(entry.messageStart, 2300);
  assert.equal(entry.messageEnd, 2400);
  assert.equal(entry.hasMoreAfter, false, "the window reaches the tail");
  assert.equal(entry.hasMoreBefore, true, "the rows between the target and the tail stay reachable");
  assert.equal("omittedAfterId" in entry, false, "the window states no omission: it is one range");

  await useAppStore.getState().loadOlderSubagentHistory({ sessionId, tabKey: "d1" });
  assert.equal(
    calls.at(-1).options.messageBefore,
    2300,
    "ordinary paging walks the gap from the window's first row",
  );
  const paged = findSubagentHistoryEntry(
    useAppStore.getState().subagentHistory,
    sessionId,
    "d1",
  );
  assert.deepEqual(paged.pages.map((held) => held.start), [2200, 2300]);
  assert.equal(paged.messageStart, 2200);
  const view = subagentHistoryMessages(paged, [])
    .map((message) => message.id)
    .filter((id) => id.startsWith("child-"));
  assert.ok(
    view.every((id, index) => id === `child-${2200 + index}`),
    "each step keeps one contiguous selection: the page read joins the window",
  );
});


/*
 * A running child tool has no durable row until it ends, so a read issued while
 * it runs cannot contain it. These tests pin the one durable/live reconciliation
 * rule: a stale scoped read may replace the durable window, but it never erases a
 * live row it did not name, the read's own lifecycle stays owned by the read, and
 * the completed durable row replaces its live copy exactly once.
 */

const CALL_ID = "call-live";
const BASH_ID = "bash-live";
const STEER_ID = "steer-live";
const LIVE_START = Date.UTC(2026, 0, 1, 0, 0, 0);

const liveBash = (status, extra = {}) => ({
  id: BASH_ID,
  role: "tool",
  toolName: "Bash",
  toolCallId: BASH_ID,
  parentToolCallId: CALL_ID,
  toolArgs: { command: "npm test" },
  content: "",
  toolStatus: status,
  createdAt: new Date(LIVE_START + 2400_500).toISOString(),
  ...extra,
});

const steerRow = () => ({
  id: STEER_ID,
  role: "user",
  content: "Keep going, re-run the suite",
  parentToolCallId: CALL_ID,
  createdAt: new Date(LIVE_START + 2401_000).toISOString(),
});

const callTask = () => ({
  ...taskRow(CALL_ID, "d1"),
  id: `${CALL_ID}-row`,
  createdAt: new Date(LIVE_START + 1000).toISOString(),
});

const ROW_STEER = 2401;
const ROW_BASH = 2402;

const durableRows = (indices) =>
  indices.map((index) =>
    index === ROW_STEER
      ? steerRow()
      : index === ROW_BASH
        ? { ...liveBash("success", { content: "suite passed" }), createdAt: new Date(LIVE_START + 2402_000).toISOString() }
        : childRow(index, CALL_ID),
  );

function makeGate() {
  let openStart;
  let openRelease;
  const started = new Promise((resolve) => {
    openStart = resolve;
  });
  const released = new Promise((resolve) => {
    openRelease = resolve;
  });
  return { started, released, start: openStart, release: openRelease };
}

/**
 * A delegation backend whose tail read waits for the test. Only the transport
 * is controlled: every store action, merge, and render helper is production
 * code. `state.durable` is the durable index list, so a stage can append the
 * row a completed tool would persist.
 */
function gatedTransport({ calls, state, gates }) {
  return async (id, options = {}) => {
    calls.push({ id, options });
    const scope = delegation("d1");
    const context = [callTask()];
    if (options.messageAround) {
      const windowRows = [10, 11];
      return page(id, durableRows(windowRows), {
        messageStart: windowRows[0],
        messageEnd: windowRows.at(-1) + 1,
        hasMoreBefore: true,
        hasMoreAfter: true,
        scope,
        context,
      });
    }
    if (options.messageBefore === undefined) {
      const gate = makeGate();
      gates.push(gate);
      gate.start();
      await gate.released;
      const slice = state.durable.slice(-100);
      return page(id, durableRows(slice), {
        messageStart: slice[0],
        messageEnd: slice.at(-1) + 1,
        hasMoreBefore: state.durable.some((index) => index < slice[0]),
        hasMoreAfter: false,
        scope,
        context,
      });
    }
    const eligible = state.durable.filter((index) => index < options.messageBefore);
    const slice = eligible.slice(-100);
    return page(id, durableRows(slice), {
      messageStart: slice[0],
      messageEnd: slice.at(-1) + 1,
      hasMoreBefore: state.durable.some((index) => index < slice[0]),
      hasMoreAfter: true,
      scope,
      context,
    });
  };
}

const rowIds = (entry) => entry.messages.map((message) => message.id);
const bashCopies = (entry) => entry.messages.filter((message) => message.id === BASH_ID);

const gapIndices = () =>
  Array.from({ length: 23 }, (_, block) =>
    Array.from({ length: 100 }, (_, offset) => 100 + block * 100 + offset),
  ).flat();

test("a stale tail window keeps the live running child row and its steering row", async (t) => {
  const sessionId = "topic-delegate-steer-gap";
  seedStore(sessionId);
  const calls = [];
  const gates = [];
  const state = { durable: [...[10, 11], ...gapIndices(), ROW_STEER] };
  t.mock.method(api, "getSession", gatedTransport({ calls, state, gates }));

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-11",
    query: "",
    requestId: 3,
  });
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(entry.messageEnd, 12, "the tab starts on the durable window it read");
  assert.deepEqual(rowIds(entry), ["child-10", "child-11"]);

  // The child tool starts: the runtime publishes tool_start before the steering
  // reply is echoed, and no durable row exists for the call yet.
  const tailRead = useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  await gates[0].started;
  assert.equal(
    findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1").refreshing,
    true,
    "the tail read owns the entry's refreshing state",
  );
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [callTask(), liveBash("running")],
  });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.deepEqual(rowIds(entry), ["child-10", "child-11", BASH_ID], "the live row is routed in");
  assert.equal(bashCopies(entry).length, 1);
  assert.equal(bashCopies(entry)[0].toolStatus, "running");
  assert.deepEqual(entry.livePending.map((message) => message.id), [BASH_ID]);
  assert.equal(
    entry.refreshing,
    true,
    "a live publication never makes an in-flight read look finished",
  );

  // The read was issued before the tool started, so its answer cannot name the
  // row. The target's window is far from the tail, so this latest read starts
  // the tail as a new contiguous window and the live row is put back beside it.
  gates[0].release();
  await tailRead;
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(entry.pages.length, 1, "the latest read starts one contiguous tail window");
  assert.ok(
    rowIds(entry).includes(STEER_ID),
    "the durable row the read did name stays",
  );
  assert.ok(
    rowIds(entry).includes(BASH_ID),
    "the live row the read did not name is not erased by the window",
  );
  assert.equal(bashCopies(entry).length, 1, "the live row is not duplicated");
  assert.equal(
    bashCopies(entry)[0].toolStatus,
    "running",
    "the still-running row keeps its live state",
  );
  assert.ok(
    entry.messages.length <= SUBAGENT_HISTORY_PAGE_SIZE + entry.livePending.length,
    "the window holds its own page and the live row it did not name",
  );
  assert.equal(
    entry.finalized,
    false,
    "a read that predates a live row does not claim the entry matches the store",
  );

  // Entry-only render: another conversation is on screen, so the tab has no live
  // array to fall back on. The row must still be there.
  useAppStore.setState({ activeSessionId: "some-other-session", messages: [] });
  const rendered = subagentHistoryMessages(
    findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1"),
    [],
  ).map((message) => message.id);
  assert.ok(rendered.includes(BASH_ID), "the row renders from the entry alone");
  assert.ok(rendered.includes(STEER_ID), "the steering row renders from the entry alone");
});

test("the completed durable row replaces its live copy exactly once", async (t) => {
  const sessionId = "topic-delegate-steer-complete";
  seedStore(sessionId);
  const calls = [];
  const gates = [];
  const state = { durable: [...[10, 11], ...gapIndices(), ROW_STEER] };
  t.mock.method(api, "getSession", gatedTransport({ calls, state, gates }));

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-11",
    query: "",
    requestId: 4,
  });
  useAppStore.setState({ activeSessionId: sessionId, messages: [callTask(), liveBash("running")] });
  const stale = useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  await gates[0].started;
  gates[0].release();
  await stale;
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(bashCopies(entry).length, 1, "the live row survives the stale window");

  // The tool ends: the durable row now exists, and a fresh read names it.
  state.durable = [...state.durable, ROW_BASH];
  const fresh = useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  await gates[1].started;
  gates[1].release();
  await fresh;
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(bashCopies(entry).length, 1, "a completed row reconciles exactly once");
  assert.equal(bashCopies(entry)[0].toolStatus, "success", "the durable value wins");
  assert.deepEqual(entry.livePending, [], "the confirmed live row retires");
  assert.equal(entry.finalized, true, "a read that confirmed every live row finalizes");
  assert.ok(rowIds(entry).includes(STEER_ID));

  // The same completion echoed live afterwards adds nothing.
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [callTask(), liveBash("success", { content: "suite passed" })],
  });
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(bashCopies(entry).length, 1, "a replayed completion does not duplicate the row");
  assert.deepEqual(entry.livePending, [], "a confirmed row never returns to the pending set");
  assert.equal(calls.filter((call) => call.options.messageAround).length, 1, "one initial read");
});

test("a durable read that lands after the live completion keeps one row", async (t) => {
  const sessionId = "topic-delegate-steer-order";
  seedStore(sessionId);
  const gates = [];
  const calls = [];
  const state = { durable: [...[10, 11], ...gapIndices(), ROW_STEER, ROW_BASH] };
  t.mock.method(api, "getSession", gatedTransport({ calls, state, gates }));

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-11",
    query: "",
    requestId: 5,
  });
  // The live completion arrives first, then the durable read that names the row.
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [callTask(), liveBash("success", { content: "suite passed" })],
  });
  let entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(bashCopies(entry).length, 1);
  assert.deepEqual(entry.livePending.map((message) => message.id), [BASH_ID]);
  const read = useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  await gates[0].started;
  gates[0].release();
  await read;
  entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.equal(bashCopies(entry).length, 1, "the order of arrival does not duplicate the row");
  assert.equal(bashCopies(entry)[0].toolStatus, "success");
  assert.deepEqual(entry.livePending, []);
  assert.equal(entry.finalized, true);
});

test("live rows of another chain neither join nor stale this one", async (t) => {
  const sessionId = "topic-delegate-isolation";
  seedStore(sessionId);
  const gates = [];
  const calls = [];
  const state = { durable: [...[10, 11], ...gapIndices(), ROW_STEER] };
  t.mock.method(api, "getSession", gatedTransport({ calls, state, gates }));

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-10",
    query: "",
    requestId: 6,
  });
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [
      callTask(),
      { ...childRow(9, "call-other"), id: "child-other", createdAt: new Date(LIVE_START + 9_000).toISOString() },
    ],
  });
  const entry = findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  assert.deepEqual(
    entry.livePending,
    [],
    "an unrelated chain's rows never become this entry's pending rows",
  );
  assert.deepEqual(
    rowIds(entry),
    ["child-10", "child-11"],
    "another chain's row does not join this tab",
  );
  assert.equal(calls.length, 1, "an unrelated publication costs no read");
});

test("repeated live publications of one call hold a single unconfirmed row", async (t) => {
  const sessionId = "topic-delegate-steer-repeat";
  seedStore(sessionId);
  const calls = [];
  const gates = [];
  const state = { durable: [...[10, 11], ...gapIndices(), ROW_STEER] };
  t.mock.method(api, "getSession", gatedTransport({ calls, state, gates }));

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-11",
    query: "",
    requestId: 7,
  });
  const entryOf = () => findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");

  // The child streams: every event republishes the same running tool.
  const rounds = 24;
  for (let round = 0; round < rounds; round += 1) {
    useAppStore.setState({ activeSessionId: sessionId, messages: [callTask(), liveBash("running")] });
  }
  let entry = entryOf();
  assert.equal(bashCopies(entry).length, 1, "the tab still paints one row for the call");
  assert.deepEqual(
    entry.livePending.map((message) => message.id),
    [BASH_ID],
    "no publication adds a second unconfirmed copy of the same call",
  );
  assert.equal(entry.livePending[0].toolStatus, "running");
  assert.ok(
    entry.livePending.length <= entry.messages.length,
    "the unconfirmed set stays a subset of the tab's own rows",
  );
  assert.ok(
    entry.livePending.length <= SUBAGENT_HISTORY_LIVE_TAIL_LIMIT,
    "repeat publications stay inside the live tail's own bound",
  );

  // The call ends: the newest live state is the one the tab holds and the one
  // it will put back if a durable read cannot name the row.
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [callTask(), liveBash("success", { content: "suite passed" })],
  });
  entry = entryOf();
  assert.equal(bashCopies(entry).length, 1);
  assert.equal(entry.livePending.length, 1, "the settled call still holds one unconfirmed row");
  assert.equal(
    entry.livePending[0].toolStatus,
    "success",
    "the newest live state replaces the older one instead of joining it",
  );
});

test("a completion that predates any durable page survives the window replacement", async (t) => {
  const sessionId = "topic-delegate-steer-terminal";
  seedStore(sessionId);
  const calls = [];
  const gates = [];
  const state = { durable: [...[10, 11], ...gapIndices(), ROW_STEER] };
  t.mock.method(api, "getSession", gatedTransport({ calls, state, gates }));

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-11",
    query: "",
    requestId: 8,
  });
  const entryOf = () => findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");

  // tool_start, then tool_end, then a replay of the earlier running frame: the
  // backend has no durable row for the call yet, so only live rows carry it.
  useAppStore.setState({ activeSessionId: sessionId, messages: [callTask(), liveBash("running")] });
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [callTask(), liveBash("success", { content: "suite passed" })],
  });
  useAppStore.setState({ activeSessionId: sessionId, messages: [callTask(), liveBash("running")] });
  let entry = entryOf();
  assert.equal(bashCopies(entry).length, 1);

  // The read cannot name the call: its pages cover the wide gap but hold no row
  // for this tool, so the newest window replaces the durable range alone.
  const stale = useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  await gates[0].started;
  gates[0].release();
  await stale;
  entry = entryOf();
  assert.equal(bashCopies(entry).length, 1, "the settled row survives the window exactly once");
  assert.deepEqual(
    bashCopies(entry).map((message) => message.toolStatus),
    ["success"],
    "the completed row is not regressed to running by the merge",
  );
  assert.deepEqual(
    entry.livePending.map((message) => message.toolStatus),
    ["success"],
    "a replayed unsettled frame never downgrades the settled unconfirmed row",
  );

  // Entry-only render: no live array to fall back on.
  useAppStore.setState({ activeSessionId: "some-other-session", messages: [] });
  assert.deepEqual(
    subagentHistoryMessages(entryOf(), [])
      .filter((message) => message.id === BASH_ID)
      .map((message) => message.toolStatus),
    ["success"],
    "the completed row paints from the entry alone",
  );

  // A later publication of the settled state adds nothing. The stalled running
  // frame is replayed once more before the next read, and that read joins the
  // page the entry already reaches: the page merge alone must not resurrect the
  // older state either.
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [callTask(), liveBash("success", { content: "suite passed" })],
  });
  entry = entryOf();
  assert.equal(bashCopies(entry).length, 1, "a replayed completion does not duplicate the row");
  useAppStore.setState({ activeSessionId: sessionId, messages: [callTask(), liveBash("running")] });
  const next = useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  await gates[1].started;
  gates[1].release();
  await next;
  entry = entryOf();
  assert.deepEqual(
    bashCopies(entry).map((message) => message.toolStatus),
    ["success"],
    "a joined page keeps the completed row once, even after a stalled replay",
  );
  assert.ok(
    entry.livePending.every((message) => message.toolStatus === "success"),
    "no unsettled version returns to the unconfirmed set",
  );
});
/*
 * One contiguous interval, the policy the main transcript follows: a reader
 * keeps every page it actually read, so boundary scrolling walks the chain
 * backwards without a row budget and without ever holding two ranges.
 */
test("the reading window keeps every page it read in one contiguous interval", async (t) => {
  const sessionId = "topic-delegate-continuous-window";
  seedStore(sessionId);
  const calls = [];
  const selected = Array.from({ length: 1000 }, (_, index) => index);
  t.mock.method(api, "getSession", sparseTransport({ calls, selected }));
  const entryOf = () =>
    findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  for (let read = 0; read < 4; read += 1) {
    await useAppStore.getState().loadOlderSubagentHistory({ sessionId, tabKey: "d1" });
  }
  const entry = entryOf();
  assert.deepEqual(
    entry.pages.map((held) => held.start),
    [500, 600, 700, 800, 900],
    "every page the reader asked for stays in the window",
  );
  assert.equal(entry.messages.length, 5 * SUBAGENT_HISTORY_PAGE_SIZE);
  assert.equal(entry.messageStart, 500, "the older cursor names the oldest retained page");
  assert.equal(entry.messageEnd, 1000, "the window ends at the scope's tail");
  assert.equal(entry.hasMoreBefore, true, "more rows sit before the window");
  assert.equal(entry.hasMoreAfter, false, "the window reaches the tail");
  assert.ok(subagentHistoryIsFollowing(entry), "a window at the tail follows live output");
  const view = subagentHistoryMessages(entry, [])
    .map((message) => message.id)
    .filter((id) => id.startsWith("child-"));
  assert.equal(view.length, entry.messages.length, "the view draws the whole interval");
  assert.ok(
    view.every((id, index) => id === `child-${500 + index}`),
    "the retained rows are contiguous: no row between the cursor and the tail is skipped",
  );
  assert.equal("omittedAfterId" in entry, false, "the window model has no omission field");
});

/*
 * A search target is a row the reader asked to see. The answer starts the
 * window there — one contiguous interval around the target — instead of
 * appending a distant page to the range already on screen.
 */
test("a focus page starts a new contiguous window around the target", () => {
  const detail = (start, count) => ({
    id: "topic-delegate-focus-window",
    title: "Conversation",
    messages: childRows(Array.from({ length: count }, (_, offset) => start + offset)),
    messageStart: start,
    messageEnd: start + count,
    hasMoreBefore: start > 0,
    hasMoreAfter: start + count < 5000,
    messageCount: 5000,
    historyScope: delegation("d1"),
    historyContext: [taskRow("call-1", "d1")],
  });
  let entry = {
    ...createSubagentHistoryEntry("topic-delegate-focus-window", "d1", 1),
    focus: { messageId: "child-450", query: "", requestId: 2 },
  };
  entry = applySubagentHistoryPage(entry, detail(600, 100), "initial", 1);
  entry = applySubagentHistoryPage(entry, detail(500, 100), "before", 2);
  assert.deepEqual(entry.pages.map((held) => held.start), [500, 600]);

  entry = applySubagentHistoryPage(entry, detail(400, 100), "focus", 3);
  assert.deepEqual(entry.pages.map((held) => held.start), [400], "the target's page becomes the window");
  assert.equal(entry.messageStart, 400);
  assert.equal(entry.messageEnd, 500);
  assert.equal(entry.hasMoreBefore, true, "rows before the target stay pageable");
  assert.equal(entry.hasMoreAfter, true, "rows after the target stay pageable");
  assert.ok(!subagentHistoryIsFollowing(entry), "a historical window does not follow live output");
  const ids = entry.messages.map((message) => message.id);
  assert.deepEqual(ids, childRows(Array.from({ length: 100 }, (_, offset) => 400 + offset)).map((row) => row.id));
  for (const index of [500, 599, 600, 699]) {
    assert.ok(!ids.includes(`child-${index}`), `child-${index} left with the window it belonged to`);
  }
  assert.equal(entry.messages.length, SUBAGENT_HISTORY_PAGE_SIZE, "no island row is kept");
});

/*
 * "Jump to latest" reads the scope's newest page and selects it. A page far
 * from the loaded window starts a fresh tail window; it is never appended to a
 * distant range, and no omission marker stands in for the rows between them.
 */
test("a latest read replaces a distant window with the tail page", async (t) => {
  const sessionId = "topic-delegate-latest-window";
  seedStore(sessionId);
  const calls = [];
  const selected = Array.from({ length: 1000 }, (_, index) => index);
  t.mock.method(api, "getSession", sparseTransport({ calls, selected, window: [400, 401, 402] }));
  const entryOf = () =>
    findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-401",
    query: "answer",
    requestId: 7,
  });
  let entry = entryOf();
  assert.deepEqual(entry.pages.map((held) => held.start), [400]);
  assert.equal(entry.hasMoreAfter, true);

  await useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  entry = entryOf();
  assert.deepEqual(
    calls.map((call) => (call.options.messageAround ? "around" : call.options.messageBefore ?? "tail")),
    ["around", "tail"],
    "the latest read is one tail page, with no bridge walk",
  );
  assert.deepEqual(entry.pages.map((held) => held.start), [900], "the tail page becomes the window");
  assert.equal(entry.messageStart, 900);
  assert.equal(entry.messageEnd, 1000);
  assert.equal(entry.hasMoreAfter, false);
  assert.equal(entry.hasMoreBefore, true, "the rows the window left behind stay reachable");
  assert.ok(subagentHistoryIsFollowing(entry));
  assert.equal(entry.messages.length, SUBAGENT_HISTORY_PAGE_SIZE, "the old range is not still held");
  const view = subagentHistoryMessages(entry, [])
    .map((message) => message.id)
    .filter((id) => id.startsWith("child-"));
  assert.ok(
    view.every((id, index) => id === `child-${900 + index}`),
    "the view is exactly the tail interval",
  );
  // Ordinary older paging walks back from the tail, one contiguous page at a time.
  await useAppStore.getState().loadOlderSubagentHistory({ sessionId, tabKey: "d1" });
  entry = entryOf();
  assert.equal(calls.at(-1).options.messageBefore, 900);
  assert.deepEqual(entry.pages.map((held) => held.start), [800, 900]);
  assert.equal(entry.messageStart, 800);
});

/*
 * A forward page is asked for from the window's own exclusive end. An answer
 * that does not move past it ends that direction: the window keeps its rows,
 * the fact that newer rows exist is kept, and the explicit latest read is the
 * way on. No read loop, no borrowed cursor arithmetic.
 */
test("a forward page that cannot move the window stops asking", () => {
  const detail = (start, count, extra = {}) => ({
    id: "topic-delegate-forward-stall",
    title: "Conversation",
    messages: childRows(Array.from({ length: count }, (_, offset) => start + offset)),
    messageStart: start,
    messageEnd: start + count,
    hasMoreBefore: start > 0,
    hasMoreAfter: false,
    messageCount: 5000,
    historyScope: delegation("d1"),
    historyContext: [taskRow("call-1", "d1")],
    ...extra,
  });
  let entry = {
    ...createSubagentHistoryEntry("topic-delegate-forward-stall", "d1", 1),
    focus: { messageId: "child-150", query: "", requestId: 2 },
  };
  entry = applySubagentHistoryPage(
    entry,
    detail(100, 100, { hasMoreAfter: true }),
    "focus",
    1,
  );
  assert.equal(entry.hasMoreAfter, true);
  const before = entry.messages.map((message) => message.id);

  // The answer repeats rows the window already holds: it cannot widen the edge.
  const stalled = applySubagentHistoryPage(entry, detail(120, 60), "after", 2);
  assert.equal(stalled.laterStalled, true, "the direction is recorded as stalled");
  assert.equal(stalled.hasMoreAfter, true, "newer rows still exist beyond the window");
  assert.deepEqual(stalled.messages.map((message) => message.id), before);
  assert.deepEqual(stalled.pages.map((held) => held.start), [100]);

  // A page that really follows the window is joined and clears the stall.
  const joined = applySubagentHistoryPage(entry, detail(200, 100), "after", 3);
  assert.equal(joined.laterStalled, undefined);
  assert.deepEqual(joined.pages.map((held) => held.start), [100, 200]);
  assert.equal(joined.messageStart, 100);
  assert.equal(joined.messageEnd, 300);
  assert.equal(joined.hasMoreAfter, false, "the joined page reached the tail");
  assert.equal(joined.messages.length, 200);
});

/*
 * Live rows are the parent's publication tail, not a physical page. They are
 * bounded on their own, and a tail that had to drop its oldest row leaves a
 * hole behind the window: the entry stops claiming the tail instead of drawing
 * a disconnected run as the end of the conversation.
 */
test("a live tail past its own bound stops claiming the tail instead of hiding the hole", () => {
  const detail = (start, count) => ({
    id: "topic-delegate-live-tail",
    title: "Conversation",
    messages: childRows(Array.from({ length: count }, (_, offset) => start + offset)),
    messageStart: start,
    messageEnd: start + count,
    hasMoreBefore: start > 0,
    hasMoreAfter: false,
    messageCount: 5000,
    historyScope: delegation("d1"),
    historyContext: [taskRow("call-1", "d1")],
  });
  let entry = createSubagentHistoryEntry("topic-delegate-live-tail", "d1", 1);
  entry = applySubagentHistoryPage(entry, detail(900, 100), "initial", 1);
  for (const start of [800, 700, 600, 500]) {
    entry = applySubagentHistoryPage(entry, detail(start, 100), "before", 2);
  }
  assert.equal(entry.messages.length, 5 * SUBAGENT_HISTORY_PAGE_SIZE, "the window is untouched");
  const windowIds = entry.pages.flatMap((held) => held.ids);
  assert.deepEqual(
    windowIds,
    childRows(Array.from({ length: 500 }, (_, offset) => 500 + offset)).map((row) => row.id),
  );

  const live = [
    taskRow("call-1", "d1"),
    ...childRows(Array.from({ length: 150 }, (_, offset) => 1000 + offset)),
  ];
  const published = applySubagentLiveRows(entry, live);
  assert.ok(published, "live rows of this chain are routed in");
  assert.equal(
    published.hasMoreAfter,
    true,
    "a trimmed live tail stops claiming the scope's tail",
  );
  assert.equal(
    published.messages.length,
    SUBAGENT_HISTORY_PAGE_SIZE * 5 + SUBAGENT_HISTORY_LIVE_TAIL_LIMIT,
    "the window holds its pages and the live tail holds its own bound",
  );
  const ids = published.messages.map((message) => message.id);
  assert.equal(new Set(ids).size, ids.length, "no row is held twice");
  const view = subagentHistoryMessages(published, []).map((message) => message.id);
  for (const index of [1000, 1049, 1100, 1149]) {
    assert.ok(!view.includes(`child-${index}`), `child-${index} is not drawn as contiguous`);
  }
  assert.ok(
    view.includes("child-500") && view.includes("child-999"),
    "the durable window is what the historical view draws",
  );
});

/**
 * A client-side model of a delegation-scoped read over a sparse physical
 * selection whose focus answers centre the page on the row asked for, the
 * way the host does. `hold` slows one read so a test can keep it in flight
 * while another request arrives.
 */
function scopedPageTransport({ calls, selected, hold }) {
  const context = () => [taskRow("call-1", "d1")];
  return async (id, options = {}) => {
    calls.push({ id, options });
    if (options.messageAround) {
      const around = Number(String(options.messageAround).slice("child-".length));
      const first = Math.max(
        0,
        Math.min(
          selected.length - SUBAGENT_HISTORY_PAGE_SIZE,
          around - SUBAGENT_HISTORY_PAGE_SIZE / 2,
        ),
      );
      const slice = selected.slice(first, first + SUBAGENT_HISTORY_PAGE_SIZE);
      return page(id, childRows(slice), {
        messageStart: slice[0],
        messageEnd: slice.at(-1) + 1,
        hasMoreBefore: selected.some((index) => index < slice[0]),
        hasMoreAfter: selected.some((index) => index > slice.at(-1)),
        scope: delegation("d1"),
        context: context(),
      });
    }
    if (hold) await hold(options);
    const cursor = options.messageBefore;
    const eligible = cursor === undefined ? selected : selected.filter((index) => index < cursor);
    const slice = eligible.slice(-SUBAGENT_HISTORY_PAGE_SIZE);
    return page(id, slice.length ? childRows(slice) : [], {
      messageStart: slice[0] ?? 0,
      messageEnd: (slice.at(-1) ?? -1) + 1,
      hasMoreBefore: slice.length ? selected.some((index) => index < slice[0]) : false,
      hasMoreAfter: slice.length ? selected.some((index) => index > slice.at(-1)) : false,
      scope: delegation("d1"),
      context: context(),
    });
  };
}

/*
 * "Jump to latest" is an explicit transition to the tail, so it supersedes a
 * read that is still in flight instead of joining it. The older answer cannot
 * decide where the pane lands: the tail read is what the reader asked for, and
 * the late older page is dropped when it arrives.
 */
test("a jump to latest supersedes an older read that is still in flight", async (t) => {
  const sessionId = "topic-delegate-latest-supersede";
  seedStore(sessionId);
  const calls = [];
  const selected = Array.from({ length: 1000 }, (_, index) => index);
  let releaseOlder;
  const olderGate = new Promise((resolve) => {
    releaseOlder = resolve;
  });
  t.mock.method(
    api,
    "getSession",
    scopedPageTransport({
      calls,
      selected,
      hold: async (options) => {
        // The first older page stays unanswered until the test releases it.
        if (options.messageBefore === 400) await olderGate;
      },
    }),
  );
  const entryOf = () =>
    findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  const asKind = (call) =>
    call.options.messageAround
      ? "around"
      : call.options.messageBefore === undefined
        ? "tail"
        : "before";

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-450",
    query: "",
    requestId: 1,
  });
  assert.equal(entryOf().messageStart, 400, "the historical window is the target's page");
  assert.equal(entryOf().hasMoreAfter, true, "newer rows exist past that window");
  assert.deepEqual(calls.map(asKind), ["around"]);

  // The reader reaches the visible top: the older page is requested and stays
  // unanswered, so the chain has one read in flight.
  const olderRead = useAppStore.getState().loadOlderSubagentHistory({ sessionId, tabKey: "d1" });
  assert.deepEqual(calls.map(asKind), ["around", "before"], "the older page is in flight");
  assert.equal(entryOf().refreshing, true);

  // Jumping to the tail while that read is in flight must read the newest page
  // itself, not hand back the older request.
  const latestRead = useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  await Promise.race([latestRead, new Promise((resolve) => setTimeout(resolve, 100))]);
  assert.notEqual(latestRead, olderRead, "the jump starts a read of its own");
  assert.deepEqual(
    calls.map(asKind),
    ["around", "before", "tail"],
    "the jump reads the newest page while the older page is still outstanding",
  );
  let entry = entryOf();
  assert.equal(entry.messageStart, 900, "the tail page is the window the jump selects");
  assert.equal(entry.hasMoreAfter, false, "the jump reached the tail");
  assert.equal(entry.refreshing, false);

  // The late older answer is dropped: it cannot move the pane back off the tail.
  releaseOlder();
  await Promise.race([olderRead, new Promise((resolve) => setTimeout(resolve, 100))]);
  entry = entryOf();
  assert.equal(calls.length, 3, "the older answer costs no further read");
  assert.equal(entry.messageStart, 900, "the tail window survives the late older answer");
  assert.equal(entry.hasMoreAfter, false);
  assert.deepEqual(
    entry.messages.map((message) => message.id),
    childRows(Array.from({ length: 100 }, (_, offset) => 900 + offset)).map((row) => row.id),
  );
});

/*
 * A chain can own a live row the current rendered window does not hold: a
 * historical window draws only its own contiguous range, so a live row past
 * it is owned but not shown. A search hit on that row must therefore read the
 * window around the target instead of deciding from the owned rows that the
 * target is already presented.
 */
test("a focus target held only as a live row reads the window around it", async (t) => {
  const sessionId = "topic-delegate-focus-live-row";
  seedStore(sessionId);
  const calls = [];
  const selected = Array.from({ length: 1100 }, (_, index) => index);
  t.mock.method(api, "getSession", scopedPageTransport({ calls, selected }));
  const entryOf = () =>
    findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");
  const liveRow = { ...childRow(900, "call-1"), toolStatus: "running" };

  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-450",
    query: "",
    requestId: 1,
  });
  // The chain's stream publishes a row newer than the target window.
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [taskRow("call-1", "d1"), liveRow],
  });
  const live = useAppStore.getState().messages;
  let entry = entryOf();
  assert.ok(
    entry.messages.some((message) => message.id === "child-900"),
    "the chain owns the live row",
  );
  assert.ok(
    !subagentHistoryMessages(entry, live).some((message) => message.id === "child-900"),
    "the historical window does not draw that live row",
  );
  assert.equal(subagentHistoryIsFollowing(entry), false, "the window is historical");

  // The reader opens the tab on the searched row: it is owned but not rendered,
  // so the window has to move to it.
  await useAppStore.getState().ensureSubagentHistory({
    sessionId,
    tabKey: "d1",
    messageId: "child-900",
    query: "delegate answer",
    requestId: 9,
  });
  assert.equal(calls.length, 2, "the owned-but-unrendered target spends one focus read");
  assert.equal(calls[1].options.messageAround, "child-900", "the read centres on the target");
  entry = entryOf();
  assert.equal(entry.messageStart, 850, "the window switches to the target's page");
  assert.equal(entry.messageEnd, 950);
  const rendered = subagentHistoryMessages(entry, live)
    .map((message) => message.id)
    .filter((id) => id.startsWith("child-"));
  assert.equal(rendered.length, SUBAGENT_HISTORY_PAGE_SIZE);
  assert.ok(rendered.includes("child-900"), "the searched row is in the rendered window");
  assert.ok(
    rendered.every((id, index) => id === `child-${850 + index}`),
    "the rendered rows are one contiguous interval around the target",
  );
});

/*
 * A durable answer that names rows the window already holds is the newest
 * value for those ids even when the page does not extend the window: a
 * repeated tail read of the same range is exactly how a finished child row
 * stops being displayed from its stale streaming copy.
 */
test("a same-range tail refresh confirms the held live row's durable value", async (t) => {
  const sessionId = "topic-delegate-same-page-confirm";
  seedStore(sessionId);
  const calls = [];
  let durable = false;
  t.mock.method(api, "getSession", async (id) => {
    calls.push({ id });
    const rows = childRows(Array.from({ length: 100 }, (_, offset) => 900 + offset)).map((row) =>
      row.id === "child-950" ? { ...row, toolStatus: "success" } : row,
    );
    return page(id, durable ? rows : rows.filter((row) => row.id !== "child-950"), {
      messageStart: 900,
      messageEnd: 1000,
      hasMoreBefore: true,
      hasMoreAfter: false,
      scope: delegation("d1"),
      context: [taskRow("call-1", "d1")],
    });
  });
  const entryOf = () =>
    findSubagentHistoryEntry(useAppStore.getState().subagentHistory, sessionId, "d1");

  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  let entry = entryOf();
  assert.deepEqual(entry.pages.map((held) => held.start), [900]);
  assert.equal(entry.hasMoreAfter, false);
  assert.equal(entry.messageStart, 900);

  // The child's call is still running: its row exists only in the live array.
  useAppStore.setState({
    activeSessionId: sessionId,
    messages: [
      taskRow("call-1", "d1"),
      { ...childRow(950, "call-1"), toolStatus: "running", content: "read file-950" },
    ],
  });
  entry = entryOf();
  assert.equal(
    entry.messages.find((message) => message.id === "child-950").toolStatus,
    "running",
    "the live row is what the chain holds while the call runs",
  );
  assert.deepEqual(
    entry.livePending.map((row) => row.id),
    ["child-950"],
    "the running row is unconfirmed",
  );
  assert.equal(entry.finalized, false);

  // The call ends and the same range is read again: the page names the row.
  durable = true;
  await useAppStore.getState().loadLatestSubagentHistory({ sessionId, tabKey: "d1" });
  entry = entryOf();
  assert.equal(calls.length, 2, "one newest-page read, no page walk");
  assert.deepEqual(entry.pages.map((held) => held.start), [900], "the range did not extend");
  assert.equal(entry.messageStart, 900);
  assert.equal(entry.messageEnd, 1000);
  assert.equal(
    entry.messages.find((message) => message.id === "child-950").toolStatus,
    "success",
    "the durable value replaces the stale live status",
  );
  assert.equal(entry.messages.filter((message) => message.id === "child-950").length, 1);
  assert.deepEqual(entry.livePending, [], "the confirmed row is retired");
  assert.equal(entry.finalized, true, "the entry now matches the store");

  // Nothing arrived after that answer, so reopening the tab costs no read.
  await useAppStore.getState().ensureSubagentHistory({ sessionId, tabKey: "d1" });
  assert.equal(calls.length, 2, "a finalized reopen spends no read");
  assert.equal(
    entryOf().messages.find((message) => message.id === "child-950").toolStatus,
    "success",
    "the finalized row is not downgraded",
  );
});
