import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createAutomaticSessionTitleService } = await import("../electron/main/services/automatic-session-title.ts");

const serverForRenderer = () => createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });

function titleHarness(settings, complete) {
  let currentTitle = "New task";
  let manualRename = false;
  let completionCalls = 0;
  const writes = [];
  const titleService = createAutomaticSessionTitleService({
    getSettings: async () => settings,
    complete: async (input) => { completionCalls++; return complete(input); },
    logger: { app() {} },
    setAutomaticTitle: async (input) => {
      writes.push(input);
      if (manualRename || currentTitle !== input.expectedTitle) return { updated: false };
      currentTitle = input.title;
      return { updated: true };
    },
  });
  return {
    titleService, writes,
    get completionCalls() { return completionCalls; },
    get currentTitle() { return currentTitle; },
    renameManually(title) { manualRename = true; currentTitle = title; },
  };
}

test("first prompt keeps fallback immediate and runs one async title completion for its session", async () => {
  const server = await serverForRenderer();
  const oldWindow = globalThis.window;
  try {
    const { createQueueSlice } = await server.ssrLoadModule("/src/stores/slices/queue-slice.ts");
    const calls = [];
    let finishCompletion;
    let commitFallback;
    globalThis.window = { piDesktop: { invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      if (channel.endsWith("deriveTitle")) return new Promise((resolve) => { commitFallback = resolve; });
      if (channel.endsWith("titleGenerate")) return new Promise((resolve) => { finishCompletion = resolve; });
      if (channel.endsWith("prompt")) return { ok: true, data: { turnId: "turn" } };
      throw new Error(`Unexpected ${channel}`);
    } } };
    let state = { activeSessionId: "s1", sessions: [{ id: "s1", title: "New task", source: "desktop" }], messages: [], pendingPlans: {}, runningSessions: {}, latestTurnResults: {}, sessionOutcomes: {}, settings: { fastModelProviderId: "p", fastModelId: "m" }, showToast: assert.fail, rememberModel() {}, refreshSessions: async () => {} };
    const runtime = { submittedComposerDrafts: new Map(), sessionTranscriptCache: new Map(), insertOptimisticUserMessage() {}, retractOptimisticUserMessage() {} };
    const slice = createQueueSlice({ get: () => state, set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; }, runtime,
      promptAttachmentsFromDraft: () => [], withoutRecordKey: (record, key) => { const next = { ...record }; delete next[key]; return next; },
      viewingSessionIdForPrompt: () => "s1", messageErrorFromUnknown: () => ({}), assistantErrorMessage: () => ({}), materializeDraftSession: async () => null });
    assert.equal(await slice.sendPrompt("Write a small utility", undefined, "s1"), true);
    assert.equal(calls.some(([channel]) => channel.endsWith("titleGenerate")), false);
    commitFallback({ ok: true, data: { updated: true } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.find(([channel]) => channel.endsWith("titleGenerate"))[1], { sessionId: "s1", prompt: "Write a small utility", fallbackTitle: "Write a small utility" });
    assert.equal(calls.filter(([channel]) => channel.endsWith("titleGenerate")).length, 1);
  } finally { globalThis.window = oldWindow; await server.close(); }
});

test("title completion uses explicit fast model and CAS preserves a manual rename during completion", async () => {
  let finishCompletion;
  const harness = titleHarness({ fastModelProviderId: "provider", fastModelId: "model" }, () => new Promise((resolve) => { finishCompletion = resolve; }));
  const pending = harness.titleService({ sessionId: "s1", prompt: "  Fix login  ", expectedTitle: "Fix login" });
  await new Promise((resolve) => setImmediate(resolve));
  harness.renameManually("My session");
  finishCompletion({ text: "Title: `Login repair`" });
  await pending;
  assert.equal(harness.completionCalls, 1);
  assert.equal(harness.currentTitle, "My session");
  assert.equal(harness.writes[0].expectedTitle, "Fix login");
  assert.equal(harness.writes[0].title, "Login repair");
});

test("missing or cleared fast binding skips completion; completion failures leave fallback untouched", async () => {
  for (const settings of [undefined, {}, { fastModelProviderId: null, fastModelId: null }]) {
    const harness = titleHarness(settings, async () => ({ text: "unused" }));
    await harness.titleService({ sessionId: "s1", prompt: "Fix login", expectedTitle: "Fix login" });
    assert.equal(harness.completionCalls, 0);
    assert.equal(harness.currentTitle, "New task");
  }
  const failing = titleHarness({ fastModelProviderId: "provider", fastModelId: "model" }, async () => { throw new Error("provider unavailable"); });
  await failing.titleService({ sessionId: "s1", prompt: "Fix login", expectedTitle: "Fix login" });
  assert.equal(failing.completionCalls, 1);
  assert.equal(failing.currentTitle, "New task");
  assert.equal(failing.writes.length, 0);
});
