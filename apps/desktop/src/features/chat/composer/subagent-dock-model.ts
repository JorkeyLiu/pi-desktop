import type { MessageUsage, UiMessage } from "@pi-desktop/shared";
import {
  assistantTurnTools,
  type AssistantActivityItem,
  type TranscriptEntry,
} from "../../../lib/assistant-turns";
import { collectLiveDelegationEntries } from "../../../lib/live-delegation-entries";
import { subagentChainLatestDelegationId } from "../../../lib/subagent-chain";
import { aggregateChainMetricsFromMessages } from "../../../lib/subagent-metrics";
import { subagentTaskTitle } from "../../../lib/subagent-title";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
  delegationIsCreating,
  isDelegationActivityItem,
  subagentOutcome,
} from "../../../lib/subagent-topology";
import { toolResultPayload } from "../../../lib/tool-presentation";

/**
 * One child agent that is still running somewhere in the open session.
 *
 * `delegationId` is absent only while the delegate runtime is still spawning:
 * a `Task` call returns its handle at its own `tool_end` (ADR 0089), so before
 * that result lands there is no id to stop or to open a chain tab for.
 */
export type DockSubagent = {
  /** Stable row identity while the handle is missing: the call's own id. */
  key: string;
  delegationId?: string;
  /** Original `Task` description of the chain, else the role that runs it. */
  title: string;
  role: string;
  creating: boolean;
  /** `startedAt` from the runtime, or the call's timestamp while creating. */
  startedAt?: number;
  /**
   * The child's own execution counters, as the runtime last reported them.
   *
   * Absent when nothing has been reported yet — a still-spawning child, or a
   * run that has produced no result, no lifecycle roster row, and no child
   * usage so far. The row then keeps the same four labelled placeholders every
   * other row holds (`Turns — · Tool calls — · Context — · Spent —`) rather
   * than a zero the runtime never sent.
   */
  metrics?: DockSubagentMetrics;
};

/**
 * Progress the runtime itself reported for one running child.
 *
 * `turns` and `toolCalls` are the child's own counters, `contextTokens` the
 * occupancy of the child's own window, and `usage` its own cumulative billed
 * spend — never the parent's context and never a figure read off the parent
 * transcript. Provenance is the shared chain aggregation
 * (`aggregateChainMetricsFromMessages`), so the dock and the chain panel cannot
 * disagree: Task snapshots first, lifecycle roster rows second, the child's own
 * reported usage last.
 */
