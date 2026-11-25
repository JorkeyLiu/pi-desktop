import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./runtime.js";
import {
  MODEL_STEER_DELIVERY,
  MODEL_STEER_SOURCE,
  isCodedSteerError,
  readModelSteerRequest,
  validateModelSteer,
} from "./subagent-steer.js";
import type {
  CommandShellOption,
  SubagentDefinition,
} from "@pi-desktop/shared";

/**
 * TaskSteer: the parent model's own steering channel.
 *
 * `Task(resume)` refuses a still-running delegation, so the model could not
 * correct a live child. `TaskSteer` closes that gap with its own boundary:
 * only a delegation in this session that is still running and that the
 * parent itself started, queued for the next turn boundary — never consumed,
 * never a new run, never a stop.
 */
const subagentRuns = vi.hoisted(() => ({
  calls: [] as any[],
  steered: [] as string[],
  /** When true, run() waits for resolveRun() so tests control settlement. */
  deferred: false,
  /** When true, steer() throws, simulating a settle in the validate/apply race. */
  throwOnSteer: false,
  settled: false,
  instances: [] as Array<{ resolve: (r: unknown) => void; settled: boolean }>,
  resolveRun: undefined as ((result: unknown) => void) | undefined,
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
        return subagentRuns.settled;
      }
      steer(text: string) {
        if (subagentRuns.throwOnSteer) throw new Error("loop settled");
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

function createRuntime(mode: "agent" | "plan" = "agent") {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-1",
    mode,
    turnId: "parent-turn",
    provider,
    commandShell,
    thinkingLevel: "medium",
    subagents: [explorer],
    onEvent: vi.fn(),
  });
}

function tool(runtime: DesktopAgentRuntime, name: string): AgentTool {
  const found = (runtime as any).agent.state.tools.find(
    (entry: any) => entry.name === name,
  );
  if (!found) throw new Error(`tool ${name} is not registered`);
  return found;
}

function errorText(receipt: unknown): string {
  return JSON.stringify((receipt as any)?.details ?? receipt);
}

beforeEach(() => {
  subagentRuns.calls.length = 0;
  subagentRuns.steered.length = 0;
  subagentRuns.deferred = false;
  subagentRuns.throwOnSteer = false;
  subagentRuns.settled = false;
  subagentRuns.instances.length = 0;
  subagentRuns.resolveRun = undefined;
});

async function startRunning(runtime: DesktopAgentRuntime): Promise<string> {
  subagentRuns.deferred = true;
  const started = await tool(runtime, "Task").execute("task-1", {
    agent: "explorer",
    task: "Find it.",
  });
  const delegationId = (started.details as any)?.delegationId as string;
  expect(delegationId).toBeTruthy();
  return delegationId;
}

describe("TaskSteer registration", () => {
  it("registers a TaskSteer tool that steers a running delegation the parent started", async () => {
    const runtime = createRuntime();
    try {
      const delegationId = await startRunning(runtime);
      const receipt = await tool(runtime, "TaskSteer").execute("steer-1", {
        delegationId,
        message: "Also check the docs.",
      });
      expect((receipt.details as any)?.error).toBeUndefined();
      expect((receipt.details as any)?.delegationId).toBe(delegationId);
      expect(subagentRuns.steered).toEqual(["Also check the docs."]);
    } finally {
      await runtime.dispose();
    }
  });

  it("stays a core declaration outside the on-demand catalog", async () => {
    const runtime = createRuntime();
    try {
      expect((runtime as any).deferredToolNames.has("TaskSteer")).toBe(false);
      const declared = tool(runtime, "TaskSteer");
      expect(declared.executionMode).toBeUndefined();
      expect(String(declared.description)).toContain("next turn");
    } finally {
      await runtime.dispose();
    }
  });

  it("points Task at TaskSteer instead of claiming a child cannot be corrected", async () => {
    const runtime = createRuntime();
    try {
      const description = String(tool(runtime, "Task").description);
      expect(description).not.toContain("you cannot correct it while it runs");
      expect(description).toContain("TaskSteer");
    } finally {
      await runtime.dispose();
    }
  });

  it("is rejected in Plan mode without execution", async () => {
    const runtime = createRuntime("plan");
    try {
      // The declaration stays visible for conversation compatibility...
      expect(() => tool(runtime, "TaskSteer")).not.toThrow();
      // ...but the call is rejected before it reaches any delegation.
      await expect(
        tool(runtime, "TaskSteer").execute("steer-1", {
          delegationId: "whatever",
          message: "hi",
        }),
      ).rejects.toThrow(/plan mode/);
      expect(subagentRuns.calls).toHaveLength(0);
      expect(subagentRuns.steered).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("TaskSteer request schema", () => {
  it("rejects missing fields without touching any run", async () => {
    const runtime = createRuntime();
    try {
      const delegationId = await startRunning(runtime);
      const runsBefore = subagentRuns.calls.length;
      for (const params of [
        {},
        { delegationId: "", message: "hi" },
        { delegationId: "  ", message: "hi" },
        { delegationId: 42, message: "hi" },
        { delegationId, message: "" },
        { delegationId, message: "   " },
        { delegationId, message: 42 },
        { delegationId },
      ]) {
        const receipt = await tool(runtime, "TaskSteer").execute("steer-schema", params);
        expect((receipt.details as any)?.error ?? receipt).toBeTruthy();
      }
      expect(errorText(await tool(runtime, "TaskSteer").execute("s", {}))).toContain(
        "delegationId required",
      );
      expect(subagentRuns.calls.length).toBe(runsBefore);
      expect(subagentRuns.steered).toHaveLength(0);
      expect((runtime as any).delegations.size).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("reads exactly delegationId and message, ignoring informational extras", () => {
    expect(
      readModelSteerRequest({
        delegationId: "d-1",
        message: "go",
        expectedTurnId: "turn-9",
        extra: true,
      }),
    ).toEqual({ delegationId: "d-1", message: "go" });
    expect(readModelSteerRequest(null)).toEqual({
      delegationId: undefined,
      message: undefined,
    });
  });
});

describe("TaskSteer ownership", () => {
  it("rejects unknown delegations with no side effect", async () => {
    const runtime = createRuntime();
    try {
      await startRunning(runtime);
      const runsBefore = subagentRuns.calls.length;
      const receipt = await tool(runtime, "TaskSteer").execute("steer-1", {
        delegationId: "nope",
        message: "hello?",
      });
      expect(errorText(receipt)).toContain("Unknown delegation");
      expect(errorText(receipt)).toContain("nope");
      expect(subagentRuns.calls.length).toBe(runsBefore);
      expect(subagentRuns.steered).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects calls issued from a delegate wrapper", async () => {
    const runtime = createRuntime();
    try {
      const delegationId = await startRunning(runtime);
      // A delegate's scoped tool stamps the in-flight call with its owner's
      // delegation id; that attribution — not a turn id — denies the call.
      (runtime as any).mutationOwners.set("steer-delegate", delegationId);
      const receipt = await tool(runtime, "TaskSteer").execute("steer-delegate", {
        delegationId,
        message: "parent, stop that.",
      });
      expect(errorText(receipt)).toContain("not yours to steer");
      expect(subagentRuns.steered).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects user-controlled runs", async () => {
    const runtime = createRuntime();
    try {
      const delegationId = await startRunning(runtime);
      (runtime as any).delegations.get(delegationId).userOrigin = true;
      const receipt = await tool(runtime, "TaskSteer").execute("steer-1", {
        delegationId,
        message: "from the model",
      });
      expect(errorText(receipt)).toContain("user-controlled");
      expect(subagentRuns.steered).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects settled and stopping delegations with resume guidance", async () => {
    const runtime = createRuntime();
    try {
      const delegationId = await startRunning(runtime);
      const record = (runtime as any).delegations.get(delegationId);
      record.status = "completed";
      const settled = await tool(runtime, "TaskSteer").execute("steer-1", {
        delegationId,
        message: "too late",
      });
      expect(errorText(settled)).toContain("already settled");
      expect(errorText(settled)).toContain("Task(resume:");
      expect(errorText(settled)).toContain(delegationId);
      record.status = "running";
      record.stopRequested = true;
      const stopping = await tool(runtime, "TaskSteer").execute("steer-2", {
        delegationId,
        message: "too late",
      });
      expect(errorText(stopping)).toContain("is stopping");
      expect(subagentRuns.steered).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("TaskSteer receipt and race", () => {
  it("returns a queueing receipt, never a consumption claim", async () => {
    const runtime = createRuntime();
    try {
      const delegationId = await startRunning(runtime);
      const receipt = (await tool(runtime, "TaskSteer").execute("steer-1", {
        delegationId,
        message: "Also check the docs.",
      })) as any;
      expect(receipt.details.delegationId).toBe(delegationId);
      expect(receipt.details.status).toBe("queued");
      expect(receipt.details.delivery).toBe(MODEL_STEER_DELIVERY);
      expect(receipt.details.source).toBe(MODEL_STEER_SOURCE);
      expect(typeof receipt.details.messageId).toBe("string");
      const text = receipt.content[0].text as string;
      expect(text).toContain("queued");
      expect(text).toContain("next turn");
      expect(text).not.toMatch(/consumed|executed/);
      // The same delegation keeps running: no new run was spawned to steer it.
      expect(subagentRuns.calls).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("maps a settle in the validate/apply race to resume guidance, not a silent drop", async () => {
    const runtime = createRuntime();
    try {
      const delegationId = await startRunning(runtime);
      subagentRuns.throwOnSteer = true;
      const receipt = await tool(runtime, "TaskSteer").execute("steer-1", {
        delegationId,
        message: "race me",
      });
      expect(errorText(receipt)).toContain("settled before the steering arrived");
      expect(errorText(receipt)).toContain("Task(resume:");
      expect(errorText(receipt)).toContain(delegationId);
      // Nothing was queued onto the dead run: no steering ledger entry.
      expect(
        ((runtime as any).delegations.get(delegationId).steeredMessageIds as Set<string>)
          ?.size ?? 0,
      ).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("leaves TaskWait delivery of the original run intact after failed steers", async () => {
    const runtime = createRuntime();
    try {
      const delegationId = await startRunning(runtime);
      await tool(runtime, "TaskSteer").execute("bad-1", {
        delegationId: "unknown",
        message: "nope",
      });
      await tool(runtime, "TaskSteer").execute("bad-2", {
        delegationId,
        message: "   ",
      });
      subagentRuns.resolveRun?.({
        agentName: "explorer",
        status: "completed",
        report: "original report",
        turns: 1,
        toolCalls: 0,
      });
      const waited = (await tool(runtime, "TaskWait").execute("wait-1", {
        delegationIds: [delegationId],
      })) as any;
      expect(JSON.stringify(waited.details)).toContain("original report");
      expect(subagentRuns.calls).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("TaskSteer and Task(resume)", () => {
  it("refuses resume of a running delegation by pointing at TaskSteer", async () => {
    const runtime = createRuntime();
    try {
      const delegationId = await startRunning(runtime);
      // Settle the mock run first so the chain exists, then mark it running
      // again the way a live delegation reads while it works.
      const receipt = (await tool(runtime, "Task").execute("task-2", {
        agent: "explorer",
        task: "Follow up on the earlier brief.",
        resume: delegationId,
      })) as any;
      expect(errorText(receipt)).toContain("still running");
      expect(errorText(receipt)).toContain("TaskSteer");
      expect(subagentRuns.calls).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("TaskSteer coded rejections", () => {
  const live = {
    delegationId: "d-1",
    parentToolCallId: "task-1",
    agentName: "explorer",
    status: "running" as const,
    stopRequested: false,
    settled: false,
    hasLiveLoop: true,
  };
  function codeOf(fn: () => unknown): string {
    try {
      fn();
    } catch (error) {
      expect(isCodedSteerError(error)).toBe(true);
      return (error as { errorCode: string }).errorCode;
    }
    throw new Error("expected a coded rejection");
  }
  it("pins a stable errorCode per failure class", () => {
    const lookup = (id: string) => (id === live.delegationId ? { ...live } : undefined);
    expect(
      codeOf(() => validateModelSteer({ kind: "parent" }, lookup, { delegationId: "", message: "hi" })),
    ).toBe("DELEGATION_NOT_FOUND");
    expect(
      codeOf(() => validateModelSteer({ kind: "parent" }, lookup, { delegationId: "nope", message: "hi" })),
    ).toBe("DELEGATION_NOT_FOUND");
    expect(
      codeOf(() =>
        validateModelSteer({ kind: "delegate", delegationId: "d-9" }, lookup, {
          delegationId: "d-1",
          message: "hi",
        }),
      ),
    ).toBe("DELEGATION_NOT_OWNED");
    expect(
      codeOf(() =>
        validateModelSteer({ kind: "parent" }, () => ({ ...live, userOrigin: true }), {
          delegationId: "d-1",
          message: "hi",
        }),
      ),
    ).toBe("DELEGATION_NOT_OWNED");
    expect(
      codeOf(() => validateModelSteer({ kind: "parent" }, lookup, { delegationId: "d-1", message: "  " })),
    ).toBe("INVALID_ARGUMENT");
    expect(
      codeOf(() =>
        validateModelSteer({ kind: "parent" }, () => ({ ...live, status: "completed" as const }), {
          delegationId: "d-1",
          message: "hi",
        }),
      ),
    ).toBe("DELEGATION_NOT_RUNNING");
  });
});
