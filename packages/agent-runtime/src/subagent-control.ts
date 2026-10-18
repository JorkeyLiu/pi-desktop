/**
 * Delegation control: the guard, routing, settlement-transition, and
 * stop/list decisions for background delegates.
 *
 * Kept out of `runtime.ts` so the hotspot owns only thin call sites. Every
 * function here is either pure over its inputs or drives an explicit effects
 * interface; the runtime implements the effects against its own state. Error
 * identities (`errorCode`) are part of the contract: the sidecar and Electron
 * main surface them to the UI without reinterpreting the text.
 */

import { randomUUID } from "node:crypto";
import {
  addUsage,
  isUuid,
  type AgentEventEnvelope,
  type MessageUsage,
  type UiMessage,
  type AgentActivityAgentPhase,
  type SubagentWakeReason,
  type SubagentWaitStatus,
} from "@pi-desktop/shared";
import { nowIso, truncateTextWithMarker } from "./agent-messages.js";
import {
  MAX_SUBAGENT_REPORT_CHARS,
  type SubagentRunResult,
  type SubagentRunStatus,
} from "./subagent.js";
import {
  assembleWaitResult,
  delegationSummary,
  formatDelegationHeartbeat,
  refreshDelegationProgress,
  snapshotWaitRecord,
  type WaitResultSnapshot,
} from "./subagent-progress.js";
import type {
  DelegationRecord,
  DelegationStatus,
} from "./runtime.js";
import { markProgramDelivery } from "./delegation-coordinator.js";

