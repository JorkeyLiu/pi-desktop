/**
 * Tool-call preparation, in a real Chromium renderer.
 *
 * The fixture mounts the production transcript and the production delegate tab,
 * drives real `AgentEvent`s through the production events slice, and checks what
 * the renderer actually paints: which element breathes, that nothing else in the
 * row moves, that argument completion stops the breath without waiting for
 * execution, that the executing row replaces the preparing one in place, that a
 * steering message between them keeps its order, and that a running child shows
 * the transcript's working indicator unless it is waiting on the user.
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

    // A delegation call keeps its card shell: breathing on the avatar and title
    // only, stating no child state, clock, metrics, or stop handle.
    state = first.send({ type: "message_start", message: message("answer-2", "assistant", "", { status: "streaming" }) });
    state = first.send({
      type: "tool_prepare",
      toolCallId: "task-1",
      toolName: "Task",
      taskTitle: "Audit the parser",
    });
    render(state);
    const card = row("task-1");
    assert(
      card,
      `the preparing delegation card did not render (ids=${ids().join(",")}; state=${state.messages.map((item) => item.id).join(",")}; text=${host.textContent?.slice(0, 300)})`,
    );
    check(card.classList.contains("is-preparing"), "the preparing card lost its class");
    check(card.textContent?.includes("Audit the parser") === true, "the card did not name the work");
    check(
      animated(card.querySelector(".subagent-task-avatar")) &&
        animated(card.querySelector(".subagent-task-title")),
      "the card avatar and title do not breathe together",
    );
    check(!card.querySelector(".subagent-task-state"), "the preparing card stated a child state");
    check(!card.querySelector(".subagent-task-spinner"), "the preparing card showed the running mark");
    check(!card.querySelector(".subagent-task-status"), "the preparing card stated status wording");
    check(!card.querySelector(".subagent-task-duration"), "the preparing card ticked a duration");
    check(!card.querySelector(".subagent-task-metrics"), "the preparing card printed metric placeholders");
    check(!card.querySelector(".subagent-stop-button"), "the preparing card offered a stop handle");
    observations.preparingCard = { text: card.textContent };

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
    check(!readyCard.classList.contains("is-preparing"), "the completed card kept breathing");
    check(staticElement(readyCard.querySelector(".subagent-task-avatar")), "the completed avatar kept breathing");
    check(!readyCard.querySelector(".subagent-task-state"), "the completed card claimed a child state");
    check(!readyCard.querySelector(".subagent-task-metrics"), "the completed card printed metric placeholders");

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
    check(creating.getAttribute("data-message-id") === "task-1", "the delegation card changed identity");
    observations.executingCard = { text: creating.textContent };

    root.unmount();
    host.remove();

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
    return {
      ok: failures.length === 0,
      failures,
      iconAnimation: getComputedStyle(icon as Element).animationName,
      nameAnimation: getComputedStyle(name as Element).animationName,
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
          entries={buildTranscriptEntries([
            message("user-1", "user", "List the files and audit the parser."),
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
              toolArgs: { description: "Audit the parser" },
            }),
            message("call-read", "tool", "", {
              toolCallId: "call-read",
              toolName: "Read",
              toolStatus: "preparing",
              toolArgsComplete: true,
              status: "streaming",
            }),
          ]).entries}
          isRunning
        />
      </I18nextProvider>,
    ),
  );
  // Keep the render mounted for the capture; the runner quits the window.
  return { ok: true, mounted: true };
};
