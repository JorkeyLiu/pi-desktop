/**
 * Self-handoff through the real agent loop.
 *
 * Everything below the external provider boundary is production code: the same
 * `SubagentRun.run()` entry, the real pi agent loop, real tool execution, the
 * real `prepareNextTurnWithContext` boundary, and the runtime-owned
 * `SubagentHandoff` tool. Only the provider transport is deterministically
 * scripted, so what these tests observe is the request the delegate would
 * actually send — including the model-authored continuation after a rollover and
 * the provider-retry path that must not lose the request.
 */
import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { SubagentDefinition } from "@pi-desktop/shared";
import { SubagentRun, type SubagentRunOptions } from "./subagent.js";
import {
  MAX_SUBAGENT_HANDOFF_FAILURES,
  MAX_SUBAGENT_HANDOFF_UNANSWERED,
  SUBAGENT_HANDOFF_TOOL_NAME,
} from "./subagent-handoff.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

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

const TASK = "Find where the permission dialog is rendered and report the path.";

function definition(): SubagentDefinition {
  return {
    name: "explorer",
    description: "Search the workspace and report findings.",
    tools: ["Read"],
    prompt: "Find the answer and report it.",
    source: "builtin",
  };
}

type LlmMessage = { role: string; content: unknown; toolCallId?: string };

function textOf(message: LlmMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const entry = block as { type?: string; text?: string; name?: string };
      if (typeof entry.text === "string") return entry.text;
      return entry.name ?? "";
    })
    .join("\n");
}

function requestText(messages: readonly LlmMessage[]): string {
  return messages.map(textOf).join("\n---\n");
}

function hasInstruction(messages: readonly LlmMessage[]): boolean {
  return requestText(messages).includes("[Context handoff required]");
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Image block payloads a request actually carries, in order. */
function imageData(messages: readonly LlmMessage[]): string[] {
  const found: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const entry = block as { type?: string; data?: string };
      if (entry.type === "image" && typeof entry.data === "string") {
        found.push(entry.data);
      }
    }
  }
  return found;
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
    ...extra,
  };
}

function readTool(calls: string[]): AgentTool {
  return {
    name: "Read",
    label: "Read",
    description: "Read one file.",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (toolCallId: string) => {
      calls.push(toolCallId);
      return {
        content: [{ type: "text" as const, text: `contents of ${toolCallId}` }],
        details: {},
      };
    },
  };
}

/**
 * A handoff written the way a delegate writes one: its own ordering and
 * formatting in a single free-form text, not a set of runtime-named fields.
 */
const SUBMITTABLE = {
  handoff: [
    "Located the dialog in the settings layout; it is mounted from apps/desktop/src/components/PermissionDialog.tsx.",
    "Constraint: the dialog's public props stay unchanged.",
    "",
    "- pnpm lint — pass",
    "- Next: add apps/desktop/test/permission-dialog.test.mjs",
  ].join("\n"),
};

type ScriptedReply =
  | { kind: "tools"; calls: ToolCall[] }
  | { kind: "truncated"; calls: ToolCall[] }
  | { kind: "text"; text: string }
  | { kind: "failure"; errorMessage: string }
  | { kind: "abort"; abort: () => void };

/**
 * A deterministic provider: it answers the Nth request with the Nth scripted
 * reply and records every request exactly as the loop built it.
 */
function scriptedProvider(
  script: ScriptedReply[],
  requests: LlmMessage[][],
  /**
   * Called with the index of each request as it is built, before its scripted
   * reply. This is where a live user steer lands: text the user sends while
   * that turn runs is queued on the child loop and handed to the delegate at
   * the next boundary.
   */
  onRequest?: (round: number) => void,
) {
  let round = 0;
  return (_model: unknown, context: { messages: LlmMessage[] }) => {
    requests.push(context.messages.map((message) => ({ ...message })));
    const requestIndex = round;
    const reply = script[round] ?? { kind: "text" as const, text: "done" };
    round += 1;
    onRequest?.(requestIndex);
    const stream = createAssistantMessageEventStream();
    if (reply.kind === "abort") {
      reply.abort();
      const message = assistantMessage([], "aborted");
      queueMicrotask(() => {
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      });
      return stream;
    }
    if (reply.kind === "failure") {
      const message = assistantMessage([], "error", {
        errorMessage: reply.errorMessage,
      });
      queueMicrotask(() => {
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      });
      return stream;
    }
    const message =
      reply.kind === "tools"
        ? assistantMessage(reply.calls, "toolUse")
        : reply.kind === "truncated"
          ? assistantMessage(reply.calls, "length")
          : assistantMessage([{ type: "text", text: reply.text }], "stop");
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason:
          reply.kind === "tools" ? "toolUse" : reply.kind === "truncated" ? "length" : "stop",
        message,
      });
      stream.end(message);
    });
    return stream;
  };
}

