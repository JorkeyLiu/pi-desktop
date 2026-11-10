import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  DelegationHandoffCheckpoint,
  SubagentDefinition,
} from "@pi-desktop/shared";
import {
  contextBudgetLimitsFor,
  type ContextBudgetLimits,
} from "./context-budget.js";
import {
  chainDeliveryDirectives,
  chainRowsToMessages,
  rebuildChainsFromTranscript,
  restorableHandoffCheckpoint,
  seedDelegateMessages,
  seedHandoffCheckpointMessages,
  type DelegationChain,
} from "./delegation-history.js";
import { buildProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";
import { SubagentRun, type SubagentRunOptions } from "./subagent.js";
import {
  SUBAGENT_HANDOFF_TOOL_NAME,
  type InstalledSubagentHandoff,
} from "./subagent-handoff.js";
import type { UiMessage } from "@pi-desktop/shared";
import type { DelegationChainRegistry } from "./delegation-chain.js";
import { delegationSummary } from "./subagent-progress.js";
import { DesktopAgentRuntime } from "./runtime.js";

import { seedResumedDelegate, seedResumedDelegateContext } from "./subagent-resume.js";

/**
 * A durable handoff checkpoint, driven both as a pure seed and through the real
 * run object.
 *
 * The contract under test: a boundary is written only after the context was
 * actually replaced, it is an identity over persisted child rows, a resume
 * restores the head plus the rows after it, and every pre-checkpoint transcript
 * still seeds exactly as it did before.
 */

const CHAIN = "chain-1";
const FIRST_CALL = "task-1";
const RESUME_CALL = "task-2";
const AGENT = "explorer";

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

function budget(hardLimit = 100_000): ContextBudgetLimits {
  return hardLimit >= 100_000
    ? contextBudgetLimitsFor({ contextWindow: 1_000_000, maxTokens: 32_000 })
    : { hardLimit, requestHeadroom: 0, keepRecentTokens: 0 };
}

const CREATED = new Date(1_700_000_000_000).toISOString();

function row(
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return {
    id,
    role,
    content,
    createdAt: CREATED,
    status: "complete",
    parentToolCallId: FIRST_CALL,
    agentName: AGENT,
    ...extra,
  };
}

function makeCheckpoint(
  overrides: Partial<DelegationHandoffCheckpoint> = {},
): DelegationHandoffCheckpoint {
  return {
    version: 1,
    delegateSessionId: CHAIN,
    delegationId: "delegation-1",
    sourceToolCallId: FIRST_CALL,
    agentName: AGENT,
    generation: 1,
    throughRowId: "absorbed-row",
    summary: "[Delegated-task handoff 1]\nSummary text.",
    originalTask: "Find the permission dialog.",
    directives: [],
    installedAt: CREATED,
    ...overrides,
  };
}

function text(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

describe("installed handoff checkpoint seeding", () => {
  it("cuts the absorbed history out of a resumed seed", () => {
    const rows: UiMessage[] = [
      row("absorbed-assistant", "assistant", "older work that was handed off"),
      row("absorbed-row", "assistant", "the last absorbed row"),
      row("after-assistant", "assistant", "work done after the rollover"),
    ];
    const checkpoint = makeCheckpoint({ throughRowId: "absorbed-row" });

    const seeded = seedHandoffCheckpointMessages({
      checkpoint,
      rows,
      directives: [],
      provider,
      model: buildProviderModel(provider),
      budget: budget(),
    });

    expect(seeded).toBeDefined();
    expect(seeded!.map(text)).toEqual([
      checkpoint.originalTask,
      checkpoint.summary,
      "work done after the rollover",
    ]);
    // Nothing the handoff absorbed is replayed.
    expect(seeded!.map(text).join("\n")).not.toContain("older work that was handed off");
  });

  it("keeps two identical directions as two rows, in delivery order, with their images", () => {
    const image = {
      kind: "image" as const,
      name: "dialog.png",
      ref: "attachments/dialog.png",
      mimeType: "image/png",
      data: "aGVsbG8=",
    };
    const rows: UiMessage[] = [
      row("direction-1", "user", "Look again.", {
        steering: true,
        attachments: [image],
      }),
      row("direction-2", "user", "Look again.", { steering: true }),
      row("absorbed-row", "assistant", "the last absorbed row"),
    ];
    const directives = [rows[0]!, rows[1]!];
    const checkpoint = makeCheckpoint({
      directives: [
        { text: "Find the permission dialog.", opening: true },
        { rowId: "direction-1", text: "Look again." },
        { rowId: "direction-2", text: "Look again." },
      ],
    });

    const seeded = seedHandoffCheckpointMessages({
      checkpoint,
      rows,
      directives,
      provider,
      model: buildProviderModel(provider),
      budget: budget(),
    });

    expect(seeded).toBeDefined();
    const userRows = seeded!.filter((message) => message.role === "user");
    // Original task, the two directions (identical text, distinct rows), summary.
    expect(userRows).toHaveLength(4);
    expect(text(userRows[1]!)).toContain("Look again.");
    expect(text(userRows[2]!)).toContain("Look again.");
    const firstDirection = userRows[1] as { content: Array<{ type: string; data?: string }> };
    expect(firstDirection.content.some((block) => block.type === "image")).toBe(true);
  });

  it("falls back to undefined when the boundary row is gone", () => {
    const seeded = seedHandoffCheckpointMessages({
      checkpoint: makeCheckpoint({ throughRowId: "missing-row" }),
      rows: [row("present-row", "assistant", "history")],
      directives: [],
      provider,
      model: buildProviderModel(provider),
      budget: budget(),
    });
    expect(seeded).toBeUndefined();
  });

  it("keeps the head and summary when the replay tail crosses the budget", () => {
    const rows: UiMessage[] = [
      row("absorbed-row", "assistant", "absorbed"),
      row("after-1", "assistant", "tail ".repeat(4000)),
    ];
    const seeded = seedHandoffCheckpointMessages({
      checkpoint: makeCheckpoint(),
      rows,
      directives: [],
      provider,
      model: buildProviderModel(provider),
      budget: budget(200),
    });
    expect(seeded?.map(text)).toEqual([
      "Find the permission dialog.",
      makeCheckpoint().summary,
    ]);
  });
});

describe("checkpoint selection", () => {
  it("uses the newest checkpoint whose boundary row still exists", () => {
    const older = makeCheckpoint({ generation: 1, throughRowId: "row-1" });
    const newer = makeCheckpoint({
      generation: 2,
      delegationId: "delegation-2",
      throughRowId: "row-2",
    });
    const rows = [row("row-1", "assistant", "one")];
    // The newest boundary is lost to a truncated branch, so the older one applies.
    expect(restorableHandoffCheckpoint([newer, older], rows)?.generation).toBe(1);
    expect(
      restorableHandoffCheckpoint(
        [newer, older],
        [row("row-1", "assistant", "one"), row("row-2", "assistant", "two")],
      )?.generation,
    ).toBe(2);
    expect(restorableHandoffCheckpoint(undefined, rows)).toBeUndefined();
  });

  it("rebuilds the latest installed checkpoints from the chain's Task rows", () => {
    const firstTask: UiMessage = {
      id: FIRST_CALL,
      role: "tool",
      content: "",
      createdAt: CREATED,
      toolCallId: FIRST_CALL,
      toolName: "Task",
      toolArgs: { agent: AGENT, task: "Find the permission dialog." },
      toolResult: {
        content: [],
        details: {
          delegationId: "delegation-1",
          agent: AGENT,
          status: "completed",
          handoffCheckpoint: makeCheckpoint({ generation: 1 }),
        },
      },
    };
    const resumedTask: UiMessage = {
      ...firstTask,
      id: RESUME_CALL,
      toolCallId: RESUME_CALL,
      toolArgs: {
        agent: AGENT,
        task: "Continue.",
        resume: "delegation-1",
      },
      toolResult: {
        content: [],
        details: {
          delegationId: "delegation-2",
          agent: AGENT,
          status: "completed",
          handoffCheckpoint: makeCheckpoint({
            version: 1,
            generation: 2,
            delegationId: "delegation-2",
            throughRowId: "row-2",
          }),
        },
      },
    };
    const rebuilt = rebuildChainsFromTranscript([firstTask, resumedTask]);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]!.handoffCheckpoints?.map((entry) => entry.generation)).toEqual([
      2, 1,
    ]);
  });

  it("represents a checkpoint-free chain exactly as before (no field, no boundary)", () => {
    const task: UiMessage = {
      id: FIRST_CALL,
      role: "tool",
      content: "",
      createdAt: CREATED,
      toolCallId: FIRST_CALL,
      toolName: "Task",
      toolArgs: { agent: AGENT, task: "Find the permission dialog." },
      toolResult: {
        content: [],
        details: { delegationId: "delegation-1", agent: AGENT, status: "completed" },
      },
    };
    const rebuilt = rebuildChainsFromTranscript([task]);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]!.handoffCheckpoints).toBeUndefined();

    // The pre-checkpoint seed is the whole chain history, unchanged.
    const rows = [
      row("assistant-1", "assistant", "read the dialog"),
      row("assistant-2", "assistant", "wrote the test"),
    ];
    const seeded = seedDelegateMessages({
      originalTask: "Find the permission dialog.",
      rows,
      provider,
      model: buildProviderModel(provider),
      budget: budget(),
    });
    expect(seeded.map(text)).toEqual([
      "Find the permission dialog.",
      "read the dialog",
      "wrote the test",
    ]);
  });
});