function codedError(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/** The record fields a child steer decision reads. */
export type SteerTargetState = {
  delegationId: string;
  parentToolCallId: string;
  agentName: string;
  status: DelegationStatus;
  stopRequested: boolean;
  /** Whether the retained loop already settled (race with settlement). */
  settled: boolean;
  /** Whether a live loop handle exists to receive the steer. */
  hasLiveLoop: boolean;
  /**
   * Delivery of the target run. A `user`-owned run steers through its own
   * execution-accounting turn, independent of any parent turn.
   */
  delivery?: "parent" | "user";
  /** Execution-accounting turn owning a detached run. */
  executionTurnId?: string;
};

export type SteerOwnership = {
  expectedParentTurnId: unknown;
  currentTurnId?: string;
  /** False once the parent turn was cancelled, failed, or disposed. */
  turnAlive: boolean;
};

export type SteerInput = {
  delegationId: unknown;
  text: unknown;
  messageId?: unknown;
};

export type ValidatedSubagentSteer =
  | {
      outcome: "steer";
      delegationId: string;
      text: string;
      message: UiMessage;
    }
  | { outcome: "already-applied"; delegationId: string };

/**
 * Decide one child steer without touching any loop.
 *
 * Guards, in order: identity, liveness (a settled delegate names its
 * `Task(resume)` even after the turn ended), then the owning turn. An
 * attached run steers through the live parent turn it names; a detached
 * user-owned run steers through its own execution-accounting turn,
 * independent of any parent turn. The echo id keeps a caller-provided UUID
 * and otherwise mints runtime identity (D288-style); a repeated id for the
 * same delegation reports `already-applied` so the child executes the steer
 * exactly once and the echo is emitted exactly once. Throws coded rejections
 * otherwise.
 */
export function validateSubagentSteer(
  record: SteerTargetState | undefined,
  request: SteerInput,
  ownership: SteerOwnership,
  seenMessageIds?: Set<string>,
): ValidatedSubagentSteer {
  const delegationId =
    typeof request.delegationId === "string" ? request.delegationId.trim() : "";
  if (!delegationId) {
    throw codedError("delegationId required", "DELEGATION_NOT_FOUND");
  }
  if (!record) {
    throw codedError(
      `Unknown delegation "${delegationId}". Call TaskList to see them.`,
      "DELEGATION_NOT_FOUND",
    );
  }
  const rawText = typeof request.text === "string" ? request.text : "";
  if (!rawText.trim()) {
    throw codedError("Steering text required", "INVALID_ARGUMENT");
  }
  if (
    record.status !== "running" ||
    record.stopRequested ||
    record.settled ||
    !record.hasLiveLoop
  ) {
    throw codedError(
      record.stopRequested
        ? `Delegation "${delegationId}" is stopping; start a new delegation or resume it after it settles with Task(resume: "${delegationId}").`
        : `Delegation "${delegationId}" already settled; continue it with Task(resume: "${delegationId}").`,
      "DELEGATION_NOT_RUNNING",
    );
  }
  if ((record.delivery ?? "parent") === "user") {
    // Detached runs answer to their execution owner, never to a parent turn.
    const expected =
      typeof ownership.expectedParentTurnId === "string"
        ? ownership.expectedParentTurnId.trim()
        : "";
    if (!expected || expected !== (record.executionTurnId ?? "").trim()) {
      throw codedError("The target turn has ended", "TURN_NOT_FOUND");
    }
  } else if (
    !ownership.expectedParentTurnId ||
    ownership.expectedParentTurnId !== ownership.currentTurnId ||
    !ownership.turnAlive
  ) {
    throw codedError("The target turn has ended", "TURN_NOT_FOUND");
  }
  const candidateId =
    typeof request.messageId === "string" ? request.messageId.trim() : "";
  const messageId = isUuid(candidateId) ? candidateId : randomUUID();
  if (seenMessageIds?.has(messageId)) {
    return { outcome: "already-applied", delegationId };
  }
  const message: UiMessage = {
    id: messageId,
    role: "user",
    content: rawText,
    createdAt: nowIso(),
    status: "complete",
    steering: true,
    parentToolCallId: record.parentToolCallId,
    agentName: record.agentName,
  };
  return { outcome: "steer", delegationId, text: rawText, message };
}

/**
 * Shared cancellation for `TaskStop` and explicit desktop controls.
 * Mutates only the target records; the caller awaits their completion.
 */
export async function stopSubagentRecords(
  records: DelegationRecord[],
  ids: string[] = [],
): Promise<{
  content: [{ type: "text"; text: string }];
  details: {
    stopped: Array<Record<string, unknown>>;
    stopPending?: Array<Record<string, unknown>>;
    settled?: Array<Record<string, unknown>>;
  };
}> {
  const targets = ids.length
    ? [...new Set(ids)]
        .map((id) => records.find((record) => record.delegationId === id))
        .filter(
          (record): record is DelegationRecord =>
            record !== undefined && record.status === "running",
        )
    : records.filter((record) => record.status === "running");
  for (const record of targets) {
    record.stopRequested = true;
    record.abort();
  }
  // Cancellation is cooperative: bound the wait so a worker that ignores
  // abort cannot wedge the caller. Still-running workers are
  // explicitly returned as pending, never mislabeled as stopped.
  let stopTimeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(targets.map((record) => record.completion)),
    new Promise<void>((resolve) => {
      stopTimeout = setTimeout(resolve, 5_000);
    }),
  ]);
  if (stopTimeout !== undefined) clearTimeout(stopTimeout);
  const pending = targets.filter((record) => record.status === "running");
  const stopped = targets.filter((record) => record.status === "stopped");
  const settled = targets.filter(
    (record) => record.status !== "running" && record.status !== "stopped",
  );
  const text =
    targets.length === 0
      ? "No matching running subagents to stop."
      : pending.length > 0
        ? `Cancellation requested for ${targets.length} subagent${targets.length === 1 ? "" : "s"}; ${pending.length} have not confirmed termination and remain running.`
        : settled.length > 0
          ? `Cancellation settled for ${targets.length} subagent${targets.length === 1 ? "" : "s"}: ${stopped.length} stopped and ${settled.length} had already finished.`
          : `Stopped ${stopped.length} subagent${stopped.length === 1 ? "" : "s"}.`;
  return {
    content: [{ type: "text" as const, text }],
    details: {
      stopped: stopped.map(delegationSummary),
      ...(pending.length > 0
        ? { stopPending: pending.map(delegationSummary) }
        : {}),
      ...(settled.length > 0
        ? { settled: settled.map(delegationSummary) }
        : {}),
    },
  };
}

/**
 * Apply an accepted steer: drive the retained loop, then persist and emit
 * the attributed echo exactly once. A loop that settled in the race reads
 * as `DELEGATION_NOT_RUNNING` (the caller continues with `Task(resume)`).
 */
