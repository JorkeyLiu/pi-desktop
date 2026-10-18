import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantActivityItem } from "./assistant-turns";
import {
  delegationLifecycleKind,
  getToolAction,
  isDelegationStartTool,
  type DelegationLifecycleKind,
} from "./tool-display";
import { toolResultPayload } from "./tool-presentation";

export type DelegationActivityItem = Extract<
  AssistantActivityItem,
  { kind: "tool" }
>;

export type SubagentOutcome =
  | "running"
  | "completed"
  | "timed_out"
  | "aborted"
  | "failed"
  | "stopped"
  | "denied"
  | "interrupted";

export type SubagentTiming = {
  startedAt?: number;
  completedAt?: number;
};

export function isDelegationActivityItem(
  item: AssistantActivityItem,
): item is DelegationActivityItem {
  // Only the tool that STARTS a subagent is a delegation activity item (ADR
  // 0062): the lifecycle tools (TaskWait/TaskList/TaskStop, ADR 0089) drive an
  // existing delegation and must not inflate the topology's subagent counts.
  return (
    item.kind === "tool" &&
    isDelegationStartTool(item.message.toolName) &&
    getToolAction(item.message.toolName) === "delegate"
  );
}

const DELEGATION_STATUSES = new Set<SubagentOutcome>([
  "running",
  "completed",
  "timed_out",
  "aborted",
  "failed",
  "stopped",
  "denied",
  "interrupted",
]);

function asDelegationStatus(value: unknown): SubagentOutcome | null {
  return DELEGATION_STATUSES.has(value as SubagentOutcome)
    ? (value as SubagentOutcome)
    : null;
}

/** TaskStop listed this row, so a `running` snapshot still means stopped. */
function stoppedEntryStatus(value: unknown): SubagentOutcome {
  const status = asDelegationStatus(value);
  return !status || status === "running" ? "stopped" : status;
}

function ingestLifecycleStatuses(
  statuses: Map<string, SubagentOutcome>,
  entries: unknown,
  fromStopped: boolean,
): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = record?.delegationId;
    const status = fromStopped
      ? stoppedEntryStatus(record?.status)
      : asDelegationStatus(record?.status);
    // Later rows win: a delegation reported running by an early TaskList is
    // settled by the TaskWait/TaskStop that follows it.
    if (typeof id === "string" && id && status) statuses.set(id, status);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function addTiming(
  timings: Map<string, SubagentTiming>,
  value: unknown,
): void {
  const record = asRecord(value);
  const delegationId = record?.delegationId;
  if (typeof delegationId !== "string" || !delegationId) return;
  const startedAt = timestamp(record?.startedAt);
  const completedAt = timestamp(record?.completedAt);
  if (startedAt === undefined && completedAt === undefined) return;
  const previous = timings.get(delegationId);
  timings.set(delegationId, {
    ...(previous?.startedAt !== undefined || startedAt !== undefined
      ? { startedAt: startedAt ?? previous?.startedAt }
      : {}),
    ...(previous?.completedAt !== undefined || completedAt !== undefined
      ? { completedAt: completedAt ?? previous?.completedAt }
      : {}),
  });
}

/**
 * Runtime timing for each delegation, including the initial `Task` start and
 * the later lifecycle snapshot that carries `completedAt`.
 *
 * A `Task` tool call ends as soon as the background delegate starts, so its
 * `toolDurationMs` is not the delegate's runtime. TaskList/TaskWait/TaskStop
 * repeat the registry timing and are the source of truth for settled nodes.
 */
export function collectDelegationTimings(
  items: readonly AssistantActivityItem[],
): ReadonlyMap<string, SubagentTiming> {
  const timings = new Map<string, SubagentTiming>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const payload = asRecord(toolResultPayload(item.message));
    if (!payload) continue;
    if (isDelegationActivityItem(item)) addTiming(timings, payload);
    const delegations = [
      ...(Array.isArray(payload.delegations) ? payload.delegations : []),
      ...(Array.isArray(payload.stopped) ? payload.stopped : []),
    ];
    for (const delegation of delegations) {
      addTiming(timings, delegation);
    }
  }
  return timings;
}

