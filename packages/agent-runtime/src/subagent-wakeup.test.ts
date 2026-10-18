/**
 * Wake evaluation is pure: snapshots in, at most one wake out, watermarks
 * advanced on the record-owned state objects. These tests pin the no-spin
 * contract — a re-evaluation over unchanged state never fires twice — and
 * the exclusivity contract: one progress kind at a time, completion always.
 */
import { describe, expect, it, vi } from "vitest";
import { normalizeSubagentWakeupSettings } from "@pi-desktop/shared";
import {
  createSubagentWakeState,
  evaluateSubagentWake,
  waitForWakeTargets,
  type SubagentWakeTarget,
  type WakeWaitOutcome,
} from "./subagent-wakeup.js";

function target(
  overrides: Partial<SubagentWakeTarget> = {},
): SubagentWakeTarget {
  return {
    delegationId: "del-1",
    status: "running",
    toolCalls: 0,
    ...overrides,
  };
}

describe("evaluateSubagentWake completion", () => {
  it("wakes when every target settled in all mode", () => {
    const states = new Map();
    const wake = normalizeSubagentWakeupSettings(undefined);
    expect(
      evaluateSubagentWake(
        [target({ status: "completed" })],
        wake,
        states,
        { mode: "all", minCompleted: 1 },
      ),
    ).toEqual({ reason: "completion", delegationIds: ["del-1"] });
  });

  it("stays quiet while targets still run", () => {
    expect(
      evaluateSubagentWake([target()], normalizeSubagentWakeupSettings(undefined), new Map(), {
        mode: "all",
        minCompleted: 1,
      }),
    ).toBeUndefined();
  });

  it("always delivers completion even when progress is off", () => {
    const settled = target({ delegationId: "a", status: "completed" });
    const wake = normalizeSubagentWakeupSettings({ kind: "off" });
    // Progress off never wakes on running work, but settlement converges.
    expect(
      evaluateSubagentWake([settled], wake, new Map(), { mode: "all", minCompleted: 1 }),
    ).toEqual({ reason: "completion", delegationIds: ["a"] });
    // Enabled completion with minCompleted converges on the first settle.
    const running = target({ delegationId: "b" });
    expect(
      evaluateSubagentWake([settled, running], wake, new Map(), {
        mode: "any",
        minCompleted: 1,
      }),
    ).toEqual({ reason: "completion", delegationIds: ["a"] });
  });

  it("treats legacy onCompletion:false as mandatory delivery", () => {
    const settled = target({ delegationId: "a", status: "completed" });
    const wake = normalizeSubagentWakeupSettings({ onCompletion: false } as never);
    expect(
      evaluateSubagentWake([settled], wake, new Map(), { mode: "all", minCompleted: 1 }),
    ).toEqual({ reason: "completion", delegationIds: ["a"] });
  });
});

describe("evaluateSubagentWake exclusivity", () => {
  it("runs only the selected progress kind", () => {
    const options = { mode: "all" as const, minCompleted: 1 };
    // A tool-calls selection ignores context occupancy.
    const tools = normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 2 });
    const toolStates = new Map([["del-1", createSubagentWakeState(0)]]);
    expect(
      evaluateSubagentWake(
        [target({ toolCalls: 0, contextTokens: 500_000 })],
        tools,
        toolStates,
        options,
      ),
    ).toBeUndefined();
    // A context selection ignores tool-call counts.
    const context = normalizeSubagentWakeupSettings({
      kind: "context-tokens",
      value: 10_000,
    });
    expect(
      evaluateSubagentWake(
        [target({ toolCalls: 99, contextTokens: 5_000 })],
        context,
        new Map([["del-1", createSubagentWakeState(99)]]),
        options,
      ),
    ).toBeUndefined();
    // Off and time never fire threshold wakes here (time is a deadline).
    for (const kind of ["off", "time"] as const) {
      const wake =
        kind === "off"
          ? normalizeSubagentWakeupSettings({ kind: "off" })
          : normalizeSubagentWakeupSettings({ kind: "time", value: 600 });
      expect(
        evaluateSubagentWake(
          [target({ toolCalls: 99, contextTokens: 500_000 })],
          wake,
          new Map([["del-1", createSubagentWakeState(0)]]),
          options,
        ),
      ).toBeUndefined();
    }
  });
});

