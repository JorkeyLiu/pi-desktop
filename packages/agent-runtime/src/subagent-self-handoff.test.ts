import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  SubagentDefinition,
  SubagentSelfHandoffSettings,
} from "@pi-desktop/shared";
import { SubagentRun, type SubagentRunOptions } from "./subagent.js";
import {
  MAX_SUBAGENT_HANDOFF_FAILURES,
  MAX_SUBAGENT_HANDOFF_UNANSWERED,
  SUBAGENT_HANDOFF_TOOL_NAME,
} from "./subagent-handoff.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

/**
 * A delegate's self-handoff, driven through the real run object.
 *
 * These tests call the same turn boundary and the same tool the agent loop
 * calls, with no provider request in between: a valid boundary is a pure
 * context operation, so the contract — request once, install only after a
 * validated submission, keep the dispatch header, drop the absorbed segment,
 * never concatenate generations, never clear on failure — is observable here.
 * The request itself is read through the same `transformContext` hook every
 * provider request passes through, which is also what the retry case exercises.
 */

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

const TASK = "Find where the permission dialog is rendered.";

function definition(): SubagentDefinition {
  return {
    name: "explorer",
    description: "Search the workspace and report findings.",
    tools: ["Read"],
    prompt: "Find the answer and report it.",
    source: "builtin",
  };
}

type DelegateTool = {
  name: string;
  execute: (id: string, args: unknown) => Promise<{
    isError?: boolean;
    details?: unknown;
    content: Array<{ type: string; text?: string }>;
  }>;
};

type DelegateAgent = {
  state: {
    messages: AgentMessage[];
    systemPrompt?: string;
    tools: DelegateTool[];
  };
  transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
  streamFunction?: (
    model: unknown,
    context: { messages: AgentMessage[] },
  ) => ReturnType<typeof createAssistantMessageEventStream>;
  continue: () => Promise<void>;
  prepareNextTurnWithContext?: (
    turn: unknown,
    signal: AbortSignal,
  ) => Promise<{ context?: { messages: AgentMessage[] } } | undefined>;
};

type HandoffStateView = {
  handoffs: number;
  failures: number;
  noProgress: number;
  toolCalls: number;
  turns: number;
  unanswered: number;
  requested: boolean;
};

function createRun(
  selfHandoff?: SubagentSelfHandoffSettings,
  overrides: Partial<SubagentRunOptions> = {},
) {
  const events: Array<{ event: { type: string } }> = [];
  const run = new SubagentRun({
    definition: definition(),
    sessionId: "session-1",
    turnId: "turn-1",
    parentToolCallId: "task-1",
    task: TASK,
    provider,
    thinkingLevel: "off",
    systemPrompt: "You are the explorer subagent.",
    tools: [],
    onEvent: (envelope) => events.push(envelope as { event: { type: string } }),
    ...(selfHandoff ? { selfHandoff } : {}),
    ...overrides,
  });
  return {
    run,
    agent: (run as unknown as { agent: DelegateAgent }).agent,
    events,
    handoffState: (run as unknown as { handoffState: HandoffStateView })
      .handoffState,
  };
}

type Harness = ReturnType<typeof createRun>;

function seed(agent: DelegateAgent, extra: AgentMessage[] = []): void {
  agent.state.messages = [
    { role: "system", content: "You are the explorer subagent.", timestamp: 0 },
    { role: "user", content: TASK, timestamp: 1 },
    ...extra,
  ];
}

function boundary(agent: DelegateAgent) {
  return agent.prepareNextTurnWithContext!(
    { toolResults: [] },
    new AbortController().signal,
  );
}

/** The request context exactly as the provider would receive it. */
async function requestMessages(agent: DelegateAgent): Promise<AgentMessage[]> {
  return agent.transformContext!([]);
}

async function submit(harness: Harness, args: unknown) {
  const tool = harness.agent.state.tools.find(
    (candidate) => candidate.name === SUBAGENT_HANDOFF_TOOL_NAME,
  );
  if (!tool) throw new Error("handoff tool is not attached");
  return tool.execute("handoff-call", args);
}

