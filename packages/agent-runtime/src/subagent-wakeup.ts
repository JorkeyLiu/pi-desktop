/**
 * Wake evaluation for delegation waits (TaskWait and the idle resume).
 *
 * Kept out of `runtime.ts` so the hotspot owns only the call sites: this
 * module decides *whether* a wait wakes, the runtime decides what a wake
 * does. State is per delegation id and lives as long as the wait targets do;
 * the runtime carries it on the delegation record so consecutive waits share
 * watermarks and can never spin on the same progress twice.
 *
 * One exclusive progress kind is active at a time (time / tool-calls /
 * context-tokens / off); completion always wakes and takes precedence.
 */

import type {
  ResolvedSubagentWakeupSettings,
  SubagentWakeReason,
} from "@pi-desktop/shared";
/** The smallest snapshot a wait target exposes for wake evaluation. */
export type SubagentWakeTarget = {
  delegationId: string;
  /** `running` while the delegate works; anything else is settled. */
  status: string;
  toolCalls: number;
  /** Current estimated context occupancy, when the run reported one. */
  contextTokens?: number;
};

/**
 * Per-delegate wake watermarks. `toolCallsNotified` is the call count the
 * last tool-call wake (or wait start) observed; `contextArmed` is false from
 * a wake until occupancy drops back below the threshold.
 */
export type SubagentWakeState = {
  toolCallsNotified: number;
  contextArmed: boolean;
};

export function createSubagentWakeState(
  toolCalls = 0,
): SubagentWakeState {
  return { toolCallsNotified: toolCalls, contextArmed: true };
}

export type SubagentWakeEvaluation = {
  reason: SubagentWakeReason;
  delegationIds: string[];
};

/**
 * Evaluate one wake poll over the current target snapshots.
 *
 * Completion always wins first; then the single selected progress kind
 * (tool calls or context) names only the delegates that actually crossed.
 * Every fire advances its watermark (tool calls) or disarms (context), and
 * a recovered context rearms silently, so waiting again after a wake cannot
 * fire on unchanged state. `time` and `off` never fire here: time is an
 * event deadline owned by the waiter, off waits for completion only.
 */
export function evaluateSubagentWake(
  targets: readonly SubagentWakeTarget[],
  wake: ResolvedSubagentWakeupSettings,
  states: Map<string, SubagentWakeState>,
  options: { mode: "all" | "any"; minCompleted: number },
): SubagentWakeEvaluation | undefined {
  const settled = targets.filter((target) => target.status !== "running");
  if (settled.length > 0) {
    const needed =
      options.mode === "all"
        ? targets.length
        : Math.min(Math.max(options.minCompleted, 1), targets.length);
    if (settled.length >= needed) {
      return {
        reason: "completion",
        delegationIds: settled.map((target) => target.delegationId),
      };
    }
  }
  if (wake.kind === "tool-calls" && typeof wake.value === "number") {
    const crossed: string[] = [];
    for (const target of targets) {
      if (target.status !== "running") continue;
      const state =
        states.get(target.delegationId) ??
        createSubagentWakeState(target.toolCalls);
      states.set(target.delegationId, state);
      if (target.toolCalls - state.toolCallsNotified >= wake.value) {
        state.toolCallsNotified = target.toolCalls;
        crossed.push(target.delegationId);
      }
    }
    if (crossed.length > 0) {
      return { reason: "tool-calls", delegationIds: crossed };
    }
  }
  if (wake.kind === "context-tokens" && typeof wake.value === "number") {
    const crossed: string[] = [];
    for (const target of targets) {
      if (target.status !== "running") continue;
      if (typeof target.contextTokens !== "number") continue;
      const state =
        states.get(target.delegationId) ??
        createSubagentWakeState(target.toolCalls);
      states.set(target.delegationId, state);
      if (state.contextArmed) {
        if (target.contextTokens >= wake.value) {
          state.contextArmed = false;
          crossed.push(target.delegationId);
        }
      } else if (target.contextTokens < wake.value) {
        state.contextArmed = true;
      }
    }
    if (crossed.length > 0) {
      return { reason: "context-tokens", delegationIds: crossed };
    }
  }
  return undefined;
}

