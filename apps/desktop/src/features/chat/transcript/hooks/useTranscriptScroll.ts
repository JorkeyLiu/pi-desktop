import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ContextCompactionMark,
  PlanningState,
  UiMessage,
} from "@pi-desktop/shared";
import type { PendingPermission } from "../../../../lib/pending-permissions";
import { transcriptEntryMessages } from "../../../../lib/assistant-turns";
import { getTranscriptProjection } from "../../../../lib/transcript-projection";
import {
  createTranscriptSettleState,
  mayHoldInitialCover,
  reduceTranscriptSettle,
  TRANSCRIPT_VEIL_FADE_MS,
} from "../../../../lib/transcript-settle";
import {
  planTopReach,
  reduceTranscriptWindow,
  TRANSCRIPT_INITIAL_MOUNT,
  TRANSCRIPT_WINDOW_MIN,
} from "../../../../lib/transcript-window";
import {
  HISTORY_REVEAL_THRESHOLD_PX,
  isHistoryRevealPosition,
  isLaterRevealPosition,
  isRecentScrollGesture,
  isScrollGestureInput,
  isTranscriptBottom,
  LATER_REVEAL_THRESHOLD_PX,
  reduceTranscriptScroll,
  shouldContinueEarlierHistory,
  shouldOfferLatestNavigation,
  transcriptHasLayout,
  TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
  type ScrollInputType,
} from "../../../../lib/transcript-scroll";
import {
  captureVisibleFragment,
  isPrependAnchorPending,
  PREPEND_ANCHOR_TOLERANCE_PX,
  remeasureVisibleFragment,
  resolvePrependAnchor,
  type VisibleFragmentAnchor,
} from "../../../../lib/transcript-prepend-anchor";
import { readScrollInputContext } from "../../../../lib/scroll-input";
import { useDisclosureAnchor } from "../../../../hooks/use-disclosure-anchor";
import type { TranscriptSearchTarget } from "../../../../lib/transcript-reading";
import { useTranscriptSearchFocus } from "../../../../hooks/use-transcript-search-focus";
import { getTranscriptReadingPosition } from "../../../../lib/transcript-reading-position";
import { useTranscriptReadingPosition, type RestoreTranscriptReading } from "../../../../hooks/use-transcript-reading-position";

type UseTranscriptScrollOptions = {
  sessionId: string | undefined;
  messages: UiMessage[];
  compactions?: ContextCompactionMark[];
  hasMoreBefore: boolean;
  onLoadOlder?: () => Promise<void>;
  isRunning: boolean;
  pendingPermission?: PendingPermission;
  askPending: boolean;
  approvalPending: boolean;
  planningState?: PlanningState;
  paneVisible: boolean;
  searchTarget: TranscriptSearchTarget | null;
  readingWindow: boolean;
  onRestoreReading?: RestoreTranscriptReading;
  hasMoreAfter: boolean;
  loadingLater: boolean;
  laterFailed: boolean;
  onLoadNewer?: () => Promise<void>;
};

