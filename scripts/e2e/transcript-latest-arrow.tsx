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
  The floating "jump to latest" control is a navigation, so it is only there
  while a navigation is left. This probe drives the production store and
  `SessionPane` against a fixture IPC boundary and asks the question the way the
  reader does - is the button on screen, and where is the scroller:

  * at the newest bottom with follow released, the control has nowhere to go;
  * above the bottom it is the way back;
  * a bounded range with later pages, or an explicit reading window, still has
    the newest turn outside the viewport and keeps the return;
  * and none of that may come back after the pane is hidden, revealed, or
    switched, which is what a stale "follow released" bookmark used to do.

  It deliberately does not page history or measure anchoring: the upward-reading
  probe owns that. This one drives the states that arrive without a downward
  gesture - content shrinking below the reader, a clamped offset, a remembered
  unpinned position.
*/
const createdAt = "2026-09-01T00:00:00Z";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
async function until(predicate: () => boolean, label: string, maxFrames = 600) {
  for (let index = 0; index < maxFrames; index++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`Timed out: ${label}`);
}

function proseContent(index: number): string {
  const paragraphs = 2 + (index % 3);
  return Array.from(
    { length: paragraphs },
    (_, paragraph) =>
      `Row ${index} paragraph ${paragraph}. ` +
      "Reader content that wraps across the transcript column. ".repeat(4 + ((index + paragraph) % 4)),
  ).join("\n\n");
}

function row(id: string, role: UiMessage["role"], content: string): UiMessage {
  return { id, role, content, createdAt, status: "complete" };
}

function conversation(id: string, count: number): UiMessage[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? row(`${id}-m${index}`, "user", `Prompt ${index}. What changed in this part of the work?`)
      : row(`${id}-m${index}`, "assistant", proseContent(index)),
  );
}

type Fixture = { summary: SessionSummary; messages: UiMessage[] };
function fixture(id: string, title: string, count: number): Fixture {
  const messages = conversation(id, count);
  return {
    messages,
    summary: {
      id, title, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
      providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt,
      messageCount: messages.length,
    },
  };
}

declare global {
  var transcriptLatestArrowProbe: () => Promise<unknown>;
}