describe("Task(resume) seeding through the chain", () => {
  it("restores the installed head and post-boundary rows, not the absorbed ones", async () => {
    const transcript: UiMessage[] = [
      row("absorbed-1", "assistant", "history the handoff absorbed"),
      row("absorbed-row", "assistant", "last absorbed row"),
      row("after-row", "assistant", "work after the rollover"),
    ];
    const chain: DelegationChain = {
      delegateSessionId: CHAIN,
      toolCallIds: [FIRST_CALL, RESUME_CALL],
      delegationIds: ["delegation-1", "delegation-2"],
      agentName: AGENT,
      readFiles: [],
      readLineCount: 0,
      originalTask: "Find the permission dialog.",
      latestDelegationId: "delegation-2",
      latestStatus: "completed",
      lastActivityAt: 1,
      handoffCheckpoints: [
        makeCheckpoint({
          throughRowId: "absorbed-row",
          directives: [{ text: "Find the permission dialog.", opening: true }],
        }),
      ],
    };

    const seeded = await seedResumedDelegate(transcript, chain, provider);

    expect(seeded?.map(text)).toEqual([
      "Find the permission dialog.",
      makeCheckpoint().summary,
      "work after the rollover",
    ]);
  });

  it("seeds the full chain history when the boundary row is gone", async () => {
    const transcript: UiMessage[] = [row("absorbed-1", "assistant", "history")];
    const chain: DelegationChain = {
      delegateSessionId: CHAIN,
      toolCallIds: [FIRST_CALL],
      delegationIds: ["delegation-1"],
      agentName: AGENT,
      readFiles: [],
      readLineCount: 0,
      originalTask: "Find the permission dialog.",
      latestDelegationId: "delegation-1",
      latestStatus: "completed",
      lastActivityAt: 1,
      handoffCheckpoints: [makeCheckpoint({ throughRowId: "missing-row" })],
    };

    const seeded = await seedResumedDelegate(transcript, chain, provider);

    expect(seeded?.map(text)).toEqual([
      "Find the permission dialog.",
      "history",
    ]);
  });
});

