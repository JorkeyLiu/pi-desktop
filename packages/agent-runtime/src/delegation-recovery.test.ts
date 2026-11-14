import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  CommandShellOption,
  SubagentDefinition,
  UiMessage,
} from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./runtime.js";
import {
  MAX_RECOVERED_DELEGATIONS,
  mergeDelegationViews,
  type RecoveredDelegation,
} from "./delegation-recovery.js";

/**
 * Historical TaskList/TaskWait reads: a restart rebuilds a read-only view of
 * the delegations the transcript proves, while live run state stays honest.
 * The delegate loop is replaced by a recorder (as in `taskwait-program.test.ts`);
 * every other export stays real.
 */
const subagentRuns = vi.hoisted(() => ({
  calls: [] as unknown[],
  result: undefined as unknown,
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
      run() {
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

const START = 1_700_000_000_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** One persisted `Task` tool row: what a restart can still see of a spawn. */
function taskRow(options: {
  callId: string;
  delegationId: string;
  task?: string;
  status?: string;
  startedAt?: number;
  completedAt?: number;
  turns?: number;
  toolCalls?: number;
  channel?: "parent" | "user";
  steering?: boolean;
  resume?: string;
}): UiMessage {
  const startedAt = options.startedAt ?? START;
  return {
    id: `row-${options.callId}`,
    role: "tool",
    content: "",
    createdAt: iso(startedAt),
    ...(options.completedAt ? { toolCompletedAt: iso(options.completedAt) } : {}),
    toolCallId: options.callId,
    toolName: "Task",
    toolArgs: {
      agent: "explorer",
      task: options.task ?? "Map the parser.",
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.channel === "user" ? { source: "user" } : {}),
    },
    toolResult: {
      content: [{ type: "text", text: "" }],
      details: {
        delegationId: options.delegationId,
        agent: "explorer",
        status: options.status ?? "completed",
        startedAt,
        ...(options.completedAt ? { completedAt: options.completedAt } : {}),
        turns: options.turns ?? 2,
        toolCalls: options.toolCalls ?? 3,
        modelId: "local-model",
        thinkingLevel: "medium",
      },
    },
    toolStatus: "success",
    ...(options.steering ? { steering: true } : {}),
  };
}

/** One persisted settled `TaskWait` row: the exact batch the parent received. */
function waitRow(options: {
  callId: string;
  delegationId: string;
  report: string;
  status?: string;
  startedAt?: number;
  completedAt?: number;
}): UiMessage {
  const startedAt = options.startedAt ?? START;
  return {
    id: `row-${options.callId}`,
    role: "tool",
    content: "",
    createdAt: iso((options.completedAt ?? startedAt + 1_000) + 1_000),
    toolCallId: options.callId,
    toolName: "TaskWait",
    toolArgs: { delegationIds: [options.delegationId] },
    toolResult: {
      content: [{ type: "text", text: options.report }],
      details: {
        status: "completed",
        delegations: [
          {
            delegationId: options.delegationId,
            agent: "explorer",
            status: options.status ?? "completed",
            startedAt,
            ...(options.completedAt ? { completedAt: options.completedAt } : {}),
            turns: 2,
            toolCalls: 3,
            modelId: "local-model",
            thinkingLevel: "medium",
            report: options.report,
          },
        ],
      },
    },
    toolStatus: "success",
  };
}

/** The delegate's own final assistant row, owned by its `Task` call. */
function childRow(options: {
  id: string;
  callId: string;
  content: string;
  createdAt?: number;
}): UiMessage {
  return {
    id: options.id,
    role: "assistant",
    content: options.content,
    status: "complete",
    createdAt: iso(options.createdAt ?? START + 500),
    parentToolCallId: options.callId,
    agentName: "explorer",
  };
}

function createRuntime(history: UiMessage[] = []): DesktopAgentRuntime {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-1",
    mode: "agent",
    turnId: "parent-turn",
    provider,
    commandShell,
    thinkingLevel: "medium",
    subagents: [explorer],
    history,
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

function recovered(runtime: DesktopAgentRuntime, id: string): RecoveredDelegation {
  return (runtime as any).recoveredDelegations.lookup(id);
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

function toolResultMessage(
  toolCallId: string,
  result: { content: unknown; details?: unknown },
): unknown {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "TaskWait",
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  };
}

beforeEach(() => {
  subagentRuns.calls.length = 0;
  subagentRuns.result = undefined;
});

describe("historical TaskList after a restart", () => {
  it("lists a settled delegation from history and keeps the live map empty", async () => {
    const runtime = createRuntime([
      taskRow({
        callId: "task-1",
        delegationId: "del-1",
        completedAt: START + 5_000,
      }),
      childRow({ id: "child-1", callId: "task-1", content: "Found it." }),
    ]);
    try {
      const listed = await listTool(runtime).execute("list-1", {});
      const text = (listed.content[0] as { text: string }).text;
      const entries = listed.details.delegations as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        delegationId: "del-1",
        agent: "explorer",
        status: "completed",
        recovered: true,
        modelId: "local-model",
      });
      expect(text).toContain("explorer (del-1)");
      expect(text).toContain("recovered from history; not running in this process");
      // History answers reads only: no run handle was fabricated.
      expect((runtime as any).delegations.size).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps the empty listing text when nothing was delegated", async () => {
    const runtime = createRuntime([childRow({ id: "child-1", callId: "task-1", content: "x" })]);
    try {
      const listed = await listTool(runtime).execute("list-1", {});
      expect((listed.content[0] as { text: string }).text).toBe(
        "No subagents have been started in this session.",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("never lists or waits on user-channel Task rows", async () => {
    const runtime = createRuntime([
      taskRow({
        callId: "task-user",
        delegationId: "del-user",
        channel: "user",
        completedAt: START + 1_000,
      }),
    ]);
    try {
      const listed = await listTool(runtime).execute("list-1", {});
      expect((listed.content[0] as { text: string }).text).toBe(
        "No subagents have been started in this session.",
      );
      const waited = await waitTool(runtime).execute("wait-1", {
        delegationIds: ["del-user"],
      });
      expect((waited.content[0] as { text: string }).text).toContain(
        "None of the requested delegation ids exist in this session.",
      );
      expect((waited.details as any).unknownIds).toEqual(["del-user"]);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("historical TaskWait report reads", () => {
  it("returns the full stored report, flagged as recovered history", async () => {
    const report = `REPORT-${"x".repeat(60_000)}-END`;
    const runtime = createRuntime([
      taskRow({
        callId: "task-1",
        delegationId: "del-1",
        completedAt: START + 5_000,
      }),
      waitRow({
        callId: "wait-0",
        delegationId: "del-1",
        report,
        completedAt: START + 5_000,
      }),
    ]);
    try {
      const waited = await waitTool(runtime).execute("wait-1", {
        delegationIds: ["del-1"],
      });
      const text = (waited.content[0] as { text: string }).text;
      const details = waited.details as any;
      expect(details.recoveredDelegationIds).toEqual(["del-1"]);
      expect(details.delegations).toHaveLength(1);
      expect(details.delegations[0]).toMatchObject({
        delegationId: "del-1",
        status: "completed",
        recovered: true,
      });
      // Full text, not truncated by the live batch cap (50,000 chars).
      expect(details.delegations[0].report).toBe(report);
      expect(text).toContain(report);
      expect(text).toContain("Reports below are history, recovered from this session's transcript");
      // A pure historical read is not a delivery boundary.
      expect((runtime as any).deliveryReceipts.waitResults.size).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("falls back to the delegate's final child row when no TaskWait row survived", async () => {
    const runtime = createRuntime([
      taskRow({
        callId: "task-1",
        delegationId: "del-1",
        completedAt: START + 5_000,
      }),
      childRow({ id: "child-1", callId: "task-1", content: "The parser lives in src/parser.ts." }),
    ]);
    try {
      expect(recovered(runtime, "del-1").reportSource).toBe("delegate-message");
      const waited = await waitTool(runtime).execute("wait-1", {
        delegationIds: ["del-1"],
      });
      expect((waited.content[0] as { text: string }).text).toContain(
        "The parser lives in src/parser.ts.",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("reads a historical running row as interrupted and never hangs", async () => {
    const runtime = createRuntime([
      taskRow({ callId: "task-1", delegationId: "del-1", status: "running" }),
    ]);
    try {
      const listed = await listTool(runtime).execute("list-1", {});
      const entries = listed.details.delegations as Array<Record<string, unknown>>;
      expect(entries[0]).toMatchObject({ delegationId: "del-1", status: "interrupted" });
      expect(recovered(runtime, "del-1").status).toBe("interrupted");
      // The wait resolves on its own: no completion can arrive for history.
      const waited = await waitTool(runtime).execute("wait-1", {
        delegationIds: ["del-1"],
      });
      const text = (waited.content[0] as { text: string }).text;
      expect(text).toContain("Interrupted before settlement");
      expect(text).toContain('continue with Task.resume: "<id>"');
      expect(text).not.toContain("Interrupted by new user input");
      expect((waited.details as any).delegations[0].status).toBe("interrupted");
      expect((runtime as any).delegations.size).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps truly unknown ids unknown", async () => {
    const runtime = createRuntime([
      taskRow({ callId: "task-1", delegationId: "del-1", completedAt: START + 1_000 }),
    ]);
    try {
      const waited = await waitTool(runtime).execute("wait-1", {
        delegationIds: ["ghost"],
      });
      expect((waited.content[0] as { text: string }).text).toBe(
        "None of the requested delegation ids exist in this session. Call TaskList to see them.",
      );
      expect((waited.details as any).unknownIds).toEqual(["ghost"]);
      expect((waited.details as any).recoveredDelegationIds).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});

describe("history and the live registry", () => {
  it("continues a recovered chain through Task.resume", async () => {
    const runtime = createRuntime([
      taskRow({ callId: "task-1", delegationId: "del-1", completedAt: START + 1_000 }),
    ]);
    try {
      subagentRuns.result = {
        agentName: "explorer",
        modelId: "local-model",
        thinkingLevel: "medium",
        status: "completed",
        report: "Continued.",
        turns: 1,
        toolCalls: 0,
      };
      const resumed = await taskTool(runtime).execute("task-r", {
        agent: "explorer",
        task: "Continue the parser review.",
        resume: "del-1",
      });
      expect((resumed.content[0] as { text: string }).text).not.toContain("Unknown");
      const resumedId = (resumed.details as any).delegationId as string;
      expect(resumedId).toBeTruthy();
      const record = (runtime as any).delegations.get(resumedId);
      expect(record.resumedFrom).toBe("del-1");
      const listed = await listTool(runtime).execute("list-1", {});
      const ids = (listed.details.delegations as Array<{ delegationId: string }>).map(
        (entry) => entry.delegationId,
      );
      expect(ids).toContain(resumedId);
      expect(ids).toContain("del-1");
      expect(ids).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps one entry per id when a settled live run outlives the prune cap", async () => {
    const runtime = createRuntime();
    try {
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Look around.",
      });
      const delegationId = (started.details as any).delegationId as string;
      await settleStatus(runtime, delegationId);
      const live = (runtime as any).delegations.get(delegationId);
      const before = await listTool(runtime).execute("list-1", {});
      expect((before.details.delegations as unknown[]).length).toBe(1);
      // Simulate the in-process retention cap dropping the live record: the
      // settled copy cached at settlement still answers the same read.
      (runtime as any).delegations.delete(delegationId);
      const after = await listTool(runtime).execute("list-2", {});
      const entries = after.details.delegations as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        delegationId,
        status: "completed",
        recovered: true,
        turns: live.result.turns,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("marks only the live report delivered when a wait mixes live and historical ids", async () => {
    const runtime = createRuntime([
      taskRow({ callId: "task-old", delegationId: "del-old", completedAt: START + 1_000 }),
      waitRow({
        callId: "wait-old",
        delegationId: "del-old",
        report: "Old report.",
        completedAt: START + 1_000,
      }),
    ]);
    try {
      const started = await taskTool(runtime).execute("task-1", {
        agent: "explorer",
        task: "Look around.",
      });
      const delegationId = (started.details as any).delegationId as string;
      await settleStatus(runtime, delegationId);
      const waited = await waitTool(runtime).execute("wait-1", {
        delegationIds: [delegationId, "del-old"],
      });
      const text = (waited.content[0] as { text: string }).text;
      expect(text).toContain("Old report.");
      expect((waited.details as any).recoveredDelegationIds).toEqual(["del-old"]);
      await acceptAcceptedMessage(runtime, toolResultMessage("wait-1", waited));
      expect((runtime as any).delegations.get(delegationId).reportDelivered).toBe(true);
      // History is not a delivery boundary: reading it again stays a plain
      // read of the same stored report.
      const reread = await waitTool(runtime).execute("wait-2", {
        delegationIds: ["del-old"],
      });
      expect((reread.content[0] as { text: string }).text).toContain("Old report.");
      expect((reread.details as any).recoveredDelegationIds).toEqual(["del-old"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("never lists a live id twice", () => {
    const live = { delegationId: "del-1", agentName: "explorer", status: "completed", startedAt: 1, lastActivityAt: 2, turns: 1, toolCalls: 0 };
    const stale: RecoveredDelegation = {
      ...live,
      recovered: true,
      toolCallId: "task-1",
      report: "old",
      reportSource: "taskwait-result",
      statusSource: "taskwait-result",
    };
    const merged = mergeDelegationViews([live], [stale]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(live);
  });

  it("bounds the recovered view to the live retention cap", async () => {
    const history: UiMessage[] = [];
    for (let index = 0; index < MAX_RECOVERED_DELEGATIONS + 5; index += 1) {
      history.push(
        taskRow({
          callId: `task-${index}`,
          delegationId: `del-${index}`,
          startedAt: START + index,
          completedAt: START + index + 1,
        }),
      );
    }
    const runtime = createRuntime(history);
    try {
      const listed = await listTool(runtime).execute("list-1", {});
      const ids = (listed.details.delegations as Array<{ delegationId: string }>).map(
        (entry) => entry.delegationId,
      );
      expect(ids).toHaveLength(MAX_RECOVERED_DELEGATIONS);
      expect(ids).not.toContain("del-0");
      expect(ids).toContain(`del-${MAX_RECOVERED_DELEGATIONS + 4}`);
    } finally {
      await runtime.dispose();
    }
  });
});
