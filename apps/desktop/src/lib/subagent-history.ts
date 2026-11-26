import type {
  SessionDetail,
  SessionHistoryRun,
  SessionHistoryScope,
  UiMessage,
} from "@pi-desktop/shared";
import { delegationHistoryScope } from "@pi-desktop/shared";
import { dedupeSessionMessages, orderRowsByLiveAnnouncement, upsertLiveSessionMessage } from "./session-transcript";
import { subagentChainCallIds } from "./subagent-chain";
import { delegationIdForMessage } from "./subagent-panel";
import { isDelegationStartTool } from "./tool-display";
import { mergePageWindow, type PageWindowPage } from "./page-window";
import { buildSubagentTranscript, type SubagentTranscript } from "./subagent-transcript";

/**
 * One delegate's conversation, read from its own scoped history page instead
 * of from the parent transcript window.
 *
 * The parent's history budget covers its own top-level rows only, so a delegate
 * tab cannot reconstruct its conversation from whatever happens to sit inside
 * the main page: the task chain may be older than the window, and its child
 * rows were never in it. A delegation-scoped read answers with the child rows
 * of every connected `Task` call plus the root `Task` records that identify the
 * chain, and the reader caches one of those per session and chain.
 *
 * Identity is the canonical chain id the backend echoes, never a card label or
 * a tab position: an older call id resolves to the same chain, and the entry
 * keeps the identities it was addressed by as aliases so a relocated panel
 * still finds it. `Task(resume …)` rows that arrive live are resolved onto the
 * same entry, so a continuation never strands the tab that already held the
 * chain.
 *
 * The cached page owns the chain's rows: durable pages and the live rows the
 * parent's event stream produced are both written into the entry, so replacing,
 * reducing, or removing the main transcript window cannot take a delegate's
 * conversation away. Rendering may merge the live tail again (an update that
 * lands between two publications), but the entry, not the parent viewport, is
 * the source of truth.
 */

export type SubagentHistoryStatus = "loading" | "ready" | "empty" | "error";

/** Scoped pages a session keeps before the least recently read one is dropped. */
export const SUBAGENT_HISTORY_LIMIT = 12;
/**
 * Selected child rows one local scoped page reads. Initial, latest, older and
 * newer reads all use the same row policy: the store asks for
 * `SUBAGENT_HISTORY_PAGE_SIZE` rows per read, so a chain of that many rows
 * needs one read instead of one read per hundred rows. The live tail keeps its
 * own smaller cap below.
 */
export const SUBAGENT_HISTORY_PAGE_SIZE = 500;
export const SUBAGENT_HISTORY_CONTENT_LIMIT = 64 * 1024;
/**
 * Live rows one chain may hold past its reading window. Live rows are the
 * parent's publication tail, not a physical page: they never evict a page the
 * reader is reading, so they are bounded on their own instead of sharing the
 * reading window.
 */
export const SUBAGENT_HISTORY_LIVE_TAIL_LIMIT = 100;
/** Identities one chain may be addressed by before the aliases stop growing. */
const MAX_ALIASES = 6;
/** The backend's answer for a chain it no longer knows. */
export const SUBAGENT_HISTORY_UNAVAILABLE = "Subagent transcript is no longer available.";

export type SubagentHistoryEntry = {
  sessionId: string;
  /** The identity this tab was opened with: a delegation id or an older call id. */
  tabKey: string;
  /** Canonical chain identity echoed by the backend; equals `tabKey` until known. */
  canonicalId: string;
  /** Identities already resolved onto this entry, including `tabKey`. */
  aliases: string[];
  status: SubagentHistoryStatus;
  /** Scoped child rows this entry owns, in physical order. */
  messages: UiMessage[];
  /** Root `Task` records identifying the chain, outside the reading window. */
  context: UiMessage[];
  /**
   * Physical run openings the backend stated for the same context chain.
   *
   * Chain-global facts, not page bounds: the renderer decides whether a run's
   * prompt belongs on screen by asking whether the retained contiguous window
   * actually covers its opening. An empty list on a scoped entry means the
   * backend served no such metadata, and the reader falls back to the
   * conservative whole-chain rule rather than guessing a run head.
   */
  runs: SessionHistoryRun[];
  messageStart: number;
  /** Exclusive physical end of the rows this entry holds, when the backend says. */
  messageEnd?: number;
  /**
   * The physical pages this entry's reading window holds, oldest first.
   *
   * They are one *contiguous* interval: a page joins the window only when its
   * physical range meets the side it was read for (older reads join the oldest
   * retained page, newer reads the newest), so the retained pages never state
   * two ranges as one conversation. Overlapping answers replace the earlier
   * copy of the same range, and a page that belongs somewhere else — a search
   * target or a fresh tail — starts a new window instead of being appended to
   * a distant one.
   */
  pages: PageWindowPage[];
  hasMoreBefore: boolean;
  /**
   * Whether the scope has selected rows newer than the window's newest row.
   * False means the window reaches the scope's tail, which is also the follow
   * state: only a window at the tail takes live output.
   */
  hasMoreAfter: boolean;
  /**
   * Live rows this chain routed in that no durable page has confirmed yet,
   * oldest first, always a subset of `messages`.
   *
   * A running child row exists only in the parent's live array until its tool
   * ends, so a read issued before that end cannot contain it. Keeping the
   * unconfirmed rows here is what lets every durable read put them back instead
   * of erasing a row the reader is watching. A page that names the row confirms
   * it, and the live copy retires exactly once. A call appears here once, holding
   * the state its latest live event published, so repeated publications cannot
   * grow it.
   */
  livePending: UiMessage[];
  /**
   * True while no live row arrived after the last durable read: the entry
   * matches the store, so reopening it costs nothing. A live row clears it,
   * and a durable read sets it again unless a live row arrived while that read
   * was in flight — then the answer is already stale.
   */
  finalized: boolean;
  /**
   * Whether a live row was routed in while a read of this entry was in flight.
   * The answer that read returns was captured before that row, so it cannot
   * finalize the entry; the flag is consumed by the read that sets it.
   */
  liveDuringRead?: boolean;
  /** True while a read of an already loaded entry is in flight. */
  refreshing: boolean;
  /** Search target this entry was opened to show, if any. */
  focus: { messageId: string; query: string; requestId: number } | null;
  /** False when the backend answered the legacy physical transcript. */
  scoped: boolean;
  /**
   * A newer page was requested from the window's own physical end and the
   * answer did not move past it, so automatic forward paging must stop asking
   * for the same page. The window keeps its rows and `hasMoreAfter`; the
   * explicit latest read is the way to the tail.
   */
  laterStalled?: boolean;
  /**
   * True while the chain's first durable page is still owed: a delegation read
   * answered with no session even though the parent already published the
   * chain's live `Task` dispatch, whose durable record the persistence outbox
   * has not appended yet. The live rows are the panel's source meanwhile, and
   * the dispatch settling is what retries the first durable page. A page, a
   * definitive miss, or a failed read clears it.
   */
  pendingDurable?: boolean;
  error?: string;
  /** The read a failure belongs to, so a retry repeats the same page. */
  retryDirection?: SubagentHistoryDirection;
  /** Monotonic read order, used to evict the least recently read entry. */
  touched: number;
};

