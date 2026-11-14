import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./runtime.js";
import type {
  CommandShellOption,
  SubagentDefinition,
  UiMessage,
} from "@pi-desktop/shared";

/**
 * User intervention is communication with a child, not ownership of it.
 *
 * These are the two lifecycle facts the product contract rests on: a child the
 * user started or continued runs independently of the parent turn, and a main
 * prompt sent while it runs is accepted without cancelling it or corrupting
 * either turn. The delegate loop is replaced by a recorder (as in
 * `runtime.test.ts`); every other export stays real.
 */
const subagentRuns = vi.hoisted(() => ({
  calls: [] as any[],
  result: undefined as any,
  deferred: false,
  instances: [] as Array<{ resolve: (r: unknown) => void; settled: boolean }>,
  resolveRun: undefined as ((result: unknown) => void) | undefined,
  steered: [] as string[],
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
      steer(text: string) {
        subagentRuns.steered.push(String(text));
      }
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

function createRuntime(overrides: { turnId?: string } = {}) {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-1",
    mode: "agent",
    turnId: overrides.turnId ?? "parent-turn",
    provider,
    commandShell,
    thinkingLevel: "medium",
    subagents: [explorer],
    onEvent: vi.fn(),
  });
}

function tool(runtime: DesktopAgentRuntime, name: string): AgentTool {
  return (runtime as any).agent.state.tools.find((entry: any) => entry.name === name);
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

async function settleStatus(runtime: DesktopAgentRuntime, delegationId: string) {
  await vi.waitFor(() => {
    expect((runtime as any).delegations.get(delegationId).status).toBe("completed");
  });
}

/** pi-agent-core's acceptance step for a stubbed parent prompt. */
async function acceptUserRow(runtime: DesktopAgentRuntime, text: string) {
  const agent = (runtime as any).agent;
  agent.state.messages.push({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
  await (runtime as any).handleAgentEvent({
    type: "message_end",
    message: agent.state.messages.at(-1),
  });
}

function stubAcceptedPrompt(runtime: DesktopAgentRuntime, prompts: string[]) {
  const handle = (runtime as any).handleAgentEvent.bind(runtime);
  const agent = (runtime as any).agent;
  agent.prompt = vi.fn(async (text: string) => {
    prompts.push(text);
    await acceptUserRow(runtime, text);
    const reply = { id: "reply-1", role: "assistant", content: "ok", status: "complete" };
    agent.state.messages.push(reply);
    await handle({ type: "agent_start" });
    await handle({ type: "message_start", message: reply });
    await handle({ type: "message_end", message: reply });
    await handle({ type: "turn_end" });
    await handle({ type: "agent_end", messages: [] });
  });
  agent.waitForIdle = vi.fn(async () => undefined);
}

beforeEach(() => {
  subagentRuns.calls.length = 0;
  subagentRuns.instances.length = 0;
  subagentRuns.resolveRun = undefined;
  subagentRuns.steered.length = 0;
  subagentRuns.result = undefined;
  subagentRuns.deferred = false;
});

describe("a child the user started runs independently of the parent turn", () => {
  it("accepts a main prompt while the child runs without cancelling it", async () => {
    const runtime = createRuntime();
    const prompts: string[] = [];
    stubAcceptedPrompt(runtime, prompts);
    try {
      // A settled, already-delivered first run ends its parent attachment.
      subagentRuns.result = completedResult("First report.");
      const started = await tool(runtime, "Task").execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      await settleStatus(runtime, firstId);
      expect((runtime as any).delegations.get(firstId).reportDelivered).toBe(false);

      // The delegate tab continues it: no parent turn is live right now.
      subagentRuns.deferred = true;
      const continued = await runtime.continueSubagent({
        delegationId: firstId,
        text: "Deeper on the parser.",
      });
      expect(continued.accepted).toBe(true);
      const record = (runtime as any).delegations.get(continued.delegationId);
      expect(record.parentTurnId).toBeUndefined();
      expect(record.status).toBe("running");

      // The user types a new main prompt while the child is still working.
      const newTurn = await runtime.prompt("Also check the docs.", "user-2", "turn-2");
      expect(newTurn.turnId).toBe("turn-2");
      expect(prompts).toEqual(["Also check the docs."]);
      // The child was neither cancelled nor aborted by the new parent epoch.
      expect(record.status).toBe("running");
      expect(subagentRuns.instances.some((entry) => entry.settled)).toBe(false);
      // The main turn ended on its own: a lone child never fakes it running.
      expect(runtime.getStatus().isRunning).toBe(false);

      subagentRuns.resolveRun!(completedResult("Parser notes."));
      await settleStatus(runtime, continued.delegationId);

      // The next parent turn reads the run through the normal interfaces.
      const listed = await tool(runtime, "TaskList").execute("list-1", {});
      expect(
        (listed.details.delegations as Array<{ delegationId: string }>).some(
          (entry) => entry.delegationId === continued.delegationId,
        ),
      ).toBe(true);
      const waited = await tool(runtime, "TaskWait").execute("wait-1", {
        delegationIds: [continued.delegationId],
      });
      expect((waited.content[0] as { text: string }).text).toContain("Parser notes.");
      // Closed parent accounting was not rewritten by the child's spend.
      expect((runtime as any).turnSubagentUsage).toBeUndefined();
      expect(record.usage).toBeUndefined();
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("continues a chain after the parent turn was aborted, without a parent prompt", async () => {
    const runtime = createRuntime();
    const prompts: string[] = [];
    stubAcceptedPrompt(runtime, prompts);
    subagentRuns.result = completedResult("First report.");
    try {
      const started = await tool(runtime, "Task").execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      await settleStatus(runtime, firstId);

      // The user aborts the main turn, then intervenes in the child from its tab.
      await runtime.abort();
      subagentRuns.deferred = true;
      const continued = await runtime.continueSubagent({
        delegationId: firstId,
        text: "Keep going without me.",
        expectedParentTurnId: "turn-that-ended",
      });
      expect(continued.accepted).toBe(true);
      const record = (runtime as any).delegations.get(continued.delegationId);
      expect(record.parentTurnId).toBeUndefined();
      expect(record.status).toBe("running");
      // No parent provider request or wake was fired for the aborted turn.
      expect(prompts).toEqual([]);

      subagentRuns.resolveRun!(completedResult("Independent report."));
      await settleStatus(runtime, continued.delegationId);
      const waited = await tool(runtime, "TaskWait").execute("wait-1", {
        delegationIds: [continued.delegationId],
      });
      expect((waited.content[0] as { text: string }).text).toContain("Independent report.");
      expect(runtime.getStatus().isRunning).toBe(false);
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("still guards a second continuation of the same running chain", async () => {
    const runtime = createRuntime();
    subagentRuns.deferred = true;
    try {
      subagentRuns.result = completedResult("First report.");
      const started = await tool(runtime, "Task").execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      subagentRuns.resolveRun!(completedResult("First report."));
      await settleStatus(runtime, firstId);

      const continued = await runtime.continueSubagent({
        delegationId: firstId,
        text: "Deeper.",
      });
      expect(continued.accepted).toBe(true);
      // The chain has a live run: a second continuation steers instead.
      await expect(
        runtime.continueSubagent({ delegationId: continued.delegationId, text: "Again." }),
      ).rejects.toMatchObject({ errorCode: "CHAIN_BUSY" });
      // Steering the live run is the accepted intervention.
      expect(
        runtime.steerSubagent({ delegationId: continued.delegationId, text: "Also check auth." })
          .accepted,
      ).toBe(true);
      expect(subagentRuns.steered).toEqual(["Also check auth."]);
      subagentRuns.resolveRun!(completedResult("Deeper report."));
      await settleStatus(runtime, continued.delegationId);
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });
});

describe("historical rows keep reading as normal children", () => {
  it("ignores a persisted delivery marker and hydrates the chain", async () => {
    const row = (toolCallId: string, details: Record<string, unknown>): UiMessage =>
      ({
        id: toolCallId,
        role: "tool",
        content: JSON.stringify({ details }),
        createdAt: new Date(1_700_000_000_000).toISOString(),
        toolCallId,
        toolName: "Task",
        toolArgs: { agent: "explorer", task: "Explore the parser." },
        toolResult: { details },
        toolStatus: "success",
        status: "complete",
      }) as UiMessage;
    const runtime = new DesktopAgentRuntime({
      host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
      sessionId: "session-1",
      mode: "agent",
      provider,
      commandShell,
      thinkingLevel: "medium",
      subagents: [explorer],
      // A row written by the retired ownership model.
      history: [
        row("task-old", {
          delegationId: "del-old",
          agent: "explorer",
          status: "completed",
          delivery: "user",
          executionTurnId: "old-exec",
        }),
      ],
      onEvent: vi.fn(),
    });
    try {
      subagentRuns.result = completedResult("Followed up.");
      const continued = await runtime.continueSubagent({
        delegationId: "del-old",
        text: "Keep going.",
      });
      expect(continued.accepted).toBe(true);
      const record = (runtime as any).delegations.get(continued.delegationId);
      expect(record.parentTurnId).toBeUndefined();
      await settleStatus(runtime, continued.delegationId);
    } finally {
      await runtime.dispose();
    }
  });
});
