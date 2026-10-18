import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./runtime.js";
import type {
  CommandShellOption,
  SubagentDefinition,
  UiMessage,
} from "@pi-desktop/shared";

/**
 * Delivery-ownership acceptance for direct user continuations: the parent
 * receives a run's report only while it expects THIS chain
 * (startedEpoch == turnEpoch, undelivered, not stopped/aborted, owning turn
 * alive). Anything else continues user-owned: no parent prompt, no parent
 * context, no billing of an unrelated turn.
 *
 * The delegate loop is replaced by a recorder (as in `runtime.test.ts`);
 * every other export stays real.
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

function createRuntime(overrides: { turnId?: string; onEvent?: (envelope: any) => void } = {}) {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-1",
    mode: "agent",
    turnId: overrides.turnId ?? "parent-turn",
    provider,
    commandShell,
    thinkingLevel: "medium",
    subagents: [explorer],
    onEvent: overrides.onEvent ?? vi.fn(),
  });
}

function taskTool(runtime: DesktopAgentRuntime): AgentTool {
  return (runtime as any).agent.state.tools.find((tool: any) => tool.name === "Task");
}

function waitTool(runtime: DesktopAgentRuntime): AgentTool {
  return (runtime as any).agent.state.tools.find((tool: any) => tool.name === "TaskWait");
}

function listTool(runtime: DesktopAgentRuntime): AgentTool {
  return (runtime as any).agent.state.tools.find((tool: any) => tool.name === "TaskList");
}

function completedResult(report: string, usage?: unknown) {
  return {
    agentName: "explorer",
    status: "completed",
    report,
    turns: 2,
    toolCalls: 3,
    ...(usage ? { usage } : {}),
  };
}

/** Seed one child assistant row so the chain has replayable history. */
function seedChildRow(runtime: DesktopAgentRuntime, parentToolCallId: string, id: string) {
  (runtime as any).transcriptHistory.push({
    id,
    role: "assistant",
    content: "reading src/app.ts",
    createdAt: new Date().toISOString(),
    status: "complete",
    parentToolCallId,
    agentName: "explorer",
  });
}

async function settleStatus(runtime: DesktopAgentRuntime, delegationId: string) {
  await vi.waitFor(() => {
    expect((runtime as any).delegations.get(delegationId).status).toBe("completed");
  });
}

beforeEach(() => {
  subagentRuns.calls.length = 0;
  subagentRuns.instances.length = 0;
  subagentRuns.resolveRun = undefined;
  subagentRuns.steered.length = 0;
  subagentRuns.result = undefined;
  subagentRuns.deferred = false;
});

