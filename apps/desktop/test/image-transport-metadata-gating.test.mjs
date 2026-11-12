import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import {
  assembleTurnPrompt,
  preparePromptAttachments,
} from "../electron/main/prompt-attachments.ts";

/**
 * The user-path regression for image transport: Electron main prepares the
 * attachment, the runtime builds the provider model from text-only catalog
 * metadata (and a stored `supportsImages: false` override), and pi-ai's
 * OpenAI-compatible adapter serializes the actual request body. The image must
 * appear in that body; capability metadata must not replace it with a path or
 * an omission note.
 *
 * The sibling package is imported from its built artifacts for the same reason
 * the product composes these at runtime; run `pnpm build:js` before this file.
 */
const runtime = await import(
  new URL("../../../packages/agent-runtime/dist/provider-binding.js", import.meta.url)
);
const capabilities = await import(
  new URL("../../../packages/agent-runtime/dist/model-capabilities.js", import.meta.url)
);
const historyModule = await import(
  new URL("../../../packages/agent-runtime/dist/attachment-history.js", import.meta.url)
);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=",
  "base64",
);
const MAX_INLINE_IMAGE_BYTES = 10_000_000;
const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const sessionId = "image-transport-metadata";

const baseUrl = "https://text-only.example/v1";

/** A provider row whose catalog and stored override both say text-only. */
function textOnlyProvider() {
  const published = capabilities.genericModelConfig("text-only-fixture", baseUrl);
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
    modelConfig: capabilities.modelConfigWithBinding(published, {
      supportsImages: false,
      supportsDocuments: null,
      thinkingLevels: ["off"],
      defaultThinkingLevel: "off",
    }),
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-image-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const scratch = join(data, "scratch", sessionId);
  await mkdir(scratch, { recursive: true });
  return { root, data, scratch };
}

function imageParts(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === "image_url")
    .map((part) => part.image_url?.url);
}

function serializedText(payload) {
  return payload.messages
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.map((part) =>
              typeof part?.text === "string"
                ? part.text
                : part?.type === "image_url"
                  ? String(part.image_url?.url ?? "")
                  : "")
          : [],
    )
    .join("\n");
}

async function captureRequest(provider, messages) {
  const model = runtime.buildProviderModel(provider);
  let captured;
  const response = stream(model, normalizeContext({ messages }), {
    apiKey: "unused-fixture",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  assert.equal((await response.result()).stopReason, "stop");
  assert.ok(captured, "provider request body captured");
  return captured;
}

test("published metadata stays text-only while the transport carries image input", () => {
  const provider = textOnlyProvider();
  const model = runtime.buildProviderModel(provider);
  assert.equal(provider.modelConfig.modalities.input.includes("image"), false);
  assert.equal(provider.modelConfig.input.includes("image"), false);
  assert.equal(model.input.includes("image"), true);
});

test("an explicit user image prepared by main reaches the provider request body", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "pasted-a.png");
  await writeFile(path, PNG);
  const attachment = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };

  const prepared = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    "describe this",
  );
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].message.kind, "image");
  assert.equal(prepared[0].message.mimeType, "image/png");
  assert.deepEqual(Buffer.from(prepared[0].inlineData, "base64"), PNG);

  const payload = await captureRequest(textOnlyProvider(), [
    {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", data: prepared[0].inlineData, mimeType: prepared[0].message.mimeType },
      ],
      timestamp: 1,
    },
  ]);
  const user = payload.messages.find((message) => message.role === "user");
  assert.deepEqual(imageParts(user?.content), [
    `data:image/png;base64,${prepared[0].inlineData}`,
  ]);
  const text = serializedText(payload);
  assert.equal(text.includes(USER_IMAGE_PLACEHOLDER), false);
  assert.equal(text.includes(path), false, "no @path fallback was sent instead of the picture");
});

