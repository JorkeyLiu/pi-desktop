/**
 * Pipeline: settings save -> `sidecar.configure` -> live runtimes -> next spawn.
 *
 * The persisted self-handoff trigger only reached a session at launch, so a save
 * during an active turn could not reach a runtime that was already running. The
 * existing `sidecar.configure` pathway now carries the field to every live
 * runtime through the same normalized setter the launch uses. It applies to
 * delegates spawned afterwards: a run already in flight keeps the trigger it
 * started with, which is what the captured `SubagentRun` options below show.
 * Local mocks only — no provider, no host, no paid services.
 */
import { describe, expect, it, vi } from "vitest";
import {
  normalizeSubagentSelfHandoffSettings,
  type SubagentDefinition,
} from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { applySubagentSelfHandoffConfigure } from "./sidecar-subagent-self-handoff.js";

const subagentRuns = vi.hoisted(() => ({
  calls: [] as any[],
}));

vi.mock("./subagent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent.js")>();
  return {
    ...actual,
    SubagentRun: class {
      constructor(options: unknown) {
        subagentRuns.calls.push(options);
      }
      progress() {
        return { toolCalls: 0, turns: 0 };
      }
      isSettled() {
        return false;
      }
      steer() {}
      run() {
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

function createRuntime(
  sessionId = "session-1",
  selfHandoff?: { kind: string; value?: number },
) {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId,
    mode: "agent",
    provider,
    commandShell: { ...commandShell },
    thinkingLevel: "medium",
    subagents: [explorer],
    subagentWakeup: { kind: "off" },
    ...(selfHandoff ? { subagentSelfHandoff: selfHandoff as never } : {}),
    onEvent: vi.fn(),
  });
}

function taskTool(runtime: DesktopAgentRuntime) {
  return (runtime as any).agent.state.tools.find((tool: any) => tool.name === "Task");
}

async function spawn(runtime: DesktopAgentRuntime, toolCallId: string) {
  await taskTool(runtime).execute(toolCallId, {
    agent: "explorer",
    task: "Find it.",
  });
}

describe("sidecar.configure subagentSelfHandoff pipeline", () => {
  it("leaves the trigger untouched when the save did not carry the field", () => {
    const calls: unknown[] = [];
    const runtimes = new Map([
      ["s-1", { setSubagentSelfHandoff: (input?: unknown) => void calls.push(input) }],
    ]);
    expect(
      applySubagentSelfHandoffConfigure(runtimes, { hostBinary: "/bin/host" }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
    expect(applySubagentSelfHandoffConfigure(runtimes, null)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("prunes a stale disposed session instead of failing the save", () => {
    const live = { setSubagentSelfHandoff: vi.fn() };
    const runtimes = new Map<
      string,
      { setSubagentSelfHandoff: (input?: any) => void }
    >([
      [
        "stale",
        {
          setSubagentSelfHandoff: () => {
            throw new Error("runtime disposed");
          },
        },
      ],
      ["live", live],
    ]);
    expect(
      applySubagentSelfHandoffConfigure(runtimes, {
        subagentSelfHandoff: { kind: "tool-calls", value: 2 },
      }),
    ).toBe(true);
    expect([...runtimes.keys()]).toEqual(["live"]);
    expect(live.setSubagentSelfHandoff).toHaveBeenCalledTimes(1);
  });

  it("normalizes the configured section exactly as a launch does", () => {
    const raw = { kind: "tool-calls", value: 2.7 } as const;
    const expected = normalizeSubagentSelfHandoffSettings(raw);
    const first = createRuntime("session-1");
    const second = createRuntime("session-2");
    const runtimes = new Map<string, DesktopAgentRuntime>([
      ["session-1", first],
      ["session-2", second],
    ]);
    try {
      expect(
        applySubagentSelfHandoffConfigure(runtimes, { subagentSelfHandoff: raw }),
      ).toBe(true);
      expect((first as any).sessionSelfHandoff).toEqual(expected);
      expect((second as any).sessionSelfHandoff).toEqual(expected);

      const future = createRuntime("session-3", raw);
      try {
        expect((future as any).sessionSelfHandoff).toEqual(expected);
      } finally {
        void future.dispose();
      }
    } finally {
      void first.dispose();
      void second.dispose();
    }
  });

  it("hands the configured trigger to the next spawn without touching the active run", async () => {
    const runtime = createRuntime("session-1");
    const runtimes = new Map<string, DesktopAgentRuntime>([["session-1", runtime]]);
    subagentRuns.calls.length = 0;
    try {
      await spawn(runtime, "task-1");
      // The delegate that was already running keeps the trigger it spawned with.
      const activeOptions = subagentRuns.calls[0];
      expect(activeOptions.selfHandoff).toEqual({ kind: "off" });

      expect(
        applySubagentSelfHandoffConfigure(runtimes, {
          subagentSelfHandoff: { kind: "context-tokens", value: 40_000 },
        }),
      ).toBe(true);

      // The live setter governs spawns; the active run's options are unchanged.
      expect(activeOptions.selfHandoff).toEqual({ kind: "off" });

      await spawn(runtime, "task-2");
      expect(subagentRuns.calls[1].selfHandoff).toEqual({
        kind: "context-tokens",
        value: 40_000,
      });
    } finally {
      void runtime.dispose();
    }
  });

  it("resets to the product default on an explicit null and refuses a disposed runtime", () => {
    const runtime = createRuntime("session-1", { kind: "runtime", value: 600 });
    try {
      expect((runtime as any).sessionSelfHandoff).toEqual({
        kind: "runtime",
        value: 600,
      });
      runtime.setSubagentSelfHandoff(null);
      expect((runtime as any).sessionSelfHandoff).toEqual({ kind: "off" });
      runtime.setSubagentSelfHandoff({ kind: "tool-calls", value: 7 });
      expect((runtime as any).sessionSelfHandoff).toEqual({
        kind: "tool-calls",
        value: 7,
      });
    } finally {
      void runtime.dispose();
    }
    expect(() => runtime.setSubagentSelfHandoff({ kind: "tool-calls", value: 1 })).toThrow(
      "runtime disposed",
    );
  });
});
