import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
  DEFAULT_SUBAGENT_HANDOFF_TOKENS,
  DEFAULT_SUBAGENT_HANDOFF_TOOL_CALLS,
  DEFAULT_SUBAGENT_SELF_HANDOFF_SETTINGS,
  MAX_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
  MAX_SUBAGENT_HANDOFF_TOKENS,
  MAX_SUBAGENT_HANDOFF_TOOL_CALLS,
  MIN_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
  MIN_SUBAGENT_HANDOFF_TOKENS,
  MIN_SUBAGENT_HANDOFF_TOOL_CALLS,
  SUBAGENT_HANDOFF_TOKENS_PER_K,
  isSubagentSelfHandoffSettings,
  normalizeSubagentSelfHandoffSettings,
  subagentHandoffKTokensToTokens,
  subagentHandoffMinutesToSeconds,
  subagentHandoffSecondsToMinutes,
  subagentHandoffTokensToKTokens,
  subagentSelfHandoffBounds,
  subagentSelfHandoffEnabled,
} from "./subagent-handoff.js";
import {
  DEFAULT_SUBAGENT_WAKEUP_CONTEXT_TOKENS,
  DEFAULT_SUBAGENT_WAKEUP_SETTINGS,
  DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS,
  DEFAULT_SUBAGENT_WAKEUP_TOOL_CALLS,
  normalizeSubagentWakeupSettings,
} from "./subagent-wakeup.js";

