import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { IPC } from "@pi-desktop/shared";

test("sending the first prompt derives a replaceable title instead of renaming", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previousWindow = globalThis.window;
  try {
    const { createQueueSlice } = await server.ssrLoadModule("/src/stores/slices/queue-slice.ts");
    const invoked = [];
    let refreshed = 0;
    globalThis.window = { piDesktop: { invoke: async (channel, ...args) => {
      invoked.push([channel, ...args]);
      if (channel === IPC.invoke.agentPrompt) return { ok: true, data: { turnId: "turn-1" } };
      if (channel === IPC.invoke.sessionDeriveTitle) return { ok: true, data: { updated: true } };
      if (channel === IPC.invoke.sessionTitleGenerate) return { ok: true, data: { updated: true } };
      throw new Error(`Unexpected IPC: ${channel}`);
    } } };
    let state = {
      activeSessionId: "session-a",
      sessions: [{ id: "session-a", title: "New task", source: "desktop" }],
      messages: [],
      pendingPlans: {},
      runningSessions: {},
      latestTurnResults: {},
      sessionOutcomes: {},
      showToast: assert.fail,
      rememberModel() {},
      refreshSessions: async () => {
        refreshed += 1;
      },
    };
    const runtime = {
      submittedComposerDrafts: new Map(),
      sessionTranscriptCache: new Map(),
      insertOptimisticUserMessage() {},
      retractOptimisticUserMessage() {},
    };
    const slice = createQueueSlice({
      get: () => state,
      set: (update) => {
        const next = typeof update === "function" ? update(state) : update;
        state = { ...state, ...next };
      },
      runtime,
      promptAttachmentsFromDraft: () => [],
      withoutRecordKey: (record, key) => {
        const next = { ...record };
        delete next[key];
        return next;
      },
      viewingSessionIdForPrompt: () => "session-a",
      messageErrorFromUnknown: (error) => ({ code: "FAILED", message: String(error) }),
      assistantErrorMessage: () => ({ role: "assistant", content: "failed" }),
      materializeDraftSession: async () => null,
    });

    assert.equal(await slice.sendPrompt("Summarize the first turn", undefined, "session-a"), true);
    // The host, not the renderer, owns the title: the sidebar keeps the
    // placeholder until the derived title comes back, and the rename path stays
    // unused so an installed title plugin can still replace the derived text.
    assert.equal(state.sessions[0].title, "New task");
    assert.deepEqual(
      invoked.filter(([channel]) => channel === IPC.invoke.sessionDeriveTitle),
      [[IPC.invoke.sessionDeriveTitle, "session-a", "Summarize the first turn"]],
    );
    assert.equal(invoked.some(([channel]) => channel.endsWith("titleGenerate")), true);
    assert.equal(invoked.some(([channel]) => channel === IPC.invoke.sessionRename), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshed, 1);
  } finally {
    globalThis.window = previousWindow;
    await server.close();
  }
});

test("Send now promotes queued input without stopping the running session", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previousWindow = globalThis.window;
  try {
    const { createQueueSlice } = await server.ssrLoadModule("/src/stores/slices/queue-slice.ts");
    const invoked = [];
    let entries = [];
    globalThis.window = { piDesktop: { invoke: async (channel, payload) => {
      invoked.push([channel, payload]);
      if (channel === IPC.invoke.agentQueuePush) {
        const entry = { ...payload, id: "queued-correction", position: 1, createdAt: "2026-10-13T00:00:00Z" };
        entries = [entry];
        return { ok: true, data: entry };
      }
      if (channel === IPC.invoke.agentQueuePrioritize) return { ok: true, data: { ok: true } };
      if (channel === IPC.invoke.agentStop) return { ok: true, data: { requested: true } };
      if (channel === IPC.invoke.agentQueueList) return { ok: true, data: { entries } };
      throw new Error(`Unexpected IPC: ${channel}`);
    } } };
    let state = {
      activeSessionId: "session-a", sessions: [{ id: "session-a", source: "desktop" }],
      pendingPlans: {}, runningSessions: { "session-a": true }, queuedPrompts: {}, showToast: assert.fail,
      // Queueing is the explicit preference; this test covers the Send-now row.
      settings: { sendWhileRunningMode: "queue" },
    };
    const slice = createQueueSlice({
      get: () => state,
      set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
      promptAttachmentsFromDraft: () => [],
    });
    Object.assign(state, slice);
    assert.equal(await slice.sendPrompt("Correct the plan now."), true);
    assert.equal(state.queuedPrompts["session-a"].length, 1);
    assert.equal(invoked.some(([channel]) => channel === IPC.invoke.agentQueuePrioritize), false);
    await slice.sendQueuedNow("queued-correction");
    assert.equal(invoked.filter(([channel]) => channel === IPC.invoke.agentQueuePrioritize).length, 1);
    assert.equal(invoked.some(([channel]) => channel === IPC.invoke.agentStop), false);
    assert.equal(state.runningSessions["session-a"], true);
    slice.applyQueueChanged({ sessionId: "session-a", entries: [] });
    assert.deepEqual(state.queuedPrompts["session-a"] ?? [], []);
  } finally {
    globalThis.window = previousWindow;
    await server.close();
  }
});

