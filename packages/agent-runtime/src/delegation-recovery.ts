/**
 * Historical delegation recovery (ADR 0089 read surface).
 *
 * The live `delegations` map is process state: `Task` inserts a record, and the
 * record carries the run handle, the completion promise, and the accounting the
 * parent still owns. A restart has none of that, so `TaskList`/`TaskWait` used
 * to answer "no subagents" for work this session really ran — even though the
 * transcript still holds the `Task` rows that prove it.
 *
 * This module rebuilds the read-only half of that state from persisted history:
 * one plain-data entry per parent-owned delegation, with no run handle, no
 * timer, and no completion promise. It is a *catalog*, not a registry: entries
 * can be listed and their stored reports read, and a still-open entry is
 * explicitly `interrupted` — resumable through the existing `Task.resume`
 * chain, never waited on.
 *
 * Report text comes, in order, from the strongest persisted evidence:
 *
 * 1. a `TaskWait` result batch, whose `details.delegations[].report` is the
 *    exact text the parent received;
 * 2. the delegate's own final assistant row (`parentToolCallId` = the `Task`
 *    call), which is the report body for a run that settled without a wait;
 * 3. the live record's settled result, cached when the run settles so the
 *    in-process prune cap cannot hide a delegation the session already listed.
 *
 * Nothing here reads storage directly: the catalog is built from the history the
 * runtime was launched with, plus the plain-data snapshot of runs that settle
 * while it lives.
 */

import {
  isDelegationHandoffCheckpoint,
  normalizeSubagentName,
  SUBAGENT_THINKING_LEVELS,
  type DelegationHandoffCheckpoint,
  type MessageUsage,
  type UiMessage,
} from "@pi-desktop/shared";
import { isRecord, timestampMs } from "./agent-messages.js";
import type { SubagentHandoffPersistenceError } from "./subagent-handoff.js";
import type { DelegationView, WaitResultSnapshot } from "./subagent-progress.js";

/**
 * Historical entries one session keeps. It matches the live registry's
 * retention (`MAX_RETAINED_DELEGATIONS`) so a restart cannot surface more
 * delegations than a running process would list, and a long conversation's
 * history cannot grow this cache without bound. The newest runs are kept.
 */
export const MAX_RECOVERED_DELEGATIONS = 100;

/** Where a recovered entry's report text came from. */
export type RecoveredReportSource =
  | "taskwait-result"
  | "delegate-message"
  /** A settled live run this process cached before pruning dropped its record. */
  | "live-run"
  /** No report text survived in the loaded history. */
  | "none";

/** One parent-owned delegation rebuilt from history: data only, never live. */
export type RecoveredDelegation = DelegationView & {
  recovered: true;
  /** Full stored report text; empty when no evidence was persisted. */
  report: string;
  reportSource: RecoveredReportSource;
  /** `Task` call that owns this run's child rows. */
  toolCallId: string;
  /** What the entry's status was derived from. */
  statusSource:
    | "taskwait-result"
    | "task-row"
    | "row-error"
    | "unknown"
    | "live-run";
  /** Settled failure this entry recorded, when it recorded one. */
  error?: { code: string; message: string };
};

/** Settled live run, handed over as plain data so pruning cannot hide it. */
export type SettledDelegationInput = {
  delegationId: string;
  parentToolCallId: string;
  agentName: string;
  modelId?: string;
  thinkingLevel?: DelegationView["thinkingLevel"];
  status: string;
  startedAt: number;
  completedAt?: number;
  lastActivityAt: number;
  turns: number;
  toolCalls: number;
  usage?: MessageUsage;
  contextTokens?: number;
  lastToolName?: string;
  executionTurnId?: string;
  resumedFrom?: string;
  modelChangedFrom?: string;
  handoffCheckpoint?: DelegationHandoffCheckpoint;
  handoffCheckpointError?: SubagentHandoffPersistenceError;
  report?: string;
  error?: { code: string; message: string };
};

/** One `Task` row selected as a delegation's identity. Later rows win. */
type TaskRowInfo = {
  delegationId: string;
  toolCallId: string;
  agentName: string;
  row: UiMessage;
  details?: Record<string, unknown>;
  args?: Record<string, unknown>;
  startedAt: number;
};

