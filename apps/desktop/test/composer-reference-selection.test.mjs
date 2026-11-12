import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  caretIndexForPoint,
  referenceDeletionSpan,
  selectionEndForPoint,
  selectionRangeFromPoints,
  selectionStartForPoint,
  skipReferenceCaret,
} = await import("../src/features/chat/composer/reference-selection.ts");
const { isChipTokenChar, nextChipToken } = await import(
  "../src/features/chat/composer/reference-model.ts"
);

const tokenChar = nextChipToken();
assert.equal(isChipTokenChar(tokenChar), true);
/** "@image.png" is 10 code units; the label length only feeds snap decisions. */
const LABEL_LENGTH = 10;

test("a plain point maps straight to its draft index", () => {
  for (const index of [0, 3, 7]) {
    assert.equal(caretIndexForPoint({ index }), index);
    assert.equal(caretIndexForPoint({ index, inside: null }), index);
    assert.equal(selectionStartForPoint({ index }), index);
    assert.equal(selectionEndForPoint({ index }), index);
  }
});

test("a caret never lands inside a label: it snaps to the nearer boundary", () => {
  assert.equal(caretIndexForPoint({ index: 4, inside: { offset: 0, length: LABEL_LENGTH } }), 4);
  assert.equal(
    caretIndexForPoint({ index: 4, inside: { offset: LABEL_LENGTH, length: LABEL_LENGTH } }),
    5,
    "a point on the label's last boundary belongs after the token",
  );
  assert.equal(
    caretIndexForPoint({ index: 4, inside: { offset: 3, length: LABEL_LENGTH } }),
    4,
    "before the middle rounds back",
  );
  assert.equal(
    caretIndexForPoint({ index: 4, inside: { offset: 6, length: LABEL_LENGTH } }),
    5,
    "after the middle rounds forward",
  );
  assert.equal(
    caretIndexForPoint({ index: 4, inside: { offset: 5, length: LABEL_LENGTH } }),
    5,
    "an exact half rounds forward",
  );
});

test("a selection touching past a label's first character includes the whole token", () => {
  // Standard label length is odd, so offset 4 of 10 is the lower half.
  assert.equal(selectionStartForPoint({ index: 2 }), 2);
  assert.equal(
    selectionStartForPoint({ index: 2, inside: { offset: 0, length: LABEL_LENGTH } }),
    2,
  );
  assert.equal(
    selectionStartForPoint({ index: 2, inside: { offset: 1, length: LABEL_LENGTH } }),
    2,
    "a touch on the first label character starts the selection at the token",
  );
  assert.equal(
    selectionStartForPoint({ index: 2, inside: { offset: 9, length: LABEL_LENGTH } }),
    2,
  );
  assert.equal(
    selectionStartForPoint({ index: 2, inside: { offset: 10, length: LABEL_LENGTH } }),
    3,
    "a point on the closing boundary excludes the token",
  );
});

test("a selection ending past the leading boundary includes the whole token", () => {
  assert.equal(selectionEndForPoint({ index: 6 }), 6);
  assert.equal(
    selectionEndForPoint({ index: 6, inside: { offset: 0, length: LABEL_LENGTH } }),
    6,
    "a point on the opening boundary excludes the token",
  );
  assert.equal(
    selectionEndForPoint({ index: 6, inside: { offset: 1, length: LABEL_LENGTH } }),
    7,
  );
  assert.equal(
    selectionEndForPoint({ index: 6, inside: { offset: LABEL_LENGTH, length: LABEL_LENGTH } }),
    7,
  );
});

test("touch-the-edge selections normalize to the whole token", () => {
  // A drag that ends on the token's trailing boundary and starts just past it.
  assert.deepEqual(
    selectionRangeFromPoints(
      { index: 0, inside: { offset: 9, length: LABEL_LENGTH } },
      { index: 1, inside: { offset: 1, length: LABEL_LENGTH } },
    ),
    { start: 0, end: 2 },
  );
  // A touch of the last label character alone.
  assert.deepEqual(
    selectionRangeFromPoints(
      { index: 0, inside: { offset: 9, length: LABEL_LENGTH } },
      { index: 0, inside: { offset: 10, length: LABEL_LENGTH } },
    ),
    { start: 0, end: 1 },
    "an endpoint strictly inside the token still expands it",
  );
  // Nothing touching the token stays where it was.
  assert.deepEqual(
    selectionRangeFromPoints(
      { index: 0, inside: { offset: 0, length: LABEL_LENGTH } },
      { index: 0 },
    ),
    { start: 0, end: 0 },
  );
});

test("a token sits on the boundary exactly before the token's label", () => {
  const points = [
    { index: 0, inside: { offset: 0, length: LABEL_LENGTH } },
    { index: 0, inside: { offset: 10, length: LABEL_LENGTH } },
  ];
  assert.deepEqual(
    selectionRangeFromPoints(points[0], points[1]),
    { start: 0, end: 1 },
    "the token start stays outside while the token end expands",
  );
  // A caret-range inside the label normalizes outward as well.
  assert.deepEqual(
    selectionRangeFromPoints(
      { index: 0, inside: { offset: 4, length: LABEL_LENGTH } },
      { index: 0, inside: { offset: 5, length: LABEL_LENGTH } },
    ),
    { start: 0, end: 1 },
    "an interior touch expands on both endpoints",
  );
});

test("an arrow key steps over a reference token instead of into it", () => {
  const value = `a${tokenChar}b`;
  assert.equal(skipReferenceCaret(value, 2, -1), 1, "left from after the token skips to before it");
  assert.equal(skipReferenceCaret(value, 1, 1), 2, "right from before the token skips past it");
  assert.equal(skipReferenceCaret(value, 1, -1), null, "plain text keeps native movement");
  assert.equal(skipReferenceCaret(value, 2, 1), null);
  assert.equal(skipReferenceCaret(tokenChar, 1, -1), 0, "a token-only draft moves to its start");
  assert.equal(skipReferenceCaret(tokenChar, 0, 1), 1, "a token-only draft moves to its end");
});

test("Backspace and Delete remove the whole adjacent token", () => {
  const value = `a${tokenChar}b`;
  assert.deepEqual(referenceDeletionSpan(value, 2, -1), { start: 1, end: 2 }, "Backspace after a token");
  assert.deepEqual(referenceDeletionSpan(value, 1, 1), { start: 1, end: 2 }, "Delete before a token");
  assert.equal(referenceDeletionSpan(value, 1, -1), null);
  assert.equal(referenceDeletionSpan(value, 2, 1), null);
  assert.deepEqual(referenceDeletionSpan(tokenChar, 1, -1), { start: 0, end: 1 });
});
