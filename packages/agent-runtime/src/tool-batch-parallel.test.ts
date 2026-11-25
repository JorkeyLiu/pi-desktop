import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  AgentEventEnvelope,
  CommandShellOption,
  SubagentDefinition,
} from "@pi-desktop/shared";
import {
  DesktopAgentRuntime,
  type RuntimeProviderConfig,
} from "./runtime.js";

type ChatMessage = {
  role: string;
  content: unknown;
  tool_call_id?: string;
};
type ChatRequest = { model: string; messages: ChatMessage[] };
type ToolCallFixture = { id: string; name: string; arguments: unknown };
type HostResult = {
  ok: boolean;
  content: unknown;
  isError?: boolean;
  errorCode?: string;
};

function deferred<T = void>() {
  let resolve!: (value: T | void) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value: T | void) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text: unknown }).text)
        : "",
    )
    .join("\n");
}

function isChildRequest(body: ChatRequest): boolean {
  return body.messages.some(
    (message) =>
      message.role === "system" &&
      contentText(message.content).includes('You are the "worker" subagent'),
  );
}

function sseText(res: ServerResponse, model: string, text: string): void {
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

function sseToolCalls(
  res: ServerResponse,
  model: string,
  calls: ToolCallFixture[],
): void {
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        },
        finish_reason: null,
      }],
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function fixture(
  respond: (body: ChatRequest, res: ServerResponse) => void,
): Promise<{ port: number }> {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    respond(JSON.parse(raw) as ChatRequest, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  return { port: address.port };
}

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

const worker: SubagentDefinition = {
  name: "worker",
  description: "Do the work and report back.",
  tools: ["Read"],
  prompt: "Do the work and report back.",
  source: "builtin",
};

function providerFor(port: number): RuntimeProviderConfig {
  return {
    id: "fixture",
    name: "Fixture",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    modelId: "fixture-model",
    apiKey: "fixture-key",
    authKind: "api_key_and_base_url",
    apiStyle: "openai-chat",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
  } as unknown as RuntimeProviderConfig;
}

function registeredTool(runtime: DesktopAgentRuntime, name: string): AgentTool {
  const found = (runtime as unknown as { agent: { state: { tools: AgentTool[] } } })
    .agent.state.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`tool ${name} is not registered`);
  return found;
}

function hostHarness() {
  const started: string[] = [];
  const aborted: string[] = [];
  const starts = new Map<string, ReturnType<typeof deferred>>();
  const pending = new Map<string, ReturnType<typeof deferred<HostResult>>>();
  const call = vi.fn(async (method: string, rawParams: unknown): Promise<unknown> => {
    const params = (rawParams ?? {}) as {
      toolCallId?: string;
      toolName?: string;
    };
    if (method === "tools.execute") {
      const id = params.toolCallId ?? "";
      started.push(id);
      if (!starts.has(id)) starts.set(id, deferred());
      starts.get(id)!.resolve(undefined);
      const execution = deferred<HostResult>();
      pending.set(id, execution);
      return execution.promise;
    }
    if (method === "tools.abort") {
      const id = params.toolCallId ?? "";
      aborted.push(id);
      pending.get(id)?.resolve({
        ok: false,
        content: "aborted",
        isError: true,
        errorCode: "TOOL_ABORTED",
      });
      return { ok: true, content: "abort requested" };
    }
    if (method === "project.instructions.resolve") return undefined;
    if (method === "session.appendMessage") return {};
    return { ok: true, content: "" };
  });
  return {
    host: { call, onNotification: vi.fn(() => () => {}) },
    started,
    aborted,
    pending,
    startedSignal(id: string) {
      if (!starts.has(id)) starts.set(id, deferred());
      return starts.get(id)!;
    },
    release(id: string, content: string) {
      const execution = pending.get(id);
      if (!execution) throw new Error(`execution ${id} was not started`);
      execution.resolve({ ok: true, content });
    },
    releaseAll(content = "released") {
      for (const execution of pending.values()) {
        execution.resolve({ ok: true, content });
      }
    },
  };
}

