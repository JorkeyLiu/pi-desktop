import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared/protocol";
import type { Result, SessionSummary, UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import {
  TRANSCRIPT_SETTLE_MAX_MS,
  TRANSCRIPT_VEIL_FADE_MS,
} from "../../apps/desktop/src/lib/transcript-settle";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/*
  Cold-opening a long history must settle at the newest turn without paging
  older history the reader never asked for, and without the visible rows
  moving between the first paint and the settled layout.

  This probe drives the production store and `SessionPane` against a fixture
  IPC boundary and records, frame by frame, whether the settle veil covered
  the scroller and where the newest row sat in the viewport.
*/
const createdAt = "2026-09-01T00:00:00Z";
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`Timed out: ${label}`);
}
function Panes() {
  const active = useAppStore((state) => state.activeSessionId);
  const retained = useAppStore((state) => state.retainedSessionIds);
  return <div className="session-panes">{retained.map((id) =>
    <SessionPane key={id} sessionId={id} visible={id === active} />)}</div>;
}

type Row = { id: string; role: UiMessage["role"]; content: string };

function conversation(id: string, rows: Row[]): { summary: SessionSummary; messages: UiMessage[] } {
  const messages: UiMessage[] = rows.map((row) => ({
    id: row.id, role: row.role, content: row.content, createdAt, status: "complete",
    ...(row.role === "tool"
      ? { toolName: "Bash", toolCallId: row.id, toolStatus: "success",
          toolArgs: { command: `printf ${row.id}` },
          toolResult: { details: { stdout: "ok", exitCode: 0 } } }
      : {}),
  }));
  return {
    summary: {
      id, title: id, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
      providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt,
      messageCount: messages.length,
    },
    messages,
  };
}

// A long text conversation: the newest page is far taller than one viewport.
function longText(id: string, count: number) {
  return conversation(id, Array.from({ length: count }, (_, index) => ({
    id: `${id}-m${index}`,
    role: (index % 2 ? "assistant" : "user") as UiMessage["role"],
    content: `Message ${index}. ${"Synthetic reading content. ".repeat(30)}`,
  })));
}
// A compact tool-heavy conversation: a page of it can fit inside the reading
// viewport, so the mounted window can underfill the scroller.
function compactTools(id: string, count: number) {
  return conversation(id, Array.from({ length: count }, (_, index) => ({
    id: `${id}-t${index}`,
    role: "tool" as UiMessage["role"],
    content: `Tool ${index}`,
  })));
}

/*
  A long session whose newest page is tool-heavy: the mounted window projects
  a handful of short rows, so it underfills the scroller. The transcript is
  still at its newest turn, and the reader never asked for earlier history.
*/
function toolHeavyTail(id: string, total: number) {
  const rows: Row[] = [];
  for (let index = 0; index < total; index++) {
    // Every tenth row is a real user turn; the rest are tool calls that
    // collapse into one activity group.
    if (index % 20 === 0) {
      rows.push({ id: `${id}-u${index}`, role: "user", content: `Prompt ${index}` });
    } else {
      rows.push({ id: `${id}-t${index}`, role: "tool", content: `Tool ${index}` });
    }
  }
  return conversation(id, rows);
}

/*
  A long session whose newest page is a single collapsed tool run. The
  projection mounts very few DOM rows for it, so the newest page underfills
  the scroller even though the conversation has hundreds of older messages.
*/
function collapsedToolTail(id: string, total: number) {
  const rows: Row[] = [];
  for (let index = 0; index < total; index++) {
    rows.push({ id: `${id}-t${index}`, role: "tool", content: `Tool ${index}` });
  }
  return conversation(id, rows);
}

/*
  A session the sidebar still reports as empty while its transcript read returns
  history. The pane paints empty first, and the long page lands afterwards in a
  later commit from the selection's own read - the store's reusable-empty path,
  not a fixture shortcut.
*/
function emptyFirstPaint(id: string, count: number) {
  const fixture = longText(id, count);
  fixture.summary.messageCount = 0;
  return fixture;
}

