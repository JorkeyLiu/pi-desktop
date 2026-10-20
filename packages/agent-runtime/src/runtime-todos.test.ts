import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolCall } from "@earendil-works/pi-ai";
import { DesktopAgentRuntime } from "./runtime.js";

describe("TodoWrite Agent user path", () => {
  it("passes overlong Unicode content to the authoritative host and returns its truncation warning", async () => {
    const content = "😀".repeat(501);
    const requests: Context[] = [];
    const hostCall = vi.fn(async (method: string) => method === "tools.execute"
      ? { ok: true, content: { content: [{ type: "text", text: "Checklist updated: 0/1 completed [1 item(s) were truncated to 500 characters]" }], details: { revision: 1 } } }
      : undefined);
    const runtime = new DesktopAgentRuntime({
      host: { call: hostCall as never },
      sessionId: "todo-session",
      mode: "agent",
      provider: { id: "local", name: "Local", baseUrl: "http://127.0.0.1:11434/v1", modelId: "local-model", apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      thinkingLevel: "off",
      onEvent: () => undefined,
    });
    let round = 0;
    const streamSimple = (_model: unknown, context: Context) => {
      requests.push({ ...context, messages: [...context.messages] });
      round += 1;
      const toolCall: ToolCall | undefined = round === 1
        ? { type: "toolCall" as const, id: "discover-todos", name: "ToolSearch", arguments: { query: "TodoWrite" } }
        : round === 2
          ? { type: "toolCall" as const, id: "write-todos", name: "TodoWrite", arguments: { todos: [{ content, status: "in_progress" }] } }
          : undefined;
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "local", model: "local-model",
        content: toolCall ? [toolCall] : [{ type: "text", text: "Checklist updated." }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: toolCall ? "toolUse" : "stop", timestamp: round,
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message });
        stream.end(message);
      });
      return stream;
    };
    // Replace only the external provider transport; keep discovery, validation,
    // execution, host forwarding, and tool-result replay on the real runtime.
    (runtime as unknown as { models: { streamSimple: typeof streamSimple } }).models = { streamSimple };
    try {
      await runtime.prompt("Track the implementation steps.", "user-todo", "turn-todo");
      const result = requests.at(-1)?.messages.find((message) => message.role === "toolResult" && message.toolCallId === "write-todos");
      expect(result).toMatchObject({ isError: false, content: [{ type: "text", text: expect.stringContaining("truncated to 500 characters") }] });
      expect(hostCall).toHaveBeenCalledWith("tools.execute", expect.objectContaining({
        sessionId: "todo-session", turnId: "turn-todo", toolName: "TodoWrite",
        args: { todos: [{ content, status: "in_progress" }] },
      }));
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps the committed checklist the host returned on the row that wrote it", async () => {
    // The card a reader sees is built from the `tool_end` result, so the list
    // the host committed — normalized, not the argument that was sent — has to
    // survive the runtime's own result mapping intact.
    const committed = [
      { content: "x".repeat(500), status: "in_progress", priority: "high" },
      { content: "Second active item", status: "pending", priority: "medium" },
    ];
    const content = {
      text: "Checklist updated: 0/2 completed; current: xxx",
      revision: 7,
      summary: { completed: 0, total: 2, inProgress: 1, cancelled: 0 },
      warnings: ["1 item(s) were truncated to 500 characters"],
      todos: committed,
    };
    const hostCall = vi.fn(async (method: string) => method === "tools.execute"
      ? { ok: true, content }
      : undefined);
    const events: Array<Record<string, unknown>> = [];
    const runtime = new DesktopAgentRuntime({
      host: { call: hostCall as never },
      sessionId: "todo-session",
      mode: "agent",
      provider: { id: "local", name: "Local", baseUrl: "http://127.0.0.1:11434/v1", modelId: "local-model", apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      thinkingLevel: "off",
      onEvent: ({ event }) => {
        if (event.type === "tool_end") events.push(event as unknown as Record<string, unknown>);
      },
    });
    let round = 0;
    const streamSimple = () => {
      round += 1;
      // TodoWrite reaches the model through ToolSearch, so the same two-round
      // discovery the production path performs comes first.
      const toolCall: ToolCall | undefined = round === 1
        ? { type: "toolCall" as const, id: "discover-todos", name: "ToolSearch", arguments: { query: "TodoWrite" } }
        : round === 2
          ? { type: "toolCall" as const, id: "write-todos", name: "TodoWrite", arguments: { todos: [{ content: "raw", status: "in_progress" }] } }
          : undefined;
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "local", model: "local-model",
        content: toolCall ? [toolCall] : [{ type: "text", text: "Checklist updated." }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: toolCall ? "toolUse" : "stop", timestamp: round,
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message });
        stream.end(message);
      });
      return stream;
    };
    (runtime as unknown as { models: { streamSimple: typeof streamSimple } }).models = { streamSimple };
    try {
      await runtime.prompt("Track the implementation steps.", "user-todo-2", "turn-todo-2");
      const write = events.find((event) => event.toolCallId === "write-todos");
      expect(write).toBeDefined();
      expect((write!.result as { details?: unknown }).details).toMatchObject({ todos: committed });
    } finally {
      await runtime.dispose();
    }
  });
});
