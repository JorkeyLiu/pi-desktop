/**
 * The main conversation reads its own scope.
 *
 * A long delegation chain can fill an entire physical transcript with rows that
 * belong under a `Task` card. The reader's page budget must therefore count the
 * conversation's own top-level records, not the delegate's child rows, and the
 * selection must not walk the window backwards looking for a renderable row when
 * the answer already is one scoped page.
 *
 * A backend without scoped history omits the echo and keeps the legacy physical
 * behavior the walk exists for; that fallback is asserted here explicitly.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");
const { MAIN_HISTORY_SCOPE } = await import("@pi-desktop/shared");

const stamp = (index) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();

const userRow = (index) => ({
  id: `u-${index}`,
  role: "user",
  content: `request ${index}`,
  createdAt: stamp(index),
});

const assistantRow = (index) => ({
  id: `a-${index}`,
  role: "assistant",
  content: `answer ${index}`,
  createdAt: stamp(index),
});

const taskRow = (index, toolCallId = `task-${index}`) => ({
  id: toolCallId,
  role: "tool",
  toolName: "Task",
  toolCallId,
  toolArgs: { prompt: "delegate" },
  content: "delegated",
  createdAt: stamp(index),
});

const childRow = (index, parentToolCallId = "task-1") => ({
  id: `child-${index}`,
  role: "tool",
  toolName: "Read",
  toolCallId: `read-${index}`,
  parentToolCallId,
  toolArgs: { path: `file-${index}.ts` },
  content: `read file-${index}`,
  createdAt: stamp(index),
});

const mainPage = (id, messages, options = {}) => ({
  session: {
    id,
    title: "Conversation",
    messages,
    messageStart: options.messageStart ?? 0,
    messageEnd: options.messageEnd,
    hasMoreBefore: options.hasMoreBefore === true,
    hasMoreAfter: options.hasMoreAfter === true,
    // The physical transcript is thousands of records long; the scoped page is
    // a hundred of the conversation's own rows.
    messageCount: options.messageCount ?? 5000,
    ...(options.historyScope ? { historyScope: options.historyScope } : {}),
    ...(options.historyContext ? { historyContext: options.historyContext } : {}),
    ...(options.navigationParent ? { navigationParent: options.navigationParent } : {}),
  },
});

function seedStore(id) {
  useAppStore.setState({
    sessions: [
      {
        id,
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
    workPanelContexts: {},
    workPanelTabs: [],
    activeWorkPanelTabId: undefined,
    workPanelOpen: false,
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
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
  });
}

test("a main-scoped open reads one bounded page of the conversation's own rows", async (t) => {
  const id = "topic-scoped-main";
  seedStore(id);
  const calls = [];
  // Thousands of child records sit physically behind this page; a scoped read
  // answers with the conversation's own top-level tail only.
  const tail = Array.from({ length: 98 }, (_, index) => assistantRow(4900 + index));
  tail.splice(40, 0, taskRow(2940));
  tail.splice(80, 0, userRow(4980));
  t.mock.method(api, "getSession", async (sessionId, options) => {
    calls.push({ id: sessionId, options });
    return mainPage(id, tail, {
      messageStart: 4900,
      messageEnd: 5000,
      hasMoreBefore: true,
      hasMoreAfter: false,
      historyScope: MAIN_HISTORY_SCOPE,
    });
  });

  await useAppStore.getState().selectSession(id);
  const state = useAppStore.getState();
  assert.equal(calls.length, 1, "the main open is one bounded read, not a walk");
  assert.deepEqual(calls[0].options.historyScope, { kind: "main" });
  assert.equal(calls[0].options.messageLimit, 100);
  assert.equal(calls[0].options.messageBefore, undefined);
  assert.equal(state.messages.length, 100, "the page is bounded");
  assert.equal(
    state.messages.filter((message) => message.parentToolCallId).length,
    0,
    "delegate child rows never enter the main page",
  );
  assert.deepEqual(state.sessionHistory[id], {
    messageStart: 4900,
    hasMoreBefore: true,
    contentLimited: true,
    scope: { kind: "main" },
  });
});

test("older main paging keeps the main scope and the physical cursor", async (t) => {
  const id = "topic-scoped-main-paging";
  seedStore(id);
  const calls = [];
  t.mock.method(api, "getSession", async (sessionId, options) => {
    calls.push({ id: sessionId, options });
    if (options?.messageBefore === undefined) {
      return mainPage(id, [assistantRow(20)], {
        messageStart: 20,
        messageEnd: 20,
        hasMoreBefore: true,
        historyScope: MAIN_HISTORY_SCOPE,
      });
    }
    return mainPage(id, [assistantRow(10), taskRow(11)], {
      messageStart: 10,
      hasMoreBefore: false,
      historyScope: MAIN_HISTORY_SCOPE,
    });
  });

  await useAppStore.getState().selectSession(id);
  await useAppStore.getState().loadTranscriptPage(id, "before");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].options.historyScope, { kind: "main" });
  assert.equal(calls[1].options.messageBefore, 20, "the window cursor is the physical start");
  const state = useAppStore.getState();
  const view = state.transcriptViews[id];
  assert.equal(view.scope?.kind, "main", "the range keeps reading its scope");
  assert.equal(view.messageStart, 10, "the older page moves the reading edge");
  assert.equal(view.hasMoreBefore, false, "the older page owns the head flag");
  assert.equal(
    view.messages.filter((message) => message.parentToolCallId).length,
    0,
    "paging never pulls delegate rows into the main range",
  );
});

test("search navigation stays a legacy physical read and keeps its navigation parent", async (t) => {
  const id = "topic-scoped-main-search";
  seedStore(id);
  const calls = [];
  const parent = {
    id: "task-9",
    role: "tool",
    toolName: "Task",
    toolCallId: "task-9",
    content: "delegated",
    createdAt: stamp(9),
  };
  t.mock.method(api, "getSession", async (sessionId, options) => {
    calls.push({ id: sessionId, options });
    if (options?.messageAround) {
      return mainPage(id, [childRow(30, "task-9")], {
        messageStart: 29,
        messageEnd: 31,
        navigationParent: parent,
      });
    }
    // A backend without scoped history: the main page still answers the
    // physical transcription, so the child row navigates inline as it always
    // did.
    return mainPage(id, [assistantRow(1)], {
      messageStart: 1,
      hasMoreBefore: false,
    });
  });

  await useAppStore.getState().selectSession(id);
  await useAppStore.getState().navigateTranscript({
    sessionId: id,
    messageId: "child-30",
    query: "file-30",
  });
  const search = calls.find((call) => call.options?.messageAround);
  assert.ok(search, "search issues an around read");
  assert.equal(
    search.options.historyScope,
    undefined,
    "search must not scope away the child row it is looking for",
  );
  const view = useAppStore.getState().transcriptViews[id];
  assert.equal(view.focus?.messageId, "child-30");
  assert.equal(view.parentMessage?.id, "task-9");
  assert.ok(
    view.messages.some((message) => message.id === "child-30"),
    "the search target stays visible",
  );
});

test("a backend without the scope echo keeps the legacy physical behavior", async (t) => {
  const id = "topic-legacy-host";
  seedStore(id);
  const calls = [];
  // A child-only tail: nothing the transcript draws, so the legacy walk runs.
  const tail = Array.from({ length: 100 }, (_, index) => childRow(400 + index));
  t.mock.method(api, "getSession", async (sessionId, options) => {
    calls.push({ id: sessionId, options });
    if (options?.messageBefore === undefined) {
      return mainPage(id, tail, {
        messageStart: 400,
        messageEnd: 499,
        hasMoreBefore: true,
      });
    }
    return mainPage(id, [userRow(0), taskRow(1)], { messageStart: 0, hasMoreBefore: false });
  });

  await useAppStore.getState().selectSession(id);
  const state = useAppStore.getState();
  assert.equal(calls.length, 2, "the legacy walk still widens a child-only tail");
  assert.deepEqual(calls[0].options.historyScope, { kind: "main" }, "the request carries the scope");
  assert.equal(
    calls[1].options.messageBefore,
    400,
    "an unanswered scope leaves the physical pagination intact",
  );
  assert.equal(
    state.messages.filter((message) => message.parentToolCallId).length,
    100,
    "a legacy answer is never filtered locally",
  );
  assert.deepEqual(state.sessionHistory[id], {
    messageStart: 0,
    hasMoreBefore: false,
    contentLimited: true,
  });
});

test("a scoped child search opens the delegate's own view and keeps the main range", async (t) => {
  const id = "topic-scoped-main-child-search";
  seedStore(id);
  const calls = [];
  const parent = taskRow(9, "task-9");
  t.mock.method(api, "getSession", async (sessionId, options) => {
    calls.push({ id: sessionId, options });
    if (options?.messageAround) {
      // The physical answer locates the child row and names its chain.
      return mainPage(id, [childRow(30, "task-9")], {
        messageStart: 29,
        messageEnd: 31,
        navigationParent: parent,
      });
    }
    if (options?.historyScope?.kind === "delegation") {
      return mainPage(id, [childRow(30, "task-9")], {
        messageStart: 30,
        historyScope: options.historyScope,
        historyContext: [parent],
      });
    }
    return mainPage(id, [assistantRow(1)], {
      messageStart: 1,
      hasMoreBefore: false,
      historyScope: MAIN_HISTORY_SCOPE,
    });
  });

  await useAppStore.getState().selectSession(id);
  await useAppStore.getState().navigateTranscript({
    sessionId: id,
    messageId: "child-30",
    query: "file-30",
  });
  // The delegate read is dispatched without blocking the navigation action.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = useAppStore.getState();
  assert.equal(
    state.transcriptViews[id],
    undefined,
    "the main range is not replaced with a physical child window",
  );
  assert.equal(state.workPanelOpen, true, "the delegate's own view opens");
  assert.ok(
    state.workPanelTabs.some((tab) => tab.kind === "subagent" && tab.resource === "task-9"),
    "the tab is keyed by the chain identity behind the child row",
  );
  const delegationCall = calls.find((call) => call.options?.historyScope?.kind === "delegation");
  assert.ok(delegationCall, "the delegate view read its own scope");
  assert.deepEqual(delegationCall.options.historyScope, { kind: "delegation", id: "task-9" });
  assert.equal(delegationCall.options.messageAround, "child-30", "the target is centered");
  const entry = state.subagentHistory[id]["task-9"];
  assert.equal(entry.focus?.messageId, "child-30", "the target focus is kept");
  assert.equal(entry.focus?.query, "file-30");
});
