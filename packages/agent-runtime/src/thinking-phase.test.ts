/**
 * Generation phase for thinking: the phase reports what the model is
 * currently generating — not which thinking blocks are still open and not
 * what the renderer's latest tool row says.
 *
 * pi-ai emits `thinking_start` / `thinking_delta` / `thinking_end` per
 * content block, and pi-agent-core forwards each one as a `message_update`
 * carrying that frame in `assistantMessageEvent`. The assistant message
 * itself stays `status: "streaming"` through all of it, and some providers
 * move on to tool calls or reply text without ever ending the thinking block
 * (responses can `toolcall_start` before `reasoning output_item.done`;
 * completions stream one final finish block). Waiting for `thinking_end`
 * would keep the row breathing while the tool row is already up, so the
 * phase must move the moment generation leaves thinking — while the message
 * still streams — and a `thinking_end` only ever ends its own currently
 * generating block.
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
  it("stays streaming through deltas, then completes on its own thinking_end", () => {
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

  it("completes when text generation starts while thinking never ended", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.observe(frame("thinking_delta", 0, { delta: "plan" }))).toBeUndefined();
    // The model moved on to reply text with no thinking_end: thinking is no
    // longer the active generation even though its block never ended.
    expect(tracker.observe(frame("text_start", 1))).toBe("complete");
    expect(tracker.observe(frame("text_delta", 1, { delta: "hi" }))).toBeUndefined();
    expect(tracker.phase()).toBe("complete");
    // The late authoritative end for the abandoned block changes nothing and
    // must not resurrect the phase.
    expect(tracker.observe(frame("thinking_end", 0, { content: "plan" }))).toBeUndefined();
    expect(tracker.phase()).toBe("complete");
  });

  it("completes when tool-call generation starts while thinking never ended", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.observe(frame("thinking_delta", 0, { delta: "plan" }))).toBeUndefined();
    // Responses can toolcall_start before reasoning output_item.done arrives:
    // the dot must stop while the message still streams.
    expect(tracker.observe(frame("toolcall_start", 1))).toBe("complete");
    expect(tracker.observe(frame("toolcall_delta", 1, { delta: "{}" }))).toBeUndefined();
    expect(tracker.observe(frame("toolcall_end", 1, { toolCall: {} }))).toBeUndefined();
    expect(tracker.phase()).toBe("complete");
  });

  it("reactivates thinking after tool activity on a real thinking frame", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.observe(frame("toolcall_start", 1))).toBe("complete");
    // A newer thought breathes again, even inside the same bubble.
    expect(tracker.observe(frame("thinking_start", 2))).toBe("streaming");
    expect(tracker.observe(frame("thinking_delta", 2, { delta: "more" }))).toBeUndefined();
    expect(tracker.observe(frame("thinking_end", 2, { content: "more" }))).toBe("complete");
  });

  it("reactivates thinking from untyped deltas after tool activity", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.observe(frame("toolcall_start", 1))).toBe("complete");
    // Compatibility: a real thinking delta without typed frames reopens
    // generation even after a typed tool frame closed it.
    expect(tracker.noteThinkingDelta()).toBe("streaming");
    expect(tracker.noteThinkingDelta()).toBeUndefined();
    expect(tracker.finish()).toBe("complete");
  });

  it("ignores a late end for an older block while newer thinking generates", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.observe(frame("toolcall_start", 1))).toBe("complete");
    expect(tracker.observe(frame("thinking_start", 2))).toBe("streaming");
    // The late authoritative end for block 0 must not close block 2.
    expect(tracker.observe(frame("thinking_end", 0, { content: "plan" }))).toBeUndefined();
    expect(tracker.phase()).toBe("streaming");
    expect(tracker.observe(frame("thinking_end", 2, { content: "more" }))).toBe("complete");
  });

  it("completes on the end of the generating block while another stays open", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.observe(frame("thinking_start", 2))).toBeUndefined();
    // Block 2 is the current generation: its end completes the phase even
    // though block 0 never ended. Waiting for every open block would keep
    // breathing long after generation moved on.
    expect(tracker.observe(frame("thinking_end", 2, { content: "b" }))).toBe("complete");
    expect(tracker.observe(frame("thinking_end", 0, { content: "a" }))).toBeUndefined();
    expect(tracker.phase()).toBe("complete");
  });

  it("never moves the phase on text_end or toolcall_end for another lane", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    // End markers for another lane say nothing about what is generating now.
    expect(tracker.observe(frame("text_end", 1, { content: "hi" }))).toBeUndefined();
    expect(tracker.observe(frame("toolcall_end", 2, { toolCall: {} }))).toBeUndefined();
    expect(tracker.phase()).toBe("streaming");
    // An end for a block that never opened is stray: ignore it.
    expect(tracker.observe(frame("thinking_end", 9, { content: "?" }))).toBeUndefined();
    expect(tracker.phase()).toBe("streaming");
    expect(tracker.observe(frame("thinking_end", 0, { content: "plan" }))).toBe("complete");
  });

  it("ignores a repeated end so it can never reopen a completed phase", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    expect(tracker.observe(frame("thinking_end", 0, { content: "a" }))).toBe("complete");
    // A stale duplicate end for the closed block changes nothing.
    expect(tracker.observe(frame("thinking_end", 0, { content: "a" }))).toBeUndefined();
    expect(tracker.phase()).toBe("complete");
    // A new block breathes again after the duplicate.
    expect(tracker.observe(frame("thinking_start", 1))).toBe("streaming");
    expect(tracker.observe(frame("thinking_end", 0, { content: "a" }))).toBeUndefined();
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

  it("finishes an attempt without letting the retry inherit the phase", () => {
    const tracker = createThinkingPhaseTracker();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
    // The provider attempt ends (silent/progress/overflow/retry teardown)
    // while the same assistant bubble is retained: thinking stops here.
    expect(tracker.finish()).toBe("complete");
    // A late end from the finished attempt changes nothing.
    expect(tracker.observe(frame("thinking_end", 0, { content: "plan" }))).toBeUndefined();
    expect(tracker.phase()).toBe("complete");
    // The next attempt reopens thinking only on a real thinking frame.
    expect(tracker.observe(frame("text_start", 1))).toBeUndefined();
    expect(tracker.observe(frame("thinking_start", 0))).toBe("streaming");
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
