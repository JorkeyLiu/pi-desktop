/**
 * Panel visibility is shell state, not conversation state.
 *
 * These cases drive the real store's public actions — reveal, select, New Task,
 * project/reset transition, collapse — so a regression in the open/closed rule
 * fails here and not only in a source contract.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore, materializeDraftSession } = await import(
  "../src/stores/app-store.ts"
);
const { api } = await import("../src/lib/api.ts");

const reviewTab = { id: "review", kind: "review" };

function seedStore(activeSessionId) {
  const session = (id, title) => ({
    id,
    title,
    mode: "agent",
    providerId: "p",
    modelId: "m",
  });
  useAppStore.setState({
    sessions: [session("session-a", "First topic"), session("session-b", "Second topic")],
    activeSessionId,
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
    navStack: [{ page: "chat", sessionId: activeSessionId }],
    navIndex: 0,
    workPanelOpen: false,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelFileRequest: null,
    workPanelContexts: {},
    providers: [{ id: "p", enabled: true, authKind: "none", models: [{ id: "m" }] }],
    settings: { defaultProviderId: "p", defaultModelId: "m", defaultMode: "agent" },
    // The reads a selection would hydrate beside the panel are not this claim.
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
  });
}

function stubSessionReads(t, createdSession) {
  const detail = (id) => {
    const summary = useAppStore.getState().sessions.find((item) => item.id === id);
    return { session: { ...summary, messages: [] } };
  };
  t.mock.method(api, "getSession", async (id) => detail(id));
  t.mock.method(api, "createSession", async (input) => ({
    session: { ...createdSession, ...input },
  }));
  t.mock.method(api, "configureSession", async (id, config) => ({
    session: { ...detail(id).session, ...config },
  }));
}

test("a revealed panel stays open across select, New Task, and project reset", async (t) => {
  seedStore("session-a");
  stubSessionReads(t, { id: "session-new", title: "New topic", mode: "agent" });

  useAppStore.getState().openWorkPanel();
  assert.equal(useAppStore.getState().workPanelOpen, true, "reveal did not open the panel");

  // An explicit user action inside session A retains its resource there.
  useAppStore.getState().openWorkPanelTabForSession("session-a", reviewTab);
  assert.deepEqual(
    useAppStore.getState().workPanelTabs.map((tab) => tab.id),
    ["review"],
  );

  // Switching topic swaps resources but is not a close.
  await useAppStore.getState().selectSession("session-b");
  assert.equal(useAppStore.getState().activeSessionId, "session-b");
  assert.equal(useAppStore.getState().workPanelOpen, true, "switching topic closed an open panel");
  assert.deepEqual(useAppStore.getState().workPanelTabs, [], "session B inherited A's tabs");

  // New Task passes through the no-conversation phase and commits a new one.
  const created = await materializeDraftSession();
  assert.equal(created, "session-new");
  assert.equal(useAppStore.getState().workPanelOpen, true, "New Task closed an open panel");

  // A project/workspace reset clears the visible content only.
  useAppStore.getState().resetWorkPanelContext();
  assert.equal(useAppStore.getState().workPanelOpen, true, "content reset closed an open panel");
  assert.deepEqual(useAppStore.getState().workPanelTabs, []);
});

test("a collapsed panel stays closed when a topic with retained open context returns", async (t) => {
  seedStore("session-a");
  stubSessionReads(t, { id: "session-new", title: "New topic", mode: "agent" });

  useAppStore.getState().openWorkPanel();
  useAppStore.getState().openWorkPanelTabForSession("session-a", reviewTab);
  await useAppStore.getState().selectSession("session-b");

  // The user closes the panel on B.
  useAppStore.getState().collapseWorkPanel();
  assert.equal(useAppStore.getState().workPanelOpen, false);

  // A is the conversation whose context used to be open; returning to it must
  // restore its resources without re-opening the dock.
  await useAppStore.getState().selectSession("session-a");
  assert.equal(useAppStore.getState().activeSessionId, "session-a");
  assert.equal(useAppStore.getState().workPanelOpen, false, "returning to A re-opened a closed panel");
  assert.deepEqual(
    useAppStore.getState().workPanelTabs.map((tab) => tab.id),
    ["review"],
    "A's retained resources did not follow the selection",
  );

  // Same for a fresh topic and for the reset transition.
  await useAppStore.getState().selectSession("session-b");
  assert.equal(useAppStore.getState().workPanelOpen, false);
  await materializeDraftSession();
  assert.equal(useAppStore.getState().workPanelOpen, false, "New Task opened a closed panel");
  useAppStore.getState().resetWorkPanelContext();
  assert.equal(useAppStore.getState().workPanelOpen, false, "content reset opened a closed panel");
});

test("a background artifact updates retained context without revealing the panel", async (t) => {
  seedStore("session-a");
  stubSessionReads(t, { id: "session-new", title: "New topic", mode: "agent" });

  // Session B is not visible: its artifact lands in B's retained context only.
  useAppStore.getState().openWorkPanelTabForSession("session-b", reviewTab);
  assert.equal(useAppStore.getState().workPanelOpen, false, "background artifact opened the panel");
  assert.deepEqual(useAppStore.getState().workPanelTabs, []);
  assert.deepEqual(
    useAppStore.getState().workPanelContexts["session-b"]?.tabs.map((tab) => tab.id),
    ["review"],
  );

  // Opening the panel later shows B's retained resource once B is visible.
  await useAppStore.getState().selectSession("session-b");
  assert.deepEqual(useAppStore.getState().workPanelTabs.map((tab) => tab.id), ["review"]);
  useAppStore.getState().openWorkPanel();
  assert.equal(useAppStore.getState().workPanelOpen, true);
  assert.equal(
    ("open" in (useAppStore.getState().workPanelContexts["session-b"] ?? {})),
    false,
    "retained contexts must not carry per-session visibility",
  );
});