/** Per-session buckets, keyed by the tab identity that opened the entry. */
export type SubagentHistoryBuckets = Record<string, Record<string, SubagentHistoryEntry>>;

/**
 * Where a page belongs relative to the window the entry holds.
 *
 * `initial` reads a chain's first durable page, `before` grows the window
 * backwards, `after` grows it forwards, `focus` starts a window around a
 * search target, and `latest` reads the scope's newest page — joining the
 * window when it is adjacent and starting a fresh tail window when it is not.
 */
export type SubagentHistoryDirection = "initial" | "before" | "after" | "focus" | "latest";

export function createSubagentHistoryEntry(
  sessionId: string,
  tabKey: string,
  touched = 0,
): SubagentHistoryEntry {
  return {
    sessionId,
    tabKey,
    canonicalId: tabKey,
    aliases: tabKey ? [tabKey] : [],
    status: "loading",
    messages: [],
    context: [],
    runs: [],
    messageStart: 0,
    pages: [],
    hasMoreBefore: false,
    hasMoreAfter: false,
    finalized: false,
    refreshing: false,
    focus: null,
    scoped: false,
    livePending: [],
    liveDuringRead: false,
    touched,
  };
}

/** The scope one entry reads: its canonical chain identity once resolved. */
export function subagentHistoryScope(entry: SubagentHistoryEntry): SessionHistoryScope {
  return delegationHistoryScope(entry.canonicalId || entry.tabKey);
}

/** Whether the entry holds anything to show yet. */
export function subagentHistoryHasRows(entry: SubagentHistoryEntry | undefined): boolean {
  return Boolean(entry && (entry.messages.length > 0 || entry.context.length > 0));
}

/**
 * The entry a tab identity resolves to: its own entry, an entry that already
 * echoed this identity as canonical, or one that recorded it as an alias.
 */
export function findSubagentHistoryEntry(
  buckets: SubagentHistoryBuckets,
  sessionId: string,
  tabKey: string,
): SubagentHistoryEntry | undefined {
  const bucket = buckets[sessionId];
  if (!bucket || !tabKey) return undefined;
  const direct = bucket[tabKey];
  if (direct) return direct;
  return Object.values(bucket).find(
    (entry) => entry.canonicalId === tabKey || entry.aliases.includes(tabKey),
  );
}

/** Add one resolved identity to the alias list, bounded and deduplicated. */
export function aliasesWith(aliases: readonly string[], next: string | undefined): string[] {
  if (!next || aliases.includes(next)) return [...aliases];
  return [...aliases, next].slice(-MAX_ALIASES);
}


 /**
  * History baseline order for the delegate view: creation time, arrival-tied.
  *
 * This is the durable skeleton's own order — the rows the live tail does not
 * name stay on it (paging and context keep the semantics the existing
 * scoped-history tests pin down). It is not the tool order
  * authority: rows the live tail names keep the first-announcement order the
  * transcript already showed (see `orderRowsByLiveAnnouncement`), because
  * completion re-stamps `createdAt` and durable pages arrive in finish order.
  * The base stays chronological; the overlay only repositions live-named
  * rows among themselves.
  */
 function orderedRows(rows: readonly UiMessage[]): UiMessage[] {
   if (rows.length < 2) return [...rows];
   const arrival = new Map<string, number>();
   for (const [index, row] of rows.entries()) {
     if (!arrival.has(row.id)) arrival.set(row.id, index);
   }
   return [...rows].sort((left, right) => {
     const leftAt = left.createdAt;
     const rightAt = right.createdAt;
     if (leftAt !== rightAt) {
       if (!leftAt) return 1;
       if (!rightAt) return -1;
       return leftAt < rightAt ? -1 : 1;
     }
     return (arrival.get(left.id) ?? 0) - (arrival.get(right.id) ?? 0);
   });
 }

