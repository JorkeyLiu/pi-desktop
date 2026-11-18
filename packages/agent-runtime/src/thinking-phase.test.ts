/**
 * Block-level thinking phase: pi-ai emits `thinking_start` / `thinking_delta` /
 * `thinking_end` per content block, and pi-agent-core forwards each one as a
 * `message_update` carrying that frame in `assistantMessageEvent`. The
 * assistant message itself stays `status: "streaming"` through all of it, so
 * the phase — not the message status and not later transcript activity — is
 * what stops the renderer's thinking indicator.
 */
import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createThinkingPhaseTracker } from "./thinking-phase.js";

const frame = (
  type: AssistantMessageEvent["type"],
  contentIndex = 0,
  extra: Record<string, unknown> = {},
): AssistantMessageEvent =>
  ({
    type,
    contentIndex,
    partial: { role: "assistant", content: [] },
    ...extra,
  }) as unknown as AssistantMessageEvent;

describe("createThinkingPhaseTracker", () => {
  it("stays silent through thinking_start and delta, then completes on thinking_end", () => {
    const tracker = createThinkingPhaseTracker();
    // thinking_start carries an empty block: no content delta exists yet, but
    // the phase change itself must be observable.
    expect(tracker.observe(frame("thinking_start"))).toBe("streaming");
    expect(tracker.observe(frame("thinking_delta", 0, { delta: "pla" }))).toBeUndefined();
    expect(tracker.observe(frame("thinking_delta", 0, { delta: "n" }))).toBeUndefined();
    expect(tracker.observe(frame("thinking_end", 0, { content: "plan" }))).toBe("complete");
  });

  it("completes on thinking_end even when the end carries no new delta", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 3))).toBe("streaming");
    // Redacted thinking can be complete at start and emit no deltas at all.
    expect(tracker.observe(frame("thinking_end", 3, { content: "done" }))).toBe("complete");
  });

  it("ignores a repeated end so it cannot clear a newer block", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.observe(frame("thinking_end", 0, { content: "a" }))).toBe("complete");
    // A stale duplicate end for the closed block changes nothing.
    expect(tracker.observe(frame("thinking_end", 0, { content: "a" }))).toBeUndefined();
    // A new block breathes again after the duplicate.
    expect(tracker.observe(frame("thinking_start", 1))).toBe("streaming");
    expect(tracker.observe(frame("thinking_end", 0, { content: "a" }))).toBeUndefined();
    expect(tracker.observe(frame("thinking_end", 1, { content: "b" }))).toBe("complete");
  });

  it("keeps streaming while any of several blocks is still open", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.observe(frame("thinking_start", 1))).toBeUndefined();
    expect(tracker.observe(frame("thinking_end", 0, { content: "a" }))).toBeUndefined();
    expect(tracker.phase()).toBe("streaming");
    expect(tracker.observe(frame("thinking_end", 1, { content: "b" }))).toBe("complete");
  });

  it("treats a real thinking delta without typed frames as streaming", () => {
    const tracker = createThinkingPhaseTracker();
    // Older or synthetic inputs can carry thinking deltas with no
    // thinking_start: the row still breathes until the terminal fallback.
    expect(tracker.noteThinkingDelta()).toBe("streaming");
    expect(tracker.noteThinkingDelta()).toBeUndefined();
    expect(tracker.phase()).toBe("streaming");
  });

  it("never infers the phase from text or tool activity", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.observe(frame("text_start", 1))).toBeUndefined();
    expect(tracker.observe(frame("text_delta", 1, { delta: "hi" }))).toBeUndefined();
    expect(tracker.observe(frame("toolcall_start", 2))).toBeUndefined();
    expect(tracker.observe(frame("toolcall_delta", 2, { delta: "{}" }))).toBeUndefined();
    expect(tracker.observe(frame("toolcall_end", 2, { toolCall: {} }))).toBeUndefined();
    expect(tracker.phase()).toBe("streaming");
    expect(tracker.observe(frame("thinking_end", 0, { content: "plan" }))).toBe("complete");
  });

  it("finishes active thinking as a terminal fallback and resets cleanly", () => {
    const tracker = createThinkingPhaseTracker();
    // A stream that ends without thinking_end (missing provider frame) still
    // stops the indicator at the terminal boundary.
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.finish()).toBe("complete");
    expect(tracker.finish()).toBeUndefined();
    // An already-completed stream finishes silently.
    expect(
      (() => {
        const done = createThinkingPhaseTracker();
        done.observe(frame("thinking_start", 0));
        done.observe(frame("thinking_end", 0, { content: "x" }));
        return done.finish();
      })(),
    ).toBeUndefined();
    // A stream that never thought finishes silently.
    expect(createThinkingPhaseTracker().finish()).toBeUndefined();
    // A fresh bubble starts with no phase.
    tracker.reset();
    expect(tracker.phase()).toBeUndefined();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
  });

  it("ignores frames without a typed event", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(undefined)).toBeUndefined();
    expect(tracker.phase()).toBeUndefined();
  });
});
