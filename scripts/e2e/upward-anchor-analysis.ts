import type { Sample, Sampler } from "./upward-anchor-sampling";

/*
  Turning captured frames into a claim.

    screenShift   = how far the reading row moved on screen
    unwantedShift = screenShift + inputDelta
                    (how far it moved that the reader's own wheel did not ask
                    for; zero is the whole claim under test)
    contentShift  = screenShift + scrollTopDelta
                    (how far the content above the reading row changed height)

  A wheel step is the reader's own movement and is subtracted; a commit - a
  mounted-window growth or an older page adding rows above the viewport - must
  leave no shift behind, whether the reader is idle or still scrolling.
*/
export type StepReading = {
  index: number;
  anchorId: string;
  scrollTopDelta: number;
  /** How far the reading row moved on screen. */
  screenShift: number;
  /**
   * How far the content above the reading row changed height: the screen
   * movement plus every scroll that happened, the reader's own included.
   */
  contentShift: number;
  /**
   * The movement no input explains: screen shift minus the scroll the reader
   * asked for. Zero means the row stayed where the reader left it.
   */
  unwantedShift: number;
  scrollHeightDelta: number;
  rowDelta: number;
  input: boolean;
};

const anchorOf = (sample: Sample) => {
  const margin = Math.min(120, sample.clientHeight / 4);
  return sample.rows.find((candidate) => candidate.bottom > margin) ?? sample.rows[0];
};

export const readStep = (before: Sample, after: Sample, index: number): StepReading | undefined => {
  const anchor = anchorOf(before);
  if (!anchor) return undefined;
  const margin = Math.min(120, before.clientHeight / 4);
  // A row that disappeared was remounted; the next surviving row above the
  // reading line carries the reading position for this step.
  const survivor = after.rows.find((candidate) => candidate.id === anchor.id) ??
    after.rows.find((candidate) => before.rows.some((row) =>
      row.id === candidate.id && row.bottom > margin));
  if (!survivor) return undefined;
  const earlier = before.rows.find((candidate) => candidate.id === survivor.id);
  if (!earlier) return undefined;
  const scrollTopDelta = after.scrollTop - before.scrollTop;
  const screenShift = survivor.top - earlier.top;
  return {
    index, anchorId: survivor.id, scrollTopDelta, screenShift,
    contentShift: Math.round((screenShift + scrollTopDelta) * 100) / 100,
    unwantedShift: Math.round((screenShift + after.inputDelta) * 100) / 100,
    scrollHeightDelta: Math.round((after.scrollHeight - before.scrollHeight) * 100) / 100,
    rowDelta: after.rows.length - before.rows.length,
    input: after.input,
  };
};

/**
 * Steps where the mounted window or a page added rows. A commit may land on a
 * frame the reader is also wheeling on; `unwantedShift` has already removed
 * that wheel, so both are held to the same bound.
 */
export const steps = (samples: Sample[], from: number) => {
  const readings: StepReading[] = [];
  for (let index = Math.max(1, from); index < samples.length; index++) {
    const reading = readStep(samples[index - 1], samples[index], index);
    if (reading) readings.push(reading);
  }
  return readings;
};

export const isCommit = (step: StepReading) => Math.abs(step.scrollHeightDelta) >= 0.5 || step.rowDelta !== 0;
const maxAbs = (values: number[]) => Math.round(values.reduce((max, value) => Math.max(max, Math.abs(value)), 0) * 100) / 100;

