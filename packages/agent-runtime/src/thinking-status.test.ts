/**
 * Thinking phase through both producers: the session runtime and the subagent
 * run must emit an explicit `thinkingStatus` phase change — including a
 * `thinking_end` that carries no content delta — while the assistant message
 * itself stays `status: "streaming"`. Tool activity never stands in for the
 * end of thinking; a stream that terminates without `thinking_end` still
 * completes the phase at its terminal boundary.
 *
 * Synthetic provider frames only; no network, no paid APIs.
 */
import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
  applyMessageUpdate,
  type AgentEvent,
  type AgentEventEnvelope,
  type PlanExecution,
  type UiMessage,
} from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import { SubagentRun, type SubagentRunOptions } from "./subagent.js";
import { createStreamCoalescer } from "./stream-coalescer.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "low", "medium", "high"],
};

const commandShell = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
} as const;

function frame(
  type: AssistantMessageEvent["type"],
  contentIndex = 0,
  extra: Record<string, unknown> = {},
): AssistantMessageEvent {
  return {
    type,
    contentIndex,
    partial: { role: "assistant", content: [] },
    ...extra,
  } as unknown as AssistantMessageEvent;
}

const assistantContent = (blocks: unknown[]): AgentMessage =>
  ({ role: "assistant", content: blocks }) as unknown as AgentMessage;

/** A settled pi assistant message: the runtime overflow check reads usage. */
const settledContent = (blocks: unknown[], stopReason: string): AgentMessage =>
  ({
    role: "assistant",
    content: blocks,
    api: "anthropic-messages",
    provider: "local",
    model: "local-model",
    stopReason,
    timestamp: 4,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  }) as unknown as AgentMessage;

const thinkingBlock = (thinking: string) => ({ type: "thinking", thinking });
const textBlock = (text: string) => ({ type: "text", text });

function updatesOf(events: AgentEventEnvelope[]): Extract<AgentEvent, { type: "message_update" }>[] {
  return events
    .map((envelope) => envelope.event)
    .filter((event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update");
}

function createSessionHarness() {
  const events: AgentEventEnvelope[] = [];
  const runtime = new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-1",
    mode: "agent",
    turnId: "turn-1",
    provider,
    commandShell: commandShell as never,
    thinkingLevel: "medium",
    onEvent: ((envelope: unknown) => {
      events.push(envelope as AgentEventEnvelope);
    }) as never,
  });
  const handleAgentEvent = (runtime as unknown as {
    handleAgentEvent: (event: unknown) => Promise<void>;
  }).handleAgentEvent.bind(runtime);
  return { runtime, events, handleAgentEvent };
}

function createDelegateHarness() {
  const events: AgentEventEnvelope[] = [];
  const run = new SubagentRun({
    definition: {
      name: "explorer",
      description: "Search the workspace and report findings.",
      tools: ["Read"],
      prompt: "Find the answer and report it.",
      source: "builtin",
    },
    sessionId: "session-1",
    turnId: "turn-1",
    parentToolCallId: "task-1",
    task: "Find where the permission dialog is rendered.",
    provider,
    thinkingLevel: "medium",
    systemPrompt: "system",
    tools: [],
    onEvent: ((envelope: unknown) => {
      events.push(envelope as AgentEventEnvelope);
    }) as unknown as SubagentRunOptions["onEvent"],
  });
  const handleEvent = (run as unknown as {
    handleEvent: (event: unknown) => void;
  }).handleEvent.bind(run);
  return { run, events, handleEvent };
}

type Harness = {
  events: AgentEventEnvelope[];
  send: (event: unknown) => Promise<void> | void;
  /** Force out frames the producer parked in its own stream coalescer. */
  flush: () => void;
  dispose?: () => Promise<void> | void;
};

function sessionHarness(): Harness {
  const { runtime, events, handleAgentEvent } = createSessionHarness();
  return {
    events,
    send: (event: unknown) => handleAgentEvent(event),
    // The session runtime parks append-only frames in its own coalescer;
    // flush between sends so each phase change lands as its own frame.
    flush: () => (runtime as unknown as { streamSink: { flush: () => void } }).streamSink.flush(),
    dispose: () => runtime.dispose(),
  };
}

function delegateHarness(): Harness {
  const { run, events, handleEvent } = createDelegateHarness();
  // The delegate run emits directly; nothing to flush.
  return { events, send: (event: unknown) => handleEvent(event), flush: () => {} };
}

async function sendFlushed(harness: Harness, event: unknown) {
  await harness.send(event);
  harness.flush();
}