/**
 * Wall-clock span of one topology card, keyed by that card's own Task ids so
 * a later fan-out in the same turn cannot stretch an earlier card's elapsed
 * time. `completedAt` is omitted while any of those delegates is still running.
 */
export function delegationTimingBounds(
  items: readonly DelegationActivityItem[],
  timings: ReadonlyMap<string, SubagentTiming>,
): { startedAt?: number; completedAt?: number } {
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  let pending = false;
  for (const item of items) {
    const payload = asRecord(toolResultPayload(item.message));
    const id = payload?.delegationId;
    if (typeof id !== "string" || !id) continue;
    const timing = timings.get(id);
    const start = timing?.startedAt ?? timestamp(payload?.startedAt);
    const end = timing?.completedAt ?? timestamp(payload?.completedAt);
    if (start !== undefined) {
      startedAt = startedAt === undefined ? start : Math.min(startedAt, start);
    }
    if (end === undefined) pending = true;
    else {
      completedAt = completedAt === undefined ? end : Math.max(completedAt, end);
    }
  }
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(!pending && completedAt !== undefined ? { completedAt } : {}),
  };
}

/**
 * Latest status per delegation id, from Task snapshots and lifecycle results.
 *
 * `Task` returns the moment the delegate starts (ADR 0089), so its own result
 * initially says `running`. The runtime later refreshes that Task row with
 * its terminal status, independently of parent lifecycle polling.
 * TaskWait/TaskList report `details.delegations[]`; TaskStop reports
 * `details.stopped[]`. Those rows — which are deliberately not topology nodes —
 * are what tells a delegation card how its subagent actually finished.
 *
  * When `turnLive` is false the parent turn has ended, so any leftover
  * `running` node with no terminal snapshot is reconstructed as `aborted`
  * (the runtime aborts them at run end). A persisted `interrupted` snapshot
  * (app exit with retained history) is recoverable and never rewritten here;
  * only a still-`running`/missing status becomes `aborted`. A `TaskStop`
  * snapshot that still says `running` is `stopped`.
 */
export function collectDelegationStatuses(
  items: readonly AssistantActivityItem[],
  options?: { turnLive?: boolean },
): ReadonlyMap<string, SubagentOutcome> {
  const statuses = new Map<string, SubagentOutcome>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    // Read the row before the guard narrows `item` away: every tool item is a
    // potential delegation node, so excluding them leaves TS with `never`.
    const { message } = item;
    if (isDelegationActivityItem(item)) continue;
    const payload = asRecord(toolResultPayload(message));
    if (!payload) continue;
    ingestLifecycleStatuses(statuses, payload.delegations, false);
    ingestLifecycleStatuses(statuses, payload.stopped, true);
  }
  // The runtime refreshes Task itself as soon as its delegate settles. This
  // terminal snapshot outranks an older TaskList/TaskWait running snapshot,
  // even though those lifecycle rows appear later in transcript order.
  for (const item of items) {
    if (!isDelegationActivityItem(item)) continue;
    const payload = asRecord(toolResultPayload(item.message));
    const status = asDelegationStatus(payload?.status);
    const id = payload?.delegationId;
    if (typeof id === "string" && id && status && status !== "running") {
      statuses.set(id, status);
    }
  }
  if (options?.turnLive === false) {
    for (const item of items) {
      if (item.kind !== "tool" || !isDelegationActivityItem(item)) continue;
      const payload = asRecord(toolResultPayload(item.message));
      const id = payload?.delegationId;
      if (typeof id !== "string" || !id) continue;
      const current = statuses.get(id);
      if (!current || current === "running") statuses.set(id, "aborted");
    }
  }
  return statuses;
}

/**
 * A settled subagent's failure as the runtime reported it.
 *
 * `Task` initially returns when a delegate starts (ADR 0089); its refreshed
 * terminal snapshot can carry a failure even before the parent polls.
 * `TaskWait`/`TaskList` report `details.delegations[]` and
 * `TaskStop` reports `details.stopped[]`, and those entries do carry
 * `error: { code, message }` from `SubagentRunResult.error`.
 */
export type DelegationFailure = {
  code: string;
  message: string;
};

function readDelegationFailure(entry: unknown): DelegationFailure | null {
  const record = asRecord(entry);
  const error = asRecord(record?.error);
  if (!error) return null;
  const code = typeof error.code === "string" ? error.code.trim() : "";
  const message = typeof error.message === "string" ? error.message.trim() : "";
  if (!code && !message) return null;
  return { code, message };
}

