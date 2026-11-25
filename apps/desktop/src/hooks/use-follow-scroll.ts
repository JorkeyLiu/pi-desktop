import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type UIEventHandler,
} from "react";
import {
  isRecentScrollGesture,
  isScrollGestureInput,
  reduceTranscriptScroll,
  TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
  type ScrollInputType,
} from "../lib/transcript-scroll";
import { readScrollInputContext } from "../lib/scroll-input";
import {
  captureVisibleFragment,
  isPrependAnchorPending,
  remeasureVisibleFragment,
  resolvePrependAnchor,
  PREPEND_ANCHOR_TOLERANCE_PX,
  type VisibleFragmentAnchor,
} from "../lib/transcript-prepend-anchor";
import type { DisclosureAnchorNotifier } from "../lib/disclosure-anchor-context";
import { useDisclosureAnchor } from "./use-disclosure-anchor";

export type FollowScroll = {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  showJump: boolean;
  handleScroll: UIEventHandler<HTMLDivElement>;
  jumpToLatest: () => void;
  scheduleFollowScroll: () => void;
  releaseFollow: () => void;
  /**
   * Arm a reading-position hold for an explicit older-page read: the fragment
   * in view keeps its viewport offset while the page grows the rows above it.
   */
  holdReadingPosition: () => void;
  /** Apply that hold once the read's rows are mounted, and release it. */
  settleReadingPosition: () => void;
  /** Provided around this scroller's rows so their disclosures can hold it. */
  disclosureAnchorNotifier: DisclosureAnchorNotifier;
};

/**
 * Stick-to-bottom follow for a nested scroller (D302).
 *
 * Same contract as the main transcript: pin on mount, follow while pinned,
 * release only on a real upward gesture, and re-pin from a jump control.
 * Layout clamps and programmatic `scrollTo` never count as a user gesture.
 * A manual disclosure holds its own reading position here too (#324), and the
 * hold also reaches the scroller this one is nested in, because growing these
 * rows grows that one's content as well.
 */
