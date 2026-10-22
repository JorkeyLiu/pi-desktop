export const TRANSCRIPT_REPIN_THRESHOLD_PX = 48;

/**
 * Sub-pixel slack for scroll events that no user input produced.
 *
 * A fractional device pixel ratio makes the browser report a position a
 * fraction of a pixel away from the `scrollTop` a layout correction asked for
 * (at DPR 1.1: asked for 841, reported 840.909). Compared strictly that
 * fraction reads as the user scrolling up and drops follow mode. Callers pass
 * `tolerancePx: 0` for anything a real gesture produced, so an intentional
 * one-pixel scroll still unpins.
 */
export const TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX = 1;

/**
 * Near-top band that grows the mounted window or fetches an older page (D269).
 * Shared by the scroll handler and the history-boundary observer so the two
 * triggers cannot drift apart.
 */
export const HISTORY_REVEAL_THRESHOLD_PX = 120;

/**
 * Near-bottom band that fetches the next page of later messages (D269).
 *
 * Reading forward is not a control: once the reader approaches the bottom of
 * the loaded window the next page is fetched, exactly like the near-top band
 * fetches the previous one. The band matches the earlier-history band so the
 * two boundaries cannot drift apart.
 */
export const LATER_REVEAL_THRESHOLD_PX = HISTORY_REVEAL_THRESHOLD_PX;

export type TranscriptScrollerGeometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** A scroller that has not been measured yet, or is skipped by `content-visibility`. */
export function transcriptHasLayout(
  geometry: Pick<TranscriptScrollerGeometry, "scrollHeight" | "clientHeight">,
): boolean {
  return geometry.clientHeight > 0 && geometry.scrollHeight > 0;
}

/**
 * Whether the visible top should grow or page earlier history (D269).
 *
 * A collapsed box reports `scrollTop === 0` and must not be treated as "the
 * user is reading the top". A pinned overflowing transcript is at (or about
 * to be restored to) the bottom; a stale zero offset there must not page the
 * conversation back to its start. An underfilled pinned tail still advances:
 * it does not overflow, so the top boundary is genuinely in view. Callers pass
 * `pinned` only for an offset their own event did not produce: a real gesture
 * is the reader's position, not stale noise, and must still continue history.
 */
export function isHistoryRevealPosition(
  geometry: TranscriptScrollerGeometry,
  pinned = false,
): boolean {
  if (!transcriptHasLayout(geometry)) return false;
  const overflows = geometry.scrollHeight > geometry.clientHeight + 1;
  if (pinned && overflows) return false;
  return geometry.scrollTop <= HISTORY_REVEAL_THRESHOLD_PX;
}

/**
 * Whether the visible bottom should fetch the next page of later messages.
 *
 * A window that does not overflow is already at its own bottom, so it keeps
 * continuing forward until the newest page is loaded. A scroller without a
 * layout box (an unrendered pane, `content-visibility: hidden`) reports no
 * position at all and must never start a read.
 */
export function isLaterRevealPosition(
  geometry: TranscriptScrollerGeometry,
): boolean {
  if (!transcriptHasLayout(geometry)) return false;
  const distance = geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
  return distance <= LATER_REVEAL_THRESHOLD_PX;
}


/**
 * Whether the scroller sits at the bottom of the range it has loaded.
 *
 * This is geometry, not follow mode: a released scroller can be clamped onto the
 * bottom by content that shrank below it, by a grown viewport, or by a restored
 * offset, and none of those arrive as a downward gesture. The sub-pixel slack is
 * the same rounding disagreement `TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX`
 * covers. A box without layout is not at any position.
 */
export function isTranscriptBottom(geometry: TranscriptScrollerGeometry): boolean {
  if (!transcriptHasLayout(geometry)) return false;
  const distance =
    geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
  return distance <= TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX;
}

/**
 * Whether automatic history continuation may act on this offset.
 *
 * A pane's first frames are not a reading position. The bounded first commit is
 * expanded, the settle veil lifts, and a still-pinned transcript is re-bottomed
 * across several layout passes; an underfilled commit reports a near-top offset
 * through all of it, because its top boundary genuinely is in view.
 * `isHistoryRevealPosition` cannot tell that mounting geometry from a reader who
 * scrolled up, so continuation fetched an older page for someone who never left
 * the newest turn - and the page landed while the rows were still moving, which
 * is the jump.
 *
 * Continuation therefore needs the offset to mean what it says: the pane has
 * finished establishing its first position, or it is still behind the settle
 * veil, where an initial fill is measured and only shown once the geometry has
 * held still. Covering never widens the reveal test itself.
 */
export function shouldContinueEarlierHistory(input: {
  geometry: TranscriptScrollerGeometry;
  pinned: boolean;
  /** The pane has established its first position and its rows are presented. */
  positioned: boolean;
  /** The settle veil still covers the transcript. */
  covered: boolean;
}): boolean {
  if (!input.positioned && !input.covered) return false;
  return isHistoryRevealPosition(input.geometry, input.pinned);
}

export type TranscriptScrollInput = {
  previousScrollTop: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasPinned: boolean;
  /** Movement under this many pixels is not movement. */
  tolerancePx?: number;
};

export type TranscriptScrollTransition = {
  distanceFromBottom: number;
  movedUp: boolean;
  movedDown: boolean;
  releasedFollow: boolean;
  pinned: boolean;
  showJump: boolean;
};