function createRun(
  selfHandoff: SubagentRunOptions["selfHandoff"],
  tools: AgentTool[],
  signal?: AbortSignal,
  /** Overrides the dispatch text, as a continuation's own input does. */
  task?: string,
): {
  run: SubagentRun;
  agent: { state: { messages: AgentMessage[] }; streamFunction: unknown };
  events: Array<{ event: { type: string } }>;
} {
  const events: Array<{ event: { type: string } }> = [];
  const run = new SubagentRun({
    definition: definition(),
    sessionId: "session-loop",
    turnId: "turn-loop",
    parentToolCallId: "task-loop",
    task: task ?? TASK,
    provider,
    thinkingLevel: "off",
    systemPrompt: "You are the explorer subagent.",
    tools,
    selfHandoff,
    ...(signal ? { signal } : {}),
    onEvent: (envelope) => events.push(envelope as { event: { type: string } }),
  });
  const agent = (run as unknown as { agent: { state: { messages: AgentMessage[] } } })
    .agent;
  return {
    run,
    agent: agent as unknown as {
      state: { messages: AgentMessage[] };
      streamFunction: unknown;
    },
    events,
  };
}

function handoffCall(
  id: string,
  args: ToolCall["arguments"] = SUBMITTABLE,
): ToolCall {
  return { type: "toolCall", id, name: SUBAGENT_HANDOFF_TOOL_NAME, arguments: args };
}

/** Provider requests that actually delivered a handoff ask, in order. */
function askCount(requests: readonly LlmMessage[][]): number {
  return requests.filter(hasInstruction).length;
}

/** Rejections of one shape, as the loop would deliver them turn after turn. */
function invalidRepetition(
  count: number,
  args: ToolCall["arguments"],
): ScriptedReply[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "tools" as const,
    calls: [handoffCall(`handoff-invalid-${index}`, args)],
  }));
}

function readCall(id: string): ToolCall {
  return { type: "toolCall", id, name: "Read", arguments: { path: "a.ts" } };
}

