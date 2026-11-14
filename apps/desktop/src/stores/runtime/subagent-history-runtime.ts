import type { SessionDetail, SessionHistoryScope, UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import {
  applySubagentHistoryFailure,
  applySubagentHistoryPage,
  applySubagentHistoryTailWindow,
  applySubagentLiveRows,
  createSubagentHistoryEntry,
  findSubagentHistoryEntry,
  setSubagentHistoryEntry,
  SUBAGENT_HISTORY_BRIDGE_PAGES,
  SUBAGENT_HISTORY_BRIDGE_STALLED,
  SUBAGENT_HISTORY_CONTENT_LIMIT,
  SUBAGENT_HISTORY_PAGE_SIZE,
  SUBAGENT_HISTORY_UNAVAILABLE,
  subagentHistoryHasRows,
  subagentHistoryLiveIds,
  subagentHistoryScope,
  subagentHistoryTouchesLive,
  type SubagentHistoryBuckets,
  type SubagentHistoryDirection,
  type SubagentHistoryEntry,
} from "../../lib/subagent-history";
import type { AppState } from "../app-state";
import type { StoreAccess } from "../slices/types";

/**
 * The independent delegate-history source.
 *
 * A delegation tab owns one entry per session and chain: it reads the chain's
 * own scope, paginates it, keeps what it read when the main transcript's
 * window is replaced, reduced, or restored, and owns the live rows the parent's
 * event stream produced for that chain. Nothing here derives availability from
 * the main transcript viewport — that is the whole point of the split — and
 * every request is keyed by the entry identity it was issued for, so a late
 * answer for a previous tab or session cannot overwrite a newer view.
 */

export type SubagentHistoryReadOptions = {
  historyScope: SessionHistoryScope;
  messageBefore?: number;
  messageAround?: string;
  messageLimit?: number;
  contentLimit?: number;
};

export type SubagentHistoryRead = (
  id: string,
  options: SubagentHistoryReadOptions,
) => Promise<{ session: SessionDetail | null }>;

export type SubagentHistoryInput = { sessionId: string; tabKey: string };

export type SubagentHistoryFocus = { messageId?: string; query?: string; requestId?: number };

export type SubagentHistoryActions = {
  /** Open (or reuse) the chain's history, optionally centered on a message. */
  ensureSubagentHistory: (input: SubagentHistoryInput & SubagentHistoryFocus) => Promise<void>;
  /** Read one older page of the entry's own scope. */
  loadOlderSubagentHistory: (input: SubagentHistoryInput) => Promise<void>;
  /** Read the scope's newest page and merge it over what the entry holds. */
  loadLatestSubagentHistory: (input: SubagentHistoryInput) => Promise<void>;
  /** Read again after a failure; the failed read's own direction is repeated. */
  retrySubagentHistory: (input: SubagentHistoryInput) => Promise<void>;
};

export function createSubagentHistoryRuntime(
  { get, set }: StoreAccess,
  read: SubagentHistoryRead = (id, options) => api.getSession(id, options),
) {
  let touched = 0;
  const inflight = new Map<string, Promise<void>>();
  /**
   * The read generation per chain. A newer read supersedes an older one, and a
   * live publication never does: routing a live row in between request and
   * answer must not throw the durable answer away.
   */
  const generations = new Map<string, number>();
  /** The live array the last publication already routed, per active session. */
  let ingestedSessionId: string | null = null;
  let ingestedLive: readonly UiMessage[] | null = null;

  const keyOf = (input: SubagentHistoryInput) => `${input.sessionId}\u0000${input.tabKey}`;

  /** Publish one entry and return it as stored (its touch order included). */
  function publish(entry: SubagentHistoryEntry): SubagentHistoryEntry {
    touched += 1;
    const nextEntry: SubagentHistoryEntry = { ...entry, touched };
    set({ subagentHistory: setSubagentHistoryEntry(get().subagentHistory, nextEntry) });
    return nextEntry;
  }

  function entryFor(input: SubagentHistoryInput): SubagentHistoryEntry | undefined {
    return findSubagentHistoryEntry(get().subagentHistory, input.sessionId, input.tabKey);
  }

  function beginRead(key: string): number {
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    return generation;
  }

  /**
   * One read of the entry's scope. The answer applies only to the entry it was
   * issued for: a newer read, a released session, or a closed tab replaces that
   * entry's generation, and an answer issued for the previous one is dropped
   * instead of merged. A live publication in between keeps the generation, so
   * its durable answer still lands.
   */
  /**
   * Open one read of the entry's scope and publish the in-flight state.
   *
   * The answer applies only to the entry it was issued for: a newer read, a
   * released session, or a closed tab replaces that entry's generation, and an
   * answer issued for the previous one is dropped instead of merged. A live
   * publication in between keeps the generation, so its durable answer still
   * lands.
   */
  function openRead(input: SubagentHistoryInput, seed?: Partial<SubagentHistoryEntry>) {
    const previous = entryFor(input);
    const key = keyOf(input);
    const generation = beginRead(key);
    const hasRows = subagentHistoryHasRows(previous);
    const pending = publish(
      previous
        ? {
            ...previous,
            ...seed,
            error: undefined,
            refreshing: true,
            // A pending read never blanks a loaded panel: the rows stay readable
            // while the entry's own state says a read is in flight.
            ...(hasRows ? {} : { status: "loading" as const }),
          }
        : { ...createSubagentHistoryEntry(input.sessionId, input.tabKey), ...seed },
    );
    return {
      pending,
      /** The entry this read may still write to, or undefined when superseded. */
      current: (): SubagentHistoryEntry | undefined => {
        const entry = entryFor(input);
        if (!entry || entry.tabKey !== pending.tabKey) return undefined;
        if (generations.get(key) !== generation) return undefined;
        return entry;
      },
    };
  }

  /** Record a failed read of the entry as it stands now. */
  function failRead(input: SubagentHistoryInput, detail: unknown, direction: SubagentHistoryDirection) {
    const current = entryFor(input);
    if (!current) return;
    publish(
      applySubagentHistoryFailure(
        current,
        detail instanceof Error ? detail.message : String(detail),
        direction,
      ),
    );
  }

  async function readPage(
    input: SubagentHistoryInput,
    direction: SubagentHistoryDirection,
    options: SubagentHistoryReadOptions,
    seed?: Partial<SubagentHistoryEntry>,
  ) {
    const { current } = openRead(input, seed);
    try {
      const { session } = await read(input.sessionId, options);
      const entry = current();
      if (!entry) return;
      if (!session) {
        publish(applySubagentHistoryFailure(entry, SUBAGENT_HISTORY_UNAVAILABLE, direction));
        return;
      }
      publish(applySubagentHistoryPage(entry, session, direction, entry.touched));
    } catch (error) {
      if (!current()) return;
      failRead(input, error, direction);
    }
  }

  function pageOptions(entry: SubagentHistoryEntry): SubagentHistoryReadOptions {
    return {
      historyScope: subagentHistoryScope(entry),
      messageLimit: SUBAGENT_HISTORY_PAGE_SIZE,
      contentLimit: SUBAGENT_HISTORY_CONTENT_LIMIT,
    };
  }

  /**
   * Tail synchronization: read the scope's newest page and join the rows between
   * it and the rows the entry already holds.
   *
   * A forward read has no cursor of its own, so a tail that sits past the entry's
   * own physical range would leave the rows in between unrepresented: the panel
   * would show the target range, then jump to the newest one, and ordinary older
   * paging walks the wrong way. The bridge therefore reads backward from the
   * newest page with the existing physical `messageBefore` cursor until its
   * range meets the range the entry holds (an overlap, or the scope's head),
   * then merges the walked pages oldest first. Every merged page is adjacent to
   * the next one in the selection, the entry's older cursor does not move, and
   * `hasMoreAfter` is cleared only by a read that really reached the tail.
   *
   * The walk is bounded: each answer must move the cursor toward the entry, so
   * a repeated or empty page stops the synchronization with an explicit error
   * that leaves the loaded rows and a retry intact. A gap wider than the walk
   * bound keeps a contiguous newest window instead and records the omission,
   * rather than dropping the middle rows without saying so.
   */
  async function latest(input: SubagentHistoryInput) {
    const previous = entryFor(input);
    if (!previous || previous.refreshing || previous.status === "loading") return;
    const { current } = openRead(input);
    try {
      const newest = await read(input.sessionId, pageOptions(previous));
      let entry = current();
      if (!entry) return;
      if (!newest.session) {
        publish(applySubagentHistoryFailure(entry, SUBAGENT_HISTORY_UNAVAILABLE, "latest"));
        return;
      }
      const head = newest.session;
      const heldEnd = entry.messageEnd;
      const headStart = head.messageStart;
      if (
        !entry.messages.length ||
        heldEnd === undefined ||
        headStart === undefined ||
        headStart <= heldEnd
      ) {
        // The entry's own range already reaches the newest page, or it holds
        // nothing to bridge from.
        publish(applySubagentHistoryPage(entry, head, "latest", entry.touched));
        return;
      }
      // Walked pages, oldest first. The newest page ends at the scope's tail.
      const walked: SessionDetail[] = [head];
      let cursor = headStart;
      let joined = false;
      for (let attempt = 0; attempt < SUBAGENT_HISTORY_BRIDGE_PAGES; attempt += 1) {
        const answer = await read(input.sessionId, {
          ...pageOptions(entry),
          messageBefore: cursor,
        });
        entry = current();
        if (!entry) return;
        if (!answer.session) {
          publish(applySubagentHistoryFailure(entry, SUBAGENT_HISTORY_UNAVAILABLE, "latest"));
          return;
        }
        const page = answer.session;
        const pageStart = page.messageStart;
        const pageEnd = page.messageEnd;
        if (!page.messages?.length || pageStart === undefined) {
          publish(applySubagentHistoryFailure(entry, SUBAGENT_HISTORY_BRIDGE_STALLED, "latest"));
          return;
        }
        walked.unshift(page);
        // Overlap with the rows the entry holds, or the scope's head, means the
        // walked range now joins the entry's range without a hole.
        if (
          (pageEnd !== undefined && pageEnd <= heldEnd) ||
          page.hasMoreBefore === false
        ) {
          joined = true;
          break;
        }
        if (pageStart >= cursor) {
          publish(applySubagentHistoryFailure(entry, SUBAGENT_HISTORY_BRIDGE_STALLED, "latest"));
          return;
        }
        cursor = pageStart;
      }
      entry = current();
      if (!entry) return;
      if (!joined) {
        publish(applySubagentHistoryTailWindow(entry, walked, entry.touched));
        return;
      }
      let merged = entry;
      for (const page of walked) merged = applySubagentHistoryPage(merged, page, "latest", entry.touched);
      // Only a joined walk may state that nothing follows the newest row.
      publish({ ...merged, hasMoreAfter: false });
    } catch (error) {
      if (!current()) return;
      failRead(input, error, "latest");
    }
  }

  async function ensure(input: SubagentHistoryInput & SubagentHistoryFocus) {
    const current = entryFor(input);
    const focus = input.messageId
      ? {
          messageId: input.messageId,
          query: input.query ?? "",
          requestId: input.requestId ?? 0,
        }
      : null;
    // A target the page already holds needs no read: the tab highlights the row
    // it has instead of replacing the range around it.
    if (current && focus && current.messages.some((message) => message.id === focus.messageId)) {
      publish({ ...current, focus });
      return;
    }
    if (current?.status === "loading") return;
    if (current && current.status !== "error" && current.finalized) {
      // Nothing happened to this chain since its last durable read, so a
      // reopened tab costs nothing and main-window browsing never triggers a
      // delegate read. A search target outside what it holds still reads the
      // range around the target, and never the whole chain.
      if (!focus) return;
    }
    // Sending a refresh rather than a reset keeps everything the entry already
    // holds: a stale entry refreshes its tail, an empty one starts at the tail.
    const base = current ?? createSubagentHistoryEntry(input.sessionId, input.tabKey);
    if (focus) {
      // A target this chain does not hold yet needs the range around it; the
      // page merges over the rows already loaded, so neither the target view
      // nor the older rows are lost.
      await readPage(
        input,
        "initial",
        { ...pageOptions(base), messageAround: focus.messageId },
        { focus },
      );
      return;
    }
    // Sending a refresh rather than a reset keeps everything the entry already
    // holds: a stale entry refreshes its tail, an empty one starts there.
    if (subagentHistoryHasRows(base)) {
      await readPage(input, "latest", pageOptions(base));
      return;
    }
    await readPage(input, "initial", pageOptions(base));
  }

  async function older(input: SubagentHistoryInput) {
    const current = entryFor(input);
    if (!current || current.refreshing || current.status === "loading") return;
    if (!current.hasMoreBefore) return;
    await readPage(input, "before", { ...pageOptions(current), messageBefore: current.messageStart });
  }

  function run(input: SubagentHistoryInput, task: () => Promise<void>) {
    const key = keyOf(input);
    const running = inflight.get(key);
    if (running) return running;
    const request = task().finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
    inflight.set(key, request);
    return request;
  }

  const actions: SubagentHistoryActions = {
    ensureSubagentHistory: (input) => run(input, () => ensure(input)),
    loadOlderSubagentHistory: (input) => run(input, () => older(input)),
    loadLatestSubagentHistory: (input) => run(input, () => latest(input)),
    retrySubagentHistory: (input) =>
      run(input, async () => {
        const current = entryFor(input);
        if (!current) {
          await ensure(input);
          return;
        }
        // Retry repeats the read that failed: an older page, a tail refresh, or
        // the entry's first page. A failed read never finalized, so `ensure`
        // refreshes a loaded entry instead of trusting it.
        if (current.retryDirection === "before" && current.hasMoreBefore) {
          await older(input);
          return;
        }
        if (current.retryDirection === "latest" && subagentHistoryHasRows(current)) {
          await latest(input);
          return;
        }
        await ensure({ sessionId: input.sessionId, tabKey: input.tabKey });
      }),
  };

  /**
   * Route the live rows of the active conversation into the chains that own
   * them.
   *
   * The parent's live array is the only place a running delegate's rows exist
   * before a durable read. Persisting the rows a chain owns at publication time
   * is what makes the delegate cache independent of the main transcript: the
   * window can be replaced, reduced, paged, or restored without taking a
   * loaded or still-streaming child row out of its own panel.
   *
   * Only chains that already have an entry are considered — an unopened
   * delegate costs nothing — and a chain the update cannot name is skipped
   * before any chain resolution.
   */
  function ingest(state: AppState) {
    const sessionId = state.activeSessionId;
    const live = state.messages;
    if (!sessionId || !live.length) return;
    if (ingestedSessionId === sessionId && ingestedLive === live) return;
    ingestedSessionId = sessionId;
    ingestedLive = live;
    const bucket = get().subagentHistory[sessionId];
    if (!bucket) return;
    const liveIds = subagentHistoryLiveIds(live);
    let buckets: SubagentHistoryBuckets | undefined;
    for (const entry of Object.values(bucket)) {
      if (!subagentHistoryTouchesLive(entry, liveIds)) continue;
      const applied = applySubagentLiveRows(entry, live);
      if (!applied) continue;
      touched += 1;
      buckets = setSubagentHistoryEntry(buckets ?? get().subagentHistory, {
        ...applied,
        touched,
      });
    }
    if (buckets) set({ subagentHistory: buckets });
  }

  /** Drop every cached delegate page of one session (session delete). */
  function releaseSession(sessionId: string) {
    const buckets: SubagentHistoryBuckets = get().subagentHistory;
    if (!buckets[sessionId]) return;
    const { [sessionId]: _released, ...rest } = buckets;
    set({ subagentHistory: rest });
  }

  /** The entry for one chain of one session, without a tab identity alias. */
  function entryForSessionChain(state: AppState, sessionId: string, tabKey: string) {
    return findSubagentHistoryEntry(state.subagentHistory, sessionId, tabKey);
  }

  return { actions, ingest, releaseSession, entryForSessionChain };
}
