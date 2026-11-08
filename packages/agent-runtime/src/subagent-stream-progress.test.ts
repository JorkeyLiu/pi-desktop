/**
 * Mid-stream occupancy: a delegate's `context-tokens` wake must observe a long
 * single streamed response before that response's `message_end`.
 *
 * pi-agent-core keeps the in-flight assistant row in `state.streamingMessage`
 * and pushes it into `state.messages` only at `message_end`, so an estimate
 * built from `messages` alone hides a whole response's growth until the stream
 * closes. These tests pin the three halves of the fix: the estimate covers the
 * live row without charging a committed row twice or reading that row's
 * in-flight usage as a baseline, the router re-evaluates the waiters on growth
 * inside one response — never per token, and with no timer involved (the wait
 * here has no deadline at all) — and growth that the transcript row does not
 * show, such as streamed tool-call arguments, still reaches the gate.
 */
import { describe, expect, it } from "vitest";
import type {
  AgentEventEnvelope,
  SubagentDefinition,
  UiMessage,
} from "@pi-desktop/shared";
import { applyMessageUpdate, normalizeSubagentWakeupSettings } from "@pi-desktop/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SubagentRun, type SubagentRunOptions } from "./subagent.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import type { DelegationRecord } from "./runtime.js";
import {
  applyDelegationActivity,
  routeDelegationEvent,
  type DelegationActivityEffects,
} from "./subagent-control.js";
import { STREAM_PROGRESS_EVALUATION_CHARS } from "./subagent-progress.js";
import { createStreamCoalescer } from "./stream-coalescer.js";
import { ESTIMATED_TEXT_CHARS_PER_TOKEN } from "./pi-runtime-estimates.js";
import {
  createSubagentWakeState,
  createWakeWaiterRegistry,
  waitForWakeTargets,
  type WakeWaitOutcome,
} from "./subagent-wakeup.js";

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

/** The configured crossing the delegate has to reach mid-stream. */
const CONTEXT_THRESHOLD_TOKENS = 1_000;
/** One frame of streamed growth, as the router and the run both quantize it. */
const QUANTUM = STREAM_PROGRESS_EVALUATION_CHARS;

function definition(): SubagentDefinition {
  return {
    name: "explorer",
    description: "Search the workspace and report findings.",
    tools: ["Read"],
    prompt: "Find the answer and report it.",
    source: "builtin",
  };
}

/** Text of `chars` characters: the body of one long streamed response. */
function filler(chars: number, unit = "streamed response detail. "): string {
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

function systemMessage(content: string): AgentMessage {
  return { role: "system", content, timestamp: 1 } as AgentMessage;
}

function userMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: 2 } as AgentMessage;
}

/** pi's `Usage`, as reported by the adapters. */
function piUsage(totalTokens: number) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A committed assistant row whose provider usage anchors the estimate. */
function settledAssistant(
  tokens: number,
  timestamp = 3,
  text = "done",
): AgentMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "local",
    model: "local-model",
    stopReason: "stop",
    timestamp,
    content: [{ type: "text", text }],
    usage: piUsage(tokens),
  } as unknown as AgentMessage;
}

/** The partial assistant row pi keeps in `state.streamingMessage`. */
function streamingRow(
  text: string,
  overrides: Record<string, unknown> = {},
): AgentMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "local",
    model: "local-model",
    stopReason: "stop",
    timestamp: 4,
    content: [{ type: "text", text }],
    ...overrides,
  } as unknown as AgentMessage;
}

/** The partial row while pi is writing one tool call's arguments. */
function streamingToolCallRow(): AgentMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "local",
    model: "local-model",
    stopReason: "pending",
    timestamp: 4,
    content: [{ type: "toolCall", id: "call-1", name: "write_file", arguments: {} }],
  } as unknown as AgentMessage;
}

function createRun(overrides: Partial<SubagentRunOptions> = {}) {
  const run = new SubagentRun({
    definition: definition(),
    sessionId: "session-1",
    turnId: "turn-1",
    parentToolCallId: "task-1",
    task: "Find where the permission dialog is rendered.",
    provider,
    thinkingLevel: "off",
    systemPrompt: "system",
    tools: [],
    onEvent: () => {},
    ...overrides,
  });
  return run as unknown as Record<string, any>;
}