test("pending queue actions stay locked until admission succeeds", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previousWindow = globalThis.window;
  try {
    const { createQueueSlice } = await server.ssrLoadModule("/src/stores/slices/queue-slice.ts");
    const { ComposerStatus } = await server.ssrLoadModule("/src/features/chat/composer/ComposerStatus.tsx");
    for (const action of ["removeQueuedPrompt", "editQueuedPrompt"]) {
      await t.test(action, async () => {
        let resolvePush;
        const admission = new Promise((resolve) => { resolvePush = resolve; });
        let entries = [];
        const removed = [];
        globalThis.window = { piDesktop: { invoke: async (channel, payload) => {
          if (channel === IPC.invoke.agentQueuePush) {
            await admission;
            const entry = { ...payload, id: "durable-turn", createdAt: "2026-09-21T00:00:00Z" };
            entries = [entry];
            return { ok: true, data: entry };
          }
          if (channel === IPC.invoke.agentQueueList) return { ok: true, data: { entries } };
          if (channel === IPC.invoke.agentQueueRemove) {
            removed.push(payload.turnId);
            entries = entries.filter((entry) => entry.id !== payload.turnId);
            return { ok: true, data: {} };
          }
          throw new Error(`Unexpected IPC: ${channel}`);
        } } };
        let state = { activeSessionId: "session-a", sessions: [{ id: "session-a", source: "desktop" }], queuedPrompts: {}, showToast: assert.fail };
        const slice = createQueueSlice({
          get: () => state,
          set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
          promptAttachmentsFromDraft: () => [],
        });
        Object.assign(state, slice);
        const draft = { text: "Please review this file", fileReferences: [{ path: "/test/example.ts", name: "example.ts" }] };
        const saving = slice.enqueuePrompt(draft.text, draft);
        const pending = state.queuedPrompts["session-a"][0];
        const renderButtons = () => renderToStaticMarkup(createElement(ComposerStatus, {
          t: (key) => key, queuedPrompts: state.queuedPrompts["session-a"] ?? [],
          ...slice, approvalPending: false, enhancementError: null, droppedDirectories: [],
        })).match(/<button\b[^>]*>/g) ?? [];
        const pendingButtons = renderButtons();
        assert.equal(pendingButtons.length, 5);
        assert.ok(pendingButtons.every((button) => / disabled=""/.test(button)), "all pending row actions must be disabled");
        assert.ok(pendingButtons.every((button) => /aria-label="[^"]*common.saving/.test(button)), "every pending action must explain that admission is still saving");
        const pendingMarkup = renderToStaticMarkup(createElement(ComposerStatus, {
          t: (key) => key, queuedPrompts: [pending], ...slice,
          approvalPending: false, enhancementError: null, droppedDirectories: [],
        }));
        assert.match(pendingMarkup, /class="composer-queued-prompt-send-now"[^>]*>common.saving<\/button>/);
        slice[action](pending.id);
        assert.deepEqual(state.queuedPrompts["session-a"], [pending], "pending row must not appear deleted");
        assert.equal(state.composerPrefill, undefined, "pending edit must not restore a second draft");
        assert.deepEqual(removed, []);
        resolvePush();
        assert.equal(await saving, true);
        await slice.refreshQueuedPrompts("session-a");
        assert.ok(renderButtons().every((button) => !/ disabled=""/.test(button)), "acknowledged row actions unlock");
        assert.ok(renderButtons().every((button) => !button.includes("common.saving")), "saving labels clear after acknowledgement");
        slice[action]("durable-turn");
        await slice.refreshQueuedPrompts("session-a");
        assert.deepEqual(removed, ["durable-turn"]);
        assert.deepEqual(entries, []);
        assert.deepEqual(state.queuedPrompts["session-a"] ?? [], []);
        if (action === "editQueuedPrompt") {
          assert.deepEqual(state.composerPrefill, { sessionId: "session-a", ...draft });
        }
      });
    }
    await t.test("failed admission clears the pending row and permits another submission", async () => {
      let rejectPush;
      const admission = new Promise((_, reject) => { rejectPush = reject; });
      const errors = [];
      let entries = [];
      globalThis.window = { piDesktop: { invoke: async (channel, payload) => {
        if (channel === IPC.invoke.agentQueuePush) {
          if (!errors.length) await admission;
          const entry = { ...payload, id: "retried-turn", createdAt: "2026-09-21T00:00:00Z" };
          entries = [entry];
          return { ok: true, data: entry };
        }
        if (channel === IPC.invoke.agentQueueList) return { ok: true, data: { entries } };
        throw new Error(`Unexpected IPC: ${channel}`);
      } } };
      let state = { activeSessionId: "session-a", sessions: [{ id: "session-a", source: "desktop" }], queuedPrompts: {}, showToast: (message) => errors.push(message) };
      const slice = createQueueSlice({
        get: () => state,
        set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
        promptAttachmentsFromDraft: () => [],
      });
      Object.assign(state, slice);
      const saving = slice.enqueuePrompt("Retry this prompt");
      assert.equal(state.queuedPrompts["session-a"].length, 1);
      rejectPush(new Error("host RPC timeout: session.queuePush"));
      assert.equal(await saving, false, "composer must receive rejection so it can restore the draft");
      assert.deepEqual(state.queuedPrompts["session-a"] ?? [], []);
      assert.deepEqual(errors, ["host RPC timeout: session.queuePush"]);
      assert.equal(await slice.enqueuePrompt("Retry this prompt"), true);
      await slice.refreshQueuedPrompts("session-a");
      assert.equal(state.queuedPrompts["session-a"][0].id, "retried-turn");
    });
  } finally {
    globalThis.window = previousWindow;
    await server.close();
  }
});

