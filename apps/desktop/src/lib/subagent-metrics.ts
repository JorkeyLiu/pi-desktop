import { addUsage, formatSubagentProgressMetrics } from "@pi-desktop/shared";
import type { MessageUsage, UiMessage } from "@pi-desktop/shared";
import { subagentChainCallIds } from "./subagent-chain";
import { contextOccupancyTokens } from "./context-usage";
import { delegationLifecycleKind } from "./tool-display";
import { delegationIdForMessage } from "./subagent-panel";
import { toolResultPayload } from "./tool-presentation";

export type SubagentContextProvenance =
  | "snapshot"
  | "lifecycle"
  | "child"
  | "unknown";

/**
 * The figures the renderer derives for one child, per segment and folded over a
 * chain.
 *
 * This is deliberately renderer-local and its counters are optional. The
 * runtime's own `SubagentProgressMetrics` always carries both counters, but a
 * historical Task payload (a resumed segment, a lifecycle roster row) may not:
 * "the child never reported this counter" and "the child reported zero" are
 * different facts, and only the second one is a figure. Callers render an
 * absent counter as the labelled dash, never as an invented zero.
 */
export type SubagentMetrics = {
  /** Turns the runtime reported; absent when it never reported any. */
  turns?: number;
  /** Tool calls the runtime reported; absent when it never reported any. */
  toolCalls?: number;
  /** Occupancy of the child's window; absent means "not reported". */
  contextTokens?: number;
  /** Cumulative billed spend, ledger-deduped by operation identity. */
  usage?: MessageUsage;
  /**
   * Where the chain's occupancy figure came from. `snapshot` is a Task result's
   * own `contextTokens`; `lifecycle` is a TaskWait/TaskList/TaskStop roster
   * entry for the same delegation; `child` is the latest valid child assistant
   * provider usage reported through the renderer's own occupancy semantics
   * (an honest estimate, flagged below). It always describes the figure that is
   * present: a later segment that reported no occupancy never relabels the
   * earlier figure it left standing. `unknown` means no segment of the chain
   * ever reported one, and callers must render `—`, never invent 0.
   */
  contextProvenance?: SubagentContextProvenance;
  /** True when the occupancy is an estimate rather than a runtime report. */
  contextEstimated?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function asUsage(value: unknown): MessageUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const total = record.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    // Ledger-deduped usage always carries totalTokens; anything else is not spend.
    if (!record.operations && !record.operationId) return undefined;
  }
  return value as MessageUsage;
}

/**
 * Live/settled progress from one Task result payload (`delegationSummary`).
 * Returns null when the payload carries no metrics at all, so callers render
 * nothing instead of a zero row. A metric-only payload (context and/or spend
 * without counters) is accepted, and a counter it never carried stays absent
 * rather than becoming a zero: a real `0` survives, an unreported counter does
 * not turn into one. `contextTokens` is occupancy (how full the child window
 * is); `usage.totalTokens` is cumulative billed spend — never mixed.
 */