describe("SubagentRun self-handoff through the real loop", () => {
  it("rolls over twice and finishes the same delegation after the second handoff", async () => {
    const readCalls: string[] = [];
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "tools", calls: [handoffCall("handoff-1")] },
      { kind: "tools", calls: [readCall("read-2")] },
      { kind: "tools", calls: [handoffCall("handoff-2")] },
      { kind: "text", text: "Final report: the dialog is in PermissionDialog.tsx." },
    ];
    const { run, agent } = createRun({ kind: "tool-calls", value: 1 }, [
      readTool(readCalls),
    ]);
    agent.streamFunction = scriptedProvider(script, requests);

    const result = await run.run();

    // Five provider requests: open, ask #1, post-rollover #1, ask #2, final.
    expect(requests).toHaveLength(5);
    // The real tool ran twice, through the loop, at the delegate's own request.
    expect(readCalls).toEqual(["read-1", "read-2"]);

    // The first ask reached the actual provider request, next to the execution
    // the delegate is being asked to summarize.
    expect(hasInstruction(requests[1]!)).toBe(true);
    expect(requestText(requests[1]!)).toContain("contents of read-1");

    // After the first rollover the next request carries the dispatch header and
    // exactly one summary: the absorbed segment (its tool call and result) is
    // gone, and the answered instruction is not re-sent.
    const afterFirst = requestText(requests[2]!);
    expect(afterFirst).toContain(TASK);
    expect(afterFirst).toContain("[Delegated-task handoff 1]");
    expect(afterFirst).toContain("PermissionDialog.tsx");
    expect(afterFirst).not.toContain("read-1");
    expect(hasInstruction(requests[2]!)).toBe(false);

    // The second segment asked again once its own threshold was crossed.
    expect(hasInstruction(requests[3]!)).toBe(true);

    // The final request carries the second generation only.
    const finalRequest = requestText(requests[4]!);
    expect(finalRequest).toContain(TASK);
    expect(finalRequest).toContain("[Delegated-task handoff 2]");
    expect(finalRequest).not.toContain("[Delegated-task handoff 1]");
    expect(finalRequest).not.toContain("read-2");

    // The same run finished the same delegation, reporting once.
    expect(result.status).toBe("completed");
    expect(result.report).toContain("Final report");
    expect(result.handoffs).toBe(2);
    expect(result.turns).toBe(5);
    expect(result.toolCalls).toBe(4);
    // The runtime's prompts never became transcript rows.
    expect(requestText(agent.state.messages as unknown as LlmMessage[])).not.toContain(
      "[Context handoff required]",
    );
  });

  it("carries the pending request into the provider retry instead of losing it", async () => {
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      // The asked turn fails at the transport before producing anything.
      { kind: "failure", errorMessage: "502 Bad Gateway" },
      { kind: "tools", calls: [handoffCall("handoff-1")] },
      { kind: "text", text: "Final report: done after the retry." },
    ];
    const { run, agent } = createRun({ kind: "tool-calls", value: 1 }, [
      readTool([]),
    ]);
    agent.streamFunction = scriptedProvider(script, requests);

    const result = await run.run();

    // The retry re-issues the same request, so the handoff instruction that was
    // charged at the boundary is delivered rather than silently dropped.
    expect(requests).toHaveLength(4);
    expect(hasInstruction(requests[1]!)).toBe(true);
    expect(hasInstruction(requests[2]!)).toBe(true);
    // The failed attempt left no duplicate assistant/history row behind.
    expect(requests[2]!.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(result.status).toBe("completed");
    expect(result.report).toContain("done after the retry");
    expect(result.handoffs).toBe(1);
  }, 15_000);

  it("keeps the whole segment when the delegate ignores the request", async () => {
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "text", text: "Final report: never handed off." },
    ];
    const { run, agent } = createRun({ kind: "tool-calls", value: 1 }, [
      readTool([]),
    ]);
    agent.streamFunction = scriptedProvider(script, requests);

    const result = await run.run();

    expect(hasInstruction(requests[1]!)).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.handoffs).toBeUndefined();
    // Nothing was replaced: the tool call and its result are still there.
    const history = requestText(agent.state.messages as unknown as LlmMessage[]);
    expect(history).toContain("contents of read-1");
    expect(history).not.toContain("[Delegated-task handoff");
  });

  it("keeps the segment when the run is cancelled before any submission", async () => {
    const controller = new AbortController();
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      // The cancel lands on the request that carries the handoff ask, so the
      // run is stopped with a segment already spent and nothing submitted.
      { kind: "abort", abort: () => controller.abort() },
    ];
    const { run, agent } = createRun(
      { kind: "tool-calls", value: 1 },
      [readTool([])],
      controller.signal,
    );
    agent.streamFunction = scriptedProvider(script, requests);

    const result = await run.run();

    // The ask was delivered, the turn was cancelled, and nothing was replaced.
    expect(requests).toHaveLength(2);
    expect(hasInstruction(requests[1]!)).toBe(true);
    expect(result.status).toBe("aborted");
    expect(result.handoffs).toBeUndefined();
    const history = requestText(agent.state.messages as unknown as LlmMessage[]);
    expect(history).toContain("contents of read-1");
    expect(history).not.toContain("[Delegated-task handoff");
  });

  /**
   * The direction the user sent must outlive the rollover it arrived in.
   *
   * Steering is ordinary user input to the child loop, so a rollover that
   * rebuilds the context from the dispatch header alone silently deletes the
   * only place the user's later instruction lived. This walks the real loop
   * through two rollovers with one extra direction before each, and asserts
   * what the delegate's provider request actually carries afterwards.
   */
  it("keeps delivered steering directions across every rollover, once and in order", async () => {
    const DIRECTION_A =
      "Additional direction A: also verify the dialog's focus trap before reporting.";
    const DIRECTION_B =
      "Additional direction B: report the exact line number of the focus-trap check.";
    const readCalls: string[] = [];
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "tools", calls: [handoffCall("handoff-1")] },
      { kind: "tools", calls: [readCall("read-2")] },
      { kind: "tools", calls: [handoffCall("handoff-2")] },
      { kind: "text", text: "Final report: the dialog is in PermissionDialog.tsx." },
    ];
    const { run, agent } = createRun({ kind: "tool-calls", value: 1 }, [
      readTool(readCalls),
    ]);
    agent.streamFunction = scriptedProvider(script, requests, (round) => {
      // Both directions are sent while a turn is already running, so each one
      // is delivered inside the segment the following handoff absorbs.
      if (round === 0) run.steer(DIRECTION_A);
      if (round === 2) run.steer(DIRECTION_B);
    });

    const result = await run.run();

    expect(requests).toHaveLength(5);
    // The delegate was actually given the direction...
    expect(requestText(requests[1]!)).toContain(DIRECTION_A);
    // ...and it survives the first rollover, ahead of the new summary.
    const afterFirst = requestText(requests[2]!);
    expect(afterFirst).toContain(TASK);
    expect(countOf(afterFirst, DIRECTION_A)).toBe(1);
    expect(afterFirst).toContain("[Delegated-task handoff 1]");
    expect(afterFirst).not.toContain("contents of read-1");

    // Both directions survive the second rollover: chronological, exactly
    // once each, and still ahead of the one surviving summary.
    const afterSecond = requestText(requests[4]!);
    expect(countOf(afterSecond, DIRECTION_A)).toBe(1);
    expect(countOf(afterSecond, DIRECTION_B)).toBe(1);
    expect(afterSecond.indexOf(DIRECTION_A)).toBeLessThan(
      afterSecond.indexOf(DIRECTION_B),
    );
    expect(afterSecond.indexOf(DIRECTION_B)).toBeLessThan(
      afterSecond.indexOf("[Delegated-task handoff 2]"),
    );
    expect(afterSecond).toContain("[Delegated-task handoff 2]");
    expect(afterSecond).not.toContain("[Delegated-task handoff 1]");
    expect(afterSecond).not.toContain("contents of read-2");
    expect(result.status).toBe("completed");
    expect(result.handoffs).toBe(2);
  });

  /**
   * The one direction the fix could duplicate: pi drains the steering queue at
   * the end of a turn and only hands those messages to the model after the
   * boundary ran. Such a message is not in the delegate's context when the
   * rollover installs its replacement, so the rollover must leave it to the
   * loop's own delivery instead of copying it in as well.
   */
  it("delivers a direction queued before the rollover install exactly once", async () => {
    const QUEUED =
      "Direction sent while the handoff turn ran: check the escape key handler too.";
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "tools", calls: [handoffCall("handoff-1")] },
      { kind: "tools", calls: [readCall("read-2")] },
      { kind: "text", text: "Final report: done." },
    ];
    const { run, agent } = createRun({ kind: "tool-calls", value: 1 }, [
      readTool([]),
    ]);
    agent.streamFunction = scriptedProvider(script, requests, (round) => {
      // Sent on the turn that submits the handoff: queued, drained, and only
      // then delivered — after the boundary installed the new context.
      if (round === 1) run.steer(QUEUED);
    });

    const result = await run.run();

    expect(requests).toHaveLength(4);
    const afterRollover = requestText(requests[2]!);
    expect(afterRollover).toContain("[Delegated-task handoff 1]");
    expect(countOf(afterRollover, QUEUED)).toBe(1);
    expect(countOf(requestText(requests[3]!), QUEUED)).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.handoffs).toBe(1);
  });

  it("keeps a steering image through a rollover", async () => {
    const image = {
      type: "image" as const,
      data: "iVBORw0KGgoAAAANSUhEUg==",
      mimeType: "image/png",
    };
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "tools", calls: [handoffCall("handoff-1")] },
      { kind: "text", text: "Final report: compared." },
    ];
    const { run, agent } = createRun({ kind: "tool-calls", value: 1 }, [
      readTool([]),
    ]);
    agent.streamFunction = scriptedProvider(script, requests, (round) => {
      if (round === 0) {
        run.steer("Compare this screenshot with the rendered dialog.", [image]);
      }
    });

    const result = await run.run();

    expect(requests).toHaveLength(3);
    expect(imageData(requests[1]!)).toEqual([image.data]);
    // The bytes travel with the direction, unchanged, across the rollover.
    const afterRollover = requestText(requests[2]!);
    expect(afterRollover).toContain("Compare this screenshot");
    expect(afterRollover).toContain("[Delegated-task handoff 1]");
    expect(imageData(requests[2]!)).toEqual([image.data]);
    expect(result.status).toBe("completed");
  });

