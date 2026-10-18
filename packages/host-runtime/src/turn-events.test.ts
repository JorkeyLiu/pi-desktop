import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { TurnEventPipeline } from "./turn-events.js";

for (const delegate of [false, true]) {
  describe(`nested tool persistence (${delegate ? "delegate" : "root"})`, () => {
    it("retains tool nesting without changing Task ownership", async () => {
      const written: Array<{ message: UiMessage; turnId: string }> = [];
      const emitted: AgentEventEnvelope[] = [];
      const finished: string[] = [];
      const pipeline = new TurnEventPipeline({
        getHost: () => ({
          async call<T>(method: string, params: unknown): Promise<T> {
            if (method === "session.appendMessage") {
              written.push(params as { message: UiMessage; turnId: string });
            }
            return {} as T;
          },
        }),
        ownership: {
          activeTurnId: () => "turn-1",
          isStaleTerminalEvent: () => false,
          finishTurn: async (sessionId) => { finished.push(sessionId); },
        },
        emit: (event) => emitted.push(event),
        log: () => undefined,
      });
      const lineage = {
        nestedParentToolCallId: "code-1",
        ...(delegate ? { parentToolCallId: "task-1", agentName: "reader" } : {}),
      };
      pipeline.handle({
        sessionId: "s", turnId: "turn-1", ts: 1_000, ...lineage,
        event: { type: "tool_start", toolCallId: "read-1", toolName: "Read", args: { path: "a.ts" } },
      });
      pipeline.handle({
        sessionId: "s", turnId: "turn-1", ts: 1_100, ...lineage,
        event: { type: "tool_end", toolCallId: "read-1", result: "contents" },
      });
      await pipeline.dispose();
      expect(written).toHaveLength(1);
      expect(written[0]?.turnId).toBe("turn-1");
      expect(written[0]?.message).toMatchObject({ toolCallId: "read-1", ...lineage });
      expect(written[0]?.message.parentToolCallId).toBe(delegate ? "task-1" : undefined);
      expect(finished).toEqual([]);
      const completed = emitted.find((envelope) => envelope.event.type === "message_end");
      expect(completed?.nestedParentToolCallId).toBe("code-1");
      expect(completed?.parentToolCallId).toBe(delegate ? "task-1" : undefined);
    });
  });
}


describe("usage ledger ingress", () => {  it("unions child reports and parent aggregates, replays idempotently, and isolates late turns", async () => {
    const writes: Array<{ method: string; params: unknown }> = [];
    const pipeline = new TurnEventPipeline({
      getHost: () => ({ async call<T>(method: string, params: unknown): Promise<T> {
        writes.push({ method, params }); return {} as T;
      } }),
      ownership: { activeTurnId: () => "new-turn", isStaleTerminalEvent: () => false, finishTurn: async () => undefined },
      emit: () => undefined, log: () => undefined,
    });
    const child = { operationId: "request-child", usageOrigin: "pi" as const, inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const classifier = { ...child, operationId: "classifier" };
    const event = { sessionId: "s", turnId: "new-turn", parentToolCallId: "task-1", nestedParentToolCallId: "code-1", ts: 1,
      event: { type: "usage" as const, usage: child } };
    pipeline.handle(event);
    pipeline.handle(event);
    pipeline.handle({ ...event, event: { type: "message_end", message: { id: "child", role: "assistant", content: "done", createdAt: "2026-09-30", usage: child } } });
    pipeline.handle({ sessionId: "s", turnId: "new-turn", ts: 2, event: { type: "turn_end", subagentUsage: {
      inputTokens: 20, outputTokens: 4, totalTokens: 24, aggregation: "aggregate", operations: [child, classifier],
    } } });
    pipeline.handle({ ...event, turnId: "old-turn", event: { type: "usage", usage: { ...child, operationId: "late" } } });
    expect(pipeline.takeTurnUsage("s")?.totalTokens).toBe(24);
    await pipeline.dispose();
    expect(writes.filter((write) => write.method === "session.recordUsage")).toHaveLength(5);
    expect(writes.at(-1)?.params).toMatchObject({ turnId: "old-turn", usage: { operationId: "late" } });
  });
});

describe("child steer echo persistence", () => {
  it("persists an attributed child user row without parent-turn effects", async () => {
    const written: Array<{ message: UiMessage; turnId: string }> = [];
    const finished: string[] = [];
    const pipeline = new TurnEventPipeline({
      getHost: () => ({
        async call<T>(method: string, params: unknown): Promise<T> {
          if (method === "session.appendMessage") {
            written.push(params as { message: UiMessage; turnId: string });
          }
          return {} as T;
        },
      }),
      ownership: {
        activeTurnId: () => "turn-1",
        isStaleTerminalEvent: () => false,
        finishTurn: async (sessionId) => { finished.push(sessionId); },
      },
      emit: () => undefined,
      log: () => undefined,
    });
    pipeline.handle({
      sessionId: "s",
      turnId: "turn-1",
      ts: 1_000,
      parentToolCallId: "task-1",
      agentName: "explorer",
      event: {
        type: "message_end",
        message: {
          id: "steer-1",
          role: "user",
          content: "Focus on auth.",
          createdAt: "2026-09-30T00:00:00.000Z",
          status: "complete",
          steering: true,
          parentToolCallId: "task-1",
          agentName: "explorer",
        },
      },
    });
    await pipeline.dispose();
    // Durable for the transcript and chain replay, tagged so the parent's
    // model rebuild keeps skipping it; the parent turn itself is untouched.
    expect(written).toHaveLength(1);
    expect(written[0]?.turnId).toBe("turn-1");
    expect(written[0]?.message).toMatchObject({
      id: "steer-1",
      role: "user",
      parentToolCallId: "task-1",
      agentName: "explorer",
    });
    expect(finished).toEqual([]);
  });
});

describe("detached execution-turn persistence", () => {
  it("honors the explicit envelope turn on child rows instead of the active parent", async () => {
    const written: Array<{ message: UiMessage; turnId: string }> = [];
    const pipeline = new TurnEventPipeline({
      getHost: () => ({
        async call<T>(method: string, params: unknown): Promise<T> {
          if (method === "session.appendMessage") {
            written.push(params as { message: UiMessage; turnId: string });
          }
          return {} as T;
        },
      }),
      ownership: {
        activeTurnId: () => "parent-turn",
        isStaleTerminalEvent: () => false,
        finishTurn: async () => undefined,
      },
      emit: () => undefined,
      log: () => undefined,
    });
    const assistant = (id: string): UiMessage => ({
      id,
      role: "assistant",
      content: "working",
      createdAt: "2026-09-30T00:00:00.000Z",
      status: "complete",
    });
    pipeline.handle({
      sessionId: "s",
      turnId: "exec-turn",
      ts: 1_000,
      parentToolCallId: "task-9",
      agentName: "explorer",
      event: { type: "message_end", message: assistant("child-a") },
    });
    pipeline.handle({
      sessionId: "s",
      turnId: "parent-turn",
      ts: 1_001,
      event: { type: "message_end", message: assistant("parent-a") },
    });
    await pipeline.dispose();
    expect(written).toHaveLength(2);
    // The child's row lands under its own execution turn, never folded into
    // whatever parent turn happens to be active.
    expect(written.find((row) => row.message.id === "child-a")?.turnId).toBe("exec-turn");
    expect(written.find((row) => row.message.id === "parent-a")?.turnId).toBe("parent-turn");
  });
});
