import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS,
  MAX_SUBAGENT_WAKEUP_CONTEXT_TOKENS,
  MAX_SUBAGENT_WAKEUP_TIME_SECONDS,
  MAX_SUBAGENT_WAKEUP_TOOL_CALLS,
  MIN_SUBAGENT_WAKEUP_CONTEXT_TOKENS,
  MIN_SUBAGENT_WAKEUP_TIME_SECONDS,
  MIN_SUBAGENT_WAKEUP_TOOL_CALLS,
  formatSubagentProgressMetrics,
  isSubagentWakeupSettings,
  isUuid,
  normalizeSubagentWakeupSettings,
} from "./subagent-wakeup.js";

describe("normalizeSubagentWakeupSettings canonical", () => {
  it("defaults to the periodic time wake", () => {
    expect(normalizeSubagentWakeupSettings(undefined)).toEqual({
      kind: "time",
      value: DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS,
    });
    expect(normalizeSubagentWakeupSettings({})).toEqual(
      normalizeSubagentWakeupSettings(undefined),
    );
  });

  it("keeps the four kinds exclusive", () => {
    expect(normalizeSubagentWakeupSettings({ kind: "off" })).toEqual({
      kind: "off",
    });
    expect(
      normalizeSubagentWakeupSettings({ kind: "time", value: 30 }),
    ).toEqual({ kind: "time", value: 30 });
    expect(
      normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 5 }),
    ).toEqual({ kind: "tool-calls", value: 5 });
    expect(
      normalizeSubagentWakeupSettings({ kind: "context-tokens", value: 50_000 }),
    ).toEqual({ kind: "context-tokens", value: 50_000 });
    // Off carries no value even when one is sent.
    expect(
      normalizeSubagentWakeupSettings({ kind: "off", value: 99 }),
    ).toEqual({ kind: "off" });
  });

  it("clamps each kind into its exported bounds", () => {
    expect(
      normalizeSubagentWakeupSettings({ kind: "time", value: 10_000 }),
    ).toEqual({ kind: "time", value: MAX_SUBAGENT_WAKEUP_TIME_SECONDS });
    expect(
      normalizeSubagentWakeupSettings({ kind: "time", value: 0 }),
    ).toEqual({ kind: "time", value: MIN_SUBAGENT_WAKEUP_TIME_SECONDS });
    expect(
      normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 25_000 }),
    ).toEqual({ kind: "tool-calls", value: MAX_SUBAGENT_WAKEUP_TOOL_CALLS });
    expect(
      normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 25.9 }),
    ).toEqual({ kind: "tool-calls", value: 25 });
    expect(
      normalizeSubagentWakeupSettings({
        kind: "context-tokens",
        value: 10_000_000_000,
      }),
    ).toEqual({
      kind: "context-tokens",
      value: MAX_SUBAGENT_WAKEUP_CONTEXT_TOKENS,
    });
    expect(
      normalizeSubagentWakeupSettings({ kind: "context-tokens", value: 500 }),
    ).toEqual({
      kind: "context-tokens",
      value: MIN_SUBAGENT_WAKEUP_CONTEXT_TOKENS,
    });
    expect(MAX_SUBAGENT_WAKEUP_TOOL_CALLS).toBeGreaterThan(
      MIN_SUBAGENT_WAKEUP_TOOL_CALLS,
    );
  });

  it("falls back malformed canonical input to the product default", () => {
    const fallback = {
      kind: "time" as const,
      value: DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS,
    };
    expect(
      normalizeSubagentWakeupSettings({ kind: "time", value: Number.NaN }),
    ).toEqual(fallback);
    expect(
      normalizeSubagentWakeupSettings({
        kind: "tool-calls",
        value: Number.POSITIVE_INFINITY,
      }),
    ).toEqual(fallback);
    expect(
      normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 0.4 }),
    ).toEqual(fallback);
    expect(
      normalizeSubagentWakeupSettings({ kind: "context-tokens", value: -5 }),
    ).toEqual(fallback);
    expect(
      normalizeSubagentWakeupSettings({ kind: "nonsense" as never }),
    ).toEqual(fallback);
  });

  it("maps legacy shapes transitionally with context-first exclusivity", () => {
    // Explicit context wins over tool calls and time.
    expect(
      normalizeSubagentWakeupSettings({
        contextTokens: 50_000,
        toolCalls: 5,
        timeSeconds: 30,
      }),
    ).toEqual({ kind: "context-tokens", value: 50_000 });
    expect(
      normalizeSubagentWakeupSettings({ toolCalls: 5, timeSeconds: 30 }),
    ).toEqual({ kind: "tool-calls", value: 5 });
    expect(normalizeSubagentWakeupSettings({ timeSeconds: 30 })).toEqual({
      kind: "time",
      value: 30,
    });
    // Legacy periodic-off maps to the off selector.
    expect(normalizeSubagentWakeupSettings({ timeSeconds: null })).toEqual({
      kind: "off",
    });
    expect(
      normalizeSubagentWakeupSettings({ timeSeconds: null, toolCalls: null }),
    ).toEqual({ kind: "off" });
  });

  it("ignores legacy onCompletion:false: completion always delivers", () => {
    // A legacy completion opt-out normalizes to the default periodic wake —
    // the flag is dropped, delivery stays mandatory.
    expect(
      normalizeSubagentWakeupSettings({ onCompletion: false }),
    ).toEqual({
      kind: "time",
      value: DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS,
    });
    expect(
      normalizeSubagentWakeupSettings({ timeSeconds: 30, onCompletion: false }),
    ).toEqual({ kind: "time", value: 30 });
  });
});

