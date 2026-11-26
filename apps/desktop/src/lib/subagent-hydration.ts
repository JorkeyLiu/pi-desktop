/**
 * How a delegate transcript's *loaded* rows reach the DOM.
 *
 * A scoped page is one contiguous interval of a chain's child rows, and a
 * 500-row page is the fetch cadence, so mounting every row of a page in one
 * React commit puts that page's Markdown parses, tool rows, disclosures, and
 * Markdown syntax trees into one task - the visible stall a reader sees as the
 * panel freezing after an older read.
 *
 * The rows still all mount: this is not a virtualizer. There is no row budget,
 * no height estimate, no spacer, and no offscreen unmount, so selection, find,
 * search, and the disclosures of every loaded row keep working exactly as they
 * did when the list mounted synchronously. What changes is the commit shape:
 * the first commit mounts a bounded run near the tail, and each following frame
 * mounts one more batch of the rows that are already loaded, above the run it
 * has already mounted. A reader paging upward therefore keeps every row they
 * were looking at, and the loaded rows above them arrive in batches instead of
 * one block.
 *
 * The mounted set is always one contiguous run of the loaded rows, `[start,
 * end)`. Two offsets are what the commit shapes need, because this pane pages in
 * both directions:
 *
 * - a replaced interval (a latest or focus read, a chain change) restarts at the
 *   bounded tail, because none of the rows the reader had are still loaded;
 * - an older page prepended keeps the rows that are still there mounted, hides
 *   only the rows that landed above them, and reveals those above in batches;
 * - a later page appended below a window read earlier is the same problem
 *   mirrored: the run the reader is reading stays exactly where it is, and the
 *   appended rows below it arrive batch by batch instead of as one page.
 *
 * Nothing grows the run by more than one batch in one commit, and no gesture is
 * exempt: a reach at the top, a search hit, and the first commit of a page all
 * travel through the same bounded batches, so reading upward can never turn a
 * page into one heavy commit. The batches also stop while the pane has no
 * visible box - its own layout, or the window it sits in - and resume when that
 * changes: a pane nobody can see must not keep parsing Markdown nobody reads.
 */
import type { SubagentTranscriptTurn } from "./subagent-transcript";

/**
 * Rows mounted in the first commit of a newly loaded interval.
 *
 * Far below a page deliberately: the first commit is the one a reader waits
 * for, and the rest of the loaded rows follow on the next frames.
 */
export const SUBAGENT_HYDRATION_FIRST_ROWS = 32;

/**
 * Rows mounted per following commit.
 *
 * One batch is one frame's worth of a heavy page, not a row budget: it exists
 * to keep a 500-row page out of a single task, and it never limits what stays
 * mounted - every loaded row is mounted once the batches finish.
 */
export const SUBAGENT_HYDRATION_STEP_ROWS = 128;

export type SubagentHydrationPolicy = {
  /** Rows mounted in the first commit of a replaced interval. */
  readonly firstRows: number;
  /** Rows mounted by each following commit. */
  readonly stepRows: number;
};

export const SUBAGENT_HYDRATION_POLICY: SubagentHydrationPolicy = {
  firstRows: SUBAGENT_HYDRATION_FIRST_ROWS,
  stepRows: SUBAGENT_HYDRATION_STEP_ROWS,
};

/** The loaded rows, and the contiguous run of them that is mounted now. */
export type SubagentHydration = {
  readonly rowCount: number;
  /** First mounted row, as an index into the loaded list. */
  readonly start: number;
  /** One past the last mounted row, as an index into the loaded list. */
  readonly end: number;
};

export const EMPTY_SUBAGENT_HYDRATION: SubagentHydration = { rowCount: 0, start: 0, end: 0 };

/** The state a newly loaded interval starts in: a bounded run near the tail. */
export function initialSubagentHydration(
  rowCount: number,
  policy: SubagentHydrationPolicy = SUBAGENT_HYDRATION_POLICY,
): SubagentHydration {
  const count = Math.max(0, rowCount);
  const mounted = Math.min(count, Math.max(0, policy.firstRows));
  return { rowCount: count, start: count - mounted, end: count };
}