/** Drive the run's own tool-call counter through the real event path. */
function recordToolCalls(harness: Harness, count: number): void {
  const handleEvent = (harness.run as unknown as {
    handleEvent: (event: unknown) => void;
  }).handleEvent.bind(harness.run);
  for (let index = 0; index < count; index += 1) {
    handleEvent({
      type: "tool_execution_start",
      toolCallId: `child-call-${index}`,
      toolName: "Read",
      args: {},
    });
  }
}

/**
 * A handoff as the delegate writes it: its own order, its own formatting, and
 * no field names the runtime ever asked for.
 */
const HANDOFF = [
  "Located the permission dialog in apps/desktop/src/components/PermissionDialog.tsx; it is mounted from the settings layout.",
  "Decision: the dialog's public props stay as they are.",
  "",
  "- pnpm lint — pass",
  "- Next: add apps/desktop/test/permission-dialog.test.mjs for the regression.",
].join("\n");

const submittable = { handoff: HANDOFF };

/** A second, deliberately different continuation for generation two. */
const SECOND_HANDOFF =
  "Second generation work: the regression test is written.\n\nNext: finish with the second generation.";

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

function messageTexts(messages: readonly AgentMessage[]): string[] {
  return messages.map(messageText);
}

function text(messages: readonly AgentMessage[]): string {
  return messageTexts(messages).join("\n");
}

const REQUEST_MARKER = "[Context handoff required]";

