import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./runtime.js";
import type {
  CommandShellOption,
  SubagentDefinition,
} from "@pi-desktop/shared";

/**
 * Explicit TaskWait on an independent continuation across parent turns.
 *
 * Path: parent turn fails -> the user continues the settled chain manually
 * (`continueSubagent`, so the new run has no live parent turn) -> a new
 * parent turn begins -> the main agent explicitly waits for the new run's id.
 * The wait must park until that run settles and then deliver its report;
 * the default (id-less) wait still sees only the current turn.
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

function createRuntime() {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-1",
    mode: "agent",
    turnId: "parent-turn",
    provider,
    commandShell,
    thinkingLevel: "medium",
    subagents: [explorer],
    onEvent: vi.fn(),
  });
}

function taskTool(runtime: DesktopAgentRuntime): AgentTool {
  return (runtime as any).agent.state.tools.find((tool: any) => tool.name === "Task");
}

function waitTool(runtime: DesktopAgentRuntime): AgentTool {
  return (runtime as any).agent.state.tools.find((tool: any) => tool.name === "TaskWait");
}

async function settleStatus(runtime: DesktopAgentRuntime, delegationId: string) {
  await vi.waitFor(() => {
    expect((runtime as any).delegations.get(delegationId).status).toBe("completed");
  });
}

/**
 * pi-agent-core's acceptance step: an accepted message is pushed into
 * `state.messages` first, then `message_end` listeners run. A `TaskWait`
 * report batch is delivered there, never when the tool merely returns.
 */
async function acceptAcceptedMessage(runtime: DesktopAgentRuntime, message: unknown) {
  const agent = (runtime as any).agent;
  agent.state.messages.push(message);
  await (runtime as any).handleAgentEvent({ type: "message_end", message });
}

async function acceptTaskWaitResult(
  runtime: DesktopAgentRuntime,
  toolCallId: string,
  result: { content: unknown; details?: unknown },
) {
  await acceptAcceptedMessage(runtime, {
    role: "toolResult",
    toolCallId,
    toolName: "TaskWait",
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  });
}

beforeEach(() => {
  subagentRuns.calls.length = 0;
  subagentRuns.instances.length = 0;
  subagentRuns.resolveRun = undefined;
  subagentRuns.result = undefined;
  subagentRuns.deferred = false;
});