describe("evaluateSubagentWake tool calls", () => {
  it("fires once per additional N calls and never spins", () => {
    const wake = normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 3 });
    const states = new Map([["del-1", createSubagentWakeState(0)]]);
    const options = { mode: "all" as const, minCompleted: 1 };
    expect(
      evaluateSubagentWake([target({ toolCalls: 2 })], wake, states, options),
    ).toBeUndefined();
    expect(
      evaluateSubagentWake([target({ toolCalls: 3 })], wake, states, options),
    ).toEqual({ reason: "tool-calls", delegationIds: ["del-1"] });
    // Same state again: the watermark advanced, so no second wake.
    expect(
      evaluateSubagentWake([target({ toolCalls: 3 })], wake, states, options),
    ).toBeUndefined();
    expect(
      evaluateSubagentWake([target({ toolCalls: 5 })], wake, states, options),
    ).toBeUndefined();
    expect(
      evaluateSubagentWake([target({ toolCalls: 6 })], wake, states, options),
    ).toEqual({ reason: "tool-calls", delegationIds: ["del-1"] });
  });

  it("names only the delegates that crossed", () => {
    const wake = normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 2 });
    const states = new Map([
      ["a", createSubagentWakeState(0)],
      ["b", createSubagentWakeState(0)],
    ]);
    expect(
      evaluateSubagentWake(
        [target({ delegationId: "a", toolCalls: 2 }), target({ delegationId: "b", toolCalls: 1 })],
        wake,
        states,
        { mode: "all", minCompleted: 2 },
      ),
    ).toEqual({ reason: "tool-calls", delegationIds: ["a"] });
  });

  it("still reports completion for settled targets", () => {
    const wake = normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 1 });
    expect(
      evaluateSubagentWake(
        [target({ status: "completed", toolCalls: 99 })],
        wake,
        new Map(),
        { mode: "all", minCompleted: 1 },
      ),
    ).toEqual({ reason: "completion", delegationIds: ["del-1"] });
  });
});

describe("evaluateSubagentWake context tokens", () => {
  it("fires on upward crossing only and rearms below the threshold", () => {
    const wake = normalizeSubagentWakeupSettings({ kind: "context-tokens", value: 10_000 });
    const states = new Map([["del-1", createSubagentWakeState(0)]]);
    const options = { mode: "all" as const, minCompleted: 1 };
    expect(
      evaluateSubagentWake([target({ contextTokens: 9_000 })], wake, states, options),
    ).toBeUndefined();
    expect(
      evaluateSubagentWake([target({ contextTokens: 11_000 })], wake, states, options),
    ).toEqual({ reason: "context-tokens", delegationIds: ["del-1"] });
    // Still above, disarmed: no repeated wake.
    expect(
      evaluateSubagentWake([target({ contextTokens: 12_000 })], wake, states, options),
    ).toBeUndefined();
    // Drop below rearms silently (compaction/degradation recovery).
    expect(
      evaluateSubagentWake([target({ contextTokens: 5_000 })], wake, states, options),
    ).toBeUndefined();
    // Growing past again wakes once more.
    expect(
      evaluateSubagentWake([target({ contextTokens: 10_500 })], wake, states, options),
    ).toEqual({ reason: "context-tokens", delegationIds: ["del-1"] });
  });

  it("skips targets that never reported occupancy", () => {
    const wake = normalizeSubagentWakeupSettings({ kind: "context-tokens", value: 10_000 });
    expect(
      evaluateSubagentWake([target()], wake, new Map(), { mode: "all", minCompleted: 1 }),
    ).toBeUndefined();
  });
});

