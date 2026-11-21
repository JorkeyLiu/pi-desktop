/**
 * Parallel tool rows must keep the order the model announced them in.
 *
 * Two calls prepared as A then B render A above B. B finishing first must not
 * move B above A, and A finishing afterwards must not move either row. The
 * reported regression is a live one: no session switch, no renderer reload.
 *
 * These tests drive the production entry points only:
 *   - `handleAgentEvent` on the real app store (active session and the
 *     background transcript cache, both real slices),
 *   - `selectSession` on the real session slice (durable read + commit),
 *   - the real `TranscriptHistory` React components rendered to HTML, so the
 *     assertion is the DOM order the user sees and not only the array order,
 *   - the real main-process persistence wiring (event persistence + outbox)
 *     against a mock host, so the durable append order the renderer has to
 *     merge is measured rather than assumed.
 *
 * Only the transport (`api.getSession`) is stubbed.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const root = fileURLToPath(new URL("..", import.meta.url));
const START = Date.parse("2026-10-13T00:00:00.000Z");
const at = (offset) => new Date(START + offset).toISOString();
const iso = (offset) => at(offset);

/** One Vite server for the whole file: every module below is the real one. */
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true, hmr: false, ws: false },
  esbuild: { jsx: "automatic" },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
test.after(async () => {
  await vite.close();
});

const { api } = await vite.ssrLoadModule("/src/lib/api.ts");
const { useAppStore } = await vite.ssrLoadModule("/src/stores/app-store.ts");
const { getTranscriptProjection } = await vite.ssrLoadModule("/src/lib/transcript-projection.ts");
const { buildTranscriptEntries } = await vite.ssrLoadModule("/src/lib/assistant-turns.ts");
const { TranscriptHistory } = await vite.ssrLoadModule(
  "/src/features/chat/transcript/AssistantTurn.tsx",
);
const { SlotSessionProvider } = await vite.ssrLoadModule("/src/plugins/renderer-slots/use-slots.tsx");

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });

const originalGetSession = api.getSession;

const userRow = (id = "user-1") => ({
  id, role: "user", content: "Run both commands.", createdAt: iso(0), status: "complete",
});

const summary = (id) => ({
  id,
  source: "local",
  title: `fixture ${id}`,
  mode: "agent",
  thinkingLevel: "high",
  permissionMode: "auto",
  messageCount: 1,
  createdAt: iso(0),
  updatedAt: iso(0),
});

/**
 * Order as the transcript actually paints it: the projection keeps every entry
 * but the tail as `history` and renders the tail last, so the painted sequence
 * is `history` followed by the last entry.
 */
function paintedOrder(messages) {
  const projection = getTranscriptProjection(messages);
  const tail = projection.entries.at(-1);
  const entries = tail ? [...projection.history, tail] : projection.history;
  const ids = [];
  const collect = (message) => ids.push(message.id);
  for (const entry of entries) {
    if (entry.kind === "message") {
      collect(entry.message);
      continue;
    }
    if (entry.kind !== "assistant-turn") continue;
    for (const part of entry.parts) {
      if (part.kind === "message") collect(part.message);
      else for (const item of part.items) collect(item.message);
    }
  }
  return ids;
}

function renderHtml(messages) {
  const { entries } = buildTranscriptEntries(messages);
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        SlotSessionProvider,
        { sessionId: "s1" },
        createElement(TranscriptHistory, { entries, isRunning: true }),
      ),
    ),
  );
}

