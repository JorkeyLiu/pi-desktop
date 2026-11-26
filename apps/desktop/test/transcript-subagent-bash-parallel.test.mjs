/**
 * One delegate's parallel Bash A/B must keep announcement order while live.
 *
 * The user report: inside ONE running subagent, concurrent Bash A (up) and B
 * (down) both breathe; B ends first and jumps above the still-running A; when
 * A ends the order restores to A/B. The earlier generic-Read fixture never
 * reproduced it, so this test drives the production producer: a real
 * `SubagentRun` consumes legal pi boundary events (toolcall start/end
 * frames, `tool_execution_start` / `tool_execution_update` /
 * `tool_execution_end`, B announced later but ending first with streaming
 * stdout partials on both) and emits real producer-to-parent envelopes —
 * `tool_prepare`, `tool_start`, `tool_update`, `tool_end` — each attributed
 * with `parentToolCallId`, `agentName`, `turnId`, `ts`. Every envelope feeds
 * the real store untouched via `handleAgentEvent`; no state is hand-placed.
 *
 * Stages assert the painted `data-message-id` order (both thinking modes)
 * plus the three true row sources (store live rows, entry history rows,
 * merged view rows) with real `createdAt` / `toolCompletedAt` / `toolStatus`
 * and the producer's own envelope timestamps. The full per-stage trace
 * prints as SUBAGENT_BASH_STAGE so a RED stage is an executable trace.
 *
 * No production file is touched. Time is a manual counter inside the
 * producer (no sleep, no provider, no subprocess); `sameMs` collapses every
 * stamp into one millisecond, the chronological re-sort's worst case.
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
const at = (ms) => new Date(ms).toISOString();

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
const { produceParallelBashEnvelopes } = await vite.ssrLoadModule(
  "/test/fixtures/subagent-bash-producer.ts",
);

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: flattenCatalog(catalogs.en) } } });

const SESSION = "bash-parallel-fixture";
const OTHER = "bash-parallel-other";
const TASK_T1 = "call-task";
const TASK_T2 = "call-noise";
 const CALL_A = "bash-a";
 const CALL_B = "bash-b";
 const PAIR = [CALL_A, CALL_B];

 function seed() {
   useAppStore.setState({
     sessions: [
       { id: SESSION, source: "local", title: "fixture", providerId: "p", modelId: "m" },
       { id: OTHER, source: "local", title: "other", providerId: "p", modelId: "m" },
     ],
    activeSessionId: SESSION,
    messages: [],
    sessionMeta: {},
    sessionHistory: {},
    transcriptViews: {},
    subagentHistory: {},
    retainedSessionIds: [SESSION, OTHER],
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

/**
 * Durable host simulator: appends a child row only on `tool_end`, stamped
 * with the call's START envelope ts (renderer `tool_end` keeps the start
 * stamp; the replayed durable row carries the same). The delegation-scoped
 * read answers with the chain's child rows plus root Task records as
 * history context.
 */
