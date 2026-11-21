import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./runtime.js";
import type {
  CommandShellOption,
  SubagentDefinition,
} from "@pi-desktop/shared";

/**
 * TaskSteer through the real child loop.
 *
 * Everything below the external provider boundary is production code: the
 * real `DesktopAgentRuntime`, a real `SubagentRun` with the real pi agent
 * loop, real tool execution, and the real delivery coordinator. Only the
 * provider transport is scripted — a localhost OpenAI-chat fixture — and
 * only the delegate's `Read` tool is gated, so the test can steer mid-call
 * at an explicit sync point instead of racing settlement.
 *
 * Round 1 answers with a `Read` call whose execute blocks on a barrier.
 * While it is blocked, the parent model calls `TaskSteer`; the receipt must
 * say `queued` for the next turn with `source: "model"`, and the blocked
 * tool must not abort. Releasing the barrier lets the child finish the
 * tool, and the very next assistant request must already carry the steered
 * message — with the same delegation id, no follow-up run, and `TaskWait`
 * delivering the original run's report.
 */

type ChatMessage = { role: string; content: unknown; tool_calls?: unknown };

function sseText(res: import("node:http").ServerResponse, model: string, text: string) {
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

function sseToolCall(
  res: import("node:http").ServerResponse,
  model: string,
  name: string,
  args: unknown,
) {
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
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

const STEER_TEXT = "Also check the docs for the permission dialog.";

async function fixture() {
  const requests: Array<{ model: string; messages: ChatMessage[] }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { model: string; messages: ChatMessage[] };
    requests.push(body);
    if (requests.length === 1) {
      sseToolCall(res, body.model, "Read", { path: "target.txt" });
    } else {
      sseText(res, body.model, "Checked the docs too. Done.");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  return { requests, port: (address as { port: number }).port };
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
  const found = (runtime as any).agent.state.tools.find(
    (entry: any) => entry.name === name,
  );
  if (!found) throw new Error(`tool ${name} is not registered`);
  return found;
}

describe("TaskSteer loop integration", () => {
  it(
    "queues mid-tool without aborting, surfaces at the next boundary, and TaskWait delivers the same run",
    async () => {
      const { requests, port } = await fixture();
      const runtime = new DesktopAgentRuntime({
        host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
        sessionId: "session-loop",
        mode: "agent",
        turnId: "parent-turn",
        provider: providerFor(port),
        commandShell,
        thinkingLevel: "off",
        subagents: [worker],
        onEvent: vi.fn(),
      });
      try {
        // Gate the delegate's Read: it reports entry, then waits for release.
        let enteredResolve!: () => void;
        const entered = new Promise<void>((resolve) => {
          enteredResolve = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const catalog: Map<string, AgentTool> = (runtime as any).toolCatalog;
        const read = catalog.get("Read");
        if (!read) throw new Error("Read is not in the tool catalog");
        const toolCalls: string[] = [];
        catalog.set("Read", {
          ...read,
          execute: (async (toolCallId: string) => {
            toolCalls.push(toolCallId);
            enteredResolve();
            await gate;
            return {
              content: [{ type: "text" as const, text: "gated file contents" }],
              details: {},
            };
          }) as AgentTool["execute"],
        });

        const started = (await registeredTool(runtime, "Task").execute("task-1", {
          agent: "worker",
          task: "Read target.txt and report what it says.",
        })) as any;
        const delegationId = started.details?.delegationId as string;
        expect(delegationId).toBeTruthy();

        // The child's first tool batch is now blocked inside Read.
        await entered;
        const record = (runtime as any).delegations.get(delegationId);
        const runBefore = record.run;
        expect(record.status).toBe("running");

        const receipt = (await registeredTool(runtime, "TaskSteer").execute("steer-1", {
          delegationId,
          message: STEER_TEXT,
        })) as any;
        expect(receipt.details?.error).toBeUndefined();
        expect(receipt.details.delegationId).toBe(delegationId);
        expect(receipt.details.status).toBe("queued");
        expect(receipt.details.delivery).toBe("next_turn");
        expect(receipt.details.source).toBe("model");
        expect(String(receipt.content[0].text)).toContain("queued");
        expect(String(receipt.content[0].text)).not.toMatch(/consumed|executed/);

        // The blocked tool was not aborted: the same run is still working.
        expect(toolCalls).toHaveLength(1);
        expect(record.status).toBe("running");
        release();

        const waited = (await registeredTool(runtime, "TaskWait").execute("wait-1", {
          delegationIds: [delegationId],
        })) as any;
        expect(JSON.stringify(waited.details)).toContain("Checked the docs too. Done.");

        // Exactly two model requests: the tool batch, then the steered turn.
        // No follow-up run was spawned to deliver the intervention.
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[1].messages)).toContain(STEER_TEXT);
        expect((runtime as any).delegations.get(delegationId).run).toBe(runBefore);
      } finally {
        await runtime.dispose();
      }
    },
    30_000,
  );
});