export function useFollowScroll(): FollowScroll {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollGestureAtRef = useRef(-Infinity);
  const followFrameRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  /**
   * The reader's visible fragment, held across the commit an explicit
   * older-page read adds height above (ADR 0331). The dock's rows grow above a
   * released reading position, and native anchoring does not cover a scroller
   * sitting at the top or a page boundary that cuts a turn, so the hook keeps
   * the fragment itself: captured on the click, applied once after its rows
   * mount.
   */
  const prependAnchorRef = useRef<VisibleFragmentAnchor | null>(null);
  /** The read that armed that hold has settled (see `settleReadingPosition`). */
  const prependAnchorSettledRef = useRef(false);
  /** Drop the hold and the read it was armed for, together. */
  const clearPrependAnchor = useCallback(() => {
    prependAnchorRef.current = null;
    prependAnchorSettledRef.current = false;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: targetTop, behavior });
    // Record the position the scroller actually reached, not the one that was
    // asked for: a fractional device pixel ratio lands a fraction of a pixel
    // away, and the intended value would make the following native scroll event
    // read as the user scrolling up.
    if (behavior === "auto") lastScrollTopRef.current = el.scrollTop;
  }, []);

  const cancelFollowScroll = useCallback(() => {
    cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = 0;
  }, []);

  const recordScrollPosition = useCallback((top: number) => {
    lastScrollTopRef.current = top;
  }, []);
  /**
   * The residual write of the armed hold: `true` while the hold owns the
   * position, `false` when there is nothing to hold any more.
   *
   * The correction is measured against the layout the browser already
   * produced, native anchoring included, so the two never compensate twice.
   */
  const applyPrependAnchor = useCallback((): boolean => {
    const held = prependAnchorRef.current;
    if (!held) return false;
    const el = scrollRef.current;
    if (!el) {
      clearPrependAnchor();
      return false;
    }
    const current = remeasureVisibleFragment(el, held.messageId);
    if (!current) {
      // The fragment is no longer mounted: there is nothing to hold on to.
      clearPrependAnchor();
      return false;
    }
    const resolution = resolvePrependAnchor(held, current, el);
    if (
      isPrependAnchorPending({
        gainedAbove: resolution.gainedAbove,
        readSettled: prependAnchorSettledRef.current,
      })
    ) {
      // Nothing landed above this fragment yet: this is not the commit the
      // hold was taken for, so keep it at the reader's current reading line.
      prependAnchorRef.current = { ...held, offset: current.offset };
      return true;
    }
    clearPrependAnchor();
    if (resolution.gainedAbove < PREPEND_ANCHOR_TOLERANCE_PX) return false;
    if (resolution.target === null) return false;
    el.scrollTop = resolution.target;
    recordScrollPosition(el.scrollTop);
    return true;
  }, [clearPrependAnchor, recordScrollPosition]);

  const holdReadingPosition = useCallback(() => {
    // A pinned scroller follows the newest row: rows added above it cannot
    // move the bottom, and a hold would only fight the follow.
    if (pinnedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const held = captureVisibleFragment(el);
    if (!held) return;
    prependAnchorRef.current = held;
    prependAnchorSettledRef.current = false;
  }, []);

  const settleReadingPosition = useCallback(() => {
    if (!prependAnchorRef.current) return;
    prependAnchorSettledRef.current = true;
    applyPrependAnchor();
  }, [applyPrependAnchor]);
  const {
    notifier: disclosureAnchorNotifier,
    restore: restoreDisclosureAnchor,
    release: releaseDisclosureAnchor,
    isHeld: isDisclosureAnchorHeld,
  } = useDisclosureAnchor(
    scrollRef,
    useCallback(() => {
      cancelFollowScroll();
      pinnedRef.current = false;
      setShowJump(true);
    }, [cancelFollowScroll]),
    recordScrollPosition,
  );

  const markScrollGesture = useCallback(
    (event: Event) => {
      const input = readScrollInputContext(
        event,
        scrollRef.current,
        contentRef.current,
      );
      if (!isScrollGestureInput(event.type as ScrollInputType, input)) return;
      lastScrollGestureAtRef.current = performance.now();
      releaseDisclosureAnchor();
    },
    [releaseDisclosureAnchor],
  );

  useEffect(() => {
    const el = scrollRef.current;
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

  useLayoutEffect(() => {
    releaseDisclosureAnchor();
    clearPrependAnchor();
    cancelFollowScroll();
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom();
  }, [cancelFollowScroll, clearPrependAnchor, releaseDisclosureAnchor, scrollToBottom]);

  const scheduleFollowScroll = useCallback(() => {
    // A queued follow frame must not move the title the reader just toggled:
    // the observer below already refuses to, and this path would undo it.
    if (!pinnedRef.current || followFrameRef.current !== 0) return;
    if (isDisclosureAnchorHeld()) return;
    if (prependAnchorRef.current) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = 0;
      if (pinnedRef.current) scrollToBottom();
    });
  }, [isDisclosureAnchorHeld, scrollToBottom]);

  // Re-pin in the observer callback itself (D287): a rAF scheduled from
  // ResizeObserver paints one unpinned frame before the follow lands. A held
  // disclosure position takes precedence — it is what keeps the clicked title
  // still while the dock's rows animate. (`useDisclosureAnchor` already passes
  // this hold outward to the scroller this one is nested in.) An explicit
  // earlier-page hold takes the position next: it owns it until its read lands,
  // so re-bottoming here would throw the reader's place away.
  const followScrollNow = useCallback(() => {
    if (restoreDisclosureAnchor()) return;
    if (applyPrependAnchor()) return;
    if (!pinnedRef.current) return;
    cancelFollowScroll();
    scrollToBottom();
  }, [applyPrependAnchor, cancelFollowScroll, restoreDisclosureAnchor, scrollToBottom]);

  useEffect(() => cancelFollowScroll, [cancelFollowScroll]);
  useEffect(() => releaseDisclosureAnchor, [releaseDisclosureAnchor]);
  useEffect(() => clearPrependAnchor, [clearPrependAnchor]);

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wasPinned = pinnedRef.current;
    // Real input is compared exactly; without it, sub-pixel slack keeps a
    // fractional device pixel ratio from reading as the user scrolling up.
    const gesturing = isRecentScrollGesture(
      performance.now(),
      lastScrollGestureAtRef.current,
    );
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
      setShowJump(true);
    } else if (transition.releasedFollow) {
      pinnedRef.current = wasPinned;
      setShowJump(!wasPinned);
      scheduleFollowScroll();
    } else {
      pinnedRef.current = transition.pinned;
      setShowJump(transition.showJump);
    }
  }, [cancelFollowScroll, scheduleFollowScroll]);

  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(followScrollNow);
    ro.observe(content, { box: "border-box" });
    ro.observe(scroller, { box: "border-box" });
    return () => ro.disconnect();
  }, [followScrollNow]);

  const jumpToLatest = useCallback(() => {
    releaseDisclosureAnchor();
    clearPrependAnchor();
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    );
  }, [clearPrependAnchor, releaseDisclosureAnchor, scrollToBottom]);

  const releaseFollow = useCallback(() => {
    releaseDisclosureAnchor();
    clearPrependAnchor();
    cancelFollowScroll();
    pinnedRef.current = false;
    setShowJump(true);
  }, [cancelFollowScroll, clearPrependAnchor, releaseDisclosureAnchor]);

  return {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
    releaseFollow,
    holdReadingPosition,
    settleReadingPosition,
    disclosureAnchorNotifier,
  };
}