/** What one `TaskWait` result batch recorded about a delegation. */
type DeliveredReport = {
  report: string;
  status: string;
};

function numberValue(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Accept a persisted thinking level only when it is a real level. */
function thinkingLevelValue(value: unknown): DelegationView["thinkingLevel"] {
  if (typeof value !== "string") return undefined;
  return SUBAGENT_THINKING_LEVELS.find((level) => level === value);
}

/** Read a persisted `{ code, message }` error or handoff-failure record. */
function codedErrorValue(
  value: unknown,
): { code: string; message: string } | undefined {
  if (!isRecord(value)) return undefined;
  const code = stringValue(value, "code");
  const message = stringValue(value, "message");
  return code && message ? { code, message } : undefined;
}
function detailsOf(row: UiMessage): Record<string, unknown> | undefined {
  const result = row.toolResult;
  return isRecord(result) && isRecord(result.details) ? result.details : undefined;
}

/** Read the one coded handoff-failure record a settled run may have written. */
function handoffFailureValue(value: unknown): SubagentHandoffPersistenceError | undefined {
  if (!isRecord(value)) return undefined;
  if (value.code !== "SUBAGENT_HANDOFF_CHECKPOINT_FAILED") return undefined;
  const message = stringValue(value, "message");
  return message ? { code: "SUBAGENT_HANDOFF_CHECKPOINT_FAILED", message } : undefined;
}

function rowTimestamp(row: UiMessage, key: "createdAt" | "toolCompletedAt"): number | undefined {
  const at = timestampMs(row[key]);
  return at || undefined;
}

/**
 * Status a persisted `Task` row records, read the same way chains are rebuilt:
 * `running` means this process never observed the settlement, so the run reads
 * as `interrupted` — not actively running, still resumable. An error row is a
 * failed run; a row with no usable status is `interrupted` too, because nothing
 * proves it settled.
 */
function statusFromTaskRow(info: TaskRowInfo, delivered: DeliveredReport | undefined):
  | { status: string; statusSource: RecoveredDelegation["statusSource"] }
{
  const settled = delivered && delivered.status !== "running" ? delivered.status : undefined;
  if (settled) return { status: settled, statusSource: "taskwait-result" };
  const detailStatus = stringValue(info.details, "status");
  if (detailStatus) {
    return {
      status: detailStatus === "running" ? "interrupted" : detailStatus,
      statusSource: "task-row",
    };
  }
  if (info.row.toolStatus === "error") {
    return { status: "failed", statusSource: "row-error" };
  }
  return { status: "interrupted", statusSource: "unknown" };
}

/** Validate the usage shape `delegationSummary` persisted, without guessing. */
function persistedUsage(value: unknown): MessageUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberValue(value, "inputTokens");
  const outputTokens = numberValue(value, "outputTokens");
  const totalTokens = numberValue(value, "totalTokens");
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  const usage: MessageUsage = { inputTokens, outputTokens, totalTokens };
  for (const key of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    const count = numberValue(value, key);
    if (count !== undefined) usage[key] = count;
  }
  const operationId = stringValue(value, "operationId");
  if (operationId) usage.operationId = operationId;
  if (value.usageOrigin === "pi" || value.usageOrigin === "legacy") {
    usage.usageOrigin = value.usageOrigin;
  }
  if (
    value.costStatus === "reported" ||
    value.costStatus === "estimated" ||
    value.costStatus === "unknown"
  ) {
    usage.costStatus = value.costStatus;
  }
  const providerId = stringValue(value, "providerId");
  if (providerId) usage.providerId = providerId;
  const modelId = stringValue(value, "modelId");
  if (modelId) usage.modelId = modelId;
  if (value.aggregation === "operation" || value.aggregation === "aggregate") {
    usage.aggregation = value.aggregation;
  }
  const cost = isRecord(value.cost) ? value.cost : undefined;
  if (cost) {
    const input = numberValue(cost, "input");
    const output = numberValue(cost, "output");
    const cacheRead = numberValue(cost, "cacheRead");
    const cacheWrite = numberValue(cost, "cacheWrite");
    const total = numberValue(cost, "total");
    if (
      input !== undefined &&
      output !== undefined &&
      cacheRead !== undefined &&
      cacheWrite !== undefined &&
      total !== undefined
    ) {
      usage.cost = { input, output, cacheRead, cacheWrite, total };
    }
  }
  return usage;
}

