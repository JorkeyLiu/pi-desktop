/**
 * A delegate tab's parallel tool rows must keep announcement order while live.
 *
 * The user report: inside one running subagent, tool A renders above tool B
 * (both breathing). B finishes first and jumps above A while A still runs;
 * after A finishes the order restores to A/B. The parent-session live order
 * never moves (upsert-in-place), so the jump — if real — must come from the
 * delegate path: `SubagentTranscriptTab` (right tab, public hooks) reads
 * `useSubagentHistory` -> `subagentHistoryMessages(entry, live)` ->
 * `buildSubagentTranscript` -> real `ToolRow`, and `orderedRows` re-sorts by
 * `createdAt` string on every render while entry merges replace values by id.
 *
 * These tests drive the production entry points only:
 *   - `handleAgentEvent` on the real app store (two Task delegates active in
 *     one session; the target chain runs parallel A/B inside),
 *   - `ensureSubagentHistory` / `loadLatestSubagentHistory` /
 *     `loadOlderSubagentHistory` against a mocked `api.getSession` transport
 *     that only appends durable child rows on `tool_end` (host behavior),
 *   - the real `SubagentTranscriptTab` rendered to HTML under both
 *     `thinkingDisplayMode` values, asserting the painted `data-message-id`
 *     order, never only the array order.
 *
 * No production file is touched. Every stage records the three true row
 * sources (store live rows, entry history rows, merged view rows) with their
 * real `createdAt` / `toolCompletedAt` / `toolStatus` — synthetic ids only,
 * never synthetic wiring. The full per-stage trace prints as
 * SUBAGENT_PARALLEL_TRACE so a RED stage is an executable trace by itself.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const root = fileURLToPath(new URL("..", import.meta.url));
const START = Date.parse("2026-10-13T00:00:00.000Z");
const at = (offset) => new Date(START + offset).toISOString();

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
const {
  findSubagentHistoryEntry,
  subagentHistoryMessages,
} = await vite.ssrLoadModule("/src/lib/subagent-history.ts");
const { SubagentTranscriptTab } = await vite.ssrLoadModule(
  "/src/components/workpanel/SubagentTranscriptTab.tsx",
);
const { SlotSessionProvider } = await vite.ssrLoadModule(
  "/src/plugins/renderer-slots/use-slots.tsx",
);

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: flattenCatalog(catalogs.en) } } });

const SESSION = "subagent-parallel-fixture";
const TASK_T1 = "call-t1";
const TASK_T2 = "call-t2";
const TOOL_A = "tool-a";
const TOOL_B = "tool-b";
const TOOL_N = "tool-n";
const PAIR = [TOOL_A, TOOL_B];

function seed() {
  useAppStore.setState({
    sessions: [{ id: SESSION, source: "local", title: "fixture" }],
    activeSessionId: SESSION,
    messages: [],
    sessionMeta: {},
    sessionHistory: {},
    transcriptViews: {},
    subagentHistory: {},
    retainedSessionIds: [SESSION],
    retainedTranscripts: {},
    sessionCompactions: {},
    planningStates: {},
    pendingPlans: {},
    notifications: [],
    sessionOutcomes: {},
    runningSessions: { [SESSION]: true },
    isRunning: true,
    agentStatuses: {},
    pendingPermissions: {},
    pendingAsks: {},
    settings: { enterToSend: true, thinkingDisplayMode: "detailed" },
    providers: [{ id: "p", enabled: true, authKind: "none", models: [{ id: "m" }] }],
  });
}

const send = (ts, event, envelope = {}) =>
  useAppStore.getState().handleAgentEvent({
    sessionId: SESSION,
    ts: START + ts,
    turnId: "turn-1",
    ...envelope,
    event,
  });

const answerRow = (overrides = {}) => ({
  id: "answer",
  role: "assistant",
  content: "",
  createdAt: at(100),
  status: "streaming",
  ...overrides,
});

const taskArgs = (task) => ({ agent: task === "Scan configs" ? "explorer" : "reviewer", task });

/**
 * Durable host simulator: the host appends a child row only on `tool_end`,
 * stamped with the call's START time (renderer `tool_end` keeps
 * `toolStart.createdAt`; the durable row the main process replays carries the
 * same stamp). The delegation-scoped read answers with the chain's own child
 * rows plus the root Task records as history context.
 */