/** Every live row that belongs to the chain: its root `Task` rows and its children. */
function ownedChainRows(
  entry: SubagentHistoryEntry,
  live: readonly UiMessage[],
): { context: UiMessage[]; messages: UiMessage[] } {
  const base = [...entry.context, ...entry.messages];
  const chain = subagentChainCallIds(
    live.length ? [...base, ...live] : base,
    entry.tabKey || entry.canonicalId,
  );
  const context: UiMessage[] = [];
  const messages: UiMessage[] = [];
  if (chain.size === 0) return { context, messages };
  for (const message of live) {
    if (message.role === "tool" && isDelegationStartTool(message.toolName)) {
      // A `Task` call of the chain is a root record, never a child row: it
      // identifies the chain and carries the run's outcome and delegation id.
      if (message.toolCallId && chain.has(message.toolCallId)) context.push(message);
      continue;
    }
    const parent = message.parentToolCallId;
    if (parent && chain.has(parent)) messages.push(message);
  }
  return { context, messages };
}

/** The resume target a `Task(resume …)` call names, if it names one. */
function resumeTargetOf(message: UiMessage): string | undefined {
  const args = message.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const resume = (args as { resume?: unknown }).resume;
  if (typeof resume !== "string") return undefined;
  const trimmed = resume.trim();
  return trimmed || undefined;
}

/**
 * Every chain identity a live array names: the `Task` calls it opened, the
 * delegation ids their results recorded, the call a continuation resumes, and
 * the parent call each child row hangs off.
 */
export function subagentHistoryLiveIds(live: readonly UiMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of live) {
    if (message.parentToolCallId) ids.add(message.parentToolCallId);
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) continue;
    if (message.toolCallId) ids.add(message.toolCallId);
    const resumed = resumeTargetOf(message);
    if (resumed) ids.add(resumed);
    ids.add(delegationIdForMessage(message));
  }
  return ids;
}

/**
 * Whether a live update can concern this chain at all.
 *
 * Chain resolution walks the whole live array, so the store first asks this
 * cheap question: no identity in the update names this chain, its `Task` rows,
 * or its children. An unrelated conversation's stream therefore costs a
 * cached delegate nothing.
 */
export function subagentHistoryTouchesLive(
  entry: SubagentHistoryEntry,
  liveIds: ReadonlySet<string>,
): boolean {
  if (!liveIds.size) return false;
  if (entry.tabKey && liveIds.has(entry.tabKey)) return true;
  if (entry.canonicalId && liveIds.has(entry.canonicalId)) return true;
  for (const alias of entry.aliases) if (liveIds.has(alias)) return true;
  for (const row of entry.context) {
    if (row.toolCallId && liveIds.has(row.toolCallId)) return true;
  }
  for (const row of entry.messages) {
    if (row.parentToolCallId && liveIds.has(row.parentToolCallId)) return true;
  }
  return false;
}

/** How the live tail names a delegate's own `Task` dispatch. */
export type SubagentLiveTaskState = "absent" | "running" | "settled";

/**
 * Whether the live tail holds the chain's own `Task` dispatch, and whether
 * that call has already reached a terminal state.
 *
 * A running dispatch has no durable row yet: the parent publishes the `Task`
 * card on `tool_start`, while host-core receives the row only when the call
 * ends and the persistence outbox drains it. A delegation read therefore
 * cannot tell a not-yet-durable chain from an unknown one by its own answer
 * alone, and `absent` is what keeps an empty answer a real miss.
 */
export function subagentHistoryLiveTaskState(
  entry: SubagentHistoryEntry,
  live: readonly UiMessage[],
): SubagentLiveTaskState {
  if (!live.length) return "absent";
  const chain = subagentChainCallIds(
    [...entry.context, ...entry.messages, ...live],
    entry.tabKey || entry.canonicalId,
  );
  let matched = false;
  let settled = true;
  for (const message of live) {
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) continue;
    const callId = message.toolCallId;
    const namesChain =
      (typeof callId === "string" &&
        (chain.has(callId) || entry.tabKey === callId ||
          entry.canonicalId === callId || entry.aliases.includes(callId))) ||
      chain.has(delegationIdForMessage(message));
    if (!namesChain) continue;
    matched = true;
    // One unsettled dispatch is enough: the chain is still being created, so
    // no durable record of the whole conversation can exist yet.
    if (!isSettledChildRow(message)) settled = false;
  }
  if (!matched) return "absent";
  return settled ? "settled" : "running";
}

/**
 * The rows a delegate view renders: the chain's own cached rows plus the live
 * tail that belongs to it.
 *
 * The entry already owns the rows ingestion persisted; this merge keeps the
 * view correct for the publication boundary between a live event and a render,
 * and it resolves the chain over both views at once — a continuation opens its
 * own `Task(resume …)` call after the page was read, so only reading the cached
 * page and the live tail together keeps that segment on the tab that already
 * represents the chain.
 *
 * Two position rules, one authority each. The history baseline is
 * chronological (`orderedRows`): rows the live tail does not name keep the
 * creation-time order the existing scoped-history tests pin down, so paging and
 * context keep their semantics. The live overlay
 * (`orderRowsByLiveAnnouncement`) owns rows the live tail names: they keep the
 * first-announcement order the transcript already showed, because completion
 * re-stamps `createdAt` and durable pages arrive in finish order. For those
 * live-named rows `createdAt` is display metadata, never a position key — a
 * re-stamp or refresh only replaces values. Live rows stay authoritative for an
 * id the cache already holds, so a completed child row replaces its streaming
 * copy.
 *
 * A window that does not reach the tail is a historical range: the live tail
 * it cannot show is not part of that conversation, so only rows the window
 * holds are drawn. The chain still keeps the newer rows it routed in, and the
 * explicit latest read is what brings them on screen (ADR 0335).
 */
