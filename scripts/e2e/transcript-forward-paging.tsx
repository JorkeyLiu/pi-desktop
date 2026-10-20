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
  Reading forward is a scroll, not a control. This probe drives the production
  store and `SessionPane` against a fixture IPC boundary and checks the real DOM
  path: a restored historical range pages itself forward to the newest message
  as the reader approaches the bottom, and the manual "load later" control never
  appears.
*/
const createdAt = "2026-09-01T00:00:00Z";
const TOTAL = 400;
const messages: UiMessage[] = Array.from({ length: TOTAL }, (_, index) => ({
  id: `fw-m${index}`, role: index % 2 === 0 ? "user" : "assistant",
  content: `Message ${index}. ${"Synthetic reading content. ".repeat(20)}`,
  createdAt, status: "complete",
}));
const sessions: SessionSummary[] = ["A", "B", "C", "D", "E"].map((id) => ({
  id: `fw-${id}`, title: id, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
  providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt,
  messageCount: TOTAL,
}));
const NEWEST = `fw-m${TOTAL - 1}`;
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

declare global { var transcriptForwardPagingProbe: () => Promise<unknown>; }
globalThis.transcriptForwardPagingProbe = async () => {
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
        assert(input && typeof input === "object" && "id" in input, "invalid history request");
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
    await useAppStore.getState().selectSession(`fw-${id}`);
    await frame();
  };
  const scroller = () => host.querySelector<HTMLDivElement>('[data-visible="true"] .thread-scroll')!;
  const row = (id: string) => scroller()?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const atBottom = () => {
    const el = scroller();
    return Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 2;
  };
  const scrollToBottom = () => {
    const el = scroller();
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 200 }));
    el.scrollTop = el.scrollHeight - el.clientHeight;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  };
  const readingView = () => useAppStore.getState().transcriptViews["fw-A"];
  try {
    useAppStore.setState({
      sessions, messages: [], activeSessionId: undefined, selectingSessionId: undefined,
      retainedSessionIds: [], retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {},
      sessionCompactions: {}, providers: [], providerModels: {}, pendingPlans: {}, pendingAsks: {},
      pendingPermissions: {}, planningStates: {}, runningSessions: {}, isRunning: false,
      workspace: undefined, queuedPrompts: {}, notifications: [], page: "chat",
      settings: { ...initial.settings, smoothStreaming: false },
    });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Panes /></I18nextProvider>));
    await select("A");
    await until(() => !host.querySelector('[data-transcript-settling="true"]'), "cold transcript settles");
    await until(() => atBottom(), "a cold open lands on the newest message");
    assert(row(NEWEST), "the tail page contains the newest message");

    // Read back to the head of the conversation. Upward paging is the existing
    // reading behaviour and it leaves a deep bookmark to restore from.
    const el = scroller();
    for (let step = 0; step < 24; step++) {
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      await frame();
      await frame();
      if (row("fw-m0")) break;
    }
    assert(row("fw-m0"), "upward paging reaches the first message");
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    el.scrollTop = 60;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    const anchor = [...el.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((node) => node.getBoundingClientRect().bottom > el.getBoundingClientRect().top)!;
    const anchorId = anchor.dataset.messageId!;
    const anchorIndex = Number(anchorId.replace("fw-m", ""));
    assert(anchorIndex < 60, `the bookmark must sit in the old half of the conversation: ${anchorIndex}`);
    for (const id of ["B", "C", "D", "E"]) await select(id);
    assert(!host.querySelector('[data-session-pane="fw-A"]'), "A was not evicted");
    await select("A");
    await until(() => Boolean(row(anchorId)), "restored range mounts the bookmarked row");
    await until(() => Boolean(readingView()?.restored), "the pane restored a historical range");
    assert(readingView()?.hasMoreAfter === true,
      `the restored range must still have a later page to read: ${JSON.stringify(readingView())}`);
    assert(Boolean(host.querySelector(".jump-latest-btn")), "a reading window keeps the jump-to-latest entry");
    // Restoring a range must not drag a reader who was reading history to the
    // bottom, and the bookmarked row keeps its own offset.
    assert(!atBottom(), "restoring a range must not force the reader to the bottom");

    // The manual control must be gone: no button, and no copy for one.
    assert(!host.querySelector(".transcript-load-later"), "no manual load-later control in the DOM");
    assert(!host.querySelector(".transcript-load-later button"), "no manual load-later button");
    assert(!host.textContent?.includes("Load later messages"), "no manual load-later copy");

    // Read forward: every scroll to the bottom fetches the next page itself.
    const pagesBefore = reads.length;
    for (let step = 0; step < 12; step++) {
      if (!readingView()?.hasMoreAfter && row(NEWEST)) break;
      scrollToBottom();
      await until(() => !readingView()?.loading, "the forward page settles");
      await frame();
      if (step === 0) {
        // A landed page keeps the reader in reading mode: it appends below the
        // window instead of re-pinning the viewport or dropping the exit.
        assert(readingView()?.restored === true, "a landed forward page keeps the reading range");
        assert(Boolean(host.querySelector(".jump-latest-btn")),
          "a landed forward page keeps the way back to the newest message");
      }
    }
    const forwardReads = reads.slice(pagesBefore);
    assert(forwardReads.length >= 2,
      `reading to the bottom must page forward more than once: ${JSON.stringify(forwardReads)}`);
    assert(forwardReads.every((read) => read.limit === 100),
      `automatic forward paging must use the ordinary page size: ${JSON.stringify(forwardReads)}`);
    await until(() => Boolean(row(NEWEST)), "continuous automatic paging reaches the newest message");
    assert(readingView() === undefined || readingView().hasMoreAfter !== true,
      "the newest page ends forward paging");
    assert(readingView() === undefined || readingView().restored === undefined,
      "reaching the tail resumes live output instead of holding a frozen range");
    // Live output must land in the window that just caught up: a message that
    // arrives now is visible without any further navigation.
    const liveTail = {
      id: "fw-live", role: "assistant" as const,
      content: "A live answer that arrived after the window caught up.",
      createdAt: "2026-09-02T00:00:00Z", status: "complete" as const,
    };
    useAppStore.setState((state) => ({ messages: [...state.messages, liveTail] }));
    await until(() => Boolean(row("fw-live")), "a live message reaches the caught-up window");
    // The reading position the user chose is still reachable, and the jump
    // control returns to the newest message.
    const jump = host.querySelector<HTMLButtonElement>('[data-visible="true"] .jump-latest-btn');
    if (jump) {
      flushSync(() => jump.click());
      await until(() => atBottom() && !readingView(), "the jump control returns to latest and releases the range");
    }
    assert(!row(NEWEST) || atBottom() || !jump, "return to latest ends at the bottom");
    assert(unexpected.length === 0, `unexpected IPC: ${unexpected}`);
    return {
      ok: true, anchorId, anchorIndex,
      forwardPages: forwardReads.length,
      forwardCursors: forwardReads.map((read) => read.before),
      panes: host.querySelectorAll("[data-session-pane]").length,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error), unexpected, reads };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.piDesktop = bridge;
    useAppStore.setState(initial);
  }
};
