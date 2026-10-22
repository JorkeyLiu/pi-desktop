import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  isPrependAnchorPending,
  PREPEND_ANCHOR_TOLERANCE_PX,
  resolvePrependAnchor,
} = await import("../src/lib/transcript-prepend-anchor.ts");

/*
  Reading upward holds the fragment the reader is looking at, not a row count and
  not a captured scroll height (ADR 0331). The hold is a residual: it is
  resolved against the layout the browser already produced, so the assertion
  here is always "the fragment ends up on the offset it was captured at".
*/

/** A fragment captured at `offset`, then re-measured after a commit. */
function hold({ offset = 40, contentTop = 1_000 } = {}) {
  return { offset, contentTop };
}
function scroller({ scrollTop = 1_040, scrollHeight = 20_000, clientHeight = 600 } = {}) {
  return { scrollTop, scrollHeight, clientHeight };
}

test("a prepend above the fragment moves the viewport by exactly the added height", () => {
  // 9 330 px landed above the fragment; native anchoring performed no
  // adjustment (the exact top) and the viewport is still where it was.
  const anchor = hold({ offset: 0, contentTop: 0 });
  const current = { offset: 9_330, contentTop: 9_330 };

  const resolution = resolvePrependAnchor(anchor, current, scroller({ scrollTop: 0 }));

  assert.equal(resolution.gainedAbove, 9_330);
  assert.equal(resolution.target, 9_330);
});

test("the residual is measured against the layout the browser already produced", () => {
  // Native anchoring held 13 679 of the 18 712 px a merged turn added above the
  // fragment: the viewport already moved, and only the remaining 4 973 px is
  // owed. Adding the whole gain here would move the reader twice.
  const anchor = hold({ offset: 60, contentTop: 1_000 });
  const current = { offset: 5_033, contentTop: 18_712 };
  const geometry = scroller({ scrollTop: 13_679 });

  const resolution = resolvePrependAnchor(anchor, current, geometry);

  assert.equal(resolution.gainedAbove, 17_712);
  assert.equal(resolution.target, 18_652, "the fragment returns to its 60 px offset");
  assert.equal(
    resolution.target - geometry.scrollTop,
    current.offset - anchor.offset,
    "the write is the visible residual, not the whole prepend",
  );
});

test("a commit that added nothing above the fragment is not a prepend", () => {
  const resolution = resolvePrependAnchor(hold(), hold(), scroller());

  assert.ok(Math.abs(resolution.gainedAbove) < PREPEND_ANCHOR_TOLERANCE_PX);
  assert.equal(resolution.target, null);
});

test("content that shrank above the fragment is not corrected", () => {
  const anchor = hold({ contentTop: 1_000 });
  const current = { offset: -20, contentTop: 940 };

  assert.equal(resolvePrependAnchor(anchor, current, scroller()).target, null);
});

test("a fragment already on its offset is not written again", () => {
  const anchor = hold({ offset: 40, contentTop: 1_000 });
  const current = { offset: 40, contentTop: 1_040 };

  const resolution = resolvePrependAnchor(anchor, current, scroller({ scrollTop: 1_000 }));

  assert.equal(resolution.gainedAbove, 40);
  assert.equal(resolution.target, null);
});

test("a target the scrollable range cannot reach stays at the browser boundary", () => {
  // The fragment sits near the bottom of the content: the offset it was read at
  // could only be restored by scrolling past the end, so it clamps.
  const anchor = hold({ offset: 40, contentTop: 500 });
  const current = { offset: 90, contentTop: 1_090 };
  const geometry = scroller({ scrollTop: 550, scrollHeight: 1_140, clientHeight: 600 });

  assert.equal(resolvePrependAnchor(anchor, current, geometry).target, 540);
  assert.equal(resolvePrependAnchor(anchor, current, {
    ...geometry, scrollTop: 540,
  }).target, null);
});

/*
  A hold is armed before the commit that adds height above and applied once
  after it. Between the two it follows the reader's reading line, so it has to
  survive a commit that mounted nothing. It must not survive the read finishing
  with nothing above: the hold would then measure against a layout it was never
  taken for, on every later commit.
*/

test("a hold follows the reading line while its read is still in flight", () => {
  assert.equal(isPrependAnchorPending({ gainedAbove: 0, readSettled: false }), true);
  // A commit that mounted nothing above yet is not the one the hold waits for.
  assert.equal(isPrependAnchorPending({ gainedAbove: -3, readSettled: false }), true);
});

test("a hold whose read settled without adding height above is released", () => {
  // The older page failed, or returned nothing the pane could mount: no commit
  // is coming for the hold.
  assert.equal(isPrependAnchorPending({ gainedAbove: 0, readSettled: true }), false);
});

test("a hold whose height already landed is applied, never kept", () => {
  assert.equal(
    isPrependAnchorPending({ gainedAbove: PREPEND_ANCHOR_TOLERANCE_PX, readSettled: false }),
    false,
  );
  assert.equal(
    isPrependAnchorPending({ gainedAbove: 120, readSettled: true }),
    false,
  );
});