/**
 * Why each settled delegation failed, keyed by delegation id.
 *
 * {@link collectDelegationStatuses} says *that* a subagent ended as `failed`,
 * `timed_out`, or `aborted`; this says why, from the same lifecycle rows and
 * with the same last-write-wins rule. A delegate that fails before emitting a
 * message row has no other carrier for its reason, which is what left a failed
 * subagent's detail panel showing steps and no explanation.
 */
export function collectDelegationFailures(
  items: readonly AssistantActivityItem[],
): ReadonlyMap<string, DelegationFailure> {
  const failures = new Map<string, DelegationFailure>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    // Read the row before the guard narrows `item` away: every tool item is a
    // potential delegation node, so excluding them leaves TS with `never`.
    const { message } = item;
    if (isDelegationActivityItem(item)) continue;
    const payload = asRecord(toolResultPayload(message));
    if (!payload) continue;
    for (const entries of [payload.delegations, payload.stopped]) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const record = asRecord(entry);
        const id = record?.delegationId;
        if (typeof id !== "string" || !id) continue;
        const failure = readDelegationFailure(entry);
        if (failure) failures.set(id, failure);
      }
    }
  }
  for (const item of items) {
    if (!isDelegationActivityItem(item)) continue;
    const payload = asRecord(toolResultPayload(item.message));
    const id = payload?.delegationId;
    const failure = readDelegationFailure(payload);
    if (typeof id === "string" && id && failure) failures.set(id, failure);
  }
  return failures;
}

/**
 * Lifecycle outcome of one `TaskWait` result (backend-owned `details`).
 *
 * `TaskWait` returns `status` + optional `wakeReason`:
 * - `completed` (+`completion`): at least one awaited delegate settled and its
 *   report is in this result — inspectable history, never deleted.
 * - `wakeup` (+`time`/`tool-calls`/`context-tokens`): an interim progress
 *   checkpoint on still-running delegates — the live delegation is one stable
 *   ongoing state, not a new standalone result row.
 * - `timeout` (no `wakeReason`): the outer bound elapsed with runners left.
 * - `interrupted`: new user input cut the wait; runners keep working.
 * Anything else (including absent fields on legacy rows) is unknown: the row
 * stays inspectable but earns no lifecycle badge.
 *
 * `TaskList` is also read here. When it has expected pending delegates it waits
 * through the same program coordinator and returns the same `status` fields, so
 * an active `TaskList` reads as a program wait (progress/result) exactly like a
 * `TaskWait`. A cheap snapshot — no pending delegates — carries no `status` and
 * stays a roster check with its own settled label.
 */
export type TaskWaitLifecycle =
  | { kind: "completed" }
  | { kind: "progress"; reason: "time" | "tool-calls" | "context-tokens" }
  | { kind: "timeout" }
  | { kind: "interrupted" }
  | { kind: "unknown" };

function asWaitRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read a `TaskWait` row's lifecycle from its backend-owned `details`
 * (`details.status` + `details.wakeReason`). Returns null for non-wait rows.
 * `TaskList` has no wait lifecycle: it is a point-in-time roster check and
 * must never read as a wait event.
 */
export function taskWaitLifecycle(message: UiMessage): TaskWaitLifecycle | null {
  const kind = lifecycleKindOf(message);
  // A `TaskWait`, or a `TaskList` that blocked through the shared program
  // coordinator and returned the same `status` fields. A `TaskList` that only
  // read the current snapshot never waited, so it returns null below.
  if (kind !== "wait" && kind !== "list") return null;
  const payload = asWaitRecord(toolResultPayload(message));
  if (!payload) return kind === "wait" ? { kind: "unknown" } : null;
  const status = typeof payload.status === "string" ? payload.status : "";
  const wakeReason = typeof payload.wakeReason === "string" ? payload.wakeReason : "";
  if (status === "interrupted") return { kind: "interrupted" };
  if (status === "timeout") return { kind: "timeout" };
  if (status === "completed") return { kind: "completed" };
  if (status === "wakeup") {
    if (wakeReason === "time" || wakeReason === "tool-calls" || wakeReason === "context-tokens") {
      return { kind: "progress", reason: wakeReason };
    }
    return { kind: "unknown" };
  }
  // A `TaskWait` without status/wakeReason predates the field (or is still
  // settling): inspectable, never a lifecycle badge. A `TaskList` here is the
  // cheap snapshot path, which has no wait lifecycle at all.
  return kind === "wait" ? { kind: "unknown" } : null;
}

