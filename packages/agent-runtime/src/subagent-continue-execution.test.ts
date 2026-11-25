/**
 * Manual continuation must not need an execution identity of its own.
 *
 * A manually continued child (`continueSubagent` between parent turns) spawns
 * via `Task(resume)` with no durable parent turn, and its tool calls carry the
 * retained, ended parent `turnId`. Nothing in the tool path treats that turn as
 * dispatch authority: every host-bound call is issued under its own
 * `(sessionId, toolCallId)` identity and is stopped by its own cancellation.
 *
 * These tests drive the real `continueSubagent` spawn path with real internal
 * wiring; only the delegate loop (covered in `subagent.test.ts`) and the host
 * edge are faked.
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

describe("manually continued child tool calls", () => {
  it("issues the continued run's plugin call under its own call identity, with no run identity", async () => {
    subagentRuns.calls.length = 0;
    subagentRuns.instances.length = 0;
    // Deferred so the run is still live when its tool call is driven below.
    subagentRuns.deferred = true;
    const { runtime, host } = createRuntime({ turnId: "parent-turn-1" });
    try {
      const accepted = await runtime.continueSubagent({
        delegationId: "del-1",
        text: "Keep going from the settled run.",
      });
      expect(accepted.accepted).toBe(true);
      expect(accepted.delegationId).toBeTruthy();
      // The acceptance carries no liveness claim: a dispatch decision is not
      // part of the continuation contract.
      expect(accepted).not.toHaveProperty("live");

      await scopedPluginTool().execute("child-call-1", { url: "https://example.com" });

      const calls = toolsExecuteCalls(host);
      expect(calls).toHaveLength(1);
      // Ordinary call identity: the pair cancellation is keyed on.
      expect(calls[0]?.sessionId).toBe("session-1");
      expect(calls[0]?.toolCallId).toBe("child-call-1");
      // The retained parent turn travels for transcript attribution only, and
      // no separate execution identity exists to authorize the call.
      expect(calls[0]?.turnId).toBe("parent-turn-1");
      expect(Object.hasOwn(calls[0] as object, "childRunId")).toBe(false);
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

  it("issues a parent-issued delegate's plugin call the same way", async () => {
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
      expect(Object.hasOwn(calls[0] as object, "childRunId")).toBe(false);
      expect(calls[0]?.turnId).toBe("parent-turn-1");
      expect(calls[0]?.toolCallId).toBe("delegate-call-1");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("continued run acceptance idempotency", () => {
  it("replays a settled run's id without spawning again", async () => {
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
      expect(first.delegationId).toBeTruthy();

      subagentRuns.resolveRun?.({ status: "completed", report: "done" });
      await (runtime.delegations.get(first.delegationId)?.completion ??
        Promise.resolve());

      const retry = await runtime.continueSubagent({
        delegationId: "del-1",
        text: "Keep going from the settled run.",
        messageId: "user-continue-1",
      });
      expect(retry.accepted).toBe(true);
      expect(retry.delegationId).toBe(first.delegationId);
      // The settled retry replays the first run's id without spawning again.
      expect(subagentRuns.calls.length).toBe(1);
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });

  it("replays a still-live run's id", async () => {
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

      const retry = await runtime.continueSubagent({
        delegationId: "del-1",
        text: "Keep going from the settled run.",
        messageId: "user-continue-2",
      });
      expect(retry.accepted).toBe(true);
      expect(retry.delegationId).toBe(first.delegationId);

      subagentRuns.resolveRun?.({ status: "completed", report: "done" });
      await (runtime.delegations.get(first.delegationId)?.completion ??
        Promise.resolve());
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });
});
