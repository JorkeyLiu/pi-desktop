import type { SessionDetail } from "@pi-desktop/shared";
import type { SessionHistoryReadOptions } from "../../lib/api";
import { isRemoteSession } from "../../lib/remote-session-safety";
import type { TranscriptReadingPosition } from "../../lib/transcript-reading-position";
import {
  EMPTY_TRANSCRIPT,
  extendTranscriptView,
  TRANSCRIPT_CONTENT_LIMIT,
  TRANSCRIPT_PAGE_SIZE,
  TRANSCRIPT_SEARCH_PAGE_SIZE,
  transcriptViewFromSession,
  transcriptWasRewritten,
  type TranscriptSearchTarget,
  type TranscriptView,
} from "../../lib/transcript-reading";
import type { AppState } from "../app-state";
import type { StoreAccess } from "../slices/types";

type ReadSession = (
  id: string,
  options: SessionHistoryReadOptions,
) => Promise<{ session: SessionDetail | null }>;
type ReadingActions = Pick<
  AppState,
  "navigateTranscript" | "loadTranscriptPage" | "returnToLatestTranscript" | "restoreTranscriptReading"
>;

/** Read workflows publish renderer views and never write the runtime/model cache. */
export function createTranscriptReadingRuntime({ get, set }: StoreAccess, read: ReadSession) {
  let nextRequestId = 0;

  function currentView(sessionId: string): TranscriptView {
    const state = get();
    return (
      state.transcriptViews[sessionId] ?? {
        messages:
          state.activeSessionId === sessionId
            ? state.messages
            : (state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT),
        messageStart: state.sessionHistory[sessionId]?.messageStart ?? 0,
        hasMoreBefore: state.sessionHistory[sessionId]?.hasMoreBefore === true,
        hasMoreAfter: false,
        focus: null,
        loading: null,
      }
    );
  }

  function publish(sessionId: string, view: TranscriptView) {
    set((state) => ({ transcriptViews: { ...state.transcriptViews, [sessionId]: view } }));
  }

  function returnToLatestTranscript(sessionId: string) {
    set((state) => {
      if (!state.transcriptViews[sessionId]) return {};
      const { [sessionId]: _released, ...transcriptViews } = state.transcriptViews;
      return { transcriptViews };
    });
  }

  function reportError(
    sessionId: string,
    pending: TranscriptView,
    direction: "before" | "after",
    error: unknown,
  ) {
    if (get().transcriptViews[sessionId] !== pending) return;
    // A later page that failed while the reader sits at the bottom of the
    // window must not retry itself: mark the view so only an explicit retry
    // reads again.
    publish(sessionId, {
      ...pending,
      loading: null,
      ...(direction === "after" ? { laterFailed: true } : {}),
    });
    if (get().activeSessionId === sessionId)
      get().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  }

  /**
   * Publish the reading range for a bookmark the loaded window cannot show.
   *
   * An anchor the loaded range already holds needs no read at all: the range is
   * the reading range, and replacing it with a narrower window around the anchor
   * discards the rows above it and the newest turn below it.
   */
  async function restoreRange(
    sessionId: string,
    position: TranscriptReadingPosition,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted || get().activeSessionId !== sessionId || !position.messageId) return false;
    const previous = get().transcriptViews[sessionId];
    const range = currentView(sessionId);
    if (range.messages.some((message) => message.id === position.messageId)) return true;
    // A user navigation already in flight always wins over automatic restore.
    if (range.focus || range.loading) return false;
    const pending: TranscriptView = { ...range, restored: true, loading: "target" };
    const rollback = () => {
      if (get().transcriptViews[sessionId] !== pending) return;
      if (previous) publish(sessionId, previous);
      else returnToLatestTranscript(sessionId);
    };
    publish(sessionId, pending);
    signal.addEventListener("abort", rollback, { once: true });
    try {
      const { session } = await read(sessionId, {
        messageAround: position.messageId,
        messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE,
        contentLimit: TRANSCRIPT_CONTENT_LIMIT,
      });
      if (signal.aborted || get().transcriptViews[sessionId] !== pending) return false;
      if (get().activeSessionId !== sessionId) {
        rollback();
        return false;
      }
      const message = session?.messages.find((row) => row.id === position.messageId);
      if (!session || !message || (message.parentToolCallId && !session.navigationParent)) {
        rollback();
        return false;
      }
      publish(sessionId, { ...transcriptViewFromSession(session), restored: true });
      return true;
    } catch (error) {
      if (!signal.aborted && get().transcriptViews[sessionId] === pending) {
        rollback();
        if (get().activeSessionId === sessionId)
          get().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      }
      return false;
    } finally {
      signal.removeEventListener("abort", rollback);
    }
  }

  /**
   * Hold a restore until the session selection in flight has committed.
   *
   * Only the visible pane restores a reading position, so at most one request
   * waits at a time; a newer request supersedes an older one, which resolves
   * `false` rather than hanging.
   */
  let awaitedRestore:
    | {
        sessionId: string;
        position: TranscriptReadingPosition;
        signal: AbortSignal;
        resolve: (found: boolean) => void;
      }
    | undefined;
  function awaitSelection(
    sessionId: string,
    position: TranscriptReadingPosition,
    signal: AbortSignal,
  ): Promise<boolean> {
    awaitedRestore?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const pending = { sessionId, position, signal, resolve };
      awaitedRestore = pending;
      signal.addEventListener(
        "abort",
        () => {
          if (awaitedRestore === pending) awaitedRestore = undefined;
          resolve(false);
        },
        { once: true },
      );
    });
  }

  const actions: ReadingActions = {
    returnToLatestTranscript,
    restoreTranscriptReading: async (sessionId, position, signal) => {
      if (signal.aborted || get().activeSessionId !== sessionId || !position.messageId) return false;
      /*
        A session selection in flight is about to publish the page this pane will
        keep. Deciding against the range it is about to replace is wrong either
        way: keeping it can lose the anchor when the committed page no longer
        holds it, and reading a bounded window around the anchor shrinks away the
        rows above and below it — which is what hid the newest turn of a warm
        revisit behind a short early range until the reader jumped to the bottom.
        Wait for the committed page instead; `reconcile` resumes this the moment
        the selection settles.
      */
      if (get().selectingSessionId === sessionId)
        return await awaitSelection(sessionId, position, signal);
      return await restoreRange(sessionId, position, signal);
    },
    navigateTranscript: async (input) => {
      const { sessionId } = input;
      if (get().activeSessionId !== sessionId) return;
      const focus: TranscriptSearchTarget = { ...input, requestId: ++nextRequestId };
      const previous: TranscriptView = { ...currentView(sessionId), loading: null };
      const pending: TranscriptView = { ...previous, loading: "target" };
      publish(sessionId, pending);
      try {
        const { session } = await read(sessionId, {
          messageAround: focus.messageId,
          messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE,
          contentLimit: TRANSCRIPT_CONTENT_LIMIT,
        });
        if (get().transcriptViews[sessionId] !== pending) return;
        if (get().activeSessionId !== sessionId) {
          returnToLatestTranscript(sessionId);
          return;
        }
        const message = session?.messages.find((candidate) => candidate.id === focus.messageId);
        if (!session || !message) throw new Error("Message no longer exists in this conversation.");
        if (message.parentToolCallId && !session.navigationParent)
          throw new Error("The task for this message no longer exists in this conversation.");
        set((state) => ({
          transcriptViews: {
            ...state.transcriptViews,
            [sessionId]: transcriptViewFromSession(session, focus),
          },
        }));
      } catch (error) {
        if (get().transcriptViews[sessionId] !== pending) return;
        publish(sessionId, previous);
        if (get().activeSessionId === sessionId)
          get().showToast(error instanceof Error ? error.message : String(error), {
            variant: "error",
          });
      }
    },
    loadTranscriptPage: async (sessionId, direction) => {
      const view = currentView(sessionId);
      if (view.loading || !(direction === "before" ? view.hasMoreBefore : view.hasMoreAfter))
        return;
      const remote = isRemoteSession({ id: sessionId });
      const limit = view.focus ? TRANSCRIPT_SEARCH_PAGE_SIZE : TRANSCRIPT_PAGE_SIZE;
      // A forward page needs the exclusive physical end of the current window.
      // Remote history exposes older-item cursors only, and a window restored
      // from partial metadata may carry no end at all. Synthesizing one would
      // request the transcript's *head* page, so a window without a reliable
      // forward cursor re-reads the newest bounded page instead: one explicit,
      // bounded degradation back to the live tail, never an arithmetic guess.
      const resyncTail = direction === "after" && view.messageEnd === undefined;
      const pending: TranscriptView = { ...view, loading: direction, laterFailed: undefined };
      publish(sessionId, pending);
      try {
        const { session } = await read(
          sessionId,
          resyncTail
            ? { messageLimit: limit, contentLimit: TRANSCRIPT_CONTENT_LIMIT }
            : {
                messageBefore: direction === "before" ? view.messageStart : (view.messageEnd ?? 0) + limit,
                messageLimit: limit,
                contentLimit: TRANSCRIPT_CONTENT_LIMIT,
              },
        );
        if (get().transcriptViews[sessionId] !== pending) return;
        if (!session) throw new Error("Conversation no longer exists.");
        if (resyncTail) {
          publish(sessionId, transcriptViewFromSession(session, view.focus));
          return;
        }
        const extended = extendTranscriptView(pending, session, direction);
        // Remote numeric values represent opaque Host item cursors. Preserve
        // the returned cursor rather than depending on its ordering. Local
        // transcripts continue merging physical message offsets unchanged.
        if (remote) {
          publish(sessionId, {
            ...extended,
            messageStart: session.messageStart ?? 0,
            messageEnd: undefined,
            hasMoreAfter: false,
          });
          return;
        }
        // A later page that added nothing cannot advance the window: keeping
        // the flag would let automatic forward paging re-request the same
        // cursor for as long as the reader stays near the bottom.
        publish(
          sessionId,
          direction === "after" && extended.messages.length === pending.messages.length
            ? { ...extended, hasMoreAfter: false }
            : extended,
        );
      } catch (error) {
        reportError(sessionId, pending, direction, error);
      }
    },
  };

  /**
   * One lifecycle boundary for pane eviction, new turns, authoritative edits,
   * and a finished turn that overlapped a restored range.
   */
  function reconcile(state: AppState, previous: AppState) {
    /*
      A committed selection is the point at which the page this pane keeps stops
      moving, so a restore that waited for it decides now - against the range the
      reader can actually stay in, not the one the selection was replacing.
    */
    const settledSessionId = previous.selectingSessionId;
    if (
      settledSessionId !== undefined &&
      state.selectingSessionId !== settledSessionId &&
      awaitedRestore?.sessionId === settledSessionId
    ) {
      const { sessionId, position, signal, resolve } = awaitedRestore;
      awaitedRestore = undefined;
      void restoreRange(sessionId, position, signal).then(resolve);
    }

    for (const [id, view] of Object.entries(state.transcriptViews)) {
      const evicted = !state.retainedSessionIds.includes(id);
      const started =
        (view.focus || view.restored || view.loading === "target") &&
        state.runningSessions[id] &&
        !previous.runningSessions[id];
      const rewritten =
        state.activeSessionId === id &&
        previous.activeSessionId === id &&
        !state.runningSessions[id] &&
        !previous.runningSessions[id] &&
        !(view.restored && previous.selectingSessionId === id) &&
        state.messages !== previous.messages &&
        transcriptWasRewritten(previous.messages, state.messages);
      if (evicted || started || rewritten) {
        returnToLatestTranscript(id);
        continue;
      }
      /*
        A range restored while a turn was already streaming never sees the
        "turn started" boundary above: that turn began before the range
        existed. Keeping the snapshot frozen past the end of that turn would
        lock its result out of the transcript for good. The range keeps its
        rows and its scroll position and simply becomes the loaded window
        again, so new output lands below the reader instead of replacing what
        they were reading. A search snapshot keeps its own contract.
      */
      const resumedDuringReading =
        state.activeSessionId === id &&
        previous.activeSessionId === id &&
        view.restored === true &&
        !view.focus &&
        !state.runningSessions[id] &&
        previous.runningSessions[id] === true;
      if (!resumedDuringReading) continue;
      const { restored: _released, ...thawed } = view;
      publish(id, thawed);
    }
  }

  return { actions, reconcile };
}
