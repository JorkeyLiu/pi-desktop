import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentTool, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./runtime.js";
import type {
  CommandShellOption,
  SubagentDefinition,
} from "@pi-desktop/shared";

/**
 * Delivery acceptance: a delegation report counts as delivered only when the
 * complete message carrying it is accepted into the parent
 * `Agent.state.messages` (`message_end`). Assembly, a `TaskWait` `execute`
 * return, a resolved prompt, and a successful model response are not that
 * boundary.
 *
 * These tests run the real pi-agent-core loop, the real runtime turn owner,
 * coordinator, and wake wait. Only the two real external boundaries are
 * replaced: the model gateway (`models.streamSimple`) and the delegate loop
 * (`SubagentRun`).
 */
const subagentRuns = vi.hoisted(() => ({
  calls: [] as any[],
  result: undefined as any,
  deferred: false,
  instances: [] as Array<{ resolve: (r: unknown) => void; settled: boolean }>,
  resolveRun: undefined as ((result: unknown) => void) | undefined,
}));
vi.mock("./subagent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent.js")>();
  return {
    ...actual,
    SubagentRun: class {
      private signal?: AbortSignal;
      constructor(options: unknown) {
        subagentRuns.calls.push(options);
        this.signal = (options as { signal?: AbortSignal }).signal;
      }
      progress() {
        return { toolCalls: 0, turns: 0 };
      }
      isSettled() {
        return false;
      }
      steer() {}
      run() {
        if (subagentRuns.deferred) {
          return new Promise((resolve) => {
            const instance = { resolve, settled: false };
            subagentRuns.instances.push(instance);
            subagentRuns.resolveRun = (result: unknown) => {
              const next = subagentRuns.instances.find((entry) => !entry.settled);
              if (next) {
                next.settled = true;
                next.resolve(result);
              }
            };
            this.signal?.addEventListener(
              "abort",
              () => {
                if (instance.settled) return;
                instance.settled = true;
                resolve({
                  agentName: "explorer",
                  status: "aborted",
                  report: "The delegated task was aborted.",
                  turns: 0,
                  toolCalls: 0,
                });
              },
              { once: true },
            );
          });
        }
        return Promise.resolve(
          subagentRuns.result ?? {
            agentName: "explorer",
            status: "completed",
            report: "done",
            turns: 1,
            toolCalls: 0,
          },
        );
      }
    },
  };
});

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "low", "medium", "high"],
  modelConfig: {
    source: "generic",
    name: "Local Catalog Model",
    baseUrl: "https://catalog.invalid/v1",
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: null, max: null },
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 256_000,
    maxTokens: 32_000,
  },
};

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

const explorer: SubagentDefinition = {
  name: "explorer",
  description: "Search the workspace and report findings.",
  tools: ["Read", "Glob", "Grep"],
  prompt: "Report file paths and line numbers.",
  source: "builtin",
};

function createRuntime(
  overrides: { onEvent?: (envelope: any) => void } = {},
) {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-1",
    mode: "agent",
    turnId: "parent-turn",
    provider,
    commandShell,
    thinkingLevel: "medium",
    subagents: [explorer],
    onEvent: overrides.onEvent ?? vi.fn(),
  });
}

type Internals = {
  agent: {
    state: { messages: AgentMessage[]; isStreaming: boolean };
    prompt: (input: unknown) => Promise<void>;
  };
  models: {
    streamSimple: (
      model: unknown,
      context: { messages: AgentMessage[] },
      options?: unknown,
    ) => ReturnType<typeof createAssistantMessageEventStream>;
  };
  delegations: Map<string, DelegationView>;
  deliveryReceipts: { pendingCount: number };
  resumeAfterDelegations: () => Promise<void>;
  handleAgentEvent: (event: unknown) => Promise<void>;
};

type DelegationView = {
  delegationId: string;
  status: string;
  delivery?: "parent" | "user";
  reportDelivered: boolean;
};

function internalsOf(runtime: DesktopAgentRuntime): Internals {
  return runtime as unknown as Internals;
}

