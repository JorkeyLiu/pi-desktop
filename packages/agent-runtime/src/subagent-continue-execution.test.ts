/**
 * Manual continuation must give the continued child run an independent
 * execution identity on every host-bound tool call.
 *
 * Regression: a manually continued child (`continueSubagent` between parent
 * turns) spawns via `Task(resume)` with no durable parent turn, but its
 * tools stamp the retained, ended parent `turnId`. The host gate only
 * dispatches live parent turns, so the child's plugin tools are refused
 * with `turn ... is no longer dispatchable` even while the child is live.
 *
 * The fix stamps an explicit per-run identity (`childRunId`, the continued
 * run's own delegation id) on the run's `tools.execute` calls. Main
 * validates it against its live-child registry instead of the parent turn.
 * These tests drive the real `continueSubagent` spawn path with real
 * internal wiring; only the delegate loop (covered in `subagent.test.ts`)
 * and the host edge are faked.
 */
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import type { SubagentDefinition, UiMessage } from "@pi-desktop/shared";

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
} as RuntimeProviderConfig;

const commandShell = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
} as const;

const explorer: SubagentDefinition = {
  name: "explorer",
  description: "Search the workspace and report findings.",
  tools: ["plugin_demo_navigate"],
  prompt: "Find the answer and report it.",
  source: "builtin",
};

const pluginTools = [
  {
    name: "plugin_demo_navigate",
    description: "Navigate the demo browser.",
    parameters: Type.Object({ url: Type.String() }),
  },
];

/**
 * The delegate loop itself is covered in `subagent.test.ts`; here the spawn
 * wiring around it is under test, so `SubagentRun` is replaced by a
 * controllable stand-in while every other export stays real.
 */
const subagentRuns = vi.hoisted(() => ({
  calls: [] as any[],
  deferred: false,
  instances: [] as Array<{ resolve: (result: unknown) => void; settled: boolean }>,
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
      contextMessages(): readonly unknown[] {
        return [];
      }
      run() {
        if (subagentRuns.deferred) {
          return new Promise((resolve) => {
            const instance = { resolve: resolve as (result: unknown) => void, settled: false };
            subagentRuns.instances.push(instance);
            subagentRuns.resolveRun = (result: unknown) => {
              const next = subagentRuns.instances.find((entry) => !entry.settled);
              if (next) {
                next.settled = true;
                next.resolve(result);
              }
            };
            this.signal?.addEventListener("abort", () => {
              if (instance.settled) return;
              instance.settled = true;
              instance.resolve({ status: "aborted", report: "" });
            });
          });
        }
        return Promise.resolve({ status: "completed", report: "done" });
      }
    },
  };
});

function restartedTaskRow(taskCallId: string, delegationId: string): UiMessage {
  return {
    id: `row-${taskCallId}`,
    role: "tool",
    content: "",
    createdAt: "2026-08-06T00:00:00.000Z",
    toolCallId: taskCallId,
    toolName: "Task",
    toolArgs: { agent: "explorer", task: "Explore the parser." },
    toolResult: {
      details: { delegationId, agent: "explorer", status: "completed" },
    },
    toolStatus: "success",
  } as UiMessage;
}

function delegateRow(id: string, parentToolCallId: string): UiMessage {
  return {
    id,
    role: "assistant",
    content: "reading src/app.ts",
    createdAt: "2026-08-06T00:00:01.000Z",
    status: "complete",
    parentToolCallId,
    agentName: "explorer",
  } as unknown as UiMessage;
}

function createRuntime(overrides: {
  turnId?: string;
  host?: { call: ReturnType<typeof vi.fn> };
} = {}) {
  const host = overrides.host ?? { call: vi.fn(async () => ({ ok: true, content: { navigated: true } })) };
  const runtime = new DesktopAgentRuntime({
    host: host as never,
    sessionId: "session-1",
    mode: "agent",
    turnId: overrides.turnId ?? "parent-turn-1",
    provider,
    commandShell: commandShell as never,
    thinkingLevel: "medium",
    history: [restartedTaskRow("task-1", "del-1"), delegateRow("child-1", "task-1")],
    pluginTools: pluginTools as never,
    subagents: [explorer],
    onEvent: () => {},
  });
  return { runtime: runtime as unknown as Record<string, any>, host };
}

function scopedPluginTool(): AgentTool {
  const scoped = (subagentRuns.calls[0]?.tools ?? []) as AgentTool[];
  const tool = scoped.find((entry) => entry.name === "plugin_demo_navigate");
  if (!tool) throw new Error("continued run was not given the plugin tool");
  return tool;
}

function toolsExecuteCalls(host: { call: ReturnType<typeof vi.fn> }) {
  return host.call.mock.calls
    .filter(([method]) => method === "tools.execute")
    .map(([, params]) => params as Record<string, unknown>);
}