/** A running delegation record holding the live loop handle. */
function recordFor(run: unknown): DelegationRecord {
  return {
    delegationId: "del-1",
    status: "running",
    turns: 0,
    toolCalls: 0,
    lastActivityAt: 0,
    wake: createSubagentWakeState(0),
    run,
  } as unknown as DelegationRecord;
}

/** One delegation as the wait snapshot reads it. */
function wakeTarget(record: DelegationRecord) {
  return {
    delegationId: record.delegationId,
    status: record.status,
    toolCalls: record.toolCalls,
    ...(record.contextTokens !== undefined
      ? { contextTokens: record.contextTokens }
      : {}),
  };
}

function envelope(event: AgentEventEnvelope["event"]): AgentEventEnvelope {
  return { sessionId: "session-1", turnId: "turn-1", ts: 1, event };
}

/** The narrow record the router mutates while it gates the stream. */
function streamRecord() {
  return { lastActivityAt: 0, turns: 0, toolCalls: 0 } as {
    lastActivityAt: number;
    turns: number;
    toolCalls: number;
    run?: { streamedChars?: () => number };
    streamedProgressChars?: number;
  };
}

function assistantRow(
  content: string,
  overrides: Partial<UiMessage> = {},
): UiMessage {
  return {
    id: "row-1",
    role: "assistant",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "streaming",
    ...overrides,
  };
}

function countingEffects() {
  const calls = { refreshProgress: 0, notifyWaiters: 0, publishProgress: 0 };
  const effects: DelegationActivityEffects = {
    touchActivity: () => {},
    touchPhase: () => {},
    trackToolCall: () => {},
    appendAssistant: () => {},
    appendToolResult: () => {},
    mergeUsage: () => {},
    refreshProgress: () => {
      calls.refreshProgress += 1;
    },
    publishProgress: () => {
      calls.publishProgress += 1;
    },
    notifyWaiters: () => {
      calls.notifyWaiters += 1;
    },
  };
  return { calls, effects };
}

describe("live occupancy estimate", () => {
  it("counts the row pi has not committed yet, without charging it twice", () => {
    const run = createRun();
    const text = filler(8_000);
    run.agent.state.messages = [
      systemMessage("system"),
      userMessage("Find where the permission dialog is rendered."),
    ];
    // pi sets `streamingMessage` and only moves that row into `messages` at
    // `message_end`; while it streams, the estimate must already cover it.
    run.agent.state.streamingMessage = streamingRow(text);
    const streaming = run.progress().contextTokens as number;
    expect(streaming).toBeGreaterThan(CONTEXT_THRESHOLD_TOKENS);

    // The commit: same row, now in `messages`, no live row left.
    run.agent.state.messages = [
      ...run.agent.state.messages,
      run.agent.state.streamingMessage,
    ];
    run.agent.state.streamingMessage = undefined;
    const committed = run.progress().contextTokens as number;

    // One row, one charge: the two views never overlap.
    expect(committed).toBe(streaming);
  });

  it("charges the streamed body when the partial row already reports usage", () => {
    const run = createRun();
    // Anthropic reports input tokens at `message_start` and pi leaves
    // `stopReason: "pending"` on the in-flight row until the message stops, so
    // the partial row carries usage long before its body is complete. That
    // usage is not a completed baseline: reading it as one would freeze the
    // estimate at the tokens reported before the body arrived.
    const anchorTokens = 1_000;
    const partialUsageTokens = 9_000;
    run.agent.state.messages = [
      systemMessage("system"),
      userMessage("Find where the permission dialog is rendered."),
      settledAssistant(anchorTokens),
    ];
    expect(run.progress().contextTokens).toBe(anchorTokens);

    const streamedAt = (chars: number) => {
      run.agent.state.streamingMessage = streamingRow("s".repeat(chars), {
        stopReason: "pending",
        usage: piUsage(partialUsageTokens),
      });
      return run.progress().contextTokens as number;
    };
    const short = streamedAt(7_000);
    const long = streamedAt(14_000);

    // The committed usage stays the anchor and the body is charged on top of
    // it, so the estimate moves with the body instead of standing at the
    // partial usage.
    expect(short).toBeLessThan(partialUsageTokens);
    expect(long - short).toBe(
      Math.ceil(7_000 / ESTIMATED_TEXT_CHARS_PER_TOKEN),
    );

    // Committed usage semantics are untouched: once the row settles, its usage
    // is the anchor again and nothing is charged as trailing content.
    run.agent.state.messages = [
      ...run.agent.state.messages,
      settledAssistant(2_000, 5),
    ];
    run.agent.state.streamingMessage = undefined;
    expect(run.progress().contextTokens).toBe(2_000);
  });
});