function createDurableHost() {
  const starts = new Map();
  const ended = [];
  const tasks = new Map();
  // The last shape each running child row was published with while this
  // simulator could still see it. A durable store is written from the row at
  // the time the call ended, and never rewritten by what happens to the parent
  // transcript afterwards — so a parked tab or a replaced live tail cannot
  // change what the durable page answers.
  const shapes = new Map();
  const remember = () => {
    for (const row of useAppStore.getState().messages) {
      if (row.parentToolCallId) shapes.set(row.id, { ...row });
    }
  };
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
    starts,
    ended,
    remember,
    async getSession(id, options) {
      const scope = options?.historyScope;
      const scopeId = scope?.id ?? "";
      const chainCallIds = new Set(
        [...tasks.keys()].filter((callId) => callId === scopeId || `d-${callId}` === scopeId),
      );
      // A durable page is in physical order, which is the order the calls
      // started, not the order they finished: B ends first here and still
      // sits after A in the chain's history.
      const children = ended
        .filter(({ callId }) => {
          const shape = shapes.get(callId);
          return shape?.parentToolCallId && chainCallIds.has(shape.parentToolCallId);
        })
        .sort((left, right) => {
          const leftStart = starts.get(left.callId) ?? left.ts;
          const rightStart = starts.get(right.callId) ?? right.ts;
          return leftStart - rightStart;
        })
        .map(({ callId, ts }) => ({
          ...shapes.get(callId),
          id: callId,
          createdAt: at(starts.get(callId) ?? ts),
          toolCompletedAt: at(ts),
          toolStatus: "success",
          status: "complete",
        }));
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
       if (!scope || scope.kind === "main") {
         // Main-scope reads never carry delegate rows. A parked session keeps
         // one benign row so reselect takes the normal detail path instead of
         // the empty-transcript toast path (a browser-surface side effect the
         // node harness cannot host).
         const hello =
           id === OTHER
             ? [{ id: "hello", role: "assistant", content: "hi", createdAt: at(START + 50), status: "complete" }]
             : [];
         return {
           session: {
             id,
             messages: hello,
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
 * Zustand v5 serves hook selectors from the initial-state snapshot under
 * SSR while `handleAgentEvent` mutates the live store: sync the live state
 * into the SSR snapshot before every render.
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
 * One Bash lifecycle pass. The producer emits the whole delegate run; the
 * harness feeds envelopes in order and snapshots at the controlled stage
 * boundaries (both started/streaming, B ended, A ended). `lateOpen` opens
 * the tab after B already ended so the first page holds durable B;
 * `background` parks the parent on another session while B ends, then
 * reselects through the real `selectSession` background-cache path.
 */
async function runBashScenario(label, { sameMs = false, lateOpen = false, background = false } = {}) {
  const host = createDurableHost();
  const original = api.getSession;
  api.getSession = (...args) => host.getSession(...args);
  const trace = [];
  try {
    seed();
    const produced = produceParallelBashEnvelopes({
      sessionId: SESSION,
      turnId: "turn-1",
      parentToolCallId: TASK_T1,
      agentName: "explorer",
      sameMs,
      callA: CALL_A,
      callB: CALL_B,
    });
    const envelopes = produced.envelopes;
    const indexOf = (type, callId) =>
      envelopes.findIndex((e) => e.event.type === type && e.event.toolCallId === callId);
    const endB = indexOf("tool_end", CALL_B);
    const endA = indexOf("tool_end", CALL_A);
    assert.ok(endB > 0 && endA > endB, `${label}: producer ends B (${endB}) before A (${endA})`);
     // First streaming partial after both Bash calls started: the tab opens
     // while both run, then real streaming traffic flows before parking.
     const startB = indexOf("tool_start", CALL_B);
     const streamB = envelopes.findIndex(
       (e, i) => i > startB && (e.event.type === "tool_update" || e.event.type === "message_update"),
     );
     assert.ok(streamB > startB, `${label}: producer streams after both starts`);
     let fed = 0;
     const feedThrough = (index) => {
       while (fed <= index) {
         const envelope = envelopes[fed++];
         if (envelope.event.type === "tool_start") host.noteStart(envelope.event.toolCallId, envelope.ts);
         if (envelope.event.type === "tool_end") host.noteEnd(envelope.event.toolCallId, envelope.ts);
        useAppStore.getState().handleAgentEvent(envelope);
        // A durable store keeps the shape a child row was last published with
        // while it was still visible; the parent transcript dropping that row
        // later does not rewrite history.
        host.remember();
       }
     };
     const snapshot = async (stage, extra = {}) => {
       const state = useAppStore.getState();
      const entry = findSubagentHistoryEntry(state.subagentHistory, SESSION, TASK_T1);
      const live = state.messages;
      const merged = subagentHistoryMessages(entry, live);
      const livePair = live.filter((row) => PAIR.includes(row.id)).map((row) => row.id);
      const entryPair = (entry?.messages ?? []).filter((row) => PAIR.includes(row.id)).map((row) => row.id);
      const mergedPair = merged.filter((row) => PAIR.includes(row.id)).map((row) => row.id);
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
         producerStarts: produced.starts,
         producerEnds: produced.ends,
         liveFacts: rowFacts(live),
         entryFacts: rowFacts(entry?.messages ?? []),
         mergedFacts: rowFacts(merged),
         entryStatus: entry?.status ?? null,
         ...extra,
       });
       console.log(`SUBAGENT_BASH_STAGE ${label} [${stage}] ` + JSON.stringify(trace.at(-1)));
       const expectLive = extra.expectLive ?? PAIR;
       const expectMerged = extra.expectMerged ?? PAIR;
       const expectDom = extra.expectDom ?? PAIR;
       assert.deepEqual(livePair, expectLive, `${label} [${stage}]: parent live store keeps ${JSON.stringify(expectLive)}`);
       if (extra.expectEntry !== undefined) {
         assert.deepEqual(entryPair, extra.expectEntry, `${label} [${stage}]: delegate entry keeps ${JSON.stringify(extra.expectEntry)}`);
       }
       assert.deepEqual(mergedPair, expectMerged, `${label} [${stage}]: delegate merged rows keep ${JSON.stringify(expectMerged)}`);
       assert.deepEqual(detailed, expectDom, `${label} [${stage}]: painted DOM (detailed) keeps ${JSON.stringify(expectDom)}`);
       assert.deepEqual(compact, expectDom, `${label} [${stage}]: painted DOM (compact) keeps ${JSON.stringify(expectDom)}`);
    };

     send(100, { type: "message_start", message: { id: "answer", role: "assistant", content: "", createdAt: at(START + 100), status: "streaming" } });
     for (const [callId, task, ts, agent] of [[TASK_T1, "run parallel bash", 105, "explorer"], [TASK_T2, "noise", 106, "reviewer"]]) {
       send(ts, { type: "tool_prepare", toolCallId: callId, toolName: "Task" });
      host.noteTask(callId);
    }
    send(107, { type: "tool_start", toolCallId: TASK_T1, toolName: "Task", args: { agent: "explorer", task: "run parallel bash" } }, { agentName: "explorer" });
    send(108, { type: "tool_start", toolCallId: TASK_T2, toolName: "Task", args: { agent: "reviewer", task: "noise" } }, { agentName: "reviewer" });

     feedThrough(background ? streamB : endB - 1);
     await snapshot("a-b-running");

     if (!lateOpen && !background) {
       await useAppStore.getState().ensureSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
       await snapshot("initial-empty-page");
     }

     if (background) {
       await useAppStore.getState().ensureSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
       await snapshot("tab-opened", { expectEntry: [] });
       // Real streaming traffic flows while the tab is open. A synchronous
       // publication has to follow the tab open before the entry can ingest:
       // the noise delegate prepares a tool, which flushes the frame batcher
       // (applying the queued Bash partials) and publishes, so the boundary
       // routes the running A/B copies into the entry while still active.
       // The noise row never matches PAIR, so every assertion still reads
       // only the target delegate's rows.
       feedThrough(endB - 1);
       send(126, { type: "tool_prepare", toolCallId: "noise-read", toolName: "Read" }, { parentToolCallId: TASK_T2, agentName: "reviewer" });
       await snapshot("a-b-streaming", { expectEntry: PAIR });
       await useAppStore.getState().selectSession(OTHER, { rememberSelection: false, record: false });
       // The right tab follows the ACTIVE session (it reads
       // `useSubagentHistory(activeSessionId, …)`), so while parked it shows
       // nothing for SESSION's chain — correct production behavior, not a
       // loss: the entry still holds both running rows in announcement order.
       await snapshot("parked-on-other", { expectLive: [], expectEntry: PAIR, expectDom: [] });
       feedThrough(endB);
       await useAppStore.getState().selectSession(SESSION, { rememberSelection: false, record: false });
       // Reselect commits the main-scope detail, which drops delegate rows by
       // design (they belong to delegate pages). The entry still holds the
       // running A/B copies ingested while active, so the tab shows both in
       // announcement order; B's durable row arrives with the next refresh.
       await snapshot("b-ended-a-running-background", { expectLive: [], expectEntry: PAIR });
       await useAppStore.getState().loadLatestSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
       await snapshot("latest-after-b-end-background", { expectLive: [] });
     } else {
       feedThrough(endB);
       await snapshot("b-ended-a-running");
       if (lateOpen) {
         await useAppStore.getState().ensureSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
         await snapshot("initial-with-durable-b");
       } else {
         await useAppStore.getState().loadLatestSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
         await snapshot("latest-after-b-end");
       }
     }

     feedThrough(envelopes.length - 1);
     // Backgrounded B-end never re-enters the main live tail: the reselect
     // commits the main-scope detail, which drops delegate rows by design.
     // The delegate tab still shows both rows in announcement order.
     await snapshot("a-ended", background ? { expectLive: [CALL_A] } : {});
     await useAppStore.getState().loadLatestSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
     await snapshot("latest-after-a-end", background ? { expectLive: [CALL_A] } : {});
  } finally {
    api.getSession = original;
  }
  console.log(`SUBAGENT_BASH_TRACE ${label} ` + JSON.stringify(trace));
}

test("bash delegate keeps A/B order through B-ends-first with distinct stamps", async () => {
  await runBashScenario("bash-early-distinct", {});
});

test("bash delegate keeps A/B order through B-ends-first in the same ms", async () => {
  await runBashScenario("bash-early-samems", { sameMs: true });
});

test("bash delegate keeps A/B order when opened after B already ended", async () => {
  await runBashScenario("bash-late-distinct", { lateOpen: true });
});

test("bash delegate keeps A/B order when opened late with same-ms stamps", async () => {
  await runBashScenario("bash-late-samems", { lateOpen: true, sameMs: true });
});

test("bash delegate keeps A/B order when the parent is backgrounded at B-end", async () => {
  await runBashScenario("bash-background", { background: true });
});