function taskTool(runtime: DesktopAgentRuntime): AgentTool {
  const tool = (runtime as any).agent.state.tools.find(
    (entry: AgentTool) => entry.name === "Task",
  );
  if (!tool) throw new Error("Task tool missing");
  return tool;
}

function waitTool(runtime: DesktopAgentRuntime): AgentTool {
  const tool = (runtime as any).agent.state.tools.find(
    (entry: AgentTool) => entry.name === "TaskWait",
  );
  if (!tool) throw new Error("TaskWait tool missing");
  return tool;
}

function completedResult(report: string) {
  return {
    agentName: "explorer",
    status: "completed",
    report,
    turns: 2,
    toolCalls: 3,
  };
}

/** Minimal pi-ai assistant message; overrides carry the shape under test. */
function assistantMessage(overrides: {
  content: unknown[];
  stopReason?: string;
  errorMessage?: string;
}) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: overrides.stopReason ?? "stop",
    timestamp: 2,
    ...(overrides.errorMessage ? { errorMessage: overrides.errorMessage } : {}),
    content: overrides.content,
  } as unknown as AssistantMessage;
}

/** Push one complete model response and end the stream. */
function completeStream(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  message: AssistantMessage,
) {
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: (message.stopReason === "toolUse" ? "toolUse" : "stop"),
      message,
    } as any);
    stream.end(message);
  });
}

