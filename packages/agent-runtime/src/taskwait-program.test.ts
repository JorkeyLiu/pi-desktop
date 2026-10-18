import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./runtime.js";
import type {
  CommandShellOption,
  SubagentDefinition,
} from "@pi-desktop/shared";

/**
 * Program-wait TaskWait: selected session wakeup owns timing, legacy
 * per-call controls (`timeoutSeconds`, `subagentWakeup`) are ignored.
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

function createRuntime(overrides: { subagentWakeup?: unknown } = {}) {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-1",
    mode: "agent",
    turnId: "parent-turn",
    provider,
    commandShell,
    thinkingLevel: "medium",
    subagents: [explorer],
    ...(overrides.subagentWakeup !== undefined
      ? { subagentWakeup: overrides.subagentWakeup as never }
      : {}),
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

beforeEach(() => {
  subagentRuns.calls.length = 0;
  subagentRuns.instances.length = 0;
  subagentRuns.resolveRun = undefined;
  subagentRuns.result = undefined;
  subagentRuns.deferred = false;
});

describe("program-wait TaskWait", () => {
  it("exposes only delegationIds, mode, minCompleted", async () => {
    const runtime = createRuntime();
    try {
      const schema = JSON.parse(
        JSON.stringify(waitTool(runtime).parameters),
      ) as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties).sort()).toEqual(
        ["delegationIds", "minCompleted", "mode"],
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("ignores legacy timeoutSeconds/subagentWakeup: 60s stays silent, program time 900s wakes", async () => {
    vi.useFakeTimers();
    try {
      const runtime = createRuntime({
        subagentWakeup: { kind: "time", value: 900 },
      });
      subagentRuns.deferred = true;
      try {
        const started = await taskTool(runtime).execute("task-1", {
          agent: "explorer",
          task: "Find it.",
        });
        const delegationId = (started.details as any).delegationId as string;
        const waiting = waitTool(runtime).execute("wait-1", {
          delegationIds: [delegationId],
          timeoutSeconds: 60,
          subagentWakeup: { kind: "time", value: 1 },
        });
        let settled = false;
        void waiting.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
        expect((runtime as any).delegations.get(delegationId).status).toBe("running");
        await vi.advanceTimersByTimeAsync(840_000);
        const woken = await waiting;
        expect(settled).toBe(true);
        expect(woken.details.status).toBe("wakeup");
        expect(woken.details.wakeReason).toBe("time");
        expect((runtime as any).delegations.get(delegationId).status).toBe("running");
        expect(
          (runtime as any).delegations.get(delegationId).reportDelivered,
        ).toBe(false);
      } finally {
        subagentRuns.deferred = false;
        await runtime.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns completion before the program period", async () => {
    const runtime = createRuntime({
      subagentWakeup: { kind: "time", value: 900 },
    });
    subagentRuns.deferred = true;
    try {
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const delegationId = (started.details as any).delegationId as string;
      const waiting = waitTool(runtime).execute("wait-1", {
        delegationIds: [delegationId],
      });
      subagentRuns.resolveRun!({
        agentName: "explorer",
        status: "completed",
        report: "Found it in src/app.ts:12.",
        turns: 1,
        toolCalls: 1,
      });
      await settleStatus(runtime, delegationId);
      const converged = await waiting;
      expect(converged.details.status).toBe("completed");
      expect(converged.details.wakeReason).toBe("completion");
      expect((converged.content[0] as { text: string }).text).toContain("src/app.ts:12");
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("off has no periodic return; abort still releases", async () => {
    vi.useFakeTimers();
    try {
      const runtime = createRuntime({ subagentWakeup: { kind: "off" } });
      subagentRuns.deferred = true;
      try {
        const started = await taskTool(runtime).execute("task-1", {
          agent: "explorer",
          task: "Find it.",
        });
        const delegationId = (started.details as any).delegationId as string;
        const controller = new AbortController();
        const waiting = waitTool(runtime).execute(
          "wait-1",
          { delegationIds: [delegationId] },
          controller.signal,
        );
        let settled = false;
        void waiting.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(settled).toBe(false);
        controller.abort();
        const released = await waiting;
        expect(settled).toBe(true);
        expect(released.details.status).toBe("wakeup");
        expect((runtime as any).delegations.get(delegationId).status).toBe("running");
      } finally {
        subagentRuns.deferred = false;
        await runtime.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads an explicitly named delivered settled id", async () => {
    const runtime = createRuntime();
    subagentRuns.deferred = true;
    try {
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const delegationId = (started.details as any).delegationId as string;
      subagentRuns.resolveRun!({
        agentName: "explorer",
        status: "completed",
        report: "src/app.ts:12 misses the null check.",
        turns: 1,
        toolCalls: 1,
      });
      await settleStatus(runtime, delegationId);
      const first = await waitTool(runtime).execute("wait-1", {
        delegationIds: [delegationId],
      });
      expect((first.content[0] as { text: string }).text).toContain("src/app.ts:12 misses the null check.");
      expect((runtime as any).delegations.get(delegationId).reportDelivered).toBe(true);
      const reread = await waitTool(runtime).execute("wait-2", {
        delegationIds: [delegationId],
      });
      expect((reread.content[0] as { text: string }).text).toContain("src/app.ts:12 misses the null check.");
      expect(reread.details.status).toBe("completed");
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });
});
