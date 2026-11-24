/**
 * Program delegation coordinator: one shared progress checkpoint per parent
 * expectation across explicit wait / idle.
 *
 * Contract:
 * - The selected session wakeup `{kind, value}` exclusively owns timing.
 *   Legacy per-call controls (`TaskWait timeoutSeconds`, per-call
 *   `subagentWakeup`) have no parameter here and are structurally ignored:
 *   a query carries only `{ids, mode, minCompleted}`.
 * - One global time checkpoint anchors monotonic cadence, shared by every
 *   program wait and never restarted or shortened by a new query. It arms
 *   from the running targets of the query being planned, so an explicit wait
 *   observes its own targets for completion, progress, and time alike; a
 *   granted `time` wake advances it by one period. It disarms only when
 *   neither the query's scope nor the default (id-less, current-turn) scope
 *   still runs.
 * - Threshold watermarks stay on the record-owned `wake` objects (same
 *   references), so consecutive waits never spin on one progress twice.
 * - Completion always wins (via `evaluateSubagentWake` /
 *   `waitForWakeTargets`). A snapshot read never consumes delivery;
 *   only `markProgramDelivery` with an explicit included set marks, and only
 *   the included settled records.
 * - Event-driven only: waits delegate to `waitForWakeTargets` (settlement
 *   promises + waiter-registry re-evaluation). No second loop. Actual timers
 *   live only inside the active `waitForWakeTargets` and cancel on wait
 *   exit/stop; the coordinator keeps the policy deadline value when no wait
 *   runs.
 * - Selected-config updates are atomic via `handleSelectedWakeUpdate`: a
 *   changed selection rebases the checkpoint at update time. No waiter is
 *   notified here, so an unrelated notification can never resolve a wait on
 *   its own (inherited from `waitForWakeTargets`).
 */

import type {
  ResolvedSubagentWakeupSettings,
  SubagentWakeReason,
} from "@pi-desktop/shared";
import {
  evaluateSubagentWake,
  waitForWakeTargets,
  wakePeriodSeconds,
  type SubagentWakeState,
  type SubagentWakeTarget,
  type WakeWaitOutcome,
} from "./subagent-wakeup.js";

/** Record view the coordinator reads; `wake` must be the record-owned object. */
export type CoordinatorRecord = {
  delegationId: string;
  status: string;
  toolCalls: number;
  contextTokens?: number;
  reportDelivered?: boolean;
  wake: SubagentWakeState;
  /**
   * Settlement promise of the live run, when the host holds one. Absent in
   * pure-state tests: settlement is then observed through the waiter
   * registry. Runtime wrappers should supply it.
   */
  completion?: Promise<unknown>;
};

export type ProgramWaitPlan = {
  wake: ResolvedSubagentWakeupSettings;
  deadline: number | null;
  deadlineKind: "time" | null;
  periodBound: true;
};

/** The only per-query controls: targets + convergence. No timeout, no wake. */
export type ProgramWaitQuery = {
  ids?: readonly string[];
  mode?: "all" | "any";
  minCompleted?: number;
};

export type ProgramWaitDeps = {
  registerWakeWaiter: (listener: () => void) => () => void;
  signal?: AbortSignal;
};

function toWakeTarget(record: CoordinatorRecord): SubagentWakeTarget {
  return {
    delegationId: record.delegationId,
    status: record.status,
    toolCalls: record.toolCalls,
    ...(record.contextTokens !== undefined
      ? { contextTokens: record.contextTokens }
      : {}),
  };
}

function sameWake(
  left: ResolvedSubagentWakeupSettings,
  right: ResolvedSubagentWakeupSettings,
): boolean {
  return left.kind === right.kind && (left.value ?? null) === (right.value ?? null);
}

