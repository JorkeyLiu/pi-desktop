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
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
  applyMessageUpdate,
  type AgentEvent,
  type AgentEventEnvelope,
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
});
