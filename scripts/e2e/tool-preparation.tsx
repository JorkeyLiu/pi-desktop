/**
 * Tool-call preparation, in a real Chromium renderer.
 *
 * The fixture mounts the production transcript and the production delegate tab,
 * The fixture mounts the production transcript and the production delegate tab,
 * drives real `AgentEvent`s through the production events slice, and checks what
 * the renderer actually paints: which element breathes on an ordinary call, that
 * a delegation card with no usable name yet waits as an integrated skeleton and
 * not as placeholder text, that argument completion turns it into the real card
 * without waiting for execution, that the executing card replaces the preparing
 * one in place, that a steering message between them keeps its order, and that a
 * running child shows the transcript's working indicator unless it waits on the
 * user.
 */

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type {
  AgentEvent,
  AgentEventEnvelope,
  UiMessage,
} from "@pi-desktop/shared";
import {
  TranscriptHistory,
} from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import type { AppState } from "../../apps/desktop/src/stores/app-state";
import { createSessionRuntime } from "../../apps/desktop/src/stores/runtime/session-runtime";
import { createEventsSlice } from "../../apps/desktop/src/stores/slices/events-slice";
import type { StoreSet } from "../../apps/desktop/src/stores/slices/types";
import { assistantErrorMessage } from "../../apps/desktop/src/stores/helpers/store-helpers";

declare global {
  var toolPreparationProbe: () => Promise<unknown>;
  var toolPreparationReducedMotionProbe: () => Promise<unknown>;
  var toolPreparationScreenshotProbe: () => Promise<unknown>;
}

const START = Date.parse("2026-10-13T00:00:00.000Z");
const SESSION = "tool-preparation-fixture";

function message(
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return {
    id,
    role,
    content,
    createdAt: new Date(START).toISOString(),
    ...extra,
  };
}

function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

type Fixture = {
  state: AppState;
  runtime: ReturnType<typeof createSessionRuntime>;
  send: (event: AgentEvent, extra?: Partial<AgentEventEnvelope>) => AppState;
};

function createFixture(messages: UiMessage[]): Fixture {
  const base = useAppStore.getInitialState();
  let state: AppState = {
    ...base,
    activeSessionId: SESSION,
    messages,
    retainedTranscripts: { [SESSION]: messages },
    runningSessions: { [SESSION]: true },
    agentStatuses: {},
    pendingPermissions: {},
    pendingAsks: {},
    sessionHistory: {},
    transcriptViews: {},
    isRunning: true,
  };
  const get = () => state;
  const set: StoreSet = (update) => {
    const previous = state;
    const patch = typeof update === "function" ? update(previous) : update;
    state = { ...previous, ...patch };
    runtime.syncTranscriptProjection(state, previous);
  };
  const runtime = createSessionRuntime({ get, set });
  runtime.cacheSessionTranscript(SESSION, messages);
  Object.assign(
    state,
    createEventsSlice({
      get,
      set,
      runtime,
      withoutRecordKey: <T,>(record: Record<string, T>, key: string) => {
        const next = { ...record };
        delete next[key];
        return next;
      },
      sessionModeForPlanningState: () => "agent",
      openPlanArtifact: () => undefined,
      notifyInteractivePrompt: () => undefined,
      flushPendingSessionConfiguration: async () => undefined,
      assistantErrorMessage: (error) =>
        assistantErrorMessage({
          code: error.code,
          message: error.message,
          retriable: error.retriable === true,
        }),
      withCompactionMark: (marks, mark) => [...(marks ?? []), mark],
    }),
  );
  let offset = 0;
  return {
    get state() {
      return state;
    },
    runtime,
    send: (event, extra = {}) => {
      offset += 1;
      state.handleAgentEvent({
        sessionId: SESSION,
        ts: START + offset * 1000,
        event,
        ...extra,
      });
      return state;
    },
  };
}