/** A `SubagentRun` driven only through its own boundary and handoff tool. */
type Harness = {
  run: SubagentRun;
  agent: {
    state: { messages: AgentMessage[]; tools: DelegateTool[] };
    prepareNextTurnWithContext?: (
      turn: unknown,
      signal: AbortSignal,
    ) => Promise<{ context?: { messages: AgentMessage[] } } | undefined>;
  };
};

type DelegateTool = {
  name: string;
  execute: (id: string, args: unknown) => Promise<{
    isError?: boolean;
    details?: unknown;
    content: Array<{ type: string; text?: string }>;
  }>;
};

function definition(): SubagentDefinition {
  return {
    name: AGENT,
    description: "Search the workspace and report findings.",
    tools: ["Read"],
    prompt: "Find the answer and report it.",
    source: "builtin",
  };
}

function createRun(overrides: Partial<SubagentRunOptions> = {}): Harness {
  const run = new SubagentRun({
    definition: definition(),
    sessionId: "session-1",
    turnId: "turn-1",
    parentToolCallId: FIRST_CALL,
    delegationId: "delegation-1",
    task: "Find the permission dialog.",
    provider,
    thinkingLevel: "off",
    systemPrompt: "You are the explorer subagent.",
    tools: [],
    onEvent: () => {},
    selfHandoff: { kind: "tool-calls", value: 1 },
    ...overrides,
  });
  return {
    run,
    agent: (run as unknown as { agent: Harness["agent"] }).agent,
  };
}

function seed(agent: Harness["agent"]): void {
  agent.state.messages = [
    { role: "system", content: "You are the explorer subagent.", timestamp: 0 },
    { role: "user", content: "Find the permission dialog.", timestamp: 1 },
  ];
}

async function boundary(agent: Harness["agent"]) {
  return agent.prepareNextTurnWithContext!(
    { toolResults: [] },
    new AbortController().signal,
  );
}

