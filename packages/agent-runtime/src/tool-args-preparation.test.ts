import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { createToolArgsPreparation } from "./tool-args-preparation.js";

/**
 * Provider streams differ in when a tool call becomes identifiable: some name
 * it up front, some start with an empty id and name and backfill both through
 * argument deltas, and some deliver the whole call at once. These cases pin the
 * two things the transcript depends on — each call is reported as soon as it can
 * be identified, and its completion is reported once, at the end of argument
 * generation, without waiting for execution.
 */

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    type: "toolCall",
    id: "",
    name: "",
    arguments: {},
    ...overrides,
  };
}

function partial(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "fixture",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    stopReason: "toolUse",
    timestamp: 0,
  } as unknown as AssistantMessage;
}

function event(
  type: "toolcall_start" | "toolcall_delta" | "toolcall_end",
  content: AssistantMessage["content"],
  contentIndex = 0,
): AssistantMessageEvent {
  const message = partial(content);
  if (type === "toolcall_end") {
    return {
      type: "toolcall_end",
      contentIndex,
      toolCall: content[contentIndex] as ToolCall,
      partial: message,
    };
  }
  if (type === "toolcall_delta") {
    return { type: "toolcall_delta", contentIndex, delta: "", partial: message };
  }
  return { type: "toolcall_start", contentIndex, partial: message };
}

