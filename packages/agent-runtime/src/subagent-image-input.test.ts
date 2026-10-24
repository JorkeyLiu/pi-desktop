/**
 * Subagent image inputs reach the child provider.
 *
 * The user's acceptance for this surface is that a picture the user attached
 * to a delegate is sent to the child endpoint even when the gateway's model
 * metadata says the model is text-only. The metadata is not trusted (a gateway
 * commonly reports `input: ["text"]` for a vision-capable upstream), so these
 * tests pin both halves: the resumed chain hydrates the persisted image, and a
 * real provider adapter receives it in the request body.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UiMessage } from "@pi-desktop/shared";
import { SubagentRun } from "./subagent.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { seedResumedDelegate } from "./subagent-resume.js";
import type { DelegationChain } from "./delegation-history.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

/** A real 1x1 PNG: the persisted bytes must decode as the image they claim. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=",
  "base64",
);
const PNG_BASE64 = PNG.toString("base64");

/**
 * A provider whose catalog metadata declares text-only input, the way a
 * gateway with unreliable metadata reports a vision model.
 */
function textOnlyProvider(): RuntimeProviderConfig {
  return {
    id: "gateway",
    name: "Gateway",
    modelId: "gateway-text-model",
    baseUrl: "https://gateway.invalid/v1",
    apiKey: "fixture-only",
    apiStyle: "chat_completions",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    modelConfig: {
      source: "generic",
      name: "Gateway Text Model",
      baseUrl: "https://gateway.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  };
}

function chain(overrides: Partial<DelegationChain> = {}): DelegationChain {
  return {
    delegateSessionId: "chain-1",
    toolCallIds: ["task-1"],
    delegationIds: ["del-1"],
    agentName: "explorer",
    readFiles: [],
    readLineCount: 0,
    latestDelegationId: "del-1",
    latestObjective: "look at the screenshot",
    latestModelId: "gateway-text-model",
    lastActivityAt: 1_700_000_000_000,
    ...overrides,
  };
}

function imageRow(id: string, ref: string, content = ""): UiMessage {
  return {
    id,
    role: "user",
    content,
    status: "complete",
    createdAt: new Date(1_700_000_000_000).toISOString(),
    parentToolCallId: "task-1",
    agentName: "explorer",
    attachments: [
      {
        kind: "image",
        name: "screenshot.png",
        ref,
        mimeType: "image/png",
        size: PNG.length,
      },
    ],
  };
}

function assistantRow(id: string): UiMessage {
  return {
    id,
    role: "assistant",
    content: "I can see the screenshot.",
    status: "complete",
    createdAt: new Date(1_700_000_001_000).toISOString(),
    parentToolCallId: "task-1",
    agentName: "explorer",
  };
}

const tempRoots: string[] = [];

async function dataRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-image-"));
  tempRoots.push(root);
  const attachments = join(root, "attachments");
  await mkdir(attachments, { recursive: true });
  await writeFile(join(attachments, "sha-fixture"), PNG);
  return attachments;
}

/** Every user image block in a seeded conversation, as `{data, mimeType}`. */
function imageBlocks(messages: readonly AgentMessage[]) {
  const blocks: Array<{ data: string; mimeType: string }> = [];
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "image") {
        blocks.push({ data: block.data, mimeType: block.mimeType });
      }
    }
  }
  return blocks;
}