export function subagentHistoryMessages(
  entry: SubagentHistoryEntry | undefined,
  live: readonly UiMessage[],
): UiMessage[] {
  if (!entry) return [...live];
  const windowIds = subagentHistoryWindowIds(entry);
  const visible = windowIds
    ? entry.messages.filter((row) => windowIds.has(row.id))
    : entry.messages;
  const base = dedupeSessionMessages([...entry.context, ...visible]);
  if (!live.length) return orderedRows(base);
  const owned = ownedChainRows(entry, live);
  if (!owned.context.length && !owned.messages.length) return orderedRows(base);
  const mergeable = windowIds
    ? owned.messages.filter((row) => windowIds.has(row.id))
    : owned.messages;
  const ownedIds = new Set([...owned.context, ...mergeable].map((row) => row.id));
  let output = base;
  for (const message of live) {
    if (!ownedIds.has(message.id)) continue;
    output = upsertLiveSessionMessage(output, message);
  }
  const liveOrder = new Map<string, number>();
  for (const [index, message] of live.entries()) {
    if (!liveOrder.has(message.id)) liveOrder.set(message.id, index);
  }
  // Durable baseline: rows the live tail does not name keep chronological
  // order among the positions they already hold; a live-only A is never
  // moved by a sorted-B anchor because B's slot is not in this set.
  const durablePositions: number[] = [];
  for (const [index, message] of output.entries()) {
    if (!liveOrder.has(message.id)) durablePositions.push(index);
  }
  const sortedDurable = orderedRows(durablePositions.map((position) => output[position]));
  let next = output.slice();
  durablePositions.forEach((position, step) => {
    next[position] = sortedDurable[step];
  });
  // Live overlay second: rows the live tail names keep the first-announcement
  // order among themselves; durable-only rows never move for them.
  return orderRowsByLiveAnnouncement(next, liveOrder, (message) => liveOrder.has(message.id));
}

/**
 * Whether the retained contiguous window covers this run's opening.
 *
 * The backend's `historyRuns` are physical facts (the run's Task row index and
 * its first selected child). Visibility is decided here from the window's own
 * physical bounds, never from `createdAt`, prompt text, or "the chain still has
 * older rows": a window cut in the middle of a run has not reached its opening,
 * and a later run's opening only appears when the window reaches that run.
 *
 * A run with no selected child yet is an empty or live opening: it is visible
 * when the window reaches the scope's tail at or after its physical Task row,
 * and its opening is never given a fabricated child position. Live Task rows
 * (no durable record, hence no run metadata) follow the tail the same way.
 *
 * Fallbacks are explicit, not guessed:
 * - The legacy physical read holds every row, so its prompts are visible.
 * - A scoped answer with no `historyRuns` at all is an older backend: only a
 *   window that provably reaches the chain head (`hasMoreBefore` false) can
 *   assert every run opening; a partial window drops the prompt rather than
 *   drawing one at the page head.
 */
export function subagentHistoryRunPromptVisible(
  entry: SubagentHistoryEntry | undefined,
  call: Pick<UiMessage, "id" | "toolCallId">,
): boolean {
  if (!entry) return true;
  if (!entry.scoped) return true;
  const pages = entry.pages ?? [];
  const windowStart = pages[0]?.start;
  const windowEnd = pages[pages.length - 1]?.end;
  const runs = entry.runs ?? [];
  const run =
    runs.find((item) => item.taskMessageId === call.id) ??
    runs.find((item) => item.callId === call.toolCallId);
  if (run) {
    const firstChild = run.firstChildIndex;
    if (firstChild !== undefined) {
      return (
        windowStart !== undefined &&
        windowEnd !== undefined &&
        windowStart <= firstChild &&
        firstChild < windowEnd
      );
    }
    return (
      entry.hasMoreAfter !== true &&
      (windowStart === undefined || windowStart <= run.taskIndex)
    );
  }
  if (windowStart === undefined) return true;
  if (!entry.runs.length) return entry.hasMoreBefore !== true;
  return entry.hasMoreAfter !== true;
}

/**
 * The delegate transcript for the entry's retained window.
 *
 * One place wires the window to the prompt rule: the model and the rendered
 * panel cannot disagree about whether a run opening is on screen.
 */
export function subagentHistoryTranscript(
  entry: SubagentHistoryEntry | undefined,
  live: readonly UiMessage[],
  delegationId: string,
): SubagentTranscript | null {
  return buildSubagentTranscript(
    subagentHistoryMessages(entry, live),
    delegationId,
    { promptVisible: (call) => subagentHistoryRunPromptVisible(entry, call) },
  );
}

/**
 * Whether the window reaches the scope's tail, so live output belongs in it.
 *
 * It is the one follow state of the panel, and it is derived from the read
 * that reached the tail rather than from scroll position: a window that still
 * has rows after it is a historical range and stays one until a latest read
 * replaces or extends it.
 */