function createDurableHost() {
  const starts = new Map();
  const ended = [];
  const tasks = new Map();
  const taskRow = (callId) => {
    const live = useAppStore.getState().messages.find((row) => row.toolCallId === callId);
    return {
      ...(live ?? { id: `${callId}-row`, role: "tool", toolName: "Task", toolCallId: callId }),
      toolResult: { details: { delegationId: `d-${callId}`, agent: "explorer", status: "completed" } },
    };
  };
  return {
    noteStart(callId, ts) {
      starts.set(callId, ts);
    },
    noteEnd(callId, ts) {
      ended.push({ callId, ts });
    },
    noteTask(callId) {
      tasks.set(callId, true);
    },
    async getSession(id, options) {
      const scope = options?.historyScope;
      const scopeId = scope?.id ?? "";
      const chainCallIds = new Set(
        [...tasks.keys()].filter(
          (callId) => callId === scopeId || `d-${callId}` === scopeId,
        ),
      );
      const children = ended
        .filter(({ callId }) => {
          const live = useAppStore.getState().messages.find((row) => row.id === callId);
          return live?.parentToolCallId && chainCallIds.has(live.parentToolCallId);
        })
        .map(({ callId, ts }) => {
          const live = useAppStore.getState().messages.find((row) => row.id === callId);
          return {
            ...live,
            createdAt: at(starts.get(callId) ?? ts),
            toolCompletedAt: at(ts),
            toolStatus: "success",
            status: "complete",
          };
        });
      if (options?.messageBefore !== undefined) {
        return {
          session: {
            id,
            messages: [],
            messageStart: 0,
            hasMoreBefore: false,
            hasMoreAfter: false,
            historyScope: scope,
            historyContext: [],
          },
        };
      }
      return {
        session: {
          id,
          messages: children,
          messageStart: 0,
          hasMoreBefore: false,
          hasMoreAfter: false,
          historyScope: scope,
          historyContext: [...chainCallIds].map(taskRow),
        },
      };
    },
  };
}

/**
 * Zustand v5 serves hook selectors from the initial-state snapshot under SSR,
 * while `handleAgentEvent` mutates the live store. The painted DOM therefore
 * needs the live state synced into the SSR snapshot before every render —
 * the same pattern `subagent-tab-scoped-history.test.mjs` uses. Array/merge
 * assertions keep reading the live store directly.
 */
function syncSSR() {
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
}

function renderHtml() {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        SlotSessionProvider,
        { sessionId: SESSION },
        createElement(SubagentTranscriptTab, { delegationId: TASK_T1 }),
      ),
    ),
  );
}