export type LiveWakeBinding = {
  getWake: () => ResolvedSubagentWakeupSettings;
  periodBound: boolean;
};
export type WakeWaitOptions = {
  mode: "all" | "any";
  minCompleted: number;
  wake: ResolvedSubagentWakeupSettings;
  deadline: number | null;
  deadlineKind: "timeout" | "time" | null;
  signal?: AbortSignal;
  live?: LiveWakeBinding;
};
export type WakeWaitOutcome = {
  timedOut: boolean;
  deadlineKind: "timeout" | "time" | null;
  /**
   * Set when the wait ended because its caller aborted it (steering, stop,
   * cancel), never because a period elapsed. This is the only outcome that
   * separates an explicit interruption from a fired deadline: both otherwise
   * resolve a time-kind wait with `timedOut`, so a cadence owner must not
   * read a bare `timedOut` as a granted period.
   */
  interrupted?: boolean;
  /**
   * The epoch-ms deadline the local timer actually fired on. Set only by a
   * real timer fire (after completion/threshold observations lose at the
   * boundary); absent for completion, threshold, and interruption outcomes.
   * A cadence owner advances from this value, so a re-armed deadline is used
   * instead of the stale deadline captured when the wait began.
   */
  firedDeadline?: number;
  wakeReason?: SubagentWakeReason;
  wakeDelegationIds: string[];
};

/** The event deadline bound for the selected progress kind, if any. */
export function wakePeriodSeconds(
  wake: ResolvedSubagentWakeupSettings,
): number | null {
  return wake.kind === "time" && typeof wake.value === "number"
    ? wake.value
    : null;
}

/**
 * Resolve once a wake condition fires, the deadline passes, or the calling
 * run aborts. Event-driven: settlement promises and per-activity
 * re-evaluation (via `registerWakeWaiter`) wake it — no polling timer.
 * `deadline` null waits until the selected threshold, settlement, steering,
 * or cancel. With no running targets and no deadline it resolves on the
 * first evaluation, creating no timers at all.
 *
 * `snapshot` reads the current target states on every poll; `states` holds
 * the record-owned watermarks so consecutive waits share them. When `live`
 * is present every poll re-reads the effective wake (session base plus the
 * wait's atomic override), so a settings change notified through the
 * waiter registry re-evaluates without ever resolving on the change alone:
 * only a satisfied threshold, settlement, deadline, steering, or cancel
 * finishes the wait. A period-bound deadline re-arms only when the period
 * value itself changes, never on unrelated edits.
 */