describe("normalizeSubagentSelfHandoffSettings", () => {
  it("defaults to off, so every settings document written before this feature reads as disabled", () => {
    expect(normalizeSubagentSelfHandoffSettings(undefined)).toEqual({ kind: "off" });
    expect(normalizeSubagentSelfHandoffSettings(null)).toEqual({ kind: "off" });
    expect(normalizeSubagentSelfHandoffSettings({} as never)).toEqual({ kind: "off" });
    expect(DEFAULT_SUBAGENT_SELF_HANDOFF_SETTINGS).toEqual({ kind: "off" });
  });

  it("keeps the four triggers exclusive and off value-free", () => {
    expect(normalizeSubagentSelfHandoffSettings({ kind: "off" })).toEqual({
      kind: "off",
    });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "off", value: 5 } as never),
    ).toEqual({ kind: "off" });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "context-tokens", value: 30_000 }),
    ).toEqual({ kind: "context-tokens", value: 30_000 });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "tool-calls", value: 4 }),
    ).toEqual({ kind: "tool-calls", value: 4 });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "runtime", value: 600 }),
    ).toEqual({ kind: "runtime", value: 600 });
  });

  it("applies the per-kind remembered default when a value is missing", () => {
    expect(normalizeSubagentSelfHandoffSettings({ kind: "context-tokens" })).toEqual({
      kind: "context-tokens",
      value: DEFAULT_SUBAGENT_HANDOFF_TOKENS,
    });
    expect(normalizeSubagentSelfHandoffSettings({ kind: "tool-calls" })).toEqual({
      kind: "tool-calls",
      value: DEFAULT_SUBAGENT_HANDOFF_TOOL_CALLS,
    });
    expect(normalizeSubagentSelfHandoffSettings({ kind: "runtime" })).toEqual({
      kind: "runtime",
      value: DEFAULT_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
    });
  });

  it("keeps the canonical default figures in both Subagent execution rows", () => {
    // One threshold vocabulary across both rows: 200k tokens, 50 tool calls,
    // 15 minutes. The wake row keeps its enabled kind; self-handoff stays off.
    expect(DEFAULT_SUBAGENT_HANDOFF_TOKENS).toBe(200_000);
    expect(DEFAULT_SUBAGENT_HANDOFF_TOOL_CALLS).toBe(50);
    expect(DEFAULT_SUBAGENT_HANDOFF_RUNTIME_SECONDS).toBe(900);
    expect(DEFAULT_SUBAGENT_WAKEUP_CONTEXT_TOKENS).toBe(200_000);
    expect(DEFAULT_SUBAGENT_WAKEUP_TOOL_CALLS).toBe(50);
    expect(DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS).toBe(900);
    expect(normalizeSubagentSelfHandoffSettings({ kind: "context-tokens" })).toEqual({
      kind: "context-tokens",
      value: 200_000,
    });
    // The wake contract's own documented fallback for an enabled kind with no
    // value stays the product default (periodic time), now 900s.
    expect(normalizeSubagentWakeupSettings({ kind: "context-tokens" })).toEqual({
      kind: "time",
      value: 900,
    });
    expect(DEFAULT_SUBAGENT_SELF_HANDOFF_SETTINGS).toEqual({ kind: "off" });
    expect(DEFAULT_SUBAGENT_WAKEUP_SETTINGS).toEqual({ kind: "time", value: 900 });
  });

  it("keeps saved explicit thresholds instead of rewriting them to the new defaults", () => {
    // A threshold saved before this default change reads back exactly as
    // stored, including counts that are not whole display units.
    expect(normalizeSubagentSelfHandoffSettings({ kind: "context-tokens", value: 50_000 })).toEqual({
      kind: "context-tokens",
      value: 50_000,
    });
    expect(normalizeSubagentSelfHandoffSettings({ kind: "runtime", value: 100 })).toEqual({
      kind: "runtime",
      value: 100,
    });
    expect(normalizeSubagentWakeupSettings({ kind: "time", value: 600 })).toEqual({
      kind: "time",
      value: 600,
    });
    expect(normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 10 })).toEqual({
      kind: "tool-calls",
      value: 10,
    });
  });


  it("clamps finite positive values into each kind's bounds", () => {
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "context-tokens", value: 1 }),
    ).toEqual({ kind: "context-tokens", value: MIN_SUBAGENT_HANDOFF_TOKENS });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "context-tokens", value: 9_000_000 }),
    ).toEqual({ kind: "context-tokens", value: MAX_SUBAGENT_HANDOFF_TOKENS });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "tool-calls", value: 0.4 }),
    ).toEqual({ kind: "tool-calls", value: DEFAULT_SUBAGENT_HANDOFF_TOOL_CALLS });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "tool-calls", value: 999_999 }),
    ).toEqual({ kind: "tool-calls", value: MAX_SUBAGENT_HANDOFF_TOOL_CALLS });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "runtime", value: 5 }),
    ).toEqual({ kind: "runtime", value: MIN_SUBAGENT_HANDOFF_RUNTIME_SECONDS });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "runtime", value: 10_000_000 }),
    ).toEqual({ kind: "runtime", value: MAX_SUBAGENT_HANDOFF_RUNTIME_SECONDS });
  });

  it("falls back to off for an unknown kind, a mistyped value, or a non-finite value", () => {
    expect(normalizeSubagentSelfHandoffSettings({ kind: "soon" } as never)).toEqual({
      kind: "off",
    });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "context-tokens", value: "lots" } as never),
    ).toEqual({
      kind: "context-tokens",
      value: DEFAULT_SUBAGENT_HANDOFF_TOKENS,
    });
    expect(
      normalizeSubagentSelfHandoffSettings({
        kind: "context-tokens",
        value: Number.NaN,
      }),
    ).toEqual({ kind: "context-tokens", value: DEFAULT_SUBAGENT_HANDOFF_TOKENS });
    expect(normalizeSubagentSelfHandoffSettings([] as never)).toEqual({ kind: "off" });
  });

  it("never normalizes a legacy wake section into a handoff trigger", () => {
    // A wake section written by an older release is a different key; if it ever
    // arrives here it must not switch the feature on.
    expect(
      normalizeSubagentSelfHandoffSettings({
        kind: "time",
        value: 600,
        timeSeconds: 600,
      } as never),
    ).toEqual({ kind: "off" });
  });
});

describe("subagentSelfHandoffBounds", () => {
  it("describes every enabled trigger in its stored unit", () => {
    expect(subagentSelfHandoffBounds("context-tokens")).toEqual([
      MIN_SUBAGENT_HANDOFF_TOKENS,
      MAX_SUBAGENT_HANDOFF_TOKENS,
    ]);
    expect(subagentSelfHandoffBounds("tool-calls")).toEqual([
      MIN_SUBAGENT_HANDOFF_TOOL_CALLS,
      MAX_SUBAGENT_HANDOFF_TOOL_CALLS,
    ]);
    expect(subagentSelfHandoffBounds("runtime")).toEqual([
      MIN_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
      MAX_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
    ]);
    expect(subagentSelfHandoffBounds("off")).toBeNull();
  });
});

