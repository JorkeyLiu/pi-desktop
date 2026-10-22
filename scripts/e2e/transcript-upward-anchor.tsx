import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared/protocol";
import type { Result, SessionSummary, UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { transcriptViewMessages } from "../../apps/desktop/src/lib/transcript-reading";
import { reduceTranscriptWindow } from "../../apps/desktop/src/lib/transcript-window";
import { collectFailures } from "./upward-anchor-analysis";
import type { Probe } from "./upward-anchor-context";
import { createFixtures, exactTopGate, installFixtureIpc, type ReadRecord } from "./upward-anchor-fixture";
import { runTailPhases } from "./upward-anchor-phases-tail";
import { runUpPhases } from "./upward-anchor-phases-up";
import { createReader } from "./upward-anchor-reader";
import { createSampler } from "./upward-anchor-sampling";

/*
  Reading upward through history must keep the reader's content where it is.

  The transcript pages older history in 100 raw messages at a time and mounts a
  trailing window over what is loaded. Both add height above the reading
  position. This probe drives the production store and `SessionPane` against a
  fixture IPC boundary and records the geometry of every mounted row on every
  frame, so the claim is measured the way a reader experiences it:

    screenShift   = how far the reading row moved on screen
    unwantedShift = screenShift + inputDelta
                    (how far it moved that the reader's own wheel did not ask
                    for; zero is the whole claim under test)
    contentShift  = screenShift + scrollTopDelta
                    (how far the content above the reading row changed height)

  A wheel step is the reader's own movement and is subtracted; a commit - a
  mounted-window growth or an older page adding rows above the viewport - must
  leave no shift behind, whether the reader is idle or still scrolling. The
  phases cover the states where native scroll anchoring is not enough on its
  own: a page landing while the reader rests at the exact top, a page whose
  boundary cuts inside the row being read, and a slow page that lands after the
  reader has kept scrolling.

  The fixture deliberately cuts a page inside a single assistant turn: the
  marathon turn straddles the first page boundary, so the first older page
  merges its own fragments into the row the reader is already looking at.

  The probe is assembled from adjacent modules: the fixture history and its IPC
  boundary, the frame sampler, the reader actions, the frame analysis, and the
  phases themselves.
*/
declare global { var transcriptUpwardAnchorProbe: () => Promise<unknown>; }
globalThis.transcriptUpwardAnchorProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const bridge = window.piDesktop;
  const fixtures = createFixtures();
  const reads: ReadRecord[] = [];
  const unexpected: string[] = [];
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  const scroller = () => host.querySelector<HTMLDivElement>('[data-visible="true"] .thread-scroll');
  const sampler = createSampler({ scroller });
  installFixtureIpc({ fixtures, reads, unexpected });
  document.body.append(host);
  const root = createRoot(host);
  const reader = createReader({ scroller, sampler, host });
  sampler.start();
  const reports: Record<string, Record<string, unknown>> = {};
  const regroup: Record<string, unknown> = {};
  const probe: Probe = { host, sampler, reader, reads, reports, regroup, gate: exactTopGate(fixtures) };

  try {
    useAppStore.setState({
      sessions: [...fixtures.values()].map((item) => item.summary), messages: [],
      activeSessionId: undefined, selectingSessionId: undefined, retainedSessionIds: [],
      retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {}, sessionCompactions: {},
      providers: [], providerModels: {}, pendingPlans: {}, pendingAsks: {}, pendingPermissions: {},
      planningStates: {}, runningSessions: {}, isRunning: false, workspace: undefined,
      queuedPrompts: {}, notifications: [], page: "chat", settings: initial.settings,
    });
    flushSync(() => root.render(
      <I18nextProvider i18n={i18n}><Panes /></I18nextProvider>,
    ));

    await runUpPhases(probe);
    await runTailPhases(probe);

    /* ---------- assertions ---------- */
    const mountedNow = reader.requireScroller().querySelectorAll("[data-message-id]").length;
    const loadedMessages = useAppStore.getState().messages.length;
    const failures = collectFailures({ reports, mountedNow, loadedMessages, unexpected });

    return {
      ok: failures.length === 0,
      error: failures.join(" | "),
      failures,
      reports,
      regroup,
      reads: reads.map((read) => ({ session: read.session, before: read.before, limit: read.limit })),
      versions: {
        loadedMessages, mountedRows: mountedNow,
        mountedShareOfLoaded: Math.round((mountedNow / Math.max(1, loadedMessages)) * 1000) / 1000,
      },
      unexpected,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      reports, regroup, reads, unexpected,
    };
  } finally {
    sampler.stop();
    flushSync(() => root.unmount());
    host.remove();
    window.piDesktop = bridge;
    useAppStore.setState(initial);
  }
};

function Panes() {
  const active = useAppStore((state) => state.activeSessionId);
  const retained = useAppStore((state) => state.retainedSessionIds);
  return <div className="session-panes">{retained.map((id) =>
    <SessionPane key={id} sessionId={id} visible={id === active} />)}</div>;
}
