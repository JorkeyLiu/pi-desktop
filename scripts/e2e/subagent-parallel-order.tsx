/**
 * Delegate-tab parallel tools in a real Chromium renderer.
 *
 * The fixture mounts the production `SubagentTranscriptTab` — the right-side
 * tab, not the main transcript — and drives real `AgentEvent`s through the
 * app store while the tab reads its own delegation-scoped history
 * (`ensureSubagentHistory` on mount via `useSubagentHistory`,
 * `loadLatestSubagentHistory` on demand) against a stubbed `api.getSession`
 * that only appends durable child rows on `tool_end`, stamped with the call's
 * START time (host behavior: the durable row keeps `toolStart.createdAt`
 * while the live row keeps its prepare-time `createdAt`).
 *
 * Both delegate children prepare in the SAME millisecond, so their live
 * `createdAt` strings tie. The assertion under test: the painted
 * `data-message-id` order plus each row's `getBoundingClientRect().top` must
 * keep A above B at every sampled frame, in both thinking display modes.
 * Only the transport is stubbed.
 */

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { AgentEvent, AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import {
  findSubagentHistoryEntry,
  subagentHistoryMessages,
} from "../../apps/desktop/src/lib/subagent-history";

declare global {
  var subagentParallelOrderProbe: () => Promise<unknown>;
}

const START = Date.parse("2026-10-13T00:00:00.000Z");
const SESSION = "subagent-parallel-fixture";
const TASK_T1 = "call-t1";
const TASK_T2 = "call-t2";
const TOOL_A = "tool-a";
const TOOL_B = "tool-b";
const PAIR = [TOOL_A, TOOL_B];

const at = (offset: number) => new Date(START + offset).toISOString();
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

type StageSample = {
  stage: string;
  frame: number;
  /** Painted order restricted to the delegate pair. */
  pair: string[];
  /** Pixel tops / heights of the pair rows: physical order, not array order. */
  tops: Record<string, number | null>;
  heights: Record<string, number | null>;
  instances: Record<string, number>;
  phase: Record<string, string | undefined>;
  storePair: string[];
  entryPair: string[];
  mergedPair: string[];
  facts: Record<string, { createdAt?: string; toolStatus?: string; toolCompletedAt?: string }>;
  boxes: number;
};

const pairFacts = (rows: readonly UiMessage[]) => {
  const facts: StageSample["facts"] = {};
  for (const row of rows) {
    if (!PAIR.includes(row.id)) continue;
    facts[row.id] = {
      createdAt: row.createdAt,
      toolStatus: row.toolStatus as string | undefined,
      toolCompletedAt: (row as { toolCompletedAt?: string }).toolCompletedAt,
    };
  }
  return facts;
};

function seedStore(mode: "detailed" | "compact") {
  useAppStore.setState({
    sessions: [{ id: SESSION, source: "local", title: "fixture" } as never],
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
    settings: { enterToSend: true, thinkingDisplayMode: mode } as never,
    providers: [{ id: "p", enabled: true, authKind: "none", models: [{ id: "m" }] }] as never,
  });
}

function installDurableHost() {
  const starts = new Map<string, number>();
  const ended: Array<{ callId: string; ts: number }> = [];
  const tasks = new Set<string>();
  const original = api.getSession;
  api.getSession = (async (id: string, options?: Record<string, unknown>) => {
    const scope = (options?.historyScope ?? {}) as { id?: string };
    const scopeId = scope.id ?? "";
    const chain = [...tasks].filter((callId) => callId === scopeId || `d-${callId}` === scopeId);
    const live = useAppStore.getState().messages;
    const children = ended
      .filter(({ callId }) => {
        const row = live.find((item) => item.id === callId);
        return row?.parentToolCallId && chain.includes(row.parentToolCallId);
      })
      .map(({ callId, ts }) => {
        const row = live.find((item) => item.id === callId) as UiMessage;
        return {
          ...row,
          createdAt: at(starts.get(callId) ?? ts),
          toolCompletedAt: at(ts),
          toolStatus: "success",
          status: "complete",
        };
      });
    if (options?.messageBefore !== undefined) {
      return { session: { id, messages: [], messageStart: 0, hasMoreBefore: false, hasMoreAfter: false, historyScope: scope, historyContext: [] } };
    }
    return {
      session: {
        id,
        messages: children,
        messageStart: 0,
        hasMoreBefore: false,
        hasMoreAfter: false,
        historyScope: scope,
        historyContext: chain.map((callId) => {
          const row = live.find((item) => item.toolCallId === callId) ?? {
            id: `${callId}-row`, role: "tool", toolName: "Task", toolCallId: callId,
          };
          return { ...row, toolResult: { details: { delegationId: `d-${callId}` } } };
        }),
      },
    };
  }) as typeof api.getSession;
  return {
    noteStart(callId: string, ts: number) {
      starts.set(callId, ts);
    },
    noteEnd(callId: string, ts: number) {
      ended.push({ callId, ts });
    },
    noteTask(callId: string) {
      tasks.add(callId);
    },
    restore() {
      api.getSession = original;
    },
  };
}

async function scenario(options: {
  label: string;
  mode: "detailed" | "compact";
  /** Open the tab only after B already ended (first page holds durable B). */
  lateOpen: boolean;
}) {
  const failures: string[] = [];
  const samples: StageSample[] = [];
  const host = installDurableHost();
  seedStore(options.mode);
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });

  const send = (ts: number, event: AgentEvent, extra: Partial<AgentEventEnvelope> = {}) => {
    useAppStore.getState().handleAgentEvent({ sessionId: SESSION, ts: START + ts, turnId: "turn-1", ...extra, event } as AgentEventEnvelope);
  };

  let mount: { host: HTMLDivElement; root: ReturnType<typeof createRoot> } | null = null;
  const mountTab = () => {
    const element = document.createElement("div");
    element.setAttribute("style", "position:absolute;top:0;left:0;right:0;height:720px;display:flex;flex-direction:column;min-height:0");
    document.body.append(element);
    const root = createRoot(element);
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <SlotSessionProvider sessionId={SESSION}>
            <SubagentTranscriptTab delegationId={TASK_T1} />
          </SlotSessionProvider>
        </I18nextProvider>,
      ),
    );
    mount = { host: element, root };
  };

  const sampleStage = async (stage: string) => {
    // Controlled sync points only: every refresh promise settles first, then
    // a bounded run of frames. A transient single-frame inversion is a bug
    // too, so every frame is sampled, not just the settled one.
    for (let index = 0; index < 4; index += 1) {
      await frame();
      const state = useAppStore.getState();
      const entry = findSubagentHistoryEntry(state.subagentHistory, SESSION, TASK_T1);
      const merged = subagentHistoryMessages(entry, state.messages);
      const rows = [...(mount?.host.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])];
      const pair = rows.map((row) => row.getAttribute("data-message-id") ?? "").filter((id) => PAIR.includes(id));
      const tops: Record<string, number | null> = {};
      const heights: Record<string, number | null> = {};
      const instances: Record<string, number> = {};
      for (const id of PAIR) {
        const found = rows.filter((row) => row.getAttribute("data-message-id") === id);
        instances[id] = found.length;
        const box = found[0]?.getBoundingClientRect();
        tops[id] = box ? Math.round(box.top * 100) / 100 : null;
        heights[id] = box ? Math.round(box.height * 100) / 100 : null;
      }
      const phase: Record<string, string | undefined> = {};
      for (const id of PAIR) phase[id] = state.messages.find((row) => row.id === id)?.toolStatus as string | undefined;
      samples.push({
        stage,
        frame: index,
        pair,
        tops,
        heights,
        instances,
        phase,
        storePair: state.messages.filter((row) => PAIR.includes(row.id)).map((row) => row.id),
        entryPair: (entry?.messages ?? []).filter((row) => PAIR.includes(row.id)).map((row) => row.id),
        mergedPair: merged.filter((row) => PAIR.includes(row.id)).map((row) => row.id),
        facts: pairFacts(merged),
        boxes: rows.length,
      });
    }
    const check = samples[samples.length - 1];
    // Late-open scenarios sample stages before the tab is opened: the empty
    // frames stay in the trace as evidence, but there is no painted order to
    // assert until the tab mounts.
    if (!mount) return;
    if (check.pair.join(",") !== PAIR.join(",")) {
      failures.push(`${stage}: painted order is ${check.pair.join(",") || "(empty)"} (expected ${PAIR.join(",")})`);
    }
    if (check.tops[TOOL_A] == null || check.tops[TOOL_B] == null) {
      failures.push(`${stage}: a pair row has no box`);
    } else if ((check.tops[TOOL_A] as number) > (check.tops[TOOL_B] as number)) {
      failures.push(`${stage}: ${TOOL_A} top=${check.tops[TOOL_A]} is below ${TOOL_B} top=${check.tops[TOOL_B]}`);
    }
    for (const id of PAIR) {
      if (check.instances[id] !== 1) failures.push(`${stage}: ${id} painted ${check.instances[id]} times`);
    }
  };

  try {
    send(100, { type: "message_start", message: { id: "answer", role: "assistant", content: "", createdAt: at(100), status: "streaming" } });
    for (const [callId, task, ts] of [[TASK_T1, "Scan configs", 105], [TASK_T2, "Review diffs", 106]] as const) {
      send(ts, { type: "tool_prepare", toolCallId: callId, toolName: "Task" });
      host.noteTask(callId);
    }
    send(107, { type: "tool_start", toolCallId: TASK_T1, toolName: "Task", args: { agent: "explorer", task: "Scan configs" } }, { agentName: "explorer" });
    send(108, { type: "tool_start", toolCallId: TASK_T2, toolName: "Task", args: { agent: "reviewer", task: "Review diffs" } }, { agentName: "reviewer" });
    // Same-millisecond prepare AND start: the live createdAt strings tie, so
    // the delegate's chronological re-sort falls back to array order.
    send(110, { type: "tool_prepare", toolCallId: TOOL_A, toolName: "Read" }, { parentToolCallId: TASK_T1, agentName: "explorer" });
    send(110, { type: "tool_prepare", toolCallId: TOOL_B, toolName: "Bash" }, { parentToolCallId: TASK_T1, agentName: "explorer" });
    send(130, { type: "tool_start", toolCallId: TOOL_A, toolName: "Read", args: { path: "a.ts" } }, { parentToolCallId: TASK_T1, agentName: "explorer" });
    host.noteStart(TOOL_A, 130);
    send(130, { type: "tool_start", toolCallId: TOOL_B, toolName: "Bash", args: { command: "b" } }, { parentToolCallId: TASK_T1, agentName: "explorer" });
    host.noteStart(TOOL_B, 130);
    if (!options.lateOpen) {
      mountTab();
      await useAppStore.getState().ensureSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
    }
    await sampleStage("a-b-running");

    send(200, { type: "tool_end", toolCallId: TOOL_B, result: "b", isError: false });
    host.noteEnd(TOOL_B, 200);
    send(200, {
      type: "message_end",
      message: { id: TOOL_B, role: "tool", content: "b", createdAt: at(130), toolCallId: TOOL_B, toolName: "Bash", toolStatus: "success", toolCompletedAt: at(200), status: "complete", isError: false, parentToolCallId: TASK_T1, agentName: "explorer" },
    });
    if (options.lateOpen) {
      // The user clicks the running card after B already ended: the first
      // page already holds durable B in finish order.
      mountTab();
      await useAppStore.getState().ensureSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
      await sampleStage("initial-with-durable-b");
    } else {
      await useAppStore.getState().loadLatestSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
      await sampleStage("latest-after-b-end");
    }

    send(300, { type: "tool_end", toolCallId: TOOL_A, result: "a", isError: false });
    host.noteEnd(TOOL_A, 300);
    send(300, {
      type: "message_end",
      message: { id: TOOL_A, role: "tool", content: "a", createdAt: at(130), toolCallId: TOOL_A, toolName: "Read", toolStatus: "success", toolCompletedAt: at(300), status: "complete", isError: false, parentToolCallId: TASK_T1, agentName: "explorer" },
    });
    await sampleStage("a-ended");

    await useAppStore.getState().loadLatestSubagentHistory({ sessionId: SESSION, tabKey: TASK_T1 });
    await sampleStage("latest-after-a-end");
  } finally {
    if (mount) {
      flushSync(() => mount?.root.unmount());
      mount.host.remove();
    }
    host.restore();
  }
  assert(samples.length > 0, `${options.label}: no frames sampled`);
  return { label: options.label, failures, samples };
}

async function probe() {
  document.documentElement.dataset.theme = "dark";
  const scenarios = [];
  scenarios.push(await scenario({ label: "early-open-detailed", mode: "detailed", lateOpen: false }));
  scenarios.push(await scenario({ label: "early-open-compact", mode: "compact", lateOpen: false }));
  scenarios.push(await scenario({ label: "late-open-detailed", mode: "detailed", lateOpen: true }));
  scenarios.push(await scenario({ label: "late-open-compact", mode: "compact", lateOpen: true }));
  const failures = scenarios.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`));
  return {
    ok: failures.length === 0,
    failures,
    scenarios: scenarios.map((item) => ({
      label: item.label,
      failureCount: item.failures.length,
      failures: item.failures,
      stages: item.samples.map((sample) => ({
        stage: sample.stage,
        frame: sample.frame,
        pair: sample.pair,
        tops: sample.tops,
        heights: sample.heights,
        instances: sample.instances,
        phase: sample.phase,
        storePair: sample.storePair,
        entryPair: sample.entryPair,
        mergedPair: sample.mergedPair,
        facts: sample.facts,
        boxes: sample.boxes,
      })),
    })),
  };
}

globalThis.subagentParallelOrderProbe = probe;
