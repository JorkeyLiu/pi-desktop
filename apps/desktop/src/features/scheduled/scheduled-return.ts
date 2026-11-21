/**
 * Where a scheduled run's conversation was opened from.
 *
 * Hiding automation transcripts from the SessionList (issue #1291) made the
 * Scheduled window their only entry point, so the chat surface has to offer the
 * way back — and returning should land on the same task and the same run the
 * reader left. The origin is remembered for the session it belongs to, so a
 * later visit to an unrelated conversation never offers it.
 */
export type ScheduledReturnOrigin = {
  taskId: string;
  taskTitle: string;
  /** The run whose transcript the reader opened, when a row started it. */
  runId: string | null;
  sessionId: string;
};

let origin: ScheduledReturnOrigin | null = null;

/** Remember the run row a conversation was opened from. */
export function rememberScheduledReturn(next: ScheduledReturnOrigin): void {
  origin = next;
}

/** The remembered origin, without consuming it: the Scheduled window restores
 * its selection from this on every mount, and revisiting must keep working. */
export function peekScheduledReturn(): ScheduledReturnOrigin | null {
  return origin;
}

/** The origin only when it belongs to the conversation being shown. */
export function scheduledReturnFor(
  sessionId: string | null | undefined,
): ScheduledReturnOrigin | null {
  if (!sessionId || origin?.sessionId !== sessionId) return null;
  return origin;
}