/**
 * Whether a program-wait row (`TaskWait`, or an active `TaskList` that blocked
 * on the coordinator) is a live progress checkpoint on still-running delegates
 * (wakeup/time/threshold) rather than a delivered result.
 * Completed/timeout/interrupted/unknown rows are history and stay visible.
 */
export function isLiveWaitCheckpoint(message: UiMessage): boolean {
  return taskWaitLifecycle(message)?.kind === "progress";
}

/**
 * Whether a program-wait row delivered at least one settled report
 * (`status: completed`). Only these rows read as "results arrived".
 */
export function isWaitResultDelivery(message: UiMessage): boolean {
  return taskWaitLifecycle(message)?.kind === "completed";
}

/** One subagent named on a lifecycle row's roster (ADR 0089). */
export type DelegationRosterEntry = {
  delegationId: string;
  agentName: string;
  status: SubagentOutcome;
  durationMs?: number;
};

/**
 * The subagents a lifecycle row reports on, in the order the runtime listed
 * them.
 *
 * `TaskWait`/`TaskList` report `details.delegations[]` and `TaskStop` reports
 * `details.stopped[]`; both carry the agent name and status, which is what a
 * reader needs. Without this the row could only show its `delegationIds`
 * argument, which is a list of bare UUIDs (D268).
 */
export function delegationRoster(
  message: UiMessage,
): DelegationRosterEntry[] {
  if (!delegationLifecycleKind(message.toolName)) return [];
  const payload = asRecord(toolResultPayload(message));
  if (!payload) return [];
  const roster: DelegationRosterEntry[] = [];
  const pushEntries = (entries: unknown, fromStopped: boolean) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const record = asRecord(entry);
      const delegationId = record?.delegationId;
      if (typeof delegationId !== "string" || !delegationId) continue;
      const agent = record?.agent;
      const startedAt = timestamp(record?.startedAt);
      const completedAt = timestamp(record?.completedAt);
      roster.push({
        delegationId,
        agentName: typeof agent === "string" ? agent : "",
        status: fromStopped
          ? stoppedEntryStatus(record?.status)
          : (asDelegationStatus(record?.status) ?? "running"),
        ...(startedAt !== undefined && completedAt !== undefined
          ? { durationMs: Math.max(0, completedAt - startedAt) }
          : {}),
      });
    }
  };
  pushEntries(payload.delegations, false);
  pushEntries(payload.stopped, true);
  return roster;
}

/**
 * What a lifecycle row should say in one line: the subagents it reports on, by
 * name, deduplicated so a repeated agent is counted rather than listed twice.
 */
