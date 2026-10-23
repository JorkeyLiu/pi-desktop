import remend from "remend";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { markdownRemarkPlugins } from "./markdown-blocks.ts";
/*
 * Presentation repairs the streaming message's last block for display only: it
 * closes the markers remend can see are still open, drops the destination of a
 * link that is still being written (and the image it would have produced), and
 * trims an unfinished tag. The authoritative source is never changed, so what
 * the renderer needs back is, for each presented byte, the source byte it came
 * from.
 *
 * Some source contexts must not be repaired at all. In each of them the marker
 * characters are content rather than syntax, so closing one would show
 * characters the message does not contain — a copy defect, not a layout one.
 * Code is the one context whose extent cannot be read off a line, so the block
 * grammar that renders the tail is the one asked where that code begins and
 * ends.
 */

type SourceRange = readonly [start: number, end: number];

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

function scanFences(source: string): { ranges: SourceRange[]; unclosed: boolean } {
  const ranges: SourceRange[] = [];
  let open: { marker: string; start: number } | null = null;
  for (let lineStart = 0; lineStart <= source.length;) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    const marker = FENCE_LINE.exec(source.slice(lineStart, lineEnd))?.[1];
    if (marker) {
      if (open === null) open = { marker: marker[0], start: lineStart };
      else if (marker[0] === open.marker) {
        ranges.push([open.start, newline === -1 ? source.length : newline + 1]);
        open = null;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (open !== null) ranges.push([open.start, source.length]);
  return { ranges, unclosed: open !== null };
}

/* Blanking a range keeps every index comparable with the unmasked source. */
function maskRanges(source: string, ranges: SourceRange[]): string {
  const characters = source.split("");
  for (const [start, end] of ranges) {
    for (let index = start; index < end && index < characters.length; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

/*
 * Inline code spans match by backtick run length, as GFM does. A run without a
 * partner is literal text in this renderer, so it stays unmasked; the parity
 * guard below owns that shape.
 */
function inlineCodeRanges(fenced: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (let index = 0; index < fenced.length;) {
    if (fenced[index] !== "`") {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (fenced[runEnd] === "`") runEnd += 1;
    const runLength = runEnd - index;
    let closing = -1;
    for (let cursor = runEnd; cursor < fenced.length;) {
      if (fenced[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let end = cursor + 1;
      while (fenced[end] === "`") end += 1;
      if (end - cursor === runLength) {
        closing = end;
        break;
      }
      cursor = end;
    }
    if (closing === -1) {
      index = runEnd;
      continue;
    }
    ranges.push([index, closing]);
    index = closing;
  }
  return ranges;
}

function hasUnclosedInlineCode(fenced: string): boolean {
  return (fenced.match(/(?<!\\)`/g)?.length ?? 0) % 2 !== 0;
}

/*
 * Display math opens when a `$$` run, or a `\[` without its `\]`, is still
 * waiting for its closer in prose. A delimiter that a finished inline-code span
 * or fence already hides from Markdown is not prose, and counting it used to
 * skip the repair for a sentence that merely quoted the delimiter.
 */
function hasUnclosedMath(literal: string): boolean {
  const displayDelimiters = literal.match(/\$\$/g)?.length ?? 0;
  const bracketDelimiters = literal.match(/\\\[|\\\]/g) ?? [];
  return displayDelimiters % 2 !== 0
    || bracketDelimiters.filter((delimiter) => delimiter === "\\[").length
      > bracketDelimiters.filter((delimiter) => delimiter === "\\]").length;
}

/*
 * The literal-code question is asked of the block grammar that renders the tail
 * rather than of the line shape. Indentation alone cannot answer it: four
 * columns inside a list item are a paragraph continuation there and code one
 * item deeper, and a code block nested in a quote or a list does not start its
 * line with indentation at all. A hand reading that disagreed with the parser
 * is exactly how a repair landed inside code, so the grammar is shared instead
 * of restated — `markdownRemarkPlugins` is the plugin list `markdown-blocks`
 * parses the same tail with.
 */
const tailParser = unified().use(remarkParse).use(markdownRemarkPlugins);

type MarkdownNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

/*
 * A code node is literal for the tail while the tail is still inside it: an
 * indented block has no fence to close it, and a fenced block whose closing
 * marker has not arrived is still open. A closed fence is finished text —
 * emphasis after it is prose again and keeps its repair.
 *
 * A fenced node's span starts at its opening marker and ends at its closer, so
 * its last line decides. Nesting keeps the container prefix on that line (`> `
 * before a quote's fence, or the item's indentation), which is stripped before
 * the run is compared with the opening one.
 */
function isLiteralCodeNode(node: MarkdownNode, source: string): boolean {
  if (node.type !== "code") return false;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  // `remark-parse` positions every node it produces. An unpositioned code node
  // cannot be inspected, so it is treated as open rather than repaired blind.
  if (start === undefined || end === undefined) return true;
  const lines = source.slice(start, end).split("\n");
  const opening = FENCE_LINE.exec(lines[0])?.[1];
  if (opening === undefined) return true;
  const closing = lines[lines.length - 1].replace(/^[ \t>]*/, "");
  return !(closing.length >= opening.length && closing === opening[0].repeat(closing.length));
}

/*
 * The parse is bounded by construction — only the last block reaches this
 * module, and a block in the active tail is at most the streaming limit — and it
 * runs only for a tail that could hold such a node: an indented block needs four
 * columns somewhere, a fenced one its marker, a raw body its tag. A tail that
 * already answered an earlier guard never gets here at all.
 */
const CODE_CONTEXT_HINT = / {4}|\t|```|~~~|<pre/i;

function opensLiteralCodeContext(source: string): boolean {
  if (!CODE_CONTEXT_HINT.test(source)) return false;
  const pending: MarkdownNode[] = [tailParser.parse(source)];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (isLiteralCodeNode(node, source)) return true;
    if (node.children) pending.push(...node.children);
  }
  return false;
}

/* Text inside `<pre>` is literal, including the text after an unclosed one. */
function opensRawPreContext(literal: string): boolean {
  const lowered = literal.toLowerCase();
  let opening = -1;
  for (let from = 0;;) {
    const candidate = lowered.indexOf("<pre", from);
    if (candidate === -1) break;
    const boundary = lowered[candidate + 4];
    if (boundary === undefined || boundary === ">" || /\s/.test(boundary)) {
      opening = candidate;
    }
    from = candidate + 4;
  }
  return opening !== -1 && lowered.indexOf("</pre", opening) === -1;
}

function identityOffsets(source: string): number[] {
  return Array.from({ length: source.length + 1 }, (_, index) => index);
}

/* Remend appends closers only, so that is the whole shape it can add. */
const APPENDED_MARKERS = /^[*_~]*$/;

/*
 * Recover each presented byte's source index from the repair that actually
 * happened, rather than from a second reading of the Markdown grammar. Remend
 * keeps what it keeps verbatim: past the first differing byte the presented
 * text is one contiguous source run, optionally after a dropped `[` (a
 * text-only incomplete link keeps its label and drops the bracket) and always
 * before the marker characters it appended. A completed image, a finished code
 * span, and any other untouched byte therefore keep their own offset, and only
 * the appended closers clamp to the end of the run they close.
 *
 * A shape that is not that — nothing in the pinned version produces one — stops
 * at the last honest byte instead of guessing.
 */
function mapPresentationOffsets(source: string, markdown: string): number[] {
  let prefix = 0;
  while (
    prefix < source.length
    && prefix < markdown.length
    && source[prefix] === markdown[prefix]
  ) prefix += 1;
  const droppedBracket = prefix < source.length && source[prefix] === "[" ? 1 : 0;
  const retainedStart = prefix + droppedBracket;
  let retained = 0;
  while (
    retainedStart + retained < source.length
    && prefix + retained < markdown.length
    && source[retainedStart + retained] === markdown[prefix + retained]
  ) retained += 1;
  const isRepair = APPENDED_MARKERS.test(markdown.slice(prefix + retained));
  const boundary = retained > 0 ? retainedStart + retained : prefix;
  const offsets = new Array<number>(markdown.length + 1);
  for (let index = 0; index <= markdown.length; index += 1) {
    if (!isRepair || index < prefix) offsets[index] = index;
    else if (retained > 0 && index <= prefix + retained) {
      offsets[index] = retainedStart + (index - prefix);
    } else offsets[index] = boundary;
  }
  return offsets;
}

export type StreamingMarkdownPresentation = {
  markdown: string;
  sourceOffsets: number[];
};

/** Repair the active tail for display without changing its authoritative source. */
export function presentStreamingMarkdown(source: string): StreamingMarkdownPresentation {
  const fences = scanFences(source);
  const fenced = fences.ranges.length > 0 ? maskRanges(source, fences.ranges) : source;
  const inlineCode = fenced.includes("`") ? inlineCodeRanges(fenced) : [];
  const literal = inlineCode.length > 0 ? maskRanges(fenced, inlineCode) : fenced;
  if (
    fences.unclosed
    || hasUnclosedInlineCode(fenced)
    || hasUnclosedMath(literal)
    || opensRawPreContext(literal)
    || source.includes("\\`")
    || source.includes("**/*")
    // Last because it parses: every cheaper guard above already settled the
    // answer, and this one only runs on a tail that could hold a code block.
    || opensLiteralCodeContext(source)
  ) {
    return { markdown: source, sourceOffsets: identityOffsets(source) };
  }
  const markdown = remend(source, {
    linkMode: "text-only",
    images: true,
    inlineCode: false,
    katex: false,
    inlineKatex: false,
    singleTilde: false,
    comparisonOperators: false,
    setextHeadings: false,
  });
  return { markdown, sourceOffsets: mapPresentationOffsets(source, markdown) };
}

/*
 * `normalizeLatexMathDelimiters` turns a complete `\[ … \]` pair into `$$ … $$`
 * and leaves an unclosed one untouched, while an unclosed `$$` stays `$$`. A
 * block that opens display math without a closer is still being streamed, so
 * the renderer must show the bytes rather than let KaTeX interpret half a
 * formula.
 */
export function opensUnclosedDisplayMath(source: string): boolean {
  const trimmed = source.trimStart();
  const opener = trimmed.startsWith("$$") ? "$$"
    : trimmed.startsWith("\\[") ? "\\]"
      : trimmed.startsWith("\\(") ? "\\)"
        : null;
  return opener !== null && !trimmed.slice(2).includes(opener);
}
