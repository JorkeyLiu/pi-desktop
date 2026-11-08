import { describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { applyMessageUpdate, streamingMessageIdentity } from "@pi-desktop/shared";
import { createStreamCoalescer } from "./stream-coalescer.js";

function assistant(partial: Partial<UiMessage> & Pick<UiMessage, "id" | "content">): UiMessage {
  return {
    role: "assistant",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "streaming",
    ...partial,
  };
}

function envelope(
  event: AgentEventEnvelope["event"],
  extra: Partial<AgentEventEnvelope> = {},
): AgentEventEnvelope {
  return { sessionId: "s1", ts: 1, event, ...extra };
}

describe("createStreamCoalescer", () => {
  it("concatenates deltas and flushes them before a semantic boundary", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
      schedule: () => () => {},
    });
    const live = assistant({ id: "m1", content: "Hel" });
    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "m1", content: "Hel" }),
        deltaText: "Hel",
      }),
    );
    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "m1", content: "Hello" }),
        deltaText: "lo",
      }),
    );
    coalescer.push(envelope({ type: "tool_start", toolCallId: "t1", toolName: "Read", args: {} }));

    expect(emitted.map((item) => item.event.type)).toEqual(["message_update", "tool_start"]);
    const update = emitted[0]!.event;
    expect(update).toMatchObject({
      type: "message_update",
      stream: "delta",
      deltaText: "Hello",
    });
    if (update.type !== "message_update") throw new Error("expected update");
    expect(update.message.content).toBe("");
    expect(applyMessageUpdate(streamingMessageIdentity(live), update).content).toBe("Hello");
    coalescer.dispose();
  });

  it("does not reorder a later message_end behind a pending delta", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
      schedule: () => () => {},
    });
    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "m1", content: "Hi" }),
        deltaText: "Hi",
      }),
    );
    coalescer.push(
      envelope({
        type: "message_end",
        message: assistant({ id: "m1", content: "Hi", status: "complete" }),
      }),
    );
    expect(emitted.map((item) => item.event.type)).toEqual(["message_update", "message_end"]);
    coalescer.dispose();
  });

  it("keeps parent and subagent streams on separate keys", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 0,
    });
    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "parent", content: "P" }),
        deltaText: "P",
      }),
    );
    coalescer.push(
      envelope(
        {
          type: "message_update",
          message: assistant({ id: "child", content: "C" }),
          deltaText: "C",
        },
        { parentToolCallId: "task-1" },
      ),
    );
    expect(emitted).toHaveLength(2);
    expect(emitted[0]!.event).toMatchObject({ deltaText: "P" });
    expect(emitted[1]!.event).toMatchObject({ deltaText: "C" });
    expect(emitted[1]!.parentToolCallId).toBe("task-1");
    coalescer.dispose();
  });

  it("passes snapshot replacements through without slimming", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item));
    const snapshot = assistant({ id: "m1", content: "retry body" });
    coalescer.push(envelope({ type: "message_update", message: snapshot }));
    expect(emitted[0]!.event).toEqual({ type: "message_update", message: snapshot });
    coalescer.dispose();
  });

  it("flushes on the scheduled interval", () => {
    vi.useFakeTimers();
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
    });
    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "m1", content: "a" }),
        deltaText: "a",
      }),
    );
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({ stream: "delta", deltaText: "a" });
    coalescer.dispose();
    vi.useRealTimers();
  });

  const updateEvent = (item: AgentEventEnvelope) => {
    if (item.event.type !== "message_update") throw new Error("expected message_update");
    return item.event;
  };

  const replay = (seed: UiMessage, frames: AgentEventEnvelope[]) =>
    frames.reduce<UiMessage>(
      (row, item) =>
        item.event.type === "message_update" ? applyMessageUpdate(row, item.event) : row,
      seed,
    );

  it("flushes a pending empty growth frame instead of degrading it to a snapshot", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
      schedule: () => () => {},
    });
    const row = assistant({ id: "m1", content: "body" });
    const growth = envelope({ type: "message_update", message: row, deltaText: "" });
    coalescer.push(growth);
    coalescer.push(growth);
    // Nothing merges: the second frame flushes the first and takes its place.
    expect(emitted).toHaveLength(1);
    coalescer.flush();
    expect(emitted).toHaveLength(2);
    for (const item of emitted) {
      const event = updateEvent(item);
      expect(event.stream).toBe("delta");
      expect(event.deltaText).toBeUndefined();
      expect(event.message.content).toBe("");
      expect(event.message.id).toBe("m1");
    }
    expect(coalescer.stats()).toMatchObject({ accepted: 2, coalesced: 0, emitted: 2 });
    // An empty identity delta appends and replaces nothing.
    expect(replay(row, emitted).content).toBe("body");
    coalescer.dispose();
  });

  it("keeps marker and text deltas in order inside one coalescing window", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
      schedule: () => () => {},
    });
    const row = assistant({ id: "m1", content: "body" });
    const grown = assistant({ id: "m1", content: "body more", modelId: "model-7" });
    coalescer.push(envelope({ type: "message_update", message: row, deltaText: "" }));
    coalescer.push(envelope({ type: "message_update", message: row, deltaText: "" }));
    coalescer.push(envelope({ type: "message_update", message: grown, deltaText: " more" }));
    coalescer.flush();

    expect(emitted).toHaveLength(2);
    const [marker, text] = emitted.map(updateEvent);
    expect(marker).toMatchObject({ stream: "delta", message: { id: "m1", content: "" } });
    expect(marker?.deltaText).toBeUndefined();
    expect(text).toMatchObject({ stream: "delta", deltaText: " more" });
    // The surviving frame keeps the newer row's metadata.
    expect(text?.message.content).toBe("");
    expect(text?.message.modelId).toBe("model-7");
    expect(coalescer.stats()).toMatchObject({ accepted: 3, coalesced: 1, emitted: 2 });
    expect(replay(row, emitted).content).toBe("body more");
    coalescer.dispose();
  });

  it("keeps a pending text delta when growth markers follow in the same window", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
      schedule: () => () => {},
    });
    const row = assistant({ id: "m1", content: "body" });
    coalescer.push(envelope({ type: "message_update", message: row, deltaText: "body" }));
    coalescer.push(envelope({ type: "message_update", message: row, deltaText: "" }));
    coalescer.push(envelope({ type: "message_update", message: row, deltaText: "" }));
    coalescer.flush();

    expect(emitted).toHaveLength(1);
    const event = updateEvent(emitted[0]!);
    expect(event).toMatchObject({ stream: "delta", deltaText: "body" });
    expect(event.message.content).toBe("");
    expect(coalescer.stats()).toMatchObject({ coalesced: 2, emitted: 1 });
    coalescer.dispose();
  });

  it("keeps a snapshot replacement ahead of a same-window delta", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
      schedule: () => () => {},
    });
    const snapshot = assistant({ id: "m1", content: "retry body" });
    coalescer.push(envelope({ type: "message_update", message: snapshot }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toEqual({ type: "message_update", message: snapshot });

    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "m1", content: "retry body more" }),
        deltaText: " more",
      }),
    );
    coalescer.flush();
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.event).toMatchObject({ stream: "delta", deltaText: " more" });
    expect(replay(snapshot, emitted).content).toBe("retry body more");
    coalescer.dispose();
  });
});
