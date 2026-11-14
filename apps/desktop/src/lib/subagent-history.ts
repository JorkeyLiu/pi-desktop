import type { SessionDetail, SessionHistoryScope, UiMessage } from "@pi-desktop/shared";
import { delegationHistoryScope } from "@pi-desktop/shared";
import { dedupeSessionMessages, upsertLiveSessionMessage } from "./session-transcript";
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
   * True while no live row arrived after the last durable read: the entry
   * matches the store, so reopening it costs nothing. A live row clears it,
   * and only a durable read sets it again.
   */
  finalized: boolean;
  /** True while a read of an already loaded entry is in flight. */
  refreshing: boolean;
  /** Search target this entry was opened to show, if any. */
  focus: { messageId: string; query: string; requestId: number } | null;
  /** False when the backend answered the legacy physical transcript. */
  scoped: boolean;
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
 * Stable conversation order across the chain's evidence.
 *
 * Durable pages arrive in physical order, live rows arrive in session order,
 * and a chain's root `Task` records are kept apart from its child rows; the
 * merged view has to read like one conversation. Creation time is the order
 * the backend produced the rows in, and identical stamps keep their arrival
 * order, so the merge never reshuffles rows the reader already sees.
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
 */
export function subagentHistoryMessages(
  entry: SubagentHistoryEntry | undefined,
  live: readonly UiMessage[],
): UiMessage[] {
  if (!entry) return [...live];
  const base = orderedRows(dedupeSessionMessages([...entry.context, ...entry.messages]));
  if (!live.length) return base;
  const owned = ownedChainRows(entry, live);
  if (!owned.context.length && !owned.messages.length) return base;
  const ownedIds = new Set([...owned.context, ...owned.messages].map((row) => row.id));
  let output = base;
  for (const message of live) {
    if (!ownedIds.has(message.id)) continue;
    // Live rows are authoritative for an id the cache already holds, so a
    // completed child row replaces its streaming copy.
    output = upsertLiveSessionMessage(output, message);
  }
  return orderedRows(output);
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
  if (!droppedAfterFocus) return { ...entry, messages: kept };
  const island = kept.findIndex((row) => row.id === focusId);
  const following = island >= 0 ? kept[island + 1] : undefined;
  if (!following) return { ...entry, messages: kept };
  return { ...entry, messages: kept, omittedAfterId: focusId };
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
  for (const row of owned.messages) messages = upsertLiveSessionMessage(messages, row);
  let context = entry.context;
  for (const row of owned.context) context = upsertLiveSessionMessage(context, row);
  let aliases = entry.aliases;
  for (const row of owned.context) aliases = aliasesWith(aliases, delegationIdForMessage(row));
  const changed =
    messages !== entry.messages ||
    context !== entry.context ||
    aliases.length !== entry.aliases.length ||
    entry.finalized;
  if (!changed) return undefined;
  return limitRows(
    {
      ...entry,
      messages,
      context,
      aliases,
      status: messages.length || context.length ? "ready" : entry.status,
      // Live rows arrived after the last durable read: the entry may miss
      // events, so a reopen reads the tail again instead of trusting it.
      finalized: false,
      refreshing: false,
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
  const messages =
    direction === "latest"
      ? mergeTailRows(entry.messages, rows)
      : dedupeSessionMessages([...rows, ...entry.messages]);
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
      messageStart,
      messageEnd: detail.messageEnd ?? entry.messageEnd,
      hasMoreBefore,
      hasMoreAfter,
      finalized: true,
      refreshing: false,
      scoped: initial ? detail.historyScope !== undefined : entry.scoped || detail.historyScope !== undefined,
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
  return {
    ...entry,
    canonicalId,
    aliases,
    status: messages.length ? "ready" : "empty",
    messages,
    context,
    omittedAfterId,
    messageStart: oldest?.messageStart ?? entry.messageStart,
    messageEnd: newest?.messageEnd ?? entry.messageEnd,
    hasMoreBefore: true,
    hasMoreAfter: false,
    finalized: true,
    refreshing: false,
    scoped,
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