export function subagentHistoryIsFollowing(entry: SubagentHistoryEntry | undefined): boolean {
  return entry?.hasMoreAfter !== true;
}

/**
 * Row identities the contiguous window holds, or `undefined` when every row
 * the entry owns belongs to the view — a window that reaches the tail, or one
 * that has not read a durable page yet.
 */
function subagentHistoryWindowIds(entry: SubagentHistoryEntry): Set<string> | undefined {
  if (entry.hasMoreAfter !== true || !entry.pages?.length) return undefined;
  return new Set(entry.pages.flatMap((page) => page.ids));
}

/**
 * Whether the rendered window holds this row.
 *
 * The entry can own rows the view does not draw: a historical window draws
 * only the ids its own pages contributed, so a live row past it is held
 * without being presented. A search target is already shown only when this
 * answers true — otherwise the reader's hit is exactly the case that has to
 * read the window around it.
 */
export function subagentHistoryHoldsWindowRow(
  entry: SubagentHistoryEntry | undefined,
  messageId: string,
): boolean {
  if (!entry?.messages.some((row) => row.id === messageId)) return false;
  const windowIds = subagentHistoryWindowIds(entry);
  return windowIds === undefined || windowIds.has(messageId);
}

/**
 * Bound the live tail without touching the reading window.
 *
 * Live rows are the parent's publication tail: they carry no physical page
 * bounds, and they are always newer than the pages the entry read. Sharing one
 * bound with them is what used to let a background publication evict the page a
 * reader was reading, so the live tail is bounded on its own. Dropping the
 * oldest of those rows leaves a hole between the window and what is retained,
 * so the entry stops claiming the tail: the view keeps the durable window and
 * an explicit latest read refills it.
 */
function limitLiveRows(
  entry: SubagentHistoryEntry,
  limit: number,
): SubagentHistoryEntry {
  if (limit <= 0) return entry;
  const pageIds = new Set((entry.pages ?? []).flatMap((page) => page.ids));
  const live = entry.messages.filter((row) => !pageIds.has(row.id));
  if (live.length <= limit) return entry;
  const dropped = new Set(live.slice(0, live.length - limit).map((row) => row.id));
  return {
    ...entry,
    messages: entry.messages.filter((row) => !dropped.has(row.id)),
    livePending: (entry.livePending ?? []).filter((row) => !dropped.has(row.id)),
    hasMoreAfter: true,
  };
}

/** Tool states that are still in flight, so a later one may still replace them. */
const UNSETTLED_TOOL_STATUSES = new Set(["running", "preparing"]);

/** True when a child row has already reached its terminal state. */
function isSettledChildRow(row: UiMessage): boolean {
  return typeof row.toolStatus === "string" && !UNSETTLED_TOOL_STATUSES.has(row.toolStatus);
}

/**
 * One unconfirmed version per call, at the position the call first appeared.
 *
 * A running child republishes on every event, so the same call reaches the
 * pending set many times with an advancing state; keeping one version per id is
 * what bounds it by the chain's own rows instead of by the event count. The
 * later publication wins, except that a replay of an earlier unsettled frame
 * never downgrades a settled one — the same rule a late prepare frame already
 * follows for an executing row.
 */
function mergePendingRows(
  held: readonly UiMessage[],
  incoming: readonly UiMessage[],
): UiMessage[] {
  const order: string[] = [];
  const byId = new Map<string, UiMessage>();
  for (const row of [...held, ...incoming]) {
    const current = byId.get(row.id);
    if (!current) {
      order.push(row.id);
      byId.set(row.id, row);
      continue;
    }
    if (isSettledChildRow(current) && !isSettledChildRow(row)) continue;
    byId.set(row.id, row);
  }
  const merged: UiMessage[] = [];
  for (const id of order) {
    const row = byId.get(id);
    if (row) merged.push(row);
  }
  return merged;
}

/** True when two pending sets hold the same row objects in the same order. */
function samePendingRows(held: readonly UiMessage[], next: readonly UiMessage[]): boolean {
  if (held.length !== next.length) return false;
  return held.every((row, index) => row === next[index]);
}

/**
 * The one durable/live reconciliation rule.
 *
 * `confirmed` is the ids of the rows a durable answer names. A live row the
 * answer names has become durable, so its live copy retires here — exactly
 * once, because the durable value already stands at that id — and the row
 * leaves the pending set. A live row the answer does not name is still newer
 * than the read: the durable window cannot speak for it, so the row is put
 * back into the result — advancing a copy the merge already holds. A settled
 * live row is therefore never displayed from an older unsettled copy of the
 * same call, whichever read path built the rows.
 *
 * Retention is bounded by the reading window and the live tail, not by the merge
 * that produced the rows: a page read keeps only the pages its window holds, and
 * a live publication keeps only its own tail. Pending holds one version per call
 * and is always a subset of `messages`, so a chain that keeps streaming cannot
 * accumulate rows past the window plus the tail. Pending state only spans the
 * distance between a live event and the durable row that records the same call.
 */