declare global { var transcriptColdOpenProbe: () => Promise<unknown>; }
globalThis.transcriptColdOpenProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const bridge = window.piDesktop;
  const reads: Array<{
    before?: number; around?: string; limit?: number; covered: boolean;
    rows?: number; scrollTop?: number; scrollHeight?: number; clientHeight?: number;
    active?: string; historyStart?: number; historyHasMore?: boolean;
    at?: number;
  }> = [];
  // Sessions whose older-page read never settles (see `cold-slow-fill`).
  const hangingOlder = new Set<string>();
  const unexpected: string[] = [];
  const veilCovered = () => Boolean(document.querySelector(".transcript-settle-veil"));
  const fixtures = new Map<string, { summary: SessionSummary; messages: UiMessage[] }>();
  for (const fixture of [
    longText("cold-long", 400),
    compactTools("cold-compact", 100),
    toolHeavyTail("cold-tools", 400),
    collapsedToolTail("cold-collapsed", 400),
    // Same density as `cold-compact`, opened in a reading viewport taller than
    // its newest page (see `[data-underfill]` in the probe host).
    compactTools("cold-underfill", 400),
    // The sidebar count says the session is empty while the transcript read
    // returns history, so the first paint is empty and the long page lands in a
    // later commit (see `emptyFirstPaint`).
    emptyFirstPaint("cold-empty-first", 400),
    // The same path with an older-page read that never settles: the rows that
    // already loaded must still be revealed inside the settle cap.
    emptyFirstPaint("cold-slow-fill", 400),
  ]) {
    fixtures.set(fixture.summary.id, fixture);
  }
  hangingOlder.add("cold-slow-fill");
  window.piDesktop = {
    channels: IPC, platform: "win32", on: () => () => {},
    invoke: async <T,>(channel: string, ...args: unknown[]): Promise<Result<T>> => {
      let data: unknown;
      if (channel === IPC.invoke.sessionGet) {
        const input = args[0] as { id: string; messageAround?: string; messageBefore?: number; messageLimit?: number };
        assert(input && typeof input === "object", "invalid history request");
        const fixture = fixtures.get(input.id);
        assert(fixture, "unexpected session");
        const all = fixture.messages;
        const limit = Math.min(input.messageLimit ?? all.length, 1000);
        let start: number;
        let end: number;
        if (input.messageAround) {
          const index = all.findIndex((row) => row.id === input.messageAround);
          assert(index >= 0, "missing anchor");
          end = Math.min(all.length, index + limit / 2 + 1);
          start = Math.max(0, end - limit);
        } else if (input.messageBefore !== undefined) {
          end = Math.min(Math.max(0, input.messageBefore), all.length);
          start = Math.max(0, end - limit);
        } else {
          end = all.length;
          start = Math.max(0, end - limit);
        }
        const readScroller = document.querySelector<HTMLElement>('[data-visible="true"] .thread-scroll');
        const readState = useAppStore.getState();
        const readHistory = readState.activeSessionId
          ? readState.sessionHistory[readState.activeSessionId]
          : undefined;
        reads.push({
          before: input.messageBefore, around: input.messageAround, limit, covered: veilCovered(),
          rows: readScroller?.querySelectorAll("[data-message-id]").length,
          scrollTop: readScroller?.scrollTop,
          scrollHeight: readScroller?.scrollHeight,
          clientHeight: readScroller?.clientHeight,
          active: readState.activeSessionId,
          historyStart: readHistory?.messageStart,
          historyHasMore: readHistory?.hasMoreBefore,
          at: performance.now(),
        });
        if (input.messageBefore !== undefined && hangingOlder.has(input.id)) {
          // Never settles: the pane has already loaded rows and must reveal them
          // inside its settle cap anyway.
          await new Promise<never>(() => {});
        }
        data = { session: { ...fixture.summary, messages: all.slice(start, end), messageStart: start,
          messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: end < all.length } };
      } else if (channel === IPC.invoke.sessionList) data = { sessions: [...fixtures.values()].map((f) => f.summary) };
      else if (channel === IPC.invoke.plansPending) data = { plans: [], state: "inactive" };
      else if (channel === IPC.invoke.pendingInteractive) data = { permissions: [], asks: [] };
      else if (channel === IPC.invoke.agentQueueList) data = { entries: [] };
      else if (channel === IPC.invoke.notificationMarkRead || channel === IPC.invoke.notificationSetViewingSession) data = { ok: true };
      else {
        unexpected.push(channel);
        return { ok: false, error: { code: "FIXTURE_UNEXPECTED", message: `Unexpected IPC ${channel}` } };
      }
      return { ok: true, data: data as T };
    },
  };
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  /*
    A reading viewport taller than the newest page: the only way to reach an
    underfilled first commit at this message density. The scroller keeps its
    production behaviour; only its height is a fixture parameter.
  */
  const style = document.createElement("style");
  style.textContent =
    '[data-underfill="true"] .thread-scroll{flex:0 0 auto !important;' +
    "height:3600px !important;max-height:3600px !important}";
  document.head.append(style);
  const root = createRoot(host);
  const scroller = () => host.querySelector<HTMLDivElement>('[data-visible="true"] .thread-scroll');
  const atBottom = () => {
    const el = scroller();
    if (!el) return false;
    return Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 2;
  };
  /*
    Sample every frame from the first paint until the layout settles. A pane that
    starts empty has no veil in its first paint, so the end of the observation
    cannot be "no veil right now": it waits until a cover has actually been seen
    and lifted (`requireCover`).
  */
  const observe = async (
    sessionId: string,
    options: { requireCover?: boolean } = {},
  ) => {
    const samples: Array<{
      covered: boolean; top: number; scrollTop: number; rows: number;
      scrollHeight: number; clientHeight: number; revealPinned: boolean; revealFree: boolean;
      at: number;
    }> = [];
    let sampling = true;
    let coverSeen = false;
    const HISTORY_REVEAL_THRESHOLD_PX = 120;
    const sample = () => {
      if (!sampling) return;
      const el = scroller();
      if (el) {
        const rows = [...el.querySelectorAll<HTMLElement>("[data-message-id]")];
        const last = rows.at(-1);
        const scrollHeight = el.scrollHeight;
        const clientHeight = el.clientHeight;
        const scrollTop = el.scrollTop;
        const hasLayout = clientHeight > 0 && scrollHeight > 0;
        const overflows = scrollHeight > clientHeight + 1;
        const nearTop = scrollTop <= HISTORY_REVEAL_THRESHOLD_PX;
        const covered = Boolean(host.querySelector(".transcript-settle-veil"));
        if (covered) coverSeen = true;
        samples.push({
          covered,
          at: performance.now(),
          top: last ? last.getBoundingClientRect().top : Number.NaN,
          scrollTop,
          rows: rows.length,
          scrollHeight,
          clientHeight,
          revealPinned: hasLayout && !(overflows) && nearTop,
          revealFree: hasLayout && nearTop,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await useAppStore.getState().selectSession(sessionId);
    await frame();
    await until(
      () => !host.querySelector(".transcript-settle-veil") &&
        (options.requireCover !== true || coverSeen),
      "the settle veil lifts",
    );
    // Let the layout finish settling after the veil is gone.
    for (let i = 0; i < 8; i++) await frame();
    sampling = false;
    return samples;
  };
  try {
    useAppStore.setState({
      sessions: [...fixtures.values()].map((f) => f.summary), messages: [], activeSessionId: undefined,
      selectingSessionId: undefined, retainedSessionIds: [], retainedTranscripts: {}, transcriptViews: {},
      sessionHistory: {}, sessionCompactions: {}, providers: [], providerModels: {}, pendingPlans: {},
      pendingAsks: {}, pendingPermissions: {}, planningStates: {}, runningSessions: {}, isRunning: false,
      workspace: undefined, queuedPrompts: {}, notifications: [], page: "chat",
      // Production defaults: smooth streaming stays on unless the reader disabled it.
      settings: initial.settings,
    });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Panes /></I18nextProvider>));

    const reports: Record<string, unknown> = {};
    for (const sessionId of ["cold-long", "cold-compact", "cold-tools", "cold-collapsed"]) {
      reads.length = 0;
      const samples = await observe(sessionId);
      const olderReads = reads.filter((read) => read.before !== undefined);
      const uncovered = samples.filter((sample) => !sample.covered && Number.isFinite(sample.top));
      // A visible row must not move while the reader can see it.
      let maxShift = 0;
      for (let i = 1; i < uncovered.length; i++) {
        const shift = Math.abs(uncovered[i].top - uncovered[i - 1].top);
        if (shift > maxShift) maxShift = shift;
      }
      const el = scroller()!;
      const report = {
        sessionId,
        totalReads: reads.length,
        olderReads: olderReads.length,
        olderCursors: olderReads.map((read) => read.before),
        samples: samples.length,
        coveredSamples: samples.filter((sample) => sample.covered).length,
        uncoveredSamples: uncovered.length,
        maxVisibleShiftPx: Math.round(maxShift * 100) / 100,
        atBottom: atBottom(),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        finalRows: el.querySelectorAll("[data-message-id]").length,
        frames: samples.map((sample) => ({
          covered: sample.covered, rows: sample.rows, scrollTop: sample.scrollTop,
          scrollHeight: sample.scrollHeight, clientHeight: sample.clientHeight,
          revealPinned: sample.revealPinned, revealFree: sample.revealFree,
        })),
      };
      reports[sessionId] = report;
      assert(olderReads.length === 0,
        `cold open of ${sessionId} paged older history without a reader gesture: ${JSON.stringify(report)}`);
      assert(report.maxVisibleShiftPx < 2,
        `cold open of ${sessionId} moved a visible row by ${report.maxVisibleShiftPx}px: ${JSON.stringify(report)}`);
      assert(atBottom(), `cold open of ${sessionId} did not settle at the newest turn: ${JSON.stringify(report)}`);
    }

    /*
      A pane whose first paint is empty spends no hydration gate on it, so the
      long page that arrives from the selection's own read is the bounded first
      commit - in a later commit than the pane itself. Nothing may be presented
      between the empty pane and the covered bounded commit: sample every frame
      and count the frames that mounted rows while no veil covered them.
    */
    reads.length = 0;
    const revalidatedSamples = await observe("cold-empty-first", { requireCover: true });
    // Frames between the empty pane and the presented rows must all be covered;
    // the observable transition is the first frame that mounted rows at all.
    let lastEmpty = -1;
    revalidatedSamples.forEach((sample, index) => {
      if (sample.rows === 0) lastEmpty = index;
    });
    const presented = revalidatedSamples.slice(lastEmpty + 1);
    // Frames the reader could see the revalidated rows before the cover arrived.
    let uncoveredPopulatedFrames = 0;
    for (const sample of presented) {
      if (sample.covered && sample.rows > 0) break;
      if (sample.rows > 0) uncoveredPopulatedFrames++;
    }
    const olderReadsHere = reads.filter((read) => read.before !== undefined);
    const revalidatedScroller = scroller()!;
    const revalidatedReport = {
      sessionId: "cold-empty-first",
      totalReads: reads.length,
      olderReads: olderReadsHere.length,
      olderReadCovered: olderReadsHere.map((read) => read.covered),
      frames: revalidatedSamples.length,
      emptyFrames: revalidatedSamples.filter((sample) => sample.rows === 0).length,
      coveredFrames: revalidatedSamples.filter((sample) => sample.covered).length,
      uncoveredPopulatedFrames,
      firstPresentedCovered: presented[0]?.covered ?? null,
      firstPresentedRows: presented[0]?.rows ?? 0,
      // The initial-fill read this fixture makes (pre-existing, see below).
      readDetails: reads,
      atBottom: atBottom(),
      finalRows: revalidatedScroller.querySelectorAll("[data-message-id]").length,
    };
    reports["cold-empty-first"] = revalidatedReport;
    assert(revalidatedReport.emptyFrames > 0,
      `the first paint must be empty before the long page lands: ${JSON.stringify(revalidatedReport)}`);
    assert(revalidatedReport.coveredFrames > 0,
      `the bounded commit after an empty first paint must be covered: ${JSON.stringify(revalidatedReport)}`);
    assert(revalidatedReport.firstPresentedCovered === true,
      `the first frame that presented the revalidated rows was not covered: ${JSON.stringify(revalidatedReport)}`);
    assert(uncoveredPopulatedFrames === 0,
      `the bounded transition was presented uncovered in ${uncoveredPopulatedFrames} frame(s): ${JSON.stringify(revalidatedReport)}`);
    /*
      One initial fill from the still-empty scroller is pre-existing behaviour
      (the same single `before` read happens without this change), and it is not
      what this fixture is about: the pane must not page again, and it must never
      page from rows that are already presented.
    */
    assert(olderReadsHere.length <= 1,
      `an empty first paint that revalidates into history must not keep paging: ${JSON.stringify(revalidatedReport)}`);
    for (const read of olderReadsHere) {
      assert((read.rows ?? 0) === 0,
        `history must not be paged from presented rows: ${JSON.stringify(revalidatedReport)}`);
    }
    assert(atBottom(),
      `the revalidated transcript must settle at the newest turn: ${JSON.stringify(revalidatedReport)}`);

    /*
      The same empty-first path, with the older-page read never settling. The
      cover may wait for that fill so a page cannot land under a lifted veil,
      but not indefinitely: the rows that already loaded must appear within the
      settle cap plus its fade, even if the read hangs forever.
    */
    reads.length = 0;
    let slowFillError: string | undefined;
    let slowFillSamples: Awaited<ReturnType<typeof observe>> = [];
    const startedAt = performance.now();
    try {
      slowFillSamples = await observe("cold-slow-fill", { requireCover: true });
    } catch (error) {
      slowFillError = error instanceof Error ? error.message : String(error);
    }
    const elapsed = performance.now() - startedAt;
    const firstCovered = slowFillSamples.find((sample) => sample.covered);
    const lifted = slowFillSamples.find(
      (sample) => sample.covered === false && sample.rows > 0,
    );
    const coverMs =
      firstCovered && lifted ? Math.round(lifted.at - firstCovered.at) : null;
    const slowFillReport = {
      sessionId: "cold-slow-fill",
      totalReads: reads.length,
      olderReads: reads.filter((read) => read.before !== undefined).length,
      frames: slowFillSamples.length,
      coverMs,
      elapsedMs: Math.round(elapsed),
      rowsVisibleAfterLift: lifted?.rows ?? 0,
      atBottom: atBottom(),
      error: slowFillError,
    };
    reports["cold-slow-fill"] = slowFillReport;
    assert(slowFillError === undefined,
      `a hung older-page read kept the veil over loaded rows: ${JSON.stringify(slowFillReport)}`);
    assert(slowFillReport.olderReads === 1,
      `the slow-fill fixture must exercise one in-flight initial fill: ${JSON.stringify(slowFillReport)}`);
    assert(coverMs !== null,
      `the veil never covered or never lifted for the slow-fill fixture: ${JSON.stringify(slowFillReport)}`);
    assert(
      coverMs! <= TRANSCRIPT_SETTLE_MAX_MS + TRANSCRIPT_VEIL_FADE_MS + 400,
      `the veil outlived the settle cap by ${coverMs! - TRANSCRIPT_SETTLE_MAX_MS - TRANSCRIPT_VEIL_FADE_MS}ms: ${JSON.stringify(slowFillReport)}`,
    );
    assert(slowFillReport.rowsVisibleAfterLift > 0,
      `loaded rows were not revealed after the cap: ${JSON.stringify(slowFillReport)}`);
    assert(atBottom(),
      `the hung-fill transcript must still settle at the newest turn: ${JSON.stringify(slowFillReport)}`);

    /*
      An underfilled newest page cannot be told from a reader who scrolled up by
      geometry alone: the top boundary really is in view while the transcript is
      still at its newest turn. D269 deliberately fills such a pane with older
      pages until the boundary leaves the near-top band, so this fixture is a
      preservation check - the first-position gate must not stall that fill, and
      the pane must still end up at the newest turn once it is filled.
    */
    host.dataset.underfill = "true";
    reads.length = 0;
    const underfillSamples = await observe("cold-underfill");
    const underfillAtBottom = atBottom();
    const tallScroller = scroller()!;
    const underfillReport = {
      sessionId: "cold-underfill",
      totalReads: reads.length,
      olderReads: reads.filter((read) => read.before !== undefined).length,
      olderCursors: reads.filter((read) => read.before !== undefined).map((read) => read.before),
      olderReadCovered: reads.filter((read) => read.before !== undefined).map((read) => read.covered),
      // Frames whose whole content fitted the tall reading viewport.
      underfilledFrames: underfillSamples.filter((sample) =>
        sample.clientHeight > 0 && sample.scrollHeight <= sample.clientHeight + 1).length,
      frames: underfillSamples.length,
      atBottom: underfillAtBottom,
      scrollHeight: tallScroller.scrollHeight,
      clientHeight: tallScroller.clientHeight,
      finalRows: tallScroller.querySelectorAll("[data-message-id]").length,
    };
    host.dataset.underfill = "false";
    reports["cold-underfill"] = underfillReport;
    assert(underfillReport.underfilledFrames > 0,
      `the underfill fixture must open shorter than its viewport: ${JSON.stringify(underfillReport)}`);
    assert(underfillReport.olderReads > 0,
      `an underfilled newest page must still be filled: ${JSON.stringify(underfillReport)}`);
    assert(underfillAtBottom,
      `an underfilled cold open must end at the newest turn: ${JSON.stringify(underfillReport)}`);

    /*
      The gate only defers automatic continuation: a reader who genuinely scrolls
      back after the pane settled must still page older history, and the rows they
      are reading must keep their place while the page lands above them.
    */
    await observe("cold-long");
    reads.length = 0;
    const paging = scroller()!;
    // Two-stage escalation (D261/ADR 0130): reaching the top mounts more of the
    // loaded window first and only then fetches a page, so a reader walking back
    // takes several gestures. Each step is a real wheel + scroll here.
    for (let step = 0; step < 8 && reads.every((read) => read.before === undefined); step++) {
      paging.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
      paging.scrollTop = 0;
      paging.dispatchEvent(new Event("scroll", { bubbles: true }));
      await frame();
      await frame();
    }
    await until(() => reads.some((read) => read.before !== undefined), "a reader gesture pages older history");
    await until(() => paging.querySelector(".transcript-history-loading")?.getAttribute("aria-hidden") !== "false",
      "the older page lands");
    for (let i = 0; i < 6; i++) await frame();
    const olderReads = reads.filter((read) => read.before !== undefined);
    const pagingReport = {
      olderReads: olderReads.length,
      cursors: olderReads.map((read) => read.before),
      limits: olderReads.map((read) => read.limit),
    };
    assert(olderReads.length > 0, `a reader gesture must still page history: ${JSON.stringify(pagingReport)}`);
    assert(olderReads.every((read) => read.limit === 100),
      `history continuation must use the ordinary page size: ${JSON.stringify(pagingReport)}`);
    // Physical cursors walk backwards, one ordinary page at a time.
    assert(olderReads.every((read, index) =>
      index === 0 || (read.before ?? 0) < (olderReads[index - 1].before ?? 0)),
    `history cursors must move backwards: ${JSON.stringify(pagingReport)}`);
    return { ok: true, reports, pagination: pagingReport };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error), reads };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.piDesktop = bridge;
    useAppStore.setState(initial);
  }
};
