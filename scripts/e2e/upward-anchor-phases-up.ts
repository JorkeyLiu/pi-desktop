import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { phaseReport } from "./upward-anchor-analysis";
import type { Probe } from "./upward-anchor-context";
import { FIRST_BOUNDARY, PAGE } from "./upward-anchor-fixture";
import { assert, frame, until } from "./upward-anchor-sampling";
import { runExactTopPhase } from "./upward-anchor-phases-top";

/*
  Reading upward, phases 0-6: the cold open, the first and second reach into the
  near-top band, a page boundary that cuts inside the assistant turn being read,
  a slow older page both idle and under the reader's wheel, and the exact top
  (in `upward-anchor-phases-top.ts`).

  Each phase records the geometry of every mounted row on every frame and writes
  its measurement into `probe.reports`; the assertions are the ones the probe has
  always made.
*/
export async function runUpPhases(probe: Probe): Promise<void> {
  const { sampler, reader, reads, reports, regroup } = probe;
  const {
    requireScroller, atBottom, topOf, fragmentsInRow,
    wheelUp, readToBand, positionAt, settle, select,
  } = reader;
  const report = (name: string, from: number) => phaseReport(sampler, name, from);

  /* Cold open: the newest page lands at its own end. */
  const coldReads = reads.length;
  /*
    Presenting a session is the one place this change trades a layout shortcut
    for real heights, so the probe reports what that costs on the same fixture:
    how long the newest page takes to settle and how many rows it mounted.
  */
  const coldStartedAt = performance.now();
  const coldLongTasks = sampler.longTasks.length;
  await select("up-fast");
  const coldReport = {
    reads: reads.slice(coldReads),
    settleMs: Math.round(performance.now() - coldStartedAt),
    longTaskMs: Math.round(Math.max(0, ...sampler.longTasks.slice(coldLongTasks)) * 10) / 10,
    atBottom: atBottom(),
    mountedRows: requireScroller().querySelectorAll("[data-message-id]").length,
  };
  assert(coldReport.atBottom,
    `cold open did not settle at the newest turn: ${JSON.stringify(coldReport)}`);
  assert(coldReport.reads.length === 1 && coldReport.reads[0].limit === PAGE,
    `cold open must read one ordinary page: ${JSON.stringify(coldReport.reads)}`);
  regroup.coldOpen = coldReport;

  /*
    1. The reader's first reach into the near-top band, then no input at all.
    The pane grows the mounted window before it pages, so what lands here is
    both kinds of upward height: mounted rows and, once the window covers the
    loaded history, the first older page - the one that cuts inside the
    marathon assistant turn.
  */
  sampler.startRecording();
  const bandReads = reads.length;
  const bandHeight = requireScroller().scrollHeight;
  assert(readToBand(90),
    `the reader never reached the near-top band (scrollTop=${requireScroller().scrollTop}, height=${requireScroller().scrollHeight})`);
  await until(() => Math.abs(requireScroller().scrollHeight - bandHeight) > 1,
    "the mounted window or the first older page lands");
  await settle("first reach");
  reports["first-reach"] = report("first-reach", 0);
  reports["first-reach"].reads = reads.length - bandReads;
  reports["first-reach"].scrollTop = requireScroller().scrollTop;

  /*
    2. The next older page, whose boundary falls between turns. This is the
    ordinary case: the reader's row must not move at all - same row, same DOM
    node, all of the height added above it.
  */
  sampler.startRecording();
  const plainReads = reads.length;
  const plainHeight = requireScroller().scrollHeight;
  assert(readToBand(90), "the reader never returned to the near-top band");
  await until(() => Math.abs(requireScroller().scrollHeight - plainHeight) > 1,
    "the second older page lands");
  await settle("second reach");
  reports["second-reach"] = report("second-reach", 0);
  reports["second-reach"].reads = reads.length - plainReads;
  reports["second-reach"].scrollTop = requireScroller().scrollTop;

  /*
    3. A page boundary that cuts inside one assistant turn. The reader's line
    is put inside the row the boundary will cut - the first fragment of the
    older page - and that page then merges its now-older fragments into the
    row already mounted. The row has to keep its DOM node and really grow, and
    the fragment the reader is looking at has to stay on its line.
  */
  await select("up-merge");
  await settle("merge open");
  /** First fragment of the page whose boundary cuts the marathon turn. */
  const cutId = `up-merge-m${FIRST_BOUNDARY}`;
  const cutNode = () => requireScroller().querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(cutId)}"]`);
  // Mounting more of the loaded window is what brings that fragment into the
  // DOM: the boundary is inside the newest page, and the window withholds the
  // older end of it.
  for (let step = 0; step < 12 && !cutNode(); step++) {
    readToBand(90);
    await settle("merge reach");
  }
  assert(cutNode(), `the boundary fragment ${cutId} never mounted`);
  const mergeLine = cutNode()!;
  /*
    The baseline is read synchronously, before the page the pane asks for here
    can land: the reader's own scroll is what puts the fragment on the line,
    and everything after it must leave that line alone.
  */
  await positionAt(mergeLine, 60);
  const mergeLineId = mergeLine.dataset.messageId;
  const mergeFragmentsBefore = fragmentsInRow(mergeLine);
  const mergeTopBefore = topOf(mergeLine);
  const mergeScrollTopBefore = requireScroller().scrollTop;
  const mergeHeightBefore = requireScroller().scrollHeight;
  const mergeViewBefore = useAppStore.getState().transcriptViews["up-merge"];
  // Whatever the pane still owes (a mounted window, then the page) lands here.
  for (let step = 0; step < 10 && fragmentsInRow(mergeLine) <= mergeFragmentsBefore; step++) {
    if (mergeLine.isConnected) await positionAt(mergeLine, 60);
    await settle("merge request");
  }
  await until(() => fragmentsInRow(mergeLine) > mergeFragmentsBefore,
    "the page that cuts inside the row being read lands", 600);
  await settle("merge landing");
  const mergeLineAfter = mergeLineId
    ? requireScroller().querySelector<HTMLElement>(`[data-message-id="${CSS.escape(mergeLineId)}"]`)
    : null;
  const mergeEvidence = {
    lineId: mergeLineId ?? null,
    lineInsideTurn: mergeLineId === cutId,
    sameNode: Boolean(mergeLineAfter && mergeLine.isSameNode(mergeLineAfter)),
    fragmentsBefore: mergeFragmentsBefore,
    fragmentsAfter: mergeLineAfter ? fragmentsInRow(mergeLineAfter) : 0,
    mergeGrewRow: mergeLineAfter ? fragmentsInRow(mergeLineAfter) > mergeFragmentsBefore : false,
    fragmentShiftPx: mergeLineAfter
      ? Math.round((topOf(mergeLineAfter) - mergeTopBefore) * 100) / 100
      : null,
    scrollTopBefore: mergeScrollTopBefore,
    scrollTopAfter: requireScroller().scrollTop,
    heightDelta: requireScroller().scrollHeight - mergeHeightBefore,
    viewBefore: Boolean(mergeViewBefore),
    reads: reads.filter((read) => read.session === "up-merge" && read.before !== undefined).length,
  };
  /*
    What has to hold here: the prepend keeps the row's DOM node (the row key
    follows the turn's last fragment), the merge really put older fragments
    into the row the reader is reading, and the fragment inside it did not
    move. The last one is the pane's own hold: native anchoring absorbed part
    of the merge and held a box other than the fragment in view (ADR 0331).
  */
  const mergeHeld = Math.abs(mergeEvidence.fragmentShiftPx ?? Infinity) <= 1;
  regroup["merge-inside-turn"] = { ...mergeEvidence, held: mergeHeld };
  assert(mergeEvidence.sameNode === true,
    `a prepend re-keyed the row being read: ${JSON.stringify(mergeEvidence)}`);
  if (mergeEvidence.lineInsideTurn) {
    assert(mergeEvidence.mergeGrewRow === true,
      `the fixture must merge older fragments into the row being read: ${JSON.stringify(mergeEvidence)}`);
    assert(mergeHeld === true,
      `a page that cut inside the row being read moved its visible fragment by ` +
      `${mergeEvidence.fragmentShiftPx}px: ${JSON.stringify(mergeEvidence)}`);
  }

  /* 4. A slow older page (180 ms): the reader stops before it lands. */
  await select("up-slow");
  await settle("slow open");
  let slowEvidence: Record<string, unknown> = { phase: "slow-reach", skipped: true };
  for (let attempt = 0; attempt < 8 && (slowEvidence.skipped as boolean | undefined) !== false; attempt++) {
    const requestsBefore = reads.filter((read) => read.session === "up-slow" && read.before !== undefined).length;
    readToBand(90);
    for (let wait = 0; wait < 240; wait++) {
      const requested = reads.filter((read) => read.session === "up-slow" && read.before !== undefined).length > requestsBefore;
      if (requested || useAppStore.getState().transcriptViews["up-slow"]) break;
      await frame();
    }
    const requested = reads.filter((read) => read.session === "up-slow" && read.before !== undefined).length > requestsBefore;
    if (!requested) {
      await settle("slow growth");
      continue;
    }
    // The read is in flight and the reader has stopped: sample its landing. The
    // store publishes the page as the view's `loading` clearing, which is the
    // commit this phase is about.
    sampler.startRecording();
    const requestAt = performance.now();
    await until(() => {
      const view = useAppStore.getState().transcriptViews["up-slow"];
      return Boolean(view) && view!.loading === null;
    }, "the slow older page publishes");
    await settle("slow landing");
    slowEvidence = {
      ...report("slow-reach", 0),
      scrollTop: requireScroller().scrollTop,
      latencyMs: Math.round(performance.now() - requestAt),
      skipped: false,
    };
  }
  reports["slow-reach"] = slowEvidence;

  /* 5. A slow older page (180 ms) while the reader keeps scrolling. */
  sampler.startRecording();
  const slowOlderReads = () => reads.filter(
    (read) => read.session === "up-slow" && read.before !== undefined).length;
  const slowView = () => useAppStore.getState().transcriptViews["up-slow"];
  let slowScrolled = 0;
  {
    const before = slowOlderReads();
    for (let step = 0; step < 20 && slowOlderReads() === before; step++) {
      readToBand(90);
      await settle("slow scroll reach");
    }
    assert(slowOlderReads() > before, "the slow pane requested an older page");
    const requestedAt = performance.now();
    // The read is in flight: the reader keeps scrolling up. The landing has to
    // answer with where they are now, not with where they were when the page
    // was asked for.
    for (let frameCount = 0; frameCount < 240 && slowView()?.loading; frameCount++) {
      slowScrolled++;
      await wheelUp(40);
    }
    await until(() => !slowView()?.loading, "the slow page lands while the reader scrolls");
    await settle("slow scroll landing");
    reports["slow-scroll"] = {
      ...report("slow-scroll", 0),
      wheelStepsWhileLoading: slowScrolled,
      latencyMs: Math.round(performance.now() - requestedAt),
      scrollTop: requireScroller().scrollTop,
    };
    assert(slowScrolled > 0,
      `the reader never scrolled while the slow page was in flight: ${JSON.stringify(reports["slow-scroll"])}`);
    assert((reports["slow-scroll"] as Record<string, unknown>).wheelStepsWhileLoading as number > 1,
      `the slow page did not stay in flight long enough to scroll under it: ${JSON.stringify(reports["slow-scroll"])}`);
  }

  /*
    6. The exact top, on its own conversation: see `upward-anchor-phases-top.ts`.
    The phases above measure the pane they leave selected; the warm return below
    expects the slow pane to be the one the reader was on, so it is selected
    again here, exactly as a reader returning to it would.
  */
  await runExactTopPhase(probe);
  await select("up-slow");
}
