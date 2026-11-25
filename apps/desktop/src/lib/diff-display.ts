/**
 * The transcript's existing 64 KiB content ceiling, applied after escaping.
 * The value deliberately mirrors `TRANSCRIPT_CONTENT_LIMIT` (a transcript-read
 * constant that drags the reading runtime into this pure tokenizer's import
 * graph); this export is the single canonical bound every diff renderer,
 * test, and the component spec refer to.
 */
export const MAX_ESCAPED_DIFF_CHARS = 64 * 1024;

export type DiffTextSegment = {
  text: string;
  /** Generated display escape, not literal source text. */
  escaped: boolean;
};

export type DiffDisplayBudget = {
  remaining: number;
  truncated: boolean;
};

export function createDiffDisplayBudget(
  characters = MAX_ESCAPED_DIFF_CHARS,
): DiffDisplayBudget {
  return {
    remaining: Math.max(0, Math.floor(characters)),
    truncated: false,
  };
}

function isInvisibleControl(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

/**
 * Tokenize raw diff text into React text nodes without mutating the wire value.
 * Tabs, newlines, and ordinary Unicode stay literal; invisible C0 (except TAB
 * and LF), DEL, and C1 become unambiguous `\\uXXXX` display segments.
 */
export function takeDiffDisplayText(
  source: string,
  budget: DiffDisplayBudget,
): DiffTextSegment[] {
  if (budget.truncated || budget.remaining === 0) {
    if (source.length > 0) budget.truncated = true;
    return [];
  }

  const segments: DiffTextSegment[] = [];
  let plain = "";
  const flushPlain = () => {
    if (plain.length > 0) {
      segments.push({ text: plain, escaped: false });
      plain = "";
    }
  };

  for (const character of source) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isInvisibleControl(codePoint)) {
      const hex = codePoint.toString(16).padStart(4, "0");
      const escape = `\\u${hex}`;
      if (escape.length > budget.remaining) {
        budget.remaining = 0;
        budget.truncated = true;
        break;
      }
      flushPlain();
      segments.push({ text: escape, escaped: true });
      budget.remaining -= escape.length;
      continue;
    }
    if (budget.remaining === 0) {
      budget.truncated = true;
      break;
    }
    plain += character;
    budget.remaining -= 1;
  }
  flushPlain();
  return segments;
}

/**
 * One rendered diff line: the literal prefix the view paints (a sign, and the
 * newline separating remote hunks/lines) plus the raw wire text. Both are
 * spent from the same budget, so every renderer accounts for the characters it
 * actually puts on screen. Returns `null` when the line cannot be rendered at
 * all; a non-null result may still leave `budget.truncated` set, in which case
 * the caller renders nothing further.
 */
export function takeDiffDisplayLine(
  prefix: string,
  text: string,
  budget: DiffDisplayBudget,
): { prefix: DiffTextSegment | null; text: DiffTextSegment[] } | null {
  if (budget.truncated) return null;
  let literal: DiffTextSegment | null = null;
  if (prefix.length > 0) {
    if (prefix.length > budget.remaining) {
      budget.remaining = 0;
      budget.truncated = true;
      return null;
    }
    budget.remaining -= prefix.length;
    literal = { text: prefix, escaped: false };
  }
  return { prefix: literal, text: takeDiffDisplayText(text, budget) };
}