describe("SubagentRun self-handoff", () => {
  it("attaches the handoff tool only when a trigger is enabled", () => {
    const off = createRun();
    expect(off.agent.state.tools).toHaveLength(0);
    const enabled = createRun({ kind: "tool-calls", value: 5 });
    expect(enabled.agent.state.tools.map((tool) => tool.name)).toEqual([
      SUBAGENT_HANDOFF_TOOL_NAME,
    ]);
  });

  it("asks at the threshold through the request hook, never the transcript", async () => {
    const harness = createRun({ kind: "tool-calls", value: 2 });
    seed(harness.agent);
    recordToolCalls(harness, 2);

    const update = await boundary(harness.agent);

    // Nothing about the durable context changed at this boundary.
    expect(update).toBeUndefined();
    const request = (await requestMessages(harness.agent)).at(-1);
    expect(request?.role).toBe("user");
    expect(messageText(request!)).toContain(REQUEST_MARKER);
    expect(harness.handoffState.requested).toBe(true);
    expect(harness.handoffState.unanswered).toBe(1);
    // Transient: the run's own messages (and therefore the transcript) never
    // contain the runtime's prompt.
    expect(text(harness.agent.state.messages)).not.toContain(REQUEST_MARKER);
  });

  it("installs a validated submission at the next boundary, keeping the dispatch header", async () => {
    const harness = createRun({ kind: "tool-calls", value: 1 });
    seed(harness.agent);
    recordToolCalls(harness, 1);
    await boundary(harness.agent);

    const accepted = await submit(harness, submittable);
    expect(accepted.isError).toBeUndefined();
    expect(harness.handoffState.handoffs).toBe(0);

    // Nothing is replaced until the safe boundary runs.
    expect(harness.agent.state.messages).toHaveLength(2);

    const update = await boundary(harness.agent);
    const messages = harness.agent.state.messages;

    expect(harness.handoffState.handoffs).toBe(1);
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
    ]);
    // Dispatch header kept verbatim — not summarized, not regenerated.
    expect((messages[1] as { content: string }).content).toBe(TASK);
    const installed = messageText(messages[2]!);
    expect(installed).toContain("[Delegated-task handoff 1]");
    // The delegate's own continuation reaches the next request verbatim and
    // unmixed with the segment it replaced: what the mechanism carries is the
    // text its author wrote, which is the whole point of a self-authored
    // handoff.
    expect(installed).toContain(HANDOFF);
    expect(text(messages)).toContain(TASK);
    // The loop still gets its own array (D620).
    expect(update?.context?.messages).not.toBe(messages);
    expect((update?.context?.messages[1] as { content: string }).content).toBe(
      TASK,
    );
    // The answered request is gone: neither queued nor re-sent.
    expect(harness.handoffState.requested).toBe(false);
    expect(harness.handoffState.unanswered).toBe(0);
    expect(text(await requestMessages(harness.agent))).not.toContain(
      REQUEST_MARKER,
    );
  });

  it("replaces the previous handoff instead of concatenating generations", async () => {
    const harness = createRun({ kind: "tool-calls", value: 1 });
    seed(harness.agent);
    recordToolCalls(harness, 1);
    await boundary(harness.agent);
    await submit(harness, submittable);
    await boundary(harness.agent);

    // Second segment: another tool call, another request, another submission.
    recordToolCalls(harness, 1);
    await boundary(harness.agent);
    const second = await submit(harness, { handoff: SECOND_HANDOFF });
    expect(second.isError).toBeUndefined();
    await boundary(harness.agent);

    const messages = harness.agent.state.messages;
    expect(harness.handoffState.handoffs).toBe(2);
    // Header + exactly one summary: generation one is absorbed, not stacked.
    expect(messages).toHaveLength(3);
    expect((messages[1] as { content: string }).content).toBe(TASK);
    const summary = messageText(messages[2]!);
    expect(summary).toContain("[Delegated-task handoff 2]");
    expect(summary).toContain("Second generation work");
    expect(summary).not.toContain("Located the dialog");
  });

  it("rolls the context over more than eight times without an artificial cap", async () => {
    const harness = createRun({ kind: "tool-calls", value: 1 });
    seed(harness.agent);
    for (let generation = 1; generation <= 12; generation += 1) {
      recordToolCalls(harness, 1);
      await boundary(harness.agent);
      expect(harness.handoffState.requested).toBe(true);
      const accepted = await submit(harness, {
        handoff: `Generation ${generation} state.\n\nNext: continue generation ${generation}.`,
      });
      expect(accepted.isError).toBeUndefined();
      await boundary(harness.agent);
      // Every generation replaced the previous one; nothing accumulated.
      expect(harness.agent.state.messages).toHaveLength(3);
      expect(messageText(harness.agent.state.messages[2]!)).toContain(
        `[Delegated-task handoff ${generation}]`,
      );
    }
    expect(harness.handoffState.handoffs).toBe(12);
    // A failed-streak counter never inherits a spent budget from a segment
    // that ended in a successful rollover.
    expect(harness.handoffState.failures).toBe(0);
    expect(harness.handoffState.unanswered).toBe(0);
    // Still asking in the thirteenth segment.
    recordToolCalls(harness, 1);
    await boundary(harness.agent);
    expect(harness.handoffState.requested).toBe(true);
  });

  it("keeps the history when the submission is invalid", async () => {
    const harness = createRun({ kind: "tool-calls", value: 1 });
    seed(harness.agent);
    recordToolCalls(harness, 1);
    await boundary(harness.agent);
    const before = [...harness.agent.state.messages];

    // A submission with nothing written in it is the only way to be invalid:
    // there is no required field to omit.
    const rejected = await submit(harness, { handoff: "   \n  " });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.text).toContain("The handoff is empty");
    expect(harness.handoffState.failures).toBe(1);
    expect(harness.handoffState.handoffs).toBe(0);
    // The request stays outstanding so the delegate can correct it in the same
    // turn, but it is not re-sent with the correction.
    expect(harness.handoffState.requested).toBe(true);
    expect(text(await requestMessages(harness.agent))).not.toContain(
      REQUEST_MARKER,
    );

    await boundary(harness.agent);
    expect(harness.agent.state.messages).toEqual(before);
    expect(harness.handoffState.handoffs).toBe(0);
  });

  it("rejects a submission nobody asked for and stays inert when the trigger is off", async () => {
    const unasked = createRun({ kind: "tool-calls", value: 5 });
    seed(unasked.agent);
    const early = await submit(unasked, submittable);
    expect(early.isError).toBe(true);
    expect(early.content[0]?.text).toContain("No handoff was requested");
    expect(unasked.handoffState.failures).toBe(0);

    // A submission after the request was answered is equally unasked.
    const answered = createRun({ kind: "tool-calls", value: 1 });
    seed(answered.agent);
    recordToolCalls(answered, 1);
    await boundary(answered.agent);
    await submit(answered, submittable);
    const afterAnswer = await submit(answered, submittable);
    expect(afterAnswer.isError).toBe(true);
    expect(afterAnswer.content[0]?.text).toContain("A handoff is already recorded");

    const off = createRun();
    seed(off.agent);
    const update = await boundary(off.agent);
    expect(update).toBeUndefined();
    expect(off.agent.state.messages).toHaveLength(2);
    expect(await requestMessages(off.agent)).toHaveLength(0);
  });

  it("does not settle the run or end the parent's turn on a handoff", async () => {
    const harness = createRun({ kind: "tool-calls", value: 1 });
    seed(harness.agent);
    recordToolCalls(harness, 1);
    await boundary(harness.agent);
    await submit(harness, submittable);
    await boundary(harness.agent);

    expect(harness.run.isSettled()).toBe(false);
    expect(harness.events.some((envelope) => envelope.event.type === "agent_end")).toBe(
      false,
    );
    expect(harness.events.some((envelope) => envelope.event.type === "turn_start")).toBe(
      false,
    );
  });

  it("keeps the run's cumulative tool-call metric while resetting the segment", async () => {
    const harness = createRun({ kind: "tool-calls", value: 1 });
    seed(harness.agent);
    recordToolCalls(harness, 1);
    await boundary(harness.agent);
    await submit(harness, submittable);
    await boundary(harness.agent);

    expect(harness.handoffState.toolCalls).toBe(0);
    expect(harness.run.progress().toolCalls).toBe(1);
  });

  it("measures occupancy from the request, not from cumulative spend", async () => {
    const spent = createRun({ kind: "context-tokens", value: 20_000 });
    seed(spent.agent);
    // Billed spend alone must never drive the trigger.
    (spent.run as unknown as {
      recordUsage: (usage: unknown) => void;
    }).recordUsage({
      inputTokens: 900_000,
      outputTokens: 5,
      totalTokens: 900_005,
    });
    expect(spent.run.progress().usage?.totalTokens).toBe(900_005);
    expect(await boundary(spent.agent)).toBeUndefined();
    expect(spent.handoffState.requested).toBe(false);

    // The provider-visible system prompt and tool schemas are part of the
    // request, so they count toward the trigger even when the transcript is tiny.
    const heavy = createRun({ kind: "context-tokens", value: 1_000 });
    seed(heavy.agent, [{ role: "system", content: "rule ".repeat(1_200), timestamp: 0 }]);
    heavy.agent.state.tools = [
      {
        name: "Big",
        label: "Big",
        description: "t".repeat(4_000),
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [], details: {} }),
      },
    ] as never;
    await boundary(heavy.agent);
    expect(text(await requestMessages(heavy.agent))).toContain(REQUEST_MARKER);
    expect(heavy.handoffState.requested).toBe(true);
  });

  it("never re-asks immediately when the dispatch header alone exceeds the threshold", async () => {
    const harness = createRun({ kind: "context-tokens", value: 1_000 });
    // A dispatch brief larger than the whole budget: keeping it verbatim is a
    // requirement, so the rollover can never clear the trigger.
    harness.agent.state.messages = [
      { role: "system", content: "You are the explorer subagent.", timestamp: 0 },
      { role: "user", content: "rule ".repeat(1_400), timestamp: 1 },
    ];

    await boundary(harness.agent);
    expect(harness.handoffState.requested).toBe(true);
    await submit(harness, submittable);
    await boundary(harness.agent);
    expect(harness.handoffState.handoffs).toBe(1);
    // The header still exceeds the threshold, so the rollover made no progress.
    expect(harness.handoffState.noProgress).toBe(1);

    // No work happened: no second request, and no second rollover.
    expect(await boundary(harness.agent)).toBeUndefined();
    expect(harness.handoffState.requested).toBe(false);

    // Real work rearms it once.
    recordToolCalls(harness, 2);
    await boundary(harness.agent);
    expect(text(await requestMessages(harness.agent))).toContain(REQUEST_MARKER);
    expect(harness.handoffState.requested).toBe(true);
  });

  it("stops asking after consecutive invalid submissions", async () => {
    const harness = createRun({ kind: "tool-calls", value: 1 });
    seed(harness.agent);
    for (let attempt = 0; attempt < MAX_SUBAGENT_HANDOFF_FAILURES; attempt += 1) {
      recordToolCalls(harness, 1);
      await boundary(harness.agent);
      const rejected = await submit(harness, { handoff: "" });
      expect(rejected.isError).toBe(true);
    }
    expect(harness.handoffState.failures).toBe(MAX_SUBAGENT_HANDOFF_FAILURES);
    recordToolCalls(harness, 1);
    expect(await boundary(harness.agent)).toBeUndefined();
    // Nothing is parked, so nothing is charged to the next request.
    expect(await requestMessages(harness.agent)).toHaveLength(0);
  });

  it("stops asking after consecutive unanswered requests", async () => {
    const harness = createRun({ kind: "tool-calls", value: 1 });
    seed(harness.agent);
    // A delegate that is asked, ignores the request, and keeps working.
    for (let round = 0; round < 20; round += 1) {
      recordToolCalls(harness, 1);
      await boundary(harness.agent);
    }
    expect(harness.handoffState.unanswered).toBe(
      MAX_SUBAGENT_HANDOFF_UNANSWERED,
    );
    // Nothing is parked for the next request any more.
    expect(await requestMessages(harness.agent)).toHaveLength(0);
    // The delegate may still comply with the request it was given: stopping the
    // asks is not the same as refusing a submission already in progress.
    const late = await submit(harness, submittable);
    expect(late.isError).toBeUndefined();
    expect(harness.handoffState.handoffs).toBe(0);
    await boundary(harness.agent);
    expect(harness.handoffState.handoffs).toBe(1);
  });

  it("carries a parked request through a model fallback instead of dropping it", async () => {
    const fallbackProvider: RuntimeProviderConfig = {
      ...provider,
      modelId: "fallback-model",
    };
    const harness = createRun(
      { kind: "tool-calls", value: 1 },
      { fallbackModels: [{ key: "local/fallback-model", provider: fallbackProvider }] },
    );
    seed(harness.agent);
    recordToolCalls(harness, 1);
    await boundary(harness.agent);

    // A provider failure on the asked turn, exactly as `run()` sees it.
    harness.agent.state.messages = [
      ...harness.agent.state.messages,
      {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "local",
        model: "local-model",
        stopReason: "error",
        errorMessage: "502 Bad Gateway",
        usage: {
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 2,
      } as AgentMessage,
    ];
    (harness.run as unknown as { streamError: unknown }).streamError = {
      code: "PROVIDER_ERROR",
      message: "502 Bad Gateway",
    };
    expect((harness.run as unknown as { useNextModel: () => boolean }).useNextModel()).toBe(
      true,
    );

    // The fallback carries the same pending instruction: it was not consumed by
    // the failed attempt, and it was not charged a second time.
    const carried = await requestMessages(harness.agent);
    expect(text(carried)).toContain(REQUEST_MARKER);
    expect(harness.handoffState.unanswered).toBe(1);

    // The loop's continuation rebuilds from `state.messages`; the instruction
    // still reaches the provider because it never lived there.
    const sent: string[] = [];
    harness.agent.streamFunction = () => {
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "continued after fallback" }],
        api: "openai-completions" as const,
        provider: "local",
        model: "fallback-model",
        stopReason: "stop" as const,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 3,
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    };
    const transform = harness.agent.transformContext!;
    harness.agent.transformContext = async (messages) => {
      const next = await transform(messages);
      sent.push(...messageTexts(next));
      return next;
    };
    await harness.agent.continue();
    expect(sent.join("\n")).toContain(REQUEST_MARKER);
    expect(sent.join("\n")).toContain(TASK);
  });
});