async function emitThinkingThenTools(harness: Harness) {
  await sendFlushed(harness, { type: "message_start", message: assistantContent([]) });
  // thinking_start carries an empty block: no content delta exists yet.
  await sendFlushed(harness, {
    type: "message_update",
    message: assistantContent([thinkingBlock("")]),
    assistantMessageEvent: frame("thinking_start", 0),
  });
  await sendFlushed(harness, {
    type: "message_update",
    message: assistantContent([thinkingBlock("plan")]),
    assistantMessageEvent: frame("thinking_delta", 0, { delta: "plan" }),
  });
  // thinking_end with no new delta: the cumulative thinking already matches.
  await sendFlushed(harness, {
    type: "message_update",
    message: assistantContent([thinkingBlock("plan")]),
    assistantMessageEvent: frame("thinking_end", 0, { content: "plan" }),
  });
  // Tool arguments stream after thinking completed; the message still streams.
  const toolCall = { type: "toolCall", id: "call-1", name: "Read", arguments: {} };
  await sendFlushed(harness, {
    type: "message_update",
    message: assistantContent([thinkingBlock("plan"), toolCall]),
    assistantMessageEvent: frame("toolcall_start", 1),
  });
  await sendFlushed(harness, {
    type: "message_update",
    message: assistantContent([thinkingBlock("plan"), toolCall]),
    assistantMessageEvent: frame("toolcall_delta", 1, { delta: '{"a":1}' }),
  });
  await sendFlushed(harness, {
    type: "message_end",
    message: settledContent([thinkingBlock("plan"), textBlock("done")], "stop"),
  });
}