describe("attached continuation", () => {
  it("running steer stays attached and its report delivers exactly once", async () => {
    const seen: any[] = [];
    const runtime = createRuntime({ onEvent: (envelope) => seen.push(envelope) });
    (runtime as any).agent.prompt = vi.fn(async () => undefined);
    (runtime as any).agent.waitForIdle = vi.fn(async () => undefined);
    const prompts: string[] = [];
    (runtime as any).agent.prompt = vi.fn(async (text: string) => {
      prompts.push(text);
    });
    subagentRuns.deferred = true;
    try {
      subagentRuns.result = completedResult("Found it.");
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const delegationId = (started.details as any).delegationId as string;
      const steered = runtime.steerSubagent({
        delegationId,
        expectedParentTurnId: "parent-turn",
        text: "Focus on auth.",
      });
      expect(steered).toEqual({ accepted: true, delegationId, turnId: "parent-turn" });
      expect(subagentRuns.steered).toEqual(["Focus on auth."]);
      subagentRuns.resolveRun!(completedResult("Found it."));
      await settleStatus(runtime, delegationId);
      await (runtime as any).resumeAfterDelegations();
      expect((runtime as any).delegations.get(delegationId).reportDelivered).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Found it.");
      expect(prompts.join("\n")).not.toContain("Focus on auth.");
      await (runtime as any).resumeAfterDelegations();
      expect(prompts).toHaveLength(1);
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("pending settled source continues attached under the live turn", async () => {
    const runtime = createRuntime();
    (runtime as any).agent.state.isStreaming = true;
    try {
      subagentRuns.result = completedResult("First report.");
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      await settleStatus(runtime, firstId);
      seedChildRow(runtime, "task-1", "child-1");
      subagentRuns.result = completedResult("Deeper findings.");
      const continued = await runtime.continueSubagent({
        delegationId: firstId,
        expectedParentTurnId: "parent-turn",
        text: "Go deeper.",
      });
      expect(continued.delivery).toBe("parent");
      expect(continued.turnId).toBe("parent-turn");
      const record = (runtime as any).delegations.get(continued.delegationId);
      expect(record.delivery).toBe("parent");
      expect(record.startedEpoch).toBe((runtime as any).turnEpoch);
      expect(record.reportDelivered).toBe(false);
      const waited = await waitTool(runtime).execute("wait-1", {
        delegationIds: [continued.delegationId],
      });
      expect((waited.content[0] as { text: string }).text).toContain("Deeper findings.");
      expect(record.reportDelivered).toBe(true);
    } finally {
      (runtime as any).agent.state.isStreaming = false;
      await runtime.dispose();
    }
  });
});

describe("detached user continuation", () => {
  it("delivered source continues user-owned with no parent prompt, context, or billing", async () => {
    const seen: any[] = [];
    const runtime = createRuntime({ onEvent: (envelope) => seen.push(envelope) });
    const prompts: string[] = [];
    (runtime as any).agent.prompt = vi.fn(async (text: string) => {
      prompts.push(text);
    });
    (runtime as any).agent.waitForIdle = vi.fn(async () => undefined);
    try {
      subagentRuns.result = completedResult("First report.", {
        operationId: "op-1",
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
      });
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      await settleStatus(runtime, firstId);
      seedChildRow(runtime, "task-1", "child-1");
      // Deliver the first report so the parent no longer expects this chain.
      await waitTool(runtime).execute("wait-0", { delegationIds: [firstId] });
      expect((runtime as any).delegations.get(firstId).reportDelivered).toBe(true);
      expect((runtime as any).getStatus().isRunning).toBe(false);

      const historyBefore = (runtime as any).transcriptHistory.length;
      const continued = await runtime.continueSubagent({
        delegationId: firstId,
        text: "Go deeper on your own.",
        messageId: "123e4567-e89b-12d3-a456-426614174000",
      });
      expect(continued.accepted).toBe(true);
      expect(continued.delivery).toBe("user");
      expect(continued.turnId).toBeDefined();
      expect(continued.turnId).not.toBe("parent-turn");
      const record = (runtime as any).delegations.get(continued.delegationId);
      expect(record.delivery).toBe("user");
      expect(record.executionTurnId).toBe(continued.turnId);
      // No parent model call ran for the detached execution.
      expect(prompts).toHaveLength(0);
      // The followup persists as attributed child history, never a main row.
      const history = (runtime as any).transcriptHistory as UiMessage[];
      expect(history.length).toBeGreaterThan(historyBefore);
      const echo = history.filter(
        (row) => row.role === "user" && row.content === "Go deeper on your own.",
      );
      expect(echo).toHaveLength(1);
      expect(echo[0].parentToolCallId).toBeDefined();
      expect(echo[0].agentName).toBe("explorer");
      const marker = history.filter(
        (row) => row.role === "tool" && row.toolName === "Task" && row.toolCallId === echo[0].parentToolCallId,
      );
      expect(marker).toHaveLength(1);
      expect(marker[0].parentToolCallId).toBeUndefined();
      expect(marker[0].toolArgs).toMatchObject({ source: "user", resume: firstId });
      // Marker emits as a parent ledger row; the followup emits tagged.
      const markerEnd = seen.find(
        (envelope) =>
          envelope.event.type === "message_end" &&
          envelope.event.message?.id === marker[0].id,
      );
      expect(markerEnd.parentToolCallId).toBeUndefined();
      const followupEnd = seen.filter(
        (envelope) =>
          envelope.event.type === "message_end" &&
          envelope.event.message?.content === "Go deeper on your own.",
      );
      expect(followupEnd.length).toBeGreaterThan(0);
      for (const envelope of followupEnd) {
        expect(envelope.parentToolCallId).toBe(echo[0].parentToolCallId);
      }

      // The first parent-owned run's spend stays where it settled.
      const parentUsageBefore = JSON.stringify((runtime as any).turnSubagentUsage);
      await settleStatus(runtime, continued.delegationId);
      // Child spend lands on its own record, never merged into another turn.
      expect(record.usage?.totalTokens).toBe(12);
      expect(JSON.stringify((runtime as any).turnSubagentUsage)).toBe(parentUsageBefore);
      // The detached execution closes its own turn without a parent conclusion.
      const terminal = seen.find(
        (envelope) =>
          (envelope.event.type === "agent_end" || envelope.event.type === "error") &&
          envelope.turnId === continued.turnId,
      );
      expect(terminal?.event.type).toBe("agent_end");
      // Parent accounting excludes the user-owned run.
      const listed = await listTool(runtime).execute("list-1", {});
      expect(
        (listed.details.delegations as Array<{ delegationId: string }>).some(
          (entry) => entry.delegationId === continued.delegationId,
        ),
      ).toBe(false);
      const waited = await waitTool(runtime).execute("wait-1", {});
      expect((waited.content[0] as { text: string }).text).toContain("No subagents are currently running");
      const named = await waitTool(runtime).execute("wait-2", {
        delegationIds: [continued.delegationId],
      });
      expect(named.details.unknownIds).toContain(continued.delegationId);
      expect(record.reportDelivered).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it("chains two user followups and steers the detached run by its execution turn", async () => {
    const runtime = createRuntime();
    subagentRuns.deferred = true;
    try {
      subagentRuns.result = completedResult("First report.");
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      subagentRuns.resolveRun!(completedResult("First report."));
      await settleStatus(runtime, firstId);
      seedChildRow(runtime, "task-1", "child-1");
      await waitTool(runtime).execute("wait-0", { delegationIds: [firstId] });

      const one = await runtime.continueSubagent({ delegationId: firstId, text: "First followup." });
      expect(one.delivery).toBe("user");
      const steered = runtime.steerSubagent({
        delegationId: one.delegationId,
        expectedParentTurnId: one.turnId!,
        text: "Meanwhile, check auth.",
      });
      expect(steered).toEqual({ accepted: true, delegationId: one.delegationId, turnId: one.turnId });
      expect(subagentRuns.steered).toEqual(["Meanwhile, check auth."]);
      // The live parent turn (there is none) cannot steer a detached run.
      expect(() =>
        runtime.steerSubagent({
          delegationId: one.delegationId,
          expectedParentTurnId: "parent-turn",
          text: "Wrong owner.",
        }),
      ).toThrow(expect.objectContaining({ errorCode: "TURN_NOT_FOUND" }));
      subagentRuns.resolveRun!(completedResult("Second report."));
      await settleStatus(runtime, one.delegationId);

      const two = await runtime.continueSubagent({ delegationId: one.delegationId, text: "Second followup." });
      expect(two.delivery).toBe("user");
      const chains = (runtime as any).delegationChains;
      expect(chains.lookup(two.delegationId).delegateSessionId).toBe(
        chains.lookup(one.delegationId).delegateSessionId,
      );
      const history = (runtime as any).transcriptHistory as UiMessage[];
      const followups = history.filter(
        (row) => row.role === "user" && typeof row.content === "string" && row.content.endsWith("followup."),
      );
      expect(followups.map((row) => row.content).sort()).toEqual([
        "First followup.",
        "Second followup.",
      ]);
      subagentRuns.resolveRun!(completedResult("Third report."));
      await settleStatus(runtime, two.delegationId);
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("explicit parent Task(resume) reattaches a user-owned chain", async () => {
    const runtime = createRuntime();
    try {
      subagentRuns.result = completedResult("First report.");
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      await settleStatus(runtime, firstId);
      seedChildRow(runtime, "task-1", "child-1");
      await waitTool(runtime).execute("wait-0", { delegationIds: [firstId] });
      const one = await runtime.continueSubagent({ delegationId: firstId, text: "User followup." });
      expect(one.delivery).toBe("user");
      await settleStatus(runtime, one.delegationId);

      const resumed = await taskTool(runtime).execute("task-9", {
        agent: "explorer",
        task: "Parent takes it back.",
        resume: one.delegationId,
      });
      const resumedId = (resumed.details as any).delegationId as string;
      const record = (runtime as any).delegations.get(resumedId);
      expect(record.delivery).toBe("parent");
      const listed = await listTool(runtime).execute("list-1", {});
      expect(
        (listed.details.delegations as Array<{ delegationId: string }>).some(
          (entry) => entry.delegationId === resumedId,
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("continue guards", () => {
  it("rejects busy instead of attaching a detached source to a live parent", async () => {
    const runtime = createRuntime();
    (runtime as any).agent.state.isStreaming = true;
    try {
      subagentRuns.result = completedResult("First report.");
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      await settleStatus(runtime, firstId);
      const delegationsBefore = (runtime as any).delegations.size;
      const historyBefore = (runtime as any).transcriptHistory.length;
      await expect(
        runtime.continueSubagent({ delegationId: firstId, text: "Barge in." }),
      ).rejects.toMatchObject({ errorCode: "AGENT_BUSY" });
      expect((runtime as any).delegations.size).toBe(delegationsBefore);
      expect((runtime as any).transcriptHistory.length).toBe(historyBefore);
    } finally {
      (runtime as any).agent.state.isStreaming = false;
      await runtime.dispose();
    }
  });

  it("refuses a stale expected turn against a live parent", async () => {
    const runtime = createRuntime();
    (runtime as any).agent.state.isStreaming = true;
    try {
      subagentRuns.result = completedResult("First report.");
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      await settleStatus(runtime, firstId);
      await expect(
        runtime.continueSubagent({
          delegationId: firstId,
          expectedParentTurnId: "other-turn",
          text: "Late.",
        }),
      ).rejects.toMatchObject({ errorCode: "TURN_NOT_FOUND" });
      expect((runtime as any).delegations.size).toBe(1);
    } finally {
      (runtime as any).agent.state.isStreaming = false;
      await runtime.dispose();
    }
  });

  it("dedups a retried continuation message id to one spawn", async () => {
    const runtime = createRuntime();
    subagentRuns.deferred = true;
    try {
      subagentRuns.result = completedResult("First report.");
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      subagentRuns.resolveRun!(completedResult("First report."));
      await settleStatus(runtime, firstId);
      seedChildRow(runtime, "task-1", "child-1");
      await waitTool(runtime).execute("wait-0", { delegationIds: [firstId] });
      const callsBefore = subagentRuns.calls.length;
      const messageId = "123e4567-e89b-12d3-a456-426614174001";
      const one = await runtime.continueSubagent({
        delegationId: firstId,
        text: "Retry me.",
        messageId,
      });
      const two = await runtime.continueSubagent({
        delegationId: firstId,
        text: "Retry me.",
        messageId,
      });
      expect(two.delegationId).toBe(one.delegationId);
      expect(subagentRuns.calls.length).toBe(callsBefore + 1);
      subagentRuns.resolveRun!(completedResult("Followup."));
      await settleStatus(runtime, one.delegationId);
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("continues a stopped, rowless chain from its original task", async () => {
    const runtime = createRuntime();
    try {
      // A stop that landed before the first child event: the chain has its
      // original brief but no child rows. The new input continues it.
      (runtime as any).transcriptHistory.push({
        id: "task-stopped",
        role: "tool",
        content: "",
        createdAt: new Date().toISOString(),
        toolCallId: "task-stopped",
        toolName: "Task",
        toolArgs: { agent: "explorer", task: "Explore the parser." },
        toolResult: {
          details: { delegationId: "del-stopped", agent: "explorer", status: "stopped" },
        },
        toolStatus: "success",
      });
      const historyModule = await import("./delegation-history.js");
      (runtime as any).delegationChains.hydrate(
        historyModule.rebuildChainsFromTranscript((runtime as any).transcriptHistory),
      );
      const continued = await runtime.continueSubagent({
        delegationId: "del-stopped",
        text: "Pick it back up.",
      });
      expect(continued.accepted).toBe(true);
      expect(continued.delivery).toBe("user");
      // Seeded with the original brief, then the new input — no fabricated rows.
      const seeded = subagentRuns.calls.at(-1)?.initialMessages ?? [];
      expect(seeded.map((message: { role: string }) => message.role)).toEqual(["user"]);
      expect(JSON.stringify(seeded[0]?.content)).toContain("Explore the parser.");
      expect(seeded.some((message: { role: string }) => message.role === "assistant")).toBe(
        false,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects a chain whose transcript lost its original task", async () => {
    const runtime = createRuntime();
    try {
      (runtime as any).transcriptHistory.push({
        id: "task-malformed",
        role: "tool",
        content: "",
        createdAt: new Date().toISOString(),
        toolCallId: "task-malformed",
        toolName: "Task",
        // No `task` brief survives: the chain cannot be seeded.
        toolArgs: { agent: "explorer" },
        toolResult: {
          details: { delegationId: "del-malformed", agent: "explorer", status: "completed" },
        },
        toolStatus: "success",
      });
      const historyModule = await import("./delegation-history.js");
      (runtime as any).delegationChains.hydrate(
        historyModule.rebuildChainsFromTranscript((runtime as any).transcriptHistory),
      );
      await expect(
        runtime.continueSubagent({ delegationId: "del-malformed", text: "Continue." }),
      ).rejects.toMatchObject({ errorCode: "NOT_RESUMABLE" });
    } finally {
      await runtime.dispose();
    }
  });
});

describe("post-restart hydration continuation", () => {
  it.each(["completed", "failed", "interrupted", "stopped", "aborted"] as const)(
    "a %s chain continues user-owned with no parent prompt after restart",
    async (status) => {
      // Post-restart: a fresh idle runtime hydrated from the persisted
      // transcript only (no live parent turn, no in-memory delegation
      // records). Delivery must be `user` from real turn liveness — never a
      // parent expectation reconstructed from the old record alone.
      const delegationId = `del-restart-${status}`;
      const toolCallId = `task-restart-${status}`;
      const rows: UiMessage[] = [
        {
          id: toolCallId,
          role: "tool",
          content: "",
          createdAt: new Date().toISOString(),
          toolCallId,
          toolName: "Task",
          toolArgs: { agent: "explorer", task: "Survey the cache." },
          toolResult: {
            details: {
              delegationId,
              agent: "explorer",
              status,
              modelId: "local-model",
              toolCalls: 2,
              turns: 1,
            },
          },
          toolStatus: status === "failed" ? "error" : "success",
          status: "complete",
        } as UiMessage,
        {
          id: `child-restart-${status}`,
          role: "assistant",
          content: "surveyed src/cache.ts",
          createdAt: new Date().toISOString(),
          status: "complete",
          parentToolCallId: toolCallId,
          agentName: "explorer",
        } as UiMessage,
      ];
      const seen: any[] = [];
      const restarted = new DesktopAgentRuntime({
        host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
        sessionId: "session-1",
        mode: "agent",
        provider,
        commandShell,
        thinkingLevel: "medium",
        subagents: [explorer],
        history: rows,
        onEvent: (envelope: any) => seen.push(envelope),
      });
      const prompts: string[] = [];
      (restarted as any).agent.prompt = vi.fn(async (text: string) => {
        prompts.push(text);
      });
      (restarted as any).agent.waitForIdle = vi.fn(async () => undefined);
      try {
        expect((restarted as any).getStatus().isRunning).toBe(false);
        subagentRuns.result = completedResult("Followup findings.");
        const callsBefore = subagentRuns.calls.length;
        const continued = await restarted.continueSubagent({
          delegationId,
          text: "Follow up after restart.",
        });
        expect(continued.accepted).toBe(true);
        expect(continued.delivery).toBe("user");
        expect(continued.turnId).toBeDefined();
        // No parent model request ran for the detached execution.
        expect(prompts).toHaveLength(0);
        // The child spawned exactly once under its own accounting turn.
        expect(subagentRuns.calls.length).toBe(callsBefore + 1);
        const record = (restarted as any).delegations.get(continued.delegationId);
        expect(record.delivery).toBe("user");
        expect(record.executionTurnId).toBe(continued.turnId);
        // Every emitted row is owned by the execution turn, never the parent.
        expect(seen.length).toBeGreaterThan(0);
        for (const envelope of seen) {
          expect(envelope.turnId).toBe(continued.turnId);
        }
      } finally {
        await restarted.dispose();
      }
    },
  );
});
