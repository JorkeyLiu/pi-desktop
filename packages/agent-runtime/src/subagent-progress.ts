/**
 * Delegation progress snapshots: the metrics heartbeat, the Task-row
 * summary, and wait-result assembly shared by `TaskWait` and the idle
 * resume.
 *
 * Kept out of `runtime.ts` so the hotspot owns only the call sites. All
 * functions here are pure over the record (or fold the live loop's own
 * counters idempotently); emitting and waiting stay with the runtime.
 */

import {
  addUsage,
  formatSubagentProgressMetrics,
  type AgentActivity,
  type AgentActivityAgent,
  type AgentEventEnvelope,
  type MessageUsage,
  type SubagentThinkingLevel,
  type UiMessage,
} from "@pi-desktop/shared";
import { isRecord } from "./agent-messages.js";
import { extractReadFiles, isReadOnlyToolName } from "./delegation-history.js";
import type { DelegationRecord } from "./runtime.js";
import type { SubagentRun } from "./subagent.js";
import { settledDelegationMessage } from "./delegation-message.js";

/**
 * A `TaskWait` result is the parent's context; like a delegate's report, it
 * must not become the context problem delegation exists to avoid.
 */
export const MAX_TASKWAIT_RESULT_CHARS = 50_000;

export function elapsedSeconds(
  record: Pick<DelegationRecord, "startedAt" | "completedAt">,
  now = Date.now(),
): number {
  const end = record.completedAt ?? now;
  return Math.max(1, Math.round((end - record.startedAt) / 1000));
}

/** One running delegate as the parent's `waiting-subagents` activity names it. */
export function waitingSubagentSnapshot(
  record: DelegationRecord,
): AgentActivityAgent {
  return {
    name: record.agentName,
    ...(record.lastPhase ? { lastPhase: record.lastPhase } : {}),
    ...(record.lastToolName ? { lastToolName: record.lastToolName } : {}),
  };
}

/** Parent activity while delegates run; the runtime only sets or clears it. */
export function waitingSubagentsActivity(
  targets: DelegationRecord[],
  since: number,
): Extract<AgentActivity, { phase: "waiting-subagents" }> {
  const running = targets.filter((record) => record.status === "running");
  return {
    phase: "waiting-subagents",
    since,
    subagentCount: running.length,
    ...(running.length > 0
      ? { agents: running.map(waitingSubagentSnapshot) }
      : {}),
  };
}

export function delegationSummary(record: DelegationRecord): Record<string, unknown> {
  return {
    delegationId: record.delegationId,
    agent: record.agentName,
    modelId: record.modelId,
    thinkingLevel: record.thinkingLevel,
    status: record.status,
    startedAt: record.startedAt,
    turns: record.result?.turns ?? record.turns,
    toolCalls: record.result?.toolCalls ?? record.toolCalls,
    ...(record.usage ?? record.result?.usage
      ? { usage: record.usage ?? record.result?.usage }
      : {}),
    ...(record.contextTokens !== undefined
      ? { contextTokens: record.contextTokens }
      : {}),
    ...(record.lastToolName ? { lastToolName: record.lastToolName } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.result?.modelFailures ? { modelFailures: record.result.modelFailures } : {}),
    ...(record.result?.error ? { error: record.result.error } : {}),
    // A delegate that compacted or lost history says so in its lifecycle
    // details, not only in the report text (ADR 0299, decision 4).
    ...(record.result?.contextCompactions
      ? { contextCompactions: record.result.contextCompactions }
      : {}),
    ...(record.result?.contextDegraded
      ? { contextDegraded: record.result.contextDegraded }
      : {}),
    ...(record.result?.scratchReportPath
      ? { scratchReportPath: record.result.scratchReportPath }
      : {}),
    ...(record.resumedFrom ? { resumedFrom: record.resumedFrom } : {}),
    ...(record.modelChangedFrom
      ? { modelChangedFrom: record.modelChangedFrom }
      : {}),
    // User-owned runs carry their delivery explicitly; parent-owned records
    // omit it (backward-compatible `parent` default).
    ...((record.delivery ?? "parent") === "user" ? { delivery: "user" as const } : {}),
  };
}