describe("manually continued child execution identity", () => {
  it("stamps the continued run's own identity on its plugin tool calls while the parent turn stays ended", async () => {
    subagentRuns.calls.length = 0;
    subagentRuns.instances.length = 0;
    // Deferred so the run is still live when its tool call is driven below;
    // an instantly-settling mock would revoke the identity first, which is
    // the next test's subject.
    subagentRuns.deferred = true;
    const { runtime, host } = createRuntime({ turnId: "parent-turn-1" });
    try {
      const accepted = await runtime.continueSubagent({
        delegationId: "del-1",
        text: "Keep going from the settled run.",
      });
      expect(accepted.accepted).toBe(true);
      const childRunId = accepted.delegationId as string;
      expect(childRunId).toBeTruthy();
      expect(childRunId).not.toBe("del-1");

      await scopedPluginTool().execute("child-call-1", { url: "https://example.com" });

      const calls = toolsExecuteCalls(host);
      expect(calls).toHaveLength(1);
      // The run's own identity travels on the call: main validates the live
      // child, not the parent turn.
      expect(calls[0]?.childRunId).toBe(childRunId);
      // The stamped turn is the retained parent turn (ended): it is
      // preserved for attribution, never impersonated as a durable turn.
      expect(calls[0]?.turnId).toBe("parent-turn-1");
      // No durable parent turn was opened for the continuation.
      expect(runtime.turnId).toBe("parent-turn-1");
      expect(
        host.call.mock.calls.some(([method]) => String(method).includes("beginTurn")),
      ).toBe(false);
      subagentRuns.resolveRun?.({ status: "completed", report: "done" });
      await (runtime.delegations.get(accepted.delegationId)?.completion ??
        Promise.resolve());
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("stops stamping once the continued run settles, so late calls cannot reuse its identity", async () => {
    subagentRuns.calls.length = 0;
    subagentRuns.instances.length = 0;
    subagentRuns.deferred = true;
    const { runtime, host } = createRuntime({ turnId: "parent-turn-1" });
    try {
      const accepted = await runtime.continueSubagent({
        delegationId: "del-1",
        text: "Keep going from the settled run.",
      });
      const tool = scopedPluginTool();

      await tool.execute("child-call-1", { url: "https://example.com" });
      expect(toolsExecuteCalls(host)[0]?.childRunId).toBe(accepted.delegationId);

      subagentRuns.resolveRun?.({ status: "completed", report: "done" });
      await (runtime.delegations.get(accepted.delegationId)?.completion ??
        Promise.resolve());

      await tool.execute("child-call-2", { url: "https://example.com" });
      const calls = toolsExecuteCalls(host);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.childRunId).toBeUndefined();
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("leaves parent-issued runs unstamped: ordinary Task tools keep turn gating", async () => {
    subagentRuns.calls.length = 0;
    const { runtime, host } = createRuntime({ turnId: "parent-turn-1" });
    try {
      const task = (runtime.agent as { state: { tools: AgentTool[] } }).state.tools.find(
        (entry) => entry.name === "Task",
      );
      if (!task) throw new Error("Task tool missing");
      const result = (await task.execute("task-2", {
        agent: "explorer",
        task: "Explore the parser.",
      })) as { details?: Record<string, unknown> };
      expect((result.details as { delegationId?: string } | undefined)?.delegationId).toBeTruthy();

      const delegateTools = (subagentRuns.calls[0]?.tools ?? []) as AgentTool[];
      const plugin = delegateTools.find((entry) => entry.name === "plugin_demo_navigate");
      if (!plugin) throw new Error("delegate was not given the plugin tool");
      await plugin.execute("delegate-call-1", { url: "https://example.com" });

      const calls = toolsExecuteCalls(host);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.childRunId).toBeUndefined();
      expect(calls[0]?.turnId).toBe("parent-turn-1");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("continued run liveness in the acceptance (F2)", () => {
  it("reports a fresh acceptance as live and a settled retry as already-applied and not live", async () => {
    subagentRuns.calls.length = 0;
    subagentRuns.instances.length = 0;
    subagentRuns.deferred = true;
    const { runtime } = createRuntime({ turnId: "parent-turn-1" });
    try {
      const first = await runtime.continueSubagent({
        delegationId: "del-1",
        text: "Keep going from the settled run.",
        messageId: "user-continue-1",
      });
      expect(first.accepted).toBe(true);
      expect(first.live).toBe(true);
      const runId = first.delegationId as string;
      expect(runId).toBeTruthy();

      subagentRuns.resolveRun?.({ status: "completed", report: "done" });
      await (runtime.delegations.get(first.delegationId)?.completion ??
        Promise.resolve());

      // A settled run retried with the same idempotency key replays the first
      // run's id, but reports it as dead so main never (re-)registers it.
      const retry = await runtime.continueSubagent({
        delegationId: "del-1",
        text: "Keep going from the settled run.",
        messageId: "user-continue-1",
      });
      expect(retry.live).toBe(false);
      expect(retry.accepted).toBe(true);
      expect(retry.delegationId).toBe(first.delegationId);
      // The settled retry replays the first run's id without spawning again.
      expect(subagentRuns.calls.length).toBe(1);
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("reports a retry of a still-live run as already-applied and live", async () => {
    subagentRuns.calls.length = 0;
    subagentRuns.instances.length = 0;
    subagentRuns.deferred = true;
    const { runtime } = createRuntime({ turnId: "parent-turn-1" });
    try {
      const first = await runtime.continueSubagent({
        delegationId: "del-1",
        text: "Keep going from the settled run.",
        messageId: "user-continue-2",
      });
      expect(first.live).toBe(true);

      const retry = await runtime.continueSubagent({
        delegationId: "del-1",
        text: "Keep going from the settled run.",
        messageId: "user-continue-2",
      });
      expect(retry.accepted).toBe(true);
      expect(retry.delegationId).toBe(first.delegationId);
      expect(retry.live).toBe(true);

      subagentRuns.resolveRun?.({ status: "completed", report: "done" });
      await (runtime.delegations.get(first.delegationId)?.completion ??
        Promise.resolve());
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });
});
