/**
 * Program delegation coordinator (step 1 helper): the selected session
 * wakeup `{kind, value}` exclusively owns timing. Per-call legacy controls
 * (`timeoutSeconds`, per-call `subagentWakeup`) have no parameter here and
 * are structurally ignored. One global time checkpoint is shared across
 * explicit wait / TaskList / idle; completion always wins; delivery marks
 * only the explicitly included settled records.
 */
import { describe, expect, it, vi } from "vitest";
import { normalizeSubagentWakeupSettings } from "@pi-desktop/shared";
import { createSubagentWakeState } from "./subagent-wakeup.js";
import {
  createDelegationCoordinator,
  markProgramDelivery,
  type CoordinatorRecord,
} from "./delegation-coordinator.js";

function record(
  id: string,
  overrides: Partial<CoordinatorRecord> = {},
): CoordinatorRecord {
  return {
    delegationId: id,
    status: "running",
    toolCalls: 0,
    delivery: "parent",
    wake: createSubagentWakeState(0),
    ...overrides,
  };
}

function registry() {
  const listeners = new Set<() => void>();
  return {
    listeners,
    register: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("delegation coordinator time cadence (selected wake only)", () => {
  it("time900: 60s quiet, 900s progress wake", async () => {
    vi.useFakeTimers();
    try {
      const now0 = Date.now();
      const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const plan = coordinator.planProgramWait({});
      expect(plan.wake).toEqual({ kind: "time", value: 900 });
      expect(plan.deadlineKind).toBe("time");
      expect(plan.periodBound).toBe(true);
      expect(plan.deadline).toBe(now0 + 900_000);
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 900_000);

      const waits = registry();
      const pending = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      let settled: unknown = null;
      void pending.then((outcome) => {
        settled = outcome;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
      // Only the selected 900s period owns the wake: nothing at 60s.
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(840_000);
      const outcome = await pending;
      expect(outcome.timedOut).toBe(true);
      expect(outcome.deadlineKind).toBe("time");
      // Granted wake advances the anchored checkpoint by one period.
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 1_800_000);
      expect(waits.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("off never progresses on time alone", async () => {
    vi.useFakeTimers();
    try {
      const off = normalizeSubagentWakeupSettings({ kind: "off" });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...off }),
        getRecords: () => records,
      });
      const plan = coordinator.planProgramWait({});
      expect(plan.deadline).toBeNull();
      expect(plan.deadlineKind).toBeNull();
      const waits = registry();
      const pending = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      let settled: unknown = null;
      void pending.then((outcome) => {
        settled = outcome;
      });
      await vi.advanceTimersByTimeAsync(900_000);
      await Promise.resolve();
      expect(settled).toBeNull();
      // Settlement still converges with completion priority.
      records[0].status = "completed";
      waits.notify();
      await expect(pending).resolves.toMatchObject({
        timedOut: false,
        wakeReason: "completion",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("delegation coordinator shared checkpoint across wait/list/idle", () => {
  it("wait -> TaskList gate -> idle reuses the checkpoint (no restart, no shorten)", () => {
    const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
    const records = [record("a"), record("b")];
    let now = 1_000_000;
    const coordinator = createDelegationCoordinator({
      getSelectedWake: () => ({ ...selected }),
      getRecords: () => records,
      now: () => now,
    });
    const first = coordinator.planProgramWait({});
    expect(first.deadline).toBe(1_000_000 + 900_000);
    // TaskList gating only selects; it never touches the checkpoint.
    const listed = coordinator.selectProgramTargets({});
    expect(listed.map((entry) => entry.delegationId).sort()).toEqual(["a", "b"]);
    expect(coordinator.peekPolicyDeadline()).toBe(first.deadline);
    // A later query (subset, idle-style) reuses it instead of restarting.
    now = 1_060_000;
    const second = coordinator.planProgramWait({ ids: ["a"] });
    expect(second.deadline).toBe(first.deadline);
    expect(second.deadline).toBeGreaterThan(now);
    // Not shortened to now + period.
    expect(second.deadline).toBeLessThan(now + 900_000);
    // Subset convergence still shares the global cadence.
    now = 1_120_000;
    const third = coordinator.planProgramWait({ mode: "any", minCompleted: 1 });
    expect(third.deadline).toBe(first.deadline);
  });

  it("no expected delegates disarms the checkpoint", () => {
    const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 60 });
    const records = [record("a")];
    let now = 5_000_000;
    const coordinator = createDelegationCoordinator({
      getSelectedWake: () => ({ ...selected }),
      getRecords: () => records,
      now: () => now,
    });
    expect(coordinator.planProgramWait({}).deadline).toBe(5_000_000 + 60_000);
    records[0].status = "completed";
    now = 5_010_000;
    expect(coordinator.planProgramWait({}).deadline).toBeNull();
    expect(coordinator.peekPolicyDeadline()).toBeNull();
  });
});

describe("delegation coordinator thresholds share record watermarks", () => {
  it("tool-calls fires once per N and never repeats without new progress", async () => {
    const selected = normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 2 });
    const records = [record("d")];
    const coordinator = createDelegationCoordinator({
      getSelectedWake: () => ({ ...selected }),
      getRecords: () => records,
    });
    // Below the threshold: quiet.
    expect(coordinator.pollProgramWake({})).toBeUndefined();
    records[0].toolCalls = 2;
    const waits = registry();
    const pending = coordinator.waitForProgramTargets({}, {
      registerWakeWaiter: waits.register,
    });
    waits.notify();
    await expect(pending).resolves.toMatchObject({
      timedOut: false,
      wakeReason: "tool-calls",
      wakeDelegationIds: ["d"],
    });
    // Same state again: watermark advanced on the same record object.
    expect(coordinator.pollProgramWake({})).toBeUndefined();
    records[0].toolCalls = 3;
    expect(coordinator.pollProgramWake({})).toBeUndefined();
    records[0].toolCalls = 4;
    expect(coordinator.pollProgramWake({})).toMatchObject({
      reason: "tool-calls",
      delegationIds: ["d"],
    });
  });

  it("context-tokens crosses once, disarms above, rearms below", () => {
    const selected = normalizeSubagentWakeupSettings({
      kind: "context-tokens",
      value: 10_000,
    });
    const records = [record("d", { contextTokens: 9_000 })];
    const coordinator = createDelegationCoordinator({
      getSelectedWake: () => ({ ...selected }),
      getRecords: () => records,
    });
    expect(coordinator.pollProgramWake({})).toBeUndefined();
    records[0].contextTokens = 11_000;
    expect(coordinator.pollProgramWake({})).toMatchObject({ reason: "context-tokens" });
    expect(coordinator.pollProgramWake({})).toBeUndefined();
    records[0].contextTokens = 5_000;
    expect(coordinator.pollProgramWake({})).toBeUndefined();
    records[0].contextTokens = 10_500;
    expect(coordinator.pollProgramWake({})).toMatchObject({ reason: "context-tokens" });
  });

  it("subset any/min shares cadence while converging on a subset", async () => {
    vi.useFakeTimers();
    try {
      const now0 = Date.now();
      const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("a"), record("b")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const full = coordinator.planProgramWait({});
      const subset = coordinator.planProgramWait({ mode: "any", minCompleted: 1, ids: ["a"] });
      expect(subset.deadline).toBe(full.deadline);
      expect(subset.deadline).toBe(now0 + 900_000);
      const waits = registry();
      const pending = coordinator.waitForProgramTargets(
        { mode: "any", minCompleted: 1, ids: ["a"] },
        { registerWakeWaiter: waits.register },
      );
      records[0].status = "completed";
      waits.notify();
      await expect(pending).resolves.toMatchObject({
        wakeReason: "completion",
        wakeDelegationIds: ["a"],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("delegation coordinator completion and delivery marking", () => {
  it("completion wins over thresholds and observing never consumes delivery", async () => {
    const tools = normalizeSubagentWakeupSettings({ kind: "tool-calls", value: 2 });
    const records = [
      record("a", { toolCalls: 5 }),
      record("b", { status: "completed" }),
    ];
    const coordinator = createDelegationCoordinator({
      getSelectedWake: () => ({ ...tools }),
      getRecords: () => records,
    });
    // Completion priority even though "a" also crossed its threshold
    // (subset convergence: one settle suffices).
    expect(coordinator.pollProgramWake({ mode: "any", minCompleted: 1 })).toMatchObject({
      reason: "completion",
      delegationIds: ["b"],
    });
    // Gating/observing (TaskList path) leaves delivery untouched.
    coordinator.selectProgramTargets({});
    coordinator.pollProgramWake({});
    expect(records[0].reportDelivered).toBeUndefined();
    expect(records[1].reportDelivered).toBeUndefined();
    // Only the explicitly included settled record marks; omitted stays pending.
    const marked = markProgramDelivery(records, new Set(["b"]));
    expect(marked).toEqual(["b"]);
    expect(records[1].reportDelivered).toBe(true);
    expect(records[0].reportDelivered).toBeUndefined();
    // Marking again is a no-op (exactly once).
    expect(markProgramDelivery(records, new Set(["a", "b"]))).toEqual([]);
  });

  it("user-owned runs are never expected, waited on, or marked", () => {
    const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 60 });
    const records = [
      record("mine", { delivery: "user", status: "completed" }),
      record("parent", { status: "completed" }),
    ];
    const coordinator = createDelegationCoordinator({
      getSelectedWake: () => ({ ...selected }),
      getRecords: () => records,
    });
    expect(
      coordinator.selectProgramTargets({}).map((entry) => entry.delegationId),
    ).toEqual(["parent"]);
    expect(
      coordinator.selectProgramTargets({ ids: ["mine"] }),
    ).toEqual([]);
    const marked = markProgramDelivery(records, new Set(["mine", "parent"]));
    expect(marked).toEqual(["parent"]);
    expect(records[0].reportDelivered).toBeUndefined();
  });
});

describe("delegation coordinator live config rebind", () => {
  it("time change rebases at update; unrelated edits never resolve a wait alone", async () => {
    vi.useFakeTimers();
    try {
      let selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const startNow = Date.now();
      const first = coordinator.planProgramWait({});
      expect(first.deadline).toBe(startNow + 900_000);

      // Live edit to a shorter period rebases at update time (documented):
      // shift the fake clock forward first (no wait holds a timer yet), then
      // apply the update so the rebase anchors at the new now.
      vi.setSystemTime(startNow + 100_000);
      selected = normalizeSubagentWakeupSettings({ kind: "time", value: 60 });
      coordinator.handleSelectedWakeUpdate();
      expect(coordinator.peekPolicyDeadline()).toBe(startNow + 100_000 + 60_000);

      // A wait that starts after the update reuses the rebased checkpoint
      // (never restarts/shortens it) and does not resolve on the config
      // change alone.
      const waits = registry();
      const pending = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      let settled: unknown = null;
      void pending.then((outcome) => {
        settled = outcome;
      });
      await Promise.resolve();
      // Same-kind unrelated notification: re-evaluate, still quiet.
      waits.notify();
      await Promise.resolve();
      expect(settled).toBeNull();
      // The rebased period still bounds the wait.
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toMatchObject({
        timedOut: true,
        deadlineKind: "time",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaving time disarms without resolving the wait", async () => {
    vi.useFakeTimers();
    try {
      let selected = normalizeSubagentWakeupSettings({ kind: "time", value: 60 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const waits = registry();
      const pending = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      let settled: unknown = null;
      void pending.then((outcome) => {
        settled = outcome;
      });
      await Promise.resolve();
      selected = normalizeSubagentWakeupSettings({ kind: "off" });
      coordinator.handleSelectedWakeUpdate();
      expect(coordinator.peekPolicyDeadline()).toBeNull();
      waits.notify();
      await Promise.resolve();
      expect(settled).toBeNull();
      records[0].status = "completed";
      waits.notify();
      await expect(pending).resolves.toMatchObject({ wakeReason: "completion" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("delegation coordinator timer ownership", () => {
  it("actual timers cancel on wait exit while the policy value persists", async () => {
    vi.useFakeTimers();
    try {
      const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const waits = registry();
      const pending = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      expect(vi.getTimerCount()).toBe(1);
      records[0].status = "completed";
      waits.notify();
      await expect(pending).resolves.toMatchObject({ wakeReason: "completion" });
      // No live timer remains, and with nothing running the policy disarms.
      expect(vi.getTimerCount()).toBe(0);
      expect(coordinator.peekPolicyDeadline()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort stops the wait and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const now0 = Date.now();
      const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const controller = new AbortController();
      const pending = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: () => () => undefined,
        signal: controller.signal,
      });
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      await expect(pending).resolves.toMatchObject({
        interrupted: true,
        timedOut: true,
        deadlineKind: null,
      });
      expect(vi.getTimerCount()).toBe(0);
      // Interruption is not a granted deadline: the cadence is untouched.
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 900_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("delegation coordinator cadence only advances on a fired deadline", () => {
  it("steering before the deadline keeps the anchor: later resume still wakes at the original deadline", async () => {
    vi.useFakeTimers();
    try {
      const now0 = Date.now();
      const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const waits = registry();
      const controller = new AbortController();
      const pending = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
        signal: controller.signal,
      });
      // User steering arrives at t=60s of a 900s period.
      await vi.advanceTimersByTimeAsync(60_000);
      controller.abort();
      await pending;
      // The anchor stays at 900, not 900 + period.
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 900_000);
      // A later wait at t=100 resumes at the original deadline.
      await vi.advanceTimersByTimeAsync(40_000);
      expect(coordinator.planProgramWait({}).deadline).toBe(now0 + 900_000);
      expect(coordinator.peekPolicyDeadline()).not.toBe(now0 + 1_800_000);
      // It actually wakes at the original 900s deadline, then advances once.
      const resumed = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      await vi.advanceTimersByTimeAsync(800_000);
      await expect(resumed).resolves.toMatchObject({
        timedOut: true,
        deadlineKind: "time",
      });
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 1_800_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pre-aborted signal grants no wake, arms no timer, and never advances", async () => {
    vi.useFakeTimers();
    try {
      const now0 = Date.now();
      const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const controller = new AbortController();
      controller.abort();
      const outcome = await coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: () => () => undefined,
        signal: controller.signal,
      });
      expect(outcome).toMatchObject({
        interrupted: true,
        timedOut: true,
        deadlineKind: null,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 900_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("two waiters on one deadline advance the shared cadence once (not twice)", async () => {
    vi.useFakeTimers();
    try {
      const now0 = Date.now();
      const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const first = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: registry().register,
      });
      const second = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: registry().register,
      });
      await vi.advanceTimersByTimeAsync(900_000);
      const [a, b] = await Promise.all([first, second]);
      expect(a.timedOut).toBe(true);
      expect(b.timedOut).toBe(true);
      // Both observed the same deadline; the next cadence is 1800, not 2700.
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 1_800_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a live period change is never overwritten by an obsolete pending deadline", async () => {
    vi.useFakeTimers();
    try {
      const now0 = Date.now();
      let selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const waits = registry();
      const pending = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      // Change the period while the old timer is still pending (no re-notify,
      // so the obsolete 900s timer is the one that fires).
      await vi.advanceTimersByTimeAsync(60_000);
      selected = normalizeSubagentWakeupSettings({ kind: "time", value: 60 });
      coordinator.handleSelectedWakeUpdate();
      const rebased = now0 + 60_000 + 60_000;
      expect(coordinator.peekPolicyDeadline()).toBe(rebased);
      await vi.advanceTimersByTimeAsync(840_000);
      await pending;
      // The obsolete fired deadline did not advance the rebased policy.
      expect(coordinator.peekPolicyDeadline()).toBe(rebased);
      expect(coordinator.peekPolicyDeadline()).not.toBe(now0 + 1_800_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a notified live rebase advances from the fired rebased deadline, and the next wait is not immediate", async () => {
    vi.useFakeTimers();
    try {
      const now0 = Date.now();
      let selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const waits = registry();
      const pending = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      // t=60s: shorten the period to 300s and notify, so the live waiter
      // actually re-arms its timer at the rebased deadline (t=360s).
      await vi.advanceTimersByTimeAsync(60_000);
      selected = normalizeSubagentWakeupSettings({ kind: "time", value: 300 });
      coordinator.handleSelectedWakeUpdate();
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 360_000);
      waits.notify();
      await Promise.resolve();

      // Quiet right up to the rebased deadline, which is where it wakes.
      await vi.advanceTimersByTimeAsync(299_000);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      const outcome = await pending;
      expect(outcome.timedOut).toBe(true);
      expect(outcome.deadlineKind).toBe("time");
      expect(outcome.firedDeadline).toBe(now0 + 360_000);
      // Exactly one advance, from the deadline the timer actually fired on.
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 660_000);

      // The next wait at t=360s must not resolve immediately: it waits the
      // remaining period, not a deadline that already elapsed.
      const next = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      let nextSettled = false;
      void next.then(() => {
        nextSettled = true;
      });
      await Promise.resolve();
      expect(nextSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(299_000);
      await Promise.resolve();
      expect(nextSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(next).resolves.toMatchObject({ timedOut: true, deadlineKind: "time" });
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 960_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("concurrent observers of one rebased deadline advance the shared cadence once", async () => {
    vi.useFakeTimers();
    try {
      const now0 = Date.now();
      let selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const waits = registry();
      const first = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      const second = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      // Rebase both live waiters onto the same shorter deadline.
      await vi.advanceTimersByTimeAsync(60_000);
      selected = normalizeSubagentWakeupSettings({ kind: "time", value: 300 });
      coordinator.handleSelectedWakeUpdate();
      waits.notify();
      await vi.advanceTimersByTimeAsync(300_000);
      const [a, b] = await Promise.all([first, second]);
      expect(a.firedDeadline).toBe(now0 + 360_000);
      expect(b.firedDeadline).toBe(now0 + 360_000);
      // Both fired on the same rebased deadline; it advances once, not twice.
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 660_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("completion at the deadline boundary wins and marks delivery once", async () => {
    vi.useFakeTimers();
    try {
      const now0 = Date.now();
      const selected = normalizeSubagentWakeupSettings({ kind: "time", value: 900 });
      const records = [record("a"), record("b")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...selected }),
        getRecords: () => records,
      });
      const waits = registry();
      const pending = coordinator.waitForProgramTargets(
        { mode: "any", minCompleted: 1 },
        { registerWakeWaiter: waits.register },
      );
      await vi.advanceTimersByTimeAsync(899_999);
      records[0].status = "completed";
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await pending;
      expect(outcome.timedOut).toBe(false);
      expect(outcome.wakeReason).toBe("completion");
      expect(outcome.wakeDelegationIds).toEqual(["a"]);
      // A settle never consumes the time cadence; b still runs so it stays.
      expect(coordinator.peekPolicyDeadline()).toBe(now0 + 900_000);
      // Delivery marks the settled report exactly once.
      expect(markProgramDelivery(records, new Set(outcome.wakeDelegationIds))).toEqual(["a"]);
      expect(markProgramDelivery(records, new Set(["a"]))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("off arms no timer and grants no cadence", async () => {
    vi.useFakeTimers();
    try {
      const off = normalizeSubagentWakeupSettings({ kind: "off" });
      const records = [record("d")];
      const coordinator = createDelegationCoordinator({
        getSelectedWake: () => ({ ...off }),
        getRecords: () => records,
      });
      const waits = registry();
      const pending = coordinator.waitForProgramTargets({}, {
        registerWakeWaiter: waits.register,
      });
      expect(vi.getTimerCount()).toBe(0);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(settled).toBe(false);
      expect(coordinator.peekPolicyDeadline()).toBeNull();
      records[0].status = "completed";
      waits.notify();
      await expect(pending).resolves.toMatchObject({ wakeReason: "completion" });
    } finally {
      vi.useRealTimers();
    }
  });
});
