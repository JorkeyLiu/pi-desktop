/**
 * The one-line reading a collapsed reasoning row shows beside its label.
 *
 * Reasoning arrives as Markdown, but a collapsed row is a label plus a single
 * line, so the line is the opening the model itself wrote: a leading heading or
 * a line that is nothing but one bold span when the text has one, otherwise the
 * opening paragraph. The row never synthesizes a title or a summary, and it
 * never tracks the newest line — the preview is the opening, so it cannot
 * flicker or cycle while the rest of the reasoning streams in.
 *
 * Markdown presentation is dropped rather than shown, while the words inside it
 * stay: emphasis, inline code, links (their label, never the destination),
 * images (their alt text), quotes, list bullets and table pipes all read as
 * plain prose. Escaped markers stay literal.
 */

/** One rendered line, derived from the message's own opening on every render. */
export type ThinkingPreview = {
  /** A leading heading or standalone bold line, already unformatted. */
  heading: string | null;
  /** The opening paragraph, unformatted and folded onto one line. */
  body: string;
};

/**
 * Only the opening is read, so a long reasoning stream costs no more than its
 * first screenfuls. Far beyond any visible row width, and purely a bound: the
 * stylesheet is what ellipsizes the line.
 */
const MAX_PREVIEW_SOURCE = 2000;

/** ATX heading; the captured group is everything the reader would see. */
const ATX_HEADING = /^\s{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
/** A whole line enclosed by one bold span reads as that opening's own title. */
const BOLD_LINE = /^\s{0,3}(\*\*|__)(.+?)\1[ \t]*[:：]?[ \t]*$/;
const FENCE_LINE = /^\s{0,3}(?:```|~~~)/;
const RULE_LINE = /^\s{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_PREFIX = /^\s{0,3}>[ \t]?/;
const LIST_PREFIX = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const TASK_PREFIX = /^\[[ xX]\][ \t]+/;
const ATX_PREFIX = /^\s{0,3}#{1,6}(?:[ \t]+|$)/;
const TABLE_ROW = /^\s{0,3}\|/;

/** Blank lines, fences and rules are layout: they carry no opening words. */
function isFurniture(line: string): boolean {
  return !line.trim() || FENCE_LINE.test(line) || RULE_LINE.test(line);
}

/** A line that ends the opening paragraph without belonging to it. */
function isBlockEnd(line: string): boolean {
  return isFurniture(line) || ATX_HEADING.test(line);
}

/**
 * Inline Markdown stripped to the text it wraps. Escaped punctuation is held
 * aside first so `\*` stays a literal asterisk instead of being read as an
 * unmatched emphasis marker.
 */
function unformatInline(text: string): string {
  const literals: string[] = [];
  const value = text
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_, literal: string) => {
      literals.push(literal);
      return `\u0000${literals.length - 1}\u0000`;
    })
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<([a-z][a-z0-9+.-]*:[^>\s]+)>/gi, "$1")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/`+/g, "")
    .replace(/(?<!\\)\*+/g, "")
    .replace(/(?<!\\)~+/g, "")
    // Underscores are markers only at word edges, so `tool_row_summary` survives.
    .replace(/(^|[\s([{"'“‘.,:;!?—–-])_+(?=\S)/g, "$1")
    .replace(/(?<=\S)_+(?=$|[\s)\]}"'”’.,:;!?—–-])/g, "")
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => literals[Number(index)] ?? "");
  return value.replace(/\s+/g, " ").trim();
}

/** One line's visible words: block furniture first, then inline presentation. */
function lineWords(line: string): string {
  let value = line;
  while (QUOTE_PREFIX.test(value)) value = value.replace(QUOTE_PREFIX, "");
  value = value.replace(LIST_PREFIX, "").replace(TASK_PREFIX, "").replace(ATX_PREFIX, "");
  if (TABLE_ROW.test(value)) {
    value = value
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .replace(/\s*\|\s*/g, " ");
  }
  return unformatInline(value);
}

/**
 * The opening of `text` as a single line, or `null` when it holds no visible
 * words at all. Pure and uncached: the row recomputes it from the message it is
 * given, so corrected or extended content is never served stale.
 */
export function thinkingPreview(text: string): ThinkingPreview | null {
  const lines = text.slice(0, MAX_PREVIEW_SOURCE).split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isFurniture(line)) {
      index += 1;
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      const title = unformatInline(heading[1]);
      if (title) return { heading: title, body: "" };
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && !isBlockEnd(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    const bold = paragraph[0] === undefined ? null : BOLD_LINE.exec(paragraph[0]);
    const title = bold ? unformatInline(bold[2]) : "";
    if (title) return { heading: title, body: "" };
    const body = paragraph.map(lineWords).filter(Boolean).join(" ");
    if (body) return { heading: null, body };
  }
  return null;
}