/**
 * How the loaded row list changed since the previous commit.
 *
 * A list that still contains the previously loaded rows as one contiguous run
 * keeps the rows it mounted; `hiddenAbove` is how many new rows landed above
 * that run and `retained` is how many of the previous rows are still there.
 * `retained` can be shorter than the previous list: a live row belongs to the
 * loaded interval until the durable page that names the same rows replaces it,
 * and the reader must keep their place across that swap. A list that keeps no
 * previous row at all is a different interval, not growth of this one.
 */
export type SubagentRowChange =
  | { readonly kind: "replace"; readonly rowCount: number }
  | {
      readonly kind: "growth";
      readonly rowCount: number;
      readonly hiddenAbove: number;
      readonly retained: number;
    };

/**
 * Classify a rebuilt row list against the previous one, by row identity.
 *
 * Only the boundary keys are compared: rows carry stable identities, so a
 * prepended page, an appended live row, a dropped live tail, and a replaced
 * window are all decided by where the previously loaded run now starts and
 * where its last surviving row sits.
 */
export function classifySubagentRowChange(
  previous: readonly string[],
  next: readonly string[],
): SubagentRowChange {
  if (!previous.length || !next.length) return { kind: "replace", rowCount: next.length };
  const offset = next.indexOf(previous[0]);
  if (offset < 0) return { kind: "replace", rowCount: next.length };
  const retained = Math.min(previous.length, next.length - offset);
  if (!retained) return { kind: "replace", rowCount: next.length };
  if (next[offset + retained - 1] !== previous[retained - 1]) {
    return { kind: "replace", rowCount: next.length };
  }
  return { kind: "growth", rowCount: next.length, hiddenAbove: offset, retained };
}

export type SubagentHydrationEvent =
  | { readonly kind: "rows"; readonly change: SubagentRowChange }
  | { readonly kind: "step" };

/**
 * One commit of the mounted run.
 *
 * `rows` maps the rows that are still loaded onto the run that is still
 * mounted; `step` grows that run by one batch, upward while the window's head is
 * still hidden and downward once it has been drawn, so nothing that was mounted
 * stops being mounted and no commit mounts more than one batch of new rows.
 */
export function reduceSubagentHydration(
  state: SubagentHydration,
  event: SubagentHydrationEvent,
  policy: SubagentHydrationPolicy = SUBAGENT_HYDRATION_POLICY,
): SubagentHydration {
  const step = Math.max(1, policy.stepRows);
  if (event.kind === "step") {
    // Rows above the run are revealed first: a window whose head is still hidden
    // has to reach it before mounting anything below is worth a frame. Only once
    // the head is drawn does the next batch travel down to rows that were
    // appended below the run.
    if (state.start > 0) return { ...state, start: Math.max(0, state.start - step) };
    if (state.end < state.rowCount) {
      return { ...state, end: Math.min(state.rowCount, state.end + step) };
    }
    return state;
  }
  const change = event.change;
  if (change.kind === "replace") return initialSubagentHydration(change.rowCount, policy);
  // The run that is still loaded sits `hiddenAbove` rows into the new list, and
  // the rows appended below it mount as one bounded batch: a live row, or the
  // first rows of a later page, never wait for a frame, and a page appended
  // below the window never lands as one heavy commit. If the interval no longer
  // names rows the run had - a live tail row the durable page dropped - the run
  // shrinks to what both lists still share instead of resetting to the bounded
  // tail, so the reader keeps the rows they were reading.
  const start = change.hiddenAbove + Math.min(state.start, change.retained);
  const end =
    change.hiddenAbove +
    Math.min(state.end, change.retained) +
    Math.min(change.rowCount - change.hiddenAbove - change.retained, step);
  // A pane that has mounted nothing yet is still at its bounded first run.
  if (end <= start) return initialSubagentHydration(change.rowCount, policy);
  const next = { rowCount: change.rowCount, start, end };
  if (
    next.rowCount === state.rowCount &&
    next.start === state.start &&
    next.end === state.end
  ) {
    return state;
  }
  return next;
}

/** Loaded rows that still have to be mounted by the batches still to come. */
export function subagentHydrationPending(state: SubagentHydration): boolean {
  return subagentVisibleCount(state) < state.rowCount;
}