describe("explicit TaskWait on an independent continuation across turns", () => {
  it("waits for the new run's id into the next turn and delivers its report", async () => {
    const runtime = createRuntime();
    subagentRuns.deferred = true;
    try {
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      subagentRuns.resolveRun!({
        agentName: "explorer",
        status: "completed",
        report: "First report.",
        turns: 1,
        toolCalls: 1,
      });
      await settleStatus(runtime, firstId);
      // Replayable child row so the resume seed can rebuild the chain.
      (runtime as any).transcriptHistory.push({
        id: "child-1",
        role: "assistant",
        content: "reading src/app.ts",
        createdAt: new Date().toISOString(),
        status: "complete",
        parentToolCallId: "task-1",
        agentName: "explorer",
      });
      // The parent turn fails; the user continues the settled chain manually.
      (runtime as any).turnHadError = true;
      (runtime as any).agent.state.isStreaming = false;
      const continued = await runtime.continueSubagent({
        delegationId: firstId,
        text: "Go deeper on your own.",
      });
      const newId = continued.delegationId;
      const record = (runtime as any).delegations.get(newId);
      expect(record.parentTurnId).toBeUndefined();
      expect(record.userOrigin).toBe(true);
      expect(record.status).toBe("running");
      // A new parent turn begins; the independent run must survive it.
      (runtime as any).turnId = "new-turn";
      (runtime as any).turnEpoch += 1;
      (runtime as any).turnHadError = false;
      (runtime as any).runCancelled = false;
      (runtime as any).abortDelegationsFromPreviousTurns();
      expect((runtime as any).delegations.get(newId).status).toBe("running");
      // The default wait still targets only the current turn: the independent
      // run is invisible without an explicit id.
      const idle = await waitTool(runtime).execute("wait-idle", {});
      expect((idle.content[0] as { text: string }).text).toBe(
        "No subagents are currently running.",
      );
      // The explicit wait must stay parked until the run settles — draining
      // microtasks must not resolve it early.
      const waiting = waitTool(runtime).execute("wait-1", {
        delegationIds: [newId],
      });
      let resolved = false;
      void waiting.then(() => {
        resolved = true;
      });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(resolved).toBe(false);
      expect((runtime as any).delegations.get(newId).status).toBe("running");
      subagentRuns.resolveRun!({
        agentName: "explorer",
        status: "completed",
        report: "Deeper findings in src/app.ts:12.",
        turns: 1,
        toolCalls: 1,
      });
      const converged = await waiting;
      expect(resolved).toBe(true);
      expect(converged.details.status).toBe("completed");
      expect(converged.details.wakeReason).toBe("completion");
      expect((converged.content[0] as { text: string }).text).toContain(
        "Deeper findings in src/app.ts:12.",
      );
      // A settled explicit id stays a cheap immediate re-read afterwards.
      await acceptTaskWaitResult(runtime, "wait-1", converged);
      const reread = await waitTool(runtime).execute("wait-2", {
        delegationIds: [newId],
      });
      expect(reread.details.status).toBe("completed");
      expect((reread.content[0] as { text: string }).text).toContain(
        "Deeper findings in src/app.ts:12.",
      );
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("observes the session time cadence over the explicit independent target", async () => {
    const runtime = createRuntime();
    runtime.setSubagentWakeup({ kind: "time", value: 60 });
    subagentRuns.deferred = true;
    try {
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const firstId = (started.details as any).delegationId as string;
      subagentRuns.resolveRun!({
        agentName: "explorer",
        status: "completed",
        report: "First report.",
        turns: 1,
        toolCalls: 1,
      });
      await settleStatus(runtime, firstId);
      (runtime as any).transcriptHistory.push({
        id: "child-1",
        role: "assistant",
        content: "reading src/app.ts",
        createdAt: new Date().toISOString(),
        status: "complete",
        parentToolCallId: "task-1",
        agentName: "explorer",
      });
      (runtime as any).turnHadError = true;
      (runtime as any).agent.state.isStreaming = false;
      const continued = await runtime.continueSubagent({
        delegationId: firstId,
        text: "Go deeper on your own.",
      });
      const newId = continued.delegationId;
      (runtime as any).turnId = "new-turn";
      (runtime as any).turnEpoch += 1;
      (runtime as any).turnHadError = false;
      (runtime as any).runCancelled = false;
      (runtime as any).abortDelegationsFromPreviousTurns();
      expect((runtime as any).delegations.get(newId).status).toBe("running");
      vi.useFakeTimers();
      try {
        // The time cadence arms from the explicit target even though the
        // default (current-turn) scope is empty: quiet before the period,
        // a heartbeat at it, delivery untouched, the run still working.
        const waiting = waitTool(runtime).execute("wait-1", {
          delegationIds: [newId],
        });
        let settled = false;
        void waiting.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(59_000);
        expect(settled).toBe(false);
        // Overshoot past the period: arming reads the clock twice, so an
        // exact-boundary advance can stop a millisecond short.
        await vi.advanceTimersByTimeAsync(61_000);
        const woken = await waiting;
        expect(settled).toBe(true);
        expect(woken.details.status).toBe("wakeup");
        expect(woken.details.wakeReason).toBe("time");
        expect((runtime as any).delegations.get(newId).status).toBe("running");
        expect((runtime as any).delegations.get(newId).reportDelivered).toBe(false);
        // The run later settles and its report converges exactly once.
        subagentRuns.resolveRun!({
          agentName: "explorer",
          status: "completed",
          report: "Deeper findings in src/app.ts:12.",
          turns: 1,
          toolCalls: 1,
        });
        const converged = await waitTool(runtime).execute("wait-2", {
          delegationIds: [newId],
        });
        expect(converged.details.status).toBe("completed");
        expect(converged.details.wakeReason).toBe("completion");
        expect((converged.content[0] as { text: string }).text).toContain(
          "Deeper findings in src/app.ts:12.",
        );
        await acceptTaskWaitResult(runtime, "wait-2", converged);
        expect((runtime as any).delegations.get(newId).reportDelivered).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });
});