describe("formatSubagentProgressMetrics", () => {
  it("compacts occupancy and spend without confusing them", () => {
    expect(
      formatSubagentProgressMetrics({
        toolCalls: 3,
        contextTokens: 12_345,
        usage: { inputTokens: 40_000, outputTokens: 5_678, totalTokens: 45_678 },
      }),
    ).toBe("3 tool calls, ctx 12.3k tokens, spent 45.7k tokens");
    expect(formatSubagentProgressMetrics({ toolCalls: 1 })).toBe(
      "1 tool call",
    );
  });
});

describe("isUuid", () => {
  it("accepts UUID-shaped row and turn identities only", () => {
    expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isUuid("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
    expect(isUuid("task-1")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid("123e4567e89b12d3a456426614174000")).toBe(false);
  });
});

describe("isSubagentWakeupSettings", () => {
  it("accepts canonical and legacy shapes, rejecting mistyped values", () => {
    expect(isSubagentWakeupSettings({})).toBe(true);
    expect(
      isSubagentWakeupSettings({ kind: "time", value: 30 }),
    ).toBe(true);
    expect(isSubagentWakeupSettings({ kind: "off" })).toBe(true);
    expect(
      isSubagentWakeupSettings({ kind: "tool-calls", value: 5 }),
    ).toBe(true);
    // Out of range still lands; the normalizers clamp at read time.
    expect(
      isSubagentWakeupSettings({ kind: "time", value: 10_000_000 }),
    ).toBe(true);
    // Legacy transitional shape still validates.
    expect(
      isSubagentWakeupSettings({
        timeSeconds: 30,
        onCompletion: false,
        toolCalls: null,
        contextTokens: 50_000,
      }),
    ).toBe(true);
    expect(isSubagentWakeupSettings({ kind: "sometimes" })).toBe(false);
    expect(isSubagentWakeupSettings({ kind: "time", value: "soon" })).toBe(false);
    expect(isSubagentWakeupSettings({ timeSeconds: "soon" })).toBe(false);
    expect(isSubagentWakeupSettings({ onCompletion: "yes" })).toBe(false);
    expect(isSubagentWakeupSettings({ toolCalls: Number.NaN })).toBe(false);
    expect(isSubagentWakeupSettings(null)).toBe(false);
    expect(isSubagentWakeupSettings([])).toBe(false);
  });
});