export function applyValidatedSteer(
  validated: Extract<ValidatedSubagentSteer, { outcome: "steer" }>,
  deps: {
    sessionId: string;
    ownerTurnId: string;
    parentToolCallId: string;
    agentName: string;
    steerLoop: (text: string) => void;
    markSteered: (messageId: string) => void;
    appendRow: (envelope: AgentEventEnvelope, message: UiMessage) => void;
    emit: (envelope: AgentEventEnvelope) => void;
  },
): void {
  const envelope = (event: AgentEventEnvelope["event"]): AgentEventEnvelope => ({
    sessionId: deps.sessionId,
    turnId: deps.ownerTurnId,
    ts: Date.now(),
    event,
    parentToolCallId: deps.parentToolCallId,
    agentName: deps.agentName,
  });
  try {
    deps.steerLoop(validated.text);
  } catch {
    throw codedError(
      `Delegation "${validated.delegationId}" settled before the steering arrived; continue it with Task(resume: "${validated.delegationId}").`,
      "DELEGATION_NOT_RUNNING",
    );
  }
  deps.markSteered(validated.message.id);
  // Chain replay, not parent model context: the row is tagged, so the
  // parent's rebuild skips it while `selectChainRows` finds it for resume.
  deps.appendRow(envelope({ type: "message_end", message: validated.message }), validated.message);
  deps.emit(envelope({ type: "message_start", message: validated.message }));
  deps.emit(envelope({ type: "message_end", message: validated.message }));
}

export type DelegationActivityHost = {
  touchPhase: (
    record: DelegationRecord,
    phase: AgentActivityAgentPhase,
    toolName?: string,
  ) => void;
  delegateToolCalls: Map<string, { name: string; args: unknown }>;
  appendRow: (
    record: DelegationRecord,
    envelope: AgentEventEnvelope,
    row: UiMessage,
  ) => void;
  toolRow: (envelope: AgentEventEnvelope) => UiMessage;
  publishProgress: (record: DelegationRecord) => void;
  notifyWaiters: () => void;
};

/** Route one delegate event into counters, history, metrics, and waiters. */
export function applyDelegationActivity(
  host: DelegationActivityHost,
  record: DelegationRecord,
  envelope: AgentEventEnvelope,
): void {
  routeDelegationEvent(record, envelope, {
    touchActivity: () => {
      record.lastActivityAt = Date.now();
    },
    touchPhase: (phase, toolName) => host.touchPhase(record, phase, toolName),
    trackToolCall: (toolCallId, name, args) => {
      host.delegateToolCalls.set(toolCallId, { name, args });
      (record.pendingToolCallIds ??= new Set()).add(toolCallId);
    },
    appendAssistant: (message) => host.appendRow(record, envelope, message),
    appendToolResult: (toolEnvelope) => {
      host.appendRow(record, toolEnvelope, host.toolRow(toolEnvelope));
      const toolCallId = (toolEnvelope.event as { toolCallId: string }).toolCallId;
      host.delegateToolCalls.delete(toolCallId);
      record.pendingToolCallIds?.delete(toolCallId);
    },
    mergeUsage: (usage) => {
      record.usage = addUsage(record.usage, usage);
    },
    refreshProgress: () => refreshDelegationProgress(record),
    publishProgress: () => host.publishProgress(record),
    notifyWaiters: () => host.notifyWaiters(),
  });
}

/**
 * Read-only delegation listing for the parent model's `TaskList`.
 * User-owned runs are the user's own followups, not the parent's delegates:
 * the parent neither waits on them nor resumes them implicitly, so they stay
 * out of its listing (an explicit parent `Task(resume)` reattaches the chain
 * as a new parent-owned run, which lists normally).
 */
export function listDelegationRecords(records: DelegationRecord[]): {
  content: [{ type: "text"; text: string }];
  details: { delegations: Array<Record<string, unknown>> };
} {
  const sorted = [...records]
    .filter((record) => (record.delivery ?? "parent") === "parent")
    .sort((left, right) => left.startedAt - right.startedAt);
  const text =
    sorted.length === 0
      ? "No subagents have been started in this session."
      : sorted.map((record) => `- ${formatDelegationHeartbeat(record)}`).join("\n");
  return {
    content: [{ type: "text" as const, text }],
    details: { delegations: sorted.map(delegationSummary) },
  };
}

/** Narrow view of the `tool_start` agent event; the envelope carries the rest. */
type ToolStartEvent = {
  type: "tool_start";
  toolCallId: string;
  toolName: string;
  args?: unknown;
};