export type DockSubagentMetrics = {
  /** Turns the runtime reported; absent when it never reported any. */
  turns?: number;
  /** Tool calls the runtime reported; absent when it never reported any. */
  toolCalls?: number;
  contextTokens?: number;
  /** True when the occupancy is an estimate rather than a runtime report. */
  contextEstimated?: boolean;
  /** The child's own cumulative spend, reported through the same chain. */
  usage?: MessageUsage;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** A `Task` call's own timestamp, the only start a creating row can report. */
function callStartedAt(message: UiMessage): number | undefined {
  if (!message.createdAt) return undefined;
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Every child agent still running in this session's live turns.
 *
 * The dock is a second *reader* of the transcript, never a second authority:
 * the caller hands it the same chat projection (`getTranscriptProjection`) and
 * the same running flag the transcript uses, so the live set is
 * `collectLiveDelegationEntries` — the bounded trace that starts at the tail
 * and stops at the last user message. A delegation whose parent turn is no
 * longer live is reconstructed exactly as the transcript reconstructs it
 * (`collectDelegationStatuses` with `turnLive: false` turns every leftover
 * `running` into `aborted`), and an `aborted` node is not running, so it is not
 * a row: completed, stopped, failed, timed-out, interrupted and
 * runtime-restart leftovers never clutter the dock.
 *
 * Consequence worth keeping: entries outside the live set are skipped instead
 * of computed. That is the same answer — a non-live entry can only produce
 * settled outcomes — and it keeps a long transcript from being re-walked on
 * every streamed token.
 *
 * Rows are deduplicated per resume chain, so a `Task(resume …)` continuation
 * replaces the earlier run of the same work instead of adding a second row,
 * and the row keeps the chain's original description as its title.
 *
 * Each row also carries the child's own reported counters, read from the same
 * chain aggregation the chain panel uses. They are asked for only on the live
 * rows the dock actually shows, so the added work is bounded by the running
 * set rather than the transcript length.
 */
export function collectDockSubagents({
  messages,
  history,
  tail,
  running,
}: {
  /** Full session messages: titles resolve across a whole resume chain. */
  messages: readonly UiMessage[];
  history: readonly TranscriptEntry[];
  tail: TranscriptEntry | undefined;
  running: boolean;
}): DockSubagent[] {
  if (!running) return [];
  const live = collectLiveDelegationEntries(history, tail, running);
  if (live.size === 0) return [];
  const entries = tail ? [...history, tail] : [...history];
  const rows = new Map<string, DockSubagent>();
  for (const entry of entries) {
    if (entry.kind !== "assistant-turn" || !live.has(entry.id)) continue;
    const items: AssistantActivityItem[] = assistantTurnTools(entry).map(
      (message) => ({ kind: "tool" as const, message }),
    );
    const statuses = collectDelegationStatuses(items, { turnLive: true });
    const timings = collectDelegationTimings(items);
    for (const item of items) {
      if (!isDelegationActivityItem(item)) continue;
      const { message } = item;
      const payload = asRecord(toolResultPayload(message));
      const rawId = payload?.delegationId;
      const delegationId = typeof rawId === "string" ? rawId.trim() : "";
      // A resumed chain is one piece of work: only its latest run is live.
      if (
        delegationId &&
        subagentChainLatestDelegationId(messages, delegationId) !== delegationId
      ) {
        continue;
      }
      if (subagentOutcome(message, statuses) !== "running") continue;
      const key = delegationId
        ? `delegation:${delegationId}`
        : `call:${message.toolCallId || message.id}`;
      if (rows.has(key)) continue;
      const role = stringField(payload, "agent") || stringField(asRecord(message.toolArgs), "agent");
      const timing = delegationId ? timings.get(delegationId) : undefined;
      const startedAt =
        timing?.startedAt ??
        timestamp(payload?.startedAt) ??
        callStartedAt(message);
      const metrics = delegationId
        ? dockSubagentMetrics(messages, delegationId)
        : undefined;
      rows.set(key, {
        key,
        ...(delegationId ? { delegationId } : {}),
        title:
          (delegationId ? subagentTaskTitle(messages, delegationId) : "") || role,
        role,
        creating: delegationIsCreating(message),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(metrics ? { metrics } : {}),
      });
    }
  }
  return [...rows.values()];
}

/**
 * The child's own reported counters for one live run, or `undefined` when the
 * runtime has not reported any yet.
 *
 * Read through the shared chain aggregation rather than off the parent
 * transcript: a `Task` snapshot, a `TaskWait`/`TaskList` roster row, or the
 * child's own provider usage under its call id. Nothing here can see the
 * parent's context, and a creating row — no delegation id, no reports — gets
 * no numbers instead of an invented zero. The cost is bounded by the live row
 * set, which is the only set the dock ever asks about.
 */
function dockSubagentMetrics(
  messages: readonly UiMessage[],
  delegationId: string,
): DockSubagentMetrics | undefined {
  const chain = aggregateChainMetricsFromMessages(messages, delegationId);
  if (!chain) return undefined;
  return {
    // A counter the chain never reported stays absent, so the row renders the
    // labelled dash rather than an invented zero.
    ...(chain.turns !== undefined ? { turns: chain.turns } : {}),
    ...(chain.toolCalls !== undefined ? { toolCalls: chain.toolCalls } : {}),
    ...(chain.contextTokens !== undefined
      ? { contextTokens: chain.contextTokens }
      : {}),
    ...(chain.contextEstimated ? { contextEstimated: true } : {}),
    ...(chain.usage ? { usage: chain.usage } : {}),
  };
}
/**
 * How long a row has been running, from its own start. Live elapsed is UI only:
 * a settled row never reaches the dock, and a missing start reports none.
 */
export function dockSubagentDuration(
  agent: DockSubagent,
  now: number,
): number | undefined {
  return agent.startedAt === undefined
    ? undefined
    : Math.max(0, now - agent.startedAt);
}
