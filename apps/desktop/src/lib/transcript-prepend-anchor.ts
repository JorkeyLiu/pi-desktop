import { transcriptHasLayout } from "./transcript-scroll";

/*
  Reading position held across one upward-history commit (ADR 0331).

  Native scroll anchoring holds the row the reader is looking at while an older
  page or a grown mounted window adds height above it - except in two states:
  at `scrollTop === 0` the platform performs no adjustment at all, and inside an
  assistant turn that a page boundary cuts, the browser anchors somewhere other
  than the fragment in view (it held 13 679 of 18 712 px on the fixture).

  So the pane keeps one hold of its own: before the commit that adds height
  above, it records the visible *fragment* (`data-message-id`, the innermost row
  unit - an outer turn box legitimately grows at its own top), and after the
  commit it puts that fragment back on the same viewport offset. The correction
  is a residual: it is measured against where the browser already left the
  fragment, so native anchoring and this hold cannot both compensate.

  Fragment, not row: a page boundary is a physical offset, so it can cut inside
  a turn and prepend fragments into the box the reader is reading. The box's own
  top does not move in that case; the fragment inside it does.
*/

/** Fragment top must be below this line to be the reader's place. */
export const PREPEND_ANCHOR_LINE_PX = 120;

/** Sub-pixel slack for "nothing above moved" and "the viewport holds it". */
export const PREPEND_ANCHOR_TOLERANCE_PX = 0.5;

/** A mounted fragment, measured both on screen and in the scroller's content. */
export type VisibleFragmentFrame = {
  /** Fragment top relative to the scroller's top edge. */
  offset: number;
  /** Fragment top in the scroller's own content coordinates. */
  contentTop: number;
};

export type VisibleFragmentAnchor = VisibleFragmentFrame & {
  messageId: string;
};

export type PrependAnchorResolution = {
  /** Height added above the held fragment since it was captured. */
  gainedAbove: number;
  /**
   * The `scrollTop` that holds the fragment on the offset it was captured at,
   * or `null` when the fragment is already there (or the scrollable range
   * cannot reach it).
   */
  target: number | null;
};

function frameOf(scroller: HTMLElement, node: HTMLElement): VisibleFragmentFrame {
  const scrollerTop = scroller.getBoundingClientRect().top;
  const offset = node.getBoundingClientRect().top - scrollerTop;
  return { offset, contentTop: offset + scroller.scrollTop };
}

/**
 * The fragment at the reading line: the first mounted one whose bottom is below
 * it. `querySelector` order is document order, so a fragment rendered in more
 * than one place resolves to its outermost node, which is the one that moves
 * with the row.
 */
export function captureVisibleFragment(
  scroller: HTMLElement,
): VisibleFragmentAnchor | null {
  if (!transcriptHasLayout(scroller)) return null;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const line = Math.min(PREPEND_ANCHOR_LINE_PX, scroller.clientHeight / 4);
  for (const node of scroller.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const rect = node.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom - scrollerTop <= line) continue;
    const messageId = node.dataset.messageId;
    if (!messageId) continue;
    const offset = rect.top - scrollerTop;
    return { messageId, offset, contentTop: offset + scroller.scrollTop };
  }
  return null;
}

/** The same fragment after a commit, or `null` when it is no longer mounted. */
export function remeasureVisibleFragment(
  scroller: HTMLElement,
  messageId: string,
): VisibleFragmentFrame | null {
  if (!transcriptHasLayout(scroller)) return null;
  const node = scroller.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`,
  );
  if (!node || node.getClientRects().length === 0) return null;
  return frameOf(scroller, node);
}

/**
 * Where the viewport has to go to hold the fragment, and how much height landed
 * above it. A gain below the tolerance is not the prepend the hold was taken
 * for: the caller keeps holding and re-captures the reading line, which is
 * where the reader is now.
 */
export function resolvePrependAnchor(
  anchor: VisibleFragmentFrame,
  current: VisibleFragmentFrame,
  scroller: { scrollTop: number; scrollHeight: number; clientHeight: number },
): PrependAnchorResolution {
  const gainedAbove = current.contentTop - anchor.contentTop;
  if (gainedAbove < PREPEND_ANCHOR_TOLERANCE_PX) return { gainedAbove, target: null };
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const target = Math.min(
    maxScrollTop,
    Math.max(0, current.contentTop - anchor.offset),
  );
  return {
    gainedAbove,
    target: Math.abs(target - scroller.scrollTop) < PREPEND_ANCHOR_TOLERANCE_PX
      ? null
      : target,
  };
}

/**
 * Whether an armed hold still has a commit to apply.
 *
 * The hold is applied once in the first commit after the page it was taken for.
 * Until that commit arrives it follows the reader's reading line, so a commit
 * that mounted nothing above it is not the one it waits for. Once the read has
 * settled with nothing added above, no commit is coming for it: the hold is
 * released rather than measuring every later, unrelated commit against a layout
 * it was never taken for.
 */
export function isPrependAnchorPending(input: {
  /** Height added above the held fragment since it was captured. */
  gainedAbove: number;
  /** The read that asked for the height has completed. */
  readSettled: boolean;
}): boolean {
  return input.gainedAbove < PREPEND_ANCHOR_TOLERANCE_PX && !input.readSettled;
}
