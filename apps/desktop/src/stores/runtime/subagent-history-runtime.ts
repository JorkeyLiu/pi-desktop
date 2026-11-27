import type { SessionDetail, SessionHistoryScope, UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import {
  applySubagentHistoryFailure,
  applySubagentHistoryPage,
  applySubagentLiveRows,
  createSubagentHistoryEntry,
  findSubagentHistoryEntry,
  setSubagentHistoryEntry,
  SUBAGENT_HISTORY_CONTENT_LIMIT,
  SUBAGENT_HISTORY_LIVE_TAIL_LIMIT,
  SUBAGENT_HISTORY_PAGE_SIZE,
  SUBAGENT_HISTORY_UNAVAILABLE,
  subagentHistoryHasRows,
  subagentHistoryHoldsWindowRow,
  subagentHistoryLiveIds,
  subagentHistoryLiveTailRows,
  subagentHistoryScope,
  subagentHistoryTouchesLive,
  subagentHistoryLiveTaskState,
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
  /** Read one newer page of the entry's own scope, at the boundary. */
  loadNewerSubagentHistory: (input: SubagentHistoryInput) => Promise<void>;
  /** Read the scope's newest page: joined when adjacent, replaced when not. */
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
  /** The live array of the conversation a read belongs to, if it is on screen. */
  function liveOf(sessionId: string): readonly UiMessage[] {
    const state = get();
    return state.activeSessionId === sessionId ? state.messages : [];
  }

  /**
   * Whether an empty answer is a chain still being created rather than a miss.
   *
   * The backend selects a delegation chain from durable `Task` rows, and the
   * parent publishes that dispatch live before the persistence outbox appends
   * it. A running dispatch is therefore a chain that is still being created, not
   * a chain the transcript no longer holds, and `false` keeps every other empty
   * answer a real miss.
   *
   * Once an entry is already owed its first durable page, an answer that cannot
   * observe the dispatch at all (`absent`) keeps it owed too: the reader's own
   * window may have moved past the `Task` row while the chain is still live, and
   * the chain demonstrably existed. Ending that state needs the dispatch observed
   * settled, which is what makes a still-empty transcript a real miss.
   */
  function firstPagePending(entry: SubagentHistoryEntry, live: readonly UiMessage[]): boolean {
    if (entry.scoped === true) return false;
    const task = subagentHistoryLiveTaskState(entry, live);
    if (task === "running") return true;
    return task === "absent" && entry.pendingDurable === true;
  }

  function beginRead(key: string): number {
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    return generation;
  }

  /** Whether this entry holds live rows but has never had a durable page. */
  function firstDurablePageOwed(entry: SubagentHistoryEntry): boolean {
    return entry.pendingDurable === true && entry.scoped !== true;
  }

  /**
   * Open one read of the entry's scope and publish the in-flight state.
   *
   * The answer applies only to the entry it was issued for: a newer read, a
   * released session, or a closed tab replaces that entry's generation, and an
   * answer issued for the previous one is dropped instead of merged. A live
   * publication in between keeps the generation, so its durable answer still
   * lands. `refreshing` belongs to this read alone: live ingestion preserves it,
   * so a second read cannot start over the first one.
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
    const live = liveOf(input.sessionId);
    const { current } = openRead(input, seed);
    try {
      const { session } = await read(input.sessionId, options);
      const entry = current();
      if (!entry) return;
      if (!session) {
        // A live dispatch whose durable record is still in the persistence
        // outbox is not a missing chain: keep the live rows and read the first
        // durable page once that dispatch settles.
        if (firstPagePending(entry, live)) {
          publish({
            ...entry,
            // The live dispatch and its rows are already readable, so this is
            // not a loading panel: the durable page is merely still owed.
            status: "ready",
            error: undefined,
            retryDirection: undefined,
            pendingDurable: true,
            finalized: false,
            refreshing: false,
          });
          return;
        }
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
   * The one explicit transition to the scope's tail.
   *
   * It reads the newest page and hands it to the window: an answer that
   * overlaps what the entry holds without reaching past its end is joined to
   * it, one that covers the held range through a newer end collapses to the
   * newest page, and one that does not overlap starts a fresh tail window. The
   * entry therefore either stays one
   * contiguous interval or replaces it — never a target range followed by a
   * distant newest one — and the renderer scrolls to the rows this read
   * selected rather than to the bottom of what it held before.
   */
  async function latest(input: SubagentHistoryInput, supersede = false) {
    const previous = entryFor(input);
    // An explicit jump supersedes a read that is still in flight: the reader
    // asked for the tail, so the older answer cannot decide the window. Any
    // other latest read waits for the read it would otherwise duplicate.
    if (!previous || (!supersede && (previous.refreshing || previous.status === "loading"))) return;
    const { current } = openRead(input);
    try {
      const newest = await read(input.sessionId, pageOptions(previous));
      const entry = current();
      if (!entry) return;
      if (!newest.session) {
        publish(applySubagentHistoryFailure(entry, SUBAGENT_HISTORY_UNAVAILABLE, "latest"));
        return;
      }
      publish(applySubagentHistoryPage(entry, newest.session, "latest", entry.touched));
    } catch (error) {
      if (!current()) return;
      failRead(input, error, "latest");
    }
  }

  /**
   * Read the page that follows the window, the direction the main transcript
   * pages when the reader reaches its bottom.
   *
   * A scoped page is selected from a physical `messageBefore` cursor, so the
   * next page is asked for from the window's own exclusive end plus one page —
   * the bound a sparse selection needs to reach rows beyond the held range. A
   * backend that answered the legacy physical transcript, or a window without a
   * reliable end, is never handed arithmetic on a number it did not state:
   * those reads degrade to the explicit latest read, exactly as the main
   * reader's own tail resync does.
   */
  async function newer(input: SubagentHistoryInput) {
    const current = entryFor(input);
    if (!current || current.refreshing || current.status === "loading") return;
    if (!current.hasMoreAfter) return;
    if (current.scoped !== true || current.messageEnd === undefined) {
      await latest(input);
      return;
    }
    await readPage(input, "after", {
      ...pageOptions(current),
      messageBefore: current.messageEnd + SUBAGENT_HISTORY_PAGE_SIZE,
    });
  }

  /**
   * The cursor one older read pages from, or `undefined` when the answer gave
   * none. A backend whose cursor is opaque still answers with the cursor to
   * hand back; a window with no cursor has no pageable history, so no read is
   * spent guessing at one.
   */
  function olderCursor(entry: SubagentHistoryEntry): number | undefined {
    return entry.messageStart > 0 ? entry.messageStart : undefined;
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
    // A target the rendered window already holds needs no read: the tab
    // highlights the row it has instead of replacing the range around it. An
    // owned row outside that window — a live row past a historical range — is
    // not presented, so it is read around like any other target.
    if (current && focus && subagentHistoryHoldsWindowRow(current, focus.messageId)) {
      publish({ ...current, focus });
      return;
    }
    if (current?.status === "loading" && !firstDurablePageOwed(current)) return;
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
      // A target this chain does not hold yet needs the range around it. The
      // answer starts a window there instead of joining a distant loaded
      // range: one contiguous interval, centred on the row the reader asked
      // for, and the rows after it are paged forward from this window.
      await readPage(
        input,
        "focus",
        { ...pageOptions(base), messageAround: focus.messageId },
        { focus },
      );
    } else if (subagentHistoryHasRows(base) && !firstDurablePageOwed(base)) {
      // Sending a refresh rather than a reset keeps the rows the entry holds
      // when the newest page joins them, and replaces a range that no longer
      // reaches the tail.
      await readPage(input, "latest", pageOptions(base));
    } else {
      // Live rows are not a physical range, so the chain's first durable page
      // must adopt the page's own cursor instead of refining one it never read.
      await readPage(input, "initial", pageOptions(base));
    }
    // A dispatch that settled while the read was in flight is exactly the
    // transition that puts its durable row in the outbox. Read the first durable
    // page once more instead of leaving the pending answer on screen until the
    // reader reopens the tab.
    const afterRead = entryFor(input);
    if (
      afterRead?.pendingDurable === true &&
      afterRead.scoped !== true &&
      subagentHistoryLiveTaskState(afterRead, liveOf(input.sessionId)) === "settled"
    ) {
      await readPage(input, "initial", pageOptions(afterRead));
    }
  }

  async function older(input: SubagentHistoryInput) {
    const current = entryFor(input);
    if (!current || current.refreshing || current.status === "loading") return;
    if (!current.hasMoreBefore) return;
    // The window's own oldest bound is the answer's cursor, handed straight
    // back to the backend that stated it. A window that has none cannot page
    // older rows without inventing a position, so it spends no read.
    const cursor = olderCursor(current);
    if (cursor === undefined) return;
    await readPage(input, "before", { ...pageOptions(current), messageBefore: cursor });
  }

  /**
   * Start one read and register its own promise under the chain.
   *
   * Each read deletes only its own entry, so a request that started while an
   * older one was still outstanding cannot be unregistered by that older read
   * when it finally settles.
   */
  function startRead(input: SubagentHistoryInput, task: () => Promise<void>) {
    const key = keyOf(input);
    const request = task().finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
    inflight.set(key, request);
    return request;
  }

  /**
   * Join the read already in flight for this chain.
   *
   * Two automatic reads of the same direction are one read: a scroll that
   * repeats a boundary request joins the page already being fetched. Only an
   * explicit request that must not be joined with an older one (`startRead`)
   * starts a second.
   */
  function run(input: SubagentHistoryInput, task: () => Promise<void>) {
    const running = inflight.get(keyOf(input));
    if (running) return running;
    return startRead(input, task);
  }

  const actions: SubagentHistoryActions = {
    ensureSubagentHistory: (input) => run(input, () => ensure(input)),
    loadOlderSubagentHistory: (input) => run(input, () => older(input)),
    loadNewerSubagentHistory: (input) => run(input, () => newer(input)),
    // The explicit jump to the tail supersedes any read still in flight: it
    // must read the newest page itself instead of handing back an older
    // request whose answer the pane would then be scrolled to.
    loadLatestSubagentHistory: (input) => startRead(input, () => latest(input, true)),
    retrySubagentHistory: (input) =>
      run(input, async () => {
        const current = entryFor(input);
        if (!current) {
          await ensure(input);
          return;
        }
        // Retry repeats the read that failed: an older page, a newer page, the
        // tail, a search range, or the entry's first page. A failed read never
        // finalized, so `ensure` refreshes a loaded entry instead of trusting it.
        if (current.retryDirection === "before" && current.hasMoreBefore) {
          await older(input);
          return;
        }
        if (current.retryDirection === "after" && current.hasMoreAfter) {
          await newer(input);
          return;
        }
        if (current.retryDirection === "latest" && subagentHistoryHasRows(current)) {
          await latest(input);
          return;
        }
        if (current.retryDirection === "focus" && current.focus?.messageId) {
          await ensure({
            ...input,
            messageId: current.focus.messageId,
            query: current.focus.query,
            requestId: current.focus.requestId,
          });
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
    if (!sessionId) return;
    // Reading this session again after another one is the lifecycle point that
    // re-offers its pending chains: the dispatch may have settled while it was
    // off screen, and its durable row is on disk now. It is one read per
    // activation, not a poll.
    const activated = ingestedSessionId !== sessionId;
    if (!activated && ingestedLive === live) return;
    ingestedSessionId = sessionId;
    ingestedLive = live;
    const bucket = get().subagentHistory[sessionId];
    if (!bucket) return;
    const liveIds = live.length ? subagentHistoryLiveIds(live) : new Set<string>();
    let buckets: SubagentHistoryBuckets | undefined;
    const convergences: SubagentHistoryInput[] = [];
    for (const entry of Object.values(bucket)) {
      // Without a live row of its own, a chain still owes its durable page on an
      // activation or on a dispatch the tail no longer names; both are handled
      // below, so an unrelated publication keeps costing nothing.
      const touches = live.length > 0 && subagentHistoryTouchesLive(entry, liveIds);
      let next = entry;
      if (touches) {
        const applied = applySubagentLiveRows(entry, live);
        if (applied) {
          touched += 1;
          next = { ...applied, touched };
          buckets = setSubagentHistoryEntry(buckets ?? get().subagentHistory, next);
        }
      }
      // A dispatch settling is exactly the transition that appends its durable
      // `Task` row behind the persistence outbox. An entry still waiting for its
      // first durable page reads it once at that transition instead of leaving
      // the live-only view on screen until the tab reopens. The two transitions
      // are terminal for that wait — the read either adopts a durable page or
      // states a miss — so a stream of live rows cannot become a stream of reads,
      // and a dispatch the tail can no longer name is not guessed at from rows.
      if (!next.refreshing && next.pendingDurable === true && next.scoped !== true) {
        if (activated || subagentHistoryLiveTaskState(next, live) === "settled") {
          convergences.push({ sessionId, tabKey: entry.tabKey });
        }
      }
      // A following tail that outgrew its live bound is the transition that
      // used to flip the entry historical. It re-anchors through the newest
      // page instead: the read joins the window it overlaps or replaces it,
      // so the entry stays one bounded contiguous interval at the tail, with
      // no latest arrow for a reader who never navigated away. Reader-held
      // ranges keep their own trim and never take this path. The in-flight
      // read dedupes through the existing generation machinery, and only an
      // ingest that actually routed rows can retrigger it.
      if (
        touches &&
        entry.hasMoreAfter !== true &&
        next.hasMoreAfter !== true &&
        next.refreshing !== true &&
        subagentHistoryLiveTailRows(next).length > SUBAGENT_HISTORY_LIVE_TAIL_LIMIT
      ) {
        convergences.push({ sessionId, tabKey: entry.tabKey });
      }
    }
    if (buckets) set({ subagentHistory: buckets });
    if (convergences.length) {
      queueMicrotask(() => {
        for (const input of convergences) void actions.ensureSubagentHistory(input);
      });
    }
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