/** The text of an accepted message; tool results arrive as content blocks. */
function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/** Accepted user messages that carry the report: history proof, not a mock. */
function acceptedUserMessages(
  runtime: DesktopAgentRuntime,
  needle: string,
): AgentMessage[] {
  return internalsOf(runtime).agent.state.messages.filter(
    (message) => message.role === "user" && textOf(message).includes(needle),
  );
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function settleStatus(
  runtime: DesktopAgentRuntime,
  delegationId: string,
) {
  await vi.waitFor(() => {
    expect(internalsOf(runtime).delegations.get(delegationId)?.status).toBe(
      "completed",
    );
  });
}

/** Spawn one parent-owned delegation through the real Task tool. */
async function startDelegation(
  runtime: DesktopAgentRuntime,
  report: string,
  toolCallId = "task-1",
): Promise<string> {
  subagentRuns.result = completedResult(report);
  const started = await taskTool(runtime).execute(toolCallId, {
    agent: "explorer",
    task: "Find it.",
  });
  const delegationId = (started.details as { delegationId: string }).delegationId;
  await settleStatus(runtime, delegationId);
  return delegationId;
}

beforeEach(() => {
  subagentRuns.calls.length = 0;
  subagentRuns.instances.length = 0;
  subagentRuns.resolveRun = undefined;
  subagentRuns.result = undefined;
  subagentRuns.deferred = false;
});

describe("idle automatic delivery", () => {
  it("keeps the report pending when pi rejects the prompt before acceptance", async () => {
    const requests: string[] = [];
    let heldStream:
      | ReturnType<typeof createAssistantMessageEventStream>
      | undefined;
    const runtime = createRuntime();
    const internals = internalsOf(runtime);
    internals.models = {
      streamSimple: (_model, context) => {
        requests.push(JSON.stringify(context.messages));
        const stream = createAssistantMessageEventStream();
        if (requests.length === 1) {
          // Occupy the real agent: its run stays open until the test releases
          // the stream, so a second prompt is rejected by pi itself.
          heldStream = stream;
          return stream;
        }
        completeStream(
          stream,
          assistantMessage({ content: [{ type: "text", text: "Report received." }] }),
        );
        return stream;
      },
    };
    try {
      const occupied = internals.agent.prompt("Occupied turn");
      // The real run owns the agent and reaches the provider seam before the
      // prompt can be rejected.
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(internals.agent.state.isStreaming).toBe(true);
      const delegationId = await startDelegation(
        runtime,
        "Auto report across the acceptance boundary.",
      );
      const record = internals.delegations.get(delegationId)!;

      // pi rejects before it takes the message: no acceptance, no delivery.
      await expect(internals.resumeAfterDelegations()).rejects.toThrow(
        /already processing/,
      );
      expect(record.reportDelivered).toBe(false);
      expect(internals.deliveryReceipts.pendingCount).toBe(0);
      expect(
        acceptedUserMessages(runtime, "Auto report across the acceptance boundary."),
      ).toHaveLength(0);

      // Release the occupying run, then retry the resume on the real loop.
      const heldMessage = assistantMessage({
        content: [{ type: "text", text: "Occupied turn finished." }],
      });
      heldStream!.push({ type: "start", partial: heldMessage });
      heldStream!.push({ type: "done", reason: "stop", message: heldMessage });
      heldStream!.end(heldMessage);
      await occupied;

      await internals.resumeAfterDelegations();
      expect(record.reportDelivered).toBe(true);
      const delivered = acceptedUserMessages(
        runtime,
        "Auto report across the acceptance boundary.",
      );
      expect(delivered).toHaveLength(1);
      // The model request that followed carries the report exactly once.
      expect(occurrences(requests.at(-1) ?? "", "Auto report across the acceptance boundary.")).toBe(1);

      // A later resume cannot replay an accepted report.
      await internals.resumeAfterDelegations();
      expect(
        acceptedUserMessages(runtime, "Auto report across the acceptance boundary."),
      ).toHaveLength(1);
      expect(occurrences(requests.at(-1) ?? "", "Auto report across the acceptance boundary.")).toBe(1);
    } finally {
      if (heldStream) {
        const heldMessage = assistantMessage({
          content: [{ type: "text", text: "Released." }],
        });
        heldStream.push({ type: "done", reason: "stop", message: heldMessage });
        heldStream.end(heldMessage);
      }
      await runtime.dispose();
    }
  });

  it("keeps a report delivered once when the provider request after it fails", async () => {
    const requests: string[] = [];
    const runtime = createRuntime();
    const internals = internalsOf(runtime);
    internals.models = {
      streamSimple: (_model, context) => {
        requests.push(JSON.stringify(context.messages));
        const stream = createAssistantMessageEventStream();
        const round = requests.length;
        if (round === 1) {
          const partial = assistantMessage({
            content: [{ type: "text", text: "Partial answer." }],
          });
          const failure = assistantMessage({
            content: [{ type: "text", text: "Provider request failed." }],
            stopReason: "error",
            errorMessage: "provider request failed",
          });
          // A provider failure after the report was already accepted: the
          // prompt resolves with a synthesized error message.
          queueMicrotask(() => {
            stream.push({ type: "start", partial });
            stream.push({ type: "error", reason: "error", error: failure });
            stream.end(failure);
          });
          return stream;
        }
        completeStream(
          stream,
          assistantMessage({ content: [{ type: "text", text: "Retry answered." }] }),
        );
        return stream;
      },
    };
    try {
      const delegationId = await startDelegation(
        runtime,
        "Accepted report before the provider failure.",
      );
      const record = internals.delegations.get(delegationId)!;

      await internals.resumeAfterDelegations();
      expect(record.reportDelivered).toBe(true);
      expect(
        acceptedUserMessages(runtime, "Accepted report before the provider failure."),
      ).toHaveLength(1);
      // The failed request still carried the accepted report exactly once.
      expect(occurrences(requests[0], "Accepted report before the provider failure.")).toBe(1);

      // Accepted history is not replayed: the next idle resume sends nothing.
      const requestsBefore = requests.length;
      await internals.resumeAfterDelegations();
      expect(requests).toHaveLength(requestsBefore);
      expect(record.reportDelivered).toBe(true);
      expect(
        acceptedUserMessages(runtime, "Accepted report before the provider failure."),
      ).toHaveLength(1);

      // A user retry keeps the accepted report exactly once in its history.
      await runtime.prompt("Retry after the failure", "retry-user", "retry-turn");
      expect(occurrences(requests.at(-1) ?? "", "Accepted report before the provider failure.")).toBe(1);
      expect(record.reportDelivered).toBe(true);
      expect(
        acceptedUserMessages(runtime, "Accepted report before the provider failure."),
      ).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("explicit TaskWait delivery", () => {
  it("consumes the report only in the accepted tool result, not at assembly", async () => {
    const observed: Array<{ reportDelivered: boolean; pending: number }> = [];
    const runtime = createRuntime({
      onEvent: (envelope) => {
        const event = envelope.event;
        // `tool_end` for the TaskWait call is emitted after `execute` returned
        // and before pi accepts the tool result message into history.
        if (event?.type === "tool_end" && event.toolCallId === "wait-1") {
          const record = [...internals.delegations.values()][0];
          observed.push({
            reportDelivered: record?.reportDelivered ?? false,
            pending: internals.deliveryReceipts.pendingCount,
          });
        }
      },
    });
    const internals = internalsOf(runtime);
    internals.models = {
      streamSimple: (_model, context) => {
        const stream = createAssistantMessageEventStream();
        const round = (internals.models as unknown as { round?: number }).round ?? 1;
        (internals.models as unknown as { round?: number }).round = round + 1;
        const message = assistantMessage({
          content:
            round === 1
              ? [
                  {
                    type: "toolCall",
                    id: "task-1",
                    name: "Task",
                    arguments: { agent: "explorer", task: "Inspect the fixture." },
                  },
                ]
              : round === 2
                ? [
                    {
                      type: "toolCall",
                      id: "wait-1",
                      name: "TaskWait",
                      arguments: {},
                    },
                  ]
                : [{ type: "text", text: "Read the waited report." }],
          stopReason: round <= 2 ? "toolUse" : "stop",
        });
        completeStream(stream, message);
        return stream;
      },
    };
    try {
      await runtime.prompt("Wait for the delegate.", "user-1", "turn-1");
      // Assembly happened once, and it did not consume the report by itself.
      expect(observed).toEqual([{ reportDelivered: false, pending: 1 }]);
      const delegationId = [...internals.delegations.keys()][0]!;
      expect(internals.delegations.get(delegationId)!.reportDelivered).toBe(true);
      expect(internals.deliveryReceipts.pendingCount).toBe(0);
      const waited = internals.agent.state.messages.filter(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolCallId?: string }).toolCallId === "wait-1",
      );
      expect(waited).toHaveLength(1);
      expect(textOf(waited[0]!)).toContain("done");
    } finally {
      await runtime.dispose();
    }
  });

  it("does not consume an assembled result the loop replaced or failed", async () => {
    const runtime = createRuntime();
    const internals = internalsOf(runtime);
    try {
      const delegationId = await startDelegation(
        runtime,
        "Report that a replacement would drop.",
      );
      const record = internals.delegations.get(delegationId)!;
      const assembled = await waitTool(runtime).execute("wait-1", {
        delegationIds: [delegationId],
      });
      expect(assembled.details).toBeDefined();
      expect(record.reportDelivered).toBe(false);
      expect(internals.deliveryReceipts.pendingCount).toBe(1);

      // `afterToolCall` may replace a result before it becomes history: same
      // call id, different text. Assembly alone never consumes the report.
      await internals.handleAgentEvent({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "wait-1",
          toolName: "TaskWait",
          content: [{ type: "text", text: "Replacement result before history." }],
          isError: false,
          timestamp: Date.now(),
        },
      });
      expect(record.reportDelivered).toBe(false);
      expect(internals.deliveryReceipts.pendingCount).toBe(0);

      // The original text arriving later no longer proves this batch was the
      // accepted one, so it stays pending and the idle resume delivers it.
      await internals.handleAgentEvent({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "wait-1",
          toolName: "TaskWait",
          content: assembled.content,
          isError: false,
          timestamp: Date.now(),
        },
      });
      expect(record.reportDelivered).toBe(false);

      internals.models = {
        streamSimple: (_model, context) => {
          const stream = createAssistantMessageEventStream();
          const message = assistantMessage({
            content: [{ type: "text", text: "Report was delivered later." }],
          });
          expect(JSON.stringify(context.messages)).toContain(
            "Report that a replacement would drop.",
          );
          completeStream(stream, message);
          return stream;
        },
      };
      await internals.resumeAfterDelegations();
      expect(record.reportDelivered).toBe(true);
      expect(
        acceptedUserMessages(runtime, "Report that a replacement would drop."),
      ).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("batch boundaries", () => {
  it("delivers a >50k first report whole and defers the next report to a later batch", async () => {
    const runtime = createRuntime();
    const internals = internalsOf(runtime);
    const prompts: string[] = [];
    try {
      const oversized = `letter-a-${"a".repeat(60_000)}`;
      subagentRuns.result = completedResult(oversized);
      const firstStarted = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "First.",
      });
      const firstId = (firstStarted.details as { delegationId: string }).delegationId;
      await settleStatus(runtime, firstId);
      subagentRuns.result = completedResult(`second-report-${"b".repeat(2_000)}`);
      const secondStarted = await taskTool(runtime).execute("task-2", {
        agent: "explorer",
        task: "Second.",
      });
      const secondId = (secondStarted.details as { delegationId: string }).delegationId;
      await settleStatus(runtime, secondId);
      // A third settled report is an ordinary pending report like the others.
      subagentRuns.result = completedResult(`third-report-${"c".repeat(2_000)}`);
      const userStarted = await taskTool(runtime).execute("task-3", {
        agent: "explorer",
        task: "User work.",
      });
      const userId = (userStarted.details as { delegationId: string }).delegationId;
      await settleStatus(runtime, userId);

      const agent = internals.agent;
      agent.prompt = vi.fn(async (input: unknown) => {
        const text = typeof input === "string" ? input : textOf(input as AgentMessage);
        prompts.push(text);
        agent.state.messages.push({
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        });
        await internals.handleAgentEvent({
          type: "message_end",
          message: agent.state.messages.at(-1),
        });
      });
      (runtime as any).waitForIdleAndSteering = vi.fn(async () => undefined);

      // One resume converges a bounded batch each; the remaining settled
      // report waits for the next resume.
      await internals.resumeAfterDelegations();
      expect(prompts).toHaveLength(2);
      // The oversized first settled report is delivered whole, never truncated.
      expect(prompts[0]).toContain(oversized);
      expect(prompts[0]).not.toContain(`second-report-${"b".repeat(2_000)}`);
      expect(prompts[1]).toContain(`second-report-${"b".repeat(2_000)}`);
      expect(prompts[1]).not.toContain(oversized);
      expect(internals.delegations.get(firstId)!.reportDelivered).toBe(true);
      expect(internals.delegations.get(secondId)!.reportDelivered).toBe(true);
      // The third settled report is an ordinary pending report: it converges
      // in the same resume, into a batch of its own.
      expect(internals.delegations.get(userId)!.reportDelivered).toBe(true);
      expect(prompts.join("\n")).toContain(`third-report-${"c".repeat(2_000)}`);

      await internals.resumeAfterDelegations();
      expect(prompts).toHaveLength(2);
      expect(acceptedUserMessages(runtime, oversized)).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("receipt lifecycle", () => {
  it("drops pending receipts on run end and dispose without marking the report", async () => {
    const runtime = createRuntime();
    const internals = internalsOf(runtime);
    try {
      const delegationId = await startDelegation(
        runtime,
        "Report whose receipt never reaches history.",
      );
      const record = internals.delegations.get(delegationId)!;
      await waitTool(runtime).execute("wait-1", { delegationIds: [delegationId] });
      expect(internals.deliveryReceipts.pendingCount).toBe(1);
      expect(record.reportDelivered).toBe(false);

      await internals.handleAgentEvent({ type: "agent_end", messages: [] });
      expect(internals.deliveryReceipts.pendingCount).toBe(0);
      expect(record.reportDelivered).toBe(false);
    } finally {
      await runtime.dispose();
    }
    // Dispose after a pending receipt also leaves the report undelivered.
    const pendingRuntime = createRuntime();
    const pending = internalsOf(pendingRuntime);
    const delegationId = await startDelegation(
      pendingRuntime,
      "Report left pending at dispose.",
    );
    const record = pending.delegations.get(delegationId)!;
    await waitTool(pendingRuntime).execute("wait-1", {
      delegationIds: [delegationId],
    });
    expect(pending.deliveryReceipts.pendingCount).toBe(1);
    await pendingRuntime.dispose();
    expect(pending.deliveryReceipts.pendingCount).toBe(0);
    expect(record.reportDelivered).toBe(false);
  });
});
