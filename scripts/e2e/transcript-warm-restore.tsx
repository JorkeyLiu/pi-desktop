import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared/protocol";
import type { Result, SessionSummary, UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/*
  Warm-session restoration must not shrink an already-loaded reading range.

  The reported failure: leaving a session at a non-bottom reading position and
  coming back renders only the early part of the conversation plus a model
  badge; the rest is missing until the reader jumps to the bottom.

  This probe drives the production store and `SessionPane` against a fixture
  IPC boundary and checks the real DOM path: after a warm revisit, every row
  the reader could see before the switch must still be in the transcript, and
  the reading anchor must keep its viewport offset.
*/
const createdAt = "2026-09-01T00:00:00Z";
const TOTAL = 140;
const messages: UiMessage[] = Array.from({ length: TOTAL }, (_, index) => ({
  id: `warm-m${index}`, role: index % 2 === 0 ? "user" : "assistant",
  content: `Message ${index}. ${"Synthetic reading content. ".repeat(30)}`,
  createdAt, status: "complete",
}));
const sessions: SessionSummary[] = ["A", "B"].map((id) => ({
  id: `warm-${id}`, title: id, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
  providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt,
  messageCount: messages.length,
}));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 240; i++) {
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

declare global { var transcriptWarmRestoreProbe: () => Promise<unknown>; }
globalThis.transcriptWarmRestoreProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const bridge = window.piDesktop;
  const reads: Array<{ around?: string; before?: number; limit?: number }> = [];
  const unexpected: string[] = [];
  window.piDesktop = {
    channels: IPC, platform: "win32", on: () => () => {},
    invoke: async <T,>(channel: string, ...args: unknown[]): Promise<Result<T>> => {
      let data: unknown;
      if (channel === IPC.invoke.sessionGet) {
        const input = args[0] as { id: string; messageAround?: string; messageBefore?: number; messageLimit?: number };
        assert(input && typeof input === "object", "invalid history request");
        const session = sessions.find((candidate) => candidate.id === input.id);
        assert(session, "unexpected session");
        const limit = Math.min(input.messageLimit ?? TOTAL, 1000);
        let start: number;
        let end: number;
        if (input.messageAround) {
          const index = messages.findIndex((row) => row.id === input.messageAround);
          assert(index >= 0, "missing anchor");
          end = Math.min(TOTAL, index + limit / 2 + 1);
          start = Math.max(0, end - limit);
        } else if (input.messageBefore !== undefined) {
          end = Math.min(Math.max(0, input.messageBefore), TOTAL);
          start = Math.max(0, end - limit);
        } else {
          end = TOTAL;
          start = Math.max(0, end - limit);
        }
        reads.push({ around: input.messageAround, before: input.messageBefore, limit });
        data = { session: { ...session, messages: messages.slice(start, end), messageStart: start,
          messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: end < TOTAL } };
      } else if (channel === IPC.invoke.sessionList) data = { sessions };
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
  const root = createRoot(host);
  const select = async (id: string) => {
    await useAppStore.getState().selectSession(`warm-${id}`);
    await frame();
  };
  const scroller = () => host.querySelector<HTMLDivElement>('[data-visible="true"] .thread-scroll')!;
  const row = (id: string) => scroller()?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const mountedIds = () => [...scroller().querySelectorAll<HTMLElement>("[data-message-id]")]
    .map((node) => node.dataset.messageId!);
  const offset = (id: string) => row(id)!.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
  try {
    useAppStore.setState({
      sessions, messages: [], activeSessionId: undefined, selectingSessionId: undefined,
      retainedSessionIds: [], retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {},
      sessionCompactions: {}, providers: [], providerModels: {}, pendingPlans: {}, pendingAsks: {},
      pendingPermissions: {}, planningStates: {}, runningSessions: {}, isRunning: false,
      workspace: undefined, queuedPrompts: {}, notifications: [], page: "chat",
      // Production defaults: smooth streaming stays on unless the reader disabled it.
      settings: initial.settings,
    });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Panes /></I18nextProvider>));
    await select("A");
    await until(() => !host.querySelector('[data-transcript-settling="true"]'), "cold transcript settles");
    const a = scroller();
    // Read back to a mid-conversation position, well above the newest turn.
    a.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
    a.scrollTop = 900;
    a.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    const anchor = [...a.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((node) => node.getBoundingClientRect().bottom > a.getBoundingClientRect().top)!;
    const anchorId = anchor.dataset.messageId!;
    const expectedOffset = offset(anchorId);
    const beforeIds = mountedIds();
    const beforeCount = beforeIds.length;

    await select("B");
    await select("A");
    await until(() => Boolean(row(anchorId)), "the warm revisit mounts the reading row");
    await until(() => Math.abs(offset(anchorId) - expectedOffset) < 2,
      "the warm revisit keeps the reading offset");

    const afterIds = mountedIds();
    const afterCount = afterIds.length;
    // The failure being pinned: the warm revisit shrank the transcript to a
    // short early range, so most rows the reader had are gone.
    const lost = beforeIds.filter((id) => !afterIds.includes(id));
    const report = {
      anchorId,
      beforeCount,
      afterCount,
      lostCount: lost.length,
      lostSample: lost.slice(0, 8),
      afterSample: afterIds.slice(0, 8),
      afterTail: afterIds.slice(-4),
      reads: reads.map((read) => ({ around: read.around, before: read.before, limit: read.limit })),
    };
    assert(lost.length === 0,
      `warm revisit lost ${lost.length} of ${beforeCount} loaded rows: ${JSON.stringify(report)}`);
    assert(afterCount >= beforeCount,
      `warm revisit shrank the transcript from ${beforeCount} to ${afterCount} rows: ${JSON.stringify(report)}`);
    return { ok: true, ...report };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error), reads };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.piDesktop = bridge;
    useAppStore.setState(initial);
  }
};