export function phaseReport(sampler: Sampler, name: string, from: number): Record<string, unknown> {
  const samples = sampler.samples;
  const forcedLayouts = sampler.forcedLayouts;
  const longTasks = sampler.longTasks;
  const readings = steps(samples, from);
  const commits = readings.filter(isCommit);
  const inputMoves = readings.filter((step) => step.input && !isCommit(step));
  const idleMoves = readings.filter((step) => !step.input && !isCommit(step));
  const idleHeightChanges = idleMoves.filter((step) => Math.abs(step.scrollHeightDelta) >= 0.5);
  const layout = forcedLayouts.slice().sort((left, right) => left - right);
  return {
    phase: name,
    frames: samples.length - from,
    mountedRows: samples.at(-1)?.rows.length ?? 0,
    commits: commits.length,
    commitDetails: commits.map((step) => ({
      anchor: step.anchorId, input: step.input, screenShift: step.screenShift,
      inputDelta: Math.round((step.unwantedShift - step.screenShift) * 100) / 100,
      unwantedShift: step.unwantedShift,
      scrollTopDelta: Math.round(step.scrollTopDelta * 100) / 100,
      scrollHeightDelta: step.scrollHeightDelta, rowDelta: step.rowDelta,
    })),
    // The claim under test: no commit moves the reading row by more than a
    // pixel beyond what the reader's own wheel asked for, and an idle reader
    // does not move at all.
    maxCommitShiftPx: maxAbs(commits.map((step) => step.unwantedShift)),
    maxIdleDriftPx: maxAbs(idleMoves.map((step) => step.screenShift)),
    maxInputShiftPx: maxAbs(inputMoves.map((step) => step.unwantedShift)),
    maxInputContentShiftPx: maxAbs(inputMoves.map((step) => step.contentShift)),
    idleHeightChangeFrames: idleHeightChanges.length,
    idleHeightChangeRangePx: idleHeightChanges.length
      ? [Math.min(...idleHeightChanges.map((step) => step.scrollHeightDelta)),
         Math.max(...idleHeightChanges.map((step) => step.scrollHeightDelta))]
      : [0, 0],
    maxInputHeightDeltaPx: maxAbs(inputMoves.map((step) => step.scrollHeightDelta)),
    inputSteps: inputMoves.length,
    forcedLayoutMedianMs: layout.length ? Math.round(layout[Math.floor(layout.length / 2)] * 1000) / 1000 : 0,
    forcedLayoutMaxMs: layout.length ? Math.round(layout[layout.length - 1] * 1000) / 1000 : 0,
    longTaskMaxMs: longTasks.length ? Math.round(Math.max(...longTasks) * 10) / 10 : 0,
  };
}

/** The phase-level claims, plus the whole-run windowing and IPC sanity checks. */
export function collectFailures(input: {
  reports: Record<string, Record<string, unknown>>;
  mountedNow: number;
  loadedMessages: number;
  unexpected: string[];
}): string[] {
  const { reports, mountedNow, loadedMessages, unexpected } = input;
  const failures: string[] = [];
  const checkStable = (name: string) => {
    const report = reports[name];
    if (!report) {
      failures.push(`${name}: the phase produced no report`);
      return;
    }
    if (report.skipped === true) {
      failures.push(`${name}: the phase was skipped, so it proves nothing`);
      return;
    }
    if ((report.commits as number) === 0) {
      failures.push(`${name}: no commit was measured, so this phase proves nothing`);
    }
    if ((report.maxCommitShiftPx as number) > 1) {
      failures.push(`${name}: a commit moved the reading row by ${report.maxCommitShiftPx}px ` +
        "beyond the reader's own scroll");
    }
    if ((report.maxIdleDriftPx as number) > 1) {
      failures.push(`${name}: the reading row drifted ${report.maxIdleDriftPx}px while the reader was idle`);
    }
    if ((report.maxInputShiftPx as number) > 1) {
      failures.push(`${name}: a wheel step moved the reading row by ${report.maxInputShiftPx}px beyond the scroll`);
    }
    if ((report.maxInputContentShiftPx as number) > 1) {
      failures.push(`${name}: a wheel step displaced content by ${report.maxInputContentShiftPx}px beyond the scroll`);
    }
    if ((report.idleHeightChangeFrames as number) > 0) {
      failures.push(`${name}: scroll height changed on ${report.idleHeightChangeFrames} idle frame(s) by ${JSON.stringify(report.idleHeightChangeRangePx)}px`);
    }
    if ((report.maxInputHeightDeltaPx as number) > 1) {
      failures.push(`${name}: scrolling changed scroll height by ${report.maxInputHeightDeltaPx}px with no new content`);
    }
  };
  for (const name of ["second-reach", "slow-reach", "slow-scroll", "at-top"]) {
    checkStable(name);
  }
  if (mountedNow >= 400) failures.push(`the pane mounted ${mountedNow} rows: upward reading must stay windowed`);
  if (loadedMessages === 0) failures.push("the transcript lost its loaded messages");
  if (unexpected.length > 0) failures.push(`unexpected IPC: ${unexpected.join(", ")}`);
  return failures;
}