/**
 * Every parent-owned delegation the transcript can prove, newest first capped at
 * `limit`. A `source: "user"` `Task` row is a user-channel continuation, not a
 * parent task: the parent neither lists, waits on, nor resumes it implicitly,
 * so it stays out of the recovered catalog exactly as it stays out of the live
 * listing.
 */
export function buildRecoveredDelegations(
  transcript: readonly UiMessage[],
  limit = MAX_RECOVERED_DELEGATIONS,
): RecoveredDelegation[] {
  const rows = new Map<string, TaskRowInfo>();
  for (const row of transcript) {
    if (row.role !== "tool" || row.toolName !== "Task" || !row.toolCallId) continue;
    const args = isRecord(row.toolArgs) ? row.toolArgs : undefined;
    if (args?.source === "user" || row.steering === true) continue;
    const details = detailsOf(row);
    const delegationId = stringValue(details, "delegationId");
    if (!delegationId) continue;
    const agentName = normalizeSubagentName(
      stringValue(args, "agent") ?? stringValue(details, "agent") ?? "",
    );
    if (!agentName) continue;
    // A settled delegation rewrites its own `Task` row; the newest copy is the
    // one that carries the final status, so a repeated call id is overwritten.
    rows.set(delegationId, {
      delegationId,
      toolCallId: row.toolCallId,
      agentName,
      row,
      ...(details ? { details } : {}),
      ...(args ? { args } : {}),
      startedAt:
        numberValue(details, "startedAt") ??
        rowTimestamp(row, "createdAt") ??
        0,
    });
  }

  // Report evidence 1: the exact batch text a `TaskWait` result delivered. Only
  // settled entries count; a running snapshot's `report` is a heartbeat line.
  const delivered = new Map<string, DeliveredReport>();
  for (const row of transcript) {
    if (row.role !== "tool" || row.toolName !== "TaskWait") continue;
    const details = detailsOf(row);
    const batches = Array.isArray(details?.delegations) ? details.delegations : [];
    for (const batch of batches) {
      if (!isRecord(batch)) continue;
      const delegationId = stringValue(batch, "delegationId");
      const report = typeof batch.report === "string" ? batch.report : undefined;
      if (!delegationId || report === undefined) continue;
      if (delivered.has(delegationId)) continue;
      delivered.set(delegationId, {
        report,
        status: stringValue(batch, "status") ?? "",
      });
    }
  }

  // Report evidence 2: the delegate's own final assistant row. Its call id
  // identifies the run, and its agent name pins the row to that chain.
  const lastAssistant = new Map<string, UiMessage>();
  const lastRowAt = new Map<string, number>();
  for (const row of transcript) {
    const callId = typeof row.parentToolCallId === "string" ? row.parentToolCallId : undefined;
    if (!callId) continue;
    const at = rowTimestamp(row, "createdAt");
    if (at !== undefined && at > (lastRowAt.get(callId) ?? 0)) lastRowAt.set(callId, at);
    if (row.role !== "assistant") continue;
    if (row.status === "error" || row.isError || row.error) continue;
    if (!row.content?.trim()) continue;
    lastAssistant.set(callId, row);
  }

  const entries: RecoveredDelegation[] = [];
  for (const info of rows.values()) {
    const batch = delivered.get(info.delegationId);
    const finalRow = lastAssistant.get(info.toolCallId);
    const childReport =
      finalRow && finalRow.agentName === info.agentName
        ? finalRow.content?.trim()
        : undefined;
    const report = batch?.report || childReport || "";
    const reportSource: RecoveredReportSource = batch
      ? "taskwait-result"
      : childReport
        ? "delegate-message"
        : "none";
    const { status, statusSource } = statusFromTaskRow(info, batch);
    const settled = status !== "interrupted" && status !== "running";
    const completedAt = settled
      ? numberValue(info.details, "completedAt") ??
        rowTimestamp(info.row, "toolCompletedAt") ??
        lastRowAt.get(info.toolCallId) ??
        info.startedAt
      : undefined;
    const lastActivityAt = Math.max(
      info.startedAt,
      numberValue(info.details, "completedAt") ?? 0,
      lastRowAt.get(info.toolCallId) ?? 0,
    );
    const details = info.details;
    const modelId = stringValue(details, "modelId");
    const thinkingLevel = thinkingLevelValue(details?.thinkingLevel);
    const contextTokens = numberValue(details, "contextTokens");
    const usage = persistedUsage(details?.usage);
    const lastToolName = stringValue(details, "lastToolName");
    const executionTurnId = stringValue(details, "executionTurnId");
    const resumedFrom = stringValue(details, "resumedFrom");
    const modelChangedFrom = stringValue(details, "modelChangedFrom");
    const checkpoint = isDelegationHandoffCheckpoint(details?.handoffCheckpoint)
      ? details?.handoffCheckpoint
      : undefined;
    const checkpointError = handoffFailureValue(details?.handoffCheckpointError);
    const error = codedErrorValue(details?.error);
    entries.push({
      recovered: true,
      delegationId: info.delegationId,
      toolCallId: info.toolCallId,
      agentName: info.agentName,
      status,
      statusSource,
      startedAt: info.startedAt,
      lastActivityAt,
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(modelId ? { modelId } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      turns: numberValue(details, "turns") ?? 0,
      toolCalls: numberValue(details, "toolCalls") ?? 0,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(lastToolName ? { lastToolName } : {}),
      ...(executionTurnId ? { executionTurnId } : {}),
      ...(resumedFrom ? { resumedFrom } : {}),
      ...(modelChangedFrom ? { modelChangedFrom } : {}),
      ...(usage ? { usage } : {}),
      ...(checkpoint ? { handoffCheckpoint: checkpoint } : {}),
      ...(checkpointError ? { handoffCheckpointError: checkpointError } : {}),
      ...(error ? { error } : {}),
      report,
      reportSource,
    });
  }
  return boundEntries(
    entries.sort((left, right) => right.startedAt - left.startedAt),
    limit,
  );
}

/** Keep the newest entries; the cap is a read bound, never a content rule. */
function boundEntries(
  entries: RecoveredDelegation[],
  limit: number,
): RecoveredDelegation[] {
  return entries.slice(0, Math.max(0, limit));
}

/**
 * The plain-data cache behind `TaskList`/`TaskWait` reads. Live records always
 * win by id; this answers only ids the process no longer holds.
 */
export class RecoveredDelegationCatalog {
  private readonly entries = new Map<string, RecoveredDelegation>();
  private readonly limit: number;

  constructor(limit = MAX_RECOVERED_DELEGATIONS) {
    this.limit = Math.max(0, limit);
  }

  /** Replace every entry with what the launch transcript can prove. */
  hydrate(transcript: readonly UiMessage[]): void {
    this.entries.clear();
    for (const entry of buildRecoveredDelegations(transcript, this.limit)) {
      this.entries.set(entry.delegationId, entry);
    }
  }

  /**
   * Cache one settled parent-owned run as plain data.
   *
   * Called at settlement so the live prune cap cannot erase a delegation the
   * session already reported: the record object goes away, the history does not.
   */
  noteSettled(record: SettledDelegationInput): void {
    const entry: RecoveredDelegation = {
      recovered: true,
      delegationId: record.delegationId,
      toolCallId: record.parentToolCallId,
      agentName: record.agentName,
      status: record.status,
      statusSource: "live-run",
      startedAt: record.startedAt,
      lastActivityAt: Math.max(record.startedAt, record.lastActivityAt),
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
      ...(record.modelId ? { modelId: record.modelId } : {}),
      ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
      turns: record.turns,
      toolCalls: record.toolCalls,
      ...(record.usage ? { usage: record.usage } : {}),
      ...(record.contextTokens !== undefined ? { contextTokens: record.contextTokens } : {}),
      ...(record.lastToolName ? { lastToolName: record.lastToolName } : {}),
      ...(record.executionTurnId ? { executionTurnId: record.executionTurnId } : {}),
      ...(record.resumedFrom ? { resumedFrom: record.resumedFrom } : {}),
      ...(record.modelChangedFrom ? { modelChangedFrom: record.modelChangedFrom } : {}),
      ...(record.handoffCheckpoint ? { handoffCheckpoint: record.handoffCheckpoint } : {}),
      ...(record.handoffCheckpointError
        ? { handoffCheckpointError: record.handoffCheckpointError }
        : {}),
      ...(record.error ? { error: record.error } : {}),
      report: record.report ?? "",
      reportSource: record.report ? "live-run" : "none",
    };
    this.entries.set(entry.delegationId, entry);
    if (this.entries.size > this.limit) {
      const overflow = this.entries.size - this.limit;
      const oldest = [...this.entries.values()]
        .sort((left, right) => left.startedAt - right.startedAt)
        .slice(0, overflow);
      for (const stale of oldest) this.entries.delete(stale.delegationId);
    }
  }

  lookup(delegationId: string): RecoveredDelegation | undefined {
    return this.entries.get(delegationId);
  }

  list(): RecoveredDelegation[] {
    return [...this.entries.values()];
  }
}

/** Union a live listing with the recovered entries; a live id always wins. */
export function mergeDelegationViews(
  live: readonly DelegationView[],
  recovered: readonly RecoveredDelegation[],
): DelegationView[] {
  const views: DelegationView[] = [...live];
  const seen = new Set(live.map((view) => view.delegationId));
  for (const entry of recovered) {
    if (seen.has(entry.delegationId)) continue;
    seen.add(entry.delegationId);
    views.push(entry);
  }
  return views;
}

/** Text returned when a recovered entry has no persisted report to show. */
export function recoveredReportNote(entry: RecoveredDelegation): string {
  if (entry.report) return entry.report;
  return entry.status === "interrupted"
    ? `This delegation is not running in this process: the app closed while it worked and no report text survived in the loaded history. Continue it with Task.resume: "${entry.delegationId}".`
    : `No report text for this delegation survived in the loaded history. Its stored status is "${entry.status}"; continue it with Task.resume: "${entry.delegationId}" to get a fresh report.`;
}

/** One recovered entry as a read-only wait snapshot. */
export function snapshotRecoveredDelegation(
  entry: RecoveredDelegation,
): WaitResultSnapshot {
  return {
    delegationId: entry.delegationId,
    agent: entry.agentName,
    status: entry.status,
    ...(entry.modelId ? { modelId: entry.modelId } : {}),
    ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
    startedAt: entry.startedAt,
    ...(entry.completedAt !== undefined ? { completedAt: entry.completedAt } : {}),
    toolCalls: entry.toolCalls ?? 0,
    turns: entry.turns ?? 0,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.handoffCheckpointError
      ? { handoffCheckpointError: entry.handoffCheckpointError }
      : {}),
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
    report: recoveredReportNote(entry),
    recovered: true,
  };
}

/**
 * Header one read of settled history carries: what these entries are, that
 * nothing in this process is running for them, and how to continue.
 */
export function recoveredWaitNote(
  entries: readonly RecoveredDelegation[],
): string | undefined {
  if (entries.length === 0) return undefined;
  const ids = entries.map((entry) => entry.delegationId).join(", ");
  const interrupted = entries.filter((entry) => entry.status === "interrupted");
  const lines = [
    `Reports below are history, recovered from this session's transcript: no run of ${entries.length === 1 ? "this delegation" : "these delegations"} is active in this process (${ids}). Reading them neither restarts nor delivers them.`,
  ];
  if (interrupted.length > 0) {
    lines.push(
      `Interrupted before settlement (the app ended while ${interrupted.length === 1 ? "it ran" : "they ran"}): ${interrupted
        .map((entry) => entry.delegationId)
        .join(", ")}. Nothing is running for ${interrupted.length === 1 ? "it" : "them"}; continue with Task.resume: "<id>" and call TaskWait again.`,
    );
  }
  return lines.join("\n");
}