describe.each([
  ["session runtime", sessionHarness],
  ["subagent run", delegateHarness],
] as const)("%s thinking phase", (_name, createHarness) => {
  it("completes thinking on thinking_end with no delta while the message still streams", async () => {
    const harness = createHarness();
    await emitThinkingThenTools(harness);
    const updates = updatesOf(harness.events);
    const phases = updates.map((update) => update.message.thinkingStatus);
    // The start opens the phase even though it carries no delta.
    expect(phases).toContain("streaming");
    // The end lands as its own phase frame with no content: the delegate run
    // keeps its existing empty-delta growth marker, which appends nothing.
    const endFrames = updates.filter(
      (update) =>
        update.message.thinkingStatus === "complete" &&
        (update.deltaText ?? "") === "" &&
        update.deltaThinking === undefined,
    );
    expect(endFrames.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update.message.status).toBe("streaming");
    }
    // No tool frame regresses the completed phase.
    const completeIndex = updates.findIndex(
      (update) => update.message.thinkingStatus === "complete",
    );
    for (const update of updates.slice(completeIndex + 1)) {
      if (update.message.thinkingStatus !== undefined) {
        expect(update.message.thinkingStatus).toBe("complete");
      }
    }
    const ends = harness.events
      .map((envelope) => envelope.event)
      .filter((event) => event.type === "message_end");
    expect(ends).toHaveLength(1);
    expect(ends[0].type === "message_end" && ends[0].message.status).toBe("complete");
    expect(ends[0].type === "message_end" && ends[0].message.thinkingStatus).toBe("complete");
    await harness.dispose?.();
  });

  it("survives the wire: slimmed frames replay to a completed phase", async () => {
    const harness = createHarness();
    const wire: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((envelope) => wire.push(envelope), {
      intervalMs: 0,
    });
    // Every emitted frame crosses the coalescer, exactly as the production
    // path slims append-only frames before the renderer.
    await sendFlushed(harness, { type: "message_start", message: assistantContent([]) });
    const drive = async (event: unknown) => {
      await sendFlushed(harness, event);
    };
    await drive({
      type: "message_update",
      message: assistantContent([thinkingBlock("")]),
      assistantMessageEvent: frame("thinking_start", 0),
    });
    await drive({
      type: "message_update",
      message: assistantContent([thinkingBlock("plan")]),
      assistantMessageEvent: frame("thinking_delta", 0, { delta: "plan" }),
    });
    await drive({
      type: "message_update",
      message: assistantContent([thinkingBlock("plan")]),
      assistantMessageEvent: frame("thinking_end", 0, { content: "plan" }),
    });
    for (const event of harness.events) coalescer.push(event);
    coalescer.flush();
    let row: UiMessage | undefined;
    for (const envelope of wire) {
      if (envelope.event.type === "message_start") row = envelope.event.message;
      if (envelope.event.type === "message_update") row = applyMessageUpdate(row, envelope.event);
    }
    expect(row?.thinkingStatus).toBe("complete");
    expect(row?.status).toBe("streaming");
    await harness.dispose?.();
  });

  it("ends thinking at the terminal boundary when thinking_end never arrives", async () => {
    const harness = createHarness();
    await harness.send({ type: "message_start", message: assistantContent([]) });
    await harness.send({
      type: "message_update",
      message: assistantContent([thinkingBlock("")]),
      assistantMessageEvent: frame("thinking_start", 0),
    });
    // The provider terminates the stream without thinking_end (known
    // responses-shared.js shape when no output_item.done reasoning arrives).
    await harness.send({
      type: "message_end",
      message: settledContent([thinkingBlock(""), textBlock("done")], "stop"),
    });
    const ends = harness.events
      .map((envelope) => envelope.event)
      .filter((event) => event.type === "message_end");
    expect(ends).toHaveLength(1);
    expect(ends[0].type === "message_end" && ends[0].message.thinkingStatus).toBe("complete");
    await harness.dispose?.();
  });

  it("ends thinking on an aborted terminal without inventing text", async () => {
    const harness = createHarness();
    await harness.send({ type: "message_start", message: assistantContent([]) });
    await harness.send({
      type: "message_update",
      message: assistantContent([thinkingBlock("half")]),
      assistantMessageEvent: frame("thinking_delta", 0, { delta: "half" }),
    });
    await harness.send({
      type: "message_end",
      message: settledContent([thinkingBlock("half")], "aborted"),
    });
    const ends = harness.events
      .map((envelope) => envelope.event)
      .filter((event) => event.type === "message_end");
    expect(ends).toHaveLength(1);
    if (ends[0].type !== "message_end") throw new Error("expected message_end");
    expect(ends[0].message.status).toBe("aborted");
    expect(ends[0].message.thinkingStatus).toBe("complete");
    await harness.dispose?.();
  });
   it("completes thinking when tool generation starts without thinking_end, ahead of tool_prepare", async () => {
     const harness = createHarness();
     const toolCall = { type: "toolCall", id: "call-1", name: "Read", arguments: {} };
     await sendFlushed(harness, { type: "message_start", message: assistantContent([]) });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("")]),
       assistantMessageEvent: frame("thinking_start", 0, {
         partial: { role: "assistant", content: [thinkingBlock("")] },
       }),
     });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("plan")]),
       assistantMessageEvent: frame("thinking_delta", 0, {
         delta: "plan",
         partial: { role: "assistant", content: [thinkingBlock("plan")] },
       }),
     });
     // Responses can start writing tool arguments before reasoning
     // output_item.done arrives: no thinking_end ever comes for block 0, and
     // the message itself stays streaming.
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("plan"), toolCall]),
       assistantMessageEvent: frame("toolcall_start", 1, {
         partial: { role: "assistant", content: [thinkingBlock("plan"), toolCall] },
       }),
     });
     const events = harness.events.map((envelope) => envelope.event);
     const prepareIndex = events.findIndex((event) => event.type === "tool_prepare");
     expect(prepareIndex).toBeGreaterThan(-1);
     const completeIndex = events.findIndex(
       (event) => event.type === "message_update" && event.message.thinkingStatus === "complete",
     );
     expect(completeIndex).toBeGreaterThan(-1);
     // The dot stops before the tool row appears, while the message streams.
     expect(completeIndex).toBeLessThan(prepareIndex);
     const complete = events[completeIndex];
     expect(complete.type === "message_update" && complete.message.status).toBe("streaming");
     // The same prefix replays through the production coalescer to a still row.
     const wire: AgentEventEnvelope[] = [];
     const coalescer = createStreamCoalescer((envelope) => wire.push(envelope), {
       intervalMs: 0,
     });
     for (const envelope of harness.events) coalescer.push(envelope);
     coalescer.flush();
     const wireComplete = wire.findIndex(
       (envelope) =>
         envelope.event.type === "message_update" &&
         envelope.event.message.thinkingStatus === "complete",
     );
     const wirePrepare = wire.findIndex((envelope) => envelope.event.type === "tool_prepare");
     expect(wireComplete).toBeGreaterThan(-1);
     expect(wireComplete).toBeLessThan(wirePrepare);
     let row: UiMessage | undefined;
     for (const envelope of wire) {
       if (envelope.event.type === "message_start") row = envelope.event.message;
       if (envelope.event.type === "message_update") row = applyMessageUpdate(row, envelope.event);
     }
     expect(row?.thinkingStatus).toBe("complete");
     expect(row?.status).toBe("streaming");
     await harness.dispose?.();
   });

   it("completes thinking when reply text starts without thinking_end", async () => {
     const harness = createHarness();
     await sendFlushed(harness, { type: "message_start", message: assistantContent([]) });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("")]),
       assistantMessageEvent: frame("thinking_start", 0),
     });
     // The model moves on to reply text with no thinking_end in between.
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("plan"), textBlock("hi")]),
       assistantMessageEvent: frame("text_start", 1),
     });
     const updates = updatesOf(harness.events);
     const texted = updates.find((update) => (update.deltaText ?? "") !== "");
     expect(texted?.message.thinkingStatus).toBe("complete");
     expect(texted?.message.status).toBe("streaming");
     await harness.dispose?.();
   });

   it("a late end for an older block never closes newer thinking", async () => {
     const harness = createHarness();
     const toolCall = { type: "toolCall", id: "call-1", name: "Read", arguments: {} };
     await sendFlushed(harness, { type: "message_start", message: assistantContent([]) });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("")]),
       assistantMessageEvent: frame("thinking_start", 0),
     });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("plan"), toolCall]),
       assistantMessageEvent: frame("toolcall_start", 1, {
         partial: { role: "assistant", content: [thinkingBlock("plan"), toolCall] },
       }),
     });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("plan"), toolCall]),
       assistantMessageEvent: frame("thinking_start", 2),
     });
     const settled = harness.events.length;
     // The late authoritative end for block 0 is stale: no frame may move it.
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("plan"), toolCall]),
       assistantMessageEvent: frame("thinking_end", 0, { content: "plan" }),
     });
     expect(harness.events.length).toBe(settled);
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("planmore"), toolCall]),
       assistantMessageEvent: frame("thinking_end", 2, { content: "planmore" }),
     });
     const updates = updatesOf(harness.events);
     expect(updates.at(-1)?.message.thinkingStatus).toBe("complete");
     await harness.dispose?.();
   });

   it("a real thinking frame after tool activity breathes again", async () => {
     const harness = createHarness();
     const toolCall = { type: "toolCall", id: "call-1", name: "Read", arguments: {} };
     await sendFlushed(harness, { type: "message_start", message: assistantContent([]) });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("")]),
       assistantMessageEvent: frame("thinking_start", 0),
     });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("plan")]),
       assistantMessageEvent: frame("thinking_delta", 0, { delta: "plan" }),
     });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("plan"), toolCall]),
       assistantMessageEvent: frame("toolcall_start", 1, {
         partial: { role: "assistant", content: [thinkingBlock("plan"), toolCall] },
       }),
     });
     // Thinking resumes in a later block of the same bubble.
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("planmore"), toolCall]),
       assistantMessageEvent: frame("thinking_delta", 2, { delta: "more" }),
     });
     const events = harness.events.map((envelope) => envelope.event);
     const completeIndex = events.findIndex(
       (event) => event.type === "message_update" && event.message.thinkingStatus === "complete",
     );
     expect(completeIndex).toBeGreaterThan(-1);
     const reopenedIndex = events.findIndex(
       (event, index) =>
         index > completeIndex &&
         event.type === "message_update" &&
         event.message.thinkingStatus === "streaming",
     );
     expect(reopenedIndex).toBeGreaterThan(-1);
     const reopened = events[reopenedIndex];
     expect(reopened.type === "message_update" && reopened.deltaThinking).toBe("more");
     await harness.dispose?.();
   });

   it("keeps thinking-complete ahead of tool_prepare when frames batch in the coalescer", async () => {
     const harness = createHarness();
     const toolCall = { type: "toolCall", id: "call-1", name: "Read", arguments: {} };
     await sendFlushed(harness, { type: "message_start", message: assistantContent([]) });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("")]),
       assistantMessageEvent: frame("thinking_start", 0),
     });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("plan")]),
       assistantMessageEvent: frame("thinking_delta", 0, { delta: "plan" }),
     });
     await sendFlushed(harness, {
       type: "message_update",
       message: assistantContent([thinkingBlock("plan"), toolCall]),
       assistantMessageEvent: frame("toolcall_start", 1, {
         partial: { role: "assistant", content: [thinkingBlock("plan"), toolCall] },
       }),
     });
     const wire: AgentEventEnvelope[] = [];
     // A schedule that never fires on its own: delta frames park until the
     // semantic tool_prepare flushes them, like the production 16ms window.
     const coalescer = createStreamCoalescer((envelope) => wire.push(envelope), {
       intervalMs: 60_000,
       schedule: () => () => {},
     });
     for (const envelope of harness.events) coalescer.push(envelope);
     const prepareIndex = wire.findIndex((envelope) => envelope.event.type === "tool_prepare");
     const completeIndex = wire.findIndex(
       (envelope) =>
         envelope.event.type === "message_update" &&
         envelope.event.message.thinkingStatus === "complete",
     );
     expect(prepareIndex).toBeGreaterThan(-1);
     expect(completeIndex).toBeGreaterThan(-1);
     expect(completeIndex).toBeLessThan(prepareIndex);
     coalescer.dispose();
     await harness.dispose?.();
   });

  it("keeps the phase complete when a typed tool frame also grows thinking", async () => {
    const harness = createHarness();
    const toolCall = { type: "toolCall", id: "call-1", name: "Read", arguments: {} };
    const grown = [thinkingBlock("planmore"), toolCall];
    await sendFlushed(harness, { type: "message_start", message: assistantContent([]) });
    await sendFlushed(harness, {
      type: "message_update",
      message: assistantContent([thinkingBlock("")]),
      assistantMessageEvent: frame("thinking_start", 0, {
        partial: { role: "assistant", content: [thinkingBlock("")] },
      }),
    });
    await sendFlushed(harness, {
      type: "message_update",
      message: assistantContent([thinkingBlock("plan")]),
      assistantMessageEvent: frame("thinking_delta", 0, {
        delta: "plan",
        partial: { role: "assistant", content: [thinkingBlock("plan")] },
      }),
    });
    // Production shape: the provider moves to tool arguments while the
    // reasoning text still reads "plan". This typed tool frame is what ends
    // the thinking lane, so the phase completes here.
    await sendFlushed(harness, {
      type: "message_update",
      message: assistantContent([thinkingBlock("plan"), toolCall]),
      assistantMessageEvent: frame("toolcall_start", 1, {
        partial: {
          role: "assistant",
          content: [thinkingBlock("plan"), toolCall],
        },
      }),
    });
    // The next tool frame also rewrites the visible reasoning block, growing
    // it to "planmore". The typed frame is toolcall_delta, so the growth must
    // not reopen the phase.
    await sendFlushed(harness, {
      type: "message_update",
      message: assistantContent(grown),
      assistantMessageEvent: frame("toolcall_delta", 1, {
        delta: '{"path":"a"}',
        partial: { role: "assistant", content: grown },
      }),
    });
    const updates = updatesOf(harness.events);
    const completeIndex = updates.findIndex(
      (update) => update.message.thinkingStatus === "complete",
    );
    expect(completeIndex).toBeGreaterThan(-1);
    // The regression needs the tool frame that really carried new thinking
    // text ("more" after "plan"), not the earlier thinking delta itself.
    const grownFrames = updates
      .map((update, index) => ({ update, index }))
      .filter(({ update }) => update.deltaThinking === "more");
    expect(grownFrames.length).toBeGreaterThan(0);
    expect(grownFrames[0]?.index).toBeGreaterThan(completeIndex);
    expect(grownFrames[0]?.update.message.thinkingStatus).toBe("complete");
    // No frame at or after completion reopens the phase.
    for (const update of updates.slice(completeIndex)) {
      if (update.message.thinkingStatus !== undefined) {
        expect(update.message.thinkingStatus).toBe("complete");
      }
    }
    await harness.dispose?.();
  });

  it("treats a real thinking delta without a provider frame as streaming", async () => {
    const harness = createHarness();
    await sendFlushed(harness, { type: "message_start", message: assistantContent([]) });
    // Compatibility gate: older or synthetic streams carry the cumulative
    // thinking text with no `assistantMessageEvent` at all.
    await sendFlushed(harness, {
      type: "message_update",
      message: assistantContent([thinkingBlock("thought")]),
    });
    const update = updatesOf(harness.events).at(-1);
    expect(update?.deltaThinking).toBe("thought");
    expect(update?.message.thinkingStatus).toBe("streaming");
    expect(update?.message.status).toBe("streaming");
    await harness.dispose?.();
  });
});

