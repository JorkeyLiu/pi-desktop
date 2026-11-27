/**
 * A successful edit/retry leaves the old reading view.
 *
 * Retrying from a held search/bookmark/history view replaces the live
 * messages, but `transcriptViews[sessionId]` kept rendering the pre-retry
 * snapshot. The retry must exit through the existing reading-view exit
 * transition so the pane shows the new latest branch.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");

const row = (id, role, content) => ({ id, role, content });

function seedStore(sessionId, messages, heldMessages) {
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
    activeSessionId: sessionId,
    messages,
    sessionHistory: {},
    transcriptViews: {
      [sessionId]: {
        // A plain held history window: no search focus, not a restored
        // bookmark — exactly the view the running-edge release ignores.
        messages: heldMessages,
        messageStart: 0,
        hasMoreAfter: true,
        hasMoreBefore: false,
        focus: null,
        loading: null,
      },
    },
    subagentHistory: {},
    retainedSessionIds: [sessionId],
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

test("a successful user-message edit exits the held reading view", async (t) => {
  const sessionId = "edit-exits-view";
  const live = [row("u1", "user", "hello"), row("a1", "assistant", "hi")];
  seedStore(sessionId, live, [...live]);
  t.mock.method(api, "prompt", async () => ({}));
  const ok = await useAppStore.getState().editUserMessage("u1", "hello again");
  assert.equal(ok, true);
  const state = useAppStore.getState();
  assert.equal(
    state.transcriptViews[sessionId],
    undefined,
    "the pre-retry snapshot must not keep rendering after the branch is replaced",
  );
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].content, "hello again");
});

test("a successful retry of the last prompt exits the held reading view", async (t) => {
  const sessionId = "retry-exits-view";
  const kept = [row("u1", "user", "hello")];
  seedStore(sessionId, [...kept, row("a1", "assistant", "hi")], [...kept]);
  const prompts = [];
  t.mock.method(api, "prompt", async (request) => {
    prompts.push(request);
    return {};
  });
  await useAppStore.getState().retryLastPrompt();
  const state = useAppStore.getState();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].truncateFromMessageId, "u1");
  assert.equal(
    state.transcriptViews[sessionId],
    undefined,
    "the pre-retry snapshot must not keep rendering after the branch is replaced",
  );
  // The last user prompt is resent through the host cut; its prefix stays live.
  assert.deepEqual(
    state.messages.map((message) => message.id),
    [],
  );
});
