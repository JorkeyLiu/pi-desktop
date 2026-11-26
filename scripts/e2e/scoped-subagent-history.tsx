import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, type SessionDetail, type UiMessage } from "@pi-desktop/shared";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import {
  SUBAGENT_HISTORY_CONTENT_LIMIT,
  SUBAGENT_HISTORY_PAGE_SIZE,
} from "../../apps/desktop/src/lib/subagent-history";

import {
  SUBAGENT_HYDRATION_FIRST_ROWS,
  SUBAGENT_HYDRATION_STEP_ROWS,
} from "../../apps/desktop/src/lib/subagent-hydration";
import { TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS } from "../../apps/desktop/src/lib/transcript-scroll";
declare global {
  var scopedHistoryProbe: () => Promise<{
    ok: boolean;
    failures: string[];
    facts: Record<string, unknown>;
  }>;
}

/*
 * The delegate panel's independent history source, mounted the way the work
 * panel mounts it (`.work-panel-body` > `.work-panel-tabpane`) in a real
 * Chromium renderer with the application's own built stylesheet.
 *
 * The fixture stubs only the preload bridge. It answers `session.get` the way a
 * scoped backend does — a delegation-scoped page of child rows plus the root
 * `Task` records that identify the chain — and records every request, so the
 * probe can prove which scope was asked for and how many reads the panel spent.
 *
 * The claim under test is availability and identity, not visual flicker: with a
 * main window that holds thousands of child rows behind it, opening the panel
 * costs exactly one bounded scoped read; replacing, reducing, restoring, and
 * then switching away from the main conversation leaves the panel's page,
 * identity, and status exactly as they were; older paging, live rows, and a
 * close/reopen reuse that page instead of rebuilding it from the parent.
 */

const SESSION = "s1";
const OTHER_SESSION = "s2";
const DELEGATION = "d1";
const CALL = "call-task";
const createdAt = "2026-10-18T00:00:00.000Z";
/** The chain's tail page: a full page, so opening the panel spends one read. */
const FIRST_PAGE_START = 30;
const FIRST_PAGE = Array.from(
  { length: SUBAGENT_HISTORY_PAGE_SIZE },
  (_, offset) => `child-${FIRST_PAGE_START + offset}`,
);
/** The chain's head page, the selection immediately before that tail window. */
const OLDER_PAGE_START = 20;
const OLDER_PAGE = Array.from({ length: 10 }, (_, offset) => `child-${OLDER_PAGE_START + offset}`);
const LIVE_ROW = "live-41";
// A long chain whose physical selection is contiguous, so a full reading
// window can be filled with ordinary `SUBAGENT_HISTORY_PAGE_SIZE`-row pages.
// It is seven pages long: the tail page plus six older reads reach its head.
const DEEP_DELEGATION = "d-deep";
const DEEP_CALL = "call-deep";
const DEEP_TOTAL = 7 * SUBAGENT_HISTORY_PAGE_SIZE;
const DEEP_TAIL_START = DEEP_TOTAL - SUBAGENT_HISTORY_PAGE_SIZE;
const DEEP_OLDEST_START = DEEP_TOTAL - 6 * SUBAGENT_HISTORY_PAGE_SIZE;
// The focused page a search on a row older than the retained window reads. The
// row must sit outside the six-page interval the older reads below accumulate,
// so the focus costs its own read instead of reusing the window it holds.
const DEEP_FOCUS_TARGET = DEEP_OLDEST_START - (SUBAGENT_HISTORY_PAGE_SIZE / 2 - 1);
const deepFocusStart = DEEP_FOCUS_TARGET + 1 - SUBAGENT_HISTORY_PAGE_SIZE / 2;
const deepFocusEnd = deepFocusStart + SUBAGENT_HISTORY_PAGE_SIZE;
const deepRowId = (index: number) => `child-deep-${index}`;
const ANCHOR_DELEGATION = "d-anchor";
const ANCHOR_CALL = "call-anchor";
const ANCHOR_TASK_ID = "anchor-task-row";
const ANCHOR_HANDOFF_ID = "anchor-handoff";
const ANCHOR_CHECKPOINT_ROW = 23;
const ANCHOR_TOTAL = 50;
const anchorRowId = (index: number) => `child-anchor-${index}`;
// A chain the parent opened from a `Task` card while its durable row is still
// in the persistence outbox: the scoped read cannot resolve it yet.
const FRESH_DELEGATION = "d-fresh";
const FRESH_CALL = "call-fresh";
const FRESH_PAGE = ["child-50", "child-51"];
const FRESH_LIVE = "live-52";
let freshDurable = false;
/**
 * A gate that holds one older read open, so the probe can press the jump
 * control while a boundary read is still in flight.
 */
let heldOlderRead: { promise: Promise<void>; resolve: () => void; scopeId: string } | null = null;
function holdOlderReads(scopeId: string) {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  heldOlderRead = { promise, resolve, scopeId };
}
function releaseOlderReads() {
  const held = heldOlderRead;
  heldOlderRead = null;
  held?.resolve();
}

type ReadRecord = {
  id: string;
  scope: { kind?: unknown; id?: unknown } | undefined;
  messageBefore: number | undefined;
  messageAround: string | undefined;
  messageLimit: number | undefined;
  contentLimit: number | undefined;
};

const reads: ReadRecord[] = [];
const channels: string[] = [];

function message(
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role, content, createdAt, status: "complete", ...extra };
}

function taskRecord(): UiMessage {
  return message("task-row", "tool", "", {
    toolName: "Task",
    toolCallId: CALL,
    toolStatus: "success",
    toolArgs: {
      agent: "explorer",
      description: "Trace the cache",
      task: "Trace why the session cache misses after a restart.",
    },
    toolResult: {
      details: {
        delegationId: DELEGATION,
        agent: "explorer",
        status: "completed",
        startedAt: 1_000,
        completedAt: 42_000,
        modelId: "test-model",
        thinkingLevel: "high",
        toolCalls: 2,
        turns: 1,
        contextTokens: 1234,
      },
    },
  });
}

function childRow(id: string, content: string, extra: Partial<UiMessage> = {}): UiMessage {
  return message(id, "assistant", content, {
    parentToolCallId: CALL,
    agentName: "explorer",
    ...extra,
  });
}

/** The running/settled `Task` card of the chain whose durable row is queued. */
function freshTaskRecord(settled: boolean): UiMessage {
  return message("fresh-task-row", "tool", "", {
    toolName: "Task",
    toolCallId: FRESH_CALL,
    toolStatus: settled ? "success" : "running",
    status: settled ? "complete" : "streaming",
    toolArgs: {
      agent: "explorer",
      description: "Fresh chain",
      task: "Explain the fresh chain.",
    },
    toolResult: {
      details: {
        delegationId: FRESH_DELEGATION,
        agent: "explorer",
        status: settled ? "completed" : "running",
        startedAt: 1_000,
        ...(settled ? { completedAt: 42_000 } : {}),
      },
    },
  });
}

function freshChildRow(id: string): UiMessage {
  return message(id, "assistant", `fresh chain row ${id}`, {
    parentToolCallId: FRESH_CALL,
    agentName: "explorer",
  });
}

/** The long chain's root `Task` card, which identifies its scope. */
function deepTaskRecord(): UiMessage {
  return message("deep-task-row", "tool", "", {
    toolName: "Task",
    toolCallId: DEEP_CALL,
    toolStatus: "success",
    toolArgs: {
      agent: "explorer",
      description: "Long chain",
      task: Array.from({ length: 48 }, (_, line) => `Long-chain instruction ${line + 1}: preserve the reader's place while older pages arrive.`).join("\n"),
    },
    toolResult: { details: { delegationId: DEEP_DELEGATION, agent: "explorer", status: "completed" } },
  });
}

function deepChildRow(index: number): UiMessage {
  return message(deepRowId(index), "assistant", `deep chain row ${index}`, {
    parentToolCallId: DEEP_CALL,
    agentName: "explorer",
  });
}

function anchorTaskRecord(): UiMessage {
  return message(ANCHOR_TASK_ID, "tool", "", {
    toolName: "Task",
    toolCallId: ANCHOR_CALL,
    toolStatus: "success",
    toolArgs: { agent: "explorer", task: "Keep the checkpoint anchored while older pages arrive." },
    toolResult: { details: { delegationId: ANCHOR_DELEGATION, agent: "explorer", status: "completed" } },
  });
}

function anchorChildRow(index: number): UiMessage {
  return message(anchorRowId(index), "assistant", `anchor chain row ${index}`, {
    parentToolCallId: ANCHOR_CALL,
    agentName: "explorer",
  });
}

function anchorHandoffRow(): UiMessage {
  return message(ANCHOR_HANDOFF_ID, "tool", "", {
    parentToolCallId: ANCHOR_CALL,
    agentName: "explorer",
    toolName: "SubagentHandoff",
    toolCallId: "anchor-handoff-call",
    toolStatus: "success",
    toolArgs: { handoff: "Keep this checkpoint visible.\n\n- Preserve the reader's offset.\n- Continue from the older page." },
    toolResult: { details: { accepted: true } },
  });
}

function anchorDetail(sessionId: string, messageBefore: number | undefined): SessionDetail {
  const end = messageBefore ?? ANCHOR_TOTAL;
  const start = messageBefore === undefined ? 30 : Math.max(0, end - 10);
  const rows = Array.from({ length: end - start }, (_, offset) => anchorChildRow(start + offset));
  const checkpointAt = rows.findIndex((row) => row.id === anchorRowId(ANCHOR_CHECKPOINT_ROW));
  if (checkpointAt >= 0) rows.splice(checkpointAt, 1, anchorHandoffRow());
  return {
    id: sessionId,
    title: "Anchor fixture",
    source: "local",
    mode: "agent",
    createdAt,
    updatedAt: createdAt,
    historyScope: { kind: "delegation", id: ANCHOR_DELEGATION },
    messages: rows,
    // The fixture numbers the chain's children from 0, so the run's opening is
    // stated at that first child; the prompt is drawn only when the retained
    // window reaches it.
    historyRuns: [
      { callId: ANCHOR_CALL, taskMessageId: ANCHOR_TASK_ID, taskIndex: 0, firstChildIndex: 0 },
    ],
    historyContext: [anchorTaskRecord()],
    messageStart: start,
    messageEnd: end,
    messageCount: ANCHOR_TOTAL,
    hasMoreBefore: start > 0,
    hasMoreAfter: false,
  } as unknown as SessionDetail;
}


/**
 * One page of the long chain: `messageBefore` is the physical exclusive cursor
 * of a contiguous selection, exactly how the host pages a scoped range. A
 * `messageAround` request answers the full focused page centred on that row,
 * which is what a search focus reads.
 */
function deepDetail(
  sessionId: string,
  messageBefore: number | undefined,
  messageAround?: string,
): SessionDetail {
  let start: number;
  let end: number;
  if (messageAround?.startsWith("child-deep-")) {
    const around = Number(messageAround.slice("child-deep-".length));
    // The host centres a focused page by ending half a page past the target's
    // own selected position, so the answer is a full contiguous page.
    const atOrBefore = Math.min(DEEP_TOTAL, around + 1);
    end = Math.min(DEEP_TOTAL, atOrBefore + SUBAGENT_HISTORY_PAGE_SIZE / 2);
    start = Math.max(0, end - SUBAGENT_HISTORY_PAGE_SIZE);
  } else {
    end = messageBefore === undefined ? DEEP_TOTAL : Math.max(0, Math.min(messageBefore, DEEP_TOTAL));
    start = Math.max(0, end - SUBAGENT_HISTORY_PAGE_SIZE);
  }
  return {
    id: sessionId,
    title: "Scoped history fixture",
    source: "local",
    mode: "agent",
    createdAt,
    updatedAt: createdAt,
    historyScope: { kind: "delegation", id: DEEP_DELEGATION },
    messages: Array.from({ length: end - start }, (_, offset) => deepChildRow(start + offset)),
    historyRuns: [
      { callId: DEEP_CALL, taskMessageId: "deep-task-row", taskIndex: 0, firstChildIndex: 0 },
    ],
    historyContext: [deepTaskRecord()],
    messageStart: start,
    messageEnd: end,
    messageCount: DEEP_TOTAL,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < DEEP_TOTAL,
  } as unknown as SessionDetail;
}