/**
 * The bounded failure budget has to cover the layer the model can fail at
 * *before* `execute`: the argument schema. A submission that is empty text,
 * too long, or the wrong shape is refused by the schema check, so the tool
 * never runs — the runtime never sees the rejection `execute` would report, and
 * the ask it already parked keeps riding on later requests. These tests walk
 * the real loop with such submissions and assert what the delegate observes:
 * how many asks it gets, which error it reads back, whether a later valid
 * submission still rolls the context over, and what the run kept.
 */
describe("SubagentRun self-handoff with schema-rejected submissions", () => {
  type HandoffStateView = {
    failures: number;
    unanswered: number;
    requested: boolean;
  };

  /** The run's own bookkeeping: a secondary witness next to the requests. */
  function stateOf(run: SubagentRun): HandoffStateView {
    return (run as unknown as { handoffState: HandoffStateView }).handoffState;
  }

  /** Six submissions of one shape, then a plain report. */
  async function drive(shape: ToolCall["arguments"]) {
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      ...invalidRepetition(6, shape),
      { kind: "text", text: "Final report: stopped asking." },
    ];
    const harness = createRun({ kind: "tool-calls", value: 1 }, [readTool([])]);
    harness.agent.streamFunction = scriptedProvider(script, requests);
    const result = await harness.run.run();
    return { ...harness, requests, result };
  }

  it("charges a schema rejection into the same budget as an execute rejection", async () => {
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      // Every submission is invalid, but at different layers: the first is
      // refused by the argument schema and never reaches `execute`, the rest
      // are refused by the runtime's own normalizer. All of them come out of
      // one budget, so the asks stop after three in total.
      { kind: "tools", calls: [handoffCall("handoff-empty", { handoff: "" })] },
      ...invalidRepetition(5, { handoff: "   \n  " }),
      { kind: "text", text: "Final report: stopped asking." },
    ];
    const harness = createRun({ kind: "tool-calls", value: 1 }, [readTool([])]);
    harness.agent.streamFunction = scriptedProvider(script, requests);

    const result = await harness.run.run();

    expect(askCount(requests)).toBe(MAX_SUBAGENT_HANDOFF_FAILURES);
    // Each layer's own reason reached the delegate, so it can correct in place.
    expect(requestText(requests[2]!)).toContain(
      'Validation failed for tool "SubagentHandoff"',
    );
    expect(requestText(requests[3]!)).toContain("The handoff is empty");
    // Six submissions are six failures, not six unanswered asks: the two
    // layers charge into one counter, and each submission charges it once.
    expect(stateOf(harness.run).failures).toBe(6);
    expect(stateOf(harness.run).unanswered).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.handoffs).toBeUndefined();
  });

  it("stops asking after empty-text submissions the schema rejects", async () => {
    const { requests, result, run, agent } = await drive({ handoff: "" });

    // The ask is bounded: three asks, then no more, even though the delegate
    // kept submitting the same empty text.
    expect(askCount(requests)).toBe(MAX_SUBAGENT_HANDOFF_FAILURES);
    expect(stateOf(run).failures).toBe(6);
    // The delegate is told why, through the real tool error the loop delivers.
    expect(requestText(requests[2]!)).toContain(
      'Validation failed for tool "SubagentHandoff"',
    );
    // Nothing was installed: a rejected submission never changes the history.
    expect(result.status).toBe("completed");
    expect(result.handoffs).toBeUndefined();
    expect(
      requestText(agent.state.messages as unknown as LlmMessage[]),
    ).toContain("contents of read-1");
  });

  it("stops asking after submissions of the wrong type", async () => {
    const { requests, result, run } = await drive({ handoff: { text: "x" } });

    expect(askCount(requests)).toBe(MAX_SUBAGENT_HANDOFF_FAILURES);
    expect(stateOf(run).failures).toBe(6);
    expect(requestText(requests[2]!)).toContain(
      'Validation failed for tool "SubagentHandoff"',
    );
    expect(result.handoffs).toBeUndefined();
  });

  it("stops asking after submissions of the wrong shape", async () => {
    const { requests, result, run } = await drive({});

    expect(askCount(requests)).toBe(MAX_SUBAGENT_HANDOFF_FAILURES);
    expect(stateOf(run).failures).toBe(6);
    expect(requestText(requests[2]!)).toContain(
      'Validation failed for tool "SubagentHandoff"',
    );
    expect(result.handoffs).toBeUndefined();
  });

  it("charges a whitespace submission exactly once", async () => {
    // Whitespace passes the schema and is rejected by the runtime's own
    // normalizer; it must cost one failure, not one per layer.
    const { requests, result, run } = await drive({ handoff: "   \n  " });

    expect(askCount(requests)).toBe(MAX_SUBAGENT_HANDOFF_FAILURES);
    // Six submissions, six charges: one per submission, not one per layer.
    expect(stateOf(run).failures).toBe(6);
    expect(requestText(requests[2]!)).toContain("The handoff is empty");
    expect(result.handoffs).toBeUndefined();
  });

  it("does not charge a submission nobody asked for", async () => {
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      // Three rejected calls while no request is outstanding: the runtime
      // refuses them for its own reason, so none may spend the budget.
      ...invalidRepetition(3, { handoff: "" }),
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "tools", calls: [readCall("read-2")] },
      { kind: "tools", calls: [handoffCall("handoff-1")] },
      { kind: "text", text: "Final report: handed off." },
    ];
    const harness = createRun({ kind: "tool-calls", value: 5 }, [readTool([])]);
    harness.agent.streamFunction = scriptedProvider(script, requests);

    const result = await harness.run.run();

    // The threshold was reached after the proactive calls: the ask still
    // happened, so nothing was charged against the failure budget.
    expect(askCount(requests)).toBe(1);
    expect(stateOf(harness.run).failures).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.handoffs).toBe(1);
  });

  it("resets the budget on a valid submission", async () => {
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "tools", calls: [handoffCall("handoff-bad-1", { handoff: "" })] },
      { kind: "tools", calls: [handoffCall("handoff-bad-2", { handoff: "" })] },
      { kind: "tools", calls: [handoffCall("handoff-1")] },
      // A second call after the acceptance is a duplicate, not an invalid
      // submission: it is refused for the runtime's own reason.
      { kind: "tools", calls: [handoffCall("handoff-duplicate", { handoff: "" })] },
      { kind: "tools", calls: [readCall("read-2")] },
      { kind: "tools", calls: [handoffCall("handoff-2")] },
      { kind: "text", text: "Final report: two handoffs." },
    ];
    const harness = createRun({ kind: "tool-calls", value: 1 }, [readTool([])]);
    harness.agent.streamFunction = scriptedProvider(script, requests);

    const result = await harness.run.run();

    // Two rejections had been charged before the valid submission, which
    // resets the budget: the post-rollover segment is asked again.
    expect(hasInstruction(requests[3]!)).toBe(true);
    expect(hasInstruction(requests[6]!)).toBe(true);
    const afterAcceptance = requestText(requests[4]!);
    expect(afterAcceptance).toContain("[Delegated-task handoff 1]");
    expect(stateOf(harness.run).failures).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.handoffs).toBe(2);
  });
});
});