/** Rows the projection mounts, clamped to what is loaded. */
export function subagentVisibleCount(state: SubagentHydration): number {
  const start = Math.min(state.rowCount, Math.max(0, state.start));
  const end = Math.min(state.rowCount, Math.max(0, state.end));
  return Math.max(0, end - start);
}

/**
 * The rows to mount for one render.
 *
 * The array keeps its identity when nothing is hidden, so a hydrated pane
 * hands its render units the same list it handed them last commit.
 */
export function subagentVisibleRows<T>(
  rows: readonly T[],
  state: SubagentHydration,
): readonly T[] {
  const count = subagentVisibleCount(state);
  if (count >= rows.length) return rows;
  const start = Math.max(0, Math.min(state.start, rows.length));
  return rows.slice(start, start + count);
}

/** Whether a row at `index` is inside the mounted run. */
export function subagentRowMounted(state: SubagentHydration, index: number): boolean {
  if (index < 0 || index >= state.rowCount) return false;
  return index >= state.start && index < Math.min(state.rowCount, state.end);
}

/**
 * Whether a pane's batches should be running now.
 *
 * Two facts decide it, both read from the pane's own owner rather than from any
 * app-wide flag: the box the rows are drawn in must have layout, and the window
 * the box sits in must not be hidden. A pane that is neither - collapsed during
 * a panel transition, or a window the user minimized - keeps the rows it has
 * already mounted and schedules nothing more, so background parsing never
 * competes with whatever the user is actually looking at.
 */
export function subagentPaneVisible(input: {
  /** `document.visibilityState !== "hidden"`. */
  readonly windowVisible: boolean;
  /** The pane's own layout box, in CSS pixels. */
  readonly width: number;
  readonly height: number;
}): boolean {
  return input.windowVisible && input.width > 0 && input.height > 0;
}

/** A frame scheduler, injected so the pump's commits are testable. */
export type SubagentHydrationClock = {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
};

/** Nothing is scheduled without a frame source: SSR renders one commit. */
export const NO_SUBAGENT_HYDRATION_CLOCK: SubagentHydrationClock = {
  request: () => 0,
  cancel: () => undefined,
};

const frameClock = (): SubagentHydrationClock =>
  typeof requestAnimationFrame === "function"
    ? {
        request: (callback) => requestAnimationFrame(callback),
        cancel: (handle) => cancelAnimationFrame(handle),
      }
    : NO_SUBAGENT_HYDRATION_CLOCK;

export type SubagentHydrationPump = {
  /** The current commit state, as the pane must render it. */
  snapshot: () => SubagentHydration;
  /** Reconcile the pump with the row list that is loaded now. */
  observe: (keys: readonly string[]) => void;
  /** Gate the batches on the pane's own visibility; an invisible pane spends no frame. */
  setActive: (active: boolean) => void;
  /** Stop scheduling without discarding what is mounted (a superseded read). */
  stop: () => void;
  /** Stop scheduling for good (the pane left). */
  dispose: () => void;
};

/**
 * The frame pump behind the mounted run.
 *
 * It owns exactly four things: the commit state, one queued frame, whether the
 * pane is visible enough to spend a frame, and the "capture the reading position
 * now" callback that runs immediately before a batch commit adds rows above the
 * reader. Everything it decides is derived from the row identities it is handed,
 * so a replaced interval cancels the batch that belonged to the old one instead
 * of mounting rows into a window that is no longer there.
 */
