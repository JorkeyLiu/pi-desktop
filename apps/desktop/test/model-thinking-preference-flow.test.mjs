import i18n from "i18next";
import { en } from "@pi-desktop/i18n";
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore, materializeDraftSession } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");
const { rememberModelThinkingLevel, loadModelThinkingPreferences } = await import(
  "../src/lib/model-thinking-preferences.ts"
);

const binding = (id, thinkingLevels, defaultThinkingLevel) => ({
  id, contextWindow: 32_000, maxTokens: 4_000, thinkingLevels, defaultThinkingLevel,
});
const catalogRow = (modelId) => ({ modelId, catalogSource: "models.dev", reasoning: true });

const providers = [
  { id: "p", enabled: true, authKind: "none", models: [
    binding("model-a", ["low", "high"], "high"),
    binding("model-b", ["low", "medium", "high"], "high"),
    binding("fresh", ["low", "high"], "high"),
  ] },
  { id: "q", enabled: true, authKind: "none", models: [binding("shared", ["low", "high"], "high")] },
  { id: "r", enabled: true, authKind: "none", models: [binding("shared", ["low", "high"], "high")] },
];
const catalog = {
  p: ["model-a", "model-b", "fresh"].map(catalogRow),
  q: [catalogRow("shared")],
  r: [catalogRow("shared")],
};

function withStorage(t) {
  const previousStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  t.after(() => { globalThis.localStorage = previousStorage; });
}

/** Start a new task from the home draft with the given model selected. */
async function createTaskThroughDraft({ providerId, modelId, draftThinkingLevel }) {
  useAppStore.setState({
    providers,
    providerModels: catalog,
    sessions: [],
    activeSessionId: null,
    draftConfiguration: draftThinkingLevel
      ? { mode: "agent", thinkingLevel: draftThinkingLevel, providerId, modelId }
      : null,
    recentModels: [{ providerId, modelId }],
    settings: { defaultProviderId: providerId, defaultModelId: modelId, defaultMode: "agent" },
    workspace: null,
    runningSessions: {},
    isRunning: false,
  });
  await materializeDraftSession();
  return useAppStore.getState().sessions.at(-1);
}

test("explicit thinking adjustments are remembered per provider and model", async (t) => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  withStorage(t);
  const created = [];
  t.mock.method(api, "createSession", async (config) => {
    const session = { ...config, id: `s${created.length + 1}`, title: "Task", messages: [] };
    created.push(session);
    return { session };
  });
  t.mock.method(api, "configureSession", async (id, config) => ({
    session: { ...useAppStore.getState().sessions.find((session) => session.id === id), ...config, id },
  }));
  t.mock.method(api, "getSession", async (id) => ({
    session: {
      ...useAppStore.getState().sessions.find((session) => session.id === id),
      messages: [],
    },
  }));

  // The user's explicit choices: A -> low, B -> medium, and the same wire id
  // under two different providers.
  rememberModelThinkingLevel({ providerId: "p", modelId: "model-a" }, "low");
  rememberModelThinkingLevel({ providerId: "p", modelId: "model-b" }, "medium");
  rememberModelThinkingLevel({ providerId: "q", modelId: "shared" }, "low");
  rememberModelThinkingLevel({ providerId: "r", modelId: "shared" }, "high");
  assert.deepEqual(
    Object.values(loadModelThinkingPreferences()).sort(),
    ["high", "low", "low", "medium"],
    "each provider/model pair stores its own level",
  );

  assert.equal(
    (await createTaskThroughDraft({ providerId: "p", modelId: "model-a" })).thinkingLevel,
    "low",
    "a new task starts at the level remembered for model A, not its binding default",
  );
  assert.equal(
    (await createTaskThroughDraft({ providerId: "p", modelId: "model-b" })).thinkingLevel,
    "medium",
    "model B keeps its own remembered level",
  );
  assert.equal(
    (await createTaskThroughDraft({ providerId: "p", modelId: "model-a" })).thinkingLevel,
    "low",
    "returning to model A restores A's earlier level; changing B did not leak into A",
  );
  assert.equal(
    (await createTaskThroughDraft({ providerId: "p", modelId: "model-b" })).thinkingLevel,
    "medium",
    "returning to model B restores B's earlier level",
  );
  assert.equal(
    (await createTaskThroughDraft({ providerId: "q", modelId: "shared" })).thinkingLevel,
    "low",
  );
  assert.equal(
    (await createTaskThroughDraft({ providerId: "r", modelId: "shared" })).thinkingLevel,
    "high",
    "the same model id under another provider keeps its own preference",
  );

  assert.equal(
    (await createTaskThroughDraft({ providerId: "p", modelId: "fresh" })).thinkingLevel,
    "high",
    "a model without a remembered preference keeps its existing binding default",
  );
  assert.equal(
    (await createTaskThroughDraft({
      providerId: "p", modelId: "model-a", draftThinkingLevel: "off",
    })).thinkingLevel,
    "off",
    "an explicit choice in the current draft outranks the remembered level",
  );

  // A saved level the model no longer supports is clamped onto what it accepts.
  rememberModelThinkingLevel({ providerId: "p", modelId: "model-a" }, "max");
  assert.equal(
    (await createTaskThroughDraft({ providerId: "p", modelId: "model-a" })).thinkingLevel,
    "high",
    "an unsupported remembered level is normalized to the nearest supported one",
  );
  rememberModelThinkingLevel({ providerId: "p", modelId: "model-a" }, "omit");
  assert.equal(
    (await createTaskThroughDraft({ providerId: "p", modelId: "model-a" })).thinkingLevel,
    "omit",
    "a remembered omit stays omit on a reasoning model",
  );
});

test("preferences survive a restart and never rewrite an existing session", async (t) => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  withStorage(t);
  const created = [];
  t.mock.method(api, "createSession", async (config) => {
    const session = { ...config, id: `s${created.length + 1}`, title: "Task", messages: [] };
    created.push(session);
    return { session };
  });
  const configureCalls = [];
  t.mock.method(api, "configureSession", async (id, config) => {
    configureCalls.push({ id, config });
    return {
      session: { ...useAppStore.getState().sessions.find((session) => session.id === id), ...config, id },
    };
  });
  t.mock.method(api, "getSession", async (id) => ({
    session: {
      ...useAppStore.getState().sessions.find((session) => session.id === id),
      messages: [],
    },
  }));

  rememberModelThinkingLevel({ providerId: "p", modelId: "model-a" }, "low");
  const restored = await createTaskThroughDraft({ providerId: "p", modelId: "model-a" });
  assert.equal(restored.thinkingLevel, "low", "the remembered level survives a fresh renderer state");

  // Reopening a session keeps that session's own stored level even though the
  // model memory now says something else.
  useAppStore.setState({
    sessions: [{ ...restored, thinkingLevel: "medium", providerId: "p", modelId: "model-a" }],
    activeSessionId: null,
    draftConfiguration: null,
    sessionHistory: {},
    retainedSessionIds: [],
    retainedTranscripts: {},
    transcriptViews: {},
  });
  await useAppStore.getState().selectSession(restored.id);
  assert.equal(useAppStore.getState().activeSessionId, restored.id);
  assert.equal(
    useAppStore.getState().sessions.find((session) => session.id === restored.id).thinkingLevel,
    "medium",
    "an existing session keeps the thinking level it stored",
  );
  assert.deepEqual(
    configureCalls.filter((call) => call.config.thinkingLevel !== undefined),
    [],
    "opening a session does not re-apply the model memory over its stored level",
  );
});
