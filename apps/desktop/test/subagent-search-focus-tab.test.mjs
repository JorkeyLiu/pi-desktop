/**
 * A search hit inside a delegate belongs to the tab that owns the chain.
 *
 * One child session reaches the panel under several identities: the dispatch's
 * delegation id, a `Task(resume …)` continuation's own id, and the bare call id
 * a card carries. An open request for any of them lands in the tab the chain
 * already has, and that surface reads its delegate history under the tab's own
 * resource. The focus a search publishes therefore has to follow the tab the
 * request landed in; a page written under the identity that asked is cached
 * where no open tab ever reads it, so the hit never renders.
 *
 * These tests drive the real store slices and the real reading and delegate
 * history runtimes, with only the transport (`api.getSession`) stubbed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const at = (second) => new Date(Date.UTC(2026, 9, 18, 0, 0, second)).toISOString();
const message = (id, role, content, extra = {}) => ({
  id,
  role,
  content,
  createdAt: at(2),
  status: "complete",
  ...extra,
});
const childRow = (id, content, callId) =>
  message(id, "assistant", content, { parentToolCallId: callId, agentName: "explorer" });
/** A root `Task` record: it names the call it was issued under and, once the
 * run exists, the backend-owned delegation id that followed it. */
const taskRow = ({ id, callId, delegationId, resume }) =>
  message(id, "tool", "", {
    toolName: "Task",
    toolCallId: callId,
    toolStatus: "success",
    toolArgs: {
      agent: "explorer",
      description: "Trace the cache",
      task: "Trace the cache",
      ...(resume ? { resume } : {}),
    },
    ...(delegationId
      ? {
          toolResult: {
            details: {
              delegationId,
              agent: "explorer",
              status: "completed",
              startedAt: 1_000,
              completedAt: 42_000,
            },
          },
        }
      : {}),
  });

const session = (rows, options = {}) => ({
  session: {
    id: "s1",
    messages: rows,
    messageStart: 0,
    hasMoreBefore: false,
    hasMoreAfter: false,
    ...options,
  },
});

