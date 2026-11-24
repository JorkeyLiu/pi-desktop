/**
 * Selected-text quotes into the composer.
 *
 * A quote is plain draft text: the excerpt the user selected, formatted as a
 * Markdown blockquote and appended to the live draft of the conversation they
 * are looking at. Quoting never sends, never creates a session, and writes
 * nothing to the transcript, so per-session draft retention and the
 * smart-Stop restore path keep working unchanged.
 *
 * There is no attribution line: the context menu only knows the selected
 * text, not which message it came from, so the quote carries exactly what the
 * user picked and nothing invented.
 */

/** Longest excerpt a quote carries; longer text is cut and marked with an ellipsis. */
export const MAX_QUOTE_CHARS = 2000;

/**
 * The text a quote carries: the selection, normalized. A blank selection
 * carries nothing — callers gate the menu on a non-empty selection, so this
 * is the second half of that contract, not a fallback to surrounding text.
 */
export function quoteExcerpt(selection: string, limit = MAX_QUOTE_CHARS): string {
  const normalized = selection.replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  const cut = normalized.slice(0, limit);
  // Never cut between a surrogate pair: the tail would render as a lone glyph.
  const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${whole.trimEnd()}…`;
}

/**
 * A Markdown blockquote of the excerpt. Blank lines stay bare `>` so the
 * fence survives the paste back into the composer.
 */
export function buildQuoteText(excerpt: string): string {
  return quoteExcerpt(excerpt)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Put a quote into an existing draft without discarding what the user already
 * typed: quoting is an addition to the prompt, never a replacement of it.
 * The quote keeps a fresh unquoted paragraph after it so the composer caret —
 * which the quote prefill parks at the end of the applied draft — lands on an
 * empty line below the blockquote, ready for direct follow-up typing. A draft
 * that already ends in blank lines is trimmed first, so repeated quotes never
 * stack gaps.
 */
export function appendQuoteToDraft(draftText: string, quote: string): string {
  const existing = draftText.replace(/\s+$/, "");
  const quoted = existing ? `${existing}\n\n${quote}` : quote;
  return `${quoted}\n\n`;
}
