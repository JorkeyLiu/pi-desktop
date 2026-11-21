/**
 * Parallel tool rows in a real Chromium renderer.
 *
 * The fixture mounts the production `SessionPane` — the container the chat
 * surface renders per retained session — so the whole render chain is the real
 * one: the app store (`handleAgentEvent` → events slice → session runtime),
 * `useTranscriptView`, `ChatTranscript`, `useTranscriptScroll` (projection,
 * mounted window, pinned follow), `TranscriptHistory` + `TranscriptTail`,
 * `AssistantTurn`, `ActivityGroup` / `ActivityItems`, `ToolRow`, and the
 * application's built stylesheet.
 *
 * What a static render cannot show is the frame-by-frame geometry: two parallel
 * calls prepared as A then B must stay A above B while B finishes first and A is
 * still running, and there must never be a frame where one of them moves, is
 * duplicated, or leaves the active turn for a settled region. Every event is
 * followed by per-frame samples of the painted `data-message-id` order, the
 * rows' bounding boxes, their rendered phase, and the projection entry each row
 * belongs to (last entry = the tail `TranscriptTail` paints, earlier entries =
 * the settled history `TranscriptHistory` paints).
 *
 * Only the transport is absent: no `api.getSession` call is made except where a
 * scenario deliberately stubs it to emulate a durable refresh.
 */

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { AgentEvent, AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import { getTranscriptProjection } from "../../apps/desktop/src/lib/transcript-projection";
import type { AppState } from "../../apps/desktop/src/stores/app-state";

declare global {
  var parallelOrderProbe: () => Promise<unknown>;
}

const START = Date.parse("2026-10-13T00:00:00.000Z");
const SESSION = "parallel-order-fixture";

/** How many frames after each event are sampled: a transient frame is a bug too. */
const FRAMES_PER_EVENT = 4;

const at = (offset: number) => new Date(START + offset).toISOString();

function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

const message = (
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage => ({ id, role, content, createdAt: at(0), ...extra });

const answer = (extra: Partial<UiMessage> = {}): UiMessage =>
  message("answer", "assistant", "", {
    createdAt: at(100),
    status: "streaming",
    ...extra,
  });

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

type Sample = {
  event: string;
  frame: number;
  /** Painted order of every row that carries a data-message-id. */
  dom: string[];
  /** Painted order restricted to the two parallel calls. */
  pairDom: Array<string | null>;
  /** Projection order (history + tail), for comparison with the DOM. */
  projection: string[];
  /** Pixel top / height / bottom of each call row, and the pane's scroll. */
  geometry: Record<string, { top: number; bottom: number; height: number } | null>;
  scrollTop: number | null;
  scrollHeight: number | null;
  /** Store phase of each call: `preparing` / `running` / `success` / `error`. */
  phase: Record<string, string | undefined>;
  /** Rendered class of each call row, so the paint is part of the record. */
  rowClass: Record<string, string | null>;
  /** How many painted elements carry each call id (dup detection). */
  instances: Record<string, number>;
  /** Projection entry index holding each call, and whether it is the tail. */
  entry: Record<string, { index: number; tail: boolean; part: number } | null>;
  entriesLength: number;
  historyLength: number;
  /** Only the tail-carrying rows are `TranscriptTail`; earlier ones are history. */
  /** Only the tail-carrying rows are `TranscriptTail`; earlier ones are history. */
  tailId: string | null;
  /** What the pane actually painted, so an empty read is diagnosable. */
  diag: {
    paneClass: string;
    scroller: boolean;
    content: boolean;
    messageRows: number;
    minimap: number;
    text: string;
    height: number;
  };
};

function readMessages(state: AppState): UiMessage[] {
  return state.activeSessionId === SESSION
    ? state.messages
    : (state.retainedTranscripts[SESSION] ?? []);
}

function sample(
  pane: HTMLElement,
  state: AppState,
  event: string,
  frameIndex: number,
): Sample {
  const messages = readMessages(state);
  const rows = [...pane.querySelectorAll<HTMLElement>("[data-message-id]")];
  const dom = rows.map((row) => row.getAttribute("data-message-id") ?? "");
  const calls = ["call-a", "call-b"];
  const elements = (id: string) =>
    rows.filter((row) => row.getAttribute("data-message-id") === id);
  const geometry: Sample["geometry"] = {};
  const rowClass: Record<string, string | null> = {};
  const instances: Record<string, number> = {};
  for (const id of calls) {
    const found = elements(id);
    instances[id] = found.length;
    const first = found[0];
    geometry[id] = first
      ? (() => {
          const box = first.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, height: box.height };
        })()
      : null;
    rowClass[id] = first?.className ?? null;
  }
  const phase: Record<string, string | undefined> = {};
  for (const id of calls) {
    phase[id] = messages.find((row) => row.id === id)?.toolStatus;
  }

  const projection = getTranscriptProjection(messages);
  const entries = projection.entries;
  const tail = entries.at(-1);
  const projectionOrder: string[] = [];
  const entry: Sample["entry"] = {};
  for (const item of messages) if (projection.visible.includes(item)) projectionOrder.push(item.id);
  const walk = (
    index: number,
    parts: readonly unknown[],
    entryValue: typeof entries[number],
  ) => {
    for (const [partIndex, rawPart] of parts.entries()) {
      const part = rawPart as { kind: string; message?: UiMessage; items?: Array<{ message: UiMessage }> };
      if (part.kind === "message" && part.message) {
        if (calls.includes(part.message.id)) {
          entry[part.message.id] = { index, tail: entryValue === tail, part: partIndex };
        }
        continue;
      }
      for (const item of part.items ?? []) {
        if (calls.includes(item.message.id)) {
          entry[item.message.id] = { index, tail: entryValue === tail, part: partIndex };
        }
      }
    }
  };
  for (const [index, value] of entries.entries()) {
    if (value.kind === "message") {
      if (calls.includes(value.message.id)) {
        entry[value.message.id] = { index, tail: value === tail, part: -1 };
      }
      continue;
    }
    if (value.kind === "assistant-turn") walk(index, value.parts, value);
  }
  const scroller = pane.querySelector<HTMLElement>(".thread-scroll");
  return {
    event,
    frame: frameIndex,
    dom,
    pairDom: dom.filter((id) => calls.includes(id)),
    projection: projectionOrder,
    geometry,
    scrollTop: scroller?.scrollTop ?? null,
    scrollHeight: scroller?.scrollHeight ?? null,
    phase,
    rowClass,
    instances,
    entry,
    entriesLength: entries.length,
    historyLength: projection.history.length,
    tailId: tail ? (tail.kind === "message" ? tail.message.id : tail.id) : null,
    diag: {
      paneClass: pane.className,
      scroller: Boolean(scroller),
      content: Boolean(pane.querySelector(".thread-content")),
      messageRows: rows.length,
      minimap: pane.querySelectorAll("[data-minimap-id]").length,
      text: (pane.textContent ?? "").slice(0, 80),
      height: pane.getBoundingClientRect().height,
    },
  };
}

type Fixture = {
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
  send: (event: AgentEvent, extra?: Partial<AgentEventEnvelope>) => void;
  /** Same store entry, caller-chosen ts: two calls can start in one millisecond. */
  sendAt: (event: AgentEvent, ts: number) => void;
  settle: () => Promise<void>;
  trace: (label: string, frames?: number) => Promise<Sample[]>;
  unmount: () => void;
};

async function mount(
  i18n: ReturnType<typeof createInstance>,
  history: UiMessage[],
  options: {
    thinkingDisplayMode?: "detailed" | "compact";
    smoothStreaming?: boolean;
    /** Seed a reading view snapshot taken before the live turn, as a page does. */
    staleView?: boolean;
  } = {},
): Promise<Fixture> {
  const base = useAppStore.getInitialState();
  const seed: Partial<AppState> = {
    activeSessionId: SESSION,
    page: "chat",
    sessions: [
      {
        id: SESSION,
        source: "local",
        title: "Parallel calls",
        mode: "agent",
        thinkingLevel: "high",
        permissionMode: "auto",
        messageCount: history.length,
        createdAt: at(0),
        updatedAt: at(0),
      } as never,
    ],
    messages: history,
    retainedSessionIds: [SESSION],
    retainedTranscripts: { [SESSION]: history },
    runningSessions: { [SESSION]: true },
    isRunning: true,
    sessionHistory: {
      [SESSION]: { scope: { kind: "main" }, messageStart: 0, hasMoreBefore: false },
    },
    transcriptViews: options.staleView
      ? {
          [SESSION]: {
            messages: history.filter((row) => row.id !== "live-user"),
            messageStart: 0,
            messageEnd: history.length - 1,
            hasMoreBefore: false,
            hasMoreAfter: false,
            focus: null,
            loading: null,
            scope: { kind: "main" },
          } as never,
        }
      : {},
    agentStatuses: {},
    pendingPermissions: {},
    pendingAsks: {},
    planningStates: {},
    latestTurnResults: {},
    sessionOutcomes: {},
    settings: {
      ...base.settings,
      theme: "dark",
      enterToSend: true,
      onboardingDismissed: false,
      smoothStreaming: options.smoothStreaming ?? false,
      thinkingDisplayMode: options.thinkingDisplayMode ?? "detailed",
    } as never,
  };
  useAppStore.setState(seed);

  const host = document.createElement("div");
  host.setAttribute(
    "style",
    "position:absolute;top:0;left:0;right:0;height:720px;display:flex;flex-direction:column;min-height:0",
  );
  document.body.append(host);
  const renderErrors: unknown[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => renderErrors.push(error) });
  flushSync(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <SessionPane sessionId={SESSION} visible />
      </I18nextProvider>,
    ),
  );

  let offset = 0;
  const sendAt = (event: AgentEvent, ts: number) => {
    useAppStore.getState().handleAgentEvent({
      sessionId: SESSION,
      ts,
      event,
    } as AgentEventEnvelope);
  };
  const send = (event: AgentEvent, extra: Partial<AgentEventEnvelope> = {}) => {
    offset += 1;
    useAppStore.getState().handleAgentEvent({
      sessionId: SESSION,
      ts: START + offset * 10,
      event,
      ...extra,
    } as AgentEventEnvelope);
  };

  const pane = () => {
    const element = host.querySelector<HTMLElement>(".session-pane");
    assert(element, "the production session pane did not mount");
    return element;
  };

  const settle = async () => {
    let previous = "";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await frame();
      const element = pane();
      const rows = element.querySelectorAll<HTMLElement>("[data-message-id]");
      const geometry = [
        element.querySelector(".thread-content")?.clientHeight,
        element.querySelector(".thread-scroll")?.scrollTop,
        element.querySelector(".thread-scroll")?.scrollHeight,
        rows[0]?.getBoundingClientRect().top,
        rows[rows.length - 1]?.getBoundingClientRect().bottom,
      ].join(":");
      if (geometry === previous) return;
      previous = geometry;
    }
  };

  const trace = async (label: string, frames = FRAMES_PER_EVENT) => {
    const samples: Sample[] = [];
    for (let index = 0; index < frames; index += 1) {
      await frame();
      samples.push(sample(pane(), useAppStore.getState(), label, index));
    }
    return samples;
  };

  assert(renderErrors.length === 0, `React failed to render the pane: ${renderErrors.map(String)}`);

  return {
    host,
    root,
    send,
    sendAt,
    settle,
    trace,
    unmount: () => {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

/** Past history long enough that the mount window, not the row count, is bounded. */
function pastHistory(turns: number): UiMessage[] {
  const rows: UiMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    rows.push(message(`user-${index}`, "user", `Step ${index}: inspect the workspace.`));
    rows.push(
      message(`past-tool-${index}`, "tool", "done", {
        toolName: "Bash",
        toolCallId: `past-call-${index}`,
        toolStatus: "success",
        toolArgs: { command: `printf step-${index}` },
        toolResult: { details: { stdout: "done", exitCode: 0 } },
      }),
    );
    rows.push(message(`past-answer-${index}`, "assistant", `Finished step ${index}.`));
  }
  rows.push(message("live-user", "user", "Run both checks in parallel."));
  return rows;
}

type Check = { failures: string[] };

/**
 * The invariant under test, checked on every sampled frame rather than only the
 * settled state: A is painted above B, each call has exactly one row, and both
 * stay in the same activity part of the same turn entry.
 */
function checkFrames(checks: Check, label: string, samples: Sample[], callOrder: readonly string[]) {
  for (const item of samples) {
    const [first, second] = callOrder;
    // A frame before the second call exists is legitimately single-row or
    // empty: preparation is per call. The invariant is that a painted row never
    // disagrees with the projection, and that A stays above B from the moment
    // both calls are live until the turn settles.
    for (const id of callOrder) {
      const projected = Boolean(item.entry[id]);
      const painted = item.instances[id] ?? 0;
      if (projected && painted !== 1) {
        checks.failures.push(
          `${label} frame ${item.frame}: ${id} is in the projection but painted ${painted} times`,
        );
      }
      if (!projected && painted !== 0) {
        checks.failures.push(
          `${label} frame ${item.frame}: ${id} is painted ${painted} times while absent from the projection`,
        );
      }
    }
    const firstIndex = item.pairDom.indexOf(first);
    const secondIndex = item.pairDom.indexOf(second);
    if (firstIndex < 0 || secondIndex < 0) continue;
    if (firstIndex > secondIndex) {
      checks.failures.push(
        `${label} frame ${item.frame}: painted order is ${item.pairDom.join(",")} (expected ${callOrder.join(",")})`,
      );
    }
    const firstBox = item.geometry[first];
    const secondBox = item.geometry[second];
    if (!firstBox || !secondBox) {
      checks.failures.push(`${label} frame ${item.frame}: a call row has no box`);
    } else if (firstBox.top > secondBox.top) {
      checks.failures.push(
        `${label} frame ${item.frame}: ${first} top=${firstBox.top} is below ${second} top=${secondBox.top}`,
      );
    }
    for (const id of callOrder) {
      if (item.instances[id] !== 1) {
        checks.failures.push(
          `${label} frame ${item.frame}: ${id} painted ${item.instances[id]} times`,
        );
      }
    }
    const a = item.entry[first];
    const b = item.entry[second];
    if (!a || !b) {
      checks.failures.push(
        `${label} frame ${item.frame}: a call is not in the projection (${JSON.stringify(item.entry)})`,
      );
    } else if (a.index !== b.index || a.part !== b.part) {
      checks.failures.push(
        `${label} frame ${item.frame}: calls split across entries/parts ${JSON.stringify(item.entry)}`,
      );
    }
  }
}

async function scenario(
  i18n: ReturnType<typeof createInstance>,
  options: {
    label: string;
    thinkingDisplayMode?: "detailed" | "compact";
    thinking?: boolean;
    turns?: number;
    smoothStreaming?: boolean;
    sameStartTimestamp?: boolean;
    staleView?: boolean;
  },
) {
  const checks: Check = { failures: [] };
  const fixture = await mount(i18n, pastHistory(options.turns ?? 6), {
    thinkingDisplayMode: options.thinkingDisplayMode,
    smoothStreaming: options.smoothStreaming,
    staleView: options.staleView,
  });
  const frames: Record<string, Sample[]> = {};
  try {
    await fixture.settle();
    await document.fonts.ready;
    await fixture.settle();
    frames.settledStart = [sample(
      fixture.host.querySelector<HTMLElement>(".session-pane")!,
      useAppStore.getState(),
      "settledStart",
      0,
    )];

    const record = async (label: string) => {
      const samples = await fixture.trace(label);
      frames[label] = samples;
      return samples;
    };

    fixture.send({
      type: "message_start",
      message: answer({
        ...(options.thinking
          ? { thinking: "", thinkingStatus: "streaming" as never, content: "" }
          : {}),
      }),
    });
    await record("message_start");

    if (options.thinking) {
      fixture.send({
        type: "message_update",
        stream: "delta",
        deltaText: "Both commands run at the same time.",
        message: answer({ thinking: "Both commands run at the same time.", status: "streaming" }),
      } as AgentEvent);
      await record("thinking");
      fixture.send({
        type: "message_end",
        message: answer({ thinking: "Both commands run at the same time.", status: "streaming" }),
      } as AgentEvent);
      await record("thinking_end");
    }

    fixture.send({ type: "tool_prepare", toolCallId: "call-a", toolName: "Bash" });
    await record("prepare_a");
    fixture.send({ type: "tool_prepare", toolCallId: "call-b", toolName: "Bash" });
    await record("prepare_b");
    fixture.send({ type: "tool_prepare", toolCallId: "call-a", toolName: "Bash", ready: true });
    await record("ready_a");
    fixture.send({ type: "tool_prepare", toolCallId: "call-b", toolName: "Bash", ready: true });
    await record("ready_b");
    // Chat Completions streams the answer text while the calls are prepared.
    fixture.send({
      type: "message_update",
      stream: "delta",
      deltaText: "Running both.",
      message: answer({ content: "Running both.", status: "streaming" }),
    } as AgentEvent);
    await record("text_delta");
    fixture.send({
      type: "message_end",
      message: answer({ content: "Running both.", status: "complete" }),
    } as AgentEvent);
    await record("message_end");

    const startEvent = (toolCallId: string, command: string): AgentEvent => ({
      type: "tool_start",
      toolCallId,
      toolName: "Bash",
      args: { command },
    });
    if (options.sameStartTimestamp) {
      const sameTs = START + 400;
      fixture.sendAt(startEvent("call-a", "printf a"), sameTs);
    } else {
      fixture.send(startEvent("call-a", "printf a"));
    }
    await record("start_a");
    if (options.sameStartTimestamp) {
      fixture.sendAt(startEvent("call-b", "printf b"), START + 400);
    } else {
      fixture.send(startEvent("call-b", "printf b"));
    }
    await record("start_b");

    // B finishes first, A is still running: the reported moment.
    fixture.send({ type: "tool_end", toolCallId: "call-b", result: "b", isError: false });
    await record("end_b_while_a_runs");
    // The main process replays the persisted row through message_end.
    fixture.send({
      type: "message_end",
      message: message("call-b", "tool", "b", {
        createdAt: at(150),
        toolCallId: "call-b",
        toolName: "Bash",
        toolArgs: { command: "printf b" },
        toolStatus: "success",
        toolResult: "b",
        toolCompletedAt: at(200),
        status: "complete",
        isError: false,
      }),
    } as AgentEvent);
    await record("b_persisted_echo");

    fixture.send({ type: "tool_end", toolCallId: "call-a", result: "a", isError: false });
    await record("end_a");
    fixture.send({
      type: "message_end",
      message: message("call-a", "tool", "a", {
        createdAt: at(150),
        toolCallId: "call-a",
        toolName: "Bash",
        toolArgs: { command: "printf a" },
        toolStatus: "success",
        toolResult: "a",
        toolCompletedAt: at(300),
        status: "complete",
        isError: false,
      }),
    } as AgentEvent);
    await record("a_persisted_echo");

    fixture.send({ type: "agent_end" });
    await record("agent_end");

    for (const [label, samples] of Object.entries(frames)) {
      checkFrames(checks, `${options.label}/${label}`, samples, ["call-a", "call-b"]);
    }

    const sawRunningWhileBFailed = Object.entries(frames).some(([label, samples]) =>
      label === "end_b_while_a_runs" &&
      samples.some((item) => item.phase["call-b"] === "success" && item.phase["call-a"] === "running"),
    );
    if (!sawRunningWhileBFailed) {
      checks.failures.push(
        `${options.label}: the scenario never reached "B done while A runs" (${JSON.stringify(
          frames.end_b_while_a_runs?.map((item) => item.phase),
        )})`,
      );
    }
    const tailDuringRun = frames.end_b_while_a_runs?.every((item) => item.entry["call-a"]?.tail === true);
    if (!tailDuringRun) {
      checks.failures.push(
        `${options.label}: the running pair left the active tail (${JSON.stringify(
          frames.end_b_while_a_runs?.map((item) => item.entry),
        )})`,
      );
    }

    return {
      label: options.label,
      ok: checks.failures.length === 0,
      failures: checks.failures,
      frames,
      final: frames.a_persisted_echo?.at(-1),
    };
  } finally {
    fixture.unmount();
  }
}

/**
 * A durable refresh that lands in finish order (B persisted first) must not
 * reorder the live transcript: the real `selectSession` path is driven with a
 * stubbed transport, and the painted frames are sampled exactly like the live
 * scenario.
 */
async function durableRefreshScenario(i18n: ReturnType<typeof createInstance>) {
  const checks: Check = { failures: [] };
  const fixture = await mount(i18n, pastHistory(6));
  const frames: Record<string, Sample[]> = {};
  const original = api.getSession;
  let durable: UiMessage[] = [];
  api.getSession = (async () => ({
    session: {
      id: SESSION,
      messages: durable,
      messageStart: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
      historyScope: { kind: "main" },
    },
  })) as typeof api.getSession;
  try {
    await fixture.settle();
    await document.fonts.ready;
    await fixture.settle();

    fixture.send({ type: "message_start", message: answer() });
    fixture.send({ type: "tool_prepare", toolCallId: "call-a", toolName: "Bash" });
    fixture.send({ type: "tool_prepare", toolCallId: "call-b", toolName: "Bash" });
    fixture.send({ type: "tool_prepare", toolCallId: "call-a", toolName: "Bash", ready: true });
    fixture.send({ type: "tool_prepare", toolCallId: "call-b", toolName: "Bash", ready: true });
    fixture.send({ type: "message_end", message: answer({ content: "Running both.", status: "complete" }) } as AgentEvent);
    fixture.send({ type: "tool_start", toolCallId: "call-a", toolName: "Bash", args: { command: "printf a" } });
    fixture.send({ type: "tool_start", toolCallId: "call-b", toolName: "Bash", args: { command: "printf b" } });
    fixture.send({ type: "tool_end", toolCallId: "call-b", result: "b", isError: false });
    frames.liveBeforeRefresh = await fixture.trace("liveBeforeRefresh");

    // The host persisted only the finished call, at its finish position.
    durable = [
      ...pastHistory(6),
      answer({ content: "Running both.", status: "complete" }),
      message("call-b", "tool", "b", {
        createdAt: at(150),
        toolCallId: "call-b",
        toolName: "Bash",
        toolArgs: { command: "printf b" },
        toolStatus: "success",
        toolResult: "b",
        toolCompletedAt: at(200),
        status: "complete",
        isError: false,
      }),
    ];
    await useAppStore.getState().selectSession(SESSION, { record: false });
    frames.afterDurableRefresh = await fixture.trace("afterDurableRefresh", 8);

    fixture.send({ type: "tool_end", toolCallId: "call-a", result: "a", isError: false });
    frames.a_endAfterRefresh = await fixture.trace("a_endAfterRefresh");

    durable = [
      ...durable,
      message("call-a", "tool", "a", {
        createdAt: at(150),
        toolCallId: "call-a",
        toolName: "Bash",
        toolArgs: { command: "printf a" },
        toolStatus: "success",
        toolResult: "a",
        toolCompletedAt: at(300),
        status: "complete",
        isError: false,
      }),
    ];
    await useAppStore.getState().selectSession(SESSION, { record: false });
    frames.afterSecondDurableRefresh = await fixture.trace("afterSecondDurableRefresh", 8);

    for (const [label, samples] of Object.entries(frames)) {
      checkFrames(checks, `durable/${label}`, samples, ["call-a", "call-b"]);
    }
    const stillLiveAfterFirst = frames.afterDurableRefresh?.every(
      (item) => item.entry["call-a"]?.tail === true && item.entry["call-b"]?.tail === true,
    );
    if (!stillLiveAfterFirst) {
      checks.failures.push(
        `durable refresh moved the running pair out of the active tail: ${JSON.stringify(
          frames.afterDurableRefresh?.map((item) => item.entry),
        )}`,
      );
    }
    return { label: "durableRefresh", ok: checks.failures.length === 0, failures: checks.failures, frames };
  } finally {
    api.getSession = original;
    fixture.unmount();
  }
}

/* ------------------------------------------------------------------------- */

async function probe() {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  document.documentElement.dataset.theme = "dark";

  const scenarios = [];
  scenarios.push(await scenario(i18n, { label: "detailed", thinkingDisplayMode: "detailed" }));
  scenarios.push(await scenario(i18n, { label: "compact", thinkingDisplayMode: "compact" }));
  // Compact hides a finished thought; the pair's order must survive the
  // thinking row being collapsed and later dropped.
  scenarios.push(
    await scenario(i18n, {
      label: "compact-thinking",
      thinkingDisplayMode: "compact",
      thinking: true,
    }),
  );
  scenarios.push(
    await scenario(i18n, {
      label: "smooth-default",
      thinkingDisplayMode: "detailed",
      smoothStreaming: true,
    }),
  );
  scenarios.push(
    await scenario(i18n, {
      label: "same-ms-start",
      thinkingDisplayMode: "detailed",
      smoothStreaming: true,
      sameStartTimestamp: true,
    }),
  );
  // The pane's live rows are merged into a reading snapshot taken before the
  // turn; the tail boundary is computed from that merge.
  scenarios.push(
    await scenario(i18n, {
      label: "stale-view",
      thinkingDisplayMode: "detailed",
      smoothStreaming: true,
      staleView: true,
    }),
  );
  const durableRefresh = await durableRefreshScenario(i18n);
  scenarios.push(durableRefresh);

  const failures = scenarios.flatMap((item) => item.failures);
  // Per-frame evidence is kept for the reported moment only: the whole trace of
  // every frame would run to megabytes and hide the signal.
  const moment = scenarios.map((item) => ({
    label: item.label,
    moment: item.frames.end_b_while_a_runs?.map((sample) => ({
      frame: sample.frame,
      dom: sample.dom,
      top: {
        a: sample.geometry["call-a"]?.top ?? null,
        b: sample.geometry["call-b"]?.top ?? null,
      },
      height: {
        a: sample.geometry["call-a"]?.height ?? null,
        b: sample.geometry["call-b"]?.height ?? null,
      },
      phase: sample.phase,
      rowClass: sample.rowClass,
      instances: sample.instances,
      entry: sample.entry,
      tailId: sample.tailId,
      scrollTop: sample.scrollTop,
      scrollHeight: sample.scrollHeight,
      historyLength: sample.historyLength,
      entriesLength: sample.entriesLength,
      diag: sample.diag,
    })),
    settledStart: item.frames.settledStart?.[0]
      ? {
          entriesLength: item.frames.settledStart[0].entriesLength,
          historyLength: item.frames.settledStart[0].historyLength,
          paintedRows: item.frames.settledStart[0].dom.length,
          dom: item.frames.settledStart[0].dom,
          scrollHeight: item.frames.settledStart[0].scrollHeight,
          scrollTop: item.frames.settledStart[0].scrollTop,
          diag: item.frames.settledStart[0].diag,
        }
      : null,
    finalPair: item.final
      ? { dom: item.final.dom.filter((id) => id === "call-a" || id === "call-b"), entry: item.final.entry }
      : null,
    stages: Object.fromEntries(
      Object.entries(item.frames).map(([label, samples]) => [
        label,
        {
          first: samples[0]?.dom.slice(-4),
          last: samples.at(-1)?.dom.slice(-4),
          tailId: samples[0]?.tailId,
          entriesLength: samples[0]?.entriesLength,
          historyLength: samples[0]?.historyLength,
          messageRows: samples[0]?.diag.messageRows,
          top: samples[0]?.scrollTop,
          height: samples[0]?.scrollHeight,
          phase: samples[0]?.phase,
          rowClass: samples[0]?.rowClass,
          boxes: Object.fromEntries(
            Object.entries(samples[0]?.geometry ?? {}).map(([id, box]) => [
              id,
              box ? Math.round(box.top * 100) / 100 : null,
            ]),
          ),
        },
      ]),
    ),
    failureCount: item.failures.length,
    failures: item.failures.slice(0, 8),
  }));
  return {
    ok: failures.length === 0,
    failures,
    scenarios: moment,
  };
}

globalThis.parallelOrderProbe = probe;

