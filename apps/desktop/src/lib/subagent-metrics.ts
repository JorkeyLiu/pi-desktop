import { formatSubagentProgressMetrics } from "@pi-desktop/shared";
import type { UiMessage } from "@pi-desktop/shared";
import { subagentTranscriptIndex } from "./subagent-index";
import type { SubagentMetrics } from "./subagent-metrics-values";

/**
 * The figures a subagent surface states, and the one way they are folded.
 *
 * The value layer — what a report says and how reports fold — lives in
 * `subagent-metrics-values`; the conversation-level fold lives in the
 * transcript index, which resolves each resume chain once per messages
 * snapshot. This module keeps the public helpers the surfaces import, so a
 * card, the child's tab header and the composer's dock keep reading the same
 * figures without each re-walking the transcript.
 */

export type {
  SubagentContextProvenance,
  SubagentMetrics,
} from "./subagent-metrics-values";

export {
  aggregateSubagentChainMetrics,
  parseSubagentMetrics,
} from "./subagent-metrics-values";

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
  return subagentTranscriptIndex(messages).metrics(delegationId);
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