function domOrder(html) {
  return [...html.matchAll(/data-message-id="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id) => PAIR.includes(id));
}

function rowFacts(rows) {
  const facts = {};
  for (const row of rows) {
    if (!PAIR.includes(row.id)) continue;
    facts[row.id] = {
      createdAt: row.createdAt,
      toolStatus: row.toolStatus,
      toolCompletedAt: row.toolCompletedAt,
      argsComplete: row.toolArgsComplete,
      hasPreparedAt: "preparedAt" in row,
      hasStartedAt: "startedAt" in row,
    };
  }
  return facts;
}

/**
 * One lifecycle pass. `timing` skews the realistic prepare/start stamps and
 * selects the early tab open (initial page is empty) versus the late tab open
 * (the user clicks the running card after B already ended, so the first page
 * already holds durable B); `withOlder` appends an older-page (`before`)
 * stage at the end.
 */
async function runScenario(label, { timing = {}, withOlder = false } = {}) {
  const host = createDurableHost();
  const original = api.getSession;
  api.getSession = (...args) => host.getSession(...args);
  const trace = [];
  try {
    seed();
    const prepA = timing.prepA ?? 110;
    const prepB = timing.prepB ?? 120;
    const startA = timing.startA ?? 130;
    const startB = timing.startB ?? 140;
    const endB = timing.endB ?? 200;
    const endA = timing.endA ?? 300;
    const lateOpen = timing.lateOpen === true;

    const snapshot = async (stage, extra = {}) => {
      const state = useAppStore.getState();
      const entry = findSubagentHistoryEntry(state.subagentHistory, SESSION, TASK_T1);
      const live = state.messages;
      const merged = subagentHistoryMessages(entry, live);
      const livePair = live.filter((row) => PAIR.includes(row.id)).map((row) => row.id);
      const entryPair = (entry?.messages ?? []).filter((row) => PAIR.includes(row.id)).map((row) => row.id);
      const mergedPair = merged.filter((row) => PAIR.includes(row.id)).map((row) => row.id);
      const expected = extra.expectPair ?? PAIR;
      syncSSR();
      const detailed = domOrder(renderHtml());
      useAppStore.setState((current) => ({
        settings: { ...current.settings, thinkingDisplayMode: "compact" },
      }));
      syncSSR();
      const compact = domOrder(renderHtml());
      useAppStore.setState((current) => ({
        settings: { ...current.settings, thinkingDisplayMode: "detailed" },
      }));
      trace.push({
        stage,
        livePair,
        entryPair,
        mergedPair,
        domDetailed: detailed,
        domCompact: compact,
        liveFacts: rowFacts(live),
        entryFacts: rowFacts(entry?.messages ?? []),
        mergedFacts: rowFacts(merged),
        entryStatus: entry?.status ?? null,
        canonicalId: entry?.canonicalId ?? null,
        ...extra,
      });
      console.log(`SUBAGENT_PARALLEL_STAGE ${label} [${stage}] ` + JSON.stringify(trace.at(-1)));
      assert.deepEqual(livePair, expected, `${label} [${stage}]: parent live store keeps A/B`);
      assert.deepEqual(mergedPair, expected, `${label} [${stage}]: delegate merged rows keep A/B`);
      assert.deepEqual(detailed, expected, `${label} [${stage}]: painted DOM (detailed) keeps A/B`);
      assert.deepEqual(compact, expected, `${label} [${stage}]: painted DOM (compact) keeps A/B`);
    };

    send(100, { type: "message_start", message: answerRow() });
    for (const [callId, task, ts] of [[TASK_T1, "Scan configs", 105], [TASK_T2, "Review diffs", 106]]) {
      send(ts, { type: "tool_prepare", toolCallId: callId, toolName: "Task" });
      host.noteTask(callId);
    }
    send(107, { type: "tool_start", toolCallId: TASK_T1, toolName: "Task", args: taskArgs("Scan configs") }, { agentName: "explorer" });
    send(108, { type: "tool_start", toolCallId: TASK_T2, toolName: "Task", args: taskArgs("Review diffs") }, { agentName: "reviewer" });
    await snapshot("tasks-running", { expectPair: [] });

    send(prepA, { type: "tool_prepare", toolCallId: TOOL_A, toolName: "Read" }, { parentToolCallId: TASK_T1, agentName: "explorer" });
    if (timing.skipPrepareB !== true) {
      send(prepB, { type: "tool_prepare", toolCallId: TOOL_B, toolName: "Bash" }, { parentToolCallId: TASK_T1, agentName: "explorer" });
    }
    send(125, { type: "tool_prepare", toolCallId: TOOL_N, toolName: "Read" }, { parentToolCallId: TASK_T2, agentName: "reviewer" });
    send(startA, { type: "tool_start", toolCallId: TOOL_A, toolName: "Read", args: { path: "a.ts" } }, { parentToolCallId: TASK_T1, agentName: "explorer" });
    host.noteStart(TOOL_A, startA);
    send(startB, { type: "tool_start", toolCallId: TOOL_B, toolName: "Bash", args: { command: "b" } }, { parentToolCallId: TASK_T1, agentName: "explorer" });
    host.noteStart(TOOL_B, startB);
    send(145, { type: "tool_start", toolCallId: TOOL_N, toolName: "Read", args: { path: "n.ts" } }, { parentToolCallId: TASK_T2, agentName: "reviewer" });
    await snapshot("a-b-running");

    if (!lateOpen) {
      await useAppStore.getState().ensureSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
      await snapshot("initial-empty-page");
    }

    send(endB, { type: "tool_end", toolCallId: TOOL_B, result: "b", isError: false });
    host.noteEnd(TOOL_B, endB);
    send(endB, {
      type: "message_end",
      message: {
        id: TOOL_B, role: "tool", content: "b", createdAt: at(startB),
        toolCallId: TOOL_B, toolName: "Bash", toolStatus: "success",
        toolCompletedAt: at(endB), status: "complete", isError: false,
        parentToolCallId: TASK_T1, agentName: "explorer",
      },
    });
    await snapshot("b-ended-a-running");

    if (lateOpen) {
      await useAppStore.getState().ensureSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
      await snapshot("initial-with-durable-b");
    } else {
      await useAppStore.getState().loadLatestSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
      await snapshot("latest-after-b-end");
    }

    send(endA, { type: "tool_end", toolCallId: TOOL_A, result: "a", isError: false });
    host.noteEnd(TOOL_A, endA);
    send(endA, {
      type: "message_end",
      message: {
        id: TOOL_A, role: "tool", content: "a", createdAt: at(startA),
        toolCallId: TOOL_A, toolName: "Read", toolStatus: "success",
        toolCompletedAt: at(endA), status: "complete", isError: false,
        parentToolCallId: TASK_T1, agentName: "explorer",
      },
    });
    await snapshot("a-ended");

    await useAppStore.getState().loadLatestSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
    await snapshot("latest-after-a-end");

    if (withOlder) {
      await useAppStore.getState().loadOlderSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
      await snapshot("older-page");
    }
  } finally {
    api.getSession = original;
  }
  console.log(`SUBAGENT_PARALLEL_TRACE ${label} ` + JSON.stringify(trace));
}

test("delegate tab keeps A/B order through B-ends-first with distinct stamps", async () => {
  await runScenario("distinct-stamps", { withOlder: true });
});

test("delegate tab keeps A/B order when A/B prepare and start in the same ms", async () => {
  await runScenario("same-ms", {
    timing: { prepA: 110, prepB: 110, startA: 130, startB: 130 },
  });
});

test("delegate tab keeps A/B order when B starts without a prepare frame", async () => {
  await runScenario("b-without-prepare", { timing: { skipPrepareB: true } });
});

test("delegate tab keeps A/B order when opened after B already ended", async () => {
  await runScenario("late-open-distinct", { timing: { lateOpen: true } });
});

test("delegate tab keeps A/B order when opened late with same-ms stamps", async () => {
  await runScenario("late-open-same-ms", {
    timing: { lateOpen: true, prepA: 110, prepB: 110, startA: 130, startB: 130 },
  });
});
