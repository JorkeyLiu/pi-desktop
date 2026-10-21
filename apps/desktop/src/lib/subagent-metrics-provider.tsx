import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { UiMessage } from "@pi-desktop/shared";
import { reuseReferences } from "./transcript-summary";
import { delegationLifecycleKind, isDelegationStartTool } from "./tool-display";
import { delegationIdForMessage } from "./subagent-panel";
import { subagentChainCallIds } from "./subagent-chain";
import {
  aggregateChainMetricsFromMessages,
  type SubagentMetrics,
} from "./subagent-metrics";

/**
 * The totals of every delegation chain in the conversation, keyed by the
 * `Task` call id of each segment.
 *
 * A resume chain is one child session continued by later `Task` calls
 * (ADR 0279), so its turns, tool calls, spend and latest occupancy belong to
 * the chain rather than to the invocation a card happens to represent. The
 * child's own tab header already reads them through
 * `aggregateChainMetricsFromMessages`; a card that folded its own payload
 * would state a per-run segment instead and disagree with the tab it opens.
 * The transcript surface therefore folds each chain once over its messages and
 * hands the result down through this context, and every card of that chain
 * reads the same object. A surface without a provider falls back to the call's
 * own payload.
 */
const SubagentChainMetricsContext =
  createContext<ReadonlyMap<string, SubagentMetrics> | null>(null);

/**
 * The conversation's chain totals by `Task` call id, or `null` outside a
 * transcript surface.
 */
export function useSubagentChainMetrics(): ReadonlyMap<string, SubagentMetrics> | null {
  return useContext(SubagentChainMetricsContext);
}

/**
 * Whether a message can move a chain's totals: a `Task` call or a
 * `TaskWait`/`TaskList`/`TaskStop` roster row carries the reported counters,
 * and a child assistant row carries the occupancy/spend fallback for a legacy
 * segment that never reported its own. Nothing else can, so the projection is
 * what the fold is memoized on: ordinary streaming updates leave it identical
 * and no chain is folded per token.
 */
function subagentMetricsMessage(message: UiMessage): boolean {
  if (message.role === "tool") {
    return (
      isDelegationStartTool(message.toolName) ||
      delegationLifecycleKind(message.toolName) !== null
    );
  }
  return message.role === "assistant" && Boolean(message.usage);
}

/**
 * Fold every resume chain once, keyed by the call id of each of its segments.
 *
 * The fold is the canonical `aggregateChainMetricsFromMessages`, so a card, the
 * composer's dock row and the child's tab header cannot state the same child
 * differently. A chain that reported nothing carries no entry at all: a caller
 * renders nothing instead of an invented zero row.
 */
export function subagentChainMetricsByIdentity(
  messages: readonly UiMessage[],
): ReadonlyMap<string, SubagentMetrics> {
  const metrics = new Map<string, SubagentMetrics>();
  const folded = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) continue;
    const callId = message.toolCallId;
    if (!callId || folded.has(callId)) continue;
    const entry = delegationIdForMessage(message);
    const chain = subagentChainCallIds(messages, entry);
    if (chain.size === 0) continue;
    for (const id of chain) folded.add(id);
    const aggregate = aggregateChainMetricsFromMessages(messages, entry);
    if (!aggregate) continue;
    for (const id of chain) metrics.set(id, aggregate);
  }
  return metrics;
}

export function SubagentChainMetricsProvider({
  messages,
  children,
}: {
  messages: readonly UiMessage[];
  children: ReactNode;
}) {
  // `messages` is replaced on every streaming update, so the projection keeps
  // its identity while no message that can move a figure has changed.
  const rawRelevant = useMemo(() => messages.filter(subagentMetricsMessage), [messages]);
  const relevantRef = useRef<UiMessage[]>([]);
  const relevant = reuseReferences(relevantRef.current, rawRelevant);
  relevantRef.current = relevant;
  const metrics = useMemo(() => subagentChainMetricsByIdentity(relevant), [relevant]);
  return (
    <SubagentChainMetricsContext.Provider value={metrics}>
      {children}
    </SubagentChainMetricsContext.Provider>
  );
}
