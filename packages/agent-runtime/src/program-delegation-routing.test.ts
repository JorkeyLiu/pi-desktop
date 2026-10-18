import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./runtime.js";
import type {
  CommandShellOption,
  SubagentDefinition,
} from "@pi-desktop/shared";

/**
 * Program delegation routing: TaskWait -> TaskList -> idle share one
 * coordinator time checkpoint; TaskList waits through the same coordinator
 * when expected delegates pend (otherwise cheap snapshot); idle resumes via
 * the same coordinator with an any/min1 query; delivery marks only
 * actually-included settled records; detached user runs never list/deliver.
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

function listTool(runtime: DesktopAgentRuntime): AgentTool {
  return (runtime as any).agent.state.tools.find((tool: any) => tool.name === "TaskList");
}

async function settleStatus(runtime: DesktopAgentRuntime, delegationId: string) {
  await vi.waitFor(() => {
    expect((runtime as any).delegations.get(delegationId).status).toBe("completed");
  });
}

function completedResult(report: string) {
  return { agentName: "explorer", status: "completed", report, turns: 1, toolCalls: 1 };
}

beforeEach(() => {
  subagentRuns.calls.length = 0;
  subagentRuns.instances.length = 0;
  subagentRuns.resolveRun = undefined;
  subagentRuns.result = undefined;
  subagentRuns.deferred = false;
});

describe("program delegation routing", () => {
  it("TaskWait anchors the checkpoint; TaskList reuses it and cannot progress-return before 900", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime({ subagentWakeup: { kind: "time", value: 900 } });
    (runtime as any).agent.prompt = vi.fn(async () => undefined);
    (runtime as any).agent.waitForIdle = vi.fn(async () => undefined);
    subagentRuns.deferred = true;
    try {
      const first = await taskTool(runtime).execute("task-1", { agent: "explorer", task: "A." });
      const second = await taskTool(runtime).execute("task-2", { agent: "explorer", task: "B." });
      const firstId = (first.details as any).delegationId as string;
      const secondId = (second.details as any).delegationId as string;
      // Anchor the shared checkpoint with an explicit TaskWait pass.
      const waiting = waitTool(runtime).execute("wait-1", { delegationIds: [firstId, secondId] });
      let waitSettled = false;
      void waiting.then(() => { waitSettled = true; });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(waitSettled).toBe(false);
      // TaskList enters while the same checkpoint is armed: it must not
      // progress-return early on the shared cadence.
      const listing = listTool(runtime).execute("list-1", {});
      let listSettled = false;
      void listing.then(() => { listSettled = true; });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listSettled).toBe(false);
      expect(waitSettled).toBe(false);
      // Finish both after the checkpoint fires; the wait converges and the
      // list carries the same completed roster.
      await vi.advanceTimersByTimeAsync(780_000);
      const woken = await waiting;
      const listed = await listing;
      expect(woken.details.status).toBe("wakeup");
      expect(listed.details.status).toBe("wakeup");
      expect(listed.details.delegations.map((entry: any) => entry.delegationId).sort()).toEqual(
        [firstId, secondId].sort(),
      );
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
      vi.useRealTimers();
    }
  });

  it("fast child delivers through idle immediately while its sibling still runs", async () => {
    const runtime = createRuntime({ subagentWakeup: { kind: "off" } });
    const prompts: string[] = [];
    (runtime as any).agent.prompt = vi.fn(async (text: string) => { prompts.push(text); });
    (runtime as any).agent.waitForIdle = vi.fn(async () => undefined);
    subagentRuns.deferred = true;
    try {
      const first = await taskTool(runtime).execute("task-1", { agent: "explorer", task: "A." });
      const second = await taskTool(runtime).execute("task-2", { agent: "explorer", task: "B." });
      const firstId = (first.details as any).delegationId as string;
      const secondId = (second.details as any).delegationId as string;
      subagentRuns.resolveRun!(completedResult("fast report src/fast.ts:1"));
      await settleStatus(runtime, firstId);
      // Idle keeps looping while the sibling runs, so observe the first
      // delivery prompt without awaiting full convergence.
      const idle = (runtime as any).resumeAfterDelegations();
      let idleSettled = false;
      void idle.then(() => { idleSettled = true; }, () => { idleSettled = true; });
      await vi.waitFor(() => {
        expect(prompts.length).toBeGreaterThanOrEqual(1);
      });
      expect((runtime as any).delegations.get(firstId).reportDelivered).toBe(true);
      expect((runtime as any).delegations.get(secondId).reportDelivered).toBe(false);
      expect(prompts[0]).toContain("fast report src/fast.ts:1");
      expect(idleSettled).toBe(false);
      await runtime.dispose();
      await idle;
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("omitted settled report stays pending; detached user run never lists or delivers", async () => {
    const runtime = createRuntime({ subagentWakeup: { kind: "off" } });
    subagentRuns.deferred = true;
    try {
      const first = await taskTool(runtime).execute("task-1", { agent: "explorer", task: "A." });
      const second = await taskTool(runtime).execute("task-2", { agent: "explorer", task: "B." });
      const firstId = (first.details as any).delegationId as string;
      const secondId = (second.details as any).delegationId as string;
      subagentRuns.resolveRun!(completedResult("first report"));
      await settleStatus(runtime, firstId);
      subagentRuns.resolveRun!(completedResult("second report"));
      await settleStatus(runtime, secondId);
      // Wait on the first only: the omitted sibling stays pending.
      const waited = await waitTool(runtime).execute("wait-1", { delegationIds: [firstId] });
      expect(waited.details.status).toBe("completed");
      expect((runtime as any).delegations.get(firstId).reportDelivered).toBe(true);
      expect((runtime as any).delegations.get(secondId).reportDelivered).toBe(false);
      // Detach the second run: the parent listing and wait surface exclude
      // user-owned runs entirely.
      (runtime as any).delegations.get(secondId).delivery = "user";
      const listed = await listTool(runtime).execute("list-1", {});
      expect(
        (listed.details.delegations as any[]).map((entry) => entry.delegationId),
      ).not.toContain(secondId);
      const unknown = await waitTool(runtime).execute("wait-2", { delegationIds: [secondId] });
      expect((unknown.content[0] as { text: string }).text).toContain("None of the requested");
      expect((runtime as any).delegations.get(secondId).reportDelivered).toBe(false);
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("TaskList with no expected pending stays a cheap snapshot", async () => {
    const runtime = createRuntime({ subagentWakeup: { kind: "off" } });
    subagentRuns.deferred = true;
    try {
      const started = await taskTool(runtime).execute("task-1", { agent: "explorer", task: "A." });
      const delegationId = (started.details as any).delegationId as string;
      subagentRuns.resolveRun!(completedResult("done src/app.ts:9"));
      await settleStatus(runtime, delegationId);
      await waitTool(runtime).execute("wait-1", { delegationIds: [delegationId] });
      expect((runtime as any).delegations.get(delegationId).reportDelivered).toBe(true);
      const listed = await listTool(runtime).execute("list-1", {});
      expect(listed.details.delegations).toHaveLength(1);
      expect(listed.details.status).toBeUndefined();
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });
});