/** One delegation-scoped page, shaped like the host's answer. */
function delegationDetail(
  sessionId: string,
  messageBefore: number | undefined,
  messageAround: string | undefined,
  scopeId: string | undefined,
): SessionDetail | null {
  // The chain's `Task` card is live while its durable row is still queued:
  // the scoped read cannot resolve the chain yet.
  if (sessionId === SESSION && scopeId === FRESH_DELEGATION && !freshDurable) return null;
  const base = {
    id: sessionId,
    title: sessionId === SESSION ? "Scoped history fixture" : "Other session",
    source: "local",
    mode: "agent",
    createdAt,
    updatedAt: createdAt,
    historyScope: { kind: "delegation" as const, id: scopeId ?? DELEGATION },
  };
  if (sessionId === SESSION && scopeId === FRESH_DELEGATION) {
    return {
      ...base,
      messages: FRESH_PAGE.map((id) => freshChildRow(id)),
      historyRuns: [
        { callId: FRESH_CALL, taskMessageId: "fresh-task-row", taskIndex: 49, firstChildIndex: 50 },
      ],
      historyContext: [freshTaskRecord(true)],
      messageStart: 50,
      messageEnd: 51,
      messageCount: 3,
      hasMoreBefore: false,
    } as unknown as SessionDetail;
  }
  if (sessionId === SESSION && scopeId === DEEP_DELEGATION) {
    return deepDetail(sessionId, messageBefore, messageAround);
  }
  if (sessionId === SESSION && scopeId === ANCHOR_DELEGATION) {
    return anchorDetail(sessionId, messageBefore);
  }
  if (sessionId === OTHER_SESSION) {
    return {
      ...base,
      messages: [],
      historyContext: [],
      messageStart: 0,
      messageEnd: 0,
      messageCount: 0,
      hasMoreBefore: false,
    } as unknown as SessionDetail;
  }
  if (messageBefore !== undefined) {
    // The selection immediately before the tail window: the head page, whose
    // physical end is exactly where the held window begins.
    return {
      ...base,
      messages: OLDER_PAGE.map((id) => childRow(id, `scoped older row ${id}`)),
      historyRuns: [
        { callId: CALL, taskMessageId: "task-row", taskIndex: 19, firstChildIndex: 20 },
      ],
      historyContext: [taskRecord()],
      messageStart: OLDER_PAGE_START,
      messageEnd: FIRST_PAGE_START,
      messageCount: FIRST_PAGE_START + FIRST_PAGE.length,
      hasMoreBefore: false,
    } as unknown as SessionDetail;
  }
  return {
    ...base,
    messages: FIRST_PAGE.map((id) => childRow(id, `scoped page row ${id}`)),
    historyRuns: [
      { callId: CALL, taskMessageId: "task-row", taskIndex: 19, firstChildIndex: 20 },
    ],
    historyContext: [taskRecord()],
    messageStart: FIRST_PAGE_START,
    messageEnd: FIRST_PAGE_START + FIRST_PAGE.length,
    messageCount: FIRST_PAGE_START + FIRST_PAGE.length,
    hasMoreBefore: true,
  } as unknown as SessionDetail;
}

window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async (channel: string, payload?: unknown) => {
    channels.push(channel);
    if (channel !== IPC.invoke.sessionGet) return { ok: true, data: undefined };
    const request = (payload ?? {}) as {
      id?: string;
      historyScope?: { kind?: string; id?: string };
      messageBefore?: number;
      messageAround?: string;
      messageLimit?: number;
      contentLimit?: number;
    };
    const id = request.id ?? "";
    const answer = delegationDetail(
      id,
      request.messageBefore,
      request.messageAround,
      request.historyScope?.id,
    );
    reads.push({
      // The mount state of the rows the panel already loaded, captured at the
      // moment the read is issued: a read must never start while the rows it
      // would sit under are still arriving.
      hydrationAtRequest:
        document
          .querySelector<HTMLElement>(".subagent-transcript-list")
          ?.getAttribute("data-hydration-state") ?? null,
      id,
      scope: request.historyScope,
      messageBefore: request.messageBefore,
      messageAround: request.messageAround,
      messageLimit: request.messageLimit,
      contentLimit: request.contentLimit,
      answer: answer
        ? {
            start: answer.messageStart,
            end: answer.messageEnd,
            rows: answer.messages?.length,
            before: answer.hasMoreBefore,
            after: answer.hasMoreAfter,
          }
        : null,
    });
    // One held read answers only when the probe releases it, so a jump can be
    // pressed while a boundary page is genuinely still in flight.
    if (
      heldOlderRead &&
      request.historyScope?.id === heldOlderRead.scopeId &&
      request.messageBefore !== undefined
    ) {
      await heldOlderRead.promise;
    }
    return { ok: true, data: { session: answer } };
  },

  on: () => () => undefined,
} as unknown as typeof window.piDesktop;

const i18n = createInstance();
void i18n.init({
  lng: "en",
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});

/** Main top-level rows, plus the Task card the delegate was opened from. */
function mainWindow(): UiMessage[] {
  return [
    message("u-1", "user", "Fix the cache"),
    message("a-1", "assistant", "Looking at the cache now."),
    taskRecord(),
  ];
}

flushSync(() => {
  useAppStore.setState({
    activeSessionId: SESSION,
    sessions: [
      { id: SESSION, title: "Scoped history fixture", source: "local", mode: "agent", createdAt, updatedAt: createdAt },
      { id: OTHER_SESSION, title: "Other session", source: "local", mode: "agent", createdAt, updatedAt: createdAt },
    ] as never,
    messages: mainWindow(),
    isRunning: false,
    settings: { enterToSend: true },
    providers: [],
    providerModels: {},
    plugins: [],
    recentModels: [],
    retainedTranscripts: {},
    retainedSessionIds: [],
    sessionHistory: {},
    transcriptViews: {},
    sessionCompactions: {},
    sessionTodos: {},
    subagentHistory: {},
    pendingPermissions: {},
    pendingAsks: {},
    queuedPrompts: {},
    planCheckpoints: {},
    agentStatuses: {},
    runningSessions: {},
  } as never);
});

const host = document.createElement("div");
host.style.cssText =
  "position:fixed;inset:0;display:flex;align-items:stretch;background:var(--ds-bg-primary)";
(document.body ?? document.documentElement).append(host);

const panel = document.createElement("div");
panel.className = "work-panel";
panel.style.cssText = "display:flex;flex-direction:column;min-height:0;height:700px;width:420px";
const body = document.createElement("div");
body.className = "work-panel-body";
body.style.cssText =
  "position:relative;display:flex;min-height:0;flex:1;flex-direction:column;aspect-ratio:auto";
const pane = document.createElement("div");
pane.className = "work-panel-tabpane";
pane.style.cssText = "display:flex;min-height:0;flex:1;flex-direction:column";
host.append(panel);
panel.append(body);
body.append(pane);
/**
 * The per-commit history of the mounted run.
 *
 * Each sample is one commit that changed how many rows are drawn: the row
 * count the DOM reached, the rows that commit added, and the offset the held
 * fragment had *at that commit*. A page that arrives in batches therefore
 * leaves one sample per batch, which is what proves the reader's fragment kept
 * its viewport offset across the batches and not only once the page finished.
 */
type BatchSample = {
  rows: number;
  added: number;
  removed: number;
  /** The pane's own report for the commit that produced this sample. */
  state: string | null;
  mounted: number;
  loaded: number;
  anchorOffset: number | null;
  /** Which fragment the offset belongs to (the reader's anchor when sampled). */
  anchorId: string | null;
  scrollTop: number;
  scrollHeight: number;
};
const batchSamples: BatchSample[] = [];
/** The fragment an older page is holding, captured before its read is issued. */
let batchAnchor: { id: string; offset: number } | null = null;
/** A row's offset from the scroller's own top edge. */
const rowOffset = (element: HTMLElement, id: string) => {
  const node = element.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  if (!node) return null;
  return node.getBoundingClientRect().top - element.getBoundingClientRect().top;
};
const observedLists = new WeakSet<HTMLElement>();
let observedRows = 0;
let observedList: HTMLElement | null = null;
/**
 * Sample every commit that mounts or replaces rows of this list.
 *
 * The observer is attached to the list element itself, so a remounted pane
 * samples its own rows without the probe reinstalling anything by hand.
 */
function observeBatches(element: HTMLElement | null) {
  if (!element || observedLists.has(element)) return;
  observedLists.add(element);
  observedRows = element.querySelectorAll("[data-message-id]").length;
  // The commit that is already drawn when the observer attaches is the window's
  // first commit: sample it as the baseline so every later sample is a real
  // delta against the pane's own reported mounted count.
  batchSamples.push({
    rows: observedRows,
    added: 0,
    removed: 0,
    state: element.getAttribute("data-hydration-state"),
    mounted: Number(element.getAttribute("data-hydration-mounted") ?? "-1"),
    loaded: Number(element.getAttribute("data-hydration-loaded") ?? "-1"),
    anchorOffset: null,
    anchorId: batchAnchor?.id ?? null,
    scrollTop: 0,
    scrollHeight: 0,
  });
  // One `MutationRecord` per write of the pane's own mounted-count attribute:
  // React writes it once per commit, so two commits that one observation
  // delivery carries are still two samples and one commit is never reported as
  // the sum of the batch before it. Every unit the pane mounts draws exactly one
  // `[data-message-id]` row, so the mounted count a commit reports is the row
  // count it drew.
  const observer = new MutationObserver((records) => {
    const scrollerElement = document.querySelector<HTMLElement>(".subagent-transcript-scroll");
    if (!scrollerElement) return;
    const commits = records.filter(
      (record) => record.type === "attributes" && record.attributeName === "data-hydration-mounted",
    );
    for (let index = 0; index < commits.length; index += 1) {
      // The next record of this delivery recorded the value *this* commit wrote
      // as its old value; the last commit's value is what the pane reports now.
      const following = commits[index + 1]?.oldValue;
      const mounted =
        index + 1 < commits.length && following != null
          ? Number(following)
          : Number(element.getAttribute("data-hydration-mounted") ?? "-1");
      const rows = mounted;
      const previous = observedRows;
      observedRows = rows;
      // A row that streams a character without moving the mounted run is not a
      // commit boundary: it draws no batch and would only blur the measurement.
      if (rows === previous && mounted === (batchSamples.at(-1)?.mounted ?? -1)) continue;
      batchSamples.push({
        rows,
        added: Math.max(0, rows - previous),
        removed: Math.max(0, previous - rows),
        state: element.getAttribute("data-hydration-state"),
        mounted,
        loaded: Number(element.getAttribute("data-hydration-loaded") ?? "-1"),
        anchorOffset: batchAnchor ? rowOffset(scrollerElement, batchAnchor.id) : null,
        anchorId: batchAnchor?.id ?? null,
        scrollTop: scrollerElement.scrollTop,
        scrollHeight: scrollerElement.scrollHeight,
      });
    }
  });
  observer.observe(element, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-hydration-mounted"],
    attributeOldValue: true,
  });
}

let root: Root | null = null;

function mountTab(delegationId: string = DELEGATION) {
  root = createRoot(pane);
  const mounted = root;
  flushSync(() => {
    mounted.render(
      <I18nextProvider i18n={i18n}>
        <SubagentTranscriptTab delegationId={delegationId} />
      </I18nextProvider>,
    );
  });
  observeBatches(pane.querySelector<HTMLElement>(".subagent-transcript-list"));
}

mountTab();

const frames = (count = 2) =>
  new Promise<void>((resolve) => {
    const tick = (left: number) => {
      if (left <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => tick(left - 1));
    };
    tick(count);
  });

async function until(check: () => boolean, label: string, timeoutMs = 4_000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (check()) return;
    await frames(1);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const tab = () => document.querySelector<HTMLElement>(".subagent-transcript-tab");
const scroller = () => document.querySelector<HTMLElement>(".subagent-transcript-scroll");
const list = () => document.querySelector<HTMLElement>(".subagent-transcript-list");
const transcriptIds = () =>
  Array.from(list()?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])
    .map((row) => row.dataset.messageId ?? "")
    .filter(Boolean);
/**
 * The Task prompts actually drawn, always scoped to the panel's own list: the
 * main transcript can hold a Task card with the same source message identity,
 * so an unscoped query would prove the wrong row.
 */
const userPromptRows = () =>
  Array.from(list()?.querySelectorAll<HTMLElement>(".message-row.user") ?? []);
const promptIds = () =>
  userPromptRows()
    .map((row) => row.dataset.messageId ?? "")
    .filter(Boolean);
const assistantIds = () => transcriptIds().filter((id) => id.startsWith("child-") || id.startsWith("live-"));
const assistantText = (id: string) => {
  const row = list()?.querySelector<HTMLElement>(
    `.message-row.assistant[data-message-id="${id}"]`,
  );
  return row?.textContent ?? "";
};
const emptyState = () => document.querySelector<HTMLElement>('[data-testid="subagent-history-empty"]');
const errorState = () => document.querySelector<HTMLElement>('[data-testid="subagent-history-error"]');
const jumpControl = () => document.querySelector<HTMLElement>(".subagent-transcript-jump");
/**
 * Whether every row of the loaded window is mounted yet.
 *
 * A scoped page reaches the pane in batches, so "the read finished" and "the
 * page is drawn" are two different moments: a probe that asserts rows, order,
 * or a reading anchor waits for this, and the batches themselves are observed
 * through `batchSamples`.
 */
const hydrationState = () => list()?.getAttribute("data-hydration-state") ?? null;
/** Rows the pane holds and says are loaded, in its own projection's terms. */
const hydrationLoaded = () =>
  Number(list()?.getAttribute("data-hydration-loaded") ?? "-1");
const hydrationMounted = () =>
  Number(list()?.getAttribute("data-hydration-mounted") ?? "-1");