function reconcileLiveRows(
  rows: readonly UiMessage[],
  confirmed: ReadonlySet<string>,
  pending: readonly UiMessage[],
): { messages: UiMessage[]; livePending: UiMessage[] } {
  let messages = dedupeSessionMessages([...rows]);
  const held = new Map(messages.map((row) => [row.id, row]));
  const livePending: UiMessage[] = [];
  for (const row of mergePendingRows([], pending)) {
    if (confirmed.has(row.id)) continue;
    const current = held.get(row.id);
    // A merge can already hold this call from an older live copy — the row the
    // parent published before the tool ended, or the retained window a page
    // read joined. The pending version is the newest state this chain saw, so
    // it replaces an unsettled copy in place; a settled copy already stands and
    // keeps the durable value.
    if (!current || (isSettledChildRow(row) && !isSettledChildRow(current))) {
      messages = upsertLiveSessionMessage(messages, row);
      held.set(row.id, row);
    }
    livePending.push(row);
  }
  return { messages, livePending };
}

/**
 * Route live child rows into the chain that owns them.
 *
 * A running delegate streams into the parent's live turn array, which the main
 * transcript window is free to replace. The chain therefore persists the rows
 * that belong to it at publication time: its child rows, the root `Task`
 * records that identify it, and any delegation identity those records reveal.
 * Nothing is derived at render time, so availability, identity, and content do
 * not depend on the main viewport at all.
 *
 * Each row routed in is also recorded as unconfirmed until a durable page names
 * it: a tool that started but has not ended has no durable row yet, so a read
 * issued before that end must not be able to erase the row. A row that already
 * settled is never downgraded by a replay of its earlier unsettled frame. One version per
 * call is kept — the newest this chain published — so repeated publications of
 * the same running tool do not multiply the unconfirmed set. The read's own
 * lifecycle (`refreshing`) belongs to the read that started it, so a live
 * publication never makes an in-flight read look finished.
 *
 * Returns `undefined` when the live array holds nothing new for this chain, so
 * a publication never republishes an unchanged entry.
 */
export function applySubagentLiveRows(
  entry: SubagentHistoryEntry,
  live: readonly UiMessage[],
  limit = SUBAGENT_HISTORY_LIVE_TAIL_LIMIT,
): SubagentHistoryEntry | undefined {
  if (!live.length) return undefined;
  const owned = ownedChainRows(entry, live);
  if (!owned.context.length && !owned.messages.length) return undefined;
  let messages = entry.messages;
  const held = new Map(messages.map((row) => [row.id, row]));
  // The same settled-stands rule the merge paths follow: a replay of an earlier
  // unsettled frame never downgrades a row that already reached its end, so the
  // live array cannot hand the tab a completed call as still running.
  const accepted: UiMessage[] = [];
  for (const row of owned.messages) {
    const current = held.get(row.id);
    if (current && isSettledChildRow(current) && !isSettledChildRow(row)) continue;
    messages = upsertLiveSessionMessage(messages, row);
    held.set(row.id, row);
    accepted.push(row);
  }
  let context = entry.context;
  for (const row of owned.context) context = upsertLiveSessionMessage(context, row);
  let aliases = entry.aliases;
  for (const row of owned.context) aliases = aliasesWith(aliases, delegationIdForMessage(row));
  // A finalized entry has already confirmed every row it holds, so a live
  // update of a row it holds is a replay of a durable row, not a new
  // unconfirmed one. Only rows the last durable read could not name join the
  // pending set.
  const confirmed = new Set(
    entry.finalized ? entry.messages.map((row) => row.id) : [],
  );
  const { livePending } = reconcileLiveRows(
    messages,
    confirmed,
    mergePendingRows(entry.livePending ?? [], accepted),
  );
  // A row routed in while a read is in flight makes that answer stale, and the
  // read that publishes the answer consumes the flag.
  const liveDuringRead = entry.liveDuringRead === true || entry.refreshing === true;
  const changed =
    messages !== entry.messages ||
    context !== entry.context ||
    aliases.length !== entry.aliases.length ||
    !samePendingRows(entry.livePending ?? [], livePending) ||
    entry.liveDuringRead !== liveDuringRead ||
    entry.finalized;
  if (!changed) return undefined;
  return limitLiveRows(
    {
      ...entry,
      messages,
      context,
      aliases,
      livePending,
      liveDuringRead,
      status: messages.length || context.length ? "ready" : entry.status,
      // Live rows arrived after the last durable read: the entry may miss
      // events, so a reopen reads the tail again instead of trusting it.
      finalized: false,
    },
    limit,
  );
}

/** The page merged over what the entry already holds, newest value per row. */
function mergePageRows(existing: readonly UiMessage[], page: readonly UiMessage[]): UiMessage[] {
  if (!page.length) return [...existing];
  if (!existing.length) return dedupeSessionMessages([...page]);
  const pageById = new Map(page.map((row) => [row.id, row]));
  const held = new Set(existing.map((row) => row.id));
  const next = existing.map((row) => pageById.get(row.id) ?? row);
  for (const row of page) if (!held.has(row.id)) next.push(row);
  return dedupeSessionMessages(next);
}

/**
 * One page built from a scoped answer: its own physical bounds and the rows it
 * contributed. A cursor derived from row order is not honest here, because a
 * sparse page has no per-row physical index; only the answer states its range.
 */
function pageOf(entry: SubagentHistoryEntry, detail: SessionDetail): PageWindowPage {
  const pageStart = detail.messageStart ?? entry.messageStart;
  return {
    start: pageStart,
    end: detail.messageEnd ?? entry.messageEnd ?? pageStart + (detail.messages ?? []).length,
    ids: (detail.messages ?? []).map((row) => row.id),
    hasMoreBefore: detail.hasMoreBefore === true,
    hasMoreAfter: detail.hasMoreAfter === true,
  };
}