test("unknown and custom model metadata still carries the user's image", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "custom-model.png");
  await writeFile(path, PNG);
  const prepared = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [{ path, name: "custom-model.png", kind: "image", mimeType: "image/png" }],
    "",
  );
  const payload = await captureRequest(
    {
      // No catalog record at all: the runtime falls back to the generic shape.
      id: "custom-account",
      name: "Custom endpoint",
      vendorKey: "custom",
      modelId: "my-private-model",
      baseUrl,
      apiKey: "unused-fixture",
      authKind: "api_key",
      apiStyle: "chat_completions",
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    },
    [
      {
        role: "user",
        content: [{ type: "image", data: prepared[0].inlineData, mimeType: "image/png" }],
        timestamp: 1,
      },
    ],
  );
  const user = payload.messages.find((message) => message.role === "user");
  assert.deepEqual(imageParts(user?.content), [
    `data:image/png;base64,${prepared[0].inlineData}`,
  ]);
});

test("a tool-result image is transported under the same policy", async () => {
  const payload = await captureRequest(textOnlyProvider(), [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "shot.png" } },
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
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Read",
      content: [
        { type: "text", text: "Screenshot saved at shot.png" },
        { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 3,
    },
  ]);
  const imageUrls = payload.messages.flatMap((message) => imageParts(message.content));
  assert.deepEqual(imageUrls, [`data:image/png;base64,${PNG.toString("base64")}`]);
  assert.equal(serializedText(payload).includes(TOOL_IMAGE_PLACEHOLDER), false);
});

test("restored user image history reaches the request even for text-only metadata", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "history.png");
  await writeFile(path, PNG);
  const history = [
    {
      id: "history-user",
      role: "user",
      content: "what was this?",
      createdAt: "2026-01-01T00:00:00.000Z",
      attachments: [{ kind: "image", name: "history.png", ref: path, mimeType: "image/png" }],
    },
  ];
  const hydrated = await historyModule.hydrateAttachmentHistory(history, { scratchDir: scratch });
  const inline = hydrated[0].attachments[0].data;
  assert.equal(inline, PNG.toString("base64"));

  const payload = await captureRequest(textOnlyProvider(), [
    {
      role: "user",
      content: [
        { type: "text", text: hydrated[0].content },
        { type: "image", data: inline, mimeType: "image/png" },
      ],
      timestamp: 1,
    },
  ]);
  const user = payload.messages.find((message) => message.role === "user");
  assert.deepEqual(imageParts(user?.content), [`data:image/png;base64,${PNG.toString("base64")}`]);
  assert.equal(serializedText(payload).includes(USER_IMAGE_PLACEHOLDER), false);
});

test("the same turn prompt assembly never swaps an explicit image for a path", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "inline.png");
  await writeFile(path, PNG);
  const turn = await assembleTurnPrompt({
    dataRoot: data,
    sessionId,
    projectPath: undefined,
    promptContent: `compare @${path} with this`,
    attachments: [{ path, name: "inline.png", kind: "image", mimeType: "image/png" }],
  });
  assert.ok(turn.preparedAttachments[0].inlineData);
  assert.equal(turn.modelContent, `compare @${path} with this`);
});

test("an oversized explicit current-turn image fails visibly instead of becoming @path", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "oversized.png");
  await writeFile(path, PNG);
  await truncate(path, MAX_INLINE_IMAGE_BYTES + 1);
  await assert.rejects(
    preparePromptAttachments(
      data,
      sessionId,
      undefined,
      [{ path, name: "oversized.png", kind: "image", mimeType: "image/png" }],
      "",
    ),
    (error) => {
      assert.equal(error.errorCode, "PAYLOAD_TOO_LARGE");
      assert.match(error.message, /limited to 10000000 bytes/);
      return true;
    },
  );
});

test("an unreadable image file fails visibly instead of becoming @path", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "not-an-image.png");
  await writeFile(path, "this is not a picture");
  await assert.rejects(
    preparePromptAttachments(
      data,
      sessionId,
      undefined,
      [{ path, name: "not-an-image.png", kind: "image", mimeType: "image/png" }],
      "",
    ),
    (error) => {
      assert.equal(error.errorCode, "UNSUPPORTED");
      assert.match(error.message, /not a readable image/);
      return true;
    },
  );
});