/**
 * Steering text is freeform child input: the child's own context window is the
 * only real limit. This walks the real loop with a direction far past the
 * retired 20000-character transport bound and asserts the delegate's provider
 * request carries it whole — both in the turn that received it and after the
 * rollover that rebuilds the delegate's context.
 */
describe("SubagentRun live steering text", () => {
  it("carries a steer past the retired text bound through the loop whole", async () => {
    const STEER = [
      "STEER-HEAD: also verify the escape handler before reporting.",
      "steer detail line with a path and a line number. ".repeat(1_200),
      "STEER-MIDDLE: keep the dialog props unchanged.",
      "astral marker \u{1F642} and CJK marker \u{4EA4}\u{63A5} ".repeat(400),
      "STEER-TAIL: report the exact line in the final answer.",
    ].join("\n");
    expect(STEER.length).toBeGreaterThan(60_000);
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "tools", calls: [handoffCall("handoff-1")] },
      { kind: "text", text: "Final report: done." },
    ];
    const { run, agent } = createRun({ kind: "tool-calls", value: 1 }, [
      readTool([]),
    ]);
    agent.streamFunction = scriptedProvider(script, requests, (round) => {
      // Sent while the first turn runs: queued on the child loop and delivered
      // at the next turn boundary, exactly like a live user steer.
      if (round === 0) run.steer(STEER);
    });

    const result = await run.run();

    expect(requests).toHaveLength(3);
    const delivered = requestText(requests[1]!);
    expect(countOf(delivered, "STEER-HEAD")).toBe(1);
    expect(delivered).toContain("STEER-MIDDLE: keep the dialog props unchanged.");
    expect(countOf(delivered, "STEER-TAIL")).toBe(1);
    expect(delivered).toContain(STEER);
    // The whole direction survives the rollover, once, not summarized.
    const afterRollover = requestText(requests[2]!);
    expect(countOf(afterRollover, "STEER-HEAD")).toBe(1);
    expect(afterRollover).toContain("STEER-MIDDLE: keep the dialog props unchanged.");
    expect(countOf(afterRollover, "STEER-TAIL")).toBe(1);
    expect(afterRollover).toContain(STEER);
    expect(afterRollover).toContain("[Delegated-task handoff 1]");
    expect(result.status).toBe("completed");
    expect(result.handoffs).toBe(1);
  });
});

