/**
 * Right-panel restart restoration.
 *
 * The durable contract: the panel's open flag, its committed width, and every
 * conversation's ordered tabs plus active tab survive a renderer/app restart,
 * an explicit close stays closed after restart, and restoring state never
 * starts a runtime, a delegation, or a background plugin view.
 *
 * These cases drive the real store's public actions and the real persistence
 * module, so a regression fails on behavior rather than on a source shape.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

// A profile's localStorage, installed before any renderer module evaluates:
// initial state reads the persisted snapshot at import time.
const memory = new Map();
const denied = { reads: false, writes: false };
globalThis.localStorage = {
  getItem(key) {
    if (denied.reads) throw new Error("storage read denied");
    return memory.has(key) ? memory.get(key) : null;
  },
  setItem(key, value) {
    if (denied.writes) throw new Error("storage write denied");
    memory.set(key, String(value));
  },
  removeItem(key) {
    memory.delete(key);
  },
  clear() {
    memory.clear();
  },
  key(index) {
    return [...memory.keys()][index] ?? null;
  },
  get length() {
    return memory.size;
  },
};

const persistence = await import("../src/lib/work-panel-persistence.ts");
const { browserPluginTab, fileWorkPanelTab } = await import(
  "../src/lib/work-panel-tabs.ts"
);
const { useAppStore } = await import("../src/stores/app-store.ts");
const { restoreWorkPanelState } = await import(
  "../src/stores/slices/work-panel-slice.ts"
);
const { api } = await import("../src/lib/api.ts");

const STORAGE_KEY = persistence.WORK_PANEL_STORAGE_KEY;

function stored() {
  const raw = memory.get(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function storedSession(sessionId) {
  return stored()?.sessions?.[sessionId] ?? null;
}

function seedStore(activeSessionId) {
  useAppStore.setState({
    ready: true,
    sessions: [
      { id: "session-a", title: "First", mode: "agent", providerId: "p", modelId: "m" },
      { id: "session-b", title: "Second", mode: "agent", providerId: "p", modelId: "m" },
    ],
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
    pluginViews: [],
    providers: [{ id: "p", enabled: true, authKind: "none", models: [{ id: "m" }] }],
    settings: { defaultProviderId: "p", defaultModelId: "m", defaultMode: "agent" },
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
  });
}

function stubSessionReads(t) {
  const detail = (id) => {
    const summary = useAppStore
      .getState()
      .sessions.find((item) => item.id === id);
    return { session: { ...summary, messages: [] } };
  };
  t.mock.method(api, "getSession", async (id) => detail(id));
  t.mock.method(api, "configureSession", async (id, config) => ({
    session: { ...detail(id).session, ...config },
  }));
}

test("a legacy width-only record restores its width and nothing else", () => {
  memory.set(STORAGE_KEY, JSON.stringify({ width: 512 }));
  const snapshot = persistence.loadWorkPanelSnapshot();
  assert.equal(snapshot.width, 512);
  assert.equal(snapshot.open, false, "an old record must not open the panel");
  assert.deepEqual(snapshot.contexts, {}, "an old record has no tab state");

  memory.set(STORAGE_KEY, JSON.stringify({ width: 12.6 }));
  assert.equal(persistence.loadWorkPanelSnapshot().width, 13);
  memory.set(STORAGE_KEY, JSON.stringify({ width: 0 }));
  assert.equal(persistence.loadWorkPanelSnapshot().width, 1);
  memory.set(STORAGE_KEY, JSON.stringify({ width: "wide" }));
  assert.equal(persistence.loadWorkPanelSnapshot().width, 360);
});

test("malformed, foreign, and unreadable records fall back without throwing", () => {
  memory.set(STORAGE_KEY, "not json");
  assert.deepEqual(persistence.loadWorkPanelSnapshot().contexts, {});
  assert.equal(persistence.loadWorkPanelSnapshot().open, false);

  memory.set(STORAGE_KEY, JSON.stringify([1, 2, 3]));
  assert.equal(persistence.loadWorkPanelSnapshot().width, 360);

  // A newer, unknown version keeps only the width every version defines.
  memory.set(
    STORAGE_KEY,
    JSON.stringify({ version: 99, width: 300, open: true, sessions: { s: {} } }),
  );
  const future = persistence.loadWorkPanelSnapshot();
  assert.equal(future.width, 300);
  assert.equal(future.open, false);
  assert.deepEqual(future.contexts, {});

  denied.reads = true;
  try {
    assert.equal(persistence.loadWorkPanelSnapshot().width, 360);
    assert.deepEqual(persistence.loadWorkPanelSnapshot().contexts, {});
  } finally {
    denied.reads = false;
  }
});

test("unknown tab kinds and unusable resources are discarded on restore", () => {
  memory.set(
    STORAGE_KEY,
    JSON.stringify({
      version: 2,
      width: 360,
      open: true,
      sessions: {
        "session-a": {
          activeTabId: "gone",
          tabs: [
            { id: "file:a.md", kind: "file", resource: "notes/./a.md" },
            { id: "plugin:pi.browser/browser:x", kind: "plugin", resource: "pi.browser/browser", location: "https://example.test/" },
            { id: "plugin:broken", kind: "plugin", resource: "broken" },
            { id: "weird", kind: "terminal" },
            { id: "file:", kind: "file", resource: "   " },
            { id: "subagent:del-1", kind: "subagent", resource: "del-1", label: "Review pass" },
            { id: "file:a.md", kind: "file", resource: "notes/a.md" },
            { kind: "review" },
          ],
        },
        "remote:abc": {
          activeTabId: "review",
          tabs: [{ id: "review", kind: "review" }],
        },
      },
    }),
  );
  const snapshot = persistence.loadWorkPanelSnapshot();
  const context = snapshot.contexts["session-a"];
  assert.ok(context, "the supported session restores");
  assert.deepEqual(
    context.tabs.map((tab) => tab.id),
    ["file:notes/a.md", "plugin:pi.browser/browser:x", "subagent:del-1"],
    "only renderable, de-duplicated tabs survive",
  );
  assert.equal(context.tabs[0].resource, "notes/a.md");
  assert.equal(
    context.activeTabId,
    "file:notes/a.md",
    "a missing active id falls back to the first surviving tab",
  );
  assert.equal(context.tabs[1].location, "https://example.test/");
  assert.equal(snapshot.contexts["remote:abc"], undefined, "remote ids never restore");
});

test("ordered tabs, active tab, width, and open state persist per session", async (t) => {
  seedStore("session-a");
  stubSessionReads(t);
  t.mock.method(api, "pluginViewClose", async () => ({}));

  const fileTab = fileWorkPanelTab("notes/a.md");
  const browserTab = browserPluginTab("https://example.test/start");
  useAppStore.getState().openWorkPanel();
  useAppStore.getState().openWorkPanelTab(fileTab);
  useAppStore.getState().openWorkPanelTab(browserTab);
  useAppStore.getState().setWorkPanelWidth(421);
  useAppStore.getState().activateWorkPanelTab(fileTab.id);

  const contextA = storedSession("session-a");
  assert.ok(contextA, "the visible session is persisted");
  assert.deepEqual(
    contextA.tabs.map((tab) => tab.id),
    [fileTab.id, browserTab.id],
    "strip order round-trips",
  );
  assert.equal(contextA.activeTabId, fileTab.id);
  assert.equal(stored().open, true);
  assert.equal(stored().width, 421);
  assert.equal(stored().version, 2);

  // A background session keeps its own ordered context.
  await useAppStore.getState().selectSession("session-b");
  useAppStore.getState().openWorkPanelTabForSession("session-b", {
    id: "review",
    kind: "review",
  });
  assert.deepEqual(
    storedSession("session-b").tabs.map((tab) => tab.id),
    ["review"],
  );
  assert.deepEqual(
    storedSession("session-a").tabs.map((tab) => tab.id),
    [fileTab.id, browserTab.id],
    "writing B never overwrites A",
  );

  const reloaded = persistence.loadWorkPanelSnapshot();
  assert.equal(reloaded.open, true);
  assert.deepEqual(
    reloaded.contexts["session-a"].tabs.map((tab) => tab.id),
    [fileTab.id, browserTab.id],
  );
  assert.equal(reloaded.contexts["session-a"].activeTabId, fileTab.id);
});

test("an explicit tab close does not reappear after restart", async (t) => {
  seedStore("session-a");
  stubSessionReads(t);
  t.mock.method(api, "pluginViewClose", async () => ({}));

  const fileTab = fileWorkPanelTab("notes/a.md");
  const browserTab = browserPluginTab("https://example.test/start");
  useAppStore.getState().openWorkPanelTab(fileTab);
  useAppStore.getState().openWorkPanelTab(browserTab);
  useAppStore.getState().closeWorkPanelTab(fileTab.id);

  const reloaded = persistence.loadWorkPanelSnapshot();
  assert.deepEqual(
    reloaded.contexts["session-a"].tabs.map((tab) => tab.id),
    [browserTab.id],
    "the closed tab is gone from the durable record",
  );
  assert.equal(reloaded.contexts["session-a"].activeTabId, browserTab.id);
});

test("collapsing persists a closed panel while retaining its tabs", async (t) => {
  seedStore("session-a");
  stubSessionReads(t);
  t.mock.method(api, "pluginViewClose", async () => ({}));

  const fileTab = fileWorkPanelTab("notes/a.md");
  useAppStore.getState().openWorkPanelTab(fileTab);
  useAppStore.getState().collapseWorkPanel();

  const reloaded = persistence.loadWorkPanelSnapshot();
  assert.equal(reloaded.open, false, "the user's collapse is remembered");
  assert.deepEqual(
    reloaded.contexts["session-a"].tabs.map((tab) => tab.id),
    [fileTab.id],
    "collapsing retains the session's tabs",
  );
});

test("host browser URL updates persist for the next launch", async (t) => {
  seedStore("session-a");
  stubSessionReads(t);
  t.mock.method(api, "pluginViewClose", async () => ({}));

  const browserTab = browserPluginTab("https://example.test/start");
  useAppStore.getState().openWorkPanelTab(browserTab);
  useAppStore.getState().updateBrowserWorkPanelTab({
    sessionId: "session-a",
    tabId: browserTab.id,
    url: "https://example.test/deep/page",
    title: "Deep Page",
    isLoading: false,
    loadError: false,
  });

  const tab = storedSession("session-a").tabs.find((item) => item.id === browserTab.id);
  assert.equal(tab.location, "https://example.test/deep/page");
  assert.equal(tab.label, "Deep Page");

  const reloaded = persistence.loadWorkPanelSnapshot();
  assert.equal(
    reloaded.contexts["session-a"].tabs[0].location,
    "https://example.test/deep/page",
  );
});

test("a deleted session leaves the durable record", async (t) => {
  seedStore("session-a");
  stubSessionReads(t);
  t.mock.method(api, "pluginViewClose", async () => ({}));
  t.mock.method(api, "deleteSession", async () => ({}));
  t.mock.method(api, "listSessions", async () => ({
    sessions: useAppStore
      .getState()
      .sessions.filter((session) => session.id !== "session-b"),
  }));

  useAppStore.getState().openWorkPanelTab(fileWorkPanelTab("notes/a.md"));
  useAppStore.getState().openWorkPanelTabForSession("session-b", {
    id: "review",
    kind: "review",
  });
  assert.ok(storedSession("session-b"));

  await useAppStore.getState().deleteSession("session-b");
  assert.equal(storedSession("session-b"), null, "a deleted session is pruned");
  assert.ok(storedSession("session-a"), "the surviving session is untouched");
});

test("restore rebuilds a fresh file request and never starts background work", async (t) => {
  seedStore("session-a");
  stubSessionReads(t);
  const pluginOpen = t.mock.method(api, "pluginViewOpen", async () => ({}));
  const startDelegation = api.startDelegation
    ? t.mock.method(api, "startDelegation", async () => ({}))
    : null;
  t.mock.method(api, "pluginViewClose", async () => ({}));

  const fileTab = fileWorkPanelTab("notes/a.md", "text/markdown", { line: 4 });
  useAppStore.getState().openWorkPanelTab(fileTab);
  useAppStore.getState().openSubagentTab("del-1", "Review pass");
  useAppStore.getState().activateWorkPanelTab(fileTab.id);
  const previousSeq = useAppStore.getState().workPanelFileRequest.seq;
  // A fresh renderer: contexts come from the durable record, the visible
  // projection and file request start empty.
  const snapshot = persistence.loadWorkPanelSnapshot();
  useAppStore.setState({
    workPanelContexts: snapshot.contexts,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelFileRequest: null,
  });
  useAppStore.setState({ workPanelFileRequest: null });
  const restored = restoreWorkPanelState(
    useAppStore.getState(),
    new Set(["session-a"]),
    true,
  );
  useAppStore.setState(restored);

  assert.equal(restored.workPanelOpen, true);
  assert.equal(restored.workPanelFileRequest.path, "notes/a.md");
  assert.equal(restored.workPanelFileRequest.mimeType, "text/markdown");
  assert.equal(restored.workPanelFileRequest.line, 4);
  assert.ok(
    restored.workPanelFileRequest.seq > previousSeq,
    "the restored request carries a fresh sequence so the file reloads",
  );
  assert.deepEqual(
    restored.workPanelTabs.map((tab) => tab.id).sort(),
    ["file:notes/a.md", "subagent:del-1"],
    "supported tabs of every known kind restore",
  );
  assert.equal(
    pluginOpen.mock.callCount(),
    0,
    "restoring state must not open a plugin view on its own",
  );
  assert.equal(startDelegation?.mock.callCount() ?? 0, 0);
});

test("restore keeps panel closed without a restored session and prunes orphans", () => {
  const contexts = {
    "session-a": {
      tabs: [{ id: "review", kind: "review" }],
      activeTabId: "review",
      fileRequest: null,
    },
    "session-gone": {
      tabs: [{ id: "file:x.md", kind: "file", resource: "x.md" }],
      activeTabId: "file:x.md",
      fileRequest: null,
    },
  };
  const state = {
    ...useAppStore.getState(),
    activeSessionId: undefined,
    workPanelContexts: contexts,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelOpen: false,
  };
  const empty = restoreWorkPanelState(state, new Set(["session-a"]), true);
  assert.equal(empty.workPanelOpen, false, "no standalone panel on the empty home");
  assert.deepEqual(Object.keys(empty.workPanelContexts), ["session-a"]);

  const orphaned = restoreWorkPanelState(
    { ...state, activeSessionId: "session-gone" },
    new Set(["session-a"]),
    true,
  );
  assert.equal(orphaned.workPanelOpen, false, "a deleted session cannot reopen the panel");
  assert.deepEqual(orphaned.workPanelTabs, []);
  assert.deepEqual(Object.keys(orphaned.workPanelContexts), ["session-a"]);
});

test("a denied storage write is best effort and never blocks a mutation", () => {
  seedStore("session-a");
  denied.writes = true;
  try {
    useAppStore.getState().openWorkPanelTab({ id: "review", kind: "review" });
    assert.deepEqual(
      useAppStore.getState().workPanelTabs.map((tab) => tab.id),
      ["review"],
    );
  } finally {
    denied.writes = false;
  }
});

test("the size bound keeps the visible conversation's tabs", async (t) => {
  seedStore("session-a");
  t.mock.method(api, "pluginViewClose", async () => ({}));

  // A long-lived profile fills every retained slot before the conversation the
  // user is reading is even inserted, which is the order the defect depended on.
  const retained = {};
  for (let index = 0; index < 70; index += 1) {
    const id = `session-retained-${String(index).padStart(2, "0")}`;
    retained[id] = {
      tabs: [{ id: "review", kind: "review" }],
      activeTabId: "review",
      fileRequest: null,
    };
  }
  retained["session-a"] = {
    tabs: [{ id: "review", kind: "review" }],
    activeTabId: "review",
    fileRequest: null,
  };

  const fileTab = fileWorkPanelTab("notes/current.md");
  const browserTab = browserPluginTab("https://example.test/live");
  useAppStore.setState({
    workPanelContexts: retained,
    workPanelTabs: [fileTab, browserTab],
    activeWorkPanelTabId: browserTab.id,
    workPanelOpen: true,
  });
  // A real mutation drives the same subscriber the app uses.
  useAppStore.getState().setWorkPanelWidth(412);

  const record = stored();
  const storedIds = Object.keys(record.sessions);
  assert.equal(storedIds.length, 60, "the record stays bounded at 60 conversations");
  assert.deepEqual(
    storedIds[0],
    "session-a",
    "the visible conversation is written before the retained ones",
  );
  assert.deepEqual(
    record.sessions["session-a"].tabs.map((tab) => tab.id),
    [fileTab.id, browserTab.id],
    "the visible projection is stored instead of its retained context",
  );
  assert.equal(record.sessions["session-a"].activeTabId, browserTab.id);

  const reloaded = persistence.loadWorkPanelSnapshot();
  const restoredIds = Object.keys(reloaded.contexts);
  assert.equal(restoredIds.length, 60, "restore honors the same bound");
  assert.deepEqual(
    reloaded.contexts["session-a"].tabs.map((tab) => tab.id),
    [fileTab.id, browserTab.id],
    "the conversation on screen keeps its tabs across restart",
  );
  assert.equal(
    reloaded.contexts["session-a"].activeTabId,
    browserTab.id,
    "its active tab survives too",
  );
  assert.ok(
    reloaded.contexts["session-retained-00"],
    "retained conversations fill the capacity that is left",
  );
  assert.ok(reloaded.contexts["session-retained-58"]);
  assert.equal(
    reloaded.contexts["session-retained-59"],
    undefined,
    "capacity ends exactly at the bound",
  );

  useAppStore.getState().closeWorkPanelTab(browserTab.id);
  useAppStore.getState().closeWorkPanelTab(fileTab.id);
  assert.equal(
    stored().sessions["session-a"],
    undefined,
    "a visible conversation whose tabs are all closed leaves the record",
  );
  assert.equal(persistence.loadWorkPanelSnapshot().contexts["session-a"], undefined);
});