export function formatDelegationHeartbeat(record: DelegationRecord): string {
  const parts = [
    `${record.agentName} (${record.delegationId})`,
    record.status,
    `${elapsedSeconds(record)}s`,
  ];
  const turns = record.result?.turns ?? record.turns;
  const toolCalls = record.result?.toolCalls ?? record.toolCalls;
  if (turns > 0) parts.push(`${turns} turns`);
  if (toolCalls > 0 || record.status === "running") {
    parts.push(
      formatSubagentProgressMetrics({
        toolCalls,
        ...(record.contextTokens !== undefined
          ? { contextTokens: record.contextTokens }
          : {}),
        ...(record.usage ?? record.result?.usage
          ? { usage: record.usage ?? record.result!.usage! }
          : {}),
      }),
    );
  }
  if (record.lastToolName) parts.push(`last tool ${record.lastToolName}`);
  return parts.join(", ");
}

/** One delegation as a wait result carries it: identity, status, metrics, report. */
export type WaitResultSnapshot = {
  delegationId: string;
  agent: string;
  status: string;
  modelId?: string;
  thinkingLevel?: SubagentThinkingLevel;
  startedAt: number;
  completedAt?: number;
  toolCalls: number;
  turns: number;
  error?: { code: string; message: string };
  scratchReportPath?: string;
  usage?: MessageUsage;
  contextTokens?: number;
  report: string;
};

/** Read one record as a wait-result snapshot (heartbeat for runners). */
export function snapshotWaitRecord(record: DelegationRecord): WaitResultSnapshot {
  return {
    delegationId: record.delegationId,
    agent: record.agentName,
    status: record.status,
    modelId: record.modelId,
    thinkingLevel: record.thinkingLevel,
    startedAt: record.startedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    toolCalls: record.result?.toolCalls ?? record.toolCalls,
    turns: record.result?.turns ?? record.turns,
    ...(record.result?.error ? { error: record.result.error } : {}),
    ...(record.result?.scratchReportPath
      ? { scratchReportPath: record.result.scratchReportPath }
      : {}),
    ...(record.usage ?? record.result?.usage
      ? { usage: record.usage ?? record.result?.usage }
      : {}),
    ...(record.contextTokens !== undefined
      ? { contextTokens: record.contextTokens }
      : {}),
    report:
      record.status === "running"
        ? formatDelegationHeartbeat(record)
        : (record.result?.report ?? `(${record.status} without a report)`),
  };
}

/** Join delegation results into one bounded text block for the model. */
export function formatDelegationResults(
  results: Array<{
    delegationId: string;
    agent: string;
    status: string;
    report: string;
    /** Compact live progress line, appended to the result header. */
    metrics?: string;
  }>,
  note?: string,
): { text: string; includedDelegationIds: Set<string> } {
  const parts: string[] = [];
  const includedDelegationIds = new Set<string>();
  let total = 0;
  let omitted = 0;
  for (const result of results) {
    const header = `## ${result.agent} (${result.delegationId}) — ${result.status}${result.metrics ? ` · ${result.metrics}` : ""}`;
    const block = `${header}\n${result.report}`;
    if (total + block.length > MAX_TASKWAIT_RESULT_CHARS) {
      omitted += 1;
      continue;
    }
    parts.push(block);
    includedDelegationIds.add(result.delegationId);
    total += block.length + 2;
  }
  if (omitted > 0) {
    parts.push(
      `[${omitted} more result${omitted === 1 ? "" : "s"} omitted to protect this context; call TaskWait with their delegationIds to re-read one.]`,
    );
  }
  return {
    text: [note, ...parts].filter((part) => part?.trim()).join("\n\n"),
    includedDelegationIds,
  };
}

/**
 * Assemble one bounded wait result for `TaskWait` and the idle resume alike:
 * metrics-suffixed blocks, the included-ids set that owns exactly-once
 * delivery marking, and detail entries carrying the same metrics.
 */
