/**
 * Ordering regression: the self-handoff trigger is decided against the request
 * the delegate would send, *before* the context-protection pass rewrites it.
 *
 * Only the protection pass itself is simulated here — one `prepareDelegateTurnContext`
 * seam that returns the compacted context a real compaction would have produced.
 * Both outcomes below would have been impossible with the old order, where the
 * compaction ran first: a threshold at or above the compaction trigger was
 * measured on the already-shrunken context, so the delegate was never asked and
 * the very segment it was supposed to summarize was summarized for it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SubagentDefinition } from "@pi-desktop/shared";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const protection = vi.hoisted(() => ({
  override: undefined as
    | undefined
    | ((input: unknown) => unknown | Promise<unknown>),
  calls: 0,
}));

vi.mock("./subagent-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-context.js")>();
  return {
    ...actual,
    prepareDelegateTurnContext: async (
      input: Parameters<typeof actual.prepareDelegateTurnContext>[0],
    ) => {
      protection.calls += 1;
      const override = protection.override;
      if (override) return override(input);
      return actual.prepareDelegateTurnContext(input);
    },
  };
});

const { SubagentRun } = await import("./subagent.js");

const TASK = "Find where the permission dialog is rendered.";

function providerWith(contextWindow: number, maxTokens: number): RuntimeProviderConfig {
  return {
    id: "local",
    name: "Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "local-model",
    apiKey: "",
    authKind: "none",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    modelConfig: {
      source: "generic",
      name: "Local Catalog Model",
      baseUrl: "http://127.0.0.1:11434/v1",
      reasoning: false,
      thinkingLevelMap: { minimal: null, xhigh: null, max: null },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    },
  };
}

function definition(): SubagentDefinition {
  return {
    name: "explorer",
    description: "Search the workspace and report findings.",
    tools: ["Read"],
    prompt: "Find the answer and report it.",
    source: "builtin",
  };
}

type DelegateAgent = {
  state: { messages: AgentMessage[] };
  transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
  prepareNextTurnWithContext?: (
    turn: unknown,
    signal: AbortSignal,
  ) => Promise<{ context?: { messages: AgentMessage[] } } | undefined>;
};

function createRun(provider: RuntimeProviderConfig) {
  const run = new SubagentRun({
    definition: definition(),
    sessionId: "session-order",
    turnId: "turn-order",
    parentToolCallId: "task-order",
    task: TASK,
    provider,
    thinkingLevel: "off",
    systemPrompt: "You are the explorer subagent.",
    tools: [],
    selfHandoff: { kind: "context-tokens", value: 1_000 },
    onEvent: () => undefined,
  });
  return {
    run,
    agent: (run as unknown as { agent: DelegateAgent }).agent,
  };
}

/** One absorbed segment: the dispatch turn plus a bulky tool result. */
function seedSegment(agent: DelegateAgent, characters: number): void {
  agent.state.messages = [
    { role: "system", content: "You are the explorer subagent.", timestamp: 0 },
    { role: "user", content: TASK, timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "reading the file" }],
      api: "openai-completions",
      provider: "local",
      model: "local-model",
      stopReason: "toolUse",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "Read",
      content: [{ type: "text", text: "x".repeat(characters) }],
      isError: false,
      timestamp: 3,
    } as AgentMessage,
  ];
}

function boundary(agent: DelegateAgent) {
  return agent.prepareNextTurnWithContext!(
    { toolResults: [] },
    new AbortController().signal,
  );
}

async function requestText(agent: DelegateAgent): Promise<string> {
  const messages = await agent.transformContext!([]);
  return messages
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      return typeof content === "string" ? content : JSON.stringify(content ?? "");
    })
    .join("\n");
}

afterEach(() => {
  protection.override = undefined;
  protection.calls = 0;
});

describe("self-handoff boundary ordering", () => {
  it("asks on the pre-compaction request and leaves the segment to the delegate", async () => {
    const { agent } = createRun(providerWith(32_000, 4_000));
    seedSegment(agent, 8_000);
    const before = [...agent.state.messages];
    // A real compaction at this boundary would have replaced the segment with a
    // short summary — the exact reason a post-compaction measurement misses it.
    protection.override = () => ({
      kind: "compacted",
      messages: [{ role: "user", content: "summary", timestamp: 9 }],
      tokensBefore: 2_100,
    });

    await boundary(agent);

    // The threshold crossed before compaction, so the delegate was asked...
    expect(await requestText(agent)).toContain("[Context handoff required]");
    // ...and the lossy pass never ran: the segment is still there to summarize.
    expect(protection.calls).toBe(0);
    expect(agent.state.messages).toEqual(before);
    expect(
      agent.state.messages.some((message) => message.role === "toolResult"),
    ).toBe(true);
  });

  it("still protects the request that no longer fits, and asks anyway", async () => {
    // A 4k window holds this 2.4k-token request? No: the safety boundary is
    // ~2k tokens, so the protection pass is mandatory before the request.
    const { agent } = createRun(providerWith(4_000, 1_000));
    seedSegment(agent, 9_600);
    protection.override = () => ({
      kind: "compacted",
      messages: [{ role: "user", content: "compact summary", timestamp: 9 }],
      tokensBefore: 2_400,
    });

    await boundary(agent);

    // The safety pass ran, and the request for a handoff survives it.
    expect(protection.calls).toBe(1);
    // The safety pass kept the leading system row and installed the stand-in.
    expect(agent.state.messages).toHaveLength(2);
    expect(agent.state.messages[1]).toMatchObject({ role: "user" });
    expect(await requestText(agent)).toContain("[Context handoff required]");
    // The request still describes the occupancy the delegate owned, not the
    // compacted stand-in.
    expect(await requestText(agent)).toContain("of 1000 tokens");
  });
});
