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
  type DelegationHandoffCheckpoint,
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
import type { SubagentHandoffPersistenceError } from "./subagent-handoff.js";

/**
 * One wait-result *batch* is sized so a large fan-out cannot dump every report
 * into the parent's context at once. The bound is a batching rule, never a
 * content rule: at least one settled report is always delivered whole, even
 * when that single report alone exceeds the budget, and a report deferred here
 * stays pending delivery — `TaskWait` returns it by id on a later batch and the
 * idle resume prompts with it. Nothing is clipped or dropped permanently.
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

/**
 * Everything a read-only delegation listing or snapshot reads.
 *
 * Structural on purpose: a live `DelegationRecord` satisfies it, and so does a
 * plain-data entry recovered from persisted history, which holds no run handle,
 * no completion promise, and no abort path. `recovered` marks the latter so a
 * listing can say the run is not active in this process.
 */
export type DelegationView = {
  delegationId: string;
  agentName: string;
  modelId?: string;
  thinkingLevel?: SubagentThinkingLevel;
  status: string;
  startedAt: number;
  /** End of the observed run, for settled and interrupted entries alike. */
  completedAt?: number;
  /** Last observed activity: the elapsed bound of a recovered entry. */
  lastActivityAt?: number;
  turns?: number;
  toolCalls?: number;
  usage?: MessageUsage;
  contextTokens?: number;
  lastToolName?: string;
  executionTurnId?: string;
  resumedFrom?: string;
  modelChangedFrom?: string;
  delivery?: "parent" | "user";
  handoffCheckpoint?: DelegationHandoffCheckpoint;
  handoffCheckpointError?: SubagentHandoffPersistenceError;
  /** Settled live result, when the record holds one. */
  result?: {
    turns?: number;
    toolCalls?: number;
    usage?: MessageUsage;
    error?: { code: string; message: string };
    report?: string;
    modelFailures?: readonly unknown[];
    contextCompactions?: number;
    contextDegraded?: boolean;
    scratchReportPath?: string;
    handoffCheckpointError?: SubagentHandoffPersistenceError;
  };
  /** True for an entry rebuilt from history: nothing runs for it here. */
  recovered?: true;
};

export function delegationSummary(record: DelegationView): Record<string, unknown> {
  return {
    delegationId: record.delegationId,
    agent: record.agentName,
    ...(record.modelId ? { modelId: record.modelId } : {}),
    ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
    status: record.status,
    startedAt: record.startedAt,
    turns: record.result?.turns ?? record.turns ?? 0,
    toolCalls: record.result?.toolCalls ?? record.toolCalls ?? 0,
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
    // The installed handoff boundary survives every later snapshot of this
    // row, so a settled `Task` row still names the boundary its chain honours.
    ...(record.handoffCheckpoint
      ? { handoffCheckpoint: record.handoffCheckpoint }
      : {}),
    // A boundary the run installed but could not persist is part of the run's
    // observable state, not a write-time footnote: both the live summary and
    // the settled one name it, so `TaskWait` and any lifecycle consumer see
    // that the durable chain fell back to an older boundary or full history.
    ...(record.handoffCheckpointError ?? record.result?.handoffCheckpointError
      ? {
          handoffCheckpointError:
            record.handoffCheckpointError ??
            record.result!.handoffCheckpointError,
        }
      : {}),
    // A recovered entry is history: no run of it is active in this process.
    ...(record.recovered ? { recovered: true as const } : {}),
  };
}

export function formatDelegationHeartbeat(record: DelegationView): string {
  const parts = [
    `${record.agentName} (${record.delegationId})`,
    record.status,
    `${elapsedSeconds(
      {
        startedAt: record.startedAt,
        // A recovered run has no clock of its own: it stopped when it was last
        // observed, so elapsed history never keeps growing after a restart.
        ...(record.completedAt !== undefined
          ? { completedAt: record.completedAt }
          : record.recovered && record.lastActivityAt !== undefined
            ? { completedAt: record.lastActivityAt }
            : {}),
      },
    )}s`,
  ];
  const turns = record.result?.turns ?? record.turns ?? 0;
  const toolCalls = record.result?.toolCalls ?? record.toolCalls ?? 0;
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
  if (record.recovered) {
    parts.push("recovered from history; not running in this process");
  }
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
  /** An installed handoff whose durable checkpoint write failed. */
  handoffCheckpointError?: SubagentHandoffPersistenceError;
  scratchReportPath?: string;
  usage?: MessageUsage;
  contextTokens?: number;
  report: string;
  /** True when the snapshot was rebuilt from persisted history, not a live run. */
  recovered?: true;
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
    ...(record.handoffCheckpointError ?? record.result?.handoffCheckpointError
      ? {
          handoffCheckpointError:
            record.handoffCheckpointError ??
            record.result!.handoffCheckpointError,
        }
      : {}),
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

/**
 * Join delegation results into one text block for the model.
 *
 * Batching rule: a block is deferred only when it does not fit the batch and
 * an settled report was already delivered in this batch. The first settled
 * report is always delivered whole — a single long report can therefore
 * exceed `MAX_TASKWAIT_RESULT_CHARS` on its own. A deferred report keeps its
 * `reportDelivered` marker untouched, so `TaskWait` returns it in a later
 * batch and the idle resume prompts with it; the marker says exactly that and
 * never implies the text was clipped.
 */
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
  let deliveredSettledReport = false;
  for (const result of results) {
    const header = `## ${result.agent} (${result.delegationId}) — ${result.status}${result.metrics ? ` · ${result.metrics}` : ""}`;
    const block = `${header}\n${result.report}`;
    const settled = result.status !== "running";
    const withinBatch = total + block.length <= MAX_TASKWAIT_RESULT_CHARS;
    if (!withinBatch && !(settled && !deliveredSettledReport)) {
      omitted += 1;
      continue;
    }
    parts.push(block);
    includedDelegationIds.add(result.delegationId);
    if (settled) deliveredSettledReport = true;
    total += block.length + 2;
  }
  if (omitted > 0) {
    parts.push(
      `[${omitted} of ${results.length} result${results.length === 1 ? "" : "s"} deferred to keep this batch bounded; call TaskWait with their delegationIds to read them in a later batch. No report is truncated or lost.]`,
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
    // The durable tool row's own identity (host-side persistence writes the
    // bare call id too), so a live transcript and a `session.get` replay agree
    // on which row a handoff boundary names.
    id: event.toolCallId,
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

/**
 * Growth of the live streamed row that triggers one mid-stream occupancy
 * re-read and wake re-evaluation.
 *
 * A provider emits one delta per token, but the estimate behind the
 * `context-tokens` wake covers the whole context: re-reading it per delta would
 * turn one response into thousands of full-context estimates. One read per
 * ~150 estimated tokens keeps a crossing visible inside the same response while
 * bounding that work by content growth, not by token count. Clock-free on
 * purpose: no timer, no polling loop.
 *
 * A frame that grows the estimate without growing visible text (streamed
 * tool-call arguments) is emitted on this same cadence, so the gate has
 * something to read when the transcript row stays still.
 */
export const STREAM_PROGRESS_EVALUATION_CHARS = 512;