describe("waitForWakeTargets", () => {
  it("resolves with no children and no timers", async () => {
    const listeners = new Set<() => void>();
    vi.useFakeTimers();
    try {
      const outcome = await waitForWakeTargets(
        () => [],
        new Map(),
        [],
        (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        {
          mode: "all",
          minCompleted: 0,
          wake: normalizeSubagentWakeupSettings(undefined),
          deadline: null,
          deadlineKind: null,
        },
      );
      expect(outcome.timedOut).toBe(false);
      expect(outcome.wakeReason).toBeUndefined();
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes on threshold progress through registered listeners, without polling", async () => {
    const mutable = { delegationId: "d", status: "running", toolCalls: 0 };
    const states = new Map([["d", createSubagentWakeState(0)]]);
    let listener!: () => void;
    const pending = waitForWakeTargets(
      () => [{ ...mutable }],
      states,
      [new Promise<void>(() => undefined)],
      (candidate) => {
        listener = candidate;
        return () => undefined;
      },
      {
        mode: "all",
        minCompleted: 1,
        wake: normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 2 }),
        deadline: null,
        deadlineKind: null,
      },
    );
    mutable.toolCalls = 1;
    listener();
    // Below the watermark nothing resolves; at it the wait wakes once.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    mutable.toolCalls = 2;
    listener();
    await expect(pending).resolves.toMatchObject({
      timedOut: false,
      wakeReason: "tool-calls",
      wakeDelegationIds: ["d"],
    });
  });

  it("an explicit deadline still bounds a threshold wait", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForWakeTargets(
        () => [target()],
        new Map([["del-1", createSubagentWakeState(0)]]),
        [new Promise<void>(() => undefined)],
        () => () => undefined,
        {
          mode: "all",
          minCompleted: 1,
          wake: normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 2 }),
          deadline: Date.now() + 1_000,
          deadlineKind: "timeout",
        },
      );
      const assertion = expect(pending).resolves.toMatchObject({
        timedOut: true,
        deadlineKind: "timeout",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes an explicit abort from a fired deadline", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = waitForWakeTargets(
        () => [target()],
        new Map([["del-1", createSubagentWakeState(0)]]),
        [new Promise<void>(() => undefined)],
        () => () => undefined,
        {
          mode: "all",
          minCompleted: 1,
          wake: normalizeSubagentWakeupSettings({ kind: "time", value: 600 }),
          deadline: Date.now() + 600_000,
          deadlineKind: "time",
          signal: controller.signal,
        },
      );
      let settled: WakeWaitOutcome | null = null;
      void pending.then((outcome) => {
        settled = outcome;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBeNull();
      controller.abort();
      // An abort is an explicit interruption: no fired deadline is claimed.
      await expect(pending).resolves.toMatchObject({
        interrupted: true,
        timedOut: true,
        deadlineKind: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the re-armed deadline a live period change actually fired on", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      let wake = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const listeners = new Set<() => void>();
      const pending = waitForWakeTargets(
        () => [target()],
        new Map([["del-1", createSubagentWakeState(0)]]),
        [new Promise<void>(() => undefined)],
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        {
          mode: "all",
          minCompleted: 1,
          wake,
          deadline: start + 900_000,
          deadlineKind: "time",
          live: { getWake: () => ({ ...wake }), periodBound: true },
        },
      );
      // Shorten the period mid-wait and notify so the timer actually re-arms.
      await vi.advanceTimersByTimeAsync(60_000);
      wake = normalizeSubagentWakeupSettings({ kind: "time", value: 300 });
      for (const listener of [...listeners]) listener();
      await vi.advanceTimersByTimeAsync(300_000);
      const outcome = await pending;
      expect(outcome.timedOut).toBe(true);
      expect(outcome.deadlineKind).toBe("time");
      // The fired deadline is the rebased one (start + 60s + 300s), not the
      // stale plan deadline (start + 900s) captured when the wait began.
      expect(outcome.firedDeadline).toBe(start + 360_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits firedDeadline when completion wins at the boundary", async () => {
    vi.useFakeTimers();
    try {
      const mutable = { delegationId: "d", status: "running", toolCalls: 0 };
      const pending = waitForWakeTargets(
        () => [{ ...mutable }],
        new Map([["d", createSubagentWakeState(0)]]),
        [new Promise<void>(() => undefined)],
        () => () => undefined,
        {
          mode: "all",
          minCompleted: 1,
          wake: normalizeSubagentWakeupSettings({ kind: "time", value: 600 }),
          deadline: Date.now() + 1_000,
          deadlineKind: "time",
        },
      );
      await vi.advanceTimersByTimeAsync(999);
      mutable.status = "completed";
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await pending;
      expect(outcome).toMatchObject({ timedOut: false, wakeReason: "completion" });
      expect(outcome.firedDeadline).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits firedDeadline on an explicit abort", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = waitForWakeTargets(
        () => [target()],
        new Map([["del-1", createSubagentWakeState(0)]]),
        [new Promise<void>(() => undefined)],
        () => () => undefined,
        {
          mode: "all",
          minCompleted: 1,
          wake: normalizeSubagentWakeupSettings({ kind: "time", value: 600 }),
          deadline: Date.now() + 600_000,
          deadlineKind: "time",
          signal: controller.signal,
        },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      const outcome = await pending;
      expect(outcome).toMatchObject({ interrupted: true, deadlineKind: null });
      expect(outcome.firedDeadline).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a settle at the deadline boundary as completion, not a timeout", async () => {
    vi.useFakeTimers();
    try {
      const mutable = { delegationId: "d", status: "running", toolCalls: 0 };
      const pending = waitForWakeTargets(
        () => [{ ...mutable }],
        new Map([["d", createSubagentWakeState(0)]]),
        [new Promise<void>(() => undefined)],
        () => () => undefined,
        {
          mode: "all",
          minCompleted: 1,
          wake: normalizeSubagentWakeupSettings({ kind: "time", value: 600 }),
          deadline: Date.now() + 1_000,
          deadlineKind: "time",
        },
      );
      await vi.advanceTimersByTimeAsync(999);
      mutable.status = "completed";
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        timedOut: false,
        wakeReason: "completion",
        wakeDelegationIds: ["d"],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
