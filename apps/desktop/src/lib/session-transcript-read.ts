import type { SessionDetail } from "@pi-desktop/shared";
import { isTranscriptRow } from "./assistant-turns";
import { dedupeSessionMessages } from "./session-transcript";

/**
 * Whether a durable window read is suspiciously empty (issue #795).
 *
 * The host answers `session.get` from a transcript file it may be rewriting at
 * that moment, so it can return "the session exists and has no messages" for a
 * session that has thousands. Taking that answer at face value cached an empty
 * transcript that the sidebar's hover prefetch re-served on every later open,
 * and the session stayed blank until the app restarted. A read is only
 * trustworthy as "empty" when the session's own count agrees with it.
 */
export function sessionReadLooksEmpty(
  session: Pick<SessionDetail, "messages" | "messageCount"> | null | undefined,
): boolean {
  if (!session) return false;
  return (session.messages ?? []).length === 0 && (session.messageCount ?? 0) > 0;
}

/**
 * Whether this durable window contains a row the turn stream would draw.
 *
 * The window can be entirely delegate rows: they hang under a `Task` card that
 * lies just before the window, so a pane opened on such a page has nothing to
 * render and nothing to page from.
 */
export function sessionWindowHasRenderableRow(
  session: Pick<SessionDetail, "messages"> | null | undefined,
): boolean {
  return (session?.messages ?? []).some(isTranscriptRow);
}

/**
 * Merge one older bounded page into the current window, or return null when it
 * cannot move the backward edge.
 *
 * The tail read stays authoritative for the forward edge: `messageEnd`,
 * `hasMoreAfter` and the session summary fields are carried through untouched
 * while `messageStart` and `hasMoreBefore` describe the widened window. A page
 * whose cursor does not decrease offers no progress, so callers end the walk
 * instead of re-requesting the same offset forever.
 */
export function mergeOlderTranscriptWindow(
  current: SessionDetail,
  older: SessionDetail | null | undefined,
): SessionDetail | null {
  if (!older) return null;
  const start = older.messageStart;
  if (typeof start !== "number" || start >= (current.messageStart ?? 0)) {
    return null;
  }
  return {
    ...current,
    messages: dedupeSessionMessages([
      ...(older.messages ?? []),
      ...(current.messages ?? []),
    ]),
    messageStart: start,
    hasMoreBefore: older.hasMoreBefore === true,
  };
}
