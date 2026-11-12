import { isChipTokenChar } from "./reference-model";

/**
 * Draft offsets for reference tokens inside the editable.
 *
 * The draft keeps one private-use sentinel per reference, so a reference is one
 * draft character, while the editor shows a variable-length `@name` label. A
 * DOM point therefore cannot be translated to a draft offset by counting
 * characters alone: a point inside a label belongs to no single draft offset.
 * These helpers hold the rules the DOM walk feeds them, so caret placement,
 * selection expansion and whole-token deletion stay one source of truth — and
 * are testable without a DOM.
 */

/** How far a DOM point sits into one reference's visible label. */
export type ReferencePointInside = { offset: number; length: number };

/** One DOM point resolved against the draft: its token start, plus the label. */
export type ReferencePoint = { index: number; inside?: ReferencePointInside | null };

/** Draft span of one whole reference token. */
export type ReferenceSpan = { start: number; end: number };

/**
 * The caret a DOM point stands for. A point inside a label is never a draft
 * position of its own, so it snaps to the nearer boundary: before or after the
 * whole token. A label half point rounds forward.
 */
export function caretIndexForPoint(point: ReferencePoint): number {
  const inside = point.inside;
  if (!inside) return point.index;
  if (inside.offset <= 0) return point.index;
  if (inside.offset >= inside.length) return point.index + 1;
  return inside.offset * 2 >= inside.length ? point.index + 1 : point.index;
}

/**
 * The draft position a selection's first endpoint stands for. Any touch that
 * reaches past the very first label character selects the whole token, and a
 * point on the token's trailing boundary leaves the token out.
 */
export function selectionStartForPoint(point: ReferencePoint): number {
  const inside = point.inside;
  if (!inside) return point.index;
  return inside.offset >= inside.length ? point.index + 1 : point.index;
}

/**
 * The draft position a selection's last endpoint stands for. Any touch past the
 * leading boundary includes the whole token; a point on that boundary leaves
 * the token out, so a selection that stops exactly before it stays untouched.
 */
export function selectionEndForPoint(point: ReferencePoint): number {
  const inside = point.inside;
  if (!inside) return point.index;
  return inside.offset <= 0 ? point.index : point.index + 1;
}

/** Ordered draft indices of a selection whose endpoints the caller has. */
export function selectionRangeFromPoints(
  startPoint: ReferencePoint,
  endPoint: ReferencePoint,
): ReferenceSpan {
  const start = selectionStartForPoint(startPoint);
  const end = Math.max(start, selectionEndForPoint(endPoint));
  return { start, end };
}

function isReferenceCharAt(value: string, index: number): boolean {
  return isChipTokenChar(value[index] ?? "");
}

/**
 * The caret position one collapsed arrow key move must land on when a whole
 * reference sits next to the caret: a token is one character, so crossing it
 * never stops inside its label. `null` keeps the browser's own movement.
 */
export function skipReferenceCaret(
  value: string,
  index: number,
  direction: -1 | 1,
): number | null {
  const from = direction < 0 ? index - 1 : index;
  if (!isReferenceCharAt(value, from)) return null;
  return direction < 0 ? index - 1 : index + 1;
}

/**
 * The draft span Backspace or Delete removes when a reference token ends at the
 * caret: deleting one label character would split an atomic token, so the whole
 * token goes instead. `null` keeps the browser's own deletion.
 */
export function referenceDeletionSpan(
  value: string,
  index: number,
  direction: -1 | 1,
): ReferenceSpan | null {
  const from = direction < 0 ? index - 1 : index;
  if (!isReferenceCharAt(value, from)) return null;
  return { start: from, end: from + 1 };
}