/**
 * Rows a replacing page keeps but cannot position: the live rows it does not
 * name.
 *
 * A live row has no physical index yet, so the page cannot say where it
 * belongs in the new range; the order the entry already held can. The row
 * lands after every page row that preceded it in that order, before the first
 * one that followed it, and at the end when the held order names no page row at
 * all (the entry held only live rows, which are newer than this read).
 *
 * That keeps a page which confirms a later sibling from moving an earlier
 * running row behind it, while a live row that outran the read still follows
 * the durable rows it came after.
 */
function placeLiveRows(
  held: readonly UiMessage[],
  page: readonly UiMessage[],
  live: readonly UiMessage[],
): UiMessage[] {
  const next = dedupeSessionMessages([...page]);
  const liveById = new Map(live.map((row) => [row.id, row]));
  const positionOf = (id: string) => next.findIndex((existing) => existing.id === id);
  for (const [index, row] of held.entries()) {
    const liveRow = liveById.get(row.id);
    if (!liveRow || positionOf(row.id) >= 0) continue;
    let after: number | undefined;
    let before: number | undefined;
    for (const [other, heldRow] of held.entries()) {
      if (other === index) continue;
      const position = positionOf(heldRow.id);
      if (position < 0) continue;
      if (other < index) after = after === undefined ? position : Math.max(after, position);
      else if (before === undefined) before = position;
    }
    const at = after !== undefined ? after + 1 : before !== undefined ? before : next.length;
    next.splice(at, 0, liveRow);
  }
  return next;
}

/**
 * Apply one scoped read to an entry.
 *
 * The entry holds ONE contiguous selected interval, so every answer either
 * joins that interval on the side it was read for or starts a new one; it is
 * never appended to a distant range. `initial` adopts the first durable page,
 * `before` grows the window backwards, `after` grows it forwards, `focus`
 * replaces the window with the page around a search target, and `latest`
 * replaces it with the scope's newest page unless that page provably overlaps
 * the held range.
 *
 * A page that cannot move the window's edge ends that direction instead: rows
 * keep their physical ranges, so appending an unjoined page is exactly how two
 * disjoint windows would be presented as one conversation. `initial` and
 * `focus` speak for both sides; the joining directions speak only for their own
 * side, and the opposite side keeps the flag it already had.
 *
 * Reads never erase a row the reader is watching: root `Task` context merges
 * monotonically, and live rows no durable page has named yet are put back into
 * the entry (the view decides what of that belongs in a historical range).
 */