function clampMinCompleted(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

/**
 * The minimal record view delivery marking reads. Kept structural so the
 * runtime's `DelegationRecord` and the coordinator's `CoordinatorRecord`
 * both satisfy it without conversion.
 */
export type ProgramDeliveryRecord = {
  delegationId: string;
  status: string;
  reportDelivered?: boolean;
};

/**
 * The single authoritative exactly-once delivery marker for program waits.
 * Marks only the explicitly included settled records; omitted settled reports
 * stay pending (`reportDelivered` untouched), running records are never marked
 * even when named. Returns the newly marked ids. The init-failure premarked
 * path stays outside this helper (already delivered at spawn).
 */
export function markProgramDelivery(
  records: readonly ProgramDeliveryRecord[],
  includedDelegationIds: ReadonlySet<string>,
): string[] {
  const marked: string[] = [];
  for (const record of records) {
    if (record.status === "running") continue;
    if (!includedDelegationIds.has(record.delegationId)) continue;
    if (record.reportDelivered) continue;
    record.reportDelivered = true;
    marked.push(record.delegationId);
  }
  return marked;
}

export function createDelegationCoordinator(options: {
  getSelectedWake: () => ResolvedSubagentWakeupSettings;
  /**
   * Record view for one wait query, resolved by the host: explicit ids
   * reach the live run whichever turn or input started it; an id-less query
   * is the host's default (current-turn pending) set.
   */
  getRecords: (query: ProgramWaitQuery) => readonly CoordinatorRecord[];
  now?: () => number;
}): {
  /** Host-resolved targets for one query; TaskWait uses this. */
  selectProgramTargets: (query?: ProgramWaitQuery) => CoordinatorRecord[];
  planProgramWait: (
    query?: ProgramWaitQuery,
    nowOverride?: number,
  ) => ProgramWaitPlan;
  /** Rebase the time checkpoint when the selected wake changed. No wait notified. */
  handleSelectedWakeUpdate: (nowOverride?: number) => void;
  /** Policy deadline value held while no wait runs (null when disarmed). */
  peekPolicyDeadline: () => number | null;
  waitForProgramTargets: (
    query: ProgramWaitQuery,
    deps: ProgramWaitDeps,
  ) => Promise<WakeWaitOutcome>;
  /** Pure poll over current snapshots (completion first, then threshold). */
  pollProgramWake: (
    query: ProgramWaitQuery,
  ) => { reason: SubagentWakeReason; delegationIds: string[] } | undefined;
} {
  const nowFn = options.now ?? Date.now;
  let timeCheckpoint: number | null = null;
  let cachedWake: ResolvedSubagentWakeupSettings = {
    ...options.getSelectedWake(),
  };

  // The checkpoint is session-global and shared by every program wait, but it
  // arms from the query being planned: an explicit wait observes its own
  // targets for completion, progress, and time alike, while the id-less
  // default (and the idle auto-resume) keeps converging on current-turn
  // pending only. It disarms only when neither the query's scope nor the
  // default scope still runs.
  const expectedRunning = (query: ProgramWaitQuery = {}): CoordinatorRecord[] =>
    options.getRecords(query).filter((record) => record.status === "running");

  const rebaseForWake = (
    now: number,
    wake: ResolvedSubagentWakeupSettings,
    query: ProgramWaitQuery = {},
  ): void => {
    const period = wakePeriodSeconds(wake);
    if (period === null || expectedRunning(query).length === 0) {
      timeCheckpoint = null;
      return;
    }
    timeCheckpoint = now + period * 1000;
  };

  // The host resolves the query; the coordinator never re-filters it, so an
  // explicit id and the wait below always name the same runs.
  const selectProgramTargets = (
    query: ProgramWaitQuery = {},
  ): CoordinatorRecord[] => {
    return [...options.getRecords(query)];
  };

  const planProgramWait = (
    query: ProgramWaitQuery = {},
    nowOverride?: number,
  ): ProgramWaitPlan => {
    const now = nowOverride ?? nowFn();
    const wake: ResolvedSubagentWakeupSettings = {
      ...options.getSelectedWake(),
    };
    if (!sameWake(wake, cachedWake)) {
      // Selected config changed: atomic rebase at update time.
      cachedWake = { ...wake };
      rebaseForWake(now, wake, query);
    } else if (timeCheckpoint === null) {
      // Anchor once from the first active expected delegation; later
      // same-config queries reuse the checkpoint (never restart/shorten).
      rebaseForWake(now, wake, query);
    } else if (expectedRunning(query).length === 0 && expectedRunning().length === 0) {
      timeCheckpoint = null;
    }
    const deadline = timeCheckpoint;
    return {
      wake,
      deadline,
      deadlineKind: deadline === null ? null : "time",
      periodBound: true,
    };
  };

  const handleSelectedWakeUpdate = (nowOverride?: number): void => {
    const now = nowOverride ?? nowFn();
    const next: ResolvedSubagentWakeupSettings = {
      ...options.getSelectedWake(),
    };
    if (sameWake(next, cachedWake)) return;
    cachedWake = { ...next };
    rebaseForWake(now, next);
  };

  const peekPolicyDeadline = (): number | null => timeCheckpoint;

  const convergence = (query: ProgramWaitQuery, targetCount: number) => {
    const mode = query.mode === "any" ? "any" : "all";
    return {
      mode,
      minCompleted:
        mode === "any"
          ? Math.min(clampMinCompleted(query.minCompleted, 1), targetCount)
          : targetCount,
    } as const;
  };

  const pollProgramWake = (query: ProgramWaitQuery) => {
    const targets = selectProgramTargets(query);
    if (targets.length === 0) return undefined;
    const states = new Map(
      targets.map((record) => [record.delegationId, record.wake]),
    );
    return evaluateSubagentWake(
      targets.map(toWakeTarget),
      { ...options.getSelectedWake() },
      states,
      convergence(query, targets.length),
    );
  };

  const waitForProgramTargets = (
    query: ProgramWaitQuery,
    deps: ProgramWaitDeps,
  ): Promise<WakeWaitOutcome> => {
    const targets = selectProgramTargets(query);
    if (targets.length === 0) {
      return Promise.resolve({
        timedOut: false,
        deadlineKind: null,
        wakeDelegationIds: [],
      });
    }
    const plan = planProgramWait(query);
    // Same record-owned watermark references: consecutive waits share them.
    const states = new Map(
      targets.map((record) => [record.delegationId, record.wake]),
    );
    const running = targets.filter((record) => record.status === "running");
    const completions: readonly Promise<unknown>[] =
      running.length > 0
        ? running.map(
            (record) => record.completion ?? new Promise<void>(() => undefined),
          )
        : [new Promise<void>(() => undefined)];
    const liveIds = new Set(targets.map((record) => record.delegationId));
    const outcome = waitForWakeTargets(
      () =>
        options
          .getRecords(query)
          .filter((record) => liveIds.has(record.delegationId))
          .map(toWakeTarget),
      states,
      completions,
      deps.registerWakeWaiter,
      {
        ...convergence(query, targets.length),
        wake: plan.wake,
        deadline: plan.deadline,
        deadlineKind: plan.deadlineKind,
        ...(deps.signal ? { signal: deps.signal } : {}),
        live: {
          getWake: () => ({ ...options.getSelectedWake() }),
          periodBound: true,
        },
      },
    );
    return outcome.then((result) => {
      // Only a timer that actually fired grants the next cadence. An
      // interruption (steering / stop / cancel) resolves the same time-kind
      // wait with `timedOut` but no deadline and an explicit `interrupted`
      // flag, so it never consumes the checkpoint.
      const timerFired =
        !result.interrupted &&
        result.timedOut &&
        result.deadlineKind === "time";
      if (timerFired && result.firedDeadline !== undefined) {
        const period = wakePeriodSeconds(options.getSelectedWake());
        // Idempotent, keyed on the deadline the timer actually fired on: a
        // live rebase advances from the rebased deadline (not the stale plan
        // captured at wait start), two waiters that shared one fired deadline
        // advance it once, and an obsolete timer firing after a rebase is
        // rejected because the checkpoint no longer matches it.
        if (period !== null && timeCheckpoint === result.firedDeadline) {
          timeCheckpoint = result.firedDeadline + period * 1000;
        }
      }
      if (expectedRunning(query).length === 0 && expectedRunning().length === 0) {
        timeCheckpoint = null;
      }
      return result;
    });
  };

  return {
    selectProgramTargets,
    planProgramWait,
    handleSelectedWakeUpdate,
    peekPolicyDeadline,
    waitForProgramTargets,
    pollProgramWake,
  };
}