test("editing a restored queue preserves attachments when resubmitted", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previousWindow = globalThis.window;
  try {
    const { createQueueSlice } = await server.ssrLoadModule("/src/stores/slices/queue-slice.ts");
    const image = { path: "/scratch/icon.png", name: "icon.png", kind: "image", mimeType: "image/png" };
    const file = { path: "/scratch/notes.txt", name: "notes.txt", kind: "file", mimeType: "text/plain" };
    for (const [name, content, attachments] of [
      ["image and file", "Review @/scratch/notes.txt with the image", [image, file]],
      ["image only", "", [image]],
      ["text only", "Review the plan", undefined],
    ]) {
      await t.test(name, async () => {
        let entries = [{ id: "restored-turn", sessionId: "session-a", content, attachments,
          position: 1, createdAt: "2026-09-23T00:00:00Z" }];
        let submitted;
        globalThis.window = { piDesktop: { invoke: async (channel, payload) => {
          if (channel === IPC.invoke.agentQueueList) return { ok: true, data: { entries } };
          if (channel === IPC.invoke.agentQueueRemove) {
            entries = entries.filter((entry) => entry.id !== payload.turnId);
            return { ok: true, data: {} };
          }
          if (channel === IPC.invoke.agentQueuePush) {
            submitted = payload;
            const entry = { ...payload, id: "resubmitted-turn", position: 1, createdAt: "2026-09-23T00:00:01Z" };
            entries = [entry];
            return { ok: true, data: entry };
          }
          throw new Error(`Unexpected IPC: ${channel}`);
        } } };
        let state = { activeSessionId: "session-a", sessions: [{ id: "session-a", source: "desktop" }], queuedPrompts: {}, showToast: assert.fail };
        const slice = createQueueSlice({
          get: () => state,
          set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
          promptAttachmentsFromDraft: (references) => references.map(({ path, name, kind, mimeType }) => ({ path, name, kind, mimeType })),
        });
        Object.assign(state, slice);
        await slice.refreshQueuedPrompts("session-a");
        slice.editQueuedPrompt("restored-turn");
        assert.deepEqual(entries, [], "editing removes the original queued entry");
        assert.deepEqual(state.composerPrefill, {
          sessionId: "session-a", text: content, fileReferences: (attachments ?? []).map((attachment) =>
            attachment.kind === "file" ? { ...attachment, token: "@/scratch/notes.txt" } : attachment),
        }, "restored draft retains the Host's text and attachments");
        assert.equal(await slice.enqueuePrompt(state.composerPrefill.text, state.composerPrefill), true);
        assert.equal(submitted.content, content, "resubmitting must not rewrite serialized file references");
        assert.deepEqual(submitted.attachments ?? [], attachments ?? [], "resubmitting must keep the same attachments");
      });
    }
  } finally {
    globalThis.window = previousWindow;
    await server.close();
  }
});