/** The painted DOM order of the rows under test. */
function domOrder(html, ids) {
  const wanted = new Set(ids);
  return [...html.matchAll(/data-message-id="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id) => wanted.has(id));
}

function seed({ active = "s1", rows = [userRow()], retained = {} } = {}) {
  useAppStore.setState({
    activeSessionId: active,
    sessions: [summary("s1"), summary("s2")],
    messages: rows,
    sessionMeta: {},
    sessionHistory: {
      s1: { scope: { kind: "main" }, messageStart: 0, hasMoreBefore: false },
      s2: { scope: { kind: "main" }, messageStart: 0, hasMoreBefore: false },
    },
    retainedSessionIds: ["s1", "s2"],
    retainedTranscripts: { [active]: rows, ...retained },
    runningSessions: { s1: true, s2: true },
    isRunning: true,
  });
}

const send = (sessionId, ts, event) =>
  useAppStore.getState().handleAgentEvent({ sessionId, ts: START + ts, turnId: "turn-1", event });

const answerRow = (overrides = {}) => ({
  id: "answer",
  role: "assistant",
  content: "",
  createdAt: iso(100),
  status: "streaming",
  ...overrides,
});

/**
 * The provider-level sequence for one assistant round with two parallel calls.
 * `onToolEnd` runs after each `tool_end` and mirrors what the main process does
 * in between: the sidecar re-emits the persisted tool row as a `message_end`.
 */
function runParallelRound(sessionId, { finishFirst = "call-b", sameStartMs = false } = {}) {
  const persistedToolRow = (callId, ts) => ({
    id: callId,
    role: "tool",
    content: callId === "call-b" ? "b" : "a",
    createdAt: iso(150),
    toolName: "Bash",
    toolArgs: { command: callId },
    toolStatus: "success",
    toolResult: callId === "call-b" ? "b" : "a",
    toolCompletedAt: iso(ts),
    status: "complete",
    isError: false,
  });
  send(sessionId, 100, { type: "message_start", message: answerRow() });
  send(sessionId, 110, { type: "tool_prepare", toolCallId: "call-a", toolName: "Bash" });
  send(sessionId, 120, { type: "tool_prepare", toolCallId: "call-b", toolName: "Bash" });
  send(sessionId, 130, { type: "tool_prepare", toolCallId: "call-a", toolName: "Bash", ready: true });
  send(sessionId, 131, { type: "tool_prepare", toolCallId: "call-b", toolName: "Bash", ready: true });
  const afterPrepare = [...useAppStore.getState().messages.map((row) => row.id)];
  // Streaming stop: answers can be announced before the transport boundary.
  send(sessionId, 132, {
    type: "message_end",
    message: answerRow({ content: "Running both.", status: "streaming" }),
  });
  send(sessionId, 140, {
    type: "message_end",
    message: answerRow({ content: "Running both.", status: "complete" }),
  });
  const afterMessageEnd = [...useAppStore.getState().messages.map((row) => row.id)];
  send(sessionId, 150, { type: "tool_start", toolCallId: "call-a", toolName: "Bash", args: { command: "a" } });
  send(sessionId, sameStartMs ? 150 : 160, {
    type: "tool_start", toolCallId: "call-b", toolName: "Bash", args: { command: "b" },
  });
  const afterStart = [...useAppStore.getState().messages.map((row) => row.id)];
  const firstEnd = finishFirst === "call-b" ? { id: "call-b", ts: 200 } : { id: "call-a", ts: 200 };
  const secondEnd = finishFirst === "call-b" ? { id: "call-a", ts: 300 } : { id: "call-b", ts: 300 };
  send(sessionId, firstEnd.ts, {
    type: "tool_end", toolCallId: firstEnd.id, result: firstEnd.id === "call-b" ? "b" : "a", isError: false,
  });
  // The main process persists only on tool_end and replays the row as a
  // message_end so a reloaded renderer can still show it.
  send(sessionId, firstEnd.ts, { type: "message_end", message: persistedToolRow(firstEnd.id, firstEnd.ts) });
  const afterFirstEnd = [...useAppStore.getState().messages.map((row) => row.id)];
  send(sessionId, secondEnd.ts, {
    type: "tool_end", toolCallId: secondEnd.id, result: secondEnd.id === "call-b" ? "b" : "a", isError: false,
  });
  send(sessionId, secondEnd.ts, { type: "message_end", message: persistedToolRow(secondEnd.id, secondEnd.ts) });
  const afterSecondEnd = [...useAppStore.getState().messages.map((row) => row.id)];
  return { afterPrepare, afterMessageEnd, afterStart, afterFirstEnd, afterSecondEnd };
}

const CALL_ROWS = ["call-a", "call-b"];
const expected = ["user-1", "answer", "call-a", "call-b"];

test("the live round keeps announcement order at every stage, A running while B is done", () => {
  seed();
  const stages = runParallelRound("s1");
  for (const [stage, ids] of Object.entries(stages)) {
    assert.deepEqual(ids, expected, `messages after ${stage}`);
  }
  const messages = useAppStore.getState().messages;
  assert.deepEqual(paintedOrder(messages), expected, "painted entry order");
  assert.deepEqual(
    getTranscriptProjection(messages).visible.map((row) => row.id),
    expected,
    "visible row order",
  );
  assert.deepEqual(domOrder(renderHtml(messages), CALL_ROWS), CALL_ROWS, "rendered DOM order");
});

test("the same-millisecond start of both parallel calls keeps announcement order", () => {
  seed();
  const stages = runParallelRound("s1", { sameStartMs: true });
  for (const [stage, ids] of Object.entries(stages)) {
    assert.deepEqual(ids, expected, `messages after ${stage}`);
  }
  assert.deepEqual(domOrder(renderHtml(useAppStore.getState().messages), CALL_ROWS), CALL_ROWS);
});

test("the invariant is symmetric: A finishing first also keeps announcement order", () => {
  seed();
  const stages = runParallelRound("s1", { finishFirst: "call-a" });
  for (const [stage, ids] of Object.entries(stages)) {
    assert.deepEqual(ids, expected, `messages after ${stage}`);
  }
  assert.deepEqual(domOrder(renderHtml(useAppStore.getState().messages), CALL_ROWS), CALL_ROWS);
});

test("a durable page in finish order does not reorder the running transcript", async () => {
  // The host appends a tool row when it finishes, so a durable read taken while
  // A still runs holds user, answer, call-b; after A finishes it holds
  // user, answer, call-b, call-a. Both are finish order, never announcement
  // order.
  let durable = [
    userRow(),
    answerRow({ content: "Running both.", status: "complete" }),
    {
      id: "call-b", role: "tool", content: "b", createdAt: iso(150),
      toolCallId: "call-b", toolName: "Bash", toolStatus: "success",
      toolCompletedAt: iso(200), status: "complete", isError: false,
    },
  ];
  api.getSession = async () => ({
    session: {
      id: "s1",
      messages: durable,
      messageStart: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
      historyScope: { kind: "main" },
    },
  });
  try {
    seed();
    const stages = runParallelRound("s1");
    assert.deepEqual(stages.afterFirstEnd, expected, "live rows before the durable read");
    // A real durable read of the same session, the way a reselect commits it.
    await useAppStore.getState().selectSession("s1", { record: false });
    const afterFirstRead = useAppStore.getState().messages;
    assert.deepEqual(
      afterFirstRead.map((row) => row.id),
      expected,
      "the durable page holds B only, A is still live: A stays above B",
    );
    assert.deepEqual(
      paintedOrder(afterFirstRead).filter((id) => CALL_ROWS.includes(id) || id === "answer"),
      ["answer", "call-a", "call-b"],
      "painted order across the merge",
    );
    assert.deepEqual(domOrder(renderHtml(afterFirstRead), CALL_ROWS), CALL_ROWS);

    // A finishes too: now the durable page holds both in finish order (B, A).
    durable = [
      ...durable,
      {
        id: "call-a", role: "tool", content: "a", createdAt: iso(150),
        toolCallId: "call-a", toolName: "Bash", toolStatus: "success",
        toolCompletedAt: iso(300), status: "complete", isError: false,
      },
    ];
    send("s1", 300, { type: "tool_end", toolCallId: "call-a", result: "a", isError: false });
    await useAppStore.getState().selectSession("s1", { record: false });
    const finalMessages = useAppStore.getState().messages;
    assert.deepEqual(finalMessages.map((row) => row.id), expected, "durable B/A page merged to A/B");
    assert.deepEqual(domOrder(renderHtml(finalMessages), CALL_ROWS), CALL_ROWS, "rendered DOM order");

    /*
      The durable page itself is finish order. It becomes the transcript only
      once the row's live provenance is gone, which in production is a renderer
      reload — out of the reported scenario, recorded here as contrast so the
      two states cannot be confused.
    */
    useAppStore.setState({ runningSessions: { s1: false, s2: true } });
    await useAppStore.getState().selectSession("s1", { record: false });
    await useAppStore.getState().selectSession("s1", { record: false });
    assert.deepEqual(
      useAppStore.getState().messages.map((row) => row.id),
      ["user-1", "answer", "call-b", "call-a"],
      "durable-only read (reload path) is finish order",
    );
  } finally {
    api.getSession = originalGetSession;
  }
});

test("the background transcript cache keeps announcement order", async () => {
  api.getSession = async () => ({
    session: {
      id: "s2",
      messages: [userRow()],
      messageStart: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
      historyScope: { kind: "main" },
    },
  });
  try {
    // s1 stays the visible session: every s2 event goes through the background
    // cache instead of the active transcript. A background session is retained
    // before its events arrive, exactly like an open tab.
    seed({ active: "s1", rows: [userRow()], retained: { s2: [userRow()] } });
    const stages = runParallelRound("s2");
    for (const [stage, ids] of Object.entries(stages)) {
      assert.deepEqual(
        useAppStore.getState().messages.map((row) => row.id),
        ["user-1"],
        `the visible session is untouched by ${stage}`,
      );
    }
    await useAppStore.getState().selectSession("s2", { record: false });
    assert.deepEqual(
      useAppStore.getState().messages.map((row) => row.id),
      expected,
      "cached background rows keep announcement order",
    );
  } finally {
    api.getSession = originalGetSession;
  }
});

test("main-process persistence appends finished tools in finish order", async () => {
  const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
  const { PersistenceOutbox } = await import("../electron/main/persistence-outbox.ts");
  const dir = await mkdtemp(join(tmpdir(), "pi-parallel-order-"));
  const silent = () => undefined;
  try {
    const appends = [];
    const host = {
      isAvailable: () => true,
      call: async (method, params) => {
        if (method === "session.appendMessage") appends.push(params.message.id);
        return {};
      },
    };
    const persistenceOutbox = new PersistenceOutbox(dir, silent);
    const { persistAgentEvent } = createEventPersistence({
      runtimeState: { host },
      steeringReplies: new Set(),
      activeTurns: new Map([["s1", "turn-1"]]),
      activeToolCalls: new Map(),
      activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
      approvedExecutionIdsBySession: new Map(),
      approvedExecutionTurns: new Map(),
      pendingExecutionFinishes: new Map(),
      planSubmissionTurnIds: new Set(),
      planSubmissionTurnKey: (sessionId, turnId) => `${sessionId}:${turnId}`,
      inflightCheckpointer: { observe() {}, flush: async () => {}, settle() {}, settleIf() {} },
      persistenceOutbox,
      addActiveTurnUsage: () => {},
      logger: { app: silent },
      finishTurn: async () => {},
      isStaleTerminalEvent: () => false,
      finishApprovedExecution: async () => {},
      emitAgentEvent: () => {},
    });
    const envelope = (ts, event) => ({ sessionId: "s1", turnId: "turn-1", ts: START + ts, event });
    persistAgentEvent(envelope(150, {
      type: "tool_start", toolCallId: "call-a", toolName: "Bash", args: { command: "a" },
    }));
    persistAgentEvent(envelope(160, {
      type: "tool_start", toolCallId: "call-b", toolName: "Bash", args: { command: "b" },
    }));
    persistAgentEvent(envelope(200, { type: "tool_end", toolCallId: "call-b", result: "b", isError: false }));
    persistAgentEvent(envelope(300, { type: "tool_end", toolCallId: "call-a", result: "a", isError: false }));
    await persistenceOutbox.flush(() => host);
    assert.deepEqual(appends, ["call-b", "call-a"], "the durable transcript is in finish order");
    assert.equal(persistenceOutbox.size(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