/** Keep explicit follow mode separate from the near-bottom visual threshold. */
export function reduceTranscriptScroll({
  previousScrollTop,
  scrollTop,
  scrollHeight,
  clientHeight,
  wasPinned,
  tolerancePx = 0,
}: TranscriptScrollInput): TranscriptScrollTransition {
  const distanceFromBottom = Math.max(
    0,
    scrollHeight - scrollTop - clientHeight,
  );
  const movedUp = scrollTop < previousScrollTop - tolerancePx;
  const movedDown = scrollTop > previousScrollTop + tolerancePx;
  const nearBottom = distanceFromBottom < TRANSCRIPT_REPIN_THRESHOLD_PX;
  const releasedFollow = movedUp && distanceFromBottom > 0;
  const pinned = releasedFollow
    ? false
    : wasPinned || (movedDown && nearBottom);

  return {
    distanceFromBottom,
    movedUp,
    movedDown,
    releasedFollow,
    pinned,
    showJump: !pinned,
  };
}

/**
 * Whether the floating "jump to latest" control has a navigation left to offer.
 *
 * The control is not a copy of the follow flag. Follow is released by any real
 * upward gesture, and the reducer keeps it released through every later
 * non-gesture event - a clamp, a grown viewport, a restored offset. Rendered
 * from that flag alone the control stayed up after the reader had already been
 * carried back to the newest bottom, where it can only scroll nowhere.
 *
 * So the question is what the control would do:
 *
 * * A bounded range with later pages loaded but not in view still has the newest
 *   turn below the viewport, and a historical reading window (`focus` or
 *   `restored`) holds a frozen range whose bottom is not the live tail. Both
 *   offer the return.
 * * Otherwise the range in view ends at the newest message. There, released
 *   follow matters only while the reader is above the bottom; at the bottom
 *   itself nothing is owed.
 *
 * Follow mode is deliberately not re-pinned here: this decides visibility only.
 */
export function shouldOfferLatestNavigation(input: {
  /** Follow was released: the reader owns the viewport. */
  followReleased: boolean;
  /** The scroller sits at the bottom of the range it has loaded. */
  atRangeBottom: boolean;
  /** Later pages are loaded but not mounted below the viewport. */
  hasMoreAfter: boolean;
  /** A search target or a restored bookmark holds a historical range. */
  historical: boolean;
}): boolean {
  if (input.historical || input.hasMoreAfter) return true;
  return input.followReleased && !input.atRangeBottom;
}

/**
 * A real user scroll-up gesture (wheel, trackpad, touch, scrollbar drag,
 * keyboard) always precedes its scroll events by at most a frame or two, and
 * keeps firing while the gesture lasts. Programmatic follow scrolling and
 * layout-driven clamps (e.g. the composer collapsing after send) emit scroll
 * events with no preceding input.
 *
 * `handleScroll` releases follow only for events inside this window, so a
 * clamp between a follow `scrollTo` and its native event delivery can never
 * be mistaken for a user scrolling up.
 */
export const TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS = 200;

export function isRecentScrollGesture(
  now: number,
  lastGestureAt: number,
): boolean {
  return now - lastGestureAt <= TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS;
}

/** Keys whose native default moves the scroller the focused element sits in. */
export const SCROLL_GESTURE_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/** Marks a scroll container so input can be attributed to the nearest one. */
export const SCROLL_OWNER_ATTRIBUTE = "data-scroll-owner";

export type ScrollInputType =
  | "wheel"
  | "touchstart"
  | "touchmove"
  | "pointerdown"
  | "keydown";

export type ScrollInputContext = {
  /** Pressed key, for a `keydown`. */
  key?: string;
  /** The key event came from a text field, which owns its own key input. */
  editable?: boolean;
  /**
   * A nearer, scrollable owner sits between the event target and this one, so
   * that owner consumes the input (`overscroll-behavior: contain` keeps it
   * there) and this one does not scroll at all.
   */
  nestedOwner?: boolean;
  /**
   * The pointer went down on this owner's own surface — its scrollbar, its
   * padding, or its content — rather than on one of its controls. A press on a
   * control or an editable field is an ordinary click and cannot start a
   * scroll.
   */
  pointerOnScrollSurface?: boolean;
};

/**
 * Whether a nested scroll owner would consume a vertical wheel or touch
 * gesture.
 *
 * Only the vertical axis counts. An element with horizontal overflow alone —
 * a wide `pre` in a marked region, for instance — still lets the gesture chain
 * to the scroller behind it, so that scroller has to own the input; treating it
 * as consumed would leave the outer viewport unmoved but un-followed, and the
 * next follow frame would drag the reader back to the bottom.
 */
export function consumesVerticalScroll(geometry: {
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return geometry.scrollHeight > geometry.clientHeight + 1;
}

/**
 * Whether a DOM input can actually move *this* container.
 *
 * Only such input may release follow or a held disclosure position. A click on
 * a control, a keystroke in a text field, and a gesture a nested scroller
 * consumes must not: marking them lets the very next programmatic follow
 * scroll look like the user scrolling up.
 */
export function isScrollGestureInput(
  type: ScrollInputType,
  context: ScrollInputContext = {},
): boolean {
  if (context.nestedOwner) return false;
  if (type === "pointerdown") return context.pointerOnScrollSurface === true;
  if (type === "keydown") {
    if (context.editable) return false;
    return context.key !== undefined && SCROLL_GESTURE_KEYS.has(context.key);
  }
  return true;
}