function runtimeFor(
  port: number,
  host: ReturnType<typeof hostHarness>["host"],
  onEvent: (envelope: AgentEventEnvelope) => void,
  subagents: SubagentDefinition[] = [],
): DesktopAgentRuntime {
  return new DesktopAgentRuntime({
    host: host as never,
    sessionId: "session-parallel",
    mode: "agent",
    turnId: "turn-parallel",
    provider: providerFor(port),
    commandShell,
    thinkingLevel: "off",
    subagents,
    onEvent,
  });
}

function toolResults(request: ChatRequest | undefined): ChatMessage[] {
  return (request?.messages ?? []).filter((message) => message.role === "tool");
}

describe("same-turn tool batch execution", () => {
  it("starts parent Bash calls and Read together and keeps result identity in source order", async () => {
    const requests: ChatRequest[] = [];
    const { port } = await fixture((body, res) => {
      requests.push(body);
      if (requests.length === 1) {
        sseToolCalls(res, body.model, [
          { id: "bash-long", name: "Bash", arguments: { command: "echo long" } },
          { id: "read-fast", name: "Read", arguments: { path: "a.txt" } },
          { id: "bash-second", name: "Bash", arguments: { command: "echo second" } },
        ]);
      } else {
        sseText(res, body.model, "done");
      }
    });
    const harness = hostHarness();
    const completed: string[] = [];
    const readEnded = deferred();
    const runtime = runtimeFor(port, harness.host, (envelope) => {
      if (envelope.event.type === "tool_end") {
        completed.push(envelope.event.toolCallId);
        if (envelope.event.toolCallId === "read-fast") readEnded.resolve();
      }
    });
    const running = runtime.prompt("Run all three calls.", "user-1", "turn-parallel");
    try {
      await harness.startedSignal("bash-long").promise;
      await harness.startedSignal("read-fast").promise;
      await harness.startedSignal("bash-second").promise;
      expect(harness.started).toHaveLength(3);
      expect(harness.started).toEqual(expect.arrayContaining(["bash-long", "read-fast", "bash-second"]));
      expect(completed).toEqual([]);

      harness.release("read-fast", "read-output");
      await readEnded.promise;
      expect(completed).toEqual(["read-fast"]);
      harness.release("bash-second", "second-bash-output");
      harness.release("bash-long", "bash-output");
      await running;

      expect(completed).toHaveLength(3);
      expect(completed[0]).toBe("read-fast");
      expect(completed.slice(1).sort()).toEqual(["bash-long", "bash-second"]);
      const results = toolResults(requests[1]);
      expect(results.map((message) => message.tool_call_id)).toEqual([
        "bash-long",
        "read-fast",
        "bash-second",
      ]);
      expect(contentText(results[0]?.content)).toContain("bash-output");
      expect(contentText(results[1]?.content)).toContain("read-output");
      expect(contentText(results[2]?.content)).toContain("second-bash-output");
    } finally {
      harness.releaseAll();
      await runtime.abort();
      await runtime.dispose();
    }
  });

  it("runs a real scoped child batch in parallel and preserves its result order", async () => {
    const requests: ChatRequest[] = [];
    const { port } = await fixture((body, res) => {
      requests.push(body);
      if (requests.length === 1) {
        sseToolCalls(res, body.model, [
          { id: "child-read", name: "Read", arguments: { path: "a.txt" } },
          { id: "child-glob", name: "Glob", arguments: { pattern: "*.ts" } },
        ]);
      } else {
        sseText(res, body.model, "child report");
      }
    });
    const harness = hostHarness();
    const globEnded = deferred();
    const runtime = runtimeFor(port, harness.host, (envelope) => {
      if (envelope.event.type === "tool_end" && envelope.event.toolCallId === "child-glob") {
        globEnded.resolve();
      }
    }, [{ ...worker, tools: ["Read", "Glob"] }]);
    try {
      const started = await registeredTool(runtime, "Task").execute("task-child", {
        agent: "worker",
        task: "Inspect the fixture.",
      });
      const delegationId = String(started.details?.delegationId ?? "");
      expect(delegationId).toBeTruthy();
      const record = (runtime as unknown as {
        delegations: Map<string, { completion: Promise<void>; status: string }>;
      }).delegations.get(delegationId);
      if (!record) throw new Error("missing delegation record");

      await harness.startedSignal("child-read").promise;
      await harness.startedSignal("child-glob").promise;
      expect(harness.started).toEqual(expect.arrayContaining(["child-read", "child-glob"]));
      harness.release("child-glob", "glob-output");
      await globEnded.promise;
      harness.release("child-read", "read-output");
      await record.completion;

      expect(record.status).toBe("completed");
      const results = toolResults(requests[1]);
      expect(results.map((message) => message.tool_call_id)).toEqual([
        "child-read",
        "child-glob",
      ]);
      expect(contentText(results[0]?.content)).toContain("read-output");
      expect(contentText(results[1]?.content)).toContain("glob-output");
    } finally {
      harness.releaseAll();
      await runtime.dispose();
    }
  });

  it("keeps same-path child writes serialized while different paths overlap", async () => {
    const requests: ChatRequest[] = [];
    const { port } = await fixture((body, res) => {
      requests.push(body);
      if (requests.length === 1) {
        sseToolCalls(res, body.model, [
          { id: "same-a", name: "Write", arguments: { path: "same.txt", content: "a" } },
          { id: "same-b", name: "Write", arguments: { path: "./same.txt", content: "b" } },
          { id: "other", name: "Write", arguments: { path: "other.txt", content: "c" } },
        ]);
      } else {
        sseText(res, body.model, "writes complete");
      }
    });
    const harness = hostHarness();
    const otherEnded = deferred();
    const runtime = runtimeFor(port, harness.host, (envelope) => {
      if (envelope.event.type === "tool_end" && envelope.event.toolCallId === "other") {
        otherEnded.resolve();
      }
    }, [{ ...worker, tools: ["Write"] }]);
    try {
      const started = await registeredTool(runtime, "Task").execute("task-writes", {
        agent: "worker",
        task: "Write the three files.",
      });
      const delegationId = String(started.details?.delegationId ?? "");
      const record = (runtime as unknown as {
        delegations: Map<string, { completion: Promise<void> }>;
      }).delegations.get(delegationId);
      if (!record) throw new Error("missing delegation record");

      await harness.startedSignal("same-a").promise;
      await harness.startedSignal("other").promise;
      expect(harness.started).toEqual(["same-a", "other"]);
      harness.release("other", "other-written");
      await otherEnded.promise;
      expect(harness.started).not.toContain("same-b");

      harness.release("same-a", "same-written-a");
      await harness.startedSignal("same-b").promise;
      harness.release("same-b", "same-written-b");
      await record.completion;

      expect(toolResults(requests[1]).map((message) => message.tool_call_id)).toEqual([
        "same-a",
        "same-b",
        "other",
      ]);
    } finally {
      harness.releaseAll();
      await runtime.dispose();
    }
  });

  it("does not serialize ordinary calls around a real Task delegation", async () => {
    const requests: ChatRequest[] = [];
    let parentRequests = 0;
    const { port } = await fixture((body, res) => {
      requests.push(body);
      if (isChildRequest(body)) {
        sseText(res, body.model, "child report");
        return;
      }
      parentRequests += 1;
      if (parentRequests === 1) {
        sseToolCalls(res, body.model, [
          { id: "mixed-read", name: "Read", arguments: { path: "a.txt" } },
          { id: "mixed-task", name: "Task", arguments: { agent: "worker", task: "Inspect." } },
          { id: "mixed-bash", name: "Bash", arguments: { command: "echo mixed" } },
        ]);
      } else {
        sseText(res, body.model, "parent done");
      }
    });
    const harness = hostHarness();
    const runtime = runtimeFor(port, harness.host, vi.fn(), [worker]);
    const running = runtime.prompt("Do all three.", "user-1", "turn-parallel");
    try {
      await harness.startedSignal("mixed-read").promise;
      await harness.startedSignal("mixed-bash").promise;
      expect(harness.started).toEqual(expect.arrayContaining(["mixed-read", "mixed-bash"]));
      expect((runtime as unknown as { delegations: Map<string, unknown> }).delegations.size).toBe(1);

      harness.release("mixed-read", "mixed-read-output");
      harness.release("mixed-bash", "mixed-bash-output");
      await running;
      await Promise.all(
        [...(runtime as unknown as {
          delegations: Map<string, { completion: Promise<void> }>;
        }).delegations.values()].map((record) => record.completion),
      );

      const parent = requests.filter((request) => !isChildRequest(request));
      expect(parent.length).toBeGreaterThanOrEqual(2);
      expect(toolResults(parent[1]).map((message) => message.tool_call_id)).toEqual([
        "mixed-read",
        "mixed-task",
        "mixed-bash",
      ]);
    } finally {
      harness.releaseAll();
      await runtime.abort();
      await runtime.dispose();
    }
  });

  it("aborts every in-flight sibling once and emits no late or duplicate results", async () => {
    const requests: ChatRequest[] = [];
    const { port } = await fixture((body, res) => {
      requests.push(body);
      if (requests.length === 1) {
        sseToolCalls(res, body.model, [
          { id: "cancel-a", name: "Read", arguments: { path: "a.txt" } },
          { id: "cancel-b", name: "Read", arguments: { path: "b.txt" } },
        ]);
      } else {
        sseText(res, body.model, "unexpected continuation");
      }
    });
    const harness = hostHarness();
    const ended: string[] = [];
    const runtime = runtimeFor(port, harness.host, (envelope) => {
      if (envelope.event.type === "tool_end") ended.push(envelope.event.toolCallId);
    });
    const running = runtime.prompt("Start both reads.", "user-1", "turn-parallel");
    try {
      await harness.startedSignal("cancel-a").promise;
      await harness.startedSignal("cancel-b").promise;
      expect(harness.started).toEqual(["cancel-a", "cancel-b"]);

      await runtime.abort();
      await running;
      expect(harness.aborted).toEqual(["cancel-a", "cancel-b"]);
      expect(requests).toHaveLength(1);
      expect([...ended].sort()).toEqual(["cancel-a", "cancel-b"]);

      const agent = (runtime as unknown as {
        agent: { state: { messages: Array<{ role: string; toolCallId?: string }> } };
      }).agent;
      const resultIds = agent.state.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.toolCallId);
      expect(resultIds).toEqual(["cancel-a", "cancel-b"]);
      harness.releaseAll("late success");
      await nextTurn();
      expect(ended).toHaveLength(2);
      expect(requests).toHaveLength(1);
    } finally {
      harness.releaseAll();
      await runtime.dispose();
    }
  });

  it("still rejects a mode transition mixed with an ordinary call before execution", async () => {
    const requests: ChatRequest[] = [];
    const { port } = await fixture((body, res) => {
      requests.push(body);
      if (requests.length === 1) {
        sseToolCalls(res, body.model, [
          { id: "enter", name: "EnterPlanMode", arguments: {} },
          { id: "read", name: "Read", arguments: { path: "a.txt" } },
        ]);
      } else {
        sseText(res, body.model, "blocked");
      }
    });
    const harness = hostHarness();
    const runtime = runtimeFor(port, harness.host, vi.fn());
    try {
      await runtime.prompt("Try the mixed transition.", "user-1", "turn-parallel");
      expect(requests).toHaveLength(2);
      expect(harness.host.call.mock.calls.some(([method]) => method === "tools.execute")).toBe(false);
      expect(harness.host.call.mock.calls.some(([method]) => method === "plans.enter")).toBe(false);
      expect(runtime.getMode()).toBe("agent");
      const agent = (runtime as unknown as {
        agent: { state: { messages: Array<{ role: string; toolCallId?: string; isError?: boolean }> } };
      }).agent;
      const results = agent.state.messages.filter((message) => message.role === "toolResult");
      expect(results.map((message) => message.toolCallId)).toEqual(["enter", "read"]);
      expect(results.every((message) => message.isError)).toBe(true);
    } finally {
      harness.releaseAll();
      await runtime.dispose();
    }
  });
});