/** Runtime-owned side effects behind delegation event routing. */
export type DelegationActivityEffects = {
  touchActivity: () => void;
  touchPhase: (phase: AgentActivityAgentPhase, toolName?: string) => void;
  trackToolCall: (toolCallId: string, name: string, args: unknown) => void;
  appendAssistant: (message: UiMessage) => void;
  appendToolResult: (envelope: AgentEventEnvelope) => void;
  mergeUsage: (usage: MessageUsage) => void;
  refreshProgress: () => void;
  publishProgress: () => void;
  notifyWaiters: () => void;
};

/**
 * Route one delegate event into counters, transcript history, live metrics,
 * and wake re-evaluation. Mirrors the parent's turn-boundary accounting:
 * `turn_start` counts, `tool_start` counts and pins arguments for replay,
 * `tool_end` releases them, `usage`/`message_end` merge spend by operation
 * identity and refresh the persisted Task snapshot.
 */
export function routeDelegationEvent(
  record: {
    lastActivityAt: number;
    turns: number;
    toolCalls: number;
    pendingToolCallIds?: Set<string>;
  },
  envelope: AgentEventEnvelope,
  effects: DelegationActivityEffects,
): void {
  effects.touchActivity();
  const event = envelope.event;
  if (event.type === "turn_start") {
    record.turns += 1;
    effects.touchPhase("waiting-model");
    effects.notifyWaiters();
    return;
  }
  if (event.type === "tool_start") {
    record.toolCalls += 1;
    effects.touchPhase("tool", event.toolName);
    // The row a later `resume` replays needs the call's arguments, and
    // `tool_end` carries only the result (ADR 0279 §3).
    effects.trackToolCall(
      event.toolCallId,
      event.toolName,
      (envelope.event as ToolStartEvent).args,
    );
    (record.pendingToolCallIds ??= new Set()).add(event.toolCallId);
    effects.notifyWaiters();
    return;
  }
  if (event.type === "tool_end") {
    effects.touchPhase("waiting-model");
    effects.appendToolResult(envelope);
    record.pendingToolCallIds?.delete(event.toolCallId);
    effects.notifyWaiters();
    return;
  }
  if (event.type === "usage") {
    // A compaction summary spent a real provider request: merge it into the
    // record by operation identity, so a re-report never double-charges.
    if (event.usage) effects.mergeUsage(event.usage);
    effects.notifyWaiters();
    return;
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    effects.appendAssistant(event.message);
    if (event.message.usage) {
      effects.mergeUsage(event.message.usage);
    }
    effects.refreshProgress();
    // One Task snapshot per child turn: the persisted row carries live
    // metrics without waiting for settlement.
    effects.publishProgress();
    effects.notifyWaiters();
  }
  if (
    (event.type === "message_start" || event.type === "message_update") &&
    event.message.role === "assistant"
  ) {
    const thinking = Boolean(
      event.message.thinking?.trim() ||
        (event.type === "message_update" && event.deltaThinking),
    );
    const text = Boolean(
      event.message.content?.trim() ||
        (event.type === "message_update" && event.deltaText),
    );
    if (thinking && !text) effects.touchPhase("thinking");
  }
}

/** Runtime-owned side effects behind delegation settlement. */
export type DelegationSettleEffects = {
  sessionId: string;
  addTurnUsage: (usage?: MessageUsage) => void;
  settleChain: (delegateSessionId: string, status: string) => void;
  dropPendingToolCalls: (toolCallIds: Set<string>) => void;
  publishSettlement: () => void;
  clearMutationRecovery: (delegationId: string) => void;
  refreshWait: () => void;
  refreshPrompt: () => void;
  prune: () => void;
  notifyWaiters: () => void;
};

/** Map a settled run onto its registry status. */
export function nextDelegationStatus(
  stopRequested: boolean,
  resultStatus: SubagentRunStatus,
): DelegationStatus {
  return stopRequested && resultStatus === "aborted" ? "stopped" : resultStatus;
}

/**
 * Record a settled run: resolve first so no side effect strands `TaskWait`
 * or the idle resume, then fold spend (idempotently), settle the chain,
 * publish, and refresh every wait that reads this record.
 */