function animationOf(element: Element | null): string {
  assert(element, "the expected animated element is missing");
  const style = getComputedStyle(element);
  return [
    style.animationName,
    style.animationDuration,
    style.animationTimingFunction,
    style.animationIterationCount,
  ].join(" ");
}

function animated(element: Element | null): boolean {
  assert(element, "the expected animated element is missing");
  const style = getComputedStyle(element);
  return (
    style.animationName === "tool-preparing-breath" &&
    style.animationDuration === "1.4s" &&
    style.animationIterationCount === "infinite"
  );
}

function staticElement(element: Element | null): boolean {
  assert(element, "the expected static element is missing");
  return getComputedStyle(element).animationName === "none";
}

async function createI18n() {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

async function preparationChecks(): Promise<{
  ok: boolean;
  failures: string[];
  observations: Record<string, unknown>;
}> {
  const failures: string[] = [];
  const observations: Record<string, unknown> = {};
  const check = (passed: boolean, label: string) => {
    if (!passed) failures.push(label);
  };
  const i18n = await createI18n();
  const first = createFixture([message("user-1", "user", "List the files.")]);
  const host = document.createElement("div");
  host.setAttribute("style", "position:absolute;inset:0;overflow:auto");
  document.body.append(host);
  const root = createRoot(host);
  const render = (state: AppState) =>
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptHistory
            entries={buildTranscriptEntries(state.messages).entries}
            isRunning
          />
        </I18nextProvider>,
      ),
    );
  const row = (id: string) =>
    host.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const ids = () =>
    [...host.querySelectorAll<HTMLElement>("[data-message-id]")].map(
      (element) => element.getAttribute("data-message-id"),
    );
  const indexOf = (id: string) =>
    [...host.querySelectorAll<HTMLElement>("[data-message-id]")].findIndex(
      (element) => element.getAttribute("data-message-id") === id,
    );

  try {
    first.send({ type: "message_start", message: message("answer-1", "assistant", "", { status: "streaming" }) });
    let state = first.send({
      type: "tool_prepare",
      toolCallId: "call-bash",
      toolName: "Bash",
    });
    render(state);

    const preparing = row("call-bash");
    assert(preparing, "the preparing row did not render");
    check(preparing.classList.contains("is-preparing"), "the preparing row lost its class");
    check(preparing.getAttribute("aria-busy") === "true", "the preparing row is not aria-busy");
    const preparingState = state.messages.find((item) => item.id === "call-bash");
    assert(preparingState, "the preparing call is missing from the projection");
    const preparingCreatedAt = preparingState.createdAt;
    check(preparing.textContent?.includes("Run") === true, "the preparing row lost its localized identity");
    check(!preparing.querySelector(".tool-row-summary"), "the preparing row showed an argument summary");
    check(!preparing.querySelector(".tool-row-caret"), "the preparing row showed a caret");
    check(!preparing.querySelector(".tool-spinner"), "the preparing row showed a spinner");
    check(!preparing.querySelector(".tool-row-state"), "the preparing row showed state wording");
    check(
      animated(preparing.querySelector(".tool-row-icon")) &&
        animated(preparing.querySelector(".tool-row-name")),
      "the icon and name do not breathe together",
    );
    check(staticElement(preparing), "the whole row animated instead of only its identity");
    check(staticElement(preparing.querySelector(".tool-row-head")), "the row head animated");
    observations.preparing = {
      id: preparing.getAttribute("data-message-id"),
      icon: animationOf(preparing.querySelector(".tool-row-icon")),
      name: animationOf(preparing.querySelector(".tool-row-name")),
      text: preparing.textContent,
    };

    // A steering message inserted while the call is still preparing keeps the
    // row before it: the row is placed by the call, not by whatever arrives
    // while the arguments stream.
    first.runtime.insertOptimisticUserMessage(
      SESSION,
      message("steer-1", "user", "Also check the docs.", { steering: true }),
    );
    render(first.state);
    check(indexOf("call-bash") >= 0 && indexOf("call-bash") < indexOf("steer-1"), "steering landed before the preparing row");

    // Argument generation ends: the pulse stops even though execution has not
    // started, and the row keeps its identity, place, and creation time.
    state = first.send({
      type: "tool_prepare",
      toolCallId: "call-bash",
      toolName: "Bash",
      ready: true,
    });
    render(state);
    const ready = row("call-bash");
    assert(ready, "the completed row disappeared");
    check(!ready.classList.contains("is-preparing"), "the row kept breathing after its arguments completed");
    check(staticElement(ready.querySelector(".tool-row-icon")), "the icon kept breathing after completion");
    check(staticElement(ready.querySelector(".tool-row-name")), "the name kept breathing after completion");
    check(!ready.querySelector(".tool-spinner"), "a completed call showed a spinner before execution");
    check(!ready.querySelector(".tool-row-state"), "a completed call claimed an execution state");
    check(ready.getAttribute("data-message-id") === "call-bash", "the completed row changed identity");
    check(indexOf("call-bash") < indexOf("steer-1"), "the completed row moved past the steering message");
    observations.complete = { text: ready.textContent, order: ids() };

    // Execution takes the same row over in place, with the existing running UI.
    state = first.send({
      type: "tool_start",
      toolCallId: "call-bash",
      toolName: "Bash",
      args: { command: "ls" },
    });
    render(state);
    const executing = row("call-bash");
    assert(executing, "the executing row disappeared");
    const executingState = state.messages.find((item) => item.id === "call-bash");
    assert(executingState, "the executing call is missing from the projection");
    check(
      state.messages.filter((item) => item.toolCallId === "call-bash").length === 1,
      "execution appended a second row",
    );
    check(executing.getAttribute("data-message-id") === "call-bash", "execution changed the row identity");
    check(executingState.toolArgsComplete === undefined, "the prepared marker survived execution");
    check(executingState.createdAt === preparingCreatedAt, "execution changed the call's creation time");
    check(executingState.toolStatus === "running", "execution did not take the row over");
    // A `run` row states its live lifecycle with the toned dot and wording; the
    // preparing presentation itself is gone.
    check(
      executing.querySelector(".tool-row-state")?.textContent?.includes("Working") === true,
      "the executing row lost its existing running UI",
    );
    check(indexOf("call-bash") < indexOf("steer-1"), "execution reordered the row past the steering message");
    observations.executing = {
      order: ids(),
      toolStatus: executingState.toolStatus,
      createdAt: executingState.createdAt,
    };

    // A delegation call keeps its card shell but states nothing yet: while the
    // arguments stream, its own title is a half-written argument, so the card
    // waits as one integrated skeleton. The first frame carries no parseable
    // description at all — the case that used to paint the fallback label.
    state = first.send({ type: "message_start", message: message("answer-2", "assistant", "", { status: "streaming" }) });
    state = first.send({
      type: "tool_prepare",
      toolCallId: "task-1",
      toolName: "Task",
    });
    render(state);
    const card = row("task-1");
    assert(
      card,
      `the preparing delegation card did not render (ids=${ids().join(",")}; state=${state.messages.map((item) => item.id).join(",")}; text=${host.textContent?.slice(0, 300)})`,
    );
    const shimmering = (element: Element | null) => {
      assert(element, "the expected skeleton bar is missing");
      const style = getComputedStyle(element);
      return (
        style.animationName === "subagent-task-skeleton-shimmer" &&
        style.animationDuration === "1s" &&
        style.animationIterationCount === "infinite"
      );
    };
    const skeletonSlots = (element: Element) =>
      [...element.querySelectorAll(".subagent-task-skeleton-line")];
    const skeletonBars = (element: Element) =>
      [...element.querySelectorAll(".subagent-task-skeleton-bar")];
    const checkPendingCard = (element: HTMLElement, label: string) => {
      check(element.classList.contains("is-preparing"), `${label}: the card lost its preparing class`);
      check(
        element.textContent?.trim() === "",
        `${label}: the card printed text (${JSON.stringify(element.textContent)})`,
      );
      check(!element.textContent?.includes("Unnamed subagent"), `${label}: the card printed the fallback label`);
      check(
        element.querySelector(".subagent-task-skeleton-avatar") !== null,
        `${label}: the card lost its avatar placeholder`,
      );
      // The card reserves one slot per line of the card that replaces it: the
      // title's line, the role's, and a third generic line where the figures
      // go. The third line is a bar, never a badge, dash or figure.
      const slots = skeletonSlots(element);
      check(slots.length === 3, `${label}: the card reserved ${slots.length} line slots, not 3`);
      check(
        slots.map((slot) => slot.className).join("|") ===
          "subagent-task-skeleton-line is-title|subagent-task-skeleton-line is-role|subagent-task-skeleton-line is-metrics",
        `${label}: the line slots are not the title, role and figures lines (${slots.map((slot) => slot.className).join("|")})`,
      );
      const bars = skeletonBars(element);
      check(bars.length === 3, `${label}: the card reserved ${bars.length} skeleton bars, not 3`);
      check(
        bars.every((bar) => shimmering(bar)),
        `${label}: the skeleton bars do not carry the 1s shimmer`,
      );
      check(
        bars.every((bar) => (bar.textContent ?? "").trim() === ""),
        `${label}: a skeleton line printed text`,
      );
      check(
        slots.every((slot) => slot.getAttribute("aria-hidden") === "true"),
        `${label}: the skeleton lines are not hidden from assistive technology`,
      );
      const button = element.querySelector("button.subagent-task-card");
      check(button?.getAttribute("aria-busy") === "true", `${label}: the card is not aria-busy`);
      check(
        button?.getAttribute("aria-label") === "Preparing subagent…",
        `${label}: the card has no localized accessible name (got ${JSON.stringify(button?.getAttribute("aria-label"))})`,
      );
      check(!button?.getAttribute("title"), `${label}: the card offered hover copy`);
      // The old whole-text breathing is gone from the card, and no child state,
      // clock, metrics or stop handle is invented before a delegation exists.
      check(
        !element.querySelector(".subagent-task-avatar"),
        `${label}: the card kept its breathing avatar instead of a placeholder`,
      );
      check(
        getComputedStyle(
          element.querySelector(".subagent-task-card") as Element,
        ).animationName === "none",
        `${label}: the whole card animates instead of its bars`,
      );
      check(!element.querySelector(".subagent-task-title"), `${label}: the card printed a title`);
      check(!element.querySelector(".subagent-task-state"), `${label}: the card stated a child state`);
      check(!element.querySelector(".subagent-task-spinner"), `${label}: the card showed the running mark`);
      check(!element.querySelector(".subagent-task-status"), `${label}: the card stated status wording`);
      check(!element.querySelector(".subagent-task-duration"), `${label}: the card ticked a duration`);
      check(!element.querySelector(".subagent-task-metrics"), `${label}: the card printed metric placeholders`);
      check(!element.querySelector(".subagent-stop-button"), `${label}: the card offered a stop handle`);
    };
    checkPendingCard(card, "unnamed");
    const cardButton = card.querySelector(".subagent-task-card");
    assert(cardButton, "the pending card lost its button");
    const cardBox = cardButton.getBoundingClientRect();
    const skeletonHeight = cardBox.height;
    // A pending card is a disabled button only for want of anything to open; the
    // shared `button:disabled` dimming would halve it, so the card keeps the
    // same opacity — and the same fill — as the card that replaces it.
    const pendingOpacity = getComputedStyle(cardButton).opacity;
    check(
      pendingOpacity === "1",
      `the pending card is dimmed by the shared disabled rule (opacity ${pendingOpacity})`,
    );
    // The highlight has to be visible and to cross the bar, not flick at one
    // end: freeze the 1s loop at phases of its cycle and read where the band is.
    const sweepBar = skeletonBars(card)[0];
    assert(sweepBar, "the pending card lost its first skeleton bar");
    const bandAt = (phase: number) => {
      sweepBar.style.animationDelay = `-${phase}ms`;
      sweepBar.style.animationPlayState = "paused";
      const style = getComputedStyle(sweepBar);
      const width = sweepBar.getBoundingClientRect().width;
      // `background-size` 300% makes the image three bar widths wide and
      // `background-position: p%` shifts it by (p/100)×2 widths, so the band's
      // centre sits at width × (3/2 − 2p).
      const scale = parseFloat(style.backgroundSize) / 100;
      const position = parseFloat(style.backgroundPosition) / 100;
      return { x: width * (scale / 2 - position * (scale - 1)), width };
    };
    const sweep = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900].map(bandAt);
    sweepBar.removeAttribute("style");
    const centers = sweep.map((sample) => sample.x);
    const barWidth = sweep[0].width;
    const travel = centers[centers.length - 1] - centers[0];
    check(
      centers.every((x, index) => index === 0 || x > centers[index - 1]),
      `the highlight does not travel one way (${centers.map((x) => Math.round(x)).join(",")})`,
    );
    check(
      travel >= 1.4 * barWidth,
      `the highlight travels only ${(travel / barWidth).toFixed(2)} bar widths per cycle`,
    );
    // The band is half a bar wide, so its glow still lies on the bar while its
    // centre is up to 0.3 bar widths past either end: the sweep is on the bar
    // for essentially the whole cycle, not only for a flick at one end.
    const onBar = centers.filter(
      (x) => x >= -0.31 * barWidth && x <= 1.31 * barWidth,
    ).length;
    check(
      onBar >= 9,
      `the highlight is off the bar for ${(((centers.length - onBar) / centers.length) * 100).toFixed(0)}% of the cycle`,
    );
    observations.preparingCard = {
      text: card.textContent,
      height: skeletonHeight,
      opacity: pendingOpacity,
      bars: skeletonBars(card).map((bar) => {
        const box = bar.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height) };
      }),
      sweep: {
        barWidth: Math.round(barWidth),
        centers: centers.map((x) => Math.round(x)),
        travelBarWidths: +(travel / barWidth).toFixed(2),
        timing: shimmering(sweepBar) ? "1s infinite" : "none",
        peakInk: getComputedStyle(sweepBar).backgroundImage.slice(0, 160),
      },
    };

    // A second delegation call, whose description is already parseable while
    // its arguments are still streaming: the same integrated skeleton, so no
    // half-written title flashes in place.
    state = first.send({
      type: "tool_prepare",
      toolCallId: "task-3",
      toolName: "Task",
      taskTitle: "Audit the",
    });
    render(state);
    const described = row("task-3");
    assert(described, "the described preparing card disappeared");
    checkPendingCard(described, "described");
    check(
      state.messages.filter((item) => item.toolCallId === "task-3").length === 1,
      "the described frame appended a second card",
    );
    check(
      !state.messages.some((item) => item.toolCallId === "task-3" && item.toolStatus !== "preparing"),
      "the described card claimed execution before tool_start",
    );
    state = first.send({
      type: "tool_prepare",
      toolCallId: "task-1",
      toolName: "Task",
      ready: true,
      taskTitle: "Audit the parser",
    });
    render(state);
    const readyCard = row("task-1");
    assert(readyCard, "the completed delegation card disappeared");
    check(!readyCard.classList.contains("is-preparing"), "the completed card kept its preparing class");
    check(!readyCard.querySelector(".subagent-task-skeleton-bar"), "the completed card kept its skeleton");
    check(
      readyCard.querySelector(".subagent-task-title")?.textContent === "Audit the parser",
      "the completed card did not take its real title",
    );
    check(staticElement(readyCard.querySelector(".subagent-task-avatar")), "the completed avatar kept breathing");
    check(!readyCard.querySelector(".subagent-task-state"), "the completed card claimed a child state");
    check(!readyCard.querySelector(".subagent-task-metrics"), "the completed card printed metric placeholders");
    // Only the pending card is exempt from the shared disabled dim: this real
    // card has nothing to open yet either, and keeps the treatment it always had.
    const readyOpacity = getComputedStyle(
      readyCard.querySelector(".subagent-task-card") as Element,
    ).opacity;
    check(
      readyOpacity === "0.5",
      `a real card with nothing to open lost its shared disabled dim (opacity ${readyOpacity})`,
    );

    // Execution takes the same card over in place, with the existing running UI
    // and the arguments the runtime sends with `tool_start`: the full card, its
    // title, its role and its figures.
    state = first.send({
      type: "tool_start",
      toolCallId: "task-1",
      toolName: "Task",
      args: { agent: "explorer", description: "Audit the parser" },
    });
    render(state);
    const creating = row("task-1");
    assert(creating, "the creating delegation card disappeared");
    check(Boolean(creating.querySelector(".subagent-task-state")), "the executing card lost its existing state line");
    check(Boolean(creating.querySelector(".subagent-task-metrics")), "the executing card lost its metric line");
    check(
      state.messages.filter((item) => item.toolCallId === "task-1").length === 1,
      "the delegation execution appended a second card",
    );
    // The skeleton has to claim exactly the ground the real card takes: the same
    // three lines in the same slots, so the pending card and the card that
    // replaces it are the same height in the same transcript, at the same width.
    check(
      Boolean(
        creating.querySelector(".subagent-task-title-row") &&
          creating.querySelector(".subagent-task-role") &&
          creating.querySelector(".subagent-task-metrics"),
      ),
      "the executing card does not fill the title, role and figures lines the skeleton reserved",
    );
    const realCardBox = creating
      .querySelector(".subagent-task-card")
      ?.getBoundingClientRect();
    const realHeight = realCardBox?.height;
    check(
      realHeight !== undefined && Math.abs(realHeight - skeletonHeight) <= 1,
      `the pending card is ${skeletonHeight.toFixed(2)}px tall but the card that replaces it is ${
        realHeight?.toFixed(2) ?? "missing"
      }px, in the same column at the same width`,
    );
    observations.executingCard = {
      text: creating.textContent,
      height: realHeight,
      pendingHeight: skeletonHeight,
      deltaPx: realHeight === undefined ? null : +(realHeight - skeletonHeight).toFixed(2),
    };
    // The child tab: the transcript's own working indicator ends a running
    // child's rows, and disappears while that child waits on the user.
    const childMessages = [
      message("task-child", "tool", "", {
        toolCallId: "task-child",
        toolName: "Task",
        toolStatus: "running",
        toolArgs: { agent: "explorer", description: "Investigate the cache" },
        toolResult: {
          details: {
            delegationId: "d1",
            agent: "explorer",
            status: "running",
            startedAt: START,
          },
        },
      }),
      message("child-1", "tool", "", {
        toolCallId: "child-1",
        toolName: "Read",
        toolStatus: "running",
        status: "streaming",
        parentToolCallId: "task-child",
        agentName: "explorer",
      }),
    ];
    useAppStore.setState({
      activeSessionId: SESSION,
      messages: childMessages,
      retainedTranscripts: { [SESSION]: childMessages },
      runningSessions: { [SESSION]: true },
      agentStatuses: { [SESSION]: { currentTurnId: "turn-parent" } } as unknown as AppState["agentStatuses"],
      pendingPermissions: {},
      pendingAsks: {},
      settings: { ...useAppStore.getState().settings, enterToSend: true },
    });
    const childHost = document.createElement("div");
    childHost.setAttribute("style", "position:absolute;inset:0;overflow:auto");
    document.body.append(childHost);
    const childRoot = createRoot(childHost);
    const paintChild = () =>
      flushSync(() =>
        childRoot.render(
          <I18nextProvider i18n={i18n}>
            <SubagentTranscriptTab delegationId="d1" />
          </I18nextProvider>,
        ),
      );
    paintChild();
    const indicator = () =>
      childHost.querySelector<HTMLElement>('[data-testid="working-indicator"]');
    check(Boolean(indicator()), "a running child showed no working indicator");
    check(
      indicator()?.textContent?.includes("Working") === true,
      "the child indicator did not state the localized working label",
    );
    const childRow = childHost.querySelector('[data-message-id="child-1"]');
    const firstIndicator = indicator();
    check(
      Boolean(
        childRow &&
          firstIndicator &&
          (childRow.compareDocumentPosition(firstIndicator) &
            Node.DOCUMENT_POSITION_FOLLOWING),
      ),
      "the child indicator did not follow the child's rows",
    );
    observations.childIndicator = { visible: Boolean(indicator()) };

    useAppStore.setState({
      pendingPermissions: {
        [SESSION]: [
          {
            requestId: "perm-1",
            sessionId: SESSION,
            toolCallId: "child-1",
            toolName: "Read",
            argsPreview: {},
            risk: "low",
            reason: "reads a file",
            agentName: "explorer",
            parentToolCallId: "task-child",
          },
        ],
      },
    } as unknown as Partial<AppState>);
    paintChild();
    check(!indicator(), "a child waiting on a permission still claimed to be working");

    useAppStore.setState({
      pendingPermissions: {},
      pendingAsks: {
        [SESSION]: [
          {
            requestId: "ask-1",
            sessionId: SESSION,
            toolCallId: "child-1",
            questions: [{ id: "q1", question: "Which file?", options: [], multiSelect: false }],
          },
        ],
      },
    } as unknown as Partial<AppState>);
    paintChild();
    check(!indicator(), "a child waiting on a question still claimed to be working");

    useAppStore.setState({ pendingAsks: {} } as unknown as Partial<AppState>);
    paintChild();
    check(Boolean(indicator()), "the child did not resume its working indicator");

    childRoot.unmount();
    childRoot.unmount();
    childHost.remove();
    return { ok: failures.length === 0, failures, observations };
  } finally {
    try {
      root.unmount();
    } catch {
      // The main host was already unmounted by the success path.
    }
    host.remove();
  }
}

