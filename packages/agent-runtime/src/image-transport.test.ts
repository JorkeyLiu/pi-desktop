import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Message, type Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { genericModelConfig, modelConfigWithBinding } from "./model-capabilities.js";
import { buildProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";

/**
 * A binding whose catalog record publishes text input only and whose stored
 * override says `supportsImages: false`. Transport must still carry the user's
 * own picture; the metadata stays metadata.
 */
function textOnlyProvider(): RuntimeProviderConfig {
  const baseUrl = "https://text-only.example/v1";
  const published = genericModelConfig("text-only-fixture", baseUrl);
  return {
    id: "text-only-account",
    name: "Text-only fixture",
    vendorKey: "custom",
    modelId: "text-only-fixture",
    baseUrl,
    apiKey: "unused-fixture",
    authKind: "api_key",
    apiStyle: "chat_completions",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    modelConfig: modelConfigWithBinding(published, {
      contextWindow: published.contextWindow,
      maxTokens: published.maxTokens,
      thinkingLevels: ["off"],
      supportsImages: false,
      supportsDocuments: null,
    }),
  };
}

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=";
const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

type Wire = {
  messages: Array<{ role: string; content?: unknown }>;
};

async function captureRequest(messages: Message[]): Promise<{ model: Model<"openai-completions">; wire: Wire }> {
  const provider = textOnlyProvider();
  const model = buildProviderModel(provider) as Model<"openai-completions">;
  let captured: Wire | undefined;
  const response = stream(model, normalizeContext({ messages }), {
    apiKey: "unused-fixture",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Wire;
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  expect((await response.result()).stopReason).toBe("stop");
  if (!captured) throw new Error("no provider request captured");
  return { model, wire: captured };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
        if (part && typeof part === "object" && "image_url" in part) {
          return String((part as { image_url?: { url?: unknown } }).image_url?.url ?? "");
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function imageParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part): part is { image_url: { url: string } } =>
      Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "image_url")
    .map((part) => part.image_url.url);
}

describe("explicit image transport", () => {
  it("keeps published capability metadata while advertising image input to the adapter", () => {
    const provider = textOnlyProvider();
    const model = buildProviderModel(provider);

    // Metadata remains what the catalog and the binding published.
    expect(provider.modelConfig?.modalities?.input).not.toContain("image");
    expect(provider.modelConfig?.input).not.toContain("image");
    // Transport is a separate answer and always offers images.
    expect(model.input).toContain("image");
  });

  it("sends a user image as image content even for text-only metadata", async () => {
    const user: AgentMessage = {
      role: "user",
      content: [
        { type: "text", text: "What is in this picture?" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ],
      timestamp: 1,
    };

    const { wire } = await captureRequest([user]);
    const userMessage = wire.messages.find((message) => message.role === "user");
    expect(userMessage).toBeDefined();
    expect(imageParts(userMessage?.content)).toEqual([
      `data:image/png;base64,${PNG_BASE64}`,
    ]);
    expect(contentText(userMessage?.content)).not.toContain(USER_IMAGE_PLACEHOLDER);
    expect(contentText(userMessage?.content)).not.toContain("image omitted");
  });

  it("sends a tool-result image as image content instead of an omission note", async () => {
    const assistant: AgentMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "Read",
          arguments: { path: "shot.png" },
        },
      ],
      api: "openai-completions",
      provider: "text-only-account",
      model: "text-only-fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    };
    const toolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Read",
      content: [
        { type: "text", text: "Screenshot saved at shot.png" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 3,
    };

    const { wire } = await captureRequest([assistant, toolResult]);
    const toolMessage = wire.messages.find((message) => message.role === "tool");
    const imageMessage = wire.messages.find((message) => message.role === "user" && imageParts(message.content).length > 0);
    expect(imageParts(imageMessage?.content ?? toolMessage?.content)).toEqual([
      `data:image/png;base64,${PNG_BASE64}`,
    ]);
    const serialized = wire.messages.map((message) => contentText(message.content)).join("\n");
    expect(serialized).not.toContain(TOOL_IMAGE_PLACEHOLDER);
  });
});