export function useTranscriptScroll({
  sessionId,
  messages,
  compactions,
  hasMoreBefore,
  onLoadOlder,
  isRunning,
  pendingPermission,
  askPending,
  approvalPending,
  planningState,
  paneVisible,
  searchTarget,
  readingWindow,
  onRestoreReading,
  hasMoreAfter,
  loadingLater,
  laterFailed,
  onLoadNewer,
}: UseTranscriptScrollOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const historyBoundaryRef = useRef<HTMLDivElement>(null);
  const laterBoundaryRef = useRef<HTMLDivElement>(null);
  const [savedReadingPosition] = useState(() => getTranscriptReadingPosition(sessionId));
  const pinnedRef = useRef(savedReadingPosition?.pinned ?? true);
  const lastScrollTopRef = useRef(0);
  // Last offset sampled while the scroller had a real layout box. A hidden
  // pane's `content-visibility: hidden` box reports `scrollTop === 0`, so the
  // hide transition must restore this rather than the collapsed value.
  const lastLaidOutScrollTopRef = useRef(0);
  const lastScrollGestureAtRef = useRef(-Infinity);
  const wasRunningRef = useRef(isRunning);
  /*
    Automatic history continuation is not a reading gesture until this pane has
    established its first position (see `shouldContinueEarlierHistory`). Refs
    because the stable scroll handler and the boundary observer both read them
    long after the render that produced them.
  */
  const [positioned, setPositioned] = useState(false);
  const positionedRef = useRef(false);
  const coveredRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const followFrameRef = useRef(0);
  /**
   * The reader's visible fragment, held across one upward-history commit
   * (ADR 0331). Captured before the commit that adds height above the reading
   * position, applied once after it; see `capturePrependAnchor` below.
   */
  const prependAnchorRef = useRef<VisibleFragmentAnchor | null>(null);
  /** The read that armed that hold has completed (see `loadOlder`). */
  const prependAnchorSettledRef = useRef(false);
  /**
   * Drop the hold and the read it was armed for, together. The two refs are one
   * state: a hold left behind without its settle flag (or the reverse) would
   * keep a stale correction armed for a commit that already happened.
   */
  const releasePrependAnchor = useCallback(() => {
    prependAnchorRef.current = null;
    prependAnchorSettledRef.current = false;
  }, []);
  const [loadingOlder, setLoadingOlder] = useState(false);
  loadingOlderRef.current = loadingOlder;
  /*
    Follow released is the reader's own state; the button is not. What is left
    to navigate is decided by `shouldOfferLatestNavigation` from this flag, the
    measured bottom, the loaded range, and a historical window - a released
    scroller that a clamp placed on the newest bottom has nothing to offer.
  */
  const [followReleased, setFollowReleased] = useState(false);
  /**
   * Measured after every commit and every native scroll event: the scroller is
   * at the bottom of the range it has loaded. Refs cannot express this, and the
   * follow flag cannot stand in for it - a clamp, a grown viewport, or a
   * restored offset arrives without a downward gesture.
   *
   * Assumed until measured: a pane that has not been laid out yet has nothing
   * below the viewport to navigate to, and the first measurement (in the layout
   * phase of its first commit) settles it before the reader can see it.
   */
  const [atRangeBottom, setAtRangeBottom] = useState(true);

  // Steady-state cap on mounted history rows (D261). Grows when the user
  // reaches the top of the window; reset per session below.
  const [windowSize, setWindowSize] = useState(savedReadingPosition?.windowSize ?? TRANSCRIPT_WINDOW_MIN);
  // Read by `reachTop`, which must stay referentially stable for the scroll
  // listener; the projection it describes is only known later in this render.
  const historyLengthRef = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el || !transcriptHasLayout(el)) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: targetTop, behavior });
    // `scrollTo({ behavior: "auto" })` is synchronous. Record the position the
    // scroller actually reached, not the one that was asked for: at a
    // fractional device pixel ratio the browser lands a fraction of a pixel
    // away (asked 841, got 840.909), and the intended value would make the
    // following native scroll event read as the user scrolling up.
    if (behavior === "auto") {
      lastScrollTopRef.current = el.scrollTop;
      lastLaidOutScrollTopRef.current = el.scrollTop;
    }
  }, []);

  const cancelFollowScroll = useCallback(() => {
    cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = 0;
  }, []);
  const recordScrollPosition = useCallback((top: number) => {
    lastScrollTopRef.current = top;
    lastLaidOutScrollTopRef.current = top;
  }, []);
  const readingPositionMissing = useCallback(() => {
    pinnedRef.current = true;
    setFollowReleased(false);
    scrollToBottom();
  }, [scrollToBottom]);
  const {
    pendingRef: readingPositionPendingRef,
    remember: rememberReadingPosition,
    cancel: cancelReadingPosition,
  } = useTranscriptReadingPosition({
    sessionId, scrollRef, contentRef, pinnedRef, visible: paneVisible,
    windowSize, contentVersion: messages, onPosition: recordScrollPosition,
    onRestore: onRestoreReading, onMissing: readingPositionMissing,
  });

  /*
    Leave follow mode. Every reader-driven move inside the transcript starts
    here: while the scroller is still pinned, a scroll that carries no input
    gesture is indistinguishable from a layout clamp, so the follow re-bottoms
    the view one frame later and undoes the move.
  */
  const releaseFollow = useCallback(() => {
    cancelReadingPosition();
    cancelFollowScroll();
    pinnedRef.current = false;
    setFollowReleased(true);
  }, [cancelFollowScroll, cancelReadingPosition]);

  // A manual disclosure (a tool, thinking or activity title; #324) hands this
  // scroller the very title it was toggled from, before the expansion state
  // changes. Follow mode is left first — re-bottoming the expansion is exactly
  // what dragged the clicked title out of view — and the held position is
  // restored from the observer below for every frame of the height transition.
  const enterDisclosureReading = useCallback(() => {
    releaseFollow();
  }, [releaseFollow]);
  const {
    notifier: disclosureAnchorNotifier,
    restore: restoreDisclosureAnchor,
    release: releaseDisclosureAnchor,
    isHeld: isDisclosureAnchorHeld,
  } = useDisclosureAnchor(
    scrollRef,
    enterDisclosureReading,
    recordScrollPosition,
  );

  /**
   * The cold-open initial fill has been asked for by this pane. One per pane,
   * never reset: it covers a pane that presents nothing, and every later page is
   * a reader reach.
   */
  const initialFillRequestedRef = useRef(false);
  /** This pane has presented at least one row, so its geometry means something. */
  const presentedRef = useRef(false);
  const reachTopRef = useRef<((readerOwnsViewport?: boolean) => void) | null>(null);
  const loadOlderRef = useRef<() => void>(() => {});
  /**
   * The one continuation gate for every trigger that is not a scroll event: a
   * reader gesture at the boundary, the boundary's visibility transition, and the
   * pane's own content commits. It re-reads the geometry gates from refs and calls
   * the current trigger through a ref, so its identity is stable: the observer
   * must not be rebuilt when a page lands, because a new IntersectionObserver
   * reports the boundary's current visibility as its first record - which would
   * turn every landed page into a fresh reach and page the whole conversation in.
   */
  const continueEarlierHistory = useCallback((readerOwnsViewport = false) => {
    const el = scrollRef.current;
    if (!el || !transcriptHasLayout(el)) return;
    // Only a pane that has presented a row has a reading position to continue
    // from; the cold-open fill of an unpresented pane is `requestInitialFill`.
    if (!presentedRef.current) return;
    if (
      !shouldContinueEarlierHistory({
        geometry: el,
        pinned: pinnedRef.current,
        positioned: positionedRef.current,
        covered: coveredRef.current,
      })
    ) {
      return;
    }
    reachTopRef.current?.(readerOwnsViewport);
  }, []);

  /**
   * The cold-open initial fill: one older page, asked for by a pane that presents
   * no row yet while the settle veil covers it (D287). Such a pane has no
   * geometry of its own to judge - an empty scroller never overflows and never
   * fills the viewport - so this is not a continuation decision: it is the one
   * page the pane may pull before it has anything to read, and its rows land
   * behind the veil that is already up. Asked once per pane; after it, every page
   * is a reader reach through `continueEarlierHistory`.
   */
  const requestInitialFill = useCallback(() => {
    if (initialFillRequestedRef.current) return;
    initialFillRequestedRef.current = true;
    loadOlderRef.current();
  }, []);

  /**
   * One queued continuation, never more. The commit that calls this has already
   * been laid out; running in a frame keeps the page it asks for from landing
   * inside the same task as the commit that justified it, and a second commit
   * before that frame must not queue a second request - the gate reads live
   * geometry when the frame runs.
   */
  const continueFrameRef = useRef(0);
  const scheduleContinueEarlierHistory = useCallback(() => {
    if (continueFrameRef.current) return;
    continueFrameRef.current = requestAnimationFrame(() => {
      continueFrameRef.current = 0;
      if (readingPositionPendingRef.current) return;
      continueEarlierHistory();
    });
  }, [continueEarlierHistory]);
  useEffect(() => () => cancelAnimationFrame(continueFrameRef.current), []);

  // A user scroll-up gesture always emits input before its scroll events;
  // programmatic follow scrolling and layout clamps (composer collapse on
  // send, indicator mount/unmount) never do. Track the last real input so
  // `handleScroll` can tell the two apart and never let a clamp between a
  // follow `scrollTo` and its native event release follow mode. Only input
  // that can move *this* scroller counts: a press on a row control is an
  // ordinary click, a field owns its own keys, and a gesture a nested dock
  // consumes belongs to that dock.
  const markScrollGesture = useCallback(
    (event: Event) => {
      const input = readScrollInputContext(
        event,
        scrollRef.current,
        contentRef.current,
      );
      if (!isScrollGestureInput(event.type as ScrollInputType, input)) return;
      cancelReadingPosition();
      lastScrollGestureAtRef.current = performance.now();
      // Real input takes the viewport back from a held disclosure position.
      releaseDisclosureAnchor();
      /*
        A gesture at the top boundary is a reach even when the scroller cannot
        move. At the very top the browser has no offset left to produce, so it
        emits no scroll event: a reader pushing for older history would
        otherwise stall on the page already in view. The gesture also owns the
        viewport for the hold taken before the resulting commit, even though
        the follow state is only released by the scroll event that follows.
      */
      if (event.type === "wheel" || event.type === "touchmove") {
        continueEarlierHistory(true);
      }
    },
    [cancelReadingPosition, continueEarlierHistory, releaseDisclosureAnchor],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", markScrollGesture, { passive: true });
    el.addEventListener("touchstart", markScrollGesture, { passive: true });
    el.addEventListener("touchmove", markScrollGesture, { passive: true });
    el.addEventListener("pointerdown", markScrollGesture, { passive: true });
    el.addEventListener("keydown", markScrollGesture, { passive: true });
    return () => {
      el.removeEventListener("wheel", markScrollGesture);
      el.removeEventListener("touchstart", markScrollGesture);
      el.removeEventListener("touchmove", markScrollGesture);
      el.removeEventListener("pointerdown", markScrollGesture);
      el.removeEventListener("keydown", markScrollGesture);
    };
  }, [markScrollGesture]);

  // Cold first visits still settle at the newest turn. A runtime bookmark wins
  // over initialization and progressive hydration when an evicted pane remounts.
  useLayoutEffect(() => {
    releaseDisclosureAnchor();
    cancelFollowScroll();
    pinnedRef.current = savedReadingPosition?.pinned ?? true;
    setFollowReleased(!pinnedRef.current);
    if (pinnedRef.current) scrollToBottom();
  }, [cancelFollowScroll, releaseDisclosureAnchor, savedReadingPosition, scrollToBottom]);

  // Revisits restore this pane's own position. A hidden scroller can be clamped
  // while its content grows off screen, so the offset is captured on the way out
  // and reapplied during the layout phase that reveals the pane: a pane the user
  // had scrolled up in returns to that offset, a pinned one returns to the
  // bottom, and neither shows an intermediate frame.
  const retainedScrollTopRef = useRef<number | null>(null);
  const wasPaneVisibleRef = useRef(paneVisible);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const becameHidden = wasPaneVisibleRef.current && !paneVisible;
    const becameVisible = !wasPaneVisibleRef.current && paneVisible;
    // The transition is only consumed once there is a scroller to read or
    // position. Committing it before this guard would swallow the edge and lose
    // the offset a pane hidden before its scroller existed should return to.
    if (!el) return;
    wasPaneVisibleRef.current = paneVisible;
    if (becameHidden) {
      releaseDisclosureAnchor();
      cancelFollowScroll();
      // A hold belongs to the layout this pane was reading; a hidden scroller
      // has none, and the reveal below owns the position instead.
      releasePrependAnchor();
      // Do not read `el.scrollTop` here: the hide CSS has already skipped
      // rendering, so the box reports 0. Restore the last laid-out offset.
      retainedScrollTopRef.current = lastLaidOutScrollTopRef.current;
      return;
    }
    if (!becameVisible || readingPositionPendingRef.current) return;
    if (pinnedRef.current) {
      scrollToBottom();
      return;
    }
    const retained = retainedScrollTopRef.current;
    if (retained === null) return;
    el.scrollTop = retained;
    lastScrollTopRef.current = retained;
    lastLaidOutScrollTopRef.current = retained;
  }, [
    cancelFollowScroll,
    paneVisible,
    releaseDisclosureAnchor,
    releasePrependAnchor,
    scrollToBottom,
  ]);

  // A hidden pane must not chase its stream: its scroller has no visible
  // viewport, and the measurements a follow scroll depends on are unreliable
  // while it is out of view. It re-anchors when it is revealed instead.
  const paneVisibleRef = useRef(paneVisible);
  paneVisibleRef.current = paneVisible;
  /**
   * Record whether the scroller sits at the bottom of what it has loaded.
   *
   * Called once per native scroll event and once per commit (below), which is
   * every way the geometry can change without the follow flag changing with it:
   * a clamp after content below shrank, a grown viewport, a restored offset, a
   * follow scroll that landed. It writes state only when the answer changes, so
   * a scroll event that stays at the bottom does not re-render.
   */
  const measureRangeBottom = useCallback(() => {
    // A pane that presents no row has no reading position to navigate from, and
    // an empty first paint must stay empty until its covered commit: measuring
    // there would write state inside that commit for nothing.
    if (!presentedRef.current) return;
    const el = scrollRef.current;
    // A box without layout (a hidden pane, `content-visibility`) reports no
    // position at all: keep the last answer instead of replacing it with noise.
    if (!el || !transcriptHasLayout(el)) return;
    const next = isTranscriptBottom(el);
    setAtRangeBottom((current) => (current === next ? current : next));
  }, []);
  const scheduleFollowScroll = useCallback(() => {
    if (!paneVisibleRef.current) return;
    // A held disclosure position wins over a queued follow frame: re-asserting
    // the bottom here would move the title the reader just toggled even though
    // the observer below already refuses to.
    if (!pinnedRef.current || followFrameRef.current !== 0) return;
    if (isDisclosureAnchorHeld()) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = 0;
      if (paneVisibleRef.current && pinnedRef.current) scrollToBottom();
    });
  }, [isDisclosureAnchorHeld, scrollToBottom]);

  // Re-pins before the browser paints. A ResizeObserver callback runs after
  // layout and before paint, so a `requestAnimationFrame` requested from it
  // lands in the *next* frame: the current frame painted the grown content
  // unpinned and the next one snapped it back, which read as the transcript
  // twitching whenever a row changed height after mount (D287). Scrolling from
  // inside the callback costs nothing extra (layout is already clean) and
  // cannot resize the observed box, so it never re-triggers the observer.
  //
  // A manual disclosure holds the title the reader toggled (#324) and is
  // restored first: its height can keep changing for several frames, and
  // re-pinning on any one of them is what dragged that title out of view.
  const followScrollNow = useCallback(() => {
    // The observed geometry is also the answer the jump control's visibility
    // reads: content growing or shrinking below the viewport, or the scroller
    // itself resizing, can leave the reader at (or off) the newest bottom
    // without a scroll event of its own.
    measureRangeBottom();
    if (paneVisibleRef.current && restoreDisclosureAnchor()) return;
    if (!paneVisibleRef.current || !pinnedRef.current) return;
    cancelFollowScroll();
    scrollToBottom();
  }, [cancelFollowScroll, measureRangeBottom, restoreDisclosureAnchor, scrollToBottom]);

  useEffect(() => cancelFollowScroll, [cancelFollowScroll]);

  /**
   * Reading position held across one upward-history commit (ADR 0331).
   *
   * Native scroll anchoring holds the visible row for an ordinary prepend, but
   * it performs no adjustment at all at `scrollTop === 0`, and inside a turn a
   * page boundary cuts it anchors on a node other than the fragment in view.
   * One hold covers both: the fragment at the reading line plus its viewport
   * offset, captured before the commit that adds height above and applied once
   * after it. The correction is measured against the layout the browser already
   * produced, so native anchoring and this hold never compensate twice, and a
   * single write in one layout phase is not a correction loop.
   *
   * `readerOwnsViewport` marks the paths where the reader's own input (a wheel
   * at the boundary, explicit navigation) took the scroller to the band: the
   * follow state is only updated later in `handleScroll`, so `pinnedRef` alone
   * would read a first upward reach as "still pinned" and skip the hold.
   */
  const capturePrependAnchor = useCallback((readerOwnsViewport = false) => {
    if (!paneVisibleRef.current) return;
    if (pinnedRef.current && !readerOwnsViewport) return;
    if (readingPositionPendingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const anchor = captureVisibleFragment(el);
    if (anchor) {
      prependAnchorRef.current = anchor;
      prependAnchorSettledRef.current = false;
    }
  }, [readingPositionPendingRef]);

  /**
   * Whether a reach at the top can dispatch an older page right now: a visible
   * pane, loaded history still behind it, no read already in flight, and a
   * reader to request one. `reachTop` asks this *before* it arms a hold, so a
   * pane with nothing left to fetch takes no hold at all.
   */
  const canLoadOlder = useCallback(
    (): boolean =>
      paneVisibleRef.current &&
      hasMoreBefore &&
      !loadingOlder &&
      onLoadOlder !== undefined,
    [hasMoreBefore, loadingOlder, onLoadOlder],
  );

  const loadOlder = useCallback(() => {
    if (!canLoadOlder() || !onLoadOlder) return;
    setLoadingOlder(true);
    void onLoadOlder().finally(() => {
      setLoadingOlder(false);
      // The commit this hold waits for lands with the page it asked for. Once
      // the read is done, a hold that still finds nothing above it has no
      // commit coming and must not measure every later one.
      prependAnchorSettledRef.current = true;
    });
  }, [canLoadOlder, onLoadOlder]);

  /**
   * Reading forward is not a control (D269): approaching the bottom of the
   * loaded window fetches the next page, exactly like approaching the top
   * fetches the previous one. The store owns the in-flight request, so this
   * stays a pure trigger: a page already loading, or one that failed and waits
   * for an explicit retry, is never requested again by a scroll event.
   */
  const loadLater = useCallback(() => {
    if (!paneVisibleRef.current) return;
    if (!hasMoreAfter || loadingLater || laterFailed || !onLoadNewer) return;
    void onLoadNewer();
  }, [hasMoreAfter, laterFailed, loadingLater, onLoadNewer]);

  /**
   * Reaching the top escalates in two stages (D261): mount more of what is
   * already loaded, and only fetch an older page once the window covers all of
   * it. Both stages add height above the reading position. Native scroll
   * anchoring holds the reader's row for most of it; the two states it cannot
   * hold (the exact top, and a page that cuts inside a turn) are covered by the
   * one hold taken here, before the commit either stage asks for.
   *
   * A reach that asks for neither stage - the window already mounts every
   * loaded row and no older page can be dispatched - takes no hold: the commit
   * that would resolve it never happens, so an armed hold would keep re-reading
   * the reading line on every later scroll and every later commit instead of
   * settling.
   */
  const reachTop = useCallback((readerOwnsViewport = false) => {
    const plan = planTopReach({
      windowSize,
      historyLength: historyLengthRef.current,
      canLoadOlder: canLoadOlder(),
    });
    if (!plan) return;
    // Taken before the commit the plan asks for, and only for one that will
    // actually happen.
    capturePrependAnchor(readerOwnsViewport);
    if (plan.kind === "grow") {
      setWindowSize(plan.windowSize);
      return;
    }
    loadOlder();
  }, [canLoadOlder, capturePrependAnchor, loadOlder, windowSize]);
  reachTopRef.current = reachTop;
  loadOlderRef.current = loadOlder;

  // Follow the stream only while the user is pinned to the bottom; a manual
  // scroll up pauses following and surfaces the jump-to-latest pill.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (paneVisibleRef.current && transcriptHasLayout(el)) {
      lastLaidOutScrollTopRef.current = el.scrollTop;
    }
    measureRangeBottom();
    if (readingPositionPendingRef.current) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }
    /*
      The page this pane asked for lands in a commit that can be several frames
      away: entries arrive through a deferred projection. The reader may keep
      scrolling until then, so the hold taken at request time is re-read on
      every scroll event that follows - the commit is answered with where the
      reader is, not with where they were when the page was requested.
    */
    if (prependAnchorRef.current) {
      const held = captureVisibleFragment(el);
      if (held) prependAnchorRef.current = held;
    }
    // A real gesture is never stale noise: the reader's own input took the
    // scroller to the near-top band, and this event is the last one that
    // position produces. Suppressing history continuation here would strand an
    // overflowing transcript at the top until some other scroll event or the
    // minimap control arrived (D269). Only an offset this event did not produce
    // — a collapsed box, or a pinned scroller still about to be restored to the
    // bottom — is read as "not at the top".
    const gesturing = isRecentScrollGesture(
      performance.now(),
      lastScrollGestureAtRef.current,
    );
    if (
      paneVisibleRef.current &&
      shouldContinueEarlierHistory({
        geometry: el,
        pinned: pinnedRef.current && !gesturing,
        // A real gesture is the reader's own position even while the pane is
        // still settling, so it authorizes continuation on its own.
        positioned: positionedRef.current || gesturing,
        covered: coveredRef.current,
      })
    ) {
      reachTop(gesturing);
    }
    // The bottom boundary continues the same way: the reader never has to press
    // anything to see what comes next.
    if (paneVisibleRef.current && isLaterRevealPosition(el)) loadLater();
    if (readingWindow) {
      lastScrollTopRef.current = el.scrollTop;
      setFollowReleased(true);
      rememberReadingPosition();
      return;
    }
    const wasPinned = pinnedRef.current;
    // Only a real gesture (wheel / trackpad / touch / scrollbar / keyboard,
    // on this scroller) releases follow. When the composer collapses or an
    // indicator row unmounts right after send, the browser clamps scrollTop
    // and emits a scroll event that looks like an upward gesture; without
    // this guard it would cancel follow and leave the transcript stuck above
    // the new turn. The tolerance is slack for the fractions a fractional
    // device pixel ratio leaves behind on programmatic corrections; anything a
    // gesture produced is compared exactly, so a one-pixel scroll still
    // unpins.
    // `gesturing` was read above, before the history-reveal question: a real
    // gesture is what makes a near-top offset the reader's own position.
    const transition = reduceTranscriptScroll({
      previousScrollTop: lastScrollTopRef.current,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      wasPinned,
      tolerancePx: gesturing ? 0 : TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
    });
    lastScrollTopRef.current = el.scrollTop;
    if (transition.releasedFollow) cancelFollowScroll();
    if (gesturing && transition.releasedFollow) {
      pinnedRef.current = false;
      setFollowReleased(true);
    } else if (transition.releasedFollow) {
      // Programmatic / layout noise: re-baseline the observed position and
      // keep the follow state unchanged instead of treating it as a user
      // gesture. A pinned transcript re-asserts the bottom; an unpinned one
      // stays unpinned.
      pinnedRef.current = wasPinned;
      setFollowReleased(!wasPinned);
      scheduleFollowScroll();
    } else {
      pinnedRef.current = transition.pinned;
      setFollowReleased(!transition.pinned);
    }
    rememberReadingPosition();
  }, [cancelFollowScroll, loadLater, measureRangeBottom, reachTop, readingPositionPendingRef, readingWindow, rememberReadingPosition, scheduleFollowScroll]);

  // Send / retry / regenerate always re-pins follow mode so the new prompt and
  // its stream stay in view, even if the user had scrolled up through history.
  // This must run in the layout phase: the send state is committed before the
  // persisted user-message event arrives, and a passive effect allows one
  // frame where a long transcript can remain at its old/top position.
  useLayoutEffect(() => {
    const turnStarted = isRunning && !wasRunningRef.current;
    wasRunningRef.current = isRunning;
    if (!turnStarted || !paneVisible) return;
    cancelReadingPosition();
    releaseDisclosureAnchor();
    cancelFollowScroll();
    // A turn start re-bottoms the transcript: the reader's held position is not
    // the position this pane is about to show.
    releasePrependAnchor();
    pinnedRef.current = true;
    setFollowReleased(false);
    scrollToBottom();
    rememberReadingPosition();
    scheduleFollowScroll();
  }, [
    cancelFollowScroll,
    cancelReadingPosition,
    isRunning,
    paneVisible,
    releaseDisclosureAnchor,
    releasePrependAnchor,
    rememberReadingPosition,
    scheduleFollowScroll,
    scrollToBottom,
  ]);

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [
    messages,
    isRunning,
    pendingPermission?.requestId,
    askPending,
    approvalPending,
    planningState,
    scheduleFollowScroll,
  ]);

  // Streamed Markdown, expanded activity rows, late images, and diagrams change
  // the content height without a React commit, so pinned follow is kept in sync
  // from the observed layout. The content is observed on its border box: the
  // bottom padding is the composer's published height, and a multi-line draft
  // growing that padding must re-pin too, or the newest turn slides behind the
  // composer until the next commit happens to re-pin it. The content box does
  // not include padding and would miss that change entirely. The scroller is
  // observed as well so a window or work-panel resize keeps the bottom in view.
  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(followScrollNow);
    ro.observe(content, { box: "border-box" });
    ro.observe(scroller, { box: "border-box" });
    return () => ro.disconnect();
  }, [followScrollNow]);

  // Defer one immutable projection, never messages and compaction boundaries
  // independently. First paint, reading, and pane reveal use the current source.
  const firstCommitRef = useRef(true);
  const firstCommit = firstCommitRef.current;
  const paneRevealed = paneVisible && !wasPaneVisibleRef.current;
  const projection = useMemo(
    () => getTranscriptProjection(messages, compactions),
    [messages, compactions],
  );
  const deferredProjection = useDeferredValue(projection);
  const renderedProjection =
    readingWindow || firstCommit || paneRevealed ? projection : deferredProjection;
  const { entries, visible, history: allHistoryEntries } = renderedProjection;
  const tailEntry = entries.at(-1);
  // Published for `reachTop`, which is declared above this projection but only
  // runs from a scroll event, long after this render committed.
  historyLengthRef.current = allHistoryEntries.length;

  // Progressive hydration, now scoped to this pane's own first commit
  // (ADR 0137): mount only the bottom portion of the transcript when the pane
  // mounts, then expand to the steady-state window after paint, with a spacer
  // holding the scroll height. Because the instance belongs to one session, the
  // gate is plain local mount state rather than a comparison against whichever
  // session was rendered last.
  //
  // The gate has to be derived during render, not set from an effect. Deciding
  // it from a layout effect mounted the *whole* history first and only then cut
  // it back to the budget, so a long session built its entire DOM, discarded it,
  // and rebuilt it, which is the opposite of what bounding the first commit is
  // for.
  //
  // The expansion target is the mounted window (D261), not the whole history: a
  // paged-in session used to end up with every row mounted for good, retaining
  // its Markdown and highlighting for rows nobody was looking at.
  const [hydrationTick, setHydrationTick] = useState(0);
  const hydrationBounded =
    !readingWindow && firstCommit && savedReadingPosition?.pinned !== false &&
    allHistoryEntries.length > TRANSCRIPT_INITIAL_MOUNT;
  // The bounded commit and the expansion must show the transcript at the same
  // place. A spacer sized from a per-entry guess cannot match the rows it stands
  // in for, so the expansion moved the visible text by the estimate error - the
  // reported page-flip jitter on a session switch. The spacer now only reserves
  // enough height to make the bottom reachable, and the expansion re-pins the
  // exact bottom in the same layout phase it commits in.
  //
  // The "needs re-anchoring" flag is derived from which session was bounded, not
  // written during render: StrictMode double-renders and abandoned concurrent
  // renders would otherwise leave a plain boolean ref set and re-bottom a
  // transcript the user had scrolled up in.
  const boundedFirstCommitRef = useRef(false);
  useEffect(() => {
    if (!hydrationBounded) {
      // An empty first paint must not spend this gate: revalidation can still
      // land a long transcript that needs the bounded expand and re-bottom.
      if (allHistoryEntries.length > 0) firstCommitRef.current = false;
      return;
    }
    boundedFirstCommitRef.current = true;
    const frame = requestAnimationFrame(() => {
      firstCommitRef.current = false;
      setHydrationTick((tick) => tick + 1);
    });
    return () => cancelAnimationFrame(frame);
    // `hydrationTick` is a dependency so a pane whose expansion is still queued
    // re-evaluates instead of holding a stale frame.
  }, [allHistoryEntries.length, hydrationBounded, hydrationTick]);

  // Settle veil (D287). A bounded first commit means the transcript is long
  // enough for its geometry to keep moving for several frames after mount: the
  // expansion, then rows whose height resolves only once laid out. Rather than
  // painting that motion, an opaque skeleton covers the scroller until the
  // geometry has held still (or a hard time cap passes) and then fades out.
  // Short transcripts mount in one commit and never show the veil. The phase is
  // initialised from the first render's own gate so the veil is in the commit
  // that reveals the pane, not one frame later.
  const [veilPhase, setVeilPhase] = useState<"covering" | "leaving" | "off">(
    () => (hydrationBounded ? "covering" : "off"),
  );
  const veilCovering = veilPhase === "covering";
  positionedRef.current = positioned;
  coveredRef.current = veilCovering;

  const transcriptWindow = reduceTranscriptWindow({
    historyLength: allHistoryEntries.length,
    windowSize: readingWindow ? allHistoryEntries.length : windowSize,
    initialCommit: hydrationBounded,
  });
  // Memoized so unrelated re-renders (jump pill, loading row) hand
  // `TranscriptHistory` the same array and it can bail on identity instead of
  // walking every mounted row.
  const historyEntries = useMemo(
    () =>
      transcriptWindow.bounded
        ? allHistoryEntries.slice(-transcriptWindow.mounted)
        : allHistoryEntries,
    [allHistoryEntries, transcriptWindow.bounded, transcriptWindow.mounted],
  );

  presentedRef.current = historyEntries.length > 0 || Boolean(tailEntry);

  const releaseSearchFollow = useCallback(() => {
    cancelReadingPosition();
    releaseDisclosureAnchor();
    cancelFollowScroll();
    // Search navigation asks for a row somewhere else: it drops the hold.
    releasePrependAnchor();
    pinnedRef.current = false;
    setFollowReleased(true);
  }, [cancelFollowScroll, cancelReadingPosition, releaseDisclosureAnchor, releasePrependAnchor]);
  useTranscriptSearchFocus({
    target: searchTarget,
    source: searchTarget
      ? messages.find((message) => message.id === searchTarget.messageId)?.content ?? ""
      : "",
    visible: paneVisible,
    scrollRef,
    contentRef,
    contentVersion: historyEntries,
    onNavigate: releaseSearchFollow,
    onPosition: recordScrollPosition,
  });

  // Runs in the same layout phase the expansion commits in, before the browser
  // paints it, so mounting the remaining history cannot move the rows the user
  // is already looking at. A user who scrolled up during the bounded frame keeps
  // their position: only a still-pinned transcript is re-bottomed.
  useLayoutEffect(() => {
    if (hydrationBounded || !boundedFirstCommitRef.current) return;
    boundedFirstCommitRef.current = false;
    if (!pinnedRef.current) return;
    cancelFollowScroll();
    scrollToBottom();
  }, [cancelFollowScroll, hydrationBounded, hydrationTick, scrollToBottom]);

  /*
    The one write of the upward hold (ADR 0331). It runs in the layout phase of
    the commit that actually changed the mounted history - not on the request
    that asked for it, and not on a deferred render that mounted nothing - so it
    reads the layout the browser has already produced, native anchoring
    included, and covers only the residual: no double compensation, no
    geometry loop, one write per hold.
  */
  useLayoutEffect(() => {
    const held = prependAnchorRef.current;
    if (!held) return;
    const el = scrollRef.current;
    if (!el || !paneVisible) return;
    // A pinned transcript is re-bottomed by follow, and a pending restore owns
    // the position outright; neither is a reader holding a row in place.
    if (pinnedRef.current || readingPositionPendingRef.current) return;
    const current = remeasureVisibleFragment(el, held.messageId);
    if (!current) {
      // The row is no longer mounted; there is nothing to hold on to.
      prependAnchorRef.current = null;
      return;
    }
    const resolution = resolvePrependAnchor(held, current, el);
    if (
      isPrependAnchorPending({
        gainedAbove: resolution.gainedAbove,
        readSettled: prependAnchorSettledRef.current,
      })
    ) {
      // Nothing landed above the held fragment yet: this is not the commit the
      // hold was taken for, so keep it and follow the reader's reading line.
      prependAnchorRef.current = { ...held, offset: current.offset };
      return;
    }
    if (resolution.gainedAbove < PREPEND_ANCHOR_TOLERANCE_PX) {
      // The read that armed it is done and nothing came above: no commit is
      // coming for this hold.
      prependAnchorRef.current = null;
      prependAnchorSettledRef.current = false;
      return;
    }
    prependAnchorRef.current = null;
    if (resolution.target === null) return;
    el.scrollTop = resolution.target;
    recordScrollPosition(el.scrollTop);
  }, [historyEntries, paneVisible]);


  // Sample the scroller once per frame from the expansion commit onward and
  // lift the veil once the geometry has stopped moving. The bounded commit
  // itself is not sampled: the expansion that follows it changes the height by
  // design. Each sample also re-pins a still-pinned transcript, so the frame the
  // veil reveals is already at the newest turn. A hidden pane pauses sampling
  // (its scroller reports no usable geometry) and resumes when revealed.
  useEffect(() => {
    if (!veilCovering || hydrationBounded || !paneVisible) return;
    const el = scrollRef.current;
    if (!el) return;
    let state = createTranscriptSettleState(performance.now());
    let frame = 0;
    const sample = () => {
      frame = 0;
      if (pinnedRef.current) scrollToBottom();
      /*
        An older page still in flight will add height above the viewport. While
        the pane is still establishing its first position that fill is allowed
        precisely because the veil hides it, so the veil waits for the read
        instead of declaring the geometry stable one frame before the page lands
        and moving the rows in front of the reader.

        The wait is bounded by the same absolute deadline as every other path,
        never restarted frame by frame: a read that hangs must not keep the veil
        over content that has already loaded. Once the deadline passes the frame
        folds its geometry, reports `timeout`, and the veil lifts.
      */
      const now = performance.now();
      if (
        positionedRef.current === false &&
        loadingOlderRef.current &&
        mayHoldInitialCover(state, now)
      ) {
        frame = requestAnimationFrame(sample);
        return;
      }
      const step = reduceTranscriptSettle(
        state,
        { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
        now,
      );
      state = step.state;
      if (step.settled) {
        setVeilPhase("leaving");
        return;
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(frame);
  }, [hydrationBounded, paneVisible, scrollToBottom, veilCovering]);

  /*
    A pane whose first paint is empty spends no hydration gate on it, so the long
    page that lands from the revalidation is the one that needs the bounded first
    commit. The veil was initialised from the *first* render's own gate, which
    was false, so enter it here instead of leaving the expansion and any initial
    fill unprotected.

    This runs in the layout phase rather than a passive effect: a state update
    from a layout effect is flushed before the browser paints, so the commit that
    mounts that page is never presented uncovered. A passive effect would leave a
    painted frame between the rows appearing and the veil covering them.
  */
  useLayoutEffect(() => {
    if (hydrationBounded && veilPhase === "off") setVeilPhase("covering");
  }, [hydrationBounded, veilPhase]);

  useEffect(() => {
    if (veilPhase !== "leaving") return;
    const timer = window.setTimeout(
      () => setVeilPhase("off"),
      TRANSCRIPT_VEIL_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [veilPhase]);

  // The minimap must describe the mounted rows, not every loaded message: it
  // resolves a click by looking up the marker's node in the scroller, so a dash
  // for a withheld row would jump nowhere (D261).
  const minimapMessages = useMemo(
    () =>
      transcriptWindow.bounded
        ? transcriptEntryMessages(
            tailEntry ? [...historyEntries, tailEntry] : historyEntries,
          )
        : visible,
    [historyEntries, tailEntry, transcriptWindow.bounded, visible],
  );
  const hasEarlierHistory = transcriptWindow.hiddenAbove > 0 || hasMoreBefore;


  const revealEarlierHistory = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isHistoryRevealPosition(el)) {
      // Explicit navigation: the reader owns the viewport from here.
      reachTop(true);
      return;
    }
    releaseDisclosureAnchor();
    releaseFollow();
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollTo({
      top: 0,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [reachTop, releaseDisclosureAnchor, releaseFollow]);

  const jumpToLatest = useCallback(() => {
    cancelReadingPosition();
    releaseDisclosureAnchor();
    releasePrependAnchor();
    pinnedRef.current = true;
    setFollowReleased(false);
    scrollToBottom(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    );
    /*
      Persist the arrival, not just the state. Pressed while the scroller is
      already at the bottom, `scrollToBottom` writes nothing, no scroll event
      follows, and the remembered position would still say "released" - which is
      what a hidden pane or a session switch restores. The bookmark is written
      here so no later reveal can resurrect the control.
    */
    rememberReadingPosition();
  }, [
    cancelReadingPosition,
    releaseDisclosureAnchor,
    releasePrependAnchor,
    rememberReadingPosition,
    scrollToBottom,
  ]);

  /*
    The first position is established once the pane is on screen, its content has
    arrived, the bounded expansion has committed, and the settle veil is gone.
    Until then a near-top offset is the pane's own mounting geometry rather than
    the reader's position, so automatic history continuation waits for it (see
    `shouldContinueEarlierHistory`). An empty first paint keeps the gate armed:
    the page that lands from its revalidation is the one that settles.
  */
  useLayoutEffect(() => {
    if (positioned) return;
    if (!paneVisible || hydrationBounded || veilCovering) return;
    if (messages.length === 0) return;
    const el = scrollRef.current;
    if (!el || !transcriptHasLayout(el)) return;
    setPositioned(true);
  }, [hydrationBounded, messages.length, paneVisible, positioned, veilCovering]);

  /*
    D269: history progression follows the visible top boundary, not only a
    native scroll event. A tail page can collapse to less than one viewport, and
    a fetched page can initially sit outside the mounted window; neither case
    changes scrollTop, so a scroll-only trigger strands both the earlier
    transcript and the minimap.

    The boundary's own visibility transitions are one owner (below); the pane's
    content obligations are another. They are separate effects because the
    observer must keep its identity: it is rebuilt only when what it observes
    changes, never when a page lands.
  */
  useEffect(() => {
    const root = scrollRef.current;
    const boundary = historyBoundaryRef.current;
    if (!root || !boundary || !hasEarlierHistory) return;
    // A hidden pane's scroller is unrendered and reports `scrollTop === 0`,
    // which reads as "at the top" and would page history for a session nobody is
    // looking at. The pane re-evaluates when it is revealed, because
    // `paneVisible` is a dependency of this effect.
    if (!paneVisible) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          scheduleContinueEarlierHistory();
        }
      },
      {
        root,
        rootMargin: `${HISTORY_REVEAL_THRESHOLD_PX}px 0px 0px 0px`,
      },
    );
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [hasEarlierHistory, paneVisible, scheduleContinueEarlierHistory, sessionId]);

  /*
    The pane's own content change is not a reader reach. Anchoring holds the row
    the reader is looking at, so a landed page or a mounted window leaves the
    boundary exactly where it was: advancing on that change would page the
    conversation in by itself, one page per commit, for a reader resting at the
    top. A content-driven run therefore continues only while the pane still owes
    what it is showing:

    * it holds loaded rows it has not mounted, or a transcript that does not fill
      the viewport - the case this trigger exists for.

    A pane that still presents nothing is not a continuation at all: it asks for
    its one cold-open fill (`requestInitialFill`) behind the veil, and nothing
    else. Anything else waits for the reader to reach the boundary again (a
    scroll, or a gesture at the top where the browser has no offset left to
    move).
  */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !hasEarlierHistory || !paneVisible) return;
    if (!presentedRef.current) {
      if (coveredRef.current) requestInitialFill();
      return;
    }
    const owesViewportContent =
      transcriptWindow.hiddenAbove > 0 ||
      root.scrollHeight <= root.clientHeight + HISTORY_REVEAL_THRESHOLD_PX;
    if (!owesViewportContent) return;
    scheduleContinueEarlierHistory();
    // `hiddenAbove` is a dependency because an IntersectionObserver does not
    // re-notify while the boundary stays continuously visible: growing the
    // window changes neither `messages.length` nor the intersection state, so
    // without it a still-underfilled transcript would advance exactly once and
    // then stall with loaded rows unmounted. Each re-run performs one bounded
    // growth step, so the escalation stays monotonic and terminates when the
    // window covers the loaded history or the boundary leaves the band.
  }, [
    hasEarlierHistory,
    hydrationTick,
    loadingOlder,
    messages.length,
    paneVisible,
    positioned,
    requestInitialFill,
    scheduleContinueEarlierHistory,
    sessionId,
    transcriptWindow.hiddenAbove,
  ]);


  // The same boundary rule at the bottom (D269): a scroll event is not the only
  // way to reach the end of a window. A page that lands short of a viewport, a
  // pane revealed already at its bottom, and a view that stops overflowing all
  // put the reader at the boundary without moving scrollTop. Re-observing after
  // each page keeps reading forward until the newest page is loaded.
  useEffect(() => {
    const root = scrollRef.current;
    const boundary = laterBoundaryRef.current;
    if (!root || !boundary || !hasMoreAfter) return;
    if (!paneVisible) return;
    let frame = 0;
    const advanceIfLaterBoundaryVisible = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (scrollRef.current !== root || readingPositionPendingRef.current) return;
        if (!isLaterRevealPosition(root)) return;
        loadLater();
      });
    };
    advanceIfLaterBoundaryVisible();
    if (typeof IntersectionObserver === "undefined") {
      return () => cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          advanceIfLaterBoundaryVisible();
        }
      },
      {
        root,
        rootMargin: `0px 0px ${LATER_REVEAL_THRESHOLD_PX}px 0px`,
      },
    );
    observer.observe(boundary);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // `messages.length` and the in-flight/error flags re-run the effect after
    // each page, so a still-visible boundary continues to the tail and stops
    // there: `hasMoreAfter` is the only condition that keeps it armed.
  }, [
    hasMoreAfter,
    laterFailed,
    loadingLater,
    loadLater,
    messages.length,
    paneVisible,
    sessionId,
  ]);
  return {
    scrollRef,
    wrapRef,
    contentRef,
    historyBoundaryRef,
    laterBoundaryRef,
    loadingOlder,
    /*
      What the control would still do, not what follow was. A released scroller
      that a clamp placed on the newest bottom has nowhere to navigate, so it
      renders nothing there; a bounded range or a historical window keeps the
      return.
    */
    showJump: shouldOfferLatestNavigation({
      followReleased,
      atRangeBottom,
      hasMoreAfter,
      historical: readingWindow,
    }),
    historyEntries,
    tailEntry,
    minimapMessages,
    hasEarlierHistory,
    hydrationBounded,
    veilCovering,
    veilPhase,
    handleScroll,
    revealEarlierHistory,
    scrollToBottom,
    jumpToLatest,
    releaseFollow,
    disclosureAnchorNotifier,
  };
}
