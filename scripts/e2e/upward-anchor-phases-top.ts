import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { phaseReport } from "./upward-anchor-analysis";
import type { Probe } from "./upward-anchor-context";
import { EXACT_TOP_SESSION } from "./upward-anchor-fixture";
import { assert, frame, until } from "./upward-anchor-sampling";

/*
  Phase 6: the exact top.

  At offset 0 the scroller cannot move, so a push there is still a reach even
  though it emits no scroll event - and the platform performs no anchoring
  adjustment at all at that offset. Whatever that reach asks for lands as a
  commit above the reader, and the row they are on must not move.

  The scenario gets a conversation of its own, one no earlier phase has read,
  and its older pages are answered only when this phase releases them. Reaching
  offset 0 is a deliberate position, not a walk: the earlier version wheeled up
  in steps, and every step inside the near-top band escalated - mounting more of
  the loaded window and pulling the next older page - until the conversation's
  whole history was spent before the assertion it was there for. A single
  positioning gesture reaches the top without passing through the band, the
  withheld page keeps a landing from moving the reader while the phase records
  the offset, and the pushes at offset 0 are what trigger the pane.

  Two kinds of answer are measured at offset 0:

    * a mounted-window growth - the pane mounting loaded rows above the reader,
      which is the commit native anchoring cannot hold at offset 0;
    * the older page the pane asks for once the window covers what is loaded -
      withheld by the fixture boundary until the phase has recorded that the
      request left from offset 0 with nothing rendered from it, and that the
      resting reader is not handed another page on its own.
*/
export async function runExactTopPhase(probe: Probe): Promise<void> {
  const { sampler, reader, reads, reports, gate } = probe;
  const {
    requireScroller, anchorElement, topOf, settle, select, arriveAtTop, pushAtTop,
  } = reader;
  const mountedRows = () => requireScroller().querySelectorAll("[data-message-id]").length;
  const olderReads = () => reads.filter(
    (read) => read.session === EXACT_TOP_SESSION && read.before !== undefined).length;
  const view = () => useAppStore.getState().transcriptViews[EXACT_TOP_SESSION];

  await select(EXACT_TOP_SESSION);
  await settle("top open");

  type Visit = {
    kind: "mounted" | "page" | "nothing";
    /** Offset at the moment the push was made, before anything landed. */
    offsetBefore: number;
    heightBefore: number;
    readsBefore: number;
    offsetAfter: number;
    heightDelta: number;
    rowsDelta: number;
    /** Reading row movement across the landing. */
    shiftPx: number | null;
    /** Older pages the resting reader asked for after the landing. */
    pagedWhileResting: number;
    heldByFixture: number;
  };
  const visits: Visit[] = [];
  let pageShiftPx: number | null = null;
  let pageLineId: string | null = null;

  const readsAtStart = olderReads();

  sampler.startRecording();
  for (let visit = 0; visit < 4; visit++) {
    if (visits.some((entry) => entry.kind === "page") &&
        visits.some((entry) => entry.kind === "mounted")) break;
    const heightBefore = requireScroller().scrollHeight;
    const rowsBefore = mountedRows();
    const readsBefore = olderReads();
    arriveAtTop();
    // The precondition: the pane is asked at offset 0, before anything is
    // rendered for it.
    const offsetBefore = requireScroller().scrollTop;
    const line = anchorElement();
    const lineId = line?.dataset.messageId;
    const lineOffset = line ? topOf(line) : null;
    pushAtTop();
    await until(() => Math.abs(requireScroller().scrollHeight - heightBefore) > 1 ||
      mountedRows() !== rowsBefore || olderReads() > readsBefore,
    "the push at the exact top is answered", 240);
    const committed = Math.abs(requireScroller().scrollHeight - heightBefore) > 1 ||
      mountedRows() !== rowsBefore;
    const readingLine = lineId
      ? requireScroller().querySelector<HTMLElement>(`[data-message-id="${CSS.escape(lineId)}"]`)
      : null;
    const shiftPx = readingLine && lineOffset !== null
      ? Math.round((topOf(readingLine) - lineOffset) * 100) / 100
      : null;
    if (committed) {
      await settle("top commit");
      visits.push({
        kind: "mounted", offsetBefore, heightBefore, readsBefore,
        offsetAfter: requireScroller().scrollTop,
        heightDelta: Math.round(requireScroller().scrollHeight - heightBefore),
        rowsDelta: mountedRows() - rowsBefore,
        shiftPx, pagedWhileResting: 0, heldByFixture: gate.held,
      });
      continue;
    }
    if (olderReads() > readsBefore) {
      /*
        The page the push asked for is in flight and the fixture withholds it:
        the reader's offset is still exactly 0 and nothing of the page is on
        screen. Nothing new may be asked for while they rest there.
      */
      const heldOffset = requireScroller().scrollTop;
      const heldHeight = requireScroller().scrollHeight;
      const restingReads = olderReads();
      for (let frameCount = 0; frameCount < 30; frameCount++) await frame();
      const pagedWhileResting = olderReads() - restingReads;
      const renderedWhileHeld = Math.abs(requireScroller().scrollHeight - heldHeight) > 1;
      pageShiftPx = shiftPx;
      pageLineId = lineId ?? null;
      visits.push({
        kind: "page", offsetBefore, heightBefore, readsBefore,
        offsetAfter: heldOffset,
        heightDelta: Math.round(requireScroller().scrollHeight - heightBefore),
        rowsDelta: mountedRows() - rowsBefore,
        shiftPx, pagedWhileResting, heldByFixture: gate.held,
      });
      assert(gate.held > 0,
        `the fixture answered the page pulled at the exact top before it was measured: ${JSON.stringify(visits.at(-1))}`);
      assert(view()?.loading === "before",
        `the pane published no in-flight older page at the exact top: ${JSON.stringify(visits.at(-1))}`);
      assert(!renderedWhileHeld,
        `the held page rendered while the reader was at the exact top: ${JSON.stringify(visits.at(-1))}`);
      gate.release();
      await until(() => view()?.loading === null, "the page pulled at the exact top publishes", 600);
      /*
        The page lands below the mounted window; the pane now owes the rows it
        has loaded but not mounted, so it mounts them one bounded step at a
        time. Those commits are at the same offset and are measured by the
        recording, not by a new push.
      */
      await settle("top page landing");
      visits.at(-1)!.offsetAfter = requireScroller().scrollTop;
      visits.at(-1)!.heightDelta = Math.round(requireScroller().scrollHeight - heightBefore);
      visits.at(-1)!.rowsDelta = mountedRows() - rowsBefore;
      visits.at(-1)!.pagedWhileResting = pagedWhileResting;
      gate.arm();
      continue;
    }
    visits.push({
      kind: "nothing", offsetBefore, heightBefore, readsBefore,
      offsetAfter: requireScroller().scrollTop,
      heightDelta: Math.round(requireScroller().scrollHeight - heightBefore),
      rowsDelta: mountedRows() - rowsBefore,
      shiftPx, pagedWhileResting: 0, heldByFixture: gate.held,
    });
    await settle("top no-op");
  }
  const report = phaseReport(sampler, "at-top", 0);
  const commitVisits = visits.filter((visit) => visit.kind === "mounted");
  const pageVisits = visits.filter((visit) => visit.kind === "page");
  const pageVisit = pageVisits.at(-1);
  const evidence = {
    ...report,
    visits,
    lineId: pageLineId,
    shiftPx: pageShiftPx ?? commitVisits.at(-1)?.shiftPx ?? null,
    pages: olderReads() - readsAtStart,
    scrollTopBefore: 0,
    scrollTopAfter: requireScroller().scrollTop,
    pagedWhileResting: visits.reduce((sum, visit) => sum + visit.pagedWhileResting, 0),
    heldByFixture: pageVisit?.heldByFixture ?? 0,
    loadedMessages: useAppStore.getState().messages.length,
    hasMoreBefore: view()?.hasMoreBefore ?? null,
  };
  reports["at-top"] = evidence;

  assert(visits.every((visit) => visit.offsetBefore === 0),
    `a measured landing was not made at the exact top: ${JSON.stringify(visits)}`);
  assert(commitVisits.length > 0,
    `a push at the exact top asked for nothing that landed: ${JSON.stringify(visits)}`);
  assert(commitVisits.some((visit) => visit.offsetAfter > 1),
    `the reader was left at the exact top after the commit above them: ${JSON.stringify(visits)}`);
  assert((report.maxCommitShiftPx as number) <= 1,
    `a commit at the exact top moved the reading row by ${report.maxCommitShiftPx}px: ` +
    `${JSON.stringify(report.commitDetails)}`);
  assert(pageVisit !== undefined,
    `the exact top never asked for the older page it owes: ${JSON.stringify(visits)}`);
  assert(pageVisit!.heldByFixture > 0 && pageVisit!.pagedWhileResting === 0,
    `a reader resting at the exact top was handed more history by itself: ${JSON.stringify(pageVisit)}`);
  assert(pageShiftPx !== null && Math.abs(pageShiftPx) <= 1,
    `the page pulled at the exact top moved the reading row by ${pageShiftPx}px: ${JSON.stringify(pageVisit)}`);
}
