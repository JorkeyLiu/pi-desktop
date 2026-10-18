/**
 * Pipeline: settings save -> `sidecar.configure` -> live runtimes.
 *
 * Production only passed `subagentWakeup` at session launch; a save during an
 * active turn never reached an already waiting runtime. This pins the minimal
 * correction: the existing `sidecar.configure` pathway carries the persisted
 * field to every live runtime through the same normalized setter the launch
 * uses, so in-flight waits rebind before the next launch. The session base
 * exclusively owns wait timing; no per-call control can shadow it. Local
 * mocks only — no provider, no host, no paid services.
 */
import { describe, expect, it, vi } from "vitest";
import {
  normalizeSubagentWakeupSettings,
  type SubagentDefinition,
} from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { applySubagentWakeupConfigure } from "./sidecar-subagent-wakeup.js";

const subagentRuns = vi.hoisted(() => ({
  calls: [] as any[],
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
                  report: "aborted",
                  turns: 0,
                  toolCalls: 0,
                });
              },
              { once: true },
            );
          });
        }
        return Promise.resolve({
          agentName: "explorer",
          status: "completed",
          report: "done",
          turns: 1,
          toolCalls: 0,
        });
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
  tools: ["Read", "Glob", "Grep"],
  prompt: "Report file paths and line numbers.",
  source: "builtin",
};

function createRuntime(sessionId = "session-1") {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId,
    mode: "agent",
    provider,
    commandShell: { ...commandShell },
    thinkingLevel: "medium",
    subagents: [explorer],
    subagentWakeup: { kind: "off" },
    onEvent: vi.fn(),
  });
}

function taskTool(runtime: DesktopAgentRuntime) {
  return (runtime as any).agent.state.tools.find((tool: any) => tool.name === "Task");
}

function waitTool(runtime: DesktopAgentRuntime) {
  return (runtime as any).agent.state.tools.find((tool: any) => tool.name === "TaskWait");
}

function emitChildToolStart(
  runtime: DesktopAgentRuntime,
  delegationId: string,
  toolCallId: string,
  callIndex = 0,
  parentToolCallId = "task-1",
) {
  const options = subagentRuns.calls[callIndex];
  options.onEvent({
    sessionId: "session-1",
    turnId: "turn-1",
    ts: Date.now(),
    event: { type: "tool_start", toolCallId, toolName: "Read", args: { path: "a.ts" } },
    parentToolCallId,
    agentName: "explorer",
  });
  void delegationId;
}

describe("sidecar.configure subagentWakeup pipeline", () => {
  it("leaves waits untouched when the save did not carry the field", () => {
    const calls: unknown[] = [];
    const runtimes = new Map([
      ["s-1", { setSubagentWakeup: (input?: unknown) => void calls.push(input) }],
    ]);
    expect(applySubagentWakeupConfigure(runtimes, { hostBinary: "/bin/host" })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(applySubagentWakeupConfigure(runtimes, null)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("prunes a stale disposed session instead of failing the save", () => {
    const live = { setSubagentWakeup: vi.fn() };
    const runtimes = new Map<string, { setSubagentWakeup: (input?: any) => void }>([
      ["stale", { setSubagentWakeup: () => { throw new Error("runtime disposed"); } }],
      ["live", live],
    ]);
    expect(
      applySubagentWakeupConfigure(runtimes, { subagentWakeup: { kind: "tool-calls", value: 2 } }),
    ).toBe(true);
    expect([...runtimes.keys()]).toEqual(["live"]);
    expect(live.setSubagentWakeup).toHaveBeenCalledTimes(1);
  });

  it("updates every live runtime with the same normalized values a future launch uses", () => {
    const raw = { kind: "tool-calls", value: 2.7 } as const;
    const expected = normalizeSubagentWakeupSettings(raw);
    const first = createRuntime("session-1");
    const second = createRuntime("session-2");
    const runtimes = new Map<string, DesktopAgentRuntime>([
      ["session-1", first],
      ["session-2", second],
    ]);
    try {
      // A settings save forwards the persisted section through configure.
      const configureParams = { subagentWakeup: raw };
      expect(applySubagentWakeupConfigure(runtimes, configureParams)).toBe(true);
      expect((first as any).sessionWakeup).toEqual(expected);
      expect((second as any).sessionWakeup).toEqual(expected);
      // A future launch normalizes the same persisted section identically.
      const future = createRuntime("session-3");
      try {
        (future as any).sessionWakeup = normalizeSubagentWakeupSettings(raw);
        expect((future as any).sessionWakeup).toEqual((first as any).sessionWakeup);
      } finally {
        void future.dispose();
      }
    } finally {
      void first.dispose();
      void second.dispose();
    }
  });

  it("rebinds an already waiting runtime before the next launch through the shared base", async () => {
    const runtime = createRuntime();
    const runtimes = new Map<string, DesktopAgentRuntime>([["session-1", runtime]]);
    subagentRuns.calls.length = 0;
    subagentRuns.instances.length = 0;
    subagentRuns.deferred = true;
    subagentRuns.resolveRun = undefined;
    try {
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Find it.",
      });
      const delegationId = (started.details as any).delegationId as string;

      // The wait starts with thresholds disabled, so it cannot wake yet.
      let settled = false;
      const waiting = waitTool(runtime)
        .execute("wait-1", { delegationIds: [delegationId] })
        .then((result: unknown) => {
          settled = true;
          return result as { details: { wakeReason?: string; wakeDelegationIds?: string[] } };
        });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);

      // The settings save arrives as `sidecar.configure` while the wait is
      // in flight — no new launch, no runtime rebuild.
      expect(
        applySubagentWakeupConfigure(runtimes, {
          subagentWakeup: { kind: "tool-calls", value: 2 },
        }),
      ).toBe(true);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Enabling the threshold alone never resolves the wait.
      expect(settled).toBe(false);

      emitChildToolStart(runtime, delegationId, "child-1");
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      emitChildToolStart(runtime, delegationId, "child-2");
      const woken = await waiting;
      expect(settled).toBe(true);
      expect(woken.details.wakeReason).toBe("tool-calls");
      expect(woken.details.wakeDelegationIds).toEqual([delegationId]);

      // The shared base alone rebinds the next in-flight wait: raising the
      // threshold quiets it, and lowering it mid-wait applies the already
      // observed progress without any per-call shadow.
      const second = await taskTool(runtime).execute("task-2", {
        agent: "explorer",
        task: "Find more.",
      });
      const secondId = (second.details as any).delegationId as string;
      applySubagentWakeupConfigure(runtimes, {
        subagentWakeup: { kind: "tool-calls", value: 5 },
      });
      let secondSettled = false;
      const secondWait = waitTool(runtime)
        .execute("wait-2", { delegationIds: [secondId] })
        .then((result: unknown) => {
          secondSettled = true;
          return result as { details: { wakeReason?: string; wakeDelegationIds?: string[] } };
        });
      const emitSecond = (toolCallId: string) =>
        emitChildToolStart(runtime, secondId, toolCallId, 1, "task-2");
      emitSecond("child-a");
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Base threshold is 5 and only one call landed: still pending.
      expect(secondSettled).toBe(false);
      applySubagentWakeupConfigure(runtimes, {
        subagentWakeup: { kind: "tool-calls", value: 1 },
      });
      const secondWoken = await secondWait;
      expect(secondWoken.details.wakeReason).toBe("tool-calls");
      expect(secondWoken.details.wakeDelegationIds).toEqual([secondId]);
    } finally {
      subagentRuns.deferred = false;
      await runtime.dispose();
    }
  });
});