test("a running session follows the send-while-running preference", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previousWindow = globalThis.window;
  try {
    const { createQueueSlice } = await server.ssrLoadModule(
      "/src/stores/slices/queue-slice.ts",
    );
    const makeHarness = ({
      settings,
      running = true,
      statuses = { "session-a": { currentTurnId: "turn-1" } },
      steerFailure,
    } = {}) => {
      const invoked = [];
      const toasts = [];
      let entries = [];
      globalThis.window = { piDesktop: { invoke: async (channel, payload) => {
        invoked.push([channel, payload]);
        if (channel === IPC.invoke.agentSteer) {
          if (steerFailure instanceof Error) throw steerFailure;
          if (steerFailure) return { ok: false, error: steerFailure };
          return { ok: true, data: { turnId: "turn-1" } };
        }
        if (channel === IPC.invoke.agentPrompt) return { ok: true, data: { turnId: "turn-2" } };
        if (channel === IPC.invoke.agentQueuePush) {
          const entry = { ...payload, id: "queued-turn", position: 1, createdAt: "2026-10-13T00:00:00Z" };
          entries = [entry];
          return { ok: true, data: entry };
        }
        if (channel === IPC.invoke.agentQueueList) return { ok: true, data: { entries } };
        throw new Error(`Unexpected IPC: ${channel}`);
      } } };
      let state = {
        activeSessionId: "session-a",
        sessions: [{ id: "session-a", title: "Existing chat", source: "desktop" }],
        messages: [],
        pendingPlans: {},
        runningSessions: running ? { "session-a": true } : {},
        agentStatuses: statuses,
        queuedPrompts: {},
        latestTurnResults: {},
        sessionOutcomes: {},
        settings,
        showToast: (message) => toasts.push(message),
        rememberModel() {},
        refreshSessions: async () => {},
      };
      const slice = createQueueSlice({
        get: () => state,
        set: (patch) => {
          state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
        },
        runtime: {
          submittedComposerDrafts: new Map(),
          sessionTranscriptCache: new Map(),
          insertOptimisticUserMessage() {},
          retractOptimisticUserMessage() {},
        },
        promptAttachmentsFromDraft: () => [],
        withoutRecordKey: (record, key) => {
          const next = { ...record };
          delete next[key];
          return next;
        },
        viewingSessionIdForPrompt: () => "session-a",
        messageErrorFromUnknown: (error) => ({
          code: error?.code ?? "FAILED",
          message: error?.message ?? String(error),
        }),
        assistantErrorMessage: () => ({ role: "assistant", content: "failed" }),
        materializeDraftSession: async () => null,
      });
      Object.assign(state, slice);
      return { invoked, toasts, slice, state: () => state };
    };
    const channels = (harness, channel) =>
      harness.invoked.filter(([invokedChannel]) => invokedChannel === channel);

    await t.test("the default steers the turn that is already running", async () => {
      const harness = makeHarness();
      const accepted = [];
      assert.equal(
        await harness.slice.sendPrompt("Adjust the plan", undefined, "session-a", (id) => accepted.push(id)),
        true,
      );
      const steerCalls = channels(harness, IPC.invoke.agentSteer);
      assert.equal(steerCalls.length, 1);
      assert.equal(steerCalls[0][1].sessionId, "session-a");
      assert.equal(steerCalls[0][1].expectedTurnId, "turn-1");
      assert.equal(steerCalls[0][1].content, "Adjust the plan");
      assert.equal(channels(harness, IPC.invoke.agentQueuePush).length, 0);
      assert.deepEqual(accepted, ["session-a"]);
      assert.deepEqual(harness.toasts, []);
    });

    await t.test("a settings document without the field keeps steering", async () => {
      for (const stored of [{}, { enterToSend: true }]) {
        const harness = makeHarness({ settings: stored });
        assert.equal(await harness.slice.sendPrompt("Follow up", undefined, "session-a"), true);
        assert.equal(channels(harness, IPC.invoke.agentSteer).length, 1);
        assert.equal(channels(harness, IPC.invoke.agentQueuePush).length, 0);
      }
    });

    await t.test("the queue preference waits for the turn to finish", async () => {
      const harness = makeHarness({ settings: { sendWhileRunningMode: "queue" } });
      assert.equal(await harness.slice.sendPrompt("Original request", undefined, "session-a"), true);
      assert.equal(channels(harness, IPC.invoke.agentSteer).length, 0);
      assert.equal(channels(harness, IPC.invoke.agentQueuePush).length, 1);
      assert.equal(harness.state().queuedPrompts["session-a"].length, 1);
    });

    await t.test("a session that cannot be steered queues instead of losing the message", async () => {
      const harness = makeHarness({ statuses: {} });
      assert.equal(await harness.slice.sendPrompt("Keep this", undefined, "session-a"), true);
      assert.equal(channels(harness, IPC.invoke.agentSteer).length, 0);
      assert.equal(channels(harness, IPC.invoke.agentQueuePush).length, 1);
      assert.deepEqual(
        harness.toasts,
        [],
        "an automatic fallback does not explain a mode the user did not pick",
      );
      assert.equal(harness.state().queuedPrompts["session-a"][0].content, "Keep this");
    });

    await t.test("a refusal raised before acceptance queues the message once, quietly", async () => {
      const harness = makeHarness({
        steerFailure: { code: "TURN_NOT_FOUND", message: "Turn not found" },
      });
      assert.equal(await harness.slice.sendPrompt("Race the turn", undefined, "session-a"), true);
      assert.equal(
        channels(harness, IPC.invoke.agentQueuePush).length,
        1,
        "a pre-acceptance refusal queues exactly once",
      );
      assert.equal(harness.state().queuedPrompts["session-a"].length, 1);
      assert.equal(harness.state().queuedPrompts["session-a"][0].content, "Race the turn");
      assert.deepEqual(
        harness.toasts,
        [],
        "the message waits in the queue, so no draft-kept notice is shown",
      );
    });

    await t.test("an unconfirmed steering failure keeps the draft instead of queueing", async () => {
      for (const steerFailure of [
        new Error("sidecar transport closed"),
        { code: "INTERNAL", message: "sidecar transport closed" },
      ]) {
        const harness = makeHarness({ steerFailure });
        const accepted = [];
        assert.equal(
          await harness.slice.sendPrompt("Unconfirmed", undefined, "session-a", (id) => accepted.push(id)),
          false,
          "the caller must restore the draft, not report a claim it cannot verify",
        );
        assert.equal(
          channels(harness, IPC.invoke.agentQueuePush).length,
          0,
          "an accepted copy may exist, so queueing could send the message twice",
        );
        assert.deepEqual(harness.state().queuedPrompts, {});
        assert.deepEqual(accepted, []);
        assert.deepEqual(
          harness.toasts,
          ["sidecar transport closed"],
          "the failure is surfaced with its own message",
        );
      }
    });

    await t.test("the steering shortcut still explains a refusal the Host raised", async () => {
      for (const steerFailure of [
        { code: "TURN_NOT_FOUND", message: "Turn not found" },
        new Error("sidecar transport closed"),
      ]) {
        const harness = makeHarness({ steerFailure });
        assert.equal(await harness.slice.steerPrompt("Try to steer"), false);
        assert.equal(channels(harness, IPC.invoke.agentQueuePush).length, 0);
        assert.equal(harness.toasts.length, 1, "the explicit shortcut explains every refusal");
      }
    });

    await t.test("the steering shortcut still explains an unavailable turn", async () => {
      const harness = makeHarness({ statuses: {} });
      assert.equal(await harness.slice.steerPrompt("Try to steer"), false);
      assert.equal(harness.invoked.length, 0);
      assert.equal(harness.toasts.length, 1);
    });

    await t.test("a settled session still sends a normal prompt", async () => {
      const harness = makeHarness({ running: false });
      assert.equal(await harness.slice.sendPrompt("Start something new", undefined, "session-a"), true);
      assert.equal(channels(harness, IPC.invoke.agentSteer).length, 0);
      assert.equal(channels(harness, IPC.invoke.agentQueuePush).length, 0);
      const promptCalls = channels(harness, IPC.invoke.agentPrompt);
      assert.equal(promptCalls.length, 1);
      assert.equal(promptCalls[0][1].content, "Start something new");
    });
  } finally {
    globalThis.window = previousWindow;
    await server.close();
  }
});
