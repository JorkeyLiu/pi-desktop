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
import { SUBAGENT_HANDOFF_TOOL_NAME } from "./subagent-handoff.js";
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
  | { kind: "text"; text: string }
  | { kind: "failure"; errorMessage: string }
  | { kind: "abort"; abort: () => void };

/**
 * A deterministic provider: it answers the Nth request with the Nth scripted
 * reply and records every request exactly as the loop built it.
 */
function scriptedProvider(script: ScriptedReply[], requests: LlmMessage[][]) {
  let round = 0;
  return (_model: unknown, context: { messages: LlmMessage[] }) => {
    requests.push(context.messages.map((message) => ({ ...message })));
    const reply = script[round] ?? { kind: "text" as const, text: "done" };
    round += 1;
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
        : assistantMessage([{ type: "text", text: reply.text }], "stop");
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: reply.kind === "tools" ? "toolUse" : "stop",
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
    task: TASK,
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
  args: { [key: string]: string } = SUBMITTABLE,
): ToolCall {
  return { type: "toolCall", id, name: SUBAGENT_HANDOFF_TOOL_NAME, arguments: args };
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
});