export function parseSubagentMetrics(payload: unknown): SubagentMetrics | null {
  const record = asRecord(payload);
  if (!record) return null;
  const toolCalls = asNonNegativeInt(record.toolCalls);
  const turns = asNonNegativeInt(record.turns);
  const contextTokens = asNonNegativeInt(record.contextTokens);
  const usage = asUsage(record.usage);
  if (
    toolCalls === undefined &&
    turns === undefined &&
    contextTokens === undefined &&
    usage === undefined
  ) {
    return null;
  }
  return {
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * One chain's context gauge: the last figure a segment actually reported, with
 * the provenance that figure came from.
 */
type ChainContextGauge = {
  tokens?: number;
  provenance: SubagentContextProvenance;
  estimated?: boolean;
};

/** A chain no segment has measured yet. */
const UNMEASURED_CONTEXT: ChainContextGauge = { provenance: "unknown" };

/**
 * Fold one segment's occupancy into the chain's gauge.
 *
 * Occupancy is a gauge, never a sum: the latest segment that actually reported
 * a figure wins, and every reported figure wins — a decrease and a real `0`
 * included. A segment that reported none leaves the chain's last known figure,
 * and that figure's own provenance, in place: an absent field is not a
 * measurement. The marker of a `Task(resume …)` continuation, and the progress
 * snapshots before its reply, carry no window of their own, and the child's
 * window does not empty because one report did not restate it. Only a chain no
 * segment ever measured stays `unknown`; a figure is never derived from spend
 * and never borrowed from another chain.
 *
 * Both folds — over a chain's entries and over its messages — go through this
 * helper so the two cannot drift into different answers for the same chain.
 */
function foldChainContextGauge(
  gauge: ChainContextGauge,
  tokens: number | undefined,
  provenance: SubagentContextProvenance,
  estimated?: boolean,
): ChainContextGauge {
  if (tokens === undefined) return gauge;
  return { tokens, provenance, ...(estimated ? { estimated: true } : {}) };
}

/**
 * Aggregate one resume chain (initial Task + its `Task(resume …)` follow-ups).
 * Spend merges by physical operation identity via the shared ledger, so a
 * re-report or replay never double-charges. Occupancy is the chain's gauge (the
 * latest figure a segment reported), never a sum: a segment that reported none
 * leaves the last known figure standing until a newer one replaces it, and a
 * chain no segment measured reports unknown rather than an invented zero.
 *
 * Tool calls and turns accumulate across the chain, but only over the segments
 * that reported them: a counter no segment reported stays absent (the surfaces
 * render a dash), while a counter some segment reported is the sum of the
 * reported values — a reported `0` included, so a chain whose segments all
 * reported zero reports zero.
 */
export function aggregateSubagentChainMetrics(
  entries: readonly (SubagentMetrics | null | undefined)[],
): SubagentMetrics | null {
  let toolCalls: number | undefined;
  let turns: number | undefined;
  let seen = false;
  let usage: MessageUsage | undefined;
  let gauge = UNMEASURED_CONTEXT;
  for (const entry of entries) {
    if (!entry) continue;
    seen = true;
    // Only a reported counter contributes: an absent one neither adds a zero
    // of its own nor wakes the total.
    if (entry.toolCalls !== undefined) {
      toolCalls = (toolCalls ?? 0) + entry.toolCalls;
    }
    if (entry.turns !== undefined) {
      turns = (turns ?? 0) + entry.turns;
    }
    usage = addUsage(usage, entry.usage);
    // A segment without an occupancy is not a measurement of an empty window.
    gauge = foldChainContextGauge(
      gauge,
      entry.contextTokens,
      entry.contextProvenance ?? "snapshot",
      entry.contextEstimated,
    );
  }
  if (!seen) return null;
  return {
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(gauge.tokens !== undefined ? { contextTokens: gauge.tokens } : {}),
    ...(usage ? { usage } : {}),
    contextProvenance: gauge.provenance,
    ...(gauge.estimated ? { contextEstimated: true } : {}),
  };
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

/**
 * Task call ids in the same resume chain as `delegationId`: the initial call
 * plus every `Task(resume …)` follow-up, forward and backward. Shared with
 * `buildSubagentTranscript` through `subagent-chain` so metrics and
 * transcript agree on both the delegation-id and bare-call-id resume forms.
 * Re-exported here so existing imports keep working.
 */
export { subagentChainCallIds } from "./subagent-chain";

function hasUsageIdentity(usage: MessageUsage | undefined): boolean {
  if (!usage) return false;
  if (typeof usage.operationId === "string" && usage.operationId) return true;
  return Array.isArray(usage.operations) && usage.operations.length > 0;
}

function isValidChildAssistant(message: UiMessage): boolean {
  if (message.role !== "assistant") return false;
  if (!message.usage) return false;
  // Same occupancy semantics as the renderer's context-usage utilities:
  // input + output + cache traffic on that request, never a summed spend.
  // A trailing provider estimate (output-only content) is honest occupancy
  // only when usage exists; without usage the row stays unknown.
  return contextOccupancyTokens(message.usage) > 0;
}

/** Latest valid child assistant usage under one Task call, if any. */
function latestChildAssistantUsage(
  messages: readonly UiMessage[],
  callId: string,
): { occupancy: number; usage: MessageUsage } | null {
  let latest: { occupancy: number; usage: MessageUsage } | null = null;
  for (const message of messages) {
    if (message.parentToolCallId !== callId) continue;
    if (!isValidChildAssistant(message)) continue;
    const usage = message.usage as MessageUsage;
    latest = { occupancy: contextOccupancyTokens(usage), usage };
  }
  return latest;
}

/**
 * Latest lifecycle roster entry per delegation id, in transcript order.
 * TaskWait/TaskList report `details.delegations[]`; TaskStop reports
 * `details.stopped[]`. Later rows win, matching status collection.
 */
function collectLifecycleMetrics(
  messages: readonly UiMessage[],
): Map<string, SubagentMetrics> {
  const perDelegation = new Map<string, SubagentMetrics>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    if (!delegationLifecycleKind(message.toolName)) continue;
    const payload = asRecord(toolResultPayload(message));
    if (!payload) continue;
    for (const key of ["delegations", "stopped"] as const) {
      const entries = payload[key];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const record = asRecord(entry);
        if (!record) continue;
        const id = record.delegationId;
        if (typeof id !== "string" || !id) continue;
        const parsed = parseSubagentMetrics(record);
        if (parsed) {
          perDelegation.set(id, { ...parsed, contextProvenance: "lifecycle" });
        }
      }
    }
  }
  return perDelegation;
}

/**
 * Aggregate metrics across one resume chain from persisted Task payloads,
 * with lifecycle and child-usage fallback for legacy rows that never
 * reported tokens.
 *
 * Preference for occupancy, per segment:
 * 1. the Task snapshot's own `contextTokens` (`snapshot`);
 * 2. the matching TaskWait/TaskList/TaskStop roster entry for the same
 *    `delegationId` (`lifecycle`);
 * 3. the segment's latest valid child assistant provider usage, reported
 *    through the same occupancy semantics as the renderer's context-usage
 *    utilities (`child`, estimated);
 * 4. otherwise nothing: that segment measured no window, so the chain keeps the
 *    last figure one of its segments did report, with that figure's own
 *    provenance. Only a chain no segment measured is unknown and renders `—`.
 *
 * Spend folds Task, lifecycle, and child assistant usage through the shared
 * operation ledger so re-reports collapse by `operationId`; legacy child
 * usage without an identity is only folded when the snapshots carry no spend
 * of their own, so one physical run is never charged twice. Occupancy is
 * never summed and never derived from summed spend.
 */
export function aggregateChainMetricsFromMessages(
  messages: readonly UiMessage[],
  delegationId: string,
): SubagentMetrics | null {
  const chain = subagentChainCallIds(messages, delegationId);
  if (chain.size === 0) return null;
  const orderedCalls = messages.filter(
    (message) =>
      message.role === "tool" &&
      message.toolCallId &&
      chain.has(message.toolCallId) &&
      (message.toolName === "Task" || message.toolName === "task" ||
        message.toolName === "subagent" ||
        (typeof message.toolName === "string" &&
          /^(task|subagent)$/i.test(message.toolName.replace(/[^a-z0-9]/gi, "")))),
  );
  // Fall back to any tool row carrying the chain call id when the tool-name
  // check above misses a namespaced Task variant.
  const calls = orderedCalls.length > 0
    ? orderedCalls
    : messages.filter(
      (message) =>
        message.role === "tool" && message.toolCallId && chain.has(message.toolCallId),
    );
  if (calls.length === 0) return null;

  const lifecycleEntries = collectLifecycleMetrics(messages);
  const entries: SubagentMetrics[] = [];
  let snapshotSpend: MessageUsage | undefined;
  let childSpend: MessageUsage | undefined;
  let gauge = UNMEASURED_CONTEXT;

  for (const call of calls) {
    const callId = call.toolCallId as string;
    const taskParsed = parseSubagentMetrics(toolResultPayload(call));
    const delegation = delegationIdForMessage(call);
    const lifecycleParsed = lifecycleEntries.get(delegation) ?? null;
    const segmentParsed = taskParsed ?? lifecycleParsed;
    if (segmentParsed) {
      entries.push(segmentParsed);
      snapshotSpend = addUsage(snapshotSpend, segmentParsed.usage);
    }
    // Child estimate for this segment: latest valid child assistant usage.
    const childUsage = latestChildAssistantUsage(messages, callId);
    if (childUsage) {
      childSpend = addUsage(childSpend, childUsage.usage);
    }
    const segmentOccupancy =
      taskParsed?.contextTokens ??
      lifecycleParsed?.contextTokens ??
      (childUsage ? childUsage.occupancy : undefined);
    const segmentProvenance: SubagentContextProvenance =
      taskParsed?.contextTokens !== undefined
        ? "snapshot"
        : lifecycleParsed?.contextTokens !== undefined
          ? "lifecycle"
          : childUsage
            ? "child"
            : "unknown";
    // A segment without a window leaves the chain's last known figure — and
    // its own provenance — standing until a newer report replaces it.
    gauge = foldChainContextGauge(
      gauge,
      segmentOccupancy,
      segmentProvenance,
      segmentProvenance === "child",
    );
  }

  // Spend: snapshots first; fold child spend through the ledger when it
  // carries operation identity (dedup-safe), or when snapshots have no spend
  // at all (legacy fallback). Legacy child usage never stacks on top of
  // snapshot spend for the same physical run.
  let usage = snapshotSpend;
  if (childSpend) {
    if (hasUsageIdentity(childSpend)) {
      usage = addUsage(usage, childSpend);
    } else if (!usage) {
      usage = childSpend;
    }
  }

  const base = aggregateSubagentChainMetrics(entries);
  if (!base && !usage && gauge.tokens === undefined) return null;
  return {
    // A counter no segment reported stays absent: the surfaces state the
    // labelled dash, never an invented zero.
    ...(base?.toolCalls !== undefined ? { toolCalls: base.toolCalls } : {}),
    ...(base?.turns !== undefined ? { turns: base.turns } : {}),
    ...(gauge.tokens !== undefined ? { contextTokens: gauge.tokens } : {}),
    ...(usage ? { usage } : {}),
    contextProvenance: gauge.provenance,
    ...(gauge.estimated ? { contextEstimated: true } : {}),
  };
}

/**
 * One-line token summary for topology nodes, panel headers/footers.
 * Keeps occupancy and spend lexically separate: `ctx` vs `spent`. Occupancy
 * stays an estimate — the number is never presented as a runtime report — but
 * it is not prefixed with a tilde: the displayed delegation cards, dock and
 * tab state the figure plainly and the estimate is flagged where the detail
 * surfaces carry it.
 *
 * Only reported figures are stated. A counter the child never reported leaves
 * no `0 tool calls` behind, and a line with no counter still states the
 * occupancy and spend it does have.
 */
export function formatSubagentMetricsLine(metrics: SubagentMetrics): string {
  // The occupancy and spend fragments keep the shared formatter's own wording
  // (`ctx … tokens`, `spent … tokens`) so the fallback below reads the same.
  const spend = metrics.usage
    ? `spent ${compactTokens(metrics.usage.totalTokens)} tokens`
    : null;
  const occupancy =
    metrics.contextTokens !== undefined
      ? `ctx ${compactTokens(metrics.contextTokens)} tokens`
      : null;
  // The shared formatter owns the tool-call wording and the ordering of the
  // figures it covers; a chain that never reported a counter composes the same
  // list from the figures it does have instead of claiming `0 tool calls`.
  const base =
    metrics.toolCalls !== undefined
      ? formatSubagentProgressMetrics({
          toolCalls: metrics.toolCalls,
          ...(metrics.contextTokens !== undefined
            ? { contextTokens: metrics.contextTokens }
            : {}),
          ...(metrics.usage ? { usage: metrics.usage } : {}),
        })
      : [occupancy, spend].filter((part): part is string => part !== null).join(", ");
  const turns =
    metrics.turns !== undefined && metrics.turns > 0
      ? `${metrics.turns} turn${metrics.turns === 1 ? "" : "s"}`
      : null;
  if (turns && base) return `${turns} · ${base}`;
  return turns ?? base;
}