export function assembleWaitResult(
  snapshots: WaitResultSnapshot[],
  note?: string,
): {
  text: string;
  includedDelegationIds: Set<string>;
  delegations: Array<WaitResultSnapshot & { metrics: string }>;
} {
  const delegations = snapshots.map((snapshot) => ({
    ...snapshot,
    metrics: formatSubagentProgressMetrics({
      toolCalls: snapshot.toolCalls,
      ...(snapshot.contextTokens !== undefined
        ? { contextTokens: snapshot.contextTokens }
        : {}),
      ...(snapshot.usage ? { usage: snapshot.usage } : {}),
    }),
  }));
  const { text, includedDelegationIds } = formatDelegationResults(
    delegations,
    note,
  );
  return { text, includedDelegationIds, delegations };
}

/** Host state behind delegation transcript rows; the runtime binds it. */
export type DelegationRowHost = {
  appendedRowIds: Set<string>;
  transcriptHistory: UiMessage[];
  delegateToolCalls: Map<string, { name: string; args: unknown }>;
  noteReads: (delegateSessionId: string, files: readonly string[], lineCount: number) => void;
};

type ToolEndRowEvent = Extract<AgentEventEnvelope["event"], { type: "tool_end" }>;

/** Rebuild a delegate tool row from its `tool_end`: the result only carries the result. */
export function toolRowFromEnvelope(
  host: Pick<DelegationRowHost, "delegateToolCalls">,
  envelope: AgentEventEnvelope,
): UiMessage {
  const event = envelope.event as ToolEndRowEvent;
  const call = host.delegateToolCalls.get(event.toolCallId);
  const ts = new Date(envelope.ts ?? Date.now()).toISOString();
  return {
    id: `delegate-tool-${event.toolCallId}`,
    role: "tool",
    content: "",
    createdAt: ts,
    toolCompletedAt: ts,
    toolCallId: event.toolCallId,
    toolName: call?.name ?? "",
    toolArgs: call?.args,
    toolResult: event.result,
    toolStatus: event.isError ? "error" : "success",
    isError: Boolean(event.isError),
    parentToolCallId: envelope.parentToolCallId,
    nestedParentToolCallId: envelope.nestedParentToolCallId,
    agentName: envelope.agentName,
  };
}

/**
 * Keep the transcript current with what a delegate produced, so a later
 * `Task.resume` in the same session replays the chain without waiting on
 * persistence (ADR 0276). A retried stream reuses the row id and appends once.
 */
export function appendDelegationRow(
  host: DelegationRowHost,
  record: Pick<DelegationRecord, "delegateSessionId">,
  envelope: AgentEventEnvelope,
  row: UiMessage,
): void {
  const tagged: UiMessage = {
    ...row,
    parentToolCallId: envelope.parentToolCallId ?? row.parentToolCallId,
    nestedParentToolCallId: envelope.nestedParentToolCallId ?? row.nestedParentToolCallId,
    agentName: envelope.agentName ?? row.agentName,
  };
  const key =
    tagged.role === "tool"
      ? `tool:${tagged.toolCallId ?? ""}`
      : `message:${tagged.id ?? ""}`;
  if (key.endsWith(":")) return;
  if (host.appendedRowIds.has(key)) return;
  host.appendedRowIds.add(key);
  host.transcriptHistory.push(tagged);
  if (tagged.role === "tool" && isReadOnlyToolName(tagged.toolName ?? "")) {
    const { files, lineCount } = extractReadFiles([tagged]);
    host.noteReads(record.delegateSessionId, files, lineCount);
  }
}

/** Host behind the parent's `waiting-subagents` activity; the runtime binds it. */
export type DelegationWaitHost = {
  getTargets: () => DelegationRecord[] | undefined;
  setTargets: (targets: DelegationRecord[] | undefined) => void;
  getActivity: () => AgentActivity | undefined;
  setActivity: (activity: AgentActivity) => void;
  clearActivity: () => void;
  now?: () => number;
};