export function settleDelegationRecord(
  record: DelegationRecord,
  result: SubagentRunResult,
  effects: DelegationSettleEffects,
): void {
  if (record.status !== "running") return;
  let settled = result;
  if (result.status === "aborted" && record.parentErrorInterrupted && !record.stopRequested) {
    const message = `The parent turn failed and interrupted this delegation. Continue it with Task(resume: "${record.delegationId}").`;
    settled = {
      ...result,
      status: "failed",
      report: truncateTextWithMarker(`${message}\n\n${result.report}`, MAX_SUBAGENT_REPORT_CHARS, "\n[report truncated]\n"),
      error: { code: "SUBAGENT_PARENT_FAILED", message, resumeId: record.delegationId },
    };
  }
  record.status = nextDelegationStatus(record.stopRequested, settled.status);
  record.result = settled;
  record.completedAt = Date.now();
  // Resolve before event publication or bookkeeping: none of those side
  // effects may strand TaskWait or the parent's idle auto-resume.
  record.resolveCompletion();
  try {
    if (settled.usage) {
      effects.addTurnUsage(settled.usage);
    }
    // Authoritative final spend, merged by operation identity over whatever
    // the live path already reported: re-reports collapse, never duplicate.
    record.usage = addUsage(record.usage, settled.usage);
    refreshDelegationProgress(record);
    effects.settleChain(record.delegateSessionId, record.status);
    // An aborted call never sends `tool_end`, so a settled run drops whatever
    // its calls left behind rather than pinning those arguments for the session.
    if (record.pendingToolCallIds) {
      effects.dropPendingToolCalls(record.pendingToolCallIds);
    }
    record.pendingToolCallIds = undefined;
    effects.publishSettlement();
  } catch {
    process.stderr.write(
      `[agent-runtime] delegation settlement side effect failed (session=${effects.sessionId} delegation=${record.delegationId})\n`,
    );
  } finally {
    effects.clearMutationRecovery(record.delegationId);
    effects.refreshWait();
    effects.refreshPrompt();
    effects.prune();
    effects.notifyWaiters();
  }
}

/** Plain-data inputs for one wait's model-facing note. */
export type WaitNoteInput = {
  interrupted: boolean;
  timedOut: boolean;
  /** Configured progress-wait seconds when a periodic wake returned. */
  deadlineSeconds: number | null;
  wakeReason?: SubagentWakeReason;
  wakeDelegationIds: string[];
  mode: "all" | "any";
  settledCount: number;
  targetCount: number;
  unknownIds: string[];
  /** Live per-running-delegate lines accompanying a progress wait note. */
  runningHeartbeats: string[];
};

/**
 * Compose one wait's note: interruption, cancellation, still-running
 * heartbeat, threshold wakes, and unknown ids. Completion always delivers,
 * so there is no held-report branch. A progress-wait note carries the
 * still-running per-delegate heartbeat lines so the parent sees who is left
 * without another `TaskList` round trip.
 */
export function buildWaitNote(input: WaitNoteInput): string | undefined {
  const wakeNote =
    input.wakeReason === "tool-calls"
      ? `Woke after more tool calls (${input.wakeDelegationIds.join(", ")}). Unfinished delegates keep working; wait again to converge.`
      : input.wakeReason === "context-tokens"
        ? `Woke as delegate context estimates crossed the threshold (${input.wakeDelegationIds.join(", ")}). Unfinished delegates keep working; wait again to converge.`
        : undefined;
  const runningNote =
    input.timedOut && input.deadlineSeconds === null
      ? "The wait ended before its delegates settled (stopped or cancelled). Settle or re-wait to converge; settled reports stay durable."
      : input.timedOut
        ? [
            `Still running after ${input.deadlineSeconds}s: ${input.settledCount}/${input.targetCount} finished. This is not a failure — unfinished delegates keep working and the runtime will deliver their reports when they finish. Call TaskStop only to cancel.`,
            ...input.runningHeartbeats,
          ].join("\n")
        : undefined;
  const unknownNote =
    input.unknownIds.length > 0
      ? `Unknown delegation ids (not found in this session): ${input.unknownIds.join(", ")}.`
      : undefined;
  const base =
    runningNote ??
    wakeNote ??
    (input.mode === "any"
      ? `Converged after ${input.settledCount} of ${input.targetCount} finished.`
      : undefined);
  const note = input.interrupted
    ? "Interrupted by new user input. Unfinished subagents keep working; handle the user's message before waiting again."
    : base;
  return (
    [note, unknownNote].filter(Boolean).join("\n") ||
    undefined
  );
}

/**
 * Finish one wait: bounded note, assembled result, exactly-once delivery
 * marking for the included settled records, and the result status. Omitted
 * reports stay pending; running delegates keep their future report.
 */
