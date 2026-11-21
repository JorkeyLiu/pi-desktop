/**
 * A parallel-Bash delegate driven by the production producer.
 *
 * The envelopes below are not hand-built: a real `SubagentRun` consumes legal
 * pi-agent-core boundary events (assistant frames with `toolcall_*` stream
 * frames, `tool_execution_start` / `tool_execution_update` /
 * `tool_execution_end`) and emits the real producer-to-parent envelopes —
 * `tool_prepare` from argument streaming, `tool_start`, streaming
 * `tool_update` partials, `tool_end`, and the delegate assistant rows — each
 * already attributed with `parentToolCallId`, `agentName`, `turnId`, and `ts`.
 * The harness feeds every envelope into the real store untouched.
 *
 * Time is a manual counter, never a sleep: `Date.now` is patched while the
 * producer runs so prepare/start/end stamps are deterministic. `sameMs`
 * collapses the whole run into one millisecond (prepare and start ties, the
 * chronological re-sort's worst case); otherwise each boundary step advances
 * the clock. Short local commands are unnecessary — the executor is the
 * deferred boundary itself: both Bash calls start, streaming partials
 * interleave, and the later-announced call B always ends first.
 */
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { SubagentRun } from "../../../../packages/agent-runtime/src/subagent.js";

export type BashProducerOptions = {
  sessionId?: string;
  turnId?: string;
  parentToolCallId?: string;
  agentName?: string;
  task?: string;
  /** Collapse every stamp into one millisecond to force createdAt ties. */
  sameMs?: boolean;
  /** Milliseconds between boundary steps when stamps must differ. */
  stepMs?: number;
  callA?: string;
  callB?: string;
  commandA?: string;
  commandB?: string;
};

export type BashProducerResult = {
  envelopes: AgentEventEnvelope[];
  /** Envelope ts of each tool_start, the host's durable createdAt source. */
  starts: Record<string, number>;
  /** Envelope ts of each tool_end. */
  ends: Record<string, number>;
  /** Every envelope ts in emission order. */
  timeline: number[];
};

const PROVIDER = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:1/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
} as const;

function assistantMessage(content: unknown[]) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content,
  };
}

const toolCallBlock = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

const bashResult = (text: string) => ({
  content: [{ type: "text", text }],
});

/**
 * Run one parallel-Bash delegate to completion and return its envelopes.
 *
 * The delegate streams both Bash calls, starts A then B, streams stdout
 * partials for both, ends B first while A still streams, then ends A and
 * settles its report. Every stage boundary is a controlled step — no sleep,
 * no provider, no subprocess.
 */
export function produceParallelBashEnvelopes(options: BashProducerOptions = {}): BashProducerResult {
  const {
    sessionId = "bash-parallel-session",
    turnId = "turn-1",
    parentToolCallId = "call-task",
    agentName = "explorer",
    task = "run parallel bash",
    sameMs = false,
    stepMs = 5,
    callA = "bash-a",
    callB = "bash-b",
    commandA = "echo alpha",
    commandB = "echo bravo",
  } = options;
  const envelopes: AgentEventEnvelope[] = [];
  const run = new SubagentRun({
    definition: {
      name: agentName,
      description: "Run shell commands and report.",
      tools: ["Bash"],
      prompt: "Run the commands and report.",
      source: "builtin",
    },
    sessionId,
    turnId,
    parentToolCallId,
    task,
    provider: { ...PROVIDER },
    thinkingLevel: "off",
    systemPrompt: "system",
    tools: [],
    onEvent: (envelope) => {
      envelopes.push(envelope);
    },
  });
  const producer = run as unknown as {
    handleEvent(event: Record<string, unknown>): void;
  };

  let now = Date.parse("2026-10-13T00:00:00.000Z");
  const advance = sameMs ? 0 : stepMs;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const step = (event: Record<string, unknown>) => {
      now += advance;
      producer.handleEvent(event);
    };
    const argsA = { command: commandA };
    const argsB = { command: commandB };
    const text = [{ type: "text", text: "Running both commands." }];
    const contentA = [...text, toolCallBlock(callA, "Bash", argsA)];
    const contentAB = [...contentA, toolCallBlock(callB, "Bash", argsB)];

    step({ type: "message_start", message: assistantMessage(text) });
    step({
      type: "message_update",
      message: assistantMessage(contentA),
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        partial: assistantMessage(contentA),
      },
    });
    step({
      type: "message_update",
      message: assistantMessage(contentA),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: toolCallBlock(callA, "Bash", argsA),
        partial: assistantMessage(contentA),
      },
    });
    step({
      type: "message_update",
      message: assistantMessage(contentAB),
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 2,
        partial: assistantMessage(contentAB),
      },
    });
    step({
      type: "message_update",
      message: assistantMessage(contentAB),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: toolCallBlock(callB, "Bash", argsB),
        partial: assistantMessage(contentAB),
      },
    });
    step({ type: "tool_execution_start", toolCallId: callA, toolName: "Bash", args: argsA });
    step({ type: "tool_execution_start", toolCallId: callB, toolName: "Bash", args: argsB });
    step({ type: "tool_execution_update", toolCallId: callA, partialResult: "alpha: 1\n" });
    step({ type: "tool_execution_update", toolCallId: callB, partialResult: "bravo: 1\n" });
    // B was announced later but finishes first while A still streams.
    step({ type: "tool_execution_end", toolCallId: callB, result: bashResult("bravo-done"), isError: false });
    step({ type: "tool_execution_update", toolCallId: callA, partialResult: "alpha: 1\nalpha: 2\n" });
    step({ type: "tool_execution_end", toolCallId: callA, result: bashResult("alpha-done"), isError: false });
    step({
      type: "message_end",
      message: {
        ...assistantMessage([{ type: "text", text: "Both commands finished." }]),
        stopReason: "stop",
      },
    });
  } finally {
    Date.now = realNow;
  }

  const starts: Record<string, number> = {};
  const ends: Record<string, number> = {};
  const timeline: number[] = [];
  for (const envelope of envelopes) {
    timeline.push(envelope.ts);
    if (envelope.event.type === "tool_start") starts[envelope.event.toolCallId] = envelope.ts;
    if (envelope.event.type === "tool_end") ends[envelope.event.toolCallId] = envelope.ts;
  }
  return { envelopes, starts, ends, timeline };
}