const chatStream = () => {
  const chunk = (value: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "gateway-text-model",
      choices: [{ index: 0, delta: value, finish_reason: finish }],
    })}\n\n`;
  return new Response(
    chunk({ role: "assistant", content: "seen" }, null) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
};

const explorerDefinition = {
  name: "explorer",
  description: "Inspect",
  prompt: "Inspect",
  source: "builtin" as const,
  tools: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("resumed delegate image history", () => {
  it("seeds an image-only chain from its persisted image instead of failing", async () => {
    const attachmentsDir = await dataRoot();
    const messages = await seedResumedDelegate(
      [imageRow("child-img", "attachments/sha-fixture"), assistantRow("child-a")],
      chain(),
      textOnlyProvider(),
      { attachmentsDir },
    );
    // The chain has no text brief: the image is the brief. A resumed run must
    // still start from it rather than reporting "no recorded history".
    expect(messages).toBeDefined();
    expect(imageBlocks(messages!)).toEqual([
      { data: PNG_BASE64, mimeType: "image/png" },
    ]);
    // No fabricated empty text turn ahead of the image.
    const first = messages![0] as { role: string; content: unknown };
    expect(first.role).toBe("user");
    expect(Array.isArray(first.content)).toBe(true);
    expect(
      (first.content as Array<{ type: string; text?: string }>).some(
        (block) => block.type === "text" && !(block.text ?? "").trim(),
      ),
    ).toBe(false);
  });

  it("keeps a text brief and the image, in the order they were recorded", async () => {
    const attachmentsDir = await dataRoot();
    const messages = await seedResumedDelegate(
      [
        imageRow("child-img", "attachments/sha-fixture", "what is this?"),
        assistantRow("child-a"),
      ],
      chain({ originalTask: "look at the screenshot" }),
      textOnlyProvider(),
      { attachmentsDir },
    );
    expect(messages).toBeDefined();
    expect(messages!.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(imageBlocks(messages!)).toHaveLength(1);
    expect(imageBlocks(messages!)[0]?.data).toBe(PNG_BASE64);
  });

  it("does not inline a ref that resolves outside the session roots", async () => {
    const attachmentsDir = await dataRoot();
    const messages = await seedResumedDelegate(
      [
        imageRow("child-img", "../../etc/passwd", "see this"),
        assistantRow("child-a"),
      ],
      chain({ originalTask: "look at the screenshot" }),
      textOnlyProvider(),
      { attachmentsDir },
    );
    expect(messages).toBeDefined();
    expect(imageBlocks(messages!)).toEqual([]);
    // The user's words still replay; only the bytes outside the roots do not.
    expect(JSON.stringify(messages)).toContain("see this");
    expect(JSON.stringify(messages)).not.toContain("../../etc/passwd");
  });
});

describe("subagent image inputs reach the provider body", () => {
  it("sends a resumed image to a model whose metadata declares text only", async () => {
    const attachmentsDir = await dataRoot();
    const provider = textOnlyProvider();
    const seeded = await seedResumedDelegate(
      [imageRow("child-img", "attachments/sha-fixture"), assistantRow("child-a")],
      chain(),
      provider,
      { attachmentsDir },
    );
    expect(seeded).toBeDefined();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return chatStream();
      }),
    );
    const run = new SubagentRun({
      definition: explorerDefinition,
      sessionId: "fixture-session",
      parentToolCallId: "task-2",
      task: "",
      provider,
      thinkingLevel: "off",
      systemPrompt: "Inspect",
      tools: [],
      onEvent: () => {},
      initialMessages: seeded!,
    });
    const result = await run.run();
    expect(result.status).toBe("completed");
    // The image is what the request carried: no metadata gate dropped it.
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0])).toContain(
      `data:image/png;base64,${PNG_BASE64}`,
    );
  });

  it("opens a continued run with the image the user just attached", async () => {
    await dataRoot();
    const provider = textOnlyProvider();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return chatStream();
      }),
    );
    const run = new SubagentRun({
      definition: explorerDefinition,
      sessionId: "fixture-session",
      parentToolCallId: "task-3",
      // An image-only continuation: no text, one picture.
      task: "",
      provider,
      thinkingLevel: "off",
      systemPrompt: "Inspect",
      tools: [],
      onEvent: () => {},
      initialImages: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
    });
    const result = await run.run();
    expect(result.status).toBe("completed");
    expect(bodies).toHaveLength(1);
    const body = JSON.stringify(bodies[0]);
    expect(body).toContain(`data:image/png;base64,${PNG_BASE64}`);
    // The image is user input, not an empty text turn.
    expect(body).not.toContain('"content":[{"type":"text","text":""}]');
  });
});