/**
 * The layers a delegate can be refused at, and what each costs.
 *
 * `SubagentHandoff` is a normal agent tool: the loop validates its arguments
 * against the declared schema before `execute`, and a message the output token
 * limit cut never executes any of its calls at all. None of these layers
 * replaces the delegate's history or its checkpoint, and a refusal is charged
 * to the one consecutive-failure budget whichever layer produced it.
 */
describe("SubagentRun self-handoff submission layers", () => {
  type HandoffView = {
    failures: number;
    unanswered: number;
    requested: boolean;
  };

  /** The run's own bookkeeping, as a secondary witness next to the requests. */
  function stateOf(run: SubagentRun): HandoffView {
    return (run as unknown as { handoffState: HandoffView }).handoffState;
  }

  /** The submission the run parked for the next boundary, if any. */
  function pendingOf(run: SubagentRun): unknown {
    return (run as unknown as { pendingHandoff: unknown }).pendingHandoff;
  }

  /**
   * A handoff several times the retired 12000-character bound, with markers at
   * the beginning, middle and end plus non-BMP characters, so a clip anywhere
   * is visible in the request the delegate sends next.
   */
  function oversizedHandoff(): string {
    return [
      "HANDOFF-HEAD: the dialog lives in PermissionDialog.tsx.",
      "checked line and its outcome. ".repeat(900),
      "HANDOFF-MIDDLE: the dialog's public props stay unchanged.",
      "astral marker \u{1F642} and CJK marker \u{4EA4}\u{63A5} ".repeat(900),
      "HANDOFF-TAIL: add the focus-trap test next.",
    ].join("\n");
  }

  it("accepts an over-long handoff in one call and installs it whole", async () => {
    const authored = oversizedHandoff();
    expect(authored.length).toBeGreaterThan(12_000);
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "tools", calls: [handoffCall("handoff-long", { handoff: authored })] },
      { kind: "text", text: "Final report: continued after one rollover." },
    ];
    const harness = createRun({ kind: "tool-calls", value: 1 }, [readTool([])]);
    harness.agent.streamFunction = scriptedProvider(script, requests);

    const result = await harness.run.run();

    // One submission answered one request: no refusal, no retry, no charge.
    expect(requests).toHaveLength(3);
    expect(result.status).toBe("completed");
    expect(result.handoffs).toBe(1);
    expect(stateOf(harness.run).failures).toBe(0);
    expect(stateOf(harness.run).unanswered).toBe(0);
    expect(pendingOf(harness.run)).toBeUndefined();

    // The delegate never read a validation error back.
    expect(requestText(requests[2]!)).not.toContain("Validation failed for tool");
    // The installed context carries the authored text character for character.
    const installed = requestText(requests[2]!);
    expect(installed).toContain("[Delegated-task handoff 1]");
    expect(installed).toContain(authored);
    expect(countOf(installed, "HANDOFF-HEAD")).toBe(1);
    expect(countOf(installed, "HANDOFF-MIDDLE")).toBe(1);
    expect(countOf(installed, "HANDOFF-TAIL")).toBe(1);
    expect(countOf(installed, "\u{1F642}")).toBe(900);
    // Only the absorbed segment is gone; the task and the report stay.
    expect(installed).not.toContain("contents of read-1");
    expect(
      countOf(
        requestText(harness.agent.state.messages as unknown as LlmMessage[]),
        authored,
      ),
    ).toBe(1);
  });

  it("keeps the segment and the checkpoint when the arguments fail the schema", async () => {
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "tools", calls: [handoffCall("handoff-shape", {})] },
      { kind: "text", text: "Final report: never handed off." },
    ];
    const harness = createRun({ kind: "tool-calls", value: 1 }, [readTool([])]);
    harness.agent.streamFunction = scriptedProvider(script, requests);

    const result = await harness.run.run();

    // The loop refused the call before `execute`: its own reason reached the
    // delegate, nothing was parked, and no history row was replaced.
    expect(requestText(requests[2]!)).toContain(
      'Validation failed for tool "SubagentHandoff"',
    );
    expect(pendingOf(harness.run)).toBeUndefined();
    expect(result.handoffs).toBeUndefined();
    const history = requestText(harness.agent.state.messages as unknown as LlmMessage[]);
    expect(history).toContain("contents of read-1");
    expect(history).not.toContain("[Delegated-task handoff");
    // The schema refusal is one invalid submission in the same budget an
    // `execute` refusal would spend, and it retires the parked request, so a
    // correction is not answered against text the delegate already replaced.
    expect(stateOf(harness.run).failures).toBe(1);
    // The failure reset the unanswered streak and spent the parked request; the
    // next boundary asks again under the same request, so the streak reads 1.
    expect(stateOf(harness.run).unanswered).toBe(1);
    expect(stateOf(harness.run).requested).toBe(true);
  });

  it("bounds repeated schema rejections and keeps the segment intact", async () => {
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      ...Array.from({ length: 6 }, (_, index) => ({
        kind: "tools" as const,
        calls: [handoffCall(`handoff-shape-${index}`, {})],
      })),
      { kind: "text", text: "Final report: stopped asking." },
    ];
    const harness = createRun({ kind: "tool-calls", value: 1 }, [readTool([])]);
    harness.agent.streamFunction = scriptedProvider(script, requests);

    const result = await harness.run.run();

    // The same malformed submission is answered deterministically every time,
    // each one costs a failure, and the asks stop at the bound instead of
    // repeating for the segment.
    expect(askCount(requests)).toBe(MAX_SUBAGENT_HANDOFF_FAILURES);
    expect(stateOf(harness.run).failures).toBe(6);
    expect(result.status).toBe("completed");
    expect(result.handoffs).toBeUndefined();
    const history = requestText(harness.agent.state.messages as unknown as LlmMessage[]);
    expect(history).toContain("contents of read-1");
    expect(history).not.toContain("[Delegated-task handoff");
  });

  it("fails a truncated handoff call without installing it", async () => {
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      // The output token limit cut this message, so pi refuses to execute any
      // of its calls: the salvaged arguments may be incomplete.
      {
        kind: "truncated",
        calls: [handoffCall("handoff-cut", { handoff: "HANDOFF-HEAD: the dialog lives in" })],
      },
      { kind: "text", text: "Final report: reissued later." },
    ];
    const harness = createRun({ kind: "tool-calls", value: 1 }, [readTool([])]);
    harness.agent.streamFunction = scriptedProvider(script, requests);

    const result = await harness.run.run();

    // The delegate reads the loop's own truncation reason...
    expect(requestText(requests[2]!)).toContain("hit the output token limit");
    // ...and none of the cut text entered the context or the checkpoint.
    expect(pendingOf(harness.run)).toBeUndefined();
    expect(result.handoffs).toBeUndefined();
    // The loop reports the un-executed call as an error without a duration, so
    // it costs one charge in the same bounded budget; the ask is renewed under
    // the next boundary's own request rather than spun on this one.
    expect(stateOf(harness.run).failures).toBe(1);
    expect(stateOf(harness.run).unanswered).toBe(1);
    const history = requestText(harness.agent.state.messages as unknown as LlmMessage[]);
    expect(history).toContain("contents of read-1");
    expect(history).not.toContain("[Delegated-task handoff");
    expect(history).not.toContain("HANDOFF-HEAD");
  });

  it("leaves the bounded asks unspent after a long submission is accepted", async () => {
    // The retired cap was enforced by the schema: a long but valid submission
    // was refused before `execute`, so each retry spent one of the bounded asks
    // and a delegate could end up unable to hand off at all.
    const authored = oversizedHandoff();
    const requests: LlmMessage[][] = [];
    const script: ScriptedReply[] = [
      { kind: "tools", calls: [readCall("read-1")] },
      { kind: "tools", calls: [handoffCall("handoff-long", { handoff: authored })] },
      { kind: "tools", calls: [readCall("read-2")] },
      { kind: "text", text: "Final report: handled in one submission." },
    ];
    const harness = createRun({ kind: "tool-calls", value: 1 }, [readTool([])]);
    harness.agent.streamFunction = scriptedProvider(script, requests);

    const result = await harness.run.run();

    // The first segment asked and was answered; the new segment asks again with
    // its own fresh budget instead of inheriting a spent one.
    expect(askCount(requests)).toBe(2);
    expect(hasInstruction(requests[0]!)).toBe(false);
    expect(hasInstruction(requests[3]!)).toBe(true);
    expect(result.handoffs).toBe(1);
    expect(stateOf(harness.run).failures).toBe(0);
    expect(stateOf(harness.run).unanswered).toBe(1);
  });
});

