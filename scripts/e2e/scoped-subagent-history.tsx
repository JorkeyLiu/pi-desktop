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
  SUBAGENT_HISTORY_MESSAGE_LIMIT,
  SUBAGENT_HISTORY_PAGE_SIZE,
} from "../../apps/desktop/src/lib/subagent-history";

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
const OLDER_PAGE = ["child-20", "child-21"];
const FIRST_PAGE = ["child-30", "child-31", "child-32", "child-33"];
const LIVE_ROW = "live-41";
// A long chain whose physical selection is contiguous, so a full reading
// window can be filled with ordinary 100-row pages.
const DEEP_DELEGATION = "d-deep";
const DEEP_CALL = "call-deep";
const DEEP_TOTAL = 1000;
const deepRowId = (index: number) => `child-deep-${index}`;
// A chain the parent opened from a `Task` card while its durable row is still
// in the persistence outbox: the scoped read cannot resolve it yet.
const FRESH_DELEGATION = "d-fresh";
const FRESH_CALL = "call-fresh";
const FRESH_PAGE = ["child-50", "child-51"];
const FRESH_LIVE = "live-52";
let freshDurable = false;

type ReadRecord = {
  id: string;
  scope: { kind?: unknown; id?: unknown } | undefined;
  messageBefore: number | undefined;
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
    toolArgs: { agent: "explorer", description: "Long chain", task: "Read the long chain." },
    toolResult: { details: { delegationId: DEEP_DELEGATION, agent: "explorer", status: "completed" } },
  });
}

function deepChildRow(index: number): UiMessage {
  return message(deepRowId(index), "assistant", `deep chain row ${index}`, {
    parentToolCallId: DEEP_CALL,
    agentName: "explorer",
  });
}

/**
 * One page of the long chain: `messageBefore` is the physical exclusive cursor
 * of a contiguous selection, exactly how the host pages a scoped range.
 */
function deepDetail(sessionId: string, messageBefore: number | undefined): SessionDetail {
  const end = messageBefore === undefined ? DEEP_TOTAL : Math.max(0, Math.min(messageBefore, DEEP_TOTAL));
  const start = Math.max(0, end - SUBAGENT_HISTORY_PAGE_SIZE);
  return {
    id: sessionId,
    title: "Scoped history fixture",
    source: "local",
    mode: "agent",
    createdAt,
    updatedAt: createdAt,
    historyScope: { kind: "delegation", id: DEEP_DELEGATION },
    messages: Array.from({ length: end - start }, (_, offset) => deepChildRow(start + offset)),
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
      historyContext: [freshTaskRecord(true)],
      messageStart: 50,
      messageEnd: 51,
      messageCount: 3,
      hasMoreBefore: false,
    } as unknown as SessionDetail;
  }
  if (sessionId === SESSION && scopeId === DEEP_DELEGATION) {
    return deepDetail(sessionId, messageBefore);
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
    return {
      ...base,
      messages: OLDER_PAGE.map((id) => childRow(id, `scoped older row ${id}`)),
      historyContext: [taskRecord()],
      messageStart: 20,
      messageEnd: 21,
      messageCount: 3614,
      hasMoreBefore: false,
    } as unknown as SessionDetail;
  }
  return {
    ...base,
    messages: FIRST_PAGE.map((id) => childRow(id, `scoped page row ${id}`)),
    historyContext: [taskRecord()],
    messageStart: 30,
    messageEnd: 33,
    // The physical transcript behind this page holds every top-level row plus
    // thousands of delegate child rows; none of them are in this answer.
    messageCount: 3614,
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
      messageLimit?: number;
      contentLimit?: number;
    };
    const id = request.id ?? "";
    reads.push({
      id,
      scope: request.historyScope,
      messageBefore: request.messageBefore,
      messageLimit: request.messageLimit,
      contentLimit: request.contentLimit,
    });
    return {
      ok: true,
      data: { session: delegationDetail(id, request.messageBefore, request.historyScope?.id) },
    };
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
const assistantIds = () =>
  Array.from(list()?.querySelectorAll<HTMLElement>(".message-row.assistant[data-message-id]") ?? [])
    .map((row) => row.dataset.messageId ?? "")
    .filter(Boolean);