function recordToolCalls(run: SubagentRun, count: number): void {
  const handleEvent = (run as unknown as {
    handleEvent: (event: unknown) => void;
  }).handleEvent.bind(run);
  for (let index = 0; index < count; index += 1) {
    handleEvent({
      type: "tool_execution_start",
      toolCallId: `child-call-${index}`,
      toolName: "Read",
      args: {},
    });
  }
}

/** One tool call that also persisted its tool row, moving the boundary cursor. */
function recordPersistedToolCall(run: SubagentRun, toolCallId = "child-call-0"): void {
  const handleEvent = (run as unknown as {
    handleEvent: (event: unknown) => void;
  }).handleEvent.bind(run);
  handleEvent({
    type: "tool_execution_start",
    toolCallId,
    toolName: "Read",
    args: { path: "src/parser.ts" },
  });
  handleEvent({
    type: "tool_execution_end",
    toolCallId,
    result: { content: [{ type: "text", text: "body" }] },
    isError: false,
  });
}

function emitSettledAssistant(run: SubagentRun, id: string): void {
  const handleEvent = (run as unknown as {
    handleEvent: (event: unknown) => void;
  }).handleEvent.bind(run);
  handleEvent({
    type: "message_start",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "part" }],
      api: "openai-completions",
      provider: provider.id,
      model: provider.modelId,
      usage: { input: 0, output: 0, total: 0 },
      stopReason: "stop",
      timestamp: 1,
    },
  });
  handleEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "read the dialog" }],
      api: "openai-completions",
      provider: provider.id,
      model: provider.modelId,
      usage: { input: 1, output: 1, total: 2 },
      stopReason: "stop",
      timestamp: 1,
    },
  });
  // The row identity the run emitted is generated internally; name the last
  // one so the assertion can see the cursor it reports.
  const last = (run as unknown as { lastPersistedRowId?: string })
    .lastPersistedRowId;
  expect(last).toBeTruthy();
  expect(id).toBeTruthy();
}

async function submit(run: SubagentRun, args: unknown) {
  const tool = (
    run as unknown as { agent: Harness["agent"] }
  ).agent.state.tools.find(
    (candidate) => candidate.name === SUBAGENT_HANDOFF_TOOL_NAME,
  );
  if (!tool) throw new Error("handoff tool is not attached");
  return tool.execute("handoff-call", args);
}

describe("handoff checkpoint persistence", () => {
  it("does not record a boundary from an accepted submission alone", async () => {
    const onHandoffInstalled = vi.fn(async (_installed: InstalledSubagentHandoff) => {});
    const harness = createRun({ onHandoffInstalled });
    seed(harness.agent);
    emitSettledAssistant(harness.run, "assistant-1");
    recordToolCalls(harness.run, 1);

    await boundary(harness.agent);
    const accepted = await submit(harness.run, { handoff: "Continue the task." });
    expect(accepted.isError).toBeUndefined();
    // Accepted, but no boundary ran yet: nothing installed, nothing recorded.
    expect(onHandoffInstalled).not.toHaveBeenCalled();
    expect(harness.agent.state.messages).toHaveLength(2);
  });

  it("reports the installed boundary only after the context was replaced", async () => {
    const onHandoffInstalled = vi.fn(async (_installed: InstalledSubagentHandoff) => {});
    const harness = createRun({ onHandoffInstalled });
    seed(harness.agent);
    emitSettledAssistant(harness.run, "assistant-1");
    recordToolCalls(harness.run, 1);
    await boundary(harness.agent);
    await submit(harness.run, { handoff: "Continue the task." });

    await boundary(harness.agent);

    expect(onHandoffInstalled).toHaveBeenCalledTimes(1);
    const installed = onHandoffInstalled.mock.calls[0]![0];
    expect(installed.generation).toBe(1);
    expect(installed.summary).toContain("[Delegated-task handoff 1]");
    const cursor = (harness.run as unknown as { lastPersistedRowId?: string })
      .lastPersistedRowId;
    expect(installed.absorbedRowIds).toContain(cursor);
    // The context really is the header plus the summary.
    expect(harness.agent.state.messages).toHaveLength(3);
  });

  it("keeps the installed context and reports the failure when the write fails", async () => {
    const onHandoffInstalled = vi.fn(async () => {
      throw new Error("the device rejected the checkpoint");
    });
    const harness = createRun({ onHandoffInstalled });
    seed(harness.agent);
    emitSettledAssistant(harness.run, "assistant-1");
    recordToolCalls(harness.run, 1);
    await boundary(harness.agent);
    await submit(harness.run, { handoff: "Continue the task." });

    await boundary(harness.agent);

    expect(harness.agent.state.messages).toHaveLength(3);
    const result = (
      harness.run as unknown as {
        result: (status: string, report: string) => {
          handoffCheckpointError?: { code: string; message: string };
        };
      }
    ).result("completed", "done");
    expect(result.handoffCheckpointError).toMatchObject({
      code: "SUBAGENT_HANDOFF_CHECKPOINT_FAILED",
      message: "the device rejected the checkpoint",
    });
  });
});

