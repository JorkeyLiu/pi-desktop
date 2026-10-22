import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORY_REVEAL_THRESHOLD_PX,
  TRANSCRIPT_REPIN_THRESHOLD_PX,
  TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS,
  isHistoryRevealPosition,
  isLaterRevealPosition,
  isRecentScrollGesture,
  isTranscriptBottom,
  LATER_REVEAL_THRESHOLD_PX,
  reduceTranscriptScroll,
  shouldContinueEarlierHistory,
  shouldOfferLatestNavigation,
  transcriptHasLayout,
} from "../src/lib/transcript-scroll.ts";

function update(overrides = {}) {
  return reduceTranscriptScroll({
    previousScrollTop: 500,
    scrollTop: 500,
    scrollHeight: 1_000,
    clientHeight: 500,
    wasPinned: true,
    ...overrides,
  });
}

test("the first small upward scroll releases transcript follow", () => {
  const result = update({ scrollTop: 499 });

  assert.equal(result.movedUp, true);
  assert.equal(result.releasedFollow, true);
  assert.equal(result.pinned, false);
  assert.equal(result.showJump, true);
});

test("layout clamping at the exact bottom preserves transcript follow", () => {
  const result = update({
    previousScrollTop: 500,
    scrollTop: 480,
    scrollHeight: 980,
  });

  assert.equal(result.movedUp, true);
  assert.equal(result.distanceFromBottom, 0);
  assert.equal(result.releasedFollow, false);
  assert.equal(result.pinned, true);
  assert.equal(result.showJump, false);
});

test("content growth cannot re-pin a manually released transcript", () => {
  const result = update({
    previousScrollTop: 499,
    scrollTop: 499,
    scrollHeight: 1_008,
    wasPinned: false,
  });

  assert.equal(result.distanceFromBottom, 9);
  assert.equal(result.pinned, false);
});

test("scrolling down near the bottom resumes transcript follow", () => {
  const result = update({
    previousScrollTop: 450,
    scrollTop: 500 - TRANSCRIPT_REPIN_THRESHOLD_PX + 1,
    wasPinned: false,
  });

  assert.equal(result.movedDown, true);
  assert.equal(result.pinned, true);
  assert.equal(result.showJump, false);
});

test("programmatic downward scrolling keeps existing follow mode pinned", () => {
  const result = update({
    previousScrollTop: 200,
    scrollTop: 250,
  });

  assert.equal(result.movedDown, true);
  assert.equal(result.pinned, true);
  assert.equal(result.showJump, false);
});

test("jump control stays visible while an unpinned transcript is away from bottom", () => {
  const result = update({
    previousScrollTop: 420,
    scrollTop: 421,
    wasPinned: false,
  });

  assert.equal(result.pinned, false);
  assert.equal(result.showJump, true);
});

test("a scroll event that follows user input is a gesture", () => {
  assert.equal(isRecentScrollGesture(100, 99), true);
  assert.equal(
    isRecentScrollGesture(
      TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS,
      0,
    ),
    true,
  );
});

test("a scroll event without recent user input is not a gesture", () => {
  assert.equal(
    isRecentScrollGesture(
      TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS + 1,
      0,
    ),
    false,
  );
  assert.equal(isRecentScrollGesture(100, -Infinity), false);
});

test("a collapsed scroller has no layout", () => {
  assert.equal(transcriptHasLayout({ scrollHeight: 0, clientHeight: 0 }), false);
  assert.equal(transcriptHasLayout({ scrollHeight: 800, clientHeight: 0 }), false);
  assert.equal(transcriptHasLayout({ scrollHeight: 800, clientHeight: 400 }), true);
});

test("a collapsed scroller is not a history-reveal position", () => {
  assert.equal(
    isHistoryRevealPosition({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
    false,
  );
});

test("a pinned overflowing transcript does not page from a stale zero offset", () => {
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: 0, scrollHeight: 4_000, clientHeight: 800 },
      true,
    ),
    false,
  );
});

test("an underfilled pinned tail still reveals earlier history", () => {
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: 0, scrollHeight: 400, clientHeight: 800 },
      true,
    ),
    true,
  );
});

test("an unpinned transcript at the top reveals earlier history", () => {
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: HISTORY_REVEAL_THRESHOLD_PX, scrollHeight: 4_000, clientHeight: 800 },
      false,
    ),
    true,
  );
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: HISTORY_REVEAL_THRESHOLD_PX + 1, scrollHeight: 4_000, clientHeight: 800 },
      false,
    ),
    false,
  );
});

test("a one-pixel overflow is not a pinned overflowing transcript", () => {
  // The overflow test is deliberately slack by one pixel: a fractional layout
  // can leave a single pixel that no scroll event can retire, and a pinned
  // transcript there is genuinely at its own top.
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: 0, scrollHeight: 801, clientHeight: 800 },
      true,
    ),
    true,
  );
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: 0, scrollHeight: 802, clientHeight: 800 },
      true,
    ),
    false,
  );
});

test("a pinned overflowing transcript is suppressed anywhere in the band", () => {
  // The suppression is about the offset being stale, not about it being zero:
  // the caller passes `pinned` only for an offset its own event did not produce.
  assert.equal(
    isHistoryRevealPosition(
      {
        scrollTop: HISTORY_REVEAL_THRESHOLD_PX,
        scrollHeight: 900,
        clientHeight: 800,
      },
      true,
    ),
    false,
  );
  assert.equal(
    isHistoryRevealPosition(
      {
        scrollTop: HISTORY_REVEAL_THRESHOLD_PX + 1,
        scrollHeight: 900,
        clientHeight: 800,
      },
      true,
    ),
    false,
  );
});