describe("mid-stream context wake", () => {
  it("wakes a context-tokens wait inside one streamed response, before message_end", async () => {
    const registry = createWakeWaiterRegistry("session-1");
    let record: DelegationRecord;
    const run = createRun({
      onEvent: (event) => {
        applyDelegationActivity(
          {
            touchPhase: () => {},
            delegateToolCalls: new Map(),
            appendRow: () => {},
            toolRow: () => ({}) as UiMessage,
            publishProgress: () => {},
            notifyWaiters: () => registry.notify(),
          },
          record,
          event,
        );
      },
    });
    record = recordFor(run);
    run.agent.state.messages = [
      systemMessage("system"),
      userMessage("Find where the permission dialog is rendered."),
    ];

    const wait = waitForWakeTargets(
      () => [wakeTarget(record)],
      // The record-owned watermark, exactly as the coordinator shares it.
      new Map([[record.delegationId, record.wake]]),
      [],
      registry.register,
      {
        mode: "any",
        minCompleted: 1,
        wake: normalizeSubagentWakeupSettings({
          kind: "context-tokens",
          value: CONTEXT_THRESHOLD_TOKENS,
        }),
        // No deadline: nothing here may depend on a timer.
        deadline: null,
        deadlineKind: null,
      },
    );
    let outcome: WakeWaitOutcome | undefined;
    void wait.then((resolved) => {
      outcome = resolved;
    });
    // Registered and polling: an unchanged running delegate resolves nothing.
    await Promise.resolve();
    expect(outcome).toBeUndefined();

    // One streamed assistant response, driven the way pi drives its listeners:
    // state first, then the event.
    let text = "";
    run.agent.state.streamingMessage = streamingRow(text);
    run.handleEvent({ type: "message_start", message: streamingRow(text) });
    const chunkChars = 1_024;
    for (let index = 0; index < 8; index += 1) {
      text += filler(chunkChars);
      const row = streamingRow(text);
      run.agent.state.streamingMessage = row;
      run.handleEvent({ type: "message_update", message: row });
      await Promise.resolve();
      if (outcome) break;
    }

    // No `message_end` was ever delivered: the wake came from the stream.
    expect(run.agent.state.streamingMessage).toBeDefined();
    expect(outcome?.wakeReason).toBe("context-tokens");
    expect(outcome?.wakeDelegationIds).toEqual(["del-1"]);
    expect(outcome?.timedOut).toBe(false);
    expect(record.contextTokens).toBeGreaterThanOrEqual(CONTEXT_THRESHOLD_TOKENS);
    // The crossing disarmed the watermark: a re-check cannot fire twice.
    expect(record.wake.contextArmed).toBe(false);
  });

  it("re-evaluates on growth, not once per streamed delta", () => {
    const { calls, effects } = countingEffects();
    const record = streamRecord();
    const deltas = 200;
    const deltaChars = 40;
    let text = "";
    for (let index = 0; index < deltas; index += 1) {
      text += "x".repeat(deltaChars);
      routeDelegationEvent(
        record,
        envelope({
          type: "message_update",
          message: assistantRow(text),
          deltaText: "x".repeat(deltaChars),
        }),
        effects,
      );
    }
    const total = deltas * deltaChars;
    // Something re-read the stream, and the cadence is bounded by growth rather
    // than by the delta count: at most one re-read per quantum, never one per
    // delta.
    expect(calls.refreshProgress).toBeGreaterThan(0);
    expect(calls.refreshProgress).toBeLessThanOrEqual(
      Math.floor(total / QUANTUM) + 1,
    );
    expect(calls.refreshProgress).toBeLessThan(deltas);
    expect(calls.notifyWaiters).toBe(calls.refreshProgress);
    // No missed final crossing: the last re-read is within one quantum of the
    // end of the stream, so a threshold crossed near the end is still seen.
    expect(record.streamedProgressChars).toBeGreaterThan(total - QUANTUM);
    // A mid-stream read never publishes a Task snapshot: one per child turn.
    expect(calls.publishProgress).toBe(0);
  });

  it("re-baselines on the next message instead of inheriting the previous one", () => {
    const { calls, effects } = countingEffects();
    const record = streamRecord();
    // One long answer: the stream's watermark ends far above zero.
    let text = "";
    for (let index = 0; index < 10; index += 1) {
      text += "x".repeat(QUANTUM);
      routeDelegationEvent(
        record,
        envelope({
          type: "message_update",
          message: assistantRow(text),
          deltaText: "x".repeat(QUANTUM),
        }),
        effects,
      );
    }
    const afterAnswer = calls.refreshProgress;
    expect(afterAnswer).toBeGreaterThan(0);

    // The next message starts empty: the row shrank, so the gate re-reads once
    // and starts counting from the new message.
    routeDelegationEvent(
      record,
      envelope({ type: "message_start", message: assistantRow("") }),
      effects,
    );
    expect(calls.refreshProgress).toBe(afterAnswer + 1);
    const afterReset = calls.refreshProgress;

    // Under one quantum of the new message nothing is re-read …
    routeDelegationEvent(
      record,
      envelope({
        type: "message_update",
        message: assistantRow("y".repeat(QUANTUM - 1)),
        deltaText: "y".repeat(QUANTUM - 1),
      }),
      effects,
    );
    expect(calls.refreshProgress).toBe(afterReset);
    // … and one quantum of the new message is, because its baseline is its own.
    // A baseline inherited from the previous message would swallow this growth
    // and delay the crossing until the next `message_end`.
    routeDelegationEvent(
      record,
      envelope({
        type: "message_update",
        message: assistantRow("y".repeat(QUANTUM * 2)),
        deltaText: "y".repeat(QUANTUM + 1),
      }),
      effects,
    );
    expect(calls.refreshProgress).toBe(afterReset + 1);
    expect(calls.notifyWaiters).toBe(calls.refreshProgress);
  });

  it("counts thinking-only growth", () => {
    const { calls, effects } = countingEffects();
    const record = { lastActivityAt: 0, turns: 0, toolCalls: 0 };
    const frames = 8;
    let thinking = "";
    for (let index = 0; index < frames; index += 1) {
      thinking += "t".repeat(QUANTUM);
      routeDelegationEvent(
        record,
        envelope({
          type: "message_update",
          message: assistantRow("", { thinking }),
          deltaThinking: "t".repeat(QUANTUM),
        }),
        effects,
      );
    }
    // Reasoning is charged like text, so a thinking-heavy response keeps the
    // occupancy — and the wake — current even though no answer text arrives.
    expect(calls.refreshProgress).toBeGreaterThan(0);
    expect(calls.refreshProgress).toBeLessThanOrEqual(frames);
    expect(calls.notifyWaiters).toBe(calls.refreshProgress);
    expect(calls.publishProgress).toBe(0);
  });

  it("counts streamed tool-call arguments the transcript row never shows", () => {
    const { calls, effects } = countingEffects();
    const record = streamRecord();
    const frames: AgentEventEnvelope[] = [];
    const run = createRun({
      onEvent: (event) => {
        frames.push(event);
        routeDelegationEvent(record, event, effects);
      },
    });
    record.run = run;
    // One call whose arguments are still being written: the transcript row is
    // empty for its whole duration, while the estimate grows by the arguments
    // the estimator charges.
    run.handleEvent({ type: "message_start", message: streamingToolCallRow() });
    const before = calls.refreshProgress;
    const argumentsFrames = 4;
    for (let index = 0; index < argumentsFrames; index += 1) {
      run.handleEvent({
        type: "message_update",
        message: streamingToolCallRow(),
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "a".repeat(QUANTUM),
          partial: streamingToolCallRow(),
        },
      });
    }

    const updates = frames.filter((frame) => frame.event.type === "message_update");
    expect(updates).toHaveLength(argumentsFrames);
    for (const frame of updates) {
      if (frame.event.type !== "message_update") continue;
      expect(frame.event.message.content).toBe("");
    }
    expect(run.streamedChars()).toBe(argumentsFrames * QUANTUM);
    expect(calls.refreshProgress - before).toBeGreaterThan(0);
  });

  it("keeps tool_start, tool_end and message_end behaviour unchanged", () => {
    const { calls, effects } = countingEffects();
    const record = { lastActivityAt: 0, turns: 0, toolCalls: 0 };
    routeDelegationEvent(
      record,
      envelope({ type: "tool_start", toolCallId: "c-1", toolName: "Read", args: {} }),
      effects,
    );
    routeDelegationEvent(
      record,
      envelope({ type: "tool_end", toolCallId: "c-1", result: {}, isError: false }),
      effects,
    );
    expect(calls.notifyWaiters).toBe(2);
    expect(calls.refreshProgress).toBe(0);
    routeDelegationEvent(
      record,
      envelope({ type: "message_end", message: assistantRow("done", { status: "complete" }) }),
      effects,
    );
    // Turn-aligned refresh + Task snapshot + wake, exactly as before.
    expect(calls.refreshProgress).toBe(1);
    expect(calls.publishProgress).toBe(1);
    expect(calls.notifyWaiters).toBe(3);
  });

  it("marks an argument-only growth frame delta-shaped on the wire, losing no text", () => {
    const inProcess: AgentEventEnvelope[] = [];
    const wire: AgentEventEnvelope[] = [];
    // The runtime's own conversion path: a delegate's `onEvent` feeds the
    // stream coalescer, which slims append-only frames on the way to the
    // renderer. `intervalMs: 0` flushes each frame, so the slimming decision —
    // not the timer — is what this test reads.
    const coalescer = createStreamCoalescer((envelope) => wire.push(envelope), {
      intervalMs: 0,
    });
    const run = createRun({
      onEvent: (event) => {
        inProcess.push(event);
        coalescer.push(event);
      },
    });

    // One response: a visible body first, then one tool call whose arguments
    // keep growing while the row's text stands still.
    const text = filler(600);
    run.handleEvent({ type: "message_start", message: streamingRow("") });
    run.agent.state.streamingMessage = streamingRow(text);
    run.handleEvent({ type: "message_update", message: streamingRow(text) });

    const argumentsFrames = 3;
    for (let index = 0; index < argumentsFrames; index += 1) {
      run.agent.state.streamingMessage = streamingRow(text);
      run.handleEvent({
        type: "message_update",
        message: streamingRow(text),
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "a".repeat(QUANTUM),
          partial: streamingRow(text),
        },
      });
    }
    coalescer.flush();

    type UpdateEnvelope = AgentEventEnvelope & {
      event: Extract<AgentEventEnvelope["event"], { type: "message_update" }>;
    };
    const isUpdate = (frame: AgentEventEnvelope): frame is UpdateEnvelope =>
      frame.event.type === "message_update";

    // In process, the growth frames are marked with the empty delta and still
    // carry the row they were built from.
    const growth = inProcess.filter(isUpdate).filter(
      (frame) => frame.event.deltaText === "",
    );
    expect(growth).toHaveLength(argumentsFrames);
    for (const frame of growth) {
      expect(frame.event.message.content).toBe(text);
      // Marked delta-shaped, not converted in place: the in-process frame keeps
      // its snapshot for the router that reads it.
      expect(frame.event.stream).toBeUndefined();
    }

    // On the wire the same frames are deltas: identity only, no cumulative
    // body, so a frame that adds no text cannot cost the whole row.
    const wireUpdates = wire.filter(isUpdate);
    const wireGrowth = wireUpdates.filter(
      (frame) => frame.event.stream === "delta" && frame.event.deltaText === undefined,
    );
    expect(wireGrowth).toHaveLength(argumentsFrames);
    for (const frame of wireGrowth) {
      expect(frame.event.message.content).toBe("");
      expect(JSON.stringify(frame).length).toBeLessThan(text.length);
    }

    // Replaying the wire stream reconstructs the text that was already shown:
    // an empty growth delta appends nothing and replaces nothing.
    let row: UiMessage | undefined;
    for (const frame of wire) {
      if (frame.event.type === "message_start") row = frame.event.message;
      if (frame.event.type === "message_update") row = applyMessageUpdate(row, frame.event);
    }
    expect(row?.content).toBe(text);
  });

  it("keeps a pending text delta when a growth frame shares its coalesce window", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((envelope) => emitted.push(envelope), {
      intervalMs: 16,
    });
    const row = assistantRow("body");
    const base = { sessionId: "session-1", turnId: "turn-1", ts: 1 };
    coalescer.push({
      ...base,
      event: { type: "message_update", message: row, deltaText: "" },
    });
    coalescer.push({
      ...base,
      event: { type: "message_update", message: row, deltaText: " more" },
    });
    coalescer.flush();
    // One frame out, still a delta, carrying the text it accumulated.
    expect(emitted).toHaveLength(1);
    const event = emitted[0].event;
    expect(event.type).toBe("message_update");
    if (event.type !== "message_update") return;
    expect(event.stream).toBe("delta");
    expect(event.message.content).toBe("");
    expect(event.deltaText).toBe(" more");
  });
});
