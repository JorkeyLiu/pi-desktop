import { describe, expect, it, vi } from "vitest";
import { GenerationThroughputSampler } from "./generation-throughput.js";

const usage = (output: number) => ({ output });

const textFrame = (delta: string) => ({
  type: "text_delta",
  contentIndex: 0,
  delta,
  partial: { content: [] },
});

const thinkingFrame = (delta: string) => ({
  type: "thinking_delta",
  contentIndex: 0,
  delta,
  partial: { content: [] },
});

describe("GenerationThroughputSampler", () => {
  it("commits exact provider output over first-content-to-end duration", () => {
    vi.useFakeTimers();
    try {
      const sampler = new GenerationThroughputSampler();
      sampler.noteEvent(undefined);
      vi.advanceTimersByTime(900);
      sampler.noteEvent(textFrame("hello") as any);
      vi.advanceTimersByTime(100);
      expect(sampler.commitSample(usage(40).output)).toBe(true);
      expect(sampler.totals()).toEqual({ tokens: 40, durationMs: 100, samples: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("two samplers fed identical events report identical totals", () => {
    vi.useFakeTimers();
    try {
      const parent = new GenerationThroughputSampler();
      const child = new GenerationThroughputSampler();
      for (const sampler of [parent, child]) {
        sampler.resetAttempt();
        vi.advanceTimersByTime(500);
        sampler.noteEvent(textFrame("hello") as any);
        vi.advanceTimersByTime(250);
        expect(sampler.commitSample(usage(30).output)).toBe(true);
      }
      expect(parent.totals()).toEqual(child.totals());
      expect(parent.totals()).toEqual({ tokens: 30, durationMs: 250, samples: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores empty deltas and pre-content waiting", () => {
    vi.useFakeTimers();
    try {
      const sampler = new GenerationThroughputSampler();
      sampler.resetAttempt();
      vi.advanceTimersByTime(700);
      sampler.noteEvent(textFrame("") as any);
      vi.advanceTimersByTime(300);
      sampler.noteEvent(textFrame("hi") as any);
      vi.advanceTimersByTime(50);
      expect(sampler.commitSample(usage(9).output)).toBe(true);
      expect(sampler.totals()).toEqual({ tokens: 9, durationMs: 50, samples: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps thinking-only and tool-arg-only starts", () => {
    vi.useFakeTimers();
    try {
      const thinking = new GenerationThroughputSampler();
      thinking.resetAttempt();
      thinking.noteEvent(thinkingFrame("plan") as any);
      vi.advanceTimersByTime(40);
      expect(thinking.commitSample(usage(5).output)).toBe(true);
      expect(thinking.totals()).toEqual({ tokens: 5, durationMs: 40, samples: 1 });

      const tools = new GenerationThroughputSampler();
      tools.resetAttempt();
      tools.noteEvent({
        type: "toolcall_start",
        contentIndex: 0,
        partial: { content: [{ type: "toolCall", arguments: { query: "x" } }] },
      } as any);
      vi.advanceTimersByTime(60);
      expect(tools.commitSample(usage(0).output)).toBe(true);
      expect(tools.totals()).toEqual({ tokens: 0, durationMs: 60, samples: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetAttempt drops the previous attempt so a retry never leaks in", () => {
    vi.useFakeTimers();
    try {
      const sampler = new GenerationThroughputSampler();
      sampler.resetAttempt();
      vi.advanceTimersByTime(800);
      sampler.noteEvent(textFrame("stale") as any);
      vi.advanceTimersByTime(50);
      sampler.resetAttempt();
      vi.advanceTimersByTime(30);
      sampler.noteEvent(textFrame("fresh") as any);
      vi.advanceTimersByTime(20);
      expect(sampler.commitSample(usage(7).output)).toBe(true);
      expect(sampler.totals()).toEqual({ tokens: 7, durationMs: 20, samples: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits once and drops unusable samples", () => {
    vi.useFakeTimers();
    try {
      const sampler = new GenerationThroughputSampler();
      sampler.resetAttempt();
      sampler.noteEvent(textFrame("x") as any);
      // No usable output: consume the stamp without committing.
      expect(sampler.commitSample(undefined)).toBe(false);
      expect(sampler.commitSample(-1)).toBe(false);
      expect(sampler.totals()).toBeUndefined();
      // A turn that never generated content commits nothing.
      sampler.resetAttempt();
      vi.advanceTimersByTime(10);
      expect(sampler.commitSample(usage(5).output)).toBe(false);
      expect(sampler.totals()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accumulates settled turns additively", () => {
    vi.useFakeTimers();
    try {
      const sampler = new GenerationThroughputSampler();
      sampler.resetAttempt();
      sampler.noteEvent(textFrame("one") as any);
      vi.advanceTimersByTime(100);
      expect(sampler.commitSample(usage(10).output)).toBe(true);
      sampler.resetAttempt();
      sampler.noteEvent(textFrame("two") as any);
      vi.advanceTimersByTime(200);
      expect(sampler.commitSample(usage(20).output)).toBe(true);
      expect(sampler.totals()).toEqual({ tokens: 30, durationMs: 300, samples: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});
