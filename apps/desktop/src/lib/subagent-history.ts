import type { SessionDetail, SessionHistoryScope, UiMessage } from "@pi-desktop/shared";
import { delegationHistoryScope } from "@pi-desktop/shared";
 import { dedupeSessionMessages, orderRowsByLiveAnnouncement, upsertLiveSessionMessage } from "./session-transcript";
import { subagentChainCallIds } from "./subagent-chain";
import { delegationIdForMessage } from "./subagent-panel";
import { isDelegationStartTool } from "./tool-display";

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
export const SUBAGENT_HISTORY_PAGE_SIZE = 100;
export const SUBAGENT_HISTORY_CONTENT_LIMIT = 64 * 1024;
/**
 * Rows one cached chain keeps before its oldest rows are trimmed. It sits well
 * above one page, so ordinary paging and a live tail never touch it; only a
 * chain whose live stream grew far past its page budget is trimmed, oldest
 * non-focus rows first, and the entry's older cursor is kept so paging can
 * still re-read what was trimmed.
 */
export const SUBAGENT_HISTORY_MESSAGE_LIMIT = 400;
/**
 * Backward reads one tail synchronization issues before it stops joining the
 * gap and keeps only the newest pages. A gap wider than this is not abandoned
 * silently: the window states the omission, and the rows before it stay reachable
 * through ordinary "show earlier" paging.
 */
export const SUBAGENT_HISTORY_BRIDGE_PAGES = 20;
/**
 * A tail synchronization answered without moving the bridge closer to the
 * newest rows, so continuing would repeat the same request forever.
 */