/**
 * One provider attempt can end without a settled message: a silent re-run,
 * a progress-only re-run, overflow recovery, a provider retry, or a run that
 * dies before `message_end`. Every one of those boundaries must stop the
 * thinking lane on the bubble it keeps visible, and the next attempt may
 * reopen it only through a real thinking frame. Every row below drives a
 * production entry point and stubs only the provider boundary.
 */
describe("thinking attempt teardown", () => {
  type Send = (event: unknown) => Promise<void>;

  function attemptHarness() {
    const { runtime, events, handleAgentEvent } = createSessionHarness();
    const streamSink = (
      runtime as unknown as { streamSink: { flush: () => void } }
    ).streamSink;
    const internal = runtime as unknown as {
      agent: {
        prompt: (...args: unknown[]) => Promise<void>;
        continue: () => Promise<void>;
        waitForIdle: () => Promise<void>;
        state: { messages: unknown[] };
      };
    };
    internal.agent.waitForIdle = vi.fn(async () => undefined);
    const send: Send = async (event) => {
      await handleAgentEvent(event);
      streamSink.flush();
    };
    return { runtime, events, agent: internal.agent, send };
  }

  /** The real provider frame order for one attempt that starts by thinking. */
  async function streamAttempt(send: Send, thinking = "plan") {
    await send({ type: "agent_start" });
    await send({ type: "turn_start" });
    await send({ type: "message_start", message: assistantContent([]) });
    await send({
      type: "message_update",
      message: assistantContent([thinkingBlock("")]),
      assistantMessageEvent: frame("thinking_start", 0),
    });
    await send({
      type: "message_update",
      message: assistantContent([thinkingBlock(thinking)]),
      assistantMessageEvent: frame("thinking_delta", 0, { delta: thinking }),
    });
  }

  const planExecution: PlanExecution = {
    id: "execution-1",
    proposalId: "proposal-1",
    sessionId: "session-1",
    kind: "plan",
    plan: "# Approved\n\nDo the work.",
    title: "Approved plan",
    question: "Proceed?",
    artifact: {
      relativePath: ".pi/plan/proposal-1.md",
      sha256: "abc123",
      sizeBytes: 24,
    },
    targetPermissionMode: "auto",
    state: "running",
  };

  type BubbleEvent = Extract<
    AgentEvent,
    { type: "message_start" } | { type: "message_update" } | { type: "message_end" }
  >;

  function bubbleEvents(events: AgentEventEnvelope[]): BubbleEvent[] {
    return events
      .map((envelope) => envelope.event)
      .filter(
        (event): event is BubbleEvent =>
          event.type === "message_start" ||
          event.type === "message_update" ||
          event.type === "message_end",
      );
  }

  /**
   * `rerun` rows keep one bubble open across the boundary: the first attempt's
   * phase completes while the message still streams, the next attempt starts
   * on that completed phase, and only a real thinking frame reopens it.
   * `terminal` rows settle the bubble with the phase complete.
   */
  function expectAttemptTeardown(events: AgentEventEnvelope[], mode: "rerun" | "terminal") {
    const bubbles = bubbleEvents(events);
    const bubbleId = bubbles[0]?.message.id;
    expect(bubbleId).toBeDefined();
    const streamingIndex = bubbles.findIndex(
      (event) => event.type === "message_update" && event.message.thinkingStatus === "streaming",
    );
    expect(streamingIndex).toBeGreaterThan(-1);
    if (mode === "terminal") {
      const terminalIndex = bubbles.findIndex(
        (event) =>
          event.type === "message_end" &&
          event.message.thinkingStatus === "complete" &&
          (event.message.status === "error" || event.message.status === "aborted"),
      );
      expect(terminalIndex).toBeGreaterThan(-1);
      const later = bubbles.slice(terminalIndex + 1);
      expect(
        later.some(
          (event) =>
            event.type === "message_update" && event.message.thinkingStatus === "streaming",
        ),
      ).toBe(false);
      return;
    }
    const completeIndex = bubbles.findIndex(
      (event, index) =>
        index > streamingIndex &&
        event.type === "message_update" &&
        event.message.thinkingStatus === "complete",
    );
    expect(completeIndex).toBeGreaterThan(-1);
    const complete = bubbles[completeIndex];
    expect(complete?.type).toBe("message_update");
    expect(complete?.message.status).toBe("streaming");
    // The next attempt reuses this bubble on the carried completed phase.
    const nextAttempt = bubbles
      .slice(completeIndex + 1)
      .find((event) => event.type !== "message_end");
    expect(nextAttempt?.message.id).toBe(bubbleId);
    expect(nextAttempt?.message.thinkingStatus).toBe("complete");
    // Only a real thinking frame in the new attempt reopens the phase.
    const reopened = bubbles.findIndex(
      (event, index) =>
        index > completeIndex &&
        event.type === "message_update" &&
        event.message.thinkingStatus === "streaming",
    );
    expect(reopened).toBeGreaterThan(completeIndex);
  }

  const cases: {
    name: string;
    mode: "rerun" | "terminal";
    run: (ctx: ReturnType<typeof attemptHarness>) => Promise<void>;
  }[] = [
    {
      name: "silent re-run stops thinking on the kept bubble and reopens on a real frame",
      mode: "rerun",
      run: async ({ runtime, agent, send }) => {
        const silent = settledContent([thinkingBlock("plan")], "stop");
        let attempts = 0;
        agent.continue = vi.fn(async () => {
          attempts += 1;
          if (attempts === 2) {
            // The production re-run loop raised this before it continued.
            expect(
              (runtime as unknown as { silentTurnRerunInProgress: boolean })
                .silentTurnRerunInProgress,
            ).toBe(true);
          }
          agent.state.messages = [
            { role: "user", content: "execute the approved plan", timestamp: 1 },
            ...(attempts === 1 ? [silent] : []),
          ];
          await streamAttempt(send, "plan");
          if (attempts === 1) {
            await send({ type: "message_end", message: silent });
            return;
          }
          await send({
            type: "message_end",
            message: settledContent(
              [thinkingBlock("plan"), textBlock("recovered answer")],
              "stop",
            ),
          });
          await send({ type: "turn_end" });
          await send({ type: "agent_end", messages: [] });
        });
        await runtime.executeApprovedPlan(planExecution, "turn-silent");
        expect(agent.continue).toHaveBeenCalledTimes(2);
      },
    },
    {
      name: "progress-only re-run stops thinking on the kept bubble and reopens on a real frame",
      mode: "rerun",
      run: async ({ runtime, agent, send }) => {
        const progress = settledContent(
          [thinkingBlock("plan"), textBlock("Staged YAML complete. Writing Owner Note now.")],
          "stop",
        );
        let attempts = 0;
        agent.continue = vi.fn(async () => {
          attempts += 1;
          if (attempts === 2) {
            // The production re-run loop raised this before it continued.
            expect(
              (runtime as unknown as { progressTurnRerunInProgress: boolean })
                .progressTurnRerunInProgress,
            ).toBe(true);
          }
          agent.state.messages = [
            { role: "user", content: "execute the approved plan", timestamp: 1 },
            ...(attempts === 1 ? [progress] : []),
          ];
          await streamAttempt(send, "plan");
          if (attempts === 1) {
            await send({ type: "message_end", message: progress });
            return;
          }
          await send({
            type: "message_end",
            message: settledContent(
              [thinkingBlock("plan"), textBlock("Implemented the approved plan.")],
              "stop",
            ),
          });
          await send({ type: "turn_end" });
          await send({ type: "agent_end", messages: [] });
        });
        await runtime.executeApprovedPlan(planExecution, "turn-progress");
        expect(agent.continue).toHaveBeenCalledTimes(2);
      },
    },
    {
      name: "overflow recovery stops thinking before compaction and reopens on a real frame",
      mode: "rerun",
      run: async ({ runtime, agent, send }) => {
        const overflow = {
          ...settledContent([thinkingBlock("plan")], "error"),
          errorMessage:
            "400: prompt is too long: 1077172 tokens > 1000000 maximum (Service: BedrockRuntime)",
        };
        agent.prompt = vi.fn(async () => {
          agent.state.messages = [
            { role: "user", content: "hello", timestamp: 1 },
            overflow,
          ];
          await streamAttempt(send, "plan");
          await send({ type: "message_end", message: overflow });
          await send({ type: "turn_end" });
          await send({ type: "agent_end", messages: [] });
        });
        (runtime as unknown as { runCompaction: unknown }).runCompaction = vi.fn(
          async () => true,
        );
        agent.continue = vi.fn(async () => {
          expect(
            (runtime as unknown as { overflowRecoveryInProgress: boolean })
              .overflowRecoveryInProgress,
          ).toBe(true);
          agent.state.messages = [{ role: "user", content: "hello", timestamp: 1 }];
          await streamAttempt(send, "recovered");
          await send({
            type: "message_end",
            message: settledContent(
              [thinkingBlock("recovered"), textBlock("recovered response")],
              "stop",
            ),
          });
          await send({ type: "turn_end" });
          await send({ type: "agent_end", messages: [] });
        });
        await runtime.prompt("hello", "user-1");
        expect(agent.continue).toHaveBeenCalledOnce();
      },
    },
    {
      name: "provider retry stops thinking before the delay and reopens on a real frame",
      mode: "rerun",
      run: async ({ runtime, agent, send }) => {
        const failed = {
          ...settledContent([thinkingBlock("plan")], "error"),
          errorMessage: "upstream unavailable",
        };
        (runtime as unknown as { providerResponseStatus?: number }).providerResponseStatus = 429;
        agent.prompt = vi.fn(async () => {
          agent.state.messages = [
            { role: "user", content: "hello", timestamp: 1 },
            failed,
          ];
          await streamAttempt(send, "plan");
          await send({ type: "message_end", message: failed });
          await send({ type: "turn_end" });
          await send({ type: "agent_end", messages: [] });
        });
        agent.continue = vi.fn(async () => {
          expect(
            (runtime as unknown as { providerRetryInProgress: boolean })
              .providerRetryInProgress,
          ).toBe(true);
          agent.state.messages = [{ role: "user", content: "hello", timestamp: 1 }];
          await streamAttempt(send, "plan");
          await send({
            type: "message_end",
            message: settledContent(
              [thinkingBlock("plan"), textBlock("recovered response")],
              "stop",
            ),
          });
          await send({ type: "turn_end" });
          await send({ type: "agent_end", messages: [] });
        });
        vi.useFakeTimers();
        try {
          const prompt = runtime.prompt("hello", "user-1");
          await vi.runAllTimersAsync();
          await prompt;
        } finally {
          vi.useRealTimers();
        }
        expect(agent.continue).toHaveBeenCalledOnce();
      },
    },
    {
      name: "a prompt that dies before message_end finalizes the phase on the error bubble",
      mode: "terminal",
      run: async ({ runtime, agent, send }) => {
        agent.prompt = vi.fn(async () => {
          await streamAttempt(send);
          throw Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          });
        });
        await expect(runtime.prompt("hello", "user-1")).rejects.toThrow();
      },
    },
    {
      name: "a prompt aborted before message_end finalizes the phase as aborted",
      mode: "terminal",
      run: async ({ runtime, agent, send }) => {
        agent.prompt = vi.fn(async () => {
          await streamAttempt(send);
          throw Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
          });
        });
        await expect(runtime.prompt("hello", "user-1")).rejects.toMatchObject({
          name: "AbortError",
        });
      },
    },
  ];

  it.each(cases)("$name", async ({ mode, run }) => {
    const ctx = attemptHarness();
    try {
      await run(ctx);
      expectAttemptTeardown(ctx.events, mode);
    } finally {
      await ctx.runtime.dispose();
    }
  });

  it("subagent provider retry stops thinking but keeps the bubble, then reopens it", () => {
    const { run, events, handleEvent } = createDelegateHarness();
    (run as unknown as { retryState: { status: number | undefined } }).retryState.status = 429;
    handleEvent({ type: "message_start", message: assistantContent([]) });
    const first = events[0]?.event;
    if (first?.type !== "message_start") throw new Error("expected message_start");
    const bubbleId = first.message.id;
    handleEvent({
      type: "message_update",
      message: assistantContent([thinkingBlock("")]),
      assistantMessageEvent: frame("thinking_start", 0),
    });
    handleEvent({
      type: "message_update",
      message: assistantContent([thinkingBlock("half")]),
      assistantMessageEvent: frame("thinking_delta", 0, { delta: "half" }),
    });
    // The provider attempt fails while thinking still generates: the retry
    // holds the same bubble open instead of settling it.
    handleEvent({
      type: "message_end",
      message: {
        ...settledContent([thinkingBlock("half")], "error"),
        errorMessage: "429: upstream unavailable",
      },
    });
    const retried = updatesOf(events).at(-1);
    expect(retried?.message.thinkingStatus).toBe("complete");
    expect(retried?.message.status).toBe("streaming");
    // The retry loop keeps this flag set while it continues the same bubble.
    (run as unknown as { providerRetryInProgress: boolean }).providerRetryInProgress = true;
    handleEvent({ type: "message_start", message: assistantContent([]) });
    const resumed = events.at(-1)?.event;
    if (resumed?.type !== "message_update") throw new Error("expected retry update");
    expect(resumed.message.id).toBe(bubbleId);
    expect(resumed.message.thinkingStatus).toBe("complete");
    // A real thinking frame reopens the phase on the next attempt.
    handleEvent({
      type: "message_update",
      message: assistantContent([thinkingBlock("")]),
      assistantMessageEvent: frame("thinking_start", 0),
    });
    expect(updatesOf(events).at(-1)?.message.thinkingStatus).toBe("streaming");
  });
});

 /**
  * The checked-in generation-phase wire trace is produced by the session
  * harness above — production runtime events through the production stream
  * coalescer — never hand-written. The thinking-row Electron fixture replays
  * exactly this file, so drift fails here instead of passing against a stale
  * trace. Refresh with `PI_UPDATE_FIXTURES=1`.
  */
 describe("thinking generation wire fixture", () => {
   const fixtureUrl = new URL(
     "../../../scripts/e2e/fixtures/thinking-generation-phase.json",
     import.meta.url,
   );

   function normalizeTrace(value: unknown): unknown {
     if (Array.isArray(value)) return value.map(normalizeTrace);
     if (value !== null && typeof value === "object") {
       const out: Record<string, unknown> = {};
       for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
         if (key === "createdAt") {
           out[key] = "2026-11-21T00:00:00.000Z";
         } else if (
           key === "modelStreamDurationMs" ||
           key === "providerWaitMs" ||
           key === "responseDurationMs" ||
           key === "responseOutputTokens"
         ) {
           continue;
         } else if (
           key === "throughput" &&
           entry !== null &&
           typeof entry === "object" &&
           !Array.isArray(entry)
         ) {
           // The sampler's span is wall-clock volatile like the dropped timing
           // keys above; the settled commit itself (exact provider tokens and
           // one sample) is the stable wire fact this trace pins.
           const { tokens, samples } = entry as Record<string, unknown>;
           out[key] = { tokens, samples };
         } else if (key === "id" && typeof entry === "string" && entry !== "call-1") {
           out[key] = "assistant-bubble";
         } else {
           out[key] = normalizeTrace(entry);
         }
       }
       return out;
     }
     return value;
   }

   it("matches the checked-in runtime-generated trace", async () => {
     const { runtime, events, handleAgentEvent } = createSessionHarness();
     const streamSink = (
       runtime as unknown as { streamSink: { flush: () => void } }
     ).streamSink;
     const send = async (event: unknown) => {
       await handleAgentEvent(event);
       streamSink.flush();
     };
     const toolCall = { type: "toolCall", id: "call-1", name: "Read", arguments: {} };
     await send({ type: "message_start", message: assistantContent([]) });
     await send({
       type: "message_update",
       message: assistantContent([thinkingBlock("")]),
       assistantMessageEvent: frame("thinking_start", 0),
     });
     await send({
       type: "message_update",
       message: assistantContent([thinkingBlock("plan")]),
       assistantMessageEvent: frame("thinking_delta", 0, { delta: "plan" }),
     });
     // No thinking_end: the responses-shaped stream moves straight to tool
     // arguments while the message still streams.
     await send({
       type: "message_update",
       message: assistantContent([thinkingBlock("plan"), toolCall]),
       assistantMessageEvent: frame("toolcall_start", 1, {
         partial: { role: "assistant", content: [thinkingBlock("plan"), toolCall] },
       }),
     });
     await send({
       type: "message_update",
       message: assistantContent([thinkingBlock("plan"), toolCall]),
       assistantMessageEvent: frame("toolcall_delta", 1, { delta: "{}" }),
     });
    // Production shape: the end frame carries the whole partial, so argument
    // preparation can report the call as ready.
    await send({
      type: "message_update",
      message: assistantContent([thinkingBlock("plan"), toolCall]),
      assistantMessageEvent: frame("toolcall_end", 1, {
        toolCall,
        partial: { role: "assistant", content: [thinkingBlock("plan"), toolCall] },
      }),
    });
    await send({
      type: "message_end",
      message: settledContent([thinkingBlock("plan"), textBlock("done")], "stop"),
    });
    await runtime.dispose();
    const trace = normalizeTrace(events.map((envelope) => envelope.event));
    if (process.env.PI_UPDATE_FIXTURES === "1") {
      await writeFile(fixtureUrl, `${JSON.stringify(trace, null, 2)}\n`);
    }
    const recorded = JSON.parse(await readFile(fixtureUrl, "utf8"));
    expect(trace).toEqual(recorded);
    // The committed contract, independent of the snapshot bytes: the phase
    // completes on tool generation while the message streams, ahead of every
    // tool_prepare — including the ready one that ends argument preparation.
    const sequence = events.map((envelope) => envelope.event);
    const completeIndex = sequence.findIndex(
      (event) => event.type === "message_update" && event.message.thinkingStatus === "complete",
    );
    const prepareIndex = sequence.findIndex((event) => event.type === "tool_prepare");
    const readyPrepareIndex = sequence.findIndex(
      (event) => event.type === "tool_prepare" && event.ready === true,
    );
    expect(completeIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(readyPrepareIndex).toBeGreaterThan(-1);
    expect(completeIndex).toBeLessThan(prepareIndex);
    expect(completeIndex).toBeLessThan(readyPrepareIndex);
 });
});
