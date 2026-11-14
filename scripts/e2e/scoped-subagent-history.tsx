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

/** One delegation-scoped page, shaped like the host's answer. */
function delegationDetail(
  sessionId: string,
  messageBefore: number | undefined,
): SessionDetail {
  const base = {
    id: sessionId,
    title: sessionId === SESSION ? "Scoped history fixture" : "Other session",
    source: "local",
    mode: "agent",
    createdAt,
    updatedAt: createdAt,
    historyScope: { kind: "delegation" as const, id: DELEGATION },
  };
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
    return { ok: true, data: { session: delegationDetail(id, request.messageBefore) } };
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

function mountTab() {
  root = createRoot(pane);
  const mounted = root;
  flushSync(() => {
    mounted.render(
      <I18nextProvider i18n={i18n}>
        <SubagentTranscriptTab delegationId={DELEGATION} />
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
const entry = (sessionId = SESSION) =>
  store().subagentHistory[sessionId]?.[DELEGATION];

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
  facts.channels = channels.length;
  facts.scopedReads = scopedReads();
  facts.finalRows = assistantIds();

  return { ok: failures.length === 0, failures, facts };
};