export function beginDelegationWait(
  host: DelegationWaitHost,
  targets: DelegationRecord[],
): void {
  const running = targets.filter((record) => record.status === "running");
  if (running.length === 0) return;
  host.setTargets(targets);
  const current = host.getActivity();
  const since =
    current?.phase === "waiting-subagents" ? current.since : (host.now ?? Date.now)();
  host.setActivity(waitingSubagentsActivity(targets, since));
}

export function refreshDelegationWait(host: DelegationWaitHost): void {
  const targets = host.getTargets();
  const current = host.getActivity();
  if (!targets || current?.phase !== "waiting-subagents") return;
  if (!targets.some((record) => record.status === "running")) return;
  host.setActivity(waitingSubagentsActivity(targets, current.since));
}

export function endDelegationWait(host: DelegationWaitHost): void {
  host.setTargets(undefined);
  if (host.getActivity()?.phase === "waiting-subagents") host.clearActivity();
}

/** A retained live loop handle, narrowed to the progress read. */
export type DelegationProgressRun = Pick<SubagentRun, "progress">;

/**
 * Fold the live loop's own counters into the record. The run's usage is
 * already cumulative and operation-identified, so merging it with
 * envelope-merged rows is idempotent: the ledger never double-charges a
 * physical request no matter which path reported it first.
 */
export function refreshDelegationProgress(
  record: {
    turns: number;
    toolCalls: number;
    usage?: MessageUsage;
    contextTokens?: number;
    run?: DelegationProgressRun | null;
  },
): void {
  const progress = record.run?.progress?.();
  if (!progress) return;
  record.turns = Math.max(record.turns, progress.turns);
  record.toolCalls = Math.max(record.toolCalls, progress.toolCalls);
  if (progress.usage) record.usage = addUsage(record.usage, progress.usage);
  if (progress.contextTokens !== undefined) {
    record.contextTokens = progress.contextTokens;
  }
}

type SnapshotEmission = {
  event: AgentEventEnvelope["event"];
  turnId?: string;
};

/**
 * Settlement snapshot for the original `Task` row, or `undefined` when the
 * row is not yet recorded (fast settle before `tool_end`) or already
 * current (a running record whose model did not move).
 */
export function settlementSnapshotEvent(
  record: DelegationRecord,
): SnapshotEmission | undefined {
  if (!record.taskMessage) return undefined;
  const original = record.taskMessage.toolResult;
  const details =
    isRecord(original) && isRecord(original.details) ? original.details : undefined;
  if (
    record.status === "running" &&
    details?.modelId === record.modelId &&
    details?.thinkingLevel === record.thinkingLevel
  ) {
    return undefined;
  }
  return {
    event: {
      type: "message_end",
      message: settledDelegationMessage(record.taskMessage, delegationSummary(record)),
    },
    turnId: record.taskTurnId,
  };
}

/**
 * Terminal for a settled detached run's own execution turn. Attached runs
 * need none — the owning parent turn closes through its own model
 * lifecycle. A stopped/aborted run ends its turn the same truthful way a
 * parent abort does, so the turn never leaks as busy.
 */
export function userOwnedTerminalEvent(
  record: Pick<DelegationRecord, "delegationId" | "status" | "executionTurnId" | "taskTurnId">,
): SnapshotEmission | undefined {
  const turnId = record.executionTurnId ?? record.taskTurnId;
  if (!turnId) return undefined;
  if (record.status === "stopped" || record.status === "aborted") {
    return {
      event: {
        type: "error",
        error: {
          code: "TURN_ABORTED",
          message: `Delegation "${record.delegationId}" ended as ${record.status}.`,
          retriable: false,
        },
      },
      turnId,
    };
  }
  return { event: { type: "agent_end", messageIds: [] }, turnId };
}

/**
 * Live snapshot for the original `Task` row while the delegate still runs:
 * one emission per child turn carrying current metrics.
 */
export function progressSnapshotEvent(
  record: DelegationRecord,
): SnapshotEmission | undefined {
  if (!record.taskMessage || record.status !== "running") return undefined;
  return {
    event: {
      type: "message_end",
      message: settledDelegationMessage(record.taskMessage, delegationSummary(record)),
    },
    turnId: record.taskTurnId,
  };
}