export function finalizeWaitResult(options: {
  targets: DelegationRecord[];
  snapshots: WaitResultSnapshot[];
  interrupted: boolean;
  timedOut: boolean;
  deadlineSeconds: number | null;
  wakeReason?: SubagentWakeReason;
  wakeDelegationIds: string[];
  mode: "all" | "any";
  unknownIds: string[];
}): {
  content: [{ type: "text"; text: string }];
  details: {
    status: SubagentWaitStatus;
    wakeReason?: SubagentWakeReason;
    wakeDelegationIds?: string[];
    unknownIds?: string[];
    delegations: Array<WaitResultSnapshot & { metrics: string }>;
  };
} {
  const settledCount = options.snapshots.filter(
    (snapshot) => snapshot.status !== "running",
  ).length;
  const note = buildWaitNote({
    interrupted: options.interrupted,
    timedOut: options.timedOut,
    deadlineSeconds: options.deadlineSeconds,
    ...(options.wakeReason ? { wakeReason: options.wakeReason } : {}),
    wakeDelegationIds: options.wakeDelegationIds,
    mode: options.mode,
    settledCount,
    targetCount: options.targets.length,
    unknownIds: options.unknownIds,
    runningHeartbeats: options.targets
      .filter((record) => record.status === "running")
      .map(formatDelegationHeartbeat),
  });
  const assembled = assembleWaitResult(options.snapshots, note);
  markProgramDelivery(options.targets, assembled.includedDelegationIds);
  const status = subagentWaitStatus({
    interrupted: options.interrupted,
    timedOut: options.timedOut,
    ...(options.wakeReason ? { wakeReason: options.wakeReason } : {}),
  });
  return {
    content: [{ type: "text" as const, text: assembled.text }],
    details: {
      status,
      ...(options.wakeReason ? { wakeReason: options.wakeReason } : {}),
      ...(options.wakeDelegationIds.length > 0 && !options.interrupted
        ? { wakeDelegationIds: options.wakeDelegationIds }
        : {}),
      ...(options.unknownIds.length ? { unknownIds: options.unknownIds } : {}),
      delegations: assembled.delegations,
    },
  };
}

/**
 * Shared small result builder for program waits (TaskList active path and
 * any future coordinator consumer): maps one coordinator wake outcome onto
 * `finalizeWaitResult` inputs with mode `any`. The runtime supplies the
 * coordinator plan + outcome; delivery marking stays inside the finalizer.
 */
export function programWaitResult(options: {
  targets: DelegationRecord[];
  wakeOutcome: {
    timedOut: boolean;
    deadlineKind: "timeout" | "time" | null;
    wakeReason?: SubagentWakeReason;
    wakeDelegationIds: string[];
  };
  planDeadlineKind: "time" | null;
  planWakeSeconds: number | null;
  interrupted: boolean;
}): {
  content: [{ type: "text"; text: string }];
  details: {
    status: SubagentWaitStatus;
    wakeReason?: SubagentWakeReason;
    wakeDelegationIds?: string[];
    unknownIds?: string[];
    delegations: Array<WaitResultSnapshot & { metrics: string }>;
  };
} {
  const effectiveKind = options.wakeOutcome.deadlineKind ?? options.planDeadlineKind;
  const wakeReason = options.interrupted
    ? undefined
    : (options.wakeOutcome.wakeReason ??
      (options.wakeOutcome.timedOut && effectiveKind === "time" ? "time" : undefined));
  return finalizeWaitResult({
    targets: options.targets,
    snapshots: options.targets.map(snapshotWaitRecord),
    interrupted: options.interrupted,
    timedOut: !options.interrupted && options.wakeOutcome.timedOut,
    deadlineSeconds: options.planWakeSeconds,
    ...(wakeReason ? { wakeReason } : {}),
    wakeDelegationIds: options.wakeOutcome.wakeDelegationIds,
    mode: "any",
    unknownIds: [],
  });
}

/**
 * Map one wait's outcome onto its `TaskWait` result status. Completion and
 * periodic time wakes are the only outcomes the program wait produces, so a
 * timed-out wait reads as a `wakeup` (the historic `timeout` member stays in
 * the union for older persisted/UI consumers but is never generated).
 */
export function subagentWaitStatus(input: {
  interrupted: boolean;
  timedOut: boolean;
  wakeReason?: SubagentWakeReason;
}): SubagentWaitStatus {
  if (input.interrupted) return "interrupted";
  if (input.timedOut) return "wakeup";
  return input.wakeReason === "completion" || input.wakeReason === undefined
    ? "completed"
    : "wakeup";
}
