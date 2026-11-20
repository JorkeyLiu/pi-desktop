import { addUsage } from "@pi-desktop/shared";
import type { MessageUsage, UiMessage } from "@pi-desktop/shared";
import { contextOccupancyTokens } from "./context-usage";

/**
 * The subagent figures as values: what one report says, and how a chain's
 * reports fold into one row.
 *
 * Nothing here reads the transcript. A report is parsed once — from a `Task`
 * result payload, a lifecycle roster entry or a child usage row — and the fold
 * works on those values, so the transcript-side analysis and every surface
 * that renders the figures share one meaning of "reported", "absent" and
 * "estimated" without re-deriving it from a stored row.
 */

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

export function asRecord(value: unknown): Record<string, unknown> | null {
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
export type ChainContextGauge = {
  tokens?: number;
  provenance: SubagentContextProvenance;
  estimated?: boolean;
};

/** A chain no segment has measured yet. */
export const UNMEASURED_CONTEXT: ChainContextGauge = { provenance: "unknown" };

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
export function foldChainContextGauge(
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

export function hasUsageIdentity(usage: MessageUsage | undefined): boolean {
  if (!usage) return false;
  if (typeof usage.operationId === "string" && usage.operationId) return true;
  return Array.isArray(usage.operations) && usage.operations.length > 0;
}

/**
 * Whether a row is a usable child occupancy/spend report: an assistant row that
 * carries provider usage with non-zero occupancy. Same occupancy semantics as
 * the renderer's context-usage utilities — input + output + cache traffic on
 * that request, never a summed spend. A trailing provider estimate
 * (output-only content) is honest occupancy only when usage exists; without
 * usage the row stays unknown.
 */
export function isValidChildAssistant(message: UiMessage): boolean {
  if (message.role !== "assistant") return false;
  if (!message.usage) return false;
  return contextOccupancyTokens(message.usage) > 0;
}

/**
 * Whether a tool row is one of the Task call shapes the chain fold reads as a
 * segment: the bare `Task`/`subagent` name, a namespaced or punctuated variant
 * of it, and nothing else. A `TaskWait`/`TaskList`/`TaskStop` roster row is not
 * a segment; it reports for segments through `details.delegations`.
 */
export function isTaskSegmentTool(message: UiMessage): boolean {
  const toolName = message.toolName;
  if (toolName === "Task" || toolName === "task" || toolName === "subagent") {
    return true;
  }
  return (
    typeof toolName === "string" &&
    /^(task|subagent)$/i.test(toolName.replace(/[^a-z0-9]/gi, ""))
  );
}