describe("tool argument preparation tracker", () => {
  it("reports a call as soon as both its id and its name are known", () => {
    const tracker = createToolArgsPreparation();
    const blocks = () => [toolCall({ id: "call-1", name: "Read" })];

    expect(tracker.observe(event("toolcall_start", blocks()))).toEqual([
      { toolCallId: "call-1", toolName: "Read" },
    ]);
    // Every later delta of the same call only carries arguments.
    expect(tracker.observe(event("toolcall_delta", blocks()))).toEqual([]);
    // Argument generation ends here, before anything executes.
    expect(tracker.observe(event("toolcall_end", blocks()))).toEqual([
      { toolCallId: "call-1", toolName: "Read", ready: true },
    ]);
    // Completion is reported once, not per frame.
    expect(tracker.observe(event("toolcall_end", blocks()))).toEqual([]);
  });

  it("waits for a late id and a late name instead of inventing an identity", () => {
    const tracker = createToolArgsPreparation();
    // OpenAI-compatible completions may start with both empty and backfill
    // them through deltas, including empty ones.
    expect(
      tracker.observe(event("toolcall_start", [toolCall()])),
    ).toEqual([]);
    expect(
      tracker.observe(event("toolcall_delta", [toolCall({ name: "Bash" })])),
    ).toEqual([]);
    expect(
      tracker.observe(event("toolcall_delta", [toolCall({ id: "call-9", name: "Bash" })])),
    ).toEqual([{ toolCallId: "call-9", toolName: "Bash" }]);
    expect(
      tracker.observe(event("toolcall_delta", [toolCall({ id: "call-9", name: "Bash" })])),
    ).toEqual([]);
    expect(
      tracker.observe(event("toolcall_end", [toolCall({ id: "call-9", name: "Bash" })])),
    ).toEqual([{ toolCallId: "call-9", toolName: "Bash", ready: true }]);
  });

  it("reports a call that only becomes identifiable at its end already complete", () => {
    const tracker = createToolArgsPreparation();
    // An empty identity never pulses and never invents a row.
    expect(tracker.observe(event("toolcall_start", [toolCall()]))).toEqual([]);
    expect(tracker.observe(event("toolcall_delta", [toolCall()]))).toEqual([]);
    // The whole call arrives with its final arguments: one frame, no pulse.
    expect(
      tracker.observe(
        event("toolcall_end", [toolCall({ id: "call-2", name: "Grep", arguments: { pattern: "x" } })]),
      ),
    ).toEqual([{ toolCallId: "call-2", toolName: "Grep", ready: true }]);
  });

  it("reports an interleaved parallel batch once per call, in content order", () => {
    const tracker = createToolArgsPreparation();
    const batch = () => [
      toolCall({ id: "call-a", name: "Read" }),
      toolCall({ id: "call-b", name: "Grep" }),
    ];
    expect(tracker.observe(event("toolcall_start", batch(), 0))).toEqual([
      { toolCallId: "call-a", toolName: "Read" },
      { toolCallId: "call-b", toolName: "Grep" },
    ]);
    expect(tracker.observe(event("toolcall_delta", batch(), 1))).toEqual([]);
    // Each call completes on its own frame; a sibling's completion never
    // repeats the other call.
    expect(tracker.observe(event("toolcall_end", batch(), 0))).toEqual([
      { toolCallId: "call-a", toolName: "Read", ready: true },
    ]);
    expect(tracker.observe(event("toolcall_end", batch(), 1))).toEqual([
      { toolCallId: "call-b", toolName: "Grep", ready: true },
    ]);
    expect(tracker.observe(event("toolcall_end", batch(), 1))).toEqual([]);
  });

  it("reports a call that only becomes identifiable later, once", () => {
    const tracker = createToolArgsPreparation();
    const batch = (first: ToolCall) => [first, toolCall({ id: "call-b", name: "Grep" })];
    expect(tracker.observe(event("toolcall_start", batch(toolCall()), 1))).toEqual([
      { toolCallId: "call-b", toolName: "Grep" },
    ]);
    expect(
      tracker.observe(
        event("toolcall_delta", batch(toolCall({ id: "call-a", name: "Read" })), 0),
      ),
    ).toEqual([{ toolCallId: "call-a", toolName: "Read" }]);
  });

  it("ignores text and thinking frames", () => {
    const tracker = createToolArgsPreparation();
    const message = partial([{ type: "text", text: "hello" }]);
    expect(
      tracker.observe({ type: "text_delta", contentIndex: 0, delta: "x", partial: message }),
    ).toEqual([]);
  });

  it("carries a delegation's bounded short description, never raw arguments", () => {
    const tracker = createToolArgsPreparation();
    const task = (description: string) => [
      toolCall({
        id: "task-1",
        name: "Task",
        arguments: { agent: "explorer", description, task: "a long brief" },
      }),
    ];
    // The name arrives before the description: the identity is reported now,
    // and the card is named once the arguments are complete.
    expect(
      tracker.observe(event("toolcall_start", [toolCall({ id: "task-1", name: "Task" })])),
    ).toEqual([{ toolCallId: "task-1", toolName: "Task" }]);
    expect(tracker.observe(event("toolcall_delta", task("Audit the")))).toEqual([]);
    const complete = tracker.observe(
      event("toolcall_end", task(`  Audit   the   parser\n${"x".repeat(400)}  `)),
    );
    expect(complete).toEqual([
      {
        toolCallId: "task-1",
        toolName: "Task",
        taskTitle: `Audit the parser ${"x".repeat(400)}`.slice(0, 200),
        ready: true,
      },
    ]);
    // Only the parsed description crosses the boundary; the brief never does.
    expect(JSON.stringify(complete)).not.toContain("a long brief");
  });

  it("does not treat an ordinary tool's arguments as a title", () => {
    const tracker = createToolArgsPreparation();
    const read = [
      toolCall({ id: "r1", name: "Read", arguments: { file_path: "/tmp/a", description: "x" } }),
    ];
    expect(tracker.observe(event("toolcall_start", read))).toEqual([
      { toolCallId: "r1", toolName: "Read" },
    ]);
    expect(tracker.observe(event("toolcall_end", read))).toEqual([
      { toolCallId: "r1", toolName: "Read", ready: true },
    ]);
  });

  it("forgets the previous message when a new one starts", () => {
    const tracker = createToolArgsPreparation();
    const blocks = () => [toolCall({ id: "call-1", name: "Read" })];
    expect(tracker.observe(event("toolcall_start", blocks()))).toHaveLength(1);
    expect(tracker.observe(event("toolcall_end", blocks()))).toHaveLength(1);
    tracker.reset();
    // A retry reuses the same content position: the call is reported again for
    // the new attempt instead of being swallowed as already prepared, and its
    // completion is reportable again too.
    expect(tracker.observe(event("toolcall_start", blocks()))).toHaveLength(1);
    expect(tracker.observe(event("toolcall_end", blocks()))).toEqual([
      { toolCallId: "call-1", toolName: "Read", ready: true },
    ]);
  });
});