/** Resolve one tool the runtime exposes on its agent state. */
function runtimeTool(runtime: DesktopAgentRuntime, name: string): AgentTool {
  const internal = runtime as unknown as {
    agent: { state: { tools: AgentTool[] } };
  };
  const tool = internal.agent.state.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Runtime tool not found: ${name}`);
  return tool;
}

/**
 * A resumed run driven through its own `run()` entry and turn boundary.
 *
 * Only the provider transport is replaced (the fake `agent` never prompts); the
 * real `prepareNextTurnWithContext` boundary, handoff tool, steering, and
 * context replacement all run.
 */
function startResumedRun(options: {
  replay: AgentMessage[];
  directives: AgentMessage[];
  task: string;
  initialImages?: unknown[];
  handoffGenerationBase?: number;
  onHandoffInstalled?: (installed: InstalledSubagentHandoff) => Promise<void>;
  selfHandoff?: { kind: "tool-calls"; value: number };
}): Harness {
  const run = new SubagentRun({
    definition: definition(),
    sessionId: "session-1",
    turnId: "turn-1",
    parentToolCallId: RESUME_CALL,
    delegationId: "delegation-2",
    task: options.task,
    provider,
    thinkingLevel: "off",
    systemPrompt: "You are the explorer subagent.",
    tools: [],
    onEvent: () => {},
    selfHandoff: options.selfHandoff ?? { kind: "tool-calls", value: 1 },
    initialMessages: options.replay,
    handoffDirectives: options.directives,
    ...(options.initialImages ? { initialImages: options.initialImages as never } : {}),
    ...(options.handoffGenerationBase !== undefined
      ? { handoffGenerationBase: options.handoffGenerationBase }
      : {}),
    ...(options.onHandoffInstalled
      ? { onHandoffInstalled: options.onHandoffInstalled }
      : {}),
  });
  const real = (run as unknown as { agent: Harness["agent"] & { state: Record<string, unknown> } }).agent;
  const prepare = real.prepareNextTurnWithContext!.bind(run);
  const fake = {
    state: {
      messages: [...options.replay],
      tools: real.state.tools,
      model: (real.state as { model?: unknown }).model,
      systemPrompt: (real.state as { systemPrompt?: unknown }).systemPrompt,
      thinkingLevel: (real.state as { thinkingLevel?: unknown }).thinkingLevel,
    },
    prompt: async () => undefined,
    waitForIdle: async () => undefined,
    abort: () => undefined,
    prepareNextTurnWithContext: prepare,
  };
  (run as unknown as { agent: unknown }).agent = fake;
  return { run, agent: fake };
}

describe("fixed handoff header vs replayed checkpoint context", () => {
  it("does not pin a resumed checkpoint's old summary or execution tail after a rollover", async () => {
    const rows: UiMessage[] = [
      row("absorbed-row", "assistant", "execution history the handoff absorbed"),
      row("tail-row", "assistant", "work after the rollover"),
    ];
    const oldSummary = "[Delegated-task handoff 1]\nOLD SUMMARY THAT MUST NOT SURVIVE";
    const checkpoint = makeCheckpoint({
      throughRowId: "absorbed-row",
      summary: oldSummary,
      directives: [
        { toolCallId: FIRST_CALL, text: "Find the permission dialog.", opening: true },
        { toolCallId: RESUME_CALL, text: "Keep looking, then report." },
      ],
    });
    const chain: DelegationChain = {
      delegateSessionId: CHAIN,
      toolCallIds: [FIRST_CALL, RESUME_CALL],
      delegationIds: ["delegation-1", "delegation-2"],
      agentName: AGENT,
      readFiles: [],
      readLineCount: 0,
      originalTask: "Find the permission dialog.",
      latestStatus: "completed",
      lastActivityAt: 1,
      handoffCheckpoints: [checkpoint],
    };
    const transcript: UiMessage[] = [
      {
        id: FIRST_CALL,
        role: "tool",
        content: "",
        createdAt: CREATED,
        toolCallId: FIRST_CALL,
        toolArgs: { agent: AGENT, task: "Find the permission dialog." },
        toolStatus: "success",
        status: "complete",
      },
      ...rows,
      {
        id: RESUME_CALL,
        role: "tool",
        content: "",
        createdAt: CREATED,
        toolCallId: RESUME_CALL,
        toolName: "Task",
        toolArgs: {
          agent: AGENT,
          task: "Keep looking, then report.",
          resume: "delegation-1",
        },
        toolStatus: "success",
        status: "complete",
      },
    ];
    const context = await seedResumedDelegateContext(transcript, chain, provider);
    expect(context).toBeDefined();
    // The replay really does restore the old summary and the post-boundary tail.
    expect(context!.replay.map(text)).toContain(oldSummary);
    expect(context!.replay.map(text)).toContain("work after the rollover");

    const harness = startResumedRun({
      replay: context!.replay,
      directives: context!.directives,
      task: "Now verify the fix.",
      handoffGenerationBase: 1,
      onHandoffInstalled: async () => undefined,
    });
    await harness.run.run();
    emitSettledAssistant(harness.run, "assistant-new");
    recordToolCalls(harness.run, 1);
    await boundary(harness.agent);
    await submit(harness.run, { handoff: "New summary text." });
    await boundary(harness.agent);

    const after = harness.agent.state.messages as AgentMessage[];
    const texts = after.map(text);
    expect(texts).toEqual([
      "Find the permission dialog.",
      "Keep looking, then report.",
      "Now verify the fix.",
      expect.stringContaining("[Delegated-task handoff 2]"),
    ]);
    // The old summary and the execution history it covered are gone.
    expect(texts.join("\n")).not.toContain("OLD SUMMARY THAT MUST NOT SURVIVE");
    expect(texts.join("\n")).not.toContain("execution history the handoff absorbed");
    expect(texts.join("\n")).not.toContain("work after the rollover");
  });

  it("replays the legacy full history for the first request without pinning any of it", async () => {
    const legacyHistory = [
      { role: "user", content: "Find the permission dialog.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "LEGACY-HISTORY-ROW" }],
        api: "openai-completions",
        provider: provider.id,
        model: provider.modelId,
        usage: { input: 1, output: 1, totalTokens: 2 },
        stopReason: "stop",
        timestamp: 2,
      },
    ] as AgentMessage[];
    const harness = startResumedRun({
      replay: legacyHistory,
      directives: [{ role: "user", content: "Find the permission dialog.", timestamp: 1 }],
      task: "See it through.",
    });
    await harness.run.run();
    emitSettledAssistant(harness.run, "assistant-new");
    recordToolCalls(harness.run, 1);
    await boundary(harness.agent);
    await submit(harness.run, { handoff: "Continue from here." });
    await boundary(harness.agent);

    const texts = (harness.agent.state.messages as AgentMessage[]).map(text);
    expect(texts.slice(0, 2)).toEqual(["Find the permission dialog.", "See it through."]);
    expect(texts.join("\n")).not.toContain("LEGACY-HISTORY-ROW");
  });

  it("keeps repeated resume directives and their images as distinct rows", async () => {
    const image = {
      kind: "image" as const,
      name: "dialog.png",
      ref: "attachments/dialog.png",
      mimeType: "image/png",
      data: "aGVsbG8=",
    };
    const transcript: UiMessage[] = [
      {
        id: "task-root",
        role: "tool",
        content: "",
        createdAt: CREATED,
        toolCallId: "task-root",
        toolName: "Task",
        toolArgs: { agent: AGENT, task: "Find the permission dialog." },
        toolStatus: "success",
        status: "complete",
      },
      {
        id: "continue-1",
        role: "user",
        content: "Look again.",
        createdAt: CREATED,
        steering: true,
        parentToolCallId: "task-continue-1",
        agentName: AGENT,
        attachments: [image],
        status: "complete",
      },
      {
        id: "task-continue-1",
        role: "tool",
        content: "",
        createdAt: CREATED,
        toolCallId: "task-continue-1",
        toolName: "Task",
        toolArgs: { agent: AGENT, task: "Look again.", resume: "delegation-1", source: "user" },
        toolStatus: "success",
        status: "complete",
      },
      {
        id: "task-resume-2",
        role: "tool",
        content: "",
        createdAt: CREATED,
        toolCallId: "task-resume-2",
        toolName: "Task",
        toolArgs: { agent: AGENT, task: "Look again.", resume: "delegation-1" },
        toolStatus: "success",
        status: "complete",
      },
    ];
    const chain: DelegationChain = {
      delegateSessionId: CHAIN,
      toolCallIds: ["task-root", "task-continue-1", "task-resume-2"],
      delegationIds: ["delegation-1"],
      agentName: AGENT,
      readFiles: [],
      readLineCount: 0,
      originalTask: "Find the permission dialog.",
      lastActivityAt: 1,
    };
    const live = chainDeliveryDirectives(transcript, chain);
    // One instruction per identity: the user-continue echo and its Task marker
    // are one directive, and the identical resume text is another.
    expect(live).toHaveLength(3);
    expect(live.map((directive) => directive.text)).toEqual([
      "Find the permission dialog.",
      "Look again.",
      "Look again.",
    ]);
    expect(live[1]!.toolCallId).toBe("task-continue-1");
    expect(live[1]!.rowId).toBe("continue-1");
    expect(live[1]!.attachments?.[0]?.ref).toBe("attachments/dialog.png");
    expect(live[2]!.toolCallId).toBe("task-resume-2");
    expect(live[2]!.rowId).toBeUndefined();

    const directives = chainRowsToMessages(
      live.map((directive) => directive.row),
      provider,
      buildProviderModel(provider),
    );
    const harness = startResumedRun({
      replay: directives,
      directives,
      task: "Ship the fix.",
    });
    await harness.run.run();
    emitSettledAssistant(harness.run, "assistant-new");
    recordToolCalls(harness.run, 1);
    await boundary(harness.agent);
    await submit(harness.run, { handoff: "Final state." });
    await boundary(harness.agent);

    const after = harness.agent.state.messages as AgentMessage[];
    expect(after.map(text).slice(0, 4)).toEqual([
      "Find the permission dialog.",
      "Look again.",
      "Look again.",
      "Ship the fix.",
    ]);
    const firstLook = after[1] as { content: Array<{ type: string; data?: string }> };
    expect(firstLook.content.some((block) => block.type === "image")).toBe(true);
  });
});

describe("durable tool identity and attachment refs", () => {
  it("names the boundary with the tool row id the host actually persists", async () => {
    let written: InstalledSubagentHandoff | undefined;
    const harness = createRun({
      onHandoffInstalled: async (installed) => {
        written = installed;
      },
    });
    recordPersistedToolCall(harness.run);
    await boundary(harness.agent);
    await submit(harness.run, { handoff: "Continue." });
    await boundary(harness.agent);
    const cursor = written!.absorbedRowIds.at(-1)!;
    // The host persists a delegate tool row under its bare call id
    // (`event-persistence.ts`/`host-core` turn rows); the cursor must be that
    // same value, never a synthetic prefix.
    expect(cursor).toBe("child-call-0");
    expect(cursor).not.toContain("delegate-tool");

    const persistedRows: UiMessage[] = [
      {
        id: cursor,
        role: "tool",
        content: "",
        createdAt: CREATED,
        toolCallId: cursor,
        toolName: "Read",
        toolArgs: { path: "src/parser.ts" },
        toolResult: { content: [{ type: "text", text: "body" }] },
        toolStatus: "success",
        status: "complete",
        parentToolCallId: FIRST_CALL,
        agentName: AGENT,
      },
    ];
    const taskRow: UiMessage = {
      id: FIRST_CALL,
      role: "tool",
      content: "",
      createdAt: CREATED,
      toolCallId: FIRST_CALL,
      toolName: "Task",
      toolArgs: { agent: AGENT, task: "Find the permission dialog." },
      toolStatus: "success",
      status: "complete",
      toolResult: {
        content: [],
        details: {
          delegationId: "delegation-1",
          agent: AGENT,
          status: "completed",
          handoffCheckpoint: makeCheckpoint({ throughRowId: cursor, generation: 1 }),
        },
      },
    };
    const chain = rebuildChainsFromTranscript([taskRow, ...persistedRows]);
    expect(chain).toHaveLength(1);
    const seeded = await seedResumedDelegate(persistedRows, chain[0]!, provider);
    expect(seeded?.map(text)).toEqual([
      "Find the permission dialog.",
      makeCheckpoint().summary,
    ]);
  });
});

describe("checkpoint persistence failure is observable", () => {
  it("surfaces a failed checkpoint write in the live summary and TaskWait details", async () => {
    const host = {
      call: vi.fn(async (method: string) => {
        if (method === "session.appendMessage") {
          throw new Error("the device rejected the checkpoint");
        }
        return undefined;
      }),
      onNotification: vi.fn(() => () => {}),
    };
    const runtime = new DesktopAgentRuntime({
      host: host as never,
      sessionId: "session-1",
      mode: "agent",
      provider,
      commandShell: {
        id: "bash",
        label: "Bash",
        dialect: "posix",
        available: true,
        isDefault: true,
      },
      thinkingLevel: "medium",
      subagents: [definition()],
      onEvent: () => {},
    });
    const internal = runtime as unknown as {
      delegationChains: DelegationChainRegistry;
      delegations: Map<string, unknown>;
      transcriptHistory: UiMessage[];
      persistInstalledHandoffCheckpoint: (...args: unknown[]) => Promise<void>;
    };
    const chain = internal.delegationChains.start({
      delegateSessionId: "chain-1",
      delegationId: "delegation-1",
      toolCallId: FIRST_CALL,
      agentName: AGENT,
      originalTask: "Find the permission dialog.",
      objective: "Find the permission dialog.",
      latestModelId: provider.modelId,
    });
    const validRow = row("persisted-row", "assistant", "work the handoff absorbed");
    internal.transcriptHistory.push(validRow);
    internal.transcriptHistory.push({
      id: "child-call-0",
      role: "tool",
      content: "",
      createdAt: CREATED,
      toolCallId: "child-call-0",
      toolName: "Read",
      toolArgs: { path: "src/parser.ts" },
      toolResult: { content: [{ type: "text", text: "body" }] },
      toolStatus: "success",
      status: "complete",
      parentToolCallId: FIRST_CALL,
      agentName: AGENT,
    });
    const taskMessage: UiMessage = {
      id: FIRST_CALL,
      role: "tool",
      content: "",
      createdAt: CREATED,
      toolCallId: FIRST_CALL,
      toolName: "Task",
      toolArgs: { agent: AGENT, task: "Find the permission dialog." },
      toolResult: {
        content: [],
        details: { delegationId: "delegation-1", agent: AGENT, status: "running" },
      },
      status: "complete",
    };
    const record = {
      delegationId: "delegation-1",
      parentToolCallId: FIRST_CALL,
      taskTurnId: "turn-1",
      agentName: AGENT,
      modelId: provider.modelId,
      thinkingLevel: "off",
      status: "running",
      startedAt: 1_700_000_000_000,
      turns: 1,
      toolCalls: 1,
      delivery: "parent" as const,
      reportDelivered: false,
      lastActivityAt: 1_700_000_000_000,
      lastPhase: "thinking",
      wake: { kind: "none" },
      completion: Promise.resolve(),
      resolveCompletion: () => {},
      abort: () => {},
      stopRequested: false,
      startedEpoch: 0,
      taskMessage,
      delegateSessionId: chain.delegateSessionId,
      handoffDirectiveRecords: [
        { toolCallId: FIRST_CALL, text: "Find the permission dialog.", opening: true },
      ],
    };
    internal.delegations.set("delegation-1", record);
    const harness = startResumedRun({
      replay: [{ role: "user", content: "Find the permission dialog.", timestamp: 1 }],
      directives: [{ role: "user", content: "Find the permission dialog.", timestamp: 1 }],
      task: "Continue.",
      onHandoffInstalled: (installed) =>
        internal.persistInstalledHandoffCheckpoint(record, chain, installed),
    });
    await harness.run.run();
    recordPersistedToolCall(harness.run);
    await boundary(harness.agent);
    await submit(harness.run, { handoff: "Continue." });
    await boundary(harness.agent);

    // Live lifecycle details name the failure immediately.
    expect(delegationSummary(record as never)).toMatchObject({
      handoffCheckpointError: {
        code: "SUBAGENT_HANDOFF_CHECKPOINT_FAILED",
        message: "the device rejected the checkpoint",
      },
    });
    // The run result carries it too, and the chain keeps no boundary.
    const result = (
      harness.run as unknown as {
        result: (status: string, report: string) => Record<string, unknown>;
      }
    ).result("completed", "done");
    expect(result.handoffCheckpointError).toMatchObject({
      code: "SUBAGENT_HANDOFF_CHECKPOINT_FAILED",
    });
    expect(chain.handoffCheckpoints).toBeUndefined();
    // The public TaskWait result renders the same failure on a settled run.
    (record as { status: string }).status = "completed";
    (record as { result?: unknown }).result = { report: "done", turns: 1, toolCalls: 1 };
    const wait = runtimeTool(runtime, "TaskWait");
    const outcome = await wait.execute("wait-1", { delegationIds: ["delegation-1"] });
    expect(
      (outcome.details as { delegations: Array<Record<string, unknown>> })
        .delegations[0],
    ).toMatchObject({
      handoffCheckpointError: { code: "SUBAGENT_HANDOFF_CHECKPOINT_FAILED" },
    });
    await runtime.dispose();
  });
});