/**
 * A continuation enters the child loop as its own dispatch text, after the
 * public entry validated it. Nothing downstream may clip it: the first request
 * the resumed run sends carries every character.
 */
describe("SubagentRun continued task text", () => {
  it("sends an over-long continued task whole in the first request", async () => {
    const authored = [
      "CONTINUE-HEAD: go deeper from the earlier segment.",
      "follow-up detail with a path and a line number. ".repeat(1_000),
      "CONTINUE-MIDDLE: the constraint that still binds.",
      "astral marker \u{1F642} and CJK marker \u{4EA4}\u{63A5} ".repeat(500),
      "CONTINUE-TAIL: report the exact line.",
    ].join("\n");
    expect(authored.length).toBeGreaterThan(20_000);
    const requests: LlmMessage[][] = [];
    const { run, agent } = createRun({ kind: "tool-calls", value: 1 }, [readTool([])], undefined, authored);
    agent.streamFunction = scriptedProvider(
      [{ kind: "text", text: "Final report: continued and done." }],
      requests,
    );

    const result = await run.run();

    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(1);
    const first = requestText(requests[0]!);
    expect(first).toContain(authored);
    expect(countOf(first, "CONTINUE-HEAD")).toBe(1);
    expect(countOf(first, "CONTINUE-MIDDLE")).toBe(1);
    expect(countOf(first, "CONTINUE-TAIL")).toBe(1);
  });
});