async function setup() {
  const vite = await createServer({
    root,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { api } = await vite.ssrLoadModule("/src/lib/api.ts");
  const { useAppStore } = await vite.ssrLoadModule("/src/stores/app-store.ts");
  const { TRANSCRIPT_SEARCH_PAGE_SIZE, TRANSCRIPT_CONTENT_LIMIT } = await vite.ssrLoadModule(
    "/src/lib/transcript-reading.ts",
  );
  return { vite, api, store: useAppStore, TRANSCRIPT_SEARCH_PAGE_SIZE, TRANSCRIPT_CONTENT_LIMIT };
}

/** Only the transport is synthetic: every store workflow below is real. */
function stubReads(api, { physical, scoped }) {
  const calls = [];
  const original = api.getSession;
  api.getSession = async (id, options) => {
    calls.push(options);
    return options.historyScope ? scoped : physical;
  };
  return { calls, restore: () => (api.getSession = original) };
}

function seed(store, { messages, tabs = [], activeTabId = null }) {
  const context = { tabs, activeTabId, fileRequest: null };
  store.setState({
    activeSessionId: "s1",
    sessions: [
      {
        id: "s1",
        source: "local",
        title: "fixture",
        mode: "agent",
        thinkingLevel: "high",
        permissionMode: "auto",
        messageCount: messages.length,
        createdAt: at(1),
        updatedAt: at(2),
      },
    ],
    messages,
    sessionMeta: {},
    sessionHistory: { s1: { scope: { kind: "main" }, messageStart: 0, hasMoreBefore: false } },
    retainedSessionIds: ["s1"],
    retainedTranscripts: {},
    transcriptViews: {},
    runningSessions: {},
    workPanelContexts: { s1: context },
    workPanelTabs: tabs,
    activeWorkPanelTabId: activeTabId,
    workPanelFileRequest: null,
    subagentHistory: {},
    toasts: [],
  });
}

const subagentTabs = (state) =>
  state.workPanelContexts.s1?.tabs.filter((tab) => tab.kind === "subagent") ?? [];

const subagentTabIds = (state) => subagentTabs(state).map((tab) => tab.id);

const errorToasts = (state) => state.toasts.filter((toast) => toast.variant === "error");

async function until(read, label, { timeout = 2_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const focusedEntry = (store) =>
  store.getState().subagentHistory.s1?.["delegation-1"]?.focus?.messageId === "child-target"
    ? store.getState().subagentHistory.s1["delegation-1"]
    : undefined;


test("a search hit opens the chain's tab and focuses the entry that tab reads", async () => {
  const { vite, api, store, TRANSCRIPT_SEARCH_PAGE_SIZE, TRANSCRIPT_CONTENT_LIMIT } = await setup();
  const target = childRow("child-target", "the cache misses after restart", "call-1");
  const rootTask = taskRow({ id: "task-1-msg", callId: "call-1", delegationId: "delegation-1" });
  try {
    const reads = stubReads(api, {
      physical: session([rootTask, target], { navigationParent: rootTask }),
      scoped: session([target], {
        historyScope: { kind: "delegation", id: "delegation-1" },
        historyContext: [rootTask],
        messageStart: 500,
      }),
    });
    try {
      seed(store, { messages: [message("root-user", "user", "Fix the cache after restart."), rootTask] });
      // The root card already opened the chain's own tab, under its delegation
      // id; nothing else is on the strip.
      store.getState().openSubagentTab("delegation-1", "Trace the cache");
      assert.deepEqual(subagentTabIds(store.getState()), ["subagent:delegation-1"]);

      await store.getState().navigateTranscript({ sessionId: "s1", messageId: target.id, query: "cache" });
      const entry = await until(() => focusedEntry(store), "the focused delegate entry");

      assert.deepEqual(
        subagentTabIds(store.getState()),
        ["subagent:delegation-1"],
        "the search focuses the chain's existing tab instead of stacking another",
      );
      assert.equal(
        store.getState().workPanelContexts.s1.activeTabId,
        "subagent:delegation-1",
        "the tab the request landed in is the one on screen",
      );
      assert.equal(store.getState().activeWorkPanelTabId, "subagent:delegation-1");
      assert.deepEqual(
        Object.keys(store.getState().subagentHistory.s1 ?? {}),
        ["delegation-1"],
        "the focus is cached in the entry the mounted tab reads, never in a second bucket keyed by the call id",
      );
      assert.equal(entry.focus.messageId, target.id);
      assert.equal(entry.focus.query, "cache");
      assert.equal(entry.focus.requestId, 1);
      assert.ok(
        entry.messages.some((row) => row.id === target.id),
        "the mounted tab holds the page the search resolved",
      );
      assert.equal(entry.scoped, true);
      assert.deepEqual(
        reads.calls.filter((options) => options.historyScope === undefined),
        [
          {
            messageAround: target.id,
            messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE,
            contentLimit: TRANSCRIPT_CONTENT_LIMIT,
          },
        ],
        "the search itself stays a physical read",
      );
      const scopedReads = reads.calls.filter((options) => options.historyScope !== undefined);
      assert.deepEqual(scopedReads.map((options) => options.historyScope), [
        { kind: "delegation", id: "delegation-1" },
      ]);
      assert.equal(scopedReads[0].messageAround, target.id);
      assert.equal(
        store.getState().transcriptViews.s1,
        undefined,
        "the delegate hit never replaces the main range the reader is in",
      );
      assert.deepEqual(errorToasts(store.getState()), []);
    } finally {
      reads.restore();
    }
  } finally {
    await vite.close();
  }
});

test("a chain's first open is still keyed by the call id that asked for it", async () => {
  const { vite, api, store } = await setup();
  const target = childRow("child-target", "the cache misses after restart", "call-9");
  // Before the run's handle lands, the call identifies itself by its call id
  // alone: that identity is a real open state, not a legacy one.
  const root = taskRow({ id: "task-9-msg", callId: "call-9" });
  try {
    const reads = stubReads(api, {
      physical: session([root, target], { navigationParent: root }),
      scoped: session([target], {
        historyScope: { kind: "delegation", id: "call-9" },
        historyContext: [root],
      }),
    });
    try {
      seed(store, { messages: [message("root-user", "user", "Fix the cache after restart."), root] });
      await store.getState().navigateTranscript({ sessionId: "s1", messageId: target.id, query: "cache" });
      await until(
        () => store.getState().subagentHistory.s1?.["call-9"]?.focus?.messageId,
        "the focused delegate entry",
      );
      const state = store.getState();
      assert.deepEqual(subagentTabIds(state), ["subagent:call-9"]);
      assert.equal(state.workPanelContexts.s1.activeTabId, "subagent:call-9");
      assert.deepEqual(Object.keys(state.subagentHistory.s1 ?? {}), ["call-9"]);
      const entry = state.subagentHistory.s1["call-9"];
      assert.equal(entry.focus.messageId, target.id);
      assert.ok(entry.messages.some((row) => row.id === target.id));
      assert.deepEqual(
        reads.calls.filter((options) => options.historyScope !== undefined).map((options) => options.historyScope),
        [{ kind: "delegation", id: "call-9" }],
        "the entry reads the scope its own tab resource names",
      );
      assert.deepEqual(errorToasts(state), []);
    } finally {
      reads.restore();
    }
  } finally {
    await vite.close();
  }
});

test("a resumed continuation's hit lands in the tab the chain was opened under", async () => {
  const { vite, api, store } = await setup();
  const original = taskRow({ id: "task-1-msg", callId: "call-1", delegationId: "delegation-1" });
  const resumed = taskRow({
    id: "task-2-msg",
    callId: "call-2",
    delegationId: "delegation-2",
    resume: "delegation-1",
  });
  const target = childRow("child-target", "the resumed run found the stale index", "call-2");
  try {
    const reads = stubReads(api, {
      physical: session([resumed, target], { navigationParent: resumed }),
      scoped: session([target], {
        historyScope: { kind: "delegation", id: "delegation-1" },
        historyContext: [original, resumed],
      }),
    });
    try {
      seed(store, {
        messages: [message("root-user", "user", "Fix the cache after restart."), original, resumed],
      });
      store.getState().openSubagentTab("delegation-1", "Trace the cache");
      await store.getState().navigateTranscript({ sessionId: "s1", messageId: target.id, query: "stale" });
      const entry = await until(() => focusedEntry(store), "the focused delegate entry");

      assert.deepEqual(
        subagentTabIds(store.getState()),
        ["subagent:delegation-1"],
        "a continuation's own call id reuses the chain's tab",
      );
      assert.deepEqual(
        Object.keys(store.getState().subagentHistory.s1 ?? {}),
        ["delegation-1"],
        "the continuation's focus follows the tab's identity, not the id it was dispatched under",
      );
      assert.equal(entry.focus.messageId, target.id);
      assert.ok(entry.messages.some((row) => row.id === target.id));
      assert.deepEqual(
        reads.calls.filter((options) => options.historyScope !== undefined).map((options) => options.historyScope),
        [{ kind: "delegation", id: "delegation-1" }],
      );
      assert.deepEqual(errorToasts(store.getState()), []);
    } finally {
      reads.restore();
    }
  } finally {
    await vite.close();
  }
});