export function waitForWakeTargets(
  snapshot: () => SubagentWakeTarget[],
  states: Map<string, SubagentWakeState>,
  completions: readonly Promise<unknown>[],
  registerWakeWaiter: (listener: () => void) => () => void,
  options: WakeWaitOptions,
): Promise<WakeWaitOutcome> {
  const { mode, minCompleted, wake, deadline: initialDeadline, deadlineKind: initialKind, signal, live } = options;
  const readWake = live ? () => live.getWake() : () => wake;
  const poll = ():
    | { timedOut: false; wakeReason: SubagentWakeReason; wakeDelegationIds: string[] }
    | { settled: true }
    | undefined => {
    const evaluation = evaluateSubagentWake(snapshot(), readWake(), states, {
      mode,
      minCompleted,
    });
    if (evaluation) {
      return {
        timedOut: false,
        wakeReason: evaluation.reason,
        wakeDelegationIds: evaluation.delegationIds,
      };
    }
    if (snapshot().every((target) => target.status !== "running")) {
      // Everything settled: completion owns delivery, reported as a wake so
      // callers mark it exactly once.
      return { settled: true };
    }
    return undefined;
  };
  const initial = poll();
  if (initial && "settled" in initial) {
    return Promise.resolve({
      timedOut: false,
      deadlineKind: initialKind,
      wakeDelegationIds: [],
    });
  }
  if (initial) {
    return Promise.resolve({ deadlineKind: initialKind, ...initial });
  }
  /** A fresh explicit-interruption outcome (no shared mutable reference). */
  const interruptedOutcome = (): WakeWaitOutcome => ({
    interrupted: true,
    timedOut: true,
    deadlineKind: null,
    wakeDelegationIds: [],
  });
  if (signal?.aborted) {
    // An already-aborted caller is an explicit interruption, not a deadline:
    // no period elapsed, so no deadline kind is claimed.
    return Promise.resolve(interruptedOutcome());
  }
  return new Promise((resolve) => {
    let done = false;
    let deadline = initialDeadline;
    let deadlineKind = initialKind;
    let lastPeriod = live?.periodBound ? wakePeriodSeconds(readWake()) : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined =
      deadline === null
        ? undefined
        : setTimeout(() => fireDeadline(), Math.max(0, deadline - Date.now()));
    const finish = (
      outcome: {
        timedOut: boolean;
        wakeReason?: SubagentWakeReason;
        wakeDelegationIds: string[];
      },
      firedDeadline?: number,
    ) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unregister();
      resolve({
        ...outcome,
        deadlineKind,
        ...(firedDeadline !== undefined ? { firedDeadline } : {}),
      });
    };
    /** An explicit interruption: never claims a fired deadline. */
    const finishAborted = () => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unregister();
      resolve(interruptedOutcome());
    };
    /**
     * The timer reached its deadline. Completion and threshold observations
     * win at the boundary (evaluated first), so a settle in the same tick is
     * delivered as a wake and marked exactly once, never as a timeout.
     */
    const fireDeadline = () => {
      if (done) return;
      const result = poll();
      if (!result) {
        // A genuine timer fire: report the local deadline the timer was armed
        // with, which a live re-arm may have moved since the wait started.
        finish({ timedOut: true, wakeDelegationIds: [] }, deadline ?? undefined);
        return;
      }
      if ("settled" in result) {
        finish({ timedOut: false, wakeDelegationIds: [] });
        return;
      }
      finish(result);
    };
    const check = () => {
      if (done) return;
      if (live?.periodBound) {
        const period = wakePeriodSeconds(readWake());
        if (period !== lastPeriod) {
          lastPeriod = period;
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          if (period === null) {
            deadline = null;
            deadlineKind = null;
          } else {
            deadline = Date.now() + period * 1000;
            deadlineKind = "time";
            timer = setTimeout(
              () => fireDeadline(),
              Math.max(0, period * 1000),
            );
          }
        }
      }
      const result = poll();
      if (!result) return;
      if ("settled" in result) {
        finish({ timedOut: false, wakeDelegationIds: [] });
      } else {
        finish(result);
      }
    };
    const unregister = registerWakeWaiter(check);
    for (const completion of completions) {
      completion.then(check, check);
    }
    const onAbort = () => finishAborted();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type WakeWaiterUnregister = () => void;

/**
 * One-shot listener registry re-evaluating in-flight wake-aware waits.
 * Owned by the runtime; the wake mechanics only call back through it.
 */
export function createWakeWaiterRegistry(sessionId: string): {
  readonly size: number;
  register: (listener: () => void) => WakeWaiterUnregister;
  notify: () => void;
  clear: () => void;
} {
  const waiters = new Set<() => void>();
  return {
    get size() {
      return waiters.size;
    },
    register(listener: () => void): WakeWaiterUnregister {
      waiters.add(listener);
      return () => {
        waiters.delete(listener);
      };
    },
    notify(): void {
      if (waiters.size === 0) return;
      for (const waiter of [...waiters]) {
        try {
          waiter();
        } catch (error) {
          process.stderr.write(
            `[agent-runtime] delegation wake re-evaluation failed (session=${sessionId}): ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    },
    clear(): void {
      waiters.clear();
    },
  };
}