export function delegationRosterSummary(
  roster: readonly DelegationRosterEntry[],
): string {
  if (roster.length === 0) return "";
  const counts = new Map<string, number>();
  for (const entry of roster) {
    if (!entry.agentName) continue;
    counts.set(entry.agentName, (counts.get(entry.agentName) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
}

/** Roster status rolled up for the row's own badge. */
export function delegationRosterOutcome(
  roster: readonly DelegationRosterEntry[],
): SubagentOutcome | null {
  if (roster.length === 0) return null;
  if (roster.some((entry) => entry.status === "running")) return "running";
  const failed = roster.find(
    (entry) => entry.status === "failed" || entry.status === "denied",
  );
  if (failed) return failed.status;
  const warned = roster.find((entry) => entry.status !== "completed");
  return warned ? warned.status : "completed";
}

/**
 * Group wait checkpoints with the live delegation interval they belong to.
 *
 * Repeated `TaskWait`/active-`TaskList` progress checkpoints on the same live
 * delegation read as one stable ongoing wait. The redundant earlier rows are
 * not deleted: the caller renders them inside a small disclosure attached to
 * the group's first row, so every checkpoint stays inspectable. Result
 * deliveries (`completed`), timeouts, interruptions, and cheap `TaskList`
 * snapshots are never folded — they are distinct history.
 *
 * `folded` is the message ids suppressed from the top level (every row of a
 * group except the last). `groups` maps each group's first folded row id to the
 * folded rows it owns, in transcript order.
 */
export function foldedWaitCheckpointGroups(
  items: readonly AssistantActivityItem[],
): { folded: ReadonlySet<string>; groups: ReadonlyMap<string, UiMessage[]> } {
  const byKey = new Map<string, Array<{ id: string; message: UiMessage }>>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    if (!isLiveWaitCheckpoint(item.message)) continue;
    const roster = delegationRoster(item.message);
    // Key on the sorted delegation ids this checkpoint covers: the same live
    // delegation waited again folds; a different target set stays separate.
    const ids = roster.map((entry) => entry.delegationId).sort();
    const key = ids.length > 0 ? ids.join(",") : `row:${item.message.id}`;
    const rows = byKey.get(key);
    if (rows) rows.push({ id: item.message.id, message: item.message });
    else byKey.set(key, [{ id: item.message.id, message: item.message }]);
  }
  const folded = new Set<string>();
  const groups = new Map<string, UiMessage[]>();
  for (const rows of byKey.values()) {
    if (rows.length < 2) continue;
    const earlier = rows.slice(0, -1);
    for (const row of earlier) folded.add(row.id);
    groups.set(earlier[0]!.id, earlier.map((row) => row.message));
  }
  return { folded, groups };
}

/**
 * The message ids a folded (non-latest) progress checkpoint owns. The caller
 * keeps history intact and only suppresses the redundant top-level rows; the
 * latest checkpoint still renders so the active interval reads as one ongoing
 * state rather than disappearing.
 */
export function collapsedWaitCheckpoints(
  items: readonly AssistantActivityItem[],
): ReadonlySet<string> {
  return foldedWaitCheckpointGroups(items).folded;
}

export function lifecycleKindOf(
  message: UiMessage,
): DelegationLifecycleKind | null {
  return delegationLifecycleKind(message.toolName);
}

export function subagentOutcome(
  message: UiMessage,
  statuses?: ReadonlyMap<string, SubagentOutcome>,
): SubagentOutcome {
  const payload = asRecord(toolResultPayload(message));
  if (payload) {
    const delegationId = payload.delegationId;
    if (typeof delegationId === "string") {
      const settled = statuses?.get(delegationId);
      if (settled) return settled;
    }
    const status = asDelegationStatus(payload.status);
    if (status) return status;
  }
  if (message.toolStatus === "running") return "running";
  if (message.toolStatus === "error") return "failed";
  if (message.toolStatus === "denied") return "denied";
  return "completed";
}
/**
 * Whether a running delegation is still being created rather than already
 * executing.
 *
 * The parent `Task` call returns its structured handle (`delegationId`,
 * `startedAt`) only at its own `tool_end` (ADR 0089). Until that result
 * arrives the row is `toolStatus: "running"` with no delegation payload: the
 * delegate runtime is still spawning and the UI cannot resolve a stable
 * delegation id. Phrasing this stretch as a distinct "creating" state — with
 * its own label and a live elapsed ticking from the call's own timestamp —
 * keeps the transcript from reading as frozen while the create happens.
 */
export function delegationIsCreating(message: UiMessage): boolean {
  if (message.toolStatus !== "running") return false;
  const payload = asRecord(toolResultPayload(message));
  if (payload && typeof payload.delegationId === "string") return false;
  return true;
}

export function summarizeSubagentActivity(
  items: readonly DelegationActivityItem[],
  statuses?: ReadonlyMap<string, SubagentOutcome>,
) {
  const outcomes = items.map((item) => subagentOutcome(item.message, statuses));
  return {
    total: outcomes.length,
    finished: outcomes.filter((outcome) => outcome !== "running").length,
    running: outcomes.filter((outcome) => outcome === "running").length,
    issues: outcomes.filter(
      (outcome) => outcome === "failed" || outcome === "denied",
    ).length,
    warnings: outcomes.filter(
      (outcome) =>
        outcome === "timed_out" ||
        outcome === "aborted" ||
        outcome === "stopped" ||
        outcome === "interrupted",
    ).length,
  };
}