/**
 * Wait until the pane presents every row it has loaded.
 *
 * The attribute alone is not enough: in the commit that applies a response the
 * pane still reports the state of the window it drew before, which is "ready"
 * and empty. A page is drawn only when it states readiness *and* names rows.
 */
const awaitHydration = (label: string, timeoutMs = 6_000) =>
  until(
    () =>
      hydrationState() === "ready" &&
      hydrationLoaded() > 0 &&
      hydrationMounted() === hydrationLoaded(),
    `the mounted rows of ${label}`,
    timeoutMs,
  );
/**
 * The fragment the reader is looking at: the first mounted row whose bottom is
 * below the reading line, exactly the fragment the panel's own hold captures.
 */
const readingLine = (element: HTMLElement) => {
  const top = element.getBoundingClientRect().top;
  const line = Math.min(120, element.clientHeight / 4);
  for (const node of Array.from(element.querySelectorAll<HTMLElement>("[data-message-id]"))) {
    const rect = node.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom - top <= line) continue;
    return { id: node.dataset.messageId ?? "", offset: rect.top - top };
  }
  return null;
};
/**
 * Drive the reader into the top boundary, where the next page is read.
 *
 * The offset is the near-top band, not the exact top: the reader's fragment
 * stays a real visible row, so the offset it must keep is measurable. It is
 * captured here, before the scroll event that arms the panel's own hold, so
 * both sides measure the same reading position.
 */
const reachTop = async (topPosition = 60) => {
  const scroller = document.querySelector<HTMLElement>(".subagent-transcript-scroll");
  if (!scroller) throw new Error("no transcript scroller");
  const before = {
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
  };
  const beforeIds = transcriptIds();
  scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
  scroller.scrollTop = topPosition;
  const anchored = readingLine(scroller);
  // The hold's fragment is stated here, in the same task as the scroll that
  // armed it: the read is dispatched from the wheel's own frame, so every batch
  // commit it produces is sampled against this offset.
  batchAnchor = anchored ? { id: anchored.id, offset: anchored.offset } : null;
  const gesture = {
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
  };
  await frames(2);
  return anchored ? {
    ...anchored,
    before,
    gesture,
    beforeIds,
  } : null;
};
const metricsContext = () =>
  document.querySelector<HTMLElement>('[data-testid="subagent-metrics-context"]')?.textContent ?? "";
const statusLabel = () =>
  document.querySelector<HTMLElement>(".subagent-transcript-status")?.textContent ?? "";

const store = () => useAppStore.getState();
const entry = (sessionId = SESSION, delegationId = DELEGATION) =>
  store().subagentHistory[sessionId]?.[delegationId];

const scopedReads = () => reads.filter((read) => read.scope?.kind === "delegation");

const failuresOf = (checks: Array<[boolean, string]>) =>
  checks.filter(([pass]) => !pass).map(([, label]) => label);

const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