export function applySubagentHistoryPage(
  entry: SubagentHistoryEntry,
  detail: SessionDetail,
  direction: SubagentHistoryDirection,
  touched: number,
): SubagentHistoryEntry {
  const rows = detail.messages ?? [];
  const pageIds = new Set(rows.map((row) => row.id));
  const page = pageOf(entry, detail);
  const held = entry.pages ?? [];
  const windowStart = held.length ? held[0].start : undefined;
  const windowEnd = held.length ? held[held.length - 1].end : undefined;
  const replaceWindow =
    direction === "initial" ||
    direction === "focus" ||
    (direction === "latest" &&
      (windowStart === undefined ||
        windowEnd === undefined ||
        page.start >= windowEnd));
  // A joining answer has to move the edge the read asked for. A backward answer
  // that starts at or below the window's own oldest bound did not move it, and
  // a forward answer whose newest selected row is still inside the window did
  // not either: both are dropped instead of doubling a range.
  const joins =
    !replaceWindow &&
    (direction === "before"
      ? windowStart !== undefined && page.start < windowStart
      : windowEnd !== undefined && page.end > windowEnd);
  const stalledBefore = !replaceWindow && !joins && direction === "before";
  const stalledAfter = !replaceWindow && !joins && direction === "after";
  const pages = replaceWindow
    ? [page]
    : joins
      ? mergePageWindow({
          window: {
            pages: held,
            hasMoreBefore: entry.hasMoreBefore,
            hasMoreAfter: entry.hasMoreAfter,
          },
          page,
          direction: direction === "before" ? "before" : "after",
        }).pages
      : [...held];
  const oldest = pages[0];
  const newest = pages[pages.length - 1];
  // A joining page lands on its side: an older page prepends (its durable
  // values are the newest answer for the ids it names), and a newer one
  // appends over the rows the entry already holds. A replacing page takes the
  // old selected range with it, but not the live rows the reader is already
  // watching: those have no physical index yet, so they keep the place the
  // announcement order gave them (see `placeLiveRows`).
  const pendingIds = new Set((entry.livePending ?? []).map((row) => row.id));
  const heldLive = entry.messages.filter(
    (row) => pendingIds.has(row.id) && !pageIds.has(row.id),
  );
  // The answer is the newest value for every id it names, so the rows the entry
  // already holds take the page's copy — a range that repeats what the window
  // holds still confirms a finished child row instead of leaving its stale
  // streaming copy on screen. It never appends a row: a page that does not
  // extend the window has no position to give one.
  const pageById = new Map(rows.map((row) => [row.id, row]));
  const baseRows = replaceWindow
    ? placeLiveRows(entry.messages, rows, heldLive)
    : !joins
      ? entry.messages.map((row) => pageById.get(row.id) ?? row)
      : direction === "before"
        ? dedupeSessionMessages([...rows, ...entry.messages])
        : mergePageRows(entry.messages, rows);
  // The page confirms the live rows it names; the rest are newer than this
  // read and stay until a later page names them.
  const { messages, livePending } = reconcileLiveRows(
    baseRows,
    pageIds,
    entry.livePending ?? [],
  );
  const pageContext = detail.historyContext?.length
    ? dedupeSessionMessages([...detail.historyContext])
    : [];
  const context = dedupeSessionMessages([...entry.context, ...pageContext]);
  // Run openings are physical chain facts, so a joining or replacing answer
  // only confirms them: the newest statement per Task row wins, and no page
  // can erase what another page already established. A run the entry has not
  // seen yet is added; the window, not this list, decides visibility.
  const runsById = new Map((entry.runs ?? []).map((run) => [run.taskMessageId, run]));
  for (const run of detail.historyRuns ?? []) runsById.set(run.taskMessageId, run);
  const runs = [...runsById.values()].sort((left, right) => left.taskIndex - right.taskIndex);
  const canonicalId =
    detail.historyScope?.kind === "delegation" && detail.historyScope.id
      ? detail.historyScope.id
      : entry.canonicalId;
  let aliases = aliasesWith(entry.aliases, canonicalId);
  for (const row of context) aliases = aliasesWith(aliases, delegationIdForMessage(row));
  const hasMoreBefore = replaceWindow
    ? page.hasMoreBefore === true
    : stalledBefore
      ? false
      : direction === "before"
        ? page.hasMoreBefore === true
        : entry.hasMoreBefore;
  const hasMoreAfter = replaceWindow
    ? page.hasMoreAfter === true
    : stalledAfter
      ? entry.hasMoreAfter
      : direction === "after" || direction === "latest"
        ? page.hasMoreAfter === true
        : entry.hasMoreAfter;
  return {
    ...entry,
    canonicalId,
    aliases,
    // The status describes the delegate's own conversation: root `Task`
    // records identify the chain, but a chain with no child row yet has no
    // messages to show.
    status: messages.length ? "ready" : "empty",
    messages,
    context,
    runs,
    livePending,
    messageStart: oldest?.start ?? entry.messageStart,
    messageEnd: newest?.end ?? entry.messageEnd,
    pages,
    hasMoreBefore,
    hasMoreAfter,
    laterStalled: stalledAfter ? true : undefined,
    // A live row that arrived while this read was in flight is not in its
    // answer, so the entry stays stale and the next open refreshes the tail
    // instead of trusting this read.
    finalized: entry.liveDuringRead !== true,
    liveDuringRead: false,
    refreshing: false,
    scoped:
      direction === "initial" || direction === "focus"
        ? detail.historyScope !== undefined
        : entry.scoped || detail.historyScope !== undefined,
    pendingDurable: false,
    error: undefined,
    retryDirection: undefined,
    touched,
  };
}

/**
 * Record a failed read without taking the entry's rows away.
 *
 * A chain that already holds rows stays ready and keeps them: the failure is a
 * stale detail on a still-usable panel, not a statement that the subagent is
 * gone. Only an entry with nothing to show becomes an error, and a reopen
 * retries because a failure never finalizes.
 */
export function applySubagentHistoryFailure(
  entry: SubagentHistoryEntry,
  error: string,
  direction?: SubagentHistoryDirection,
): SubagentHistoryEntry {
  return {
    ...entry,
    status: subagentHistoryHasRows(entry) ? "ready" : "error",
    error,
    retryDirection: direction,
    finalized: false,
    refreshing: false,
    pendingDurable: false,
  };
}

/**
 * Keep at most `limit` entries overall: the most recently read chains survive,
 * and a session whose every entry aged out loses its bucket.
 */
export function pruneSubagentHistory(
  buckets: SubagentHistoryBuckets,
  limit = SUBAGENT_HISTORY_LIMIT,
): SubagentHistoryBuckets {
  const entries = Object.entries(buckets).flatMap(([sessionId, bucket]) =>
    Object.entries(bucket).map(([key, entry]) => ({ sessionId, key, entry })),
  );
  if (entries.length <= limit) return buckets;
  entries.sort((left, right) => right.entry.touched - left.entry.touched);
  const next: SubagentHistoryBuckets = {};
  for (const { sessionId, key, entry } of entries.slice(0, Math.max(0, limit))) {
    const bucket = next[sessionId] ?? (next[sessionId] = {});
    bucket[key] = entry;
  }
  return next;
}

/**
 * Publish one entry into the buckets without mutating the previous map.
 *
 * The entry is stored under its own tab key; an older call id reaches it
 * through `findSubagentHistoryEntry`'s alias lookup, so one chain never
 * duplicates into two caches.
 */
export function setSubagentHistoryEntry(
  buckets: SubagentHistoryBuckets,
  entry: SubagentHistoryEntry,
  limit = SUBAGENT_HISTORY_LIMIT,
): SubagentHistoryBuckets {
  const bucket = buckets[entry.sessionId] ?? {};
  const existing = bucket[entry.tabKey];
  const nextEntry: SubagentHistoryEntry = existing
    ? { ...entry, focus: entry.focus ?? existing.focus }
    : entry;
  return pruneSubagentHistory(
    {
      ...buckets,
      [entry.sessionId]: { ...bucket, [entry.tabKey]: nextEntry },
    },
    limit,
  );
}