export const SUBAGENT_HISTORY_BRIDGE_STALLED =
  "Subagent history did not move closer to the newest rows.";
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
  /** Scoped child rows, in physical order. */
  messages: UiMessage[];
  /** Root `Task` records identifying the chain, outside the page budget. */
  context: UiMessage[];
  messageStart: number;
  /** Last physical index of the rows this entry holds, when the backend says. */
  messageEnd?: number;
  hasMoreBefore: boolean;
  /**
   * Whether the scope has selected rows after the newest row this entry holds.
   * Only a read that reached the scope's tail clears it; a tail synchronization
   * that could not join the gap leaves it set.
   */
  hasMoreAfter: boolean;
  /**
   * The first row of a run that is not adjacent to the previous rendered row:
/**
   * The retained row after which rows were omitted: a trimmed focus island, or
   * a tail synchronization that kept only the newest pages. The view states the
   * omission there instead of presenting the two ranges as one conversation.
   */
  omittedAfterId?: string;
  /**
   * Live rows this chain routed in that no durable page has confirmed yet,
   * oldest first, always a subset of `messages`.
   *
   * A running child row exists only in the parent's live array until its tool
   * ends, so a read issued before that end cannot contain it. Keeping the
   * unconfirmed rows here is what lets every durable merge — including the
   * window replacement a wide gap forces — put them back instead of erasing a
   * row the reader is watching. A page that names the row confirms it, and the
   * live copy retires exactly once. A call appears here once, holding the state
   * its latest live event published, so repeated publications cannot grow it.
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

/** The direction one page tightens: its own window, older rows, or the tail. */
export type SubagentHistoryDirection = "initial" | "before" | "latest";

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
    messageStart: 0,
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
  * name stay on it (paging, focus islands, and context keep the semantics the
  * existing scoped-history tests pin down). It is not the tool order
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
  * creation-time order the existing scoped-history tests pin down, so paging,
  * focus islands, and context keep their semantics. The live overlay
  * (`orderRowsByLiveAnnouncement`) owns rows the live tail names: they keep
  * the first-announcement order the transcript already showed, because
  * completion re-stamps `createdAt` and durable pages arrive in finish order.
  * For those live-named rows `createdAt` is display metadata, never a
  * position key — a re-stamp or refresh only replaces values. Live rows stay
  * authoritative for an id the cache already holds, so a completed child row
  * replaces its streaming copy.
  */
 export function subagentHistoryMessages(
   entry: SubagentHistoryEntry | undefined,
   live: readonly UiMessage[],
 ): UiMessage[] {
  if (!entry) return [...live];
  // Chronological history baseline first: the entry's own order already
  // carries live announcement order for ingested rows, but paging prepends
  // older pages ahead of focus islands, so the baseline must be restored by
  // creation time. Completion re-stamps `createdAt` on the same id, so the
  // baseline sort below only runs over rows the live tail does not name —
  // live-named rows keep their entry slots here and the overlay restores
  // their announcement order next. Either set alone would regress the other:
  // a full re-sort moves a re-stamped A after B, entry order alone strands
  // a paged focus island behind its older page.
  const base = dedupeSessionMessages([...entry.context, ...entry.messages]);
  if (!live.length) return orderedRows(base);
  const owned = ownedChainRows(entry, live);
  if (!owned.context.length && !owned.messages.length) return orderedRows(base);
  const ownedIds = new Set([...owned.context, ...owned.messages].map((row) => row.id));
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
  * Trim the oldest rows of a chain that grew past its row budget.
  *
  * The focus row is kept wherever it sits, so trimming can leave it as an island
  * with a hole after it. That hole is recorded rather than hidden: the entry then
  * names the first row of the retained run that follows the island, and the view
  * states the omission there. A trim that only drops rows before every kept row
  * keeps the range contiguous, and no marker is set.
  */
function limitRows(entry: SubagentHistoryEntry, limit: number): SubagentHistoryEntry {
  if (limit <= 0 || entry.messages.length <= limit) return entry;
  const focusId = entry.focus?.messageId;
  const focusIndex = focusId ? entry.messages.findIndex((row) => row.id === focusId) : -1;
  const kept: UiMessage[] = [];
  let excess = entry.messages.length - limit;
  let droppedAfterFocus = false;
  for (const [index, row] of entry.messages.entries()) {
    if (excess > 0 && row.id !== focusId) {
      excess -= 1;
      if (focusIndex >= 0 && index > focusIndex) droppedAfterFocus = true;
      continue;
    }
    kept.push(row);
  }
  const keptIds = new Set(kept.map((row) => row.id));
  const trimmed: SubagentHistoryEntry = {
    ...entry,
    messages: kept,
    // An unconfirmed row is always one of the rows, so a trim bounds both.
    livePending: (entry.livePending ?? []).filter((row) => keptIds.has(row.id)),
  };
  if (!droppedAfterFocus) return trimmed;
  const island = kept.findIndex((row) => row.id === focusId);
  const following = island >= 0 ? kept[island + 1] : undefined;
  if (!following) return trimmed;
  return { ...trimmed, omittedAfterId: focusId };
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
 * Retention is bounded by the row budget (`limitRows`): pending holds one
 * version per call and always a subset of `messages`, so a chain that keeps
 * streaming cannot accumulate rows past its own window. Pending state only
 * spans the distance between a live event and the durable row that records the
 * same call.
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
  limit = SUBAGENT_HISTORY_MESSAGE_LIMIT,
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
  return limitRows(
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

/** The tail page merged over what the entry already holds. */
function mergeTailRows(existing: readonly UiMessage[], page: readonly UiMessage[]): UiMessage[] {
  if (!page.length) return [...existing];
  if (!existing.length) return dedupeSessionMessages([...page]);
  const pageById = new Map(page.map((row) => [row.id, row]));
  const held = new Set(existing.map((row) => row.id));
  const next = existing.map((row) => pageById.get(row.id) ?? row);
  for (const row of page) if (!held.has(row.id)) next.push(row);
  return dedupeSessionMessages(next);
}

/**
 * Apply one scoped read to an entry.
 *
 * Reads never erase: an `initial` page, an older page, and a tail refresh all
 * merge onto the rows the entry already owns, so a read that lands while a
 * live row was already routed in cannot take that row away. `initial` adopts
 * the page's own cursor and adopts the echoed canonical identity; `before`
 * moves the older cursor backward; `latest` replaces overlapping ids with the
 * durable version, appends the ids the entry did not hold yet, and adopts the
 * newer cursor, `hasMoreAfter`, and the tail's `messageEnd`.
 *
 * Root `Task` rows identify the chain and sit outside its page budget, so
 * context merges monotonically rather than resetting on a page that omits it.
 * An empty page is a legitimate state for this scope — a delegate that never
 * produced a row — while an entry that already holds rows stays ready.
 */
export function applySubagentHistoryPage(
  entry: SubagentHistoryEntry,
  detail: SessionDetail,
  direction: SubagentHistoryDirection,
  touched: number,
): SubagentHistoryEntry {
  const rows = detail.messages ?? [];
  const initial = direction === "initial";
  const merged =
    direction === "latest"
      ? mergeTailRows(entry.messages, rows)
      : dedupeSessionMessages([...rows, ...entry.messages]);
  // The page confirms the live rows it names; the rest are newer than this
  // read and stay until a later page names them.
  const { messages, livePending } = reconcileLiveRows(
    merged,
    new Set(rows.map((row) => row.id)),
    entry.livePending ?? [],
  );
  const pageContext = detail.historyContext?.length
    ? dedupeSessionMessages([...detail.historyContext])
    : [];
  const context = dedupeSessionMessages([...entry.context, ...pageContext]);
  const canonicalId =
    detail.historyScope?.kind === "delegation" && detail.historyScope.id
      ? detail.historyScope.id
      : entry.canonicalId;
  let aliases = aliasesWith(entry.aliases, canonicalId);
  for (const row of context) aliases = aliasesWith(aliases, delegationIdForMessage(row));
  const pageStart = detail.messageStart;
  let messageStart = entry.messageStart;
  if (initial) {
    messageStart = pageStart ?? entry.messageStart;
  } else if (pageStart !== undefined) {
    // The older cursor follows the oldest row actually known; a tail read
    // must not move it forward and strand the rows already loaded.
    messageStart = entry.messages.length ? Math.min(pageStart, entry.messageStart) : pageStart;
  }
  const hasMoreBefore = initial
    ? detail.hasMoreBefore === true
    : direction === "before"
      ? detail.hasMoreBefore === true
      : entry.messages.length
        ? entry.hasMoreBefore
        : detail.hasMoreBefore === true;
  // Only the read that moved forward knows what follows it: an older page keeps
  // the entry's own forward knowledge, and a tail read states the real tail.
  const hasMoreAfter =
    direction === "before" ? entry.hasMoreAfter : detail.hasMoreAfter === true;
  return limitRows(
    {
      ...entry,
      canonicalId,
      aliases,
      // The status describes the delegate's own conversation: root `Task`
      // records identify the chain, but a chain with no child row yet has no
      // messages to show.
      status: messages.length ? "ready" : "empty",
      messages,
      context,
      livePending,
      messageStart,
      messageEnd: detail.messageEnd ?? entry.messageEnd,
      hasMoreBefore,
      hasMoreAfter,
      // A live row that arrived while this read was in flight is not in its
      // answer, so the entry stays stale and the next open refreshes the tail
      // instead of trusting this read.
      finalized: entry.liveDuringRead !== true,
      liveDuringRead: false,
      refreshing: false,
      scoped: initial
        ? detail.historyScope !== undefined
        : entry.scoped || detail.historyScope !== undefined,
      pendingDurable: false,
      error: undefined,
      retryDirection: undefined,
      touched,
    },
    SUBAGENT_HISTORY_MESSAGE_LIMIT,
  );
}

/**
 * Keep the newest contiguous pages one tail synchronization walked.
 *
 * A gap wider than a single synchronization may join would otherwise force
 * either an unbounded chain of reads or a silently incomplete history, so the
 * entry keeps a contiguous newest window instead: it reaches the scope's tail,
 * its rows are adjacent to each other, and the entry's older cursor moves to
 * the window's first page so ordinary "show earlier" paging re-reads the rows
 * the window left out. The search focus survives as its own retained row, and
 * the entry names the omission the view must state rather than presenting two
 * non-adjacent ranges as one conversation. The previously loaded rows are the
 * ones the window drops; nothing claims the scope starts there.
 */
export function applySubagentHistoryTailWindow(
  entry: SubagentHistoryEntry,
  pages: readonly SessionDetail[],
  touched: number,
): SubagentHistoryEntry {
  const focusId = entry.focus?.messageId;
  const focusRow = focusId ? entry.messages.find((row) => row.id === focusId) : undefined;
  // The window leaves room for one more older page and for the focus row itself,
  // so the next explicit "show earlier" adds to the retained range instead of
  // immediately trimming the rows it just read. One page is always kept.
  const windowBudget =
    SUBAGENT_HISTORY_MESSAGE_LIMIT - SUBAGENT_HISTORY_PAGE_SIZE - 1;
  const retained: SessionDetail[] = [];
  let retainedRows = 0;
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const size = (pages[index].messages ?? []).length;
    if (retained.length && retainedRows + size > windowBudget) break;
    retained.unshift(pages[index]);
    retainedRows += size;
  }
  let messages = dedupeSessionMessages(retained.flatMap((page) => page.messages ?? []));
  // A focus row outside the window is retained as its own range and needs a slot
  // of its own: drop the window's oldest page rather than exceeding the budget.
  while (
    retained.length > 1 &&
    messages.length >= SUBAGENT_HISTORY_MESSAGE_LIMIT - 1 &&
    focusRow &&
    !messages.some((row) => row.id === focusRow.id)
  ) {
    retained.shift();
    messages = dedupeSessionMessages(retained.flatMap((page) => page.messages ?? []));
  }
  const oldest = retained[0] ?? pages[0];
  const newest = retained[retained.length - 1] ?? pages[pages.length - 1];
  let context = entry.context;
  let aliases = entry.aliases;
  let canonicalId = entry.canonicalId;
  let scoped = entry.scoped;
  for (const page of pages) {
    context = dedupeSessionMessages([...context, ...(page.historyContext ?? [])]);
    if (page.historyScope?.kind === "delegation" && page.historyScope.id) {
      canonicalId = page.historyScope.id;
    }
    scoped = scoped || page.historyScope !== undefined;
  }
  for (const row of context) aliases = aliasesWith(aliases, delegationIdForMessage(row));
  aliases = aliasesWith(aliases, canonicalId);
  let omittedAfterId: string | undefined;
  if (focusRow && !messages.some((row) => row.id === focusRow.id)) {
    messages = [focusRow, ...messages];
    omittedAfterId = focusRow.id;
  }
  // Every page the walk read confirms the rows it named, including pages the
  // window itself could not keep. A live row none of them named has no durable
  // copy yet, so it is put back after the retained run instead of erased by
  // the replacement.
  const confirmed = new Set(
    pages.flatMap((page) => (page.messages ?? []).map((row) => row.id)),
  );
  const reconciled = reconcileLiveRows(messages, confirmed, entry.livePending ?? []);
  return {
    ...entry,
    canonicalId,
    aliases,
    status: reconciled.messages.length ? "ready" : "empty",
    messages: reconciled.messages,
    context,
    livePending: reconciled.livePending,
    omittedAfterId,
    messageStart: oldest?.messageStart ?? entry.messageStart,
    messageEnd: newest?.messageEnd ?? entry.messageEnd,
    hasMoreBefore: true,
    hasMoreAfter: false,
    // A window that predates a live row does not finalize the entry: the next
    // open reads the tail again instead of trusting it.
    finalized: entry.liveDuringRead !== true,
    liveDuringRead: false,
    refreshing: false,
    scoped,
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
