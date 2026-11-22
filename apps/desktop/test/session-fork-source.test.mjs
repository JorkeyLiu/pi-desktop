import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { api } = await import("../src/lib/api.ts");
const { default: i18next } = await import("i18next");
await i18next.init({
  lng: "en",
  resources: { en: { translation: {
    chat: { untitledTask: "Untitled", sessionTranscriptEmpty: "History unreadable" },
    nav: { branchTitle: "{{title}} (branch)" },
  } } },
});

const assistant = (id, content) => ({ id, role: "assistant", content, status: "complete" });

function harness(t, { activeId, panes }) {
  const sessions = Object.keys(panes).map((id) => ({ id, title: `Task ${id}`, mode: "agent" }));
  let state = {
    activeSessionId: activeId,
    selectingSessionId: undefined,
    isRunning: false,
    runningSessions: {},
    messages: [...panes[activeId]],
    sessions,
    sessionHistory: {},
    transcriptViews: {},
    sessionMeta: {},
    sessionCompactions: {},
    planningStates: {},
    retainedSessionIds: Object.keys(panes),
    retainedTranscripts: Object.fromEntries(Object.entries(panes).map(([id, rows]) => [id, [...rows]])),
    workPanelContexts: {},
    workPanelTabs: [],
    workPanelOpen: false,
    navStack: [{ page: "chat", sessionId: activeId }],
    navIndex: 0,
    toasts: [],
    showToast: (message, options) => {
      state = { ...state, toasts: [...state.toasts, { message, options }] };
    },
    error: null,
    errorCode: null,
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
  };
  let intent = 0;
  const cache = new Map();
  const runtime = {
    beginNavigationIntent: () => ++intent,
    navigationIntentIsCurrent: (value) => value === intent,
    cacheSessionTranscript: (id, messages) => cache.set(id, messages),
    loadFullSessionMessages: () => assert.fail("reply fork must not hydrate over a live transcript"),
  };
  const access = {
    get: () => state,
    set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    runtime,
    decorateSessions: (list) => list,
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
  };
  const coordination = createSessionCoordination(access);
  const slice = createSessionSlice({ ...access, ...coordination });
  const calls = [];
  t.mock.method(api, "forkSession", (id, title, anchor) => {
    calls.push({ id, title, anchor });
    return Promise.resolve({ session: { id: `child-of-${id}`, title, mode: "agent", messages: [] } });
  });
  return { slice, get: access.get, set: access.set, calls };
}

test("same-session reply fork still targets the active transcript (ordinary click control)", async (t) => {
  const reply = assistant("a1", "completed reply");
  const h = harness(t, { activeId: "A", panes: { A: [{ id: "u1", role: "user", content: "hi" }, reply] } });
  await h.slice.forkAssistantMessage("a1");
  assert.equal(h.calls.length, 1, "the ordinary same-session branch must reach the host");
  assert.equal(h.calls[0].id, "A");
  assert.equal(h.calls[0].anchor, "a1");
  assert.equal(h.get().activeSessionId, "child-of-A", "the child session activates");
});

test("reply fork targets its explicit source pane when another session is active", async (t) => {
  const reply = assistant("a1", "completed reply in A");
  const h = harness(t, {
    activeId: "B",
    panes: {
      A: [{ id: "u1", role: "user", content: "hi" }, reply],
      B: [{ id: "u2", role: "user", content: "other" }, assistant("b1", "other reply")],
    },
  });
  await h.slice.forkAssistantMessage("a1", "A");
  assert.equal(h.calls.length, 1, "an explicit source pane must fork instead of silently missing against B");
  assert.equal(h.calls[0].id, "A");
  assert.equal(h.calls[0].anchor, "a1");
  assert.ok(h.get().sessions.some((session) => session.id === "child-of-A"), "the child is recorded");
});

test("a stale menu whose anchor left the retained snapshot reports instead of no-op", async (t) => {
  const h = harness(t, {
    activeId: "B",
    panes: {
      A: [{ id: "u1", role: "user", content: "hi" }],
      B: [{ id: "u2", role: "user", content: "other" }],
    },
  });
  await h.slice.forkAssistantMessage("a1", "A");
  assert.equal(h.calls.length, 0, "a missing anchor must not fork an unrelated transcript");
  assert.deepEqual(
    h.get().toasts.map((toast) => toast.options?.variant),
    ["error"],
    "the stale branch reports through the existing error toast path",
  );
});

test("a historical reply held by the reading view forks its own active session", async (t) => {
  const reply = assistant("a1", "older completed reply");
  const h = harness(t, {
    activeId: "A",
    panes: { A: [{ id: "u1", role: "user", content: "hi" }] },
  });
  h.set((state) => ({
    transcriptViews: {
      ...state.transcriptViews,
      A: {
        messages: [{ id: "u1", role: "user", content: "hi" }, reply],
        messageStart: 0,
        hasMoreBefore: false,
        hasMoreAfter: false,
        focus: null,
        restored: true,
      },
    },
  }));
  await h.slice.forkAssistantMessage("a1", "A");
  assert.equal(h.calls.length, 1, "the rendered historical reply must fork instead of silently missing");
  assert.equal(h.calls[0].id, "A");
  assert.equal(h.calls[0].anchor, "a1");
  assert.ok(h.get().sessions.some((session) => session.id === "child-of-A"), "the child is recorded");
});

test("default lookup without an explicit source stays silent for unknown anchors", async (t) => {
  const h = harness(t, {
    activeId: "A",
    panes: { A: [{ id: "u1", role: "user", content: "hi" }] },
  });
  await h.slice.forkAssistantMessage("missing");
  assert.equal(h.calls.length, 0);
  assert.equal(h.get().toasts.length, 0, "the default path keeps its existing silent guards");
});