const assistantText = (id: string) => {
  const row = list()?.querySelector<HTMLElement>(
    `.message-row.assistant[data-message-id="${id}"]`,
  );
  return row?.textContent ?? "";
};
const emptyState = () => document.querySelector<HTMLElement>('[data-testid="subagent-history-empty"]');
const errorState = () => document.querySelector<HTMLElement>('[data-testid="subagent-history-error"]');
const showingEarlier = () =>
  document.querySelector<HTMLElement>(".subagent-transcript-earlier .link-btn");
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
  await frames(3);
  const failures: string[] = [];
  const facts: Record<string, unknown> = {};

  // 1. Opening the panel: one bounded page of its own chain, never the parent.
  await until(
    () => scopedReads().length === 1 && entry()?.status === "ready",
    "the delegate's first scoped page",
  );
  await frames(2);
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
      [showingEarlier() !== null, "an older page exists behind the first one"],
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
  failures.push(
    ...failuresOf([
      [same(assistantIds(), firstPageRows), "replacing the parent window leaves the panel's rows intact"],
      [scopedReads().length === 1, "replacing the parent window spends no further read"],
      [entry()?.status === "ready", "the panel stays available after the parent window is replaced"],
      [entry()?.messages.length === FIRST_PAGE.length, "the cached page keeps its own rows"],
      [entry()?.canonicalId === DELEGATION, "the chain identity is unchanged"],
      [showingEarlier() !== null, "paging state survives the parent window"],
      [emptyState() === null && errorState() === null, "the panel is neither empty nor failed"],
      [
        metricsContext().length > 0,
        `chain metrics survive without any parent Task card (${metricsContext()})`,
      ],
    ]),
  );
  facts.afterReplace = { rows: assistantIds(), reads: scopedReads().length };

  // 3. Older paging reads the chain's own scope with the cursor the page kept.
  showingEarlier()?.click();
  await until(
    () => scopedReads().length === 2 && entry()?.status === "ready",
    "the older page of the chain",
  );
  await frames(2);
  failures.push(
    ...failuresOf([
      [scopedReads()[1]?.messageBefore === 30, `the older read uses the page cursor (${scopedReads()[1]?.messageBefore})`],
      [scopedReads()[1]?.scope?.id === DELEGATION, "the older read stays in the chain's scope"],
      [
        same(assistantIds(), [...OLDER_PAGE, ...FIRST_PAGE]),
        `older rows prepend to the loaded page (${assistantIds().join(",")})`,
      ],
      [showingEarlier() === null, "the trigger disappears once the chain's head is loaded"],
      [entry()?.hasMoreBefore === false, "the entry records that it reached the head"],
      [entry()?.messages.length === OLDER_PAGE.length + FIRST_PAGE.length, "the page holds every loaded row"],
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
  // 9. A long chain fills the whole reading window. The measure is the real
  //    one: the page the reader clicked for must survive the budget trim, the
  //    fragment in view must stay on its viewport offset while the page grows
  //    above it, and the dropped side must remain reachable through the
  //    matching control.
  flushSync(() => {
    root?.unmount();
    root = null;
  });
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: SESSION,
      messages: [deepTaskRecord()],
    } as never);
  });
  mountTab(DEEP_DELEGATION);
  const deepEntry = () => entry(SESSION, DEEP_DELEGATION);
  const deepReads = () =>
    scopedReads().filter((read) => read.scope?.id === DEEP_DELEGATION);
  const olderReady = () =>
    deepEntry()?.refreshing !== true &&
    deepEntry()?.status !== "loading" &&
    showingEarlier() !== null;
  const latestReady = () =>
    deepEntry()?.refreshing !== true &&
    document.querySelector<HTMLElement>('[data-testid="subagent-show-latest"] .link-btn') !== null;
  await until(
    () => deepReads().length === 1 && deepEntry()?.status === "ready",
    "the long chain's first page",
  );
  await frames(2);
  // Three explicit older reads fill the window: 600…999 at 400 rows.
  for (let click = 0; click < 3; click += 1) {
    await until(olderReady, "the earlier control before a deep-chain click");
    const before = deepReads().length;
    showingEarlier()?.click();
    await until(
      () => deepReads().length === before + 1 && deepEntry()?.status === "ready",
      `deep-chain older page ${click + 1}`,
    );
    await frames(2);
  }
  failures.push(
    ...failuresOf([
      [
        deepEntry()?.messages.length === SUBAGENT_HISTORY_MESSAGE_LIMIT,
        `the long chain fills its ${SUBAGENT_HISTORY_MESSAGE_LIMIT}-row window`,
      ],
      [deepEntry()?.messageStart === 600, `the window's older cursor is 600 (${deepEntry()?.messageStart})`],
      [
        JSON.stringify(deepReads().slice(1).map((read) => read.messageBefore)) ===
          JSON.stringify([900, 800, 700]),
        `each older read pages from the window's own cursor (${deepReads()
          .slice(1)
          .map((read) => read.messageBefore)
          .join(",")})`,
      ],
    ]),
  );
  facts.deepFullWindow = {
    rows: assistantIds().length,
    messageStart: deepEntry()?.messageStart,
    reads: deepReads().length,
  };

  // A real upward gesture releases follow, so the click below grows the rows
  // above the reader's own reading position instead of the pinned bottom.
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
  const fragmentOffset = (element: HTMLElement, id: string) => {
    const node = element.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!node) return null;
    return node.getBoundingClientRect().top - element.getBoundingClientRect().top;
  };
  deepScroller?.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  deepScroller!.scrollTop = Math.max(0, deepScroller!.scrollHeight / 2);
  await frames(3);
  const released = deepScroller ? geometryOf(deepScroller).distanceFromBottom > 100 : false;
  failures.push(
    ...failuresOf([
      [released, "an upward gesture releases follow at the reading position"],
      [
        document.querySelector<HTMLElement>(".subagent-transcript-jump") !== null,
        "a released scroller offers the jump control",
      ],
    ]),
  );
  const anchored = deepScroller ? readingLine(deepScroller) : null;
  if (!anchored) failures.push("the released scroller shows a fragment at the reading line");
  const anchoredId = anchored?.id ?? "";
  const beforeAnchor = deepScroller ? geometryOf(deepScroller) : null;

  const deepBeforeRead = deepReads().length;
  showingEarlier()?.click();
  await until(
    () => deepReads().length === deepBeforeRead + 1 && deepEntry()?.status === "ready",
    "the older page at the full window",
  );
  await frames(3);
  const clickedRead = deepReads().at(-1);
  const afterAnchor = deepScroller ? geometryOf(deepScroller) : null;
  const afterOffset =
    deepScroller && anchoredId ? fragmentOffset(deepScroller, anchoredId) : null;
  const windowRows = assistantIds().filter((id) => id.startsWith("child-deep-"));
  const expectedWindow = Array.from(
    { length: SUBAGENT_HISTORY_MESSAGE_LIMIT },
    (_, offset) => deepRowId(500 + offset),
  );
  facts.deepOlderPage = {
    messageBefore: clickedRead?.messageBefore,
    anchoredId,
    before: beforeAnchor,
    after: afterAnchor,
    anchoredOffset: afterOffset,
    rows: windowRows.length,
  };
  failures.push(
    ...failuresOf([
      [clickedRead?.messageBefore === 600, `the click pages from the window's cursor (${clickedRead?.messageBefore})`],
      [
        afterOffset !== null && Math.abs(afterOffset - anchored.offset) < 2,
        `the held fragment stays on its viewport offset (${anchoredId}: ${String(anchored?.offset)} → ${String(afterOffset)})`,
      ],
      [
        beforeAnchor !== null && afterAnchor !== null && afterAnchor.scrollTop > beforeAnchor.scrollTop + 100,
        "the page added height above the reading position",
      ],
      [
        deepEntry()?.messages.length === SUBAGENT_HISTORY_MESSAGE_LIMIT,
        "the clicked page is retained inside the window budget",
      ],
      [
        deepEntry()?.messageStart === 500,
        `the cursor names the oldest retained row (${deepEntry()?.messageStart})`,
      ],
      [deepEntry()?.hasMoreAfter === true, "the dropped newest page is stated as continuing"],
      [
        windowRows.length === SUBAGENT_HISTORY_MESSAGE_LIMIT &&
          windowRows.every((id, index) => id === expectedWindow[index]),
        `the rendered window is exactly 500…899 (${windowRows.length} rows, first ${windowRows[0]}, last ${windowRows.at(-1)})`,
      ],
      [
        !windowRows.includes(deepRowId(999)),
        "the newest dropped row is not mounted",
      ],
    ]),
  );

  // The forward control re-reads the tail: the newest page rejoins the window,
  // the oldest page leaves it, and jumping to the latest re-bottoms the pane.
  await until(latestReady, "the show-latest control after the older page");
  document.querySelector<HTMLElement>('[data-testid="subagent-show-latest"] .link-btn')?.click();
  await until(
    () => deepReads().length === deepBeforeRead + 2 && deepEntry()?.status === "ready",
    "the tail read of the long chain",
  );
  await frames(3);
  const recoveredRows = assistantIds().filter((id) => id.startsWith("child-deep-"));
  const expectedRecovered = Array.from(
    { length: SUBAGENT_HISTORY_MESSAGE_LIMIT },
    (_, offset) => deepRowId(600 + offset),
  );
  failures.push(
    ...failuresOf([
      [deepEntry()?.hasMoreAfter === false, "the forward read reaches the chain's tail"],
      [deepEntry()?.hasMoreBefore === true, "the older page it dropped stays reachable backwards"],
      [deepEntry()?.messageEnd === DEEP_TOTAL, `the newest cursor is the tail end (${deepEntry()?.messageEnd})`],
      [
        recoveredRows.length === SUBAGENT_HISTORY_MESSAGE_LIMIT &&
          recoveredRows.every((id, index) => id === expectedRecovered[index]),
        `the recovered window is exactly 600…999 (${recoveredRows.length} rows, last ${recoveredRows.at(-1)})`,
      ],
      [
        new Set(recoveredRows).size === recoveredRows.length,
        "a rejoining page does not duplicate a row",
      ],
    ]),
  );
  document.querySelector<HTMLElement>(".subagent-transcript-jump")?.click();
  await until(
    () => (deepScroller ? geometryOf(deepScroller).distanceFromBottom < 2 : false),
    "the jump back to the latest row",
  );
  const jumped = deepScroller ? geometryOf(deepScroller) : null;
  facts.deepRecovery = {
    messageStart: deepEntry()?.messageStart,
    rows: recoveredRows.length,
    last: recoveredRows.at(-1),
    jumped,
    reads: deepReads().length,
  };
  failures.push(
    ...failuresOf([
      [
        jumped !== null && jumped.distanceFromBottom < 2,
        `the jump control re-bottoms the pane (${String(jumped?.distanceFromBottom)})`,
      ],
      [
        assistantText(deepRowId(DEEP_TOTAL - 1)).includes(`deep chain row ${DEEP_TOTAL - 1}`),
        "the newest row renders after the recovery",
      ],
    ]),
  );

  facts.channels = channels.length;
  facts.scopedReads = scopedReads();
  facts.finalRows = assistantIds();

  return { ok: failures.length === 0, failures, facts };
};