describe("isSubagentSelfHandoffSettings", () => {
  it("accepts canonical shapes and rejects mistyped values at the boundary", () => {
    expect(isSubagentSelfHandoffSettings({ kind: "off" })).toBe(true);
    expect(isSubagentSelfHandoffSettings({ kind: "tool-calls" })).toBe(true);
    expect(isSubagentSelfHandoffSettings({ kind: "tool-calls", value: 3 })).toBe(true);
    // Out-of-range still lands and reads back clamped.
    expect(isSubagentSelfHandoffSettings({ kind: "runtime", value: 99_999 })).toBe(true);
    expect(isSubagentSelfHandoffSettings({ kind: "runtime", value: "9" })).toBe(false);
    expect(isSubagentSelfHandoffSettings({ kind: "runtime", value: Number.POSITIVE_INFINITY })).toBe(
      false,
    );
    expect(isSubagentSelfHandoffSettings({ kind: "off", value: 1 })).toBe(false);
    expect(isSubagentSelfHandoffSettings({ kind: "sometimes" })).toBe(false);
    expect(isSubagentSelfHandoffSettings(undefined)).toBe(false);
    expect(isSubagentSelfHandoffSettings([])).toBe(false);
  });
});

describe("display-unit conversions", () => {
  it("converts context thresholds between tokens and k tokens", () => {
    expect(SUBAGENT_HANDOFF_TOKENS_PER_K).toBe(1_000);
    expect(subagentHandoffTokensToKTokens(50_000)).toBe(50);
    expect(subagentHandoffKTokensToTokens(50)).toBe(50_000);
    expect(subagentHandoffKTokensToTokens(1)).toBe(MIN_SUBAGENT_HANDOFF_TOKENS);
    expect(subagentHandoffTokensToKTokens(MAX_SUBAGENT_HANDOFF_TOKENS)).toBe(1_000);
  });

  it("converts runtime thresholds between seconds and minutes", () => {
    expect(subagentHandoffMinutesToSeconds(15)).toBe(
      DEFAULT_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
    );
    expect(subagentHandoffSecondsToMinutes(DEFAULT_SUBAGENT_HANDOFF_RUNTIME_SECONDS)).toBe(15);
    expect(subagentHandoffSecondsToMinutes(MAX_SUBAGENT_HANDOFF_RUNTIME_SECONDS)).toBe(300);
  });

  it("round-trips a UI-edited value back to the stored unit", () => {
    for (const minutes of [1, 15, 240, 300]) {
      expect(
        subagentHandoffSecondsToMinutes(
          subagentHandoffMinutesToSeconds(minutes),
        ),
      ).toBe(minutes);
    }
    for (const k of [1, 50, 1_000]) {
      expect(
        subagentHandoffTokensToKTokens(subagentHandoffKTokensToTokens(k)),
      ).toBe(k);
    }
  });
});

describe("subagentSelfHandoffEnabled", () => {
  it("is true only for a selected trigger", () => {
    expect(subagentSelfHandoffEnabled({ kind: "off" })).toBe(false);
    expect(subagentSelfHandoffEnabled(undefined)).toBe(false);
    expect(subagentSelfHandoffEnabled({ kind: "runtime" })).toBe(true);
  });
});

describe("self-handoff runtime ceiling", () => {
  it("accepts a 300-minute runtime and clamps above it", () => {
    // The user-set ceiling is 300 minutes; the 15-minute remembered default
    // and the 60-second floor are unchanged.
    expect(MAX_SUBAGENT_HANDOFF_RUNTIME_SECONDS).toBe(18_000);
    expect(DEFAULT_SUBAGENT_HANDOFF_RUNTIME_SECONDS).toBe(900);
    expect(MIN_SUBAGENT_HANDOFF_RUNTIME_SECONDS).toBe(60);
    expect(subagentSelfHandoffBounds("runtime")).toEqual([
      MIN_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
      MAX_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
    ]);
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "runtime", value: 18_000 }),
    ).toEqual({ kind: "runtime", value: 18_000 });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "runtime", value: 17_999 }),
    ).toEqual({ kind: "runtime", value: 17_999 });
    expect(
      normalizeSubagentSelfHandoffSettings({ kind: "runtime", value: 18_001 }),
    ).toEqual({ kind: "runtime", value: 18_000 });
    // The other triggers keep their own ceilings.
    expect(subagentSelfHandoffBounds("tool-calls")).toEqual([1, 10_000]);
    expect(subagentSelfHandoffBounds("context-tokens")).toEqual([1_000, 1_000_000]);
  });
});