globalThis.toolPreparationProbe = async () => preparationChecks();

globalThis.toolPreparationReducedMotionProbe = async () => {
  const failures: string[] = [];
  const i18n = await createI18n();
  const host = document.createElement("div");
  host.setAttribute("style", "position:absolute;inset:0;overflow:auto");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptHistory
            entries={buildTranscriptEntries([
              message("user-1", "user", "List the files."),
              message("answer-1", "assistant", "", { status: "streaming" }),
              message("call-bash", "tool", "", {
                toolCallId: "call-bash",
                toolName: "Bash",
                toolStatus: "preparing",
                status: "streaming",
              }),
              message("task-1", "tool", "", {
                toolCallId: "task-1",
                toolName: "Task",
                toolStatus: "preparing",
                status: "streaming",
              }),
            ]).entries}
            isRunning
          />
        </I18nextProvider>,
      ),
    );
    const row = host.querySelector<HTMLElement>('[data-message-id="call-bash"]');
    assert(row, "the reduced-motion preparing row did not render");
    const icon = row.querySelector(".tool-row-icon");
    const name = row.querySelector(".tool-row-name");
    if (getComputedStyle(icon as Element).animationName !== "none") {
      failures.push("reduced motion still animated the icon");
    }
    if (getComputedStyle(name as Element).animationName !== "none") {
      failures.push("reduced motion still animated the name");
    }
    if (!row.classList.contains("is-preparing")) {
      failures.push("reduced motion dropped the preparing row presentation");
    }
    // The delegation card's skeleton keeps its bars and its geometry, static:
    // state is never carried by motion alone.
    const card = host.querySelector<HTMLElement>('[data-message-id="task-1"]');
    assert(card, "the reduced-motion preparing card did not render");
    const bars = [...card.querySelectorAll(".subagent-task-skeleton-bar")];
    if (bars.length !== 3) {
      failures.push(`reduced motion rendered ${bars.length} skeleton bars instead of 3`);
    }
    // Reduced motion stops the sweep and changes nothing else: the three line
    // slots still take their full line boxes and the card is still the sum of
    // its padding, its lines and their gaps — not the 58px minimum.
    const cardButton = card.querySelector(".subagent-task-card") as Element | null;
    const copy = card.querySelector(".subagent-task-copy");
    if (!cardButton || !copy) {
      failures.push("reduced motion lost the pending card's copy column");
    } else {
      const cardStyle = getComputedStyle(cardButton);
      const padding =
        parseFloat(cardStyle.paddingTop) + parseFloat(cardStyle.paddingBottom);
      const gap = parseFloat(getComputedStyle(copy).gap) || 0;
      const lineBoxes = [...card.querySelectorAll(".subagent-task-skeleton-line")]
        .reduce((sum, slot) => sum + slot.getBoundingClientRect().height, 0);
      const expected = padding + lineBoxes + gap * (bars.length - 1);
      const cardHeight = cardButton.getBoundingClientRect().height;
      if (Math.abs(cardHeight - expected) > 1) {
        failures.push(
          `reduced motion left the pending card ${cardHeight}px tall against ${expected}px of lines`,
        );
      }
      if (!(lineBoxes > padding)) {
        failures.push("the pending card's lines do not clear its own min-height");
      }
    }
    for (const bar of bars) {
      if (getComputedStyle(bar).animationName !== "none") {
        failures.push("reduced motion still animated a skeleton bar");
      }
    }
    if (!card.classList.contains("is-preparing")) {
      failures.push("reduced motion dropped the preparing card presentation");
    }
    return {
      ok: failures.length === 0,
      failures,
      iconAnimation: getComputedStyle(icon as Element).animationName,
      nameAnimation: getComputedStyle(name as Element).animationName,
      cardBarAnimation: bars.length
        ? getComputedStyle(bars[0]).animationName
        : null,
    };
  } finally {
    root.unmount();
    host.remove();
  }
};