globalThis.scopedHistoryProbe = async () => {
  const probeStartedAt = performance.now();
  await frames(3);
  const failures: string[] = [];
  const facts: Record<string, unknown> = {};

  // 1. Opening the panel: one bounded page of its own chain, never the parent.
  await until(
    () => scopedReads().length === 1 && entry()?.status === "ready",
    "the delegate's first scoped page",
  );
  await frames(2);
  await awaitHydration("the delegate's first scoped page");
  failures.push(
    ...failuresOf([
      [scopedReads().length === 1, "opening the panel spends exactly one scoped read"],
      [scopedReads()[0]?.scope?.id === DELEGATION, "the read addresses the opened chain"],
      [
        scopedReads()[0]?.messageLimit === SUBAGENT_HISTORY_PAGE_SIZE,
        `the page is bounded (limit ${scopedReads()[0]?.messageLimit})`,
      ],
      [
        scopedReads()[0]?.contentLimit === SUBAGENT_HISTORY_CONTENT_LIMIT,
        "the page carries the delegate content limit",
      ],
      [scopedReads()[0]?.messageBefore === undefined, "the first page asks for no older cursor"],
      [reads.every((read) => read.scope?.kind === "delegation"), "no read left the panel unscoped"],
      [tab() !== null, "the panel's own tab renders"],
      [same(assistantIds(), FIRST_PAGE), `the first page's rows render (${assistantIds().join(",")})`],
      [/completed/i.test(statusLabel()), `the header states the chain's status (${statusLabel()})`],
      [metricsContext().length > 0, `chain metrics resolve from the page's context (${metricsContext()})`],
      [entry()?.hasMoreBefore === true, "an older page exists behind the first one"],
      [
        promptIds().length === 0 && userPromptRows().length === 0,
        "a tail window cut inside the run draws no Task prompt",
      ],
      [emptyState() === null && errorState() === null, "a loaded panel shows neither empty nor error"],
    ]),
  );
  const firstPageRows = assistantIds();
  facts.firstRead = {
    scope: scopedReads()[0]?.scope,
    messageLimit: scopedReads()[0]?.messageLimit,
    contentLimit: scopedReads()[0]?.contentLimit,
  };
  facts.mainMessages = store().messages.length;

  // 2. The reader replaces the parent's window with older top-level rows that
  //    hold no Task card at all: the panel's own page must survive untouched.
  flushSync(() => {
    useAppStore.setState({
      messages: [
        message("u-old-1", "user", "an older parent prompt"),
        message("a-old-1", "assistant", "an older parent answer"),
      ],
      sessionHistory: {
        [SESSION]: {
          sessionId: SESSION,
          messages: [
            message("u-old-1", "user", "an older parent prompt"),
            message("a-old-1", "assistant", "an older parent answer"),
          ],
          messageStart: 0,
          messageEnd: 1,
          messageCount: 3614,
          hasMoreBefore: false,
        },
      },
      transcriptViews: {},
    } as never);
  });
  await frames(4);
  await awaitHydration("the page behind the replaced parent window");
  failures.push(
    ...failuresOf([
      [same(assistantIds(), firstPageRows), "replacing the parent window leaves the panel's rows intact"],
      [scopedReads().length === 1, "replacing the parent window spends no further read"],
      [entry()?.status === "ready", "the panel stays available after the parent window is replaced"],
      [entry()?.messages.length === FIRST_PAGE.length, "the cached page keeps its own rows"],
      [entry()?.canonicalId === DELEGATION, "the chain identity is unchanged"],
      [entry()?.hasMoreBefore === true, "paging state survives the parent window"],
      [emptyState() === null && errorState() === null, "the panel is neither empty nor failed"],
      [
        metricsContext().length > 0,
        `chain metrics survive without any parent Task card (${metricsContext()})`,
      ],
    ]),
  );
  facts.afterReplace = { rows: assistantIds(), reads: scopedReads().length };

  // 3. Reaching the top reads the chain's own previous page with the cursor the
  //    page kept; the panel has no separate earlier control.
  await reachTop();
  await until(
    () => scopedReads().length === 2 && entry()?.status === "ready",
    "the older page of the chain",
  );
  await frames(2);
  await awaitHydration("the older page of the chain");
  failures.push(
    ...failuresOf([
      [scopedReads()[1]?.messageBefore === 30, `the older read uses the page cursor (${scopedReads()[1]?.messageBefore})`],
      [scopedReads()[1]?.scope?.id === DELEGATION, "the older read stays in the chain's scope"],
      [
        same(assistantIds(), [...OLDER_PAGE, ...FIRST_PAGE]),
        `older rows prepend to the loaded page (${assistantIds().join(",")})`,
      ],
      [entry()?.hasMoreBefore === false, "the boundary pages no further once the head is loaded"],
      [entry()?.messages.length === OLDER_PAGE.length + FIRST_PAGE.length, "the page holds every loaded row"],
      [
        same(promptIds(), ["task-row"]) && userPromptRows().length === 1,
        `the page that reaches the run's first child introduces its prompt once (${promptIds().join(",")})`,
      ],
      [
        transcriptIds()[0] === "task-row",
        "the prompt takes its chronological opening position, not a sticky header",
      ],
    ]),
  );
  facts.afterOlder = { rows: assistantIds(), reads: scopedReads().length };

  // 4. A live child row merges in without the panel reloading anything.
  flushSync(() => {
    useAppStore.setState({ messages: [...store().messages, childRow(LIVE_ROW, "live chain row forty one", { status: "streaming" })] } as never);
  });
  await frames(3);
  failures.push(
    ...failuresOf([
      [assistantIds().includes(LIVE_ROW), "a live child row joins the panel"],
      [assistantText(LIVE_ROW).includes("live chain row forty one"), "the live row renders its own content"],
      [scopedReads().length === 2, "a live row needs no scoped read"],
    ]),
  );
  // The completed event for the same row replaces the streaming copy in place.
  flushSync(() => {
    useAppStore.setState({
      messages: store().messages.map((row) =>
        row.id === LIVE_ROW ? { ...row, status: "complete", content: "live chain row forty one is final" } : row,
      ),
    } as never);
  });
  await frames(3);
  failures.push(
    ...failuresOf([
      [assistantIds().filter((id) => id === LIVE_ROW).length === 1, "a completed live row does not duplicate"],
      [assistantText(LIVE_ROW).includes("is final"), "the live row's completion replaces its streaming copy"],
    ]),
  );
  facts.afterLive = { rows: assistantIds(), reads: scopedReads().length };

  // 5. Switching the conversation away and back keeps the chain's page.
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: OTHER_SESSION,
      messages: [message("u-other", "user", "another conversation")],
    } as never);
  });
  await until(() => scopedReads().some((read) => read.id === OTHER_SESSION), "the other session's read");
  await frames(3);
  failures.push(
    ...failuresOf([
      [
        // The chain owns the live child row it streamed, so the tab's page
        // survives the session switch with that row included.
        entry()?.messages.length === OLDER_PAGE.length + FIRST_PAGE.length + 1,
        "switching the session keeps the first chain's page",
      ],
      [entry()?.canonicalId === DELEGATION, "the first chain keeps its identity while another session is on screen"],
      [
        document.querySelector<HTMLElement>(`.message-row.assistant[data-message-id="${FIRST_PAGE[0]}"]`) === null,
        "the first chain's rows are not drawn for the other session",
      ],
      [emptyState() !== null, "the other session's empty scoped page states emptiness"],
    ]),
  );
  const readsBeforeRestore = scopedReads().length;
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: SESSION,
      // The session's own live turn array comes back with the row it streamed.
      messages: [
        message("u-late", "user", "a restored parent window"),
        childRow(LIVE_ROW, "live chain row forty one is final"),
      ],
    } as never);
  });
  await frames(4);
  await awaitHydration("the restored session's page");
  failures.push(
    ...failuresOf([
      [
        same(assistantIds(), [...OLDER_PAGE, ...FIRST_PAGE, LIVE_ROW]),
        `restoring the session restores the loaded rows (${assistantIds().join(",")})`,
      ],
      // A chain whose live rows arrived after its last read refreshes its tail
      // once on restore; rows, identity and availability do not change.
      [scopedReads().length <= readsBeforeRestore + 1, "restoring the session spends at most one tail refresh"],
      [emptyState() === null, "the restored panel is not the other session's empty state"],
    ]),
  );
  facts.afterRestore = { rows: assistantIds(), reads: scopedReads().length };

  // 6. Close and reopen the tab: the page is reused, not rebuilt from the parent.
  const readCount = scopedReads().length;
  flushSync(() => {
    root?.unmount();
    root = null;
  });
  await frames(2);
  failures.push(...failuresOf([[tab() === null, "closing the tab removes its surface"]]));
  mountTab();
  await frames(4);
  await awaitHydration("the reopened tab's page");
  failures.push(
    ...failuresOf([
      [tab() !== null, "reopening the tab mounts its surface"],
      [
        same(assistantIds(), [...OLDER_PAGE, ...FIRST_PAGE, LIVE_ROW]),
        "reopening draws the page the entry kept",
      ],
      [scopedReads().length === readCount, "reopening reuses the cached page"],
      [entry()?.status === "ready", "the reopened panel is ready"],
    ]),
  );
  facts.afterReopen = { rows: assistantIds(), reads: scopedReads().length };

  // 7. The parent's window comes back to the original shape: still nothing to do.
  flushSync(() => {
    useAppStore.setState({ messages: mainWindow() } as never);
  });
  await frames(3);
  await awaitHydration("the restored parent window's page");
  failures.push(
    ...failuresOf([
      [scopedReads().length === readCount, "the restored parent window spends no read"],
      // The chain owns the live child rows it streamed: a parent window that
      // no longer holds them keeps them on the chain's page.
      [same(assistantIds(), [...OLDER_PAGE, ...FIRST_PAGE, LIVE_ROW]), "a parent window without live rows keeps the chain's rows"],
    ]),
  );

  // 8. A chain opened from a `Task` card that is live while host-core has not
  //    yet appended its durable row. The first scoped read cannot resolve the
  //    chain; the panel keeps the live conversation instead of declaring the
  //    chain unavailable, and converges on its durable page when the dispatch
  //    settles.
  flushSync(() => {
    root?.unmount();
    root = null;
  });
  freshDurable = false;
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: SESSION,
      messages: [freshTaskRecord(false), freshChildRow(FRESH_LIVE)],
    } as never);
  });
  mountTab(FRESH_DELEGATION);
  const freshEntry = () => entry(SESSION, FRESH_DELEGATION);
  const freshScopedReads = () =>
    scopedReads().filter((read) => read.scope?.id === FRESH_DELEGATION);
  await until(
    () => freshScopedReads().length === 1 && freshEntry()?.status === "ready",
    "the pending chain's first scoped answer",
  );
  await frames(2);
  failures.push(
    ...failuresOf([
      [
        freshEntry()?.error === undefined && errorState() === null,
        `a chain whose durable Task row is still queued is not reported unavailable (error ${String(freshEntry()?.error)})`,
      ],
      [freshEntry()?.pendingDurable === true, "the panel records that its first durable page is still owed"],
      [emptyState() === null, "the pending chain is not an empty history"],
      [assistantIds().includes(FRESH_LIVE), "the live child row renders while the durable page is owed"],
      [freshScopedReads().length === 1, "the pending answer costs one scoped read"],
      [freshScopedReads()[0]?.scope?.id === FRESH_DELEGATION, "the pending answer addresses the chain's own scope"],
    ]),
  );
  facts.freshPending = {
    status: freshEntry()?.status,
    pendingDurable: freshEntry()?.pendingDurable,
    error: freshEntry()?.error ?? null,
    rows: assistantIds(),
  };

  // The completion event publishes the settled `Task` card; its durable row is
  // appended behind it. That transition is what the panel reads on.
  freshDurable = true;
  flushSync(() => {
    useAppStore.setState({
      messages: [freshTaskRecord(true), freshChildRow(FRESH_LIVE)],
    } as never);
  });
  await until(
    () =>
      freshEntry()?.pendingDurable === false &&
      freshEntry()?.scoped === true &&
      assistantIds().includes(FRESH_PAGE[0] ?? ""),
    "the chain's first durable page",
  );
  await frames(2);
  failures.push(
    ...failuresOf([
      [
        freshEntry()?.error === undefined && errorState() === null,
        "the durable page replaces the pending state without an error",
      ],
      [same(assistantIds().slice(0, FRESH_PAGE.length), FRESH_PAGE), `the durable page renders its rows (${assistantIds().join(",")})`],
      [assistantIds().filter((id) => id === FRESH_LIVE).length === 1, "the live row stays one row over the durable page"],
      [
        freshScopedReads().length === 2,
        `settling converges with one more scoped read, not a poll (${freshScopedReads().length})`,
      ],
    ]),
  );
  facts.freshSettled = {
    status: freshEntry()?.status,
    pendingDurable: freshEntry()?.pendingDurable,
    scoped: freshEntry()?.scoped,
    reads: freshScopedReads().length,
    rows: assistantIds(),
  };
  // 9. A long chain, the representative user path: opening the tab reads the
  //    tail page; reaching the top pages older automatically while the
  //    fragment in view keeps its offset and the window keeps growing (no row
  //    budget); a search focus switches the window to the target's contiguous
  //    page; the jump control reads the newest page and scrolls to it; and live
  //    rows are never drawn as a disconnected tail while the window is
  //    historical.
  flushSync(() => {
    root?.unmount();
    root = null;
  });
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: SESSION,
      messages: [deepTaskRecord(), message("deep-parent-main", "user", "ordinary top-level main row")],
    } as never);
  });
  const tailSamplesFrom = batchSamples.length;
  mountTab(DEEP_DELEGATION);
  const deepEntry = () => entry(SESSION, DEEP_DELEGATION);
  const deepReads = () =>
    scopedReads().filter((read) => read.scope?.id === DEEP_DELEGATION);
  const deepRowIds = () => assistantIds().filter((id) => id.startsWith("child-deep-"));
  const deepRows = () => deepRowIds().map((id) => Number(id.slice("child-deep-".length)));
  const noEarlierControl = () =>
    document.querySelector(".subagent-transcript-earlier .link-btn") === null;
  await until(
    () => deepReads().length === 1 && deepEntry()?.status === "ready",
    "the long chain's first page",
  );
  const tailReadAt = performance.now();
  await awaitHydration("the long chain's tail page");
  const tailMountedAt = performance.now();
  failures.push(
    ...failuresOf([
      [deepReads().length === 1, "opening the long chain spends one scoped read"],
      [deepEntry()?.messageStart === DEEP_TAIL_START, `the first window is the tail page (${deepEntry()?.messageStart})`],
      [deepEntry()?.messageEnd === DEEP_TOTAL, "the window ends at the chain's tail"],
      [
        same(deepRowIds(), Array.from({ length: SUBAGENT_HISTORY_PAGE_SIZE }, (_, offset) => deepRowId(DEEP_TAIL_START + offset))),
        "the tail page's rows render",
      ],
      [deepEntry()?.hasMoreBefore === true, "older rows exist behind the window"],
      [noEarlierControl(), "there is no separate show-earlier control"],
    ]),
  );
  // The tail page reaches the pane in bounded commits: the first one mounts a
  // short run near the newest row, later frames mount the rest, and nothing
  // stays hidden once the page states it is ready.
  const tailBatches = batchSamples.slice(tailSamplesFrom);
  // The list is observed as it mounts, before the read lands, so its baseline
  // sample can already draw a cached row: the page's first commit is the first
  // sample that carries the page's own rows.
  const tailPageStart = tailBatches.find(
    (sample) => sample.loaded >= SUBAGENT_HISTORY_PAGE_SIZE,
  );
  const tailFirstCommit = tailPageStart
    ? Math.min(tailPageStart.mounted, tailPageStart.loaded)
    : deepRowIds().length;
  const tailLargestCommit = Math.max(...tailBatches.map((sample) => sample.added), 0);
  failures.push(
    ...failuresOf([
      [
        tailFirstCommit === SUBAGENT_HYDRATION_FIRST_ROWS,
        `the tail page's first commit is the bounded run (${tailFirstCommit} rows)`,
      ],
      [
        tailLargestCommit <= SUBAGENT_HYDRATION_STEP_ROWS,
        `no commit mounts more than one batch of the page (${tailLargestCommit} rows)`,
      ],
      [hydrationState() === "ready", "the finished tail page states every row is mounted"],
    ]),
  );
  facts.deepFirstPage = {
    messageStart: deepEntry()?.messageStart,
    rows: deepRowIds().length,
    readMs: Math.round(tailReadAt - probeStartedAt),
    hydratedMs: Math.round(tailMountedAt - probeStartedAt),
    batches: tailBatches,
  };

  const deepScroller = scroller();
  const geometryOf = (element: HTMLElement) => {
    const top = element.getBoundingClientRect().top;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      distanceFromBottom: element.scrollHeight - element.scrollTop - element.clientHeight,
      top,
    };
  };
  const fragmentOffset = (element: HTMLElement, id: string) => {
    const node = element.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!node) return null;
    return node.getBoundingClientRect().top - element.getBoundingClientRect().top;
  };
  // A real upward gesture releases follow, so the top reach grows the rows
  // above the reader's own reading position instead of the pinned bottom. The
  // wheel input and the scroll event are both dispatched: a synthetic `scrollTop`
  // write emits no scroll event of its own, and follow is released by the event
  // that carries the reader's input, not by the write.
  const releaseTarget = deepScroller
    ? Math.max(0, Math.floor((deepScroller.scrollHeight - deepScroller.clientHeight) / 2))
    : 0;
  deepScroller!.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, deltaY: -(deepScroller!.scrollTop - releaseTarget) }),
  );
  deepScroller!.scrollTop = releaseTarget;
  deepScroller!.dispatchEvent(new Event("scroll", { bubbles: true }));
  failures.push(
    ...failuresOf([
      [deepScroller ? geometryOf(deepScroller).distanceFromBottom > 100 : false, "an upward gesture releases follow"],
    ]),
  );

  // Three automatic boundary reaches: each read pages from the window's own
  // start and the fragment at the reading line keeps its offset. These pages
  // stay inside the run, so none of them may draw its Task prompt.
  const deepPagingTrace: Array<Record<string, unknown>> = [];
  for (let step = 0; step < 3; step += 1) {
    const before = deepReads().length;
    const samplesFrom = batchSamples.length;
    const anchored = await reachTop();
    if (!anchored) {
      failures.push("the released scroller shows a fragment at the reading line");
      break;
    }
    await until(
      () => deepReads().length === before + 1 && deepEntry()?.status === "ready",
      `boundary older page ${step + 1}`,
    );
    const readAt = performance.now();
    // The read finishing and the page being drawn are different moments: the
    // rows arrive in batches, so the page's rows, order, and anchors are only
    // final once it states that everything it loaded is mounted.
    await awaitHydration(`older page ${step + 1}`);
    const hydratedAt = performance.now();
    const pageBatches = batchSamples.slice(samplesFrom);
    const after = deepScroller ? fragmentOffset(deepScroller, anchored.id) : null;
    const ids = transcriptIds();
    // The prompt is a chronological opening, so no prepended page may draw it
    // above children the window already holds.
    const promptRows = promptIds().length;
    const loading = document.querySelector<HTMLElement>('[data-testid="subagent-history-older-loading"]');
    const loadingLabel = loading?.querySelector<HTMLElement>(".subagent-transcript-earlier-label");
    const read = deepReads().at(-1);
    deepPagingTrace.push({
      page: step + 1,
      before: anchored.before,
      after: deepScroller ? geometryOf(deepScroller) : null,
      anchor: { id: anchored.id, beforeOffset: anchored.offset, afterOffset: after },
      ids: ids.slice(0, 4),
      promptRows,
      loading: loading ? {
        height: loading.getBoundingClientRect().height,
        ariaHidden: loading.getAttribute("aria-hidden"),
        labelVisibility: loadingLabel ? getComputedStyle(loadingLabel).visibility : null,
      } : null,
      scopeIds: deepReads().map((item) => item.scope?.id),
      cursor: read?.messageBefore,
      batches: pageBatches,
      readMs: Math.round(readAt - probeStartedAt),
      hydratedMs: Math.round(hydratedAt - probeStartedAt),
    });
    failures.push(
      ...failuresOf([
        [
          after !== null && Math.abs(after - anchored.offset) < 2,
          `the held fragment stays on its viewport offset at step ${step + 1} (${anchored.id}: ${String(
            anchored.offset,
          )} → ${String(after)})`,
        ],
        [promptRows === 0, `no Task prompt is drawn above the held children at step ${step + 1}`],
        [
          ids[0] === (deepEntry()?.messageStart === undefined ? "" : deepRowId(deepEntry()!.messageStart!)),
          `the page head is its oldest child, not a reused prompt at step ${step + 1}`,
        ],
        [loading?.getAttribute("aria-hidden") === "true", "settled loading furniture is hidden"],
        [deepReads().every((item) => item.scope?.id === DEEP_DELEGATION), "every older read echoes the delegation scope"],
        [noEarlierControl(), "boundary paging is not a control"],
        [
          pageBatches.every(
            (sample) =>
              sample.anchorOffset !== null &&
              Math.abs(sample.anchorOffset - anchored.offset) < 2,
          ),
          `every batch of page ${step + 1} keeps the held fragment on its offset (${pageBatches
            .map((sample) => sample.anchorOffset)
            .join(", ")})`,
        ],
        [
          pageBatches.every((sample) => sample.added <= SUBAGENT_HYDRATION_STEP_ROWS),
          `no batch of page ${step + 1} mounts more than one step of rows`,
        ],
        [
          pageBatches.length > 0 && pageBatches.some((sample) => sample.added > 0),
          `page ${step + 1} reached the pane in batches, not one commit`,
        ],
        [
          read?.hydrationAtRequest === "ready",
          `page ${step + 1} was read only after the loaded rows were mounted (${read?.hydrationAtRequest})`,
        ],
        [
          ids.length === (deepEntry()?.messages.length ?? -1),
          `every loaded row of page ${step + 1} is mounted (${ids.length}/${deepEntry()?.messages.length})`,
        ],
      ]),
    );
    if (step === 2) {
      failures.push(
        ...failuresOf([
          [
            read?.messageBefore === DEEP_TOTAL - 3 * SUBAGENT_HISTORY_PAGE_SIZE,
            `each older read pages from the window's own cursor (${read?.messageBefore})`,
          ],
          [
            deepEntry()?.messages.length === SUBAGENT_HISTORY_PAGE_SIZE * 4,
            `the window keeps every page it read (${deepEntry()?.messages.length})`,
          ],
          [deepEntry()?.messageStart === DEEP_TOTAL - 4 * SUBAGENT_HISTORY_PAGE_SIZE, "the older cursor follows the window's oldest page"],
          [deepEntry()?.messageEnd === DEEP_TOTAL, "the newest bound stays the chain's tail"],
        ]),
      );
    }
  }
  facts.deepPagingTrace = deepPagingTrace;
  failures.push(
    ...failuresOf([
      [deepPagingTrace.length === 3, "three older pages have a complete rendered trace"],
      [deepPagingTrace.every((page) => page.cursor === DEEP_TAIL_START - (Number(page.page) - 1) * SUBAGENT_HISTORY_PAGE_SIZE), "older cursors progress from the window head"],
      [
        deepPagingTrace.every((page) => page.promptRows === 0),
        "every older page inside the run stays prompt-free",
      ],
      [document.body.textContent?.includes("ordinary top-level main row") === false, "ordinary top-level main rows remain outside the scoped transcript"],
    ]),
  );
  // Two more reaches prove there is no row budget: the window keeps growing.
  for (let step = 0; step < 2; step += 1) {
    const before = deepReads().length;
    await reachTop();
    await until(
      () => deepReads().length === before + 1 && deepEntry()?.status === "ready",
      `boundary older page ${step + 4}`,
    );
    await awaitHydration(`boundary older page ${step + 4}`);
  }
  failures.push(
    ...failuresOf([
      [
        deepEntry()?.messages.length === SUBAGENT_HISTORY_PAGE_SIZE * 6,
        `the window keeps growing past any row budget (${deepEntry()?.messages.length})`,
      ],
      [deepEntry()?.messageStart === DEEP_OLDEST_START, `the oldest cursor is ${DEEP_OLDEST_START} (${deepEntry()?.messageStart})`],
      [
        deepRows().every((index, offset) => index === DEEP_OLDEST_START + offset),
        "the retained rows are one contiguous interval",
      ],
      [noEarlierControl(), "no top show-earlier control exists"],
      [
        promptIds().length === 0 && userPromptRows().length === 0,
        "a window that still has not reached the run head draws no prompt",
      ],
    ]),
  );
  facts.deepWindow = {
    rows: deepEntry()?.messages.length,
    messageStart: deepEntry()?.messageStart,
    reads: deepReads().length,
  };
  console.log("SCOPED_DEEP_TRACE " + JSON.stringify({ trace: deepPagingTrace, window: facts.deepWindow }));

  // A search focus on a distant row switches the window to the target's page.
  const focusTarget = deepRowId(DEEP_FOCUS_TARGET);
  const beforeFocus = deepReads().length;
  void store().ensureSubagentHistory({
    sessionId: SESSION,
    tabKey: DEEP_DELEGATION,
    messageId: focusTarget,
    query: "",
    requestId: 11,
  });
  await until(
    () => deepReads().length === beforeFocus + 1 && deepEntry()?.refreshing !== true,
    "the focus page of the long chain",
    15_000,
  );
  await awaitHydration("the focus page of the long chain");
  failures.push(
    ...failuresOf([
      [deepReads().at(-1)?.messageAround === focusTarget, "the focus read is centred on the target"],
      [deepEntry()?.messageStart === deepFocusStart, `the window starts at the target's focused page (${deepEntry()?.messageStart})`],
      [deepEntry()?.messageEnd === deepFocusEnd, "the window ends at the target's focused page"],
      [
        JSON.stringify(deepRows()) ===
          JSON.stringify(Array.from({ length: SUBAGENT_HISTORY_PAGE_SIZE }, (_, offset) => deepFocusStart + offset)),
        `the window is the target's contiguous page (${deepRows().slice(0, 2).join(",")}…)`,
      ],
      [!deepRowIds().includes(deepRowId(DEEP_TOTAL - 1)), "the distant range is not kept as an island"],
      [
        document.querySelector('[data-testid="subagent-history-omitted"]') === null,
        "no omission marker stands in for the distance",
      ],
      [deepEntry()?.hasMoreAfter === true, "newer rows stay stated"],
      [jumpControl() !== null, "the historical window offers the jump control"],
    ]),
  );
  facts.deepFocus = {
    messageStart: deepEntry()?.messageStart,
    rows: deepRows(),
    reads: deepReads().length,
  };

  // A live child row while the window is historical: routed in, never drawn as
  // the tail of the target's range.
  const liveDeep = deepRowId(deepFocusStart - 1);
  flushSync(() => {
    useAppStore.setState({
      messages: [
        deepTaskRecord(),
        message(liveDeep, "assistant", "live deep row", {
          parentToolCallId: DEEP_CALL,
          agentName: "explorer",
        }),
      ],
    } as never);
  });
  await frames(3);
  failures.push(
    ...failuresOf([
      [assistantIds().includes(liveDeep) === false, "a disconnected live row is not drawn"],
      [
        (deepEntry()?.livePending ?? []).some((row) => row.id === liveDeep) ||
          (deepEntry()?.messages ?? []).some((row) => row.id === liveDeep),
        "the live row is still owned by the chain",
      ],
    ]),
  );

  // 9b. Continuing forward: a historical window that still has newer rows pages
  //     below the reader. The appended page is the older page's commit problem
  //     mirrored - the reader's rows stay where they are, the new rows mount in
  //     bounded batches below them, and a bottom reach made while they mount
  //     spends no further host read.
  const forwardStart = deepEntry()?.messageStart ?? -1;
  const forwardEnd = deepEntry()?.messageEnd ?? -1;
  const forwardSamplesFrom = batchSamples.length;
  const forwardReadsBefore = deepReads().length;
  const forwardIdsBefore = transcriptIds();
  // The reader scrolls all the way onto the window's exact end - the geometry
  // `scrollHeight - clientHeight` produces - with their own gesture. That end is
  // not the chain's newest row while newer rows remain, so the reach continues
  // the window; it neither hands the viewport back to follow nor asks the tail
  // control for anything.
  const jumpBeforeForward = jumpControl() !== null;
  holdOlderReads(DEEP_DELEGATION);
  deepScroller!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 240 }));
  deepScroller!.scrollTop = deepScroller!.scrollHeight - deepScroller!.clientHeight;
  const jumpAtExactBottom = jumpControl() !== null;
  const forwardAnchor = readingLine(deepScroller!);
  batchAnchor = forwardAnchor ? { id: forwardAnchor.id, offset: forwardAnchor.offset } : null;
  const forwardGesture = geometryOf(deepScroller!);
  deepScroller!.dispatchEvent(new Event("scroll", { bubbles: true }));
  await until(() => deepReads().length === forwardReadsBefore + 1, "the forward page read");
  const forwardRead = deepReads().at(-1);
  releaseOlderReads();
  // The held answer applies after it is released, so the page is loaded once the
  // window's own end moved; until then the pane has not started preparing rows.
  await until(
    () =>
      deepEntry()?.messageEnd === forwardEnd + SUBAGENT_HISTORY_PAGE_SIZE &&
      deepEntry()?.refreshing !== true,
    "the appended page of the long chain",
    15_000,
  );
  // Every frame between the answer and the finished page is sampled for a Task
  // prompt: a window still inside the run must not flash one while it grows.
  const forwardPromptSamples: number[] = [];
  let forwardSettled = false;
  const sampleForwardPrompts = (async () => {
    const deadline = performance.now() + 6_000;
    do {
      forwardPromptSamples.push(promptIds().length);
      if (forwardSettled) return;
      await frames(1);
    } while (performance.now() < deadline);
  })();
  // A second reach at the boundary while the appended rows are still mounting.
  // It carries the reader's own gesture and sits on the window's end; the pane
  // must reveal what it already loaded instead of reading the next page, and
  // the fragment the reach leaves visible keeps its offset across the batches.
  let sawForwardMounting = false;
  let forwardReadsWhileMounting: number | null = null;
  let forwardReachAnchor: { id: string; offset: number } | null = null;
  const mountingDeadline = performance.now() + 4_000;
  while (performance.now() < mountingDeadline) {
    if (hydrationState() === "pending") {
      sawForwardMounting = true;
      forwardReadsWhileMounting = deepReads().length;
      deepScroller!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 240 }));
      // The second reach lands on the exact end too, with the reader's own
      // gesture: the rows it already loaded are still mounting, so the pane
      // reveals those batches and spends no further host read. The fragment is
      // read in the same task as the scroll, before any batch can grow the page
      // below it.
      deepScroller!.scrollTop = deepScroller!.scrollHeight - deepScroller!.clientHeight;
      deepScroller!.dispatchEvent(new Event("scroll", { bubbles: true }));
      const reached = readingLine(deepScroller!);
      forwardReachAnchor = reached ? { id: reached.id, offset: reached.offset } : null;
      batchAnchor = forwardReachAnchor;
      await frames(1);
      break;
    }
    await frames(1);
  }
  // The appended page finishes mounting on its own: this waits for the pane's
  // stated readiness, not for a second read.
  await awaitHydration("the appended page of the long chain", 15_000);
  forwardSettled = true;
  await sampleForwardPrompts;
  const forwardAfter = forwardAnchor ? fragmentOffset(deepScroller!, forwardAnchor.id) : null;
  const forwardReachAfter = forwardReachAnchor
    ? fragmentOffset(deepScroller!, forwardReachAnchor.id)
    : null;
  const forwardIds = transcriptIds();
  const forwardBatches = batchSamples.slice(forwardSamplesFrom);
  const forwardContiguous = deepRows().every((index, offset) => index === forwardStart + offset);
  failures.push(
    ...failuresOf([
      [
        forwardGesture.distanceFromBottom === 0,
        `the reach lands on the exact loaded bottom (${forwardGesture.distanceFromBottom}px from it)`,
      ],
      [
        jumpBeforeForward && jumpAtExactBottom,
        `the tail control stays available at the exact end before any latest read (${String(
          jumpBeforeForward,
        )}/${String(jumpAtExactBottom)})`,
      ],
      [
        deepReads().length === forwardReadsBefore + 1,
        `a later-boundary reach spends one scoped read (${deepReads().length - forwardReadsBefore})`,
      ],
      [forwardRead?.scope?.id === DEEP_DELEGATION, "the forward read echoes the delegation scope"],
      [
        forwardRead?.messageBefore === forwardEnd + SUBAGENT_HISTORY_PAGE_SIZE,
        `the forward read pages from the window's own end (${String(forwardRead?.messageBefore)})`,
      ],
      [
        forwardRead?.hydrationAtRequest === "ready",
        `the forward read waits for every loaded row (${forwardRead?.hydrationAtRequest})`,
      ],
      [
        deepEntry()?.messageEnd === forwardEnd + SUBAGENT_HISTORY_PAGE_SIZE,
        `the window gains one page below (${String(deepEntry()?.messageEnd)})`,
      ],
      [deepEntry()?.messageStart === forwardStart, "the reader's window head did not move"],
      [deepEntry()?.hasMoreAfter === true, "the window still states rows newer than it"],
      [
        // The retained interval, not the whole entry: a live row the page cannot
        // place is owned by the chain but is not part of this historical range.
        forwardIds.length ===
          (deepEntry()?.messageEnd ?? -1) - (deepEntry()?.messageStart ?? -1),
        `every row of the appended interval is mounted (${forwardIds.length}/${String(
          (deepEntry()?.messageEnd ?? -1) - (deepEntry()?.messageStart ?? -1),
        )})`,
      ],
      [forwardContiguous, "the appended page joins the window as one contiguous interval"],
      [
        forwardIdsBefore.every((id) => forwardIds.includes(id)),
        "no row the reader already had was dropped by the append",
      ],
      [
        forwardBatches.length > 0 &&
          forwardBatches.every((sample) => sample.added <= SUBAGENT_HYDRATION_STEP_ROWS),
        `no forward commit mounts more than one step (${forwardBatches.map((sample) => sample.added).join(",")})`,
      ],
      [
        forwardBatches.filter((sample) => sample.added > 0).length >= 2,
        `the appended page mounts in more than one commit (${forwardBatches.filter((sample) => sample.added > 0).length})`,
      ],
      [
        forwardBatches.some((sample) => sample.state === "pending"),
        "the pane states it is still preparing the appended page",
      ],
      [
        sawForwardMounting && forwardReadsWhileMounting === forwardReadsBefore + 1,
        `a boundary reach while the appended page mounts spends no further read (${String(forwardReadsWhileMounting)})`,
      ],
      [
        (() => {
          const anchor = forwardReachAnchor ?? forwardAnchor;
          const after = forwardReachAnchor ? forwardReachAfter : forwardAfter;
          return anchor !== null && after !== null && Math.abs(after - anchor.offset) < 2;
        })(),
        `the visible fragment keeps its offset across the append (${String(
          (forwardReachAnchor ?? forwardAnchor)?.id,
        )}: ${String((forwardReachAnchor ?? forwardAnchor)?.offset)} → ${String(
          forwardReachAnchor ? forwardReachAfter : forwardAfter,
        )})`,
      ],
      [
        forwardBatches.every((sample) => {
          if (sample.anchorId === null || sample.anchorOffset === null) return true;
          const expected =
            forwardReachAnchor && sample.anchorId === forwardReachAnchor.id
              ? forwardReachAnchor.offset
              : forwardAnchor && sample.anchorId === forwardAnchor.id
                ? forwardAnchor.offset
                : null;
          return expected !== null && Math.abs(sample.anchorOffset - expected) < 2;
        }),
        `every appended batch keeps the visible fragment on its offset (${forwardBatches
          .map((sample) => `${String(sample.anchorId)}=${String(sample.anchorOffset)}`)
          .join(", ")})`,
      ],
      [
        forwardPromptSamples.every((count) => count === 0) && promptIds().length === 0,
        `no Task prompt is drawn or flashed while the run's head is not retained (${forwardPromptSamples.join(",")})`,
      ],
      [jumpControl() !== null, "the historical window still offers the jump control"],
    ]),
  );
  facts.deepForward = {
    from: { start: forwardStart, end: forwardEnd },
    to: {
      start: deepEntry()?.messageStart,
      end: deepEntry()?.messageEnd,
      rows: forwardIds.length,
    },
    cursor: forwardRead?.messageBefore,
    gesture: forwardGesture,
    anchor: { id: forwardAnchor?.id, beforeOffset: forwardAnchor?.offset, afterOffset: forwardAfter },
    batches: forwardBatches,
    promptSamples: forwardPromptSamples,
    readsWhileMounting: forwardReadsWhileMounting,
    hasMore: [deepEntry()?.hasMoreBefore, deepEntry()?.hasMoreAfter],
  };
  console.log("SCOPED_DEEP_FORWARD " + JSON.stringify(facts.deepForward));

  // 9c. A native scrolling key at the later boundary is a reader's reach
  //     exactly as a wheel is: the forward boundary belongs to genuine input,
  //     not to one input kind.
  const keyInputAt = performance.now();
  const keySamplesFrom = batchSamples.length;
  const keyReadsBefore = deepReads().length;
  const keyStart = deepEntry()?.messageStart ?? -1;
  const keyEnd = deepEntry()?.messageEnd ?? -1;
  deepScroller!.focus();
  deepScroller!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  // The key is the intent and the position is the exact end of the loaded
  // window: a native key that scrolls to the bottom is a reader's reach there,
  // not the tail the pane has already reached. The fragment is read in the same
  // task as the scroll, before any batch can grow the page below it.
  deepScroller!.scrollTop = deepScroller!.scrollHeight - deepScroller!.clientHeight;
  const keyGesture = geometryOf(deepScroller!);
  const keyJumpAtExactBottom = jumpControl() !== null;
  deepScroller!.dispatchEvent(new Event("scroll", { bubbles: true }));
  const keyAnchor = readingLine(deepScroller!);
  batchAnchor = keyAnchor ? { id: keyAnchor.id, offset: keyAnchor.offset } : null;
  await until(() => deepReads().length === keyReadsBefore + 1, "the keyboard forward page read");
  // The page is loaded once its own answer applied, not when the request was
  // issued; the batches that draw it start after that.
  await until(
    () => deepEntry()?.messageEnd === keyEnd + SUBAGENT_HISTORY_PAGE_SIZE && deepEntry()?.refreshing !== true,
    "the keyboard page of the long chain",
    15_000,
  );
  await awaitHydration("the keyboard forward page");
  const keyAfter = keyAnchor ? fragmentOffset(deepScroller!, keyAnchor.id) : null;
  const keyBatches = batchSamples.slice(keySamplesFrom);
  failures.push(
    ...failuresOf([
      [
        keyGesture.distanceFromBottom === 0 && keyJumpAtExactBottom,
        `the key lands on the exact loaded bottom with the tail control present (${keyGesture.distanceFromBottom}px, jump ${String(
          keyJumpAtExactBottom,
        )})`,
      ],
      [
        deepReads().length === keyReadsBefore + 1,
        `a native scrolling key continues forward (${deepReads().length - keyReadsBefore} reads)`,
      ],
      [
        deepReads().at(-1)?.messageBefore === keyEnd + SUBAGENT_HISTORY_PAGE_SIZE,
        `the keyboard reach pages from the window's end (${String(deepReads().at(-1)?.messageBefore)})`,
      ],
      [
        deepEntry()?.messageEnd === keyEnd + SUBAGENT_HISTORY_PAGE_SIZE,
        "the keyboard reach appends the next page",
      ],
      [deepEntry()?.messageStart === keyStart, "the keyboard reach keeps the window head"],
      [
        keyAnchor !== null && keyAfter !== null && Math.abs(keyAfter - keyAnchor.offset) < 2,
        `the keyboard reach keeps the reader's fragment (${String(keyAnchor?.offset)} → ${String(keyAfter)})`,
      ],
      [
        keyBatches.every((sample) => sample.added <= SUBAGENT_HYDRATION_STEP_ROWS),
        "the keyboard page mounts in bounded batches",
      ],
      [promptIds().length === 0, "the keyboard page still draws no Task prompt"],
      [jumpControl() !== null, "the keyboard reach leaves the reader released"],
    ]),
  );
  facts.deepForwardKey = {
    cursor: deepReads().at(-1)?.messageBefore,
    window: { start: deepEntry()?.messageStart, end: deepEntry()?.messageEnd },
    anchor: { id: keyAnchor?.id, beforeOffset: keyAnchor?.offset, afterOffset: keyAfter },
    batches: keyBatches,
    reads: deepReads().length,
  };

  // 9d. A programmatic clamp at the same boundary is not a reach: geometry alone
  //     never continues forward, and it never takes the viewport back from a
  //     released reader. The check runs after the reader's own gesture has
  //     expired, which is what makes the write indistinguishable from a clamp.
  await until(
    () => performance.now() > keyInputAt + TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS + 60,
    "the reader's gesture to expire",
    2_000,
  );
  const clampReadsBefore = deepReads().length;
  const clampEnd = deepEntry()?.messageEnd ?? -1;
  deepScroller!.scrollTop = deepScroller!.scrollHeight - deepScroller!.clientHeight;
  deepScroller!.dispatchEvent(new Event("scroll", { bubbles: true }));
  await frames(3);
  failures.push(
    ...failuresOf([
      [
        deepReads().length === clampReadsBefore,
        `a programmatic clamp spends no forward read (${deepReads().length - clampReadsBefore})`,
      ],
      [deepEntry()?.messageEnd === clampEnd, "the programmatic clamp leaves the window unchanged"],
      [jumpControl() !== null, "a programmatic clamp never takes the viewport back"],
      [promptIds().length === 0, "the clamped window still draws no Task prompt"],
    ]),
  );
  facts.deepForwardClamp = {
    reads: deepReads().length,
    window: { start: deepEntry()?.messageStart, end: deepEntry()?.messageEnd },
    jump: jumpControl() !== null,
    scrollTop: deepScroller?.scrollTop,
    scrollHeight: deepScroller?.scrollHeight,
  };

  // The jump control reads the newest page and scrolls to what it selected.
  const beforeLatest = deepReads().length;
  jumpControl()?.click();
  await until(
    () => deepReads().length === beforeLatest + 1 && deepEntry()?.refreshing !== true,
    "the tail read behind the jump control",
  );
  await until(
    () => (deepScroller ? geometryOf(deepScroller).distanceFromBottom < 2 : false),
    "the jump back to the latest row",
  );
  await awaitHydration("the tail window behind the jump control");
  const jumped = deepScroller ? geometryOf(deepScroller) : null;
  failures.push(
    ...failuresOf([
      [deepReads().at(-1)?.messageBefore === undefined, "the jump reads the newest page, not a cursor"],
      [deepEntry()?.messageStart === DEEP_TAIL_START, `the jump selects the tail window (${deepEntry()?.messageStart})`],
      [deepEntry()?.messageEnd === DEEP_TOTAL, "the tail window ends at the chain's tail"],
      [deepEntry()?.hasMoreAfter === false, "the tail window follows"],
      [
        same(deepRowIds().slice(0, SUBAGENT_HISTORY_PAGE_SIZE), Array.from({ length: SUBAGENT_HISTORY_PAGE_SIZE }, (_, offset) => deepRowId(DEEP_TAIL_START + offset))),
        `the jump draws the tail interval (${deepRowIds().slice(0, 3).join(",")}…)`,
      ],
      [
        assistantIds().filter((id) => id === liveDeep).length === 1,
        "the live row joins once, at the tail",
      ],
      [jumped !== null && jumped.distanceFromBottom < 2, `the jump re-bottoms the pane (${String(jumped?.distanceFromBottom)})`],
    ]),
  );
  facts.deepLatest = {
    messageStart: deepEntry()?.messageStart,
    rows: deepRowIds().length,
    live: assistantIds().filter((id) => id === liveDeep).length,
    jumped,
    reads: deepReads().length,
  };

  // 10. Jumping to latest while a boundary read is still in flight: the explicit
  //     jump supersedes that read instead of being answered by it. The pane must
  //     end on the fresh tail window, and the late older answer must not move it.
  const refocusTarget = deepRowId(DEEP_FOCUS_TARGET);
  const beforeRefocus = deepReads().length;
  void store().ensureSubagentHistory({
    sessionId: SESSION,
    tabKey: DEEP_DELEGATION,
    messageId: refocusTarget,
    query: "",
    requestId: 12,
  });
  await until(
    () => deepReads().length === beforeRefocus + 1 && deepEntry()?.refreshing !== true,
    "the re-focused target page",
  );
  await awaitHydration("the re-focused target page");
  failures.push(
    ...failuresOf([
      [
        deepEntry()?.messageStart === deepFocusStart,
        `the historical window is the target's page again (${deepEntry()?.messageStart})`,
      ],
      [jumpControl() !== null, "the historical window offers the jump control"],
    ]),
  );

  holdOlderReads(DEEP_DELEGATION);
  const beforeHeld = deepReads().length;
  await reachTop();
  await until(() => deepReads().length === beforeHeld + 1, "the held older read");
  await frames(2);
  const heldLoading = document.querySelector<HTMLElement>('[data-testid="subagent-history-older-loading"]');
  const heldLoadingLabel = heldLoading?.querySelector<HTMLElement>(".subagent-transcript-earlier-label");
  const heldLoadingHeight = heldLoading?.getBoundingClientRect().height ?? 0;
  const heldAnchor = deepScroller ? readingLine(deepScroller) : null;
  await frames(3);
  const heldAnchorAfter = deepScroller && heldAnchor
    ? fragmentOffset(deepScroller, heldAnchor.id)
    : null;
  facts.deepHeldLoading = {
    present: heldLoading !== null,
    height: heldLoadingHeight,
    settledHeight: heldLoading?.getBoundingClientRect().height ?? 0,
    ariaHidden: heldLoading?.getAttribute("aria-hidden"),
    labelVisibility: heldLoadingLabel ? getComputedStyle(heldLoadingLabel).visibility : null,
    overflowAnchor: heldLoading ? getComputedStyle(heldLoading).overflowAnchor : null,
    anchor: heldAnchor,
    anchorAfter: heldAnchorAfter,
  };
  failures.push(
    ...failuresOf([
      [heldLoading !== null && heldLoadingHeight > 0, "held older reads keep fixed loading furniture mounted"],
      [heldLoading?.getAttribute("aria-hidden") === "false", "held older reads expose the loading status"],
      [heldLoadingLabel ? getComputedStyle(heldLoadingLabel).visibility === "visible" : false, "held older reads show the loading label"],
      [heldLoading ? getComputedStyle(heldLoading).overflowAnchor === "none" : false, "loading furniture is excluded from native anchoring"],
      [heldLoading !== null && heldLoading.isConnected && Math.abs(heldLoading.getBoundingClientRect().height - heldLoadingHeight) < 0.5, "loading furniture keeps its box while the read is held"],
      [heldAnchorAfter !== null && Math.abs(heldAnchorAfter - (heldAnchor?.offset ?? 0)) < 2, "showing loading furniture does not move the held fragment"],
    ]),
  );
  failures.push(
    ...failuresOf([
      [
        deepReads().at(-1)?.messageBefore === deepFocusStart,
        `the held older read pages from the window's own cursor (${deepReads().at(-1)?.messageBefore})`,
      ],
      [
        deepEntry()?.messageStart === deepFocusStart,
        "the held read has not answered, so the window has not moved",
      ],
    ]),
  );
  jumpControl()?.click();
  await until(() => deepReads().length === beforeHeld + 2, "the superseding tail read");
  await until(
    () => (deepScroller ? geometryOf(deepScroller).distanceFromBottom < 2 : false),
    "the jump after a superseded read",
  );
  await awaitHydration("the superseded tail page");
  const superseded = deepScroller ? geometryOf(deepScroller) : null;
  failures.push(
    ...failuresOf([
      [
        deepReads().at(-1)?.messageBefore === undefined,
        "the jump reads the newest page while the older read is outstanding",
      ],
      [
        deepEntry()?.messageStart === DEEP_TAIL_START,
        `the superseded jump selects the tail window (${deepEntry()?.messageStart})`,
      ],
      [deepEntry()?.messageEnd === DEEP_TOTAL, "the tail window ends at the chain's tail"],
      [deepEntry()?.hasMoreAfter === false, "the tail window follows"],
      [
        deepEntry()?.messages.filter((row) => row.id !== liveDeep).length ===
          SUBAGENT_HISTORY_PAGE_SIZE,
        `the tail window replaced the historical page (${deepEntry()?.messages.length})`,
      ],
      [
        superseded !== null && superseded.distanceFromBottom < 2,
        `the pane re-bottoms on the fresh tail (${String(superseded?.distanceFromBottom)})`,
      ],
    ]),
  );

  // The superseded answer lands now: it cannot move the window or the pane.
  releaseOlderReads();
  await frames(4);
  await awaitHydration("the released tail page");
  const released = deepScroller ? geometryOf(deepScroller) : null;
  failures.push(
    ...failuresOf([
      [
        deepEntry()?.messageStart === DEEP_TAIL_START,
        `the late older answer is dropped (${deepEntry()?.messageStart})`,
      ],
      [deepEntry()?.hasMoreAfter === false, "the tail window still follows"],
      [
        released !== null && released.distanceFromBottom < 2,
        `the pane stays on the tail (${String(released?.distanceFromBottom)})`,
      ],
    ]),
  );
  facts.deepSupersededLatest = {
    messageStart: deepEntry()?.messageStart,
    rows: deepEntry()?.messages.length,
    reads: deepReads().length,
    superseded,
    released,
  };

  // Finish at the physical head so the tall Task brief itself, not a child
  // answer, is the only visible anchor. This is the brief-only paging case:
  // every page before the head stays prompt-free, the head page introduces the
  // prompt exactly once at its chronological opening, and the reading anchor it
  // was measured against keeps its viewport offset.
  const headTrace: Array<Record<string, unknown>> = [];
  for (let step = 0; step < DEEP_TOTAL / SUBAGENT_HISTORY_PAGE_SIZE - 1; step += 1) {
    const before = deepReads().length;
    const samplesFrom = batchSamples.length;
    const anchored = await reachTop();
    await until(
      () => deepReads().length === before + 1 && deepEntry()?.status === "ready",
      `head-boundary older page ${step + 1}`,
    );
    const readAtHead = performance.now();
    await awaitHydration(`head-boundary older page ${step + 1}`);
    const hydratedAtHead = performance.now();
    const pageBatches = batchSamples.slice(samplesFrom);
    const after = deepScroller && anchored ? fragmentOffset(deepScroller, anchored.id) : null;
    headTrace.push({
      page: step + 1,
      cursor: deepReads().at(-1)?.messageBefore,
      messageStart: deepEntry()?.messageStart,
      promptRows: promptIds().length,
      ids: transcriptIds().slice(0, 3),
      anchor: { id: anchored?.id ?? null, beforeOffset: anchored?.offset ?? null, afterOffset: after },
      batches: pageBatches,
      readMs: Math.round(readAtHead - probeStartedAt),
      hydratedMs: Math.round(hydratedAtHead - probeStartedAt),
    });
    failures.push(
      ...failuresOf([
        [
          anchored !== null && after !== null && Math.abs(after - anchored.offset) < 2,
          `the head-boundary anchor keeps its offset at page ${step + 1} (${anchored?.id}: ${String(
            anchored?.offset,
          )} → ${String(after)})`,
        ],
        [
          pageBatches.every(
            (sample) =>
              sample.anchorOffset !== null &&
              Math.abs(sample.anchorOffset - anchored.offset) < 2,
          ),
          `every batch of head page ${step + 1} keeps the held fragment on its offset`,
        ],
        [
          deepReads().at(-1)?.hydrationAtRequest === "ready",
          `head page ${step + 1} was read only after the loaded rows were mounted`,
        ],
        [
          anchored !== null,
          `head page ${step + 1} was measured against a real fragment`,
        ],
        [
          promptIds().length === (deepEntry()?.messageStart === 0 ? 1 : 0),
          `the prompt appears only on the page that reaches the run head (page ${step + 1})`,
        ],
      ]),
    );
  }
  const headBriefNode = userPromptRows()[0] ?? null;
  // A further reach at the head reads nothing and must not rerender the prompt
  // away or duplicate it.
  const headNodeBefore = headBriefNode;
  const readsAtHead = deepReads().length;
  await reachTop();
  await frames(3);
  const headNodeAfter = userPromptRows()[0] ?? null;
  deepScroller!.scrollTop = 0;
  await frames(3);
  const headAnchor = readingLine(deepScroller!);
  const headBrief = headBriefNode?.getBoundingClientRect();
  facts.deepHeadAnchor = {
    anchor: headAnchor,
    briefHeight: headBrief?.height ?? null,
    viewportHeight: deepScroller!.clientHeight,
    ids: transcriptIds().slice(0, 3),
    headTrace,
    stableBriefDom: headNodeAfter === headNodeBefore,
    readsAtHead,
  };
  failures.push(
    ...failuresOf([
      [headAnchor?.id === "deep-task-row", "the tall Task brief is anchorable at the physical head"],
      [headNodeBefore !== null && headNodeAfter === headNodeBefore, "the brief DOM stays mounted once the head is reached"],
      [deepEntry()?.messageStart === 0, "the final older cursor reaches the physical head"],
      [
        headTrace.filter((page) => Number(page.promptRows) > 0).length === 1 &&
          Number(headTrace.at(-1)?.promptRows) === 1,
        "the prompt is introduced once, on the last page",
      ],
      [
        userPromptRows().length === 1 && promptIds()[0] === "deep-task-row",
        "the head draws exactly one identified prompt",
      ],
      [deepRows().slice(0, DEEP_TOTAL).every((index, offset) => index === offset), "all older children retain true transcript order"],
    ]),
  );
  console.log("SCOPED_DEEP_TRACE " + JSON.stringify({ trace: deepPagingTrace, head: facts.deepHeadAnchor, window: facts.deepWindow }));

  // 11. A live child can arrive while the requested older page is still in
  //     flight. That live growth is not the page commit: the loading hold and
  //     the reading-line correction must wait for the older read to finish.
  flushSync(() => {
    root?.unmount();
    root = null;
  });
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: SESSION,
      messages: [
        anchorTaskRecord(),
        message("anchor-parent-main", "user", "ordinary top-level main row"),
      ],
    } as never);
  });
  mountTab(ANCHOR_DELEGATION);
  const anchorEntry = () => entry(SESSION, ANCHOR_DELEGATION);
  const anchorReads = () => scopedReads().filter((read) => read.scope?.id === ANCHOR_DELEGATION);
  const anchorChildIds = () =>
    transcriptIds().filter((id) => id.startsWith("child-anchor-"));
  await until(
    () => anchorReads().length === 1 && anchorEntry()?.status === "ready",
    "the anchor chain's first page",
  );
  await frames(3);
  await awaitHydration("the anchor chain's first page");
  let anchorScroller = scroller();
  if (!anchorScroller) throw new Error("anchor transcript scroller missing");
  failures.push(
    ...failuresOf([
      [anchorEntry()?.messageStart === 30, "the anchor fixture opens on its bounded tail page"],
      [
        same(anchorChildIds(), Array.from({ length: 20 }, (_, offset) => anchorRowId(30 + offset))),
        "the anchor fixture's initial children render in order",
      ],
      [
        promptIds().length === 0 && transcriptIds().filter((id) => id === ANCHOR_TASK_ID).length === 0,
        "a bounded tail page inside the run draws no Task prompt",
      ],
      [
        document.body.textContent?.includes("ordinary top-level main row") === false,
        "ordinary main rows stay outside the anchor chain",
      ],
    ]),
  );

  holdOlderReads(ANCHOR_DELEGATION);
  const beforeHeldAnchorRead = anchorReads().length;
  await reachTop();
  await until(
    () => anchorReads().length === beforeHeldAnchorRead + 1,
    "the held anchor older read",
  );
  await frames(2);
  const heldAnchorBoundary = readingLine(anchorScroller);
  const heldAnchorOffset = heldAnchorBoundary
    ? fragmentOffset(anchorScroller, heldAnchorBoundary.id)
    : null;
  const heldLoadingBeforeLive = document.querySelector<HTMLElement>(
    '[data-testid="subagent-history-older-loading"]',
  );
  const rowsBeforeLive = anchorEntry()?.messages.length ?? 0;
  const liveAnchor = "child-anchor-live";
  flushSync(() => {
    useAppStore.setState({
      messages: [
        anchorTaskRecord(),
        message("anchor-parent-main", "user", "ordinary top-level main row"),
        message(liveAnchor, "assistant", "live anchor child", {
          parentToolCallId: ANCHOR_CALL,
          agentName: "explorer",
        }),
      ],
    } as never);
  });
  await frames(4);
  const liveWhilePending = {
    loadingBeforeLive: heldLoadingBeforeLive?.getAttribute("aria-hidden"),
    refreshing: anchorEntry()?.refreshing,
    rows: anchorEntry()?.messages.length,
    rowsBeforeLive,
    liveRendered: transcriptIds().filter((id) => id === liveAnchor).length,
    loading: document
      .querySelector<HTMLElement>('[data-testid="subagent-history-older-loading"]')
      ?.getAttribute("aria-hidden"),
    anchor: readingLine(anchorScroller),
    offset: heldAnchorBoundary
      ? fragmentOffset(anchorScroller, heldAnchorBoundary.id)
      : null,
    boundary: heldAnchorBoundary,
    boundaryOffset: heldAnchorOffset,
  };
  failures.push(
    ...failuresOf([
      [liveWhilePending.refreshing === true, "a live child preserves the pending older read state"],
      [
        (liveWhilePending.rows ?? 0) > rowsBeforeLive && liveWhilePending.liveRendered === 1,
        "the live child joins the chain while the older read is pending",
      ],
      [
        liveWhilePending.loading === "false",
        "live growth does not clear the older-page loading state early",
      ],
      [
        liveWhilePending.boundary !== null &&
          liveWhilePending.anchor?.id === liveWhilePending.boundary.id &&
          liveWhilePending.offset !== null &&
          Math.abs(liveWhilePending.offset - (heldAnchorOffset ?? 0)) < 2,
        "live growth alone leaves the held visible anchor and offset unchanged",
      ],
    ]),
  );

  releaseOlderReads();
  await until(
    () =>
      anchorEntry()?.refreshing === false &&
      anchorEntry()?.messageStart === 20 &&
      (anchorEntry()?.messages.length ?? 0) >= rowsBeforeLive + 10,
    "the released anchor older page",
  );
  await frames(4);
  await awaitHydration("the released anchor older page");
  const settledAfterLive = {
    anchor: readingLine(anchorScroller),
    offset: heldAnchorBoundary
      ? fragmentOffset(anchorScroller, heldAnchorBoundary.id)
      : null,
    boundary: heldAnchorBoundary,
    boundaryOffset: heldAnchorOffset,
    loading: document
      .querySelector<HTMLElement>('[data-testid="subagent-history-older-loading"]')
      ?.getAttribute("aria-hidden"),
  };
  failures.push(
    ...failuresOf([
      [
        settledAfterLive.boundary !== null &&
          settledAfterLive.anchor?.id === settledAfterLive.boundary.id &&
          settledAfterLive.offset !== null &&
          Math.abs(settledAfterLive.offset - (heldAnchorOffset ?? 0)) < 2,
        "the released older page restores the same visible anchor and offset after live growth",
      ],
      [
        settledAfterLive.loading === "true",
        "the older-page loading state settles only after the page lands",
      ],
      [anchorReads().at(-1)?.messageBefore === 30, "the delayed read keeps its requested cursor"],
    ]),
  );
  facts.anchorDelayedRead = { liveWhilePending, settledAfterLive };

  let checkpoint = list()?.querySelector<HTMLElement>(
    `[data-message-id="${ANCHOR_HANDOFF_ID}"]`,
  ) ?? null;
  const checkpointTrace: Array<Record<string, unknown>> = [];
  facts.anchorCheckpointPosition = {
    ids: transcriptIds().slice(0, 32),
    checkpoint: transcriptIds().indexOf(ANCHOR_HANDOFF_ID),
    rowBefore: transcriptIds().indexOf(anchorRowId(ANCHOR_CHECKPOINT_ROW - 1)),
    rowAfter: transcriptIds().indexOf(anchorRowId(ANCHOR_CHECKPOINT_ROW + 1)),
  };
  failures.push(
    ...failuresOf([
      [
        checkpoint?.classList.contains("transcript-handoff-row") === true,
        "the accepted checkpoint exposes its stable source message id",
      ],
      [
        transcriptIds().indexOf(ANCHOR_HANDOFF_ID) ===
          transcriptIds().indexOf(anchorRowId(ANCHOR_CHECKPOINT_ROW - 1)) + 1,
        "the checkpoint keeps its physical position between its neighbouring children",
      ],
    ]),
  );

  const placeCheckpoint = () => {
    if (!checkpoint) return;
    checkpoint.scrollIntoView({ block: "start" });
    const line = Math.min(120, anchorScroller.clientHeight / 4);
    const height = checkpoint.getBoundingClientRect().height;
    anchorScroller.scrollTop -= Math.max(0, line - height + 12);
  };
  const keepCheckpointThroughPage = async (expanded: boolean, step: number) => {
    if (!checkpoint) return;
    placeCheckpoint();
    await frames(3);
    const before = readingLine(anchorScroller);
    const beforeOffset = before ? fragmentOffset(anchorScroller, before.id) : null;
    const head = checkpoint.querySelector<HTMLButtonElement>(".transcript-handoff-head");
    const isExpanded = head?.getAttribute("aria-expanded") === "true";
    if (isExpanded !== expanded) head?.click();
    await frames(3);
    placeCheckpoint();
    await frames(3);
    const beforeRead = anchorReads().length;
    holdOlderReads(ANCHOR_DELEGATION);
    await reachTop(110);
    await until(
      () => anchorReads().length === beforeRead + 1,
      `the ${expanded ? "expanded" : "collapsed"} checkpoint older read`,
    );
    await frames(2);
    const boundary = readingLine(anchorScroller);
    const boundaryOffset = boundary ? fragmentOffset(anchorScroller, boundary.id) : null;
    const loadingHeld = document
      .querySelector<HTMLElement>('[data-testid="subagent-history-older-loading"]')
      ?.getAttribute("aria-hidden");
    const reads = anchorReads().map((read) => read.messageBefore ?? "latest");
    releaseOlderReads();
    await until(
      () => anchorEntry()?.refreshing === false && anchorReads().length === beforeRead + 1,
      `the ${expanded ? "expanded" : "collapsed"} checkpoint page settlement`,
    );
    await frames(4);
    await awaitHydration(`the ${expanded ? "expanded" : "collapsed"} checkpoint page`);
    const after = readingLine(anchorScroller);
    const afterOffset = after ? fragmentOffset(anchorScroller, after.id) : null;
    const currentNode = list()?.querySelector<HTMLElement>(
      `[data-message-id="${ANCHOR_HANDOFF_ID}"]`,
    ) ?? null;
    const currentHead = currentNode?.querySelector<HTMLButtonElement>(".transcript-handoff-head");
    checkpointTrace.push({
      step,
      expanded,
      before,
      beforeOffset,
      boundary,
      boundaryOffset,
      after,
      afterOffset,
      loadingHeld,
      settledLoading: document
        .querySelector<HTMLElement>('[data-testid="subagent-history-older-loading"]')
        ?.getAttribute("aria-hidden"),
      sameDom: currentNode === checkpoint,
      currentExpanded: currentHead?.getAttribute("aria-expanded") === "true",
      bodyText: currentNode?.querySelector(".transcript-handoff-body")?.textContent ?? "",
      cursor: anchorReads().at(-1)?.messageBefore,
      reads,
    });
    failures.push(
      ...failuresOf([
        [
          before?.id === ANCHOR_HANDOFF_ID,
          `the ${expanded ? "expanded" : "collapsed"} checkpoint is the fragment at the reading line before paging`,
        ],
        [
          boundary !== null && after !== null && boundary.id === after.id,
          `the ${expanded ? "expanded" : "collapsed"} reach keeps the same visible fragment`,
        ],
        [
          boundaryOffset !== null &&
            afterOffset !== null &&
            Math.abs(afterOffset - boundaryOffset) < 2,
          `the ${expanded ? "expanded" : "collapsed"} checkpoint keeps its viewport offset`,
        ],
        [currentNode === checkpoint, `the ${expanded ? "expanded" : "collapsed"} checkpoint DOM stays mounted`],
        [
          (currentHead?.getAttribute("aria-expanded") === "true") === expanded,
          `the ${expanded ? "expanded" : "collapsed"} checkpoint keeps its disclosure state`,
        ],
        [loadingHeld === "false", "checkpoint paging exposes loading while its read is held"],
        [
          promptIds().length === (anchorEntry()?.messageStart === 0 ? 1 : 0) &&
            (promptIds().length === 0 || promptIds()[0] === ANCHOR_TASK_ID),
          "the prompt is drawn only once the retained window reaches the run head",
        ],
        [
          document
            .querySelector<HTMLElement>('[data-testid="subagent-history-older-loading"]')
            ?.getAttribute("aria-hidden") === "true",
          "checkpoint paging hides loading after settlement",
        ],
      ]),
    );
  };
  await keepCheckpointThroughPage(false, 1);
  // Give the expanded state its own anchored window: the same chain is
  // reopened and paged once so the checkpoint again sits near the top band.
  flushSync(() => {
    root?.unmount();
    root = null;
  });
  flushSync(() => {
    const bucket = { ...(store().subagentHistory[SESSION] ?? {}) };
    delete bucket[ANCHOR_DELEGATION];
    useAppStore.setState({
      activeSessionId: SESSION,
      messages: [
        anchorTaskRecord(),
        message("anchor-parent-main", "user", "ordinary top-level main row"),
        message(liveAnchor, "assistant", "live anchor child", {
          parentToolCallId: ANCHOR_CALL,
          agentName: "explorer",
        }),
      ],
      subagentHistory: { [SESSION]: bucket },
    } as never);
  });
  mountTab(ANCHOR_DELEGATION);
  anchorScroller = scroller();
  await until(
    () => anchorEntry()?.status === "ready" && anchorEntry()?.messageStart === 30,
    "the anchor chain's reopened tail page",
  );
  await frames(3);
  await awaitHydration("the anchor chain's reopened tail page");
  const beforeReanchorRead = anchorReads().length;
  await reachTop();
  await until(
    () => anchorReads().length === beforeReanchorRead + 1 && anchorEntry()?.messageStart === 20,
    "the anchor chain's reanchored page",
  );
  await frames(3);
  await awaitHydration("the anchor chain's reanchored page");
  checkpoint = list()?.querySelector<HTMLElement>(
    `[data-message-id="${ANCHOR_HANDOFF_ID}"]`,
  ) ?? null;
  await keepCheckpointThroughPage(true, 2);
  const headBoundary = readingLine(anchorScroller);
  const headBoundaryOffset = headBoundary
    ? fragmentOffset(anchorScroller, headBoundary.id)
    : null;
  const promptRowsBeforeHead = promptIds().length;
  const messageStartBeforeHead = anchorEntry()?.messageStart;
  for (let attempt = 0; attempt < 3 && anchorEntry()?.messageStart !== 0; attempt += 1) {
    const beforeRead = anchorReads().length;
    await reachTop();
    try {
      await until(
        () => anchorReads().length >= beforeRead + 1 && anchorEntry()?.messageStart === 0,
        "the checkpoint chain's final head page",
        10_000,
      );
    } catch {
      // The reach may land a frame late; the loop retries, the assertions below
      // still state the final truth.
    }
  }
  await until(
    () => anchorEntry()?.messageStart === 0,
    "the checkpoint chain's head window",
    30_000,
  );
  await frames(4);
  await awaitHydration("the checkpoint chain's head window");
  const headSettled = readingLine(anchorScroller);
  const headSettledOffset = headSettled
    ? fragmentOffset(anchorScroller, headSettled.id)
    : null;
  failures.push(
    ...failuresOf([
      [
        promptRowsBeforeHead === (messageStartBeforeHead === 0 ? 1 : 0),
        `the prompt is drawn exactly when the window reaches the run head (${messageStartBeforeHead})`,
      ],
      [
        same(promptIds(), [ANCHOR_TASK_ID]) && userPromptRows().length === 1,
        `the head page introduces the Task prompt once (${promptIds().join(",")})`,
      ],
      [
        headBoundary !== null &&
          headSettled !== null &&
          headSettled.id === headBoundary.id &&
          headSettledOffset !== null &&
          headBoundaryOffset !== null &&
          Math.abs(headSettledOffset - headBoundaryOffset) < 2,
        `the visible anchor survives the prompt's introduction (${headBoundary?.id}: ${String(
          headBoundaryOffset,
        )} → ${String(headSettledOffset)})`,
      ],
      [
        document
          .querySelector<HTMLElement>('[data-testid="subagent-history-older-loading"]')
          ?.getAttribute("aria-hidden") === "true",
        "the head page settles its loading furniture",
      ],
    ]),
  );
  facts.anchorCheckpointTrace = checkpointTrace;
  const finalAnchorIds = transcriptIds();
  const expectedAnchorIds = [
    ANCHOR_TASK_ID,
    ...Array.from({ length: ANCHOR_CHECKPOINT_ROW }, (_, index) => anchorRowId(index)),
    ANCHOR_HANDOFF_ID,
    ...Array.from(
      { length: ANCHOR_TOTAL - ANCHOR_CHECKPOINT_ROW - 1 },
      (_, index) => anchorRowId(index + ANCHOR_CHECKPOINT_ROW + 1),
    ),
    liveAnchor,
  ];
  failures.push(
    ...failuresOf([
      [same(finalAnchorIds, expectedAnchorIds), "brief, children, checkpoint, and live row keep true transcript order"],
      [finalAnchorIds.filter((id) => id === ANCHOR_TASK_ID).length === 1, "the anchor Task brief appears once after three prepends"],
      [finalAnchorIds.includes("anchor-parent-main") === false, "the anchor scope never admits an ordinary main row"],
      [anchorEntry()?.messageStart === 0, "the checkpoint pages reach the physical head"],
      [checkpointTrace.length === 2 || checkpoint === null, "collapsed and expanded checkpoint anchors both exercised"],
    ]),
  );
  console.log(
    "SCOPED_ANCHOR_TRACE " +
      JSON.stringify({ delayed: facts.anchorDelayedRead, checkpoints: checkpointTrace, ids: finalAnchorIds }),
  );

  facts.channels = channels.length;
  facts.scopedReads = scopedReads();
  facts.finalRows = assistantIds();
  // Every commit the pane spends, measured against the pane's own reported
  // mounted count. A batch grows the run by at most one configured batch, and
  // there is no exempt path: the head entry, a wheel boundary reach, a distant
  // focus read, and a latest read all travel through the same batches. A window
  // replacement removes rows first, so its commit is counted separately - its
  // first mount is still the bounded first run.
  const mountCommits = batchSamples.map((sample, index) => ({
    index,
    rows: sample.rows,
    added: sample.added,
    removed: sample.removed,
    mounted: sample.mounted,
    loaded: sample.loaded,
    state: sample.state,
    growth: sample.mounted - (index === 0 ? 0 : batchSamples[index - 1].mounted),
  }));
  // A window start is a commit that restarts the mounted run at the bounded
  // first run: the first commit of a list, and any replacement (a latest or
  // focus read, a chain change) - a replacement unmounts the old rows first.
  const windowStarts = mountCommits.filter(
    (commit) =>
      commit.index === 0 ||
      (commit.removed > 0 && commit.mounted <= SUBAGENT_HYDRATION_FIRST_ROWS),
  );
  // A commit that removes a live tail row and keeps the reader's run is not a
  // window replacement: the durable page simply does not name the row the live
  // page did. It is reported separately instead of being counted as a restart.
  const retainedDrops = mountCommits.filter(
    (commit) => commit.index > 0 && commit.removed > 0 && commit.mounted > SUBAGENT_HYDRATION_FIRST_ROWS,
  );
  const batchedCommits = mountCommits.filter((commit) => !windowStarts.includes(commit));
  const maxBatchGrowth = batchedCommits.reduce((max, commit) => Math.max(max, commit.growth), 0);
  const growthOverStep = batchedCommits.filter((commit) => commit.growth > SUBAGENT_HYDRATION_STEP_ROWS);
  const oversizedWindowStarts = windowStarts.filter(
    (commit) => commit.mounted > SUBAGENT_HYDRATION_FIRST_ROWS,
  );
  const largestCommit = mountCommits.reduce((max, commit) => Math.max(max, commit.added), 0);
  facts.progressiveMount = {
    commits: mountCommits.length,
    windowStarts: windowStarts.length,
    windowStartMounts: windowStarts.map((commit) => commit.mounted),
    replacementCommits: mountCommits.filter((commit) => commit.removed > 0).length,
    retainedDrops: retainedDrops.length,
    retainedDropRuns: retainedDrops.map((commit) => `${commit.mounted}/${commit.loaded}@${commit.index}`),
    maxBatchGrowth,
    growthOverStep: growthOverStep.length,
    oversizedWindowStarts: oversizedWindowStarts.length,
    largestCommit,
  };
  failures.push(
    ...failuresOf([
      [
        oversizedWindowStarts.length === 0,
        `every window restarts bounded (${windowStarts
          .map((commit) => commit.mounted)
          .join(",")})`,
      ],
      [
        growthOverStep.length === 0,
        `no commit grows the mounted run by more than one batch (${growthOverStep
          .map((commit) => `${commit.mounted}@${commit.index}`)
          .join(",")} of ${maxBatchGrowth})`,
      ],
      [
        largestCommit <= SUBAGENT_HYDRATION_STEP_ROWS,
        `no commit adds more than one batch of rows to the DOM (${largestCommit})`,
      ],
      [
        // A window whose page is shorter than the first run is mounted whole
        // (a pane can mount with a row it already had cached), so the bound is
        // "never more than the first run", and at least one window proves the
        // configured first run is what a page actually starts with.
        windowStarts.every(
          (commit) => commit.mounted <= Math.min(commit.loaded, SUBAGENT_HYDRATION_FIRST_ROWS),
        ) &&
          windowStarts.some(
            (commit) =>
              commit.loaded >= SUBAGENT_HYDRATION_FIRST_ROWS &&
              commit.mounted === SUBAGENT_HYDRATION_FIRST_ROWS,
          ),
        `every window opens with the bounded first run (${windowStarts
          .map((commit) => `${commit.mounted}/${commit.loaded}`)
          .join(",")})`,
      ],
    ]),
  );
  console.log("SCOPED_HYDRATION_TRACE " + JSON.stringify(facts.progressiveMount));

  return { ok: failures.length === 0, failures, facts };
};
