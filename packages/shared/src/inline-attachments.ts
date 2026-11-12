/**
 * Inline prompt attachments: where a draft's attachment chips sit in the text.
 *
 * The Composer keeps images as chips inside the draft, so the outgoing prompt
 * names them at the position the user typed them. Electron main records that
 * text as `inlinePath` on the attachment it prepared, and every consumer — the
 * transcript renderer, the restored history, and the agent runtime that builds
 * the provider request — reads the placement back through the helpers below
 * instead of appending every image after the text.
 */
import { formatFileInsert } from "./composer-trigger.js";

/** The attachment field placement reads. Both durable and prompt shapes qualify. */
export type InlinePlacedAttachment = { readonly inlinePath?: string };

/** An inclusive-exclusive span of prompt text, in `content` offsets. */
export type InlinePathSpan = { start: number; end: number };

/** The `@path` text a prompt uses for one attachment path. */
export function formatPromptPathText(path: string): string {
  return formatFileInsert(path, "file").trim();
}

/**
 * Match one marker text per entry, in order, from the previous match. An entry
 * without a marker, or one the prompt does not name, yields null and leaves the
 * cursor untouched, so a later entry can still claim its own text.
 */
function locateMarkers(
  content: string,
  markers: ReadonlyArray<string | undefined>,
): Array<InlinePathSpan | null> {
  let cursor = 0;
  return markers.map((marker) => {
    const text = marker?.trim() ?? "";
    if (!text) return null;
    const start = content.indexOf(text, cursor);
    if (start === -1) return null;
    cursor = start + text.length;
    return { start, end: cursor };
  });
}

/**
 * Locate the path text of each entry, in order. A producer records a placement
 * with this call: it holds attachment paths, not prompt text.
 */
export function locateInlinePromptPaths(
  content: string,
  paths: ReadonlyArray<string | undefined>,
): Array<InlinePathSpan | null> {
  return locateMarkers(
    content,
    paths.map((path) => (path ? formatPromptPathText(path) : undefined)),
  );
}

/**
 * The text a recorded placement occupies, when it is one `@path` chip.
 *
 * `inlinePath` comes back from a message row on the next send, so Electron main
 * receives it from the renderer. It only ever decides where an already-verified
 * attachment is drawn and where its block sits in the prompt; anything that is
 * not a single chip token is not a placement and would otherwise be able to
 * claim arbitrary prompt text.
 */
export function inlinePlacementMarker(inlinePath: string | undefined): string | undefined {
  const text = typeof inlinePath === "string" ? inlinePath.trim() : "";
  if (!text.startsWith("@") || text.length < 2) return undefined;
  if (!/\s/.test(text)) return text;
  return text.startsWith('@"') && text.endsWith('"') && text.length > 3 ? text : undefined;
}

/** One attachment's placement inside the prompt, and the text that placed it. */
export type InlineAttachmentPlacement = InlinePathSpan & { marker: string };

/**
 * Locate one placement per entry, in order: the `@path` text the entry recorded
 * when the prompt still names it, otherwise the text the entry's own path
 * serializes to.
 *
 * A resent message names the path the user originally wrote in its text while
 * its attachment carries the content-addressed blob the host stored, so the
 * recorded placement — not the storage ref — is what the prompt can locate.
 */
export function locateInlineAttachmentPlacements(
  content: string,
  entries: ReadonlyArray<{ path: string; inlinePath?: string }>,
): Array<InlineAttachmentPlacement | null> {
  let cursor = 0;
  return entries.map((entry) => {
    const marker =
      inlinePlacementMarker(entry.inlinePath) ?? formatPromptPathText(entry.path);
    const start = marker ? content.indexOf(marker, cursor) : -1;
    if (!marker || start === -1) return null;
    cursor = start + marker.length;
    return { start, end: cursor, marker };
  });
}

/** One ordered piece of a prompt: a run of text, or an attachment inside it. */
export type InlineContentPart<A> =
  | { kind: "text"; text: string; start: number; end: number }
  | { kind: "attachment"; attachment: A; start: number; end: number };

/**
 * Split a prompt into ordered parts: the text runs with every attachment whose
 * recorded `inlinePath` sits inside them. Offsets stay relative to the whole
 * prompt, so a caller can render one message as several runs without losing
 * source positions.
 *
 * `trailing` reports the attachments the prompt does not name inline; they keep
 * the previous behavior of following the text.
 */
export function splitInlineContent<A extends InlinePlacedAttachment>(
  content: string,
  attachments: readonly A[],
): { parts: Array<InlineContentPart<A>>; trailing: A[] } {
  const parts: Array<InlineContentPart<A>> = [];
  const trailing: A[] = [];
  const located = locateMarkers(
    content,
    attachments.map((attachment) => attachment.inlinePath),
  );
  let cursor = 0;
  attachments.forEach((attachment, index) => {
    const span = located[index];
    if (!span) {
      trailing.push(attachment);
      return;
    }
    if (span.start > cursor) {
      parts.push({
        kind: "text",
        text: content.slice(cursor, span.start),
        start: cursor,
        end: span.start,
      });
    }
    parts.push({ kind: "attachment", attachment, start: span.start, end: span.end });
    cursor = span.end;
  });
  if (cursor < content.length) {
    parts.push({ kind: "text", text: content.slice(cursor), start: cursor, end: content.length });
  }
  return { parts, trailing };
}
