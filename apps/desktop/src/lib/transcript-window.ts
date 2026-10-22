/**
 * How much of a loaded transcript stays mounted (D261).
 *
 * ADR 0120 bounded what crosses the IPC boundary, not what the renderer keeps
 * in the DOM: paging older history in kept every row mounted forever, so a long
 * session accumulated React trees, Markdown ASTs, and Shiki token arrays for
 * rows nobody was looking at. `content-visibility` skips their layout and paint
 * but retains all of it, which is the wrong resource on a low-memory machine.
 *
 * So the mounted history is a trailing window over the loaded history. Reaching
 * the top grows the window first and only fetches an older page once the window
 * covers everything already loaded, which makes upward travel a two-stage
 * escalation: mount what is loaded, then load more.
 */

/**
 * Rows mounted in the first commit after a session switch.
 *
 * Deliberately far below the steady-state cap: the point is a fast first paint,
 * and the expansion to the full window lands in the next frame.
 */
export const TRANSCRIPT_INITIAL_MOUNT = 15;

/** Steady-state cap on mounted history rows. */
export const TRANSCRIPT_WINDOW_MIN = 60;

/** Rows added each time the user reaches the top of the mounted window. */
export const TRANSCRIPT_WINDOW_STEP = 40;

export type TranscriptWindowInput = {
  /** Loaded history rows, excluding the tail entry, which always mounts. */
  historyLength: number;
  /** Current steady-state budget, grown by `growTranscriptWindow`. */
  windowSize: number;
  /** Whether this is the bounded first commit after a session switch. */
  initialCommit: boolean;
};

export type TranscriptWindow = {
  /** Trailing history rows to mount. */
  mounted: number;
  /** Loaded history rows above the window, deliberately not mounted. */
  hiddenAbove: number;
  /** Whether any loaded row is being withheld. */
  bounded: boolean;
};

/** Resolve the mounted slice for one render. */
export function reduceTranscriptWindow({
  historyLength,
  windowSize,
  initialCommit,
}: TranscriptWindowInput): TranscriptWindow {
  const length = Math.max(0, historyLength);
  const budget = initialCommit
    ? TRANSCRIPT_INITIAL_MOUNT
    : Math.max(TRANSCRIPT_WINDOW_MIN, windowSize);
  const mounted = Math.min(length, budget);
  const hiddenAbove = length - mounted;
  return { mounted, hiddenAbove, bounded: hiddenAbove > 0 };
}

/**
 * Next window budget when the user reaches the top of the mounted rows.
 *
 * Clamped to the loaded history so the budget cannot drift above what exists
 * and silently swallow the growth steps a later page would need.
 */
export function growTranscriptWindow(
  windowSize: number,
  historyLength: number,
): number {
  const current = Math.max(TRANSCRIPT_WINDOW_MIN, windowSize);
  const length = Math.max(0, historyLength);
  if (current >= length) return current;
  return Math.min(length, current + TRANSCRIPT_WINDOW_STEP);
}

/** What one reach at the top of the mounted window asks for. */
export type TopReachPlan =
  | { readonly kind: "grow"; readonly windowSize: number }
  | { readonly kind: "page" };

/**
 * What a reach at the top asks for: mount more of what is already loaded, fetch
 * an older page, or nothing at all (`null`).
 *
 * `null` is not a degenerate step on the way to a page. A window that already
 * mounts every loaded row, on a pane that can dispatch no older page, has no
 * commit coming - so the caller must not arm a reading-position hold for one.
 * Such a hold never resolves (the read that would settle it never starts) and
 * keeps re-reading the reading line on every later scroll and every later
 * commit, for the rest of the session.
 */
export function planTopReach(input: {
  /** Current steady-state budget, as passed to `growTranscriptWindow`. */
  windowSize: number;
  /** Loaded history rows, excluding the tail entry. */
  historyLength: number;
  /** This pane can dispatch an older page right now. */
  canLoadOlder: boolean;
}): TopReachPlan | null {
  const grown = growTranscriptWindow(input.windowSize, input.historyLength);
  if (grown !== input.windowSize) return { kind: "grow", windowSize: grown };
  if (!input.canLoadOlder) return null;
  return { kind: "page" };
}