test("the near-bottom band is the only automatic later-page trigger", () => {
  const at = (scrollTop, scrollHeight = 2_000, clientHeight = 500) => ({
    scrollTop, scrollHeight, clientHeight,
  });
  assert.equal(isLaterRevealPosition(at(1_500 - LATER_REVEAL_THRESHOLD_PX)), true);
  assert.equal(isLaterRevealPosition(at(1_500 - LATER_REVEAL_THRESHOLD_PX - 1)), false);
  // An underfilled window is at its own bottom, so it continues forward.
  assert.equal(isLaterRevealPosition(at(0, 400, 500)), true);
  // A scroller without layout reports no position at all.
  assert.equal(isLaterRevealPosition(at(0, 0, 0)), false);
});

test("a cold pane does not continue earlier history before its first position exists", () => {
  // The bounded first commit is expanded, the veil lifts, and a pinned pane is
  // re-bottomed across several layout passes. Through all of it an underfilled
  // commit reports a near-top offset, so the offset alone cannot authorize a
  // page read for a reader who never left the newest turn.
  const underfilled = { scrollTop: 0, scrollHeight: 400, clientHeight: 800 };
  assert.equal(
    shouldContinueEarlierHistory({
      geometry: underfilled, pinned: true, positioned: false, covered: false,
    }),
    false,
  );
  // The same geometry once the pane has finished establishing its position.
  assert.equal(
    shouldContinueEarlierHistory({
      geometry: underfilled, pinned: true, positioned: true, covered: false,
    }),
    true,
  );
});

test("history continuation still fills an underfilled pane while the veil covers it", () => {
  const underfilled = { scrollTop: 0, scrollHeight: 400, clientHeight: 800 };
  assert.equal(
    shouldContinueEarlierHistory({
      geometry: underfilled, pinned: true, positioned: false, covered: true,
    }),
    true,
  );
  // Covering never widens the reveal test itself.
  assert.equal(
    shouldContinueEarlierHistory({
      geometry: { scrollTop: 400, scrollHeight: 2_000, clientHeight: 800 },
      pinned: false, positioned: false, covered: true,
    }),
    false,
  );
  assert.equal(
    shouldContinueEarlierHistory({
      geometry: { scrollTop: 0, scrollHeight: 2_000, clientHeight: 800 },
      pinned: true, positioned: true, covered: false,
    }),
    false,
    "a pinned overflowing pane still ignores a stale zero offset",
  );
});

/*
  The floating jump control is a navigation affordance, not a copy of the follow
  flag. A transcript that has arrived at the bottom of the newest range has
  nowhere to go, so the control is not shown there - including when follow was
  released and the arrival was a layout clamp rather than a downward gesture.
*/

test("an unpinned transcript that arrives at the newest bottom stops offering latest", () => {
  const transition = reduceTranscriptScroll({
    previousScrollTop: 620,
    scrollTop: 600,
    scrollHeight: 1_100,
    clientHeight: 500,
    wasPinned: false,
  });

  // Content below the reader shrank and clamped the offset to the new end: the
  // reducer keeps follow released and the old gate kept the button up.
  assert.equal(transition.distanceFromBottom, 0);
  assert.equal(transition.pinned, false);
  assert.equal(transition.showJump, true);
  assert.equal(
    shouldOfferLatestNavigation({
      followReleased: true,
      atRangeBottom: isTranscriptBottom({
        scrollTop: 600, scrollHeight: 1_100, clientHeight: 500,
      }),
      hasMoreAfter: false,
      historical: false,
    }),
    false,
  );
});

test("an unpinned transcript above the bottom still offers latest", () => {
  assert.equal(
    shouldOfferLatestNavigation({
      followReleased: true,
      atRangeBottom: isTranscriptBottom({
        scrollTop: 400, scrollHeight: 1_100, clientHeight: 500,
      }),
      hasMoreAfter: false,
      historical: false,
    }),
    true,
  );
});

test("a followed transcript never offers latest, even above the bottom", () => {
  // Streaming grows the content below the viewport before follow re-bottoms it;
  // that frame is not a navigation the reader owns.
  assert.equal(
    shouldOfferLatestNavigation({
      followReleased: false,
      atRangeBottom: false,
      hasMoreAfter: false,
      historical: false,
    }),
    false,
  );
});

test("a bounded range or an explicit reading window still offers latest", () => {
  // Later pages are loaded but not in view: the newest turn is not on screen.
  assert.equal(
    shouldOfferLatestNavigation({
      followReleased: true,
      atRangeBottom: true,
      hasMoreAfter: true,
      historical: false,
    }),
    true,
  );
  // A search target or a restored bookmark holds a frozen range: its bottom is
  // not the live tail, so returning to the live conversation stays available.
  assert.equal(
    shouldOfferLatestNavigation({
      followReleased: true,
      atRangeBottom: true,
      hasMoreAfter: false,
      historical: true,
    }),
    true,
  );
});

test("a scroller without a layout box is never at its bottom", () => {
  assert.equal(isTranscriptBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), false);
  assert.equal(isTranscriptBottom({ scrollTop: 0, scrollHeight: 900, clientHeight: 0 }), false);
});

test("a fractional device pixel ratio at the bottom is the bottom", () => {
  // Asked for 841, reported 840.909: sub-pixel slack, not a reading position.
  assert.equal(isTranscriptBottom({ scrollTop: 840.909, scrollHeight: 1_341, clientHeight: 500 }), true);
});