/**
 * A static frame for the artifact: a standard call and a delegation call, both
 * still being written, plus a completed one waiting for execution.
 */
globalThis.toolPreparationScreenshotProbe = async () => {
  const i18n = await createI18n();
  const host = document.createElement("div");
  host.setAttribute("style", "position:absolute;inset:0;overflow:auto;padding:24px");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <TranscriptHistory
          entries={
            buildTranscriptEntries([
              message("user-1", "user", "List the files and audit the parser."),
              message("answer-1", "assistant", "", { status: "streaming" }),
              message("call-bash", "tool", "", {
                toolCallId: "call-bash",
                toolName: "Bash",
                toolStatus: "preparing",
                status: "streaming",
              }),
              // A delegation card with no parseable name yet: one integrated
              // skeleton, no text.
              message("task-2", "tool", "", {
                toolCallId: "task-2",
                toolName: "Task",
                toolStatus: "preparing",
                status: "streaming",
              }),
              // The same card after argument completion: its real title, still
              // claiming no child state.
              message("task-1", "tool", "", {
                toolCallId: "task-1",
                toolName: "Task",
                toolStatus: "preparing",
                toolArgsComplete: true,
                status: "streaming",
                toolArgs: { agent: "explorer", description: "Audit the parser" },
              }),
              message("call-read", "tool", "", {
                toolCallId: "call-read",
                toolName: "Read",
                toolStatus: "preparing",
                toolArgsComplete: true,
                status: "streaming",
              }),
            ]).entries
          }
          isRunning
        />
      </I18nextProvider>,
    ),
  );
  // Keep the render mounted for the capture; the runner quits the window.
  return { ok: true, mounted: true };
};