globalThis.transcriptLatestArrowProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const bridge = window.piDesktop;
  const fixtures = new Map<string, Fixture>([
    ["arrow-live", fixture("arrow-live", "Newest page", 40)],
    ["arrow-history", fixture("arrow-history", "Bounded history", 300)],
    ["arrow-other", fixture("arrow-other", "Second conversation", 24)],
  ]);
  const reads: { session: string; around?: string; limit: number }[] = [];
  const unexpected: string[] = [];

  window.piDesktop = {
    channels: IPC, platform: "win32", on: () => () => {},
    invoke: async <T,>(channel: string, ...args: unknown[]): Promise<Result<T>> => {
      let data: unknown;
      if (channel === IPC.invoke.sessionGet) {
        const input = args[0] as {
          id: string; messageAround?: string; messageBefore?: number; messageLimit?: number;
        };
        assert(input && typeof input === "object", "invalid history request");
        const target = fixtures.get(input.id);
        assert(target, `unexpected session ${input.id}`);
        const all = target.messages;
        const limit = Math.min(input.messageLimit ?? all.length, 1000);
        let start: number;
        let end: number;
        if (input.messageAround) {
          const index = all.findIndex((candidate) => candidate.id === input.messageAround);
          assert(index >= 0, "missing history anchor");
          end = Math.min(all.length, index + Math.ceil(limit / 2));
          start = Math.max(0, end - limit);
          reads.push({ session: input.id, around: input.messageAround, limit });
        } else if (input.messageBefore !== undefined) {
          end = Math.min(Math.max(0, input.messageBefore), all.length);
          start = Math.max(0, end - limit);
          reads.push({ session: input.id, limit });
        } else {
          end = all.length;
          start = Math.max(0, end - limit);
          reads.push({ session: input.id, limit });
        }
        data = {
          session: {
            ...target.summary, messages: all.slice(start, end), messageStart: start,
            messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: end < all.length,
          },
        };
      } else if (channel === IPC.invoke.sessionList) {
        data = { sessions: [...fixtures.values()].map((item) => item.summary) };
      } else if (channel === IPC.invoke.plansPending) data = { plans: [], state: "inactive" };
      else if (channel === IPC.invoke.pendingInteractive) data = { permissions: [], asks: [] };
      else if (channel === IPC.invoke.agentQueueList) data = { entries: [] };
      else if (
        channel === IPC.invoke.notificationMarkRead ||
        channel === IPC.invoke.notificationSetViewingSession
      ) data = { ok: true };
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

  const scroller = () => host.querySelector<HTMLDivElement>('[data-visible="true"] .thread-scroll');
  const requireScroller = () => {
    const element = scroller();
    assert(element, "the visible pane has no transcript scroller");
    return element;
  };
  /** The control is rendered or it is not; there is no hidden copy of it. */
  const arrowVisible = () => Boolean(host.querySelector('[data-visible="true"] .jump-latest-btn'));
  const geometry = () => {
    const element = requireScroller();
    return {
      scrollTop: Math.round(element.scrollTop * 100) / 100,
      scrollHeight: Math.round(element.scrollHeight * 100) / 100,
      clientHeight: Math.round(element.clientHeight * 100) / 100,
      distanceFromBottom:
        Math.round((element.scrollHeight - element.scrollTop - element.clientHeight) * 100) / 100,
    };
  };
  const atBottom = () => geometry().distanceFromBottom < 2;

  const select = async (sessionId: string) => {
    await useAppStore.getState().selectSession(sessionId);
    await frame();
    await until(
      () => !host.querySelector('[data-transcript-settling="true"]'),
      `settle ${sessionId}`,
    );
    await frame();
    await frame();
  };
  /** A real upward gesture: input first, then the offset and its scroll event. */
  const wheelUp = async (delta: number) => {
    const element = requireScroller();
    const before = element.scrollTop;
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -delta }));
    element.scrollTop = Math.max(0, element.scrollTop - delta);
    assert(element.scrollTop < before, "the reader never left the bottom");
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    await frame();
  };
  const click = async () => {
    const button = host.querySelector<HTMLElement>('[data-visible="true"] .jump-latest-btn');
    assert(button, "the jump control is not on screen");
    button.click();
    await frame();
    await until(() => atBottom(), "the jump control reaches the newest bottom");
    await frame();
    await frame();
  };

  const check = (name: string, condition: boolean, detail: unknown) => {
    if (!condition) {
      throw new Error(
        `${name} failed: ${JSON.stringify({ detail, geometry: geometry(), arrow: arrowVisible() })}`,
      );
    }
    return { name, ok: true, ...(detail as object) };
  };

  const phases: Record<string, unknown> = {};

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

    /* 1. The newest page presents at its own end: nothing is owed there. */
    await select("arrow-live");
    phases.coldOpen = check("cold open offers no navigation", atBottom() && !arrowVisible(), {});

    /* 2. A real upward gesture leaves the bottom and surfaces the control. */
    await wheelUp(220);
    const above = geometry();
    await until(() => arrowVisible(), "the jump control appears above the bottom");
    phases.aboveBottom = check(
      "a released transcript above the bottom offers latest",
      above.distanceFromBottom > 100 && arrowVisible(),
      { distanceFromBottom: above.distanceFromBottom },
    );

    /*
      3. Content below the reader shrinks - a disclosure collapsing, an image
      failing, a row collapsing - so the browser clamps the offset onto the new
      end. No gesture produced this arrival: the reader is at the newest bottom
      with follow still released, and the control has nowhere left to go.
    */
    const hidden: HTMLElement[] = [];
    const element = requireScroller();
    const rows = [...element.querySelectorAll<HTMLElement>("[data-message-id]")];
    for (let index = rows.length - 1; index >= 0 && !atBottom(); index--) {
      const node = rows[index];
      if (node.getBoundingClientRect().bottom <= element.getBoundingClientRect().top) continue;
      node.style.display = "none";
      hidden.push(node);
      if (hidden.length > 40) break;
    }
    await frame();
    await frame();
    phases.clampedToBottom = check(
      "a clamp onto the newest bottom hides the control",
      hidden.length > 0 && atBottom() && !arrowVisible(),
      { shrunkRows: hidden.length },
    );

    /* 4. Restoring the height puts the reader above the bottom again. */
    for (const node of hidden) node.style.display = "";
    await frame();
    await until(() => arrowVisible(), "the control returns above the bottom");
    phases.heightRestored = check(
      "restored height above the bottom offers latest again",
      !atBottom() && arrowVisible(),
      { distanceFromBottom: geometry().distanceFromBottom },
    );

    /* 5. The control carries the reader to the newest bottom and stays gone. */
    await click();
    phases.clicked = check("the control leaves nothing to navigate", atBottom() && !arrowVisible(), {});

    /* 6. Hide, reveal and switch must not resurrect a stale released bookmark. */
    await select("arrow-other");
    await select("arrow-live");
    phases.switchedBack = check(
      "a revealed pane does not resurrect the control at the bottom",
      atBottom() && !arrowVisible(),
      {},
    );

    /*
      7. Hide/reveal at the clamped state itself: the pane is at the newest
      bottom with follow released, which is the state a switch used to restore
      as "scroll released" and re-arm the control.
    */
    await wheelUp(160);
    await until(() => arrowVisible(), "the control appears before the clamp");
    const clamp2 = requireScroller();
    const rows2 = [...clamp2.querySelectorAll<HTMLElement>("[data-message-id]")];
    const hidden2: HTMLElement[] = [];
    for (let index = rows2.length - 1; index >= 0 && !atBottom(); index--) {
      const node = rows2[index];
      if (node.getBoundingClientRect().bottom <= clamp2.getBoundingClientRect().top) continue;
      node.style.display = "none";
      hidden2.push(node);
      if (hidden2.length > 40) break;
    }
    await frame();
    await frame();
    await select("arrow-other");
    await select("arrow-live");
    phases.revealAfterClamp = check(
      "a revealed pane stays put after a clamped arrival",
      atBottom() && !arrowVisible(),
      { shrunkRows: hidden2.length },
    );
    for (const node of hidden2) node.style.display = "";
    await frame();

    /*
      8. A bounded range keeps the return: a search target inside the history
      holds a frozen window that ends before the newest page.
    */
    await select("arrow-history");
    const target = "arrow-history-m150";
    await useAppStore.getState().navigateTranscript({
      sessionId: "arrow-history", messageId: target, query: "Row 150",
    });
    await until(() => Boolean(useAppStore.getState().transcriptViews["arrow-history"]?.focus),
      "the search target range is published");
    await until(
      () => !host.querySelector('[data-visible="true"] .transcript-navigation-loading'),
      "the target range renders",
    );
    await frame();
    await frame();
    const view = useAppStore.getState().transcriptViews["arrow-history"];
    phases.boundedRange = check(
      "a bounded range with later pages offers latest",
      view?.hasMoreAfter === true && arrowVisible(),
      { hasMoreAfter: view?.hasMoreAfter, distanceFromBottom: geometry().distanceFromBottom },
    );

    /* 9. Returning to live drops the range; the control then reaches the end. */
    useAppStore.getState().returnToLatestTranscript("arrow-history");
    await frame();
    await frame();
    await until(() => arrowVisible(), "the control appears above the live bottom");
    await click();
    phases.returnedToLatest = check(
      "returning to the live transcript ends at the newest bottom",
      atBottom() && !arrowVisible() &&
        useAppStore.getState().transcriptViews["arrow-history"] === undefined,
      {},
    );

    assert(unexpected.length === 0, `unexpected IPC calls: ${unexpected.join(", ")}`);
    return { ok: true, phases, reads, unexpected };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      phases, reads, unexpected,
    };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.piDesktop = bridge;
    useAppStore.setState(initial);
  }
};

function Panes() {
  const active = useAppStore((state) => state.activeSessionId);
  const retained = useAppStore((state) => state.retainedSessionIds);
  return (
    <div className="session-panes">
      {retained.map((id) => (
        <SessionPane key={id} sessionId={id} visible={id === active} />
      ))}
    </div>
  );
}