export function createSubagentHydrationPump(input: {
  publish: (state: SubagentHydration) => void;
  clock?: SubagentHydrationClock;
  policy?: SubagentHydrationPolicy;
  /** Runs synchronously before each batch commit that will add rows above. */
  beforeBatch?: () => void;
}): SubagentHydrationPump {
  const clock = input.clock ?? frameClock();
  const policy = input.policy ?? SUBAGENT_HYDRATION_POLICY;
  let state = EMPTY_SUBAGENT_HYDRATION;
  let previous: readonly string[] | null = null;
  let frame = 0;
  let disposed = false;
  let active = true;

  const publish = (next: SubagentHydration) => {
    if (
      next.rowCount === state.rowCount &&
      next.start === state.start &&
      next.end === state.end
    ) {
      return;
    }
    state = next;
    input.publish(next);
  };
  const cancelFrame = () => {
    if (!frame) return;
    clock.cancel(frame);
    frame = 0;
  };
  const arm = () => {
    if (frame || disposed || !active || !subagentHydrationPending(state)) return;
    frame = clock.request(() => {
      frame = 0;
      if (disposed || !active || !subagentHydrationPending(state)) return;
      input.beforeBatch?.();
      publish(reduceSubagentHydration(state, { kind: "step" }, policy));
      arm();
    });
  };

  return {
    snapshot: () => state,
    observe: (keys) => {
      const change = classifySubagentRowChange(previous ?? [], keys);
      previous = keys;
      // The queued batch was computed against the previous list: a replaced
      // interval must not mount rows of the window it replaced.
      cancelFrame();
      publish(reduceSubagentHydration(state, { kind: "rows", change }, policy));
      arm();
    },
    setActive: (next) => {
      if (active === next) return;
      active = next;
      // An invisible pane stops spending frames; the rows it already mounted
      // stay mounted, and the batches resume from the same commit state.
      if (active) arm();
      else cancelFrame();
    },
    stop: cancelFrame,
    dispose: () => {
      disposed = true;
      cancelFrame();
    },
  };
}

/** A prompt row of a turn: the `Task` call's own user row. */
export type SubagentPromptUnit = {
  readonly kind: "prompt";
  readonly key: string;
  readonly messageId: string;
  readonly task: string;
  readonly attachments?: SubagentTranscriptTurn["attachments"];
};

/** A row the delegate produced under a turn. */
export type SubagentRowUnit = {
  readonly kind: "tool" | "thinking" | "steering-user" | "answer";
  readonly key: string;
  readonly messageId: string;
  readonly message: SubagentTranscriptTurn["rows"][number]["message"];
};

export type SubagentTranscriptUnit = SubagentPromptUnit | SubagentRowUnit;

/**
 * Flatten the turns into the one ordered list the pane mounts.
 *
 * A turn contributes its prompt row first - when the retained interval reaches
 * that run's opening - and then its own rows in physical order, so the flat
 * list is the transcript, and a batch boundary is just a row offset inside
 * it.
 */
export function buildSubagentTranscriptUnits(
  turns: readonly SubagentTranscriptTurn[] | undefined,
): readonly SubagentTranscriptUnit[] {
  if (!turns?.length) return [];
  const units: SubagentTranscriptUnit[] = [];
  for (const turn of turns) {
    if (turn.showPrompt) {
      units.push({
        kind: "prompt",
        key: `prompt-${turn.messageId}`,
        messageId: turn.messageId,
        task: turn.task,
        ...(turn.attachments ? { attachments: turn.attachments } : {}),
      });
    }
    for (const row of turn.rows) {
      units.push({
        kind: row.kind,
        key: `${row.kind}-${row.message.id}`,
        messageId: row.message.id,
        message: row.message,
      });
    }
  }
  return units;
}

/**
 * Reuse the units that describe the same row as they did last commit.
 *
 * The transcript is rebuilt whenever any message changes, so every unit object
 * is new even though a hydration batch grows only the mounted run. Reusing the
 * units of unchanged rows lets the memoized row components bail out, which is
 * what keeps a batch commit proportional to the batch instead of to the page.
 */
export function stabilizeSubagentTranscriptUnits(
  previous: readonly SubagentTranscriptUnit[] | null,
  next: readonly SubagentTranscriptUnit[],
): readonly SubagentTranscriptUnit[] {
  if (!previous?.length) return next;
  const reusable = new Map<string, SubagentTranscriptUnit>();
  for (const unit of previous) reusable.set(unit.key, unit);
  let changed = false;
  const stable = next.map((unit) => {
    const before = reusable.get(unit.key);
    if (!before || before.kind !== unit.kind) return unit;
    if (before.kind === "prompt" && unit.kind === "prompt") {
      if (before.task !== unit.task || before.attachments !== unit.attachments) return unit;
      changed = true;
      return before;
    }
    if (before.kind !== "prompt" && unit.kind !== "prompt" && before.message === unit.message) {
      changed = true;
      return before;
    }
    return unit;
  });
  return changed ? stable : next;
}
