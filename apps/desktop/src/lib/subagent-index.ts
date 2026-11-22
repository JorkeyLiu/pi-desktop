import { addUsage } from "@pi-desktop/shared";
import type { MessageUsage, UiMessage } from "@pi-desktop/shared";
import { contextOccupancyTokens } from "./context-usage";
import { delegationLifecycleKind, isDelegationStartTool } from "./tool-display";
import { delegationIdForMessage } from "./subagent-panel";
import { toolResultPayload } from "./tool-presentation";
import {
  aggregateSubagentChainMetrics,
  asRecord,
  foldChainContextGauge,
  hasUsageIdentity,
  isValidChildAssistant,
  isTaskSegmentTool,
  parseSubagentMetrics,
  UNMEASURED_CONTEXT,
  type SubagentMetrics,
} from "./subagent-metrics-values";
import { isAcceptedSubagentCall } from "./assistant-turns";
import {
  delegateTaskAgent,
  delegateTaskTitle,
  resumeArgOf,
  resumeTarget,
  subagentResumeLinks,
} from "./subagent-task-call";
/**
 * One conversation's delegation chains, resolved once.
 *
 * A resume chain is a connected component of the `Task` calls a conversation
 * holds (ADR 0279), and every surface that draws one — the transcript's title,
 * chain-key and metrics providers, a delegation card, the child's panel header,
 * the composer's dock — asks about a chain by an identity that may be any of
 * its segments. Resolving that per question re-walked the whole transcript once
 * per chain, per rendered commit, which is what a long history with several
 * running children paid for on every streamed token.
 *
 * This module resolves the conversation once and answers every question from
 * that resolution: chain membership, the chain's original description, its
 * folded figures, the chain key each identity maps to, and the title/figures
 * maps the providers hand down. It is pure with respect to the messages array —
 * the only state it keeps is the index itself, held by a `WeakMap` keyed by the
 * array the caller passed, so it is rebuilt only when the store hands over a new
 * snapshot and is collected with that snapshot. There is no clock, no
 * invalidation and no persisted copy of a derived figure.
 *
 * The resolution rules are the ones the surfaces already had, unchanged:
 *
 * - membership walks the resume edges forward from every `Task` call whose
 *   target is in the chain, and backward only along the edge the link map kept
 *   for that target, so a fork reaches every continuation from the parent and a
 *   sibling that no later call resumed stays on itself;
 * - only a `Task` call names a chain: it is the only row that seeds one, the
 *   only row that can be a chain's latest segment, and the only row that
 *   contributes an identity to the title and chain-key maps. An ordinary tool
 *   row can still be a chain member through a resume edge that names it, and
 *   still receives the chain's folded figures, but it opens no chain of its own;
 * - only an executed `Task` call seeds or extends one: a rejected resume with
 *   no handle, no spawn in flight and no child rows is a request attempt, not
 *   a segment, so the chain's latest segment stays on the last accepted call;
 * - a resume that names nothing resolvable still records its edge, so the
 *   dangling name is a chain member — malformed history stays readable exactly
 *   as before, and a cycle terminates;
 * - the earliest description titles the chain, a counter accumulates only over
 *   the segments that reported it, occupancy is the last reported figure with
 *   its own provenance, and spend folds through the shared operation ledger.
 */

/** One `Task` call of a conversation, with what the fold needs to know. */
type CallRow = {
  callId: string;
  /** The identity a row of this call is keyed by: its result's id, else the call id. */
  delegationId: string;
  /** Position in the transcript, which is the whole of "session order". */
  order: number;
  /** The call's own `Task` payload, parsed once. */
  snapshot: SubagentMetrics | null;
  /** Whether the call's tool name is one the segment fold reads. */
  segment: boolean;
  /** The row itself, for the description it was dispatched with. */
  message: UiMessage;
};

const EMPTY_CHAIN: ReadonlySet<string> = new Set();
const EMPTY_LIST: readonly string[] = [];

export type SubagentTranscriptIndex = {
  /** Every `Task` call id of the resume chain `delegationId` names. */
  chainCallIds: (delegationId: string) => ReadonlySet<string>;
  /** The chain's last `Task` call id in session order, or `null`. */
  latestCallId: (delegationId: string) => string | null;
  /** The chain-latest delegation identity, falling back to the entry id. */
  latestDelegationId: (delegationId: string) => string;
  /** The chain's earliest description; empty when no call carried one. */
  title: (delegationId: string) => string;
  /** The chain's folded figures, or `null` when no segment reported any. */
  metrics: (delegationId: string) => SubagentMetrics | null;
  /** Every `Task` call's title, keyed by the identity its row is keyed by. */
  titles: ReadonlyMap<string, string>;
  /** Every delegation's requested agent, keyed by the same identity as `titles`. */
  agents: ReadonlyMap<string, string>;
  /** Every identity's chain key: the call id its component starts at. */
  chainKeys: ReadonlyMap<string, string>;
  /** Every segment's folded figures, keyed by `Task` call id. */
  metricsByCallId: ReadonlyMap<string, SubagentMetrics>;
};

/**
 * The analysis of one messages array.
 *
 * The cache is keyed by the array itself: a store snapshot is immutable, so the
 * same array can only mean the same conversation. A new array — a streamed
 * token, a settled row — is a new analysis, and the old one becomes garbage as
 * soon as nothing renders from it.
 */
const indexes = new WeakMap<readonly UiMessage[], SubagentTranscriptIndex>();

/** The conversation's chain analysis, built once per messages snapshot. */
export function subagentTranscriptIndex(
  messages: readonly UiMessage[],
): SubagentTranscriptIndex {
  const cached = indexes.get(messages);
  if (cached) return cached;
  const built = build(messages);
  indexes.set(messages, built);
  return built;
}

function build(messages: readonly UiMessage[]): SubagentTranscriptIndex {
  const { callByDelegationId, resumeLink } = subagentResumeLinks(messages);
  // A resume edge is walked forward from every `Task` call that names it, and
  // backward only from the single edge the link map kept for that target.
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const [prior, next] of resumeLink) {
    backward.set(next, [...(backward.get(next) ?? EMPTY_LIST), prior]);
  }

  const calls: CallRow[] = [];
  /** The `Task` calls: the only rows that name, seed, extend or retarget a chain. */
  const delegationCalls: CallRow[] = [];
  /** Every tool row with a call id, for the segment fold's fallback path. */
  const toolRows: UiMessage[] = [];
  /** First described call per call id, in session order. */
  const firstTitle = new Map<string, { order: number; title: string }>();
  /** Latest lifecycle roster entry per delegation id, in session order. */
  const lifecycle = new Map<string, SubagentMetrics>();
  /** Latest valid child assistant report per parent call id. */
  const childUsage = new Map<string, { occupancy: number; usage: MessageUsage }>();

  // The child rows arrive after the call they belong to, so a call's acceptance
  // is judged after the pass; the stashed rows keep session order, so the
  // forward edges and the seed list read exactly as before for executed calls.
  const childParents = new Set<string>();
  const taskRows: CallRow[] = [];
  for (let order = 0; order < messages.length; order += 1) {
    const message = messages[order];
    const callId = message.toolCallId;
    if (message.parentToolCallId) childParents.add(message.parentToolCallId);
    if (callId) {
      const dispatchTitle = delegateTaskTitle(message);
      if (dispatchTitle && !firstTitle.has(callId)) {
        firstTitle.set(callId, { order, title: dispatchTitle });
      }
    }
    if (message.role === "assistant") {
      const parent = message.parentToolCallId;
      if (parent && isValidChildAssistant(message)) {
        const usage = message.usage as MessageUsage;
        childUsage.set(parent, { occupancy: contextOccupancyTokens(usage), usage });
      }
      continue;
    }
    if (message.role !== "tool") continue;
    if (callId) toolRows.push(message);
    if (delegationLifecycleKind(message.toolName)) {
      collectRosterMetrics(message, lifecycle);
      continue;
    }
    if (!callId) continue;
    const row: CallRow = {
      callId,
      delegationId: delegationIdForMessage(message),
      order,
      snapshot: parseSubagentMetrics(toolResultPayload(message)),
      segment: isTaskSegmentTool(message),
      message,
    };
    calls.push(row);
    if (isDelegationStartTool(message.toolName)) taskRows.push(row);
  }
  // Only an executed call seeds or extends a chain: a rejected resume is a
  // request attempt with no run behind it, so it must neither move the
  // chain's latest segment nor open a chain.
  for (const row of taskRows) {
    if (!isAcceptedSubagentCall(row.message, childParents.has(row.callId))) continue;
    delegationCalls.push(row);
    const target = resumeTarget(resumeArgOf(row.message), callByDelegationId);
    if (target) forward.set(target, [...(forward.get(target) ?? EMPTY_LIST), row.callId]);
  }

  const chains = new Map<string, ReadonlySet<string>>();
  const latestCalls = new Map<string, string | null>();
  const foldedMetrics = new Map<string, SubagentMetrics | null>();

  const chainCallIds = (delegationId: string): ReadonlySet<string> => {
    const target = delegationId.trim();
    if (!target) return EMPTY_CHAIN;
    const cached = chains.get(target);
    if (cached) return cached;
    const seeds: string[] = [];
    for (const call of delegationCalls) {
      if (call.delegationId === target || call.callId === target) seeds.push(call.callId);
    }
    const chain = new Set(seeds);
    const queue = [...seeds];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const id of forward.get(current) ?? EMPTY_LIST) {
        if (chain.has(id)) continue;
        chain.add(id);
        queue.push(id);
      }
      for (const id of backward.get(current) ?? EMPTY_LIST) {
        if (chain.has(id)) continue;
        chain.add(id);
        queue.push(id);
      }
    }
    chains.set(target, chain);
    return chain;
  };

  /**
   * The chain fold itself: snapshots first, lifecycle roster entries for the
   * segments that reported nothing, the child's own usage last, with spend
   * folded through the shared operation ledger and occupancy kept as a gauge.
   */
  const foldChain = (rows: readonly CallRow[]): SubagentMetrics | null => {
    const entries: SubagentMetrics[] = [];
    let snapshotSpend: MessageUsage | undefined;
    let childSpend: MessageUsage | undefined;
    let gauge = UNMEASURED_CONTEXT;
    for (const row of rows) {
      const lifecycleParsed = lifecycle.get(row.delegationId) ?? null;
      const segmentParsed = row.snapshot ?? lifecycleParsed;
      if (segmentParsed) {
        entries.push(segmentParsed);
        snapshotSpend = addUsage(snapshotSpend, segmentParsed.usage);
      }
      const child = childUsage.get(row.callId);
      if (child) childSpend = addUsage(childSpend, child.usage);
      const occupancy =
        row.snapshot?.contextTokens ?? lifecycleParsed?.contextTokens ?? child?.occupancy;
      const provenance =
        row.snapshot?.contextTokens !== undefined
          ? "snapshot"
          : lifecycleParsed?.contextTokens !== undefined
            ? "lifecycle"
            : child
              ? "child"
              : "unknown";
      gauge = foldChainContextGauge(gauge, occupancy, provenance, provenance === "child");
    }
    // Spend: snapshots first; fold child spend through the ledger when it
    // carries operation identity (dedup-safe), or when snapshots have no spend
    // at all (legacy fallback).
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
      ...(base?.toolCalls !== undefined ? { toolCalls: base.toolCalls } : {}),
      ...(base?.turns !== undefined ? { turns: base.turns } : {}),
      ...(gauge.tokens !== undefined ? { contextTokens: gauge.tokens } : {}),
      ...(usage ? { usage } : {}),
      contextProvenance: gauge.provenance,
      ...(gauge.estimated ? { contextEstimated: true } : {}),
    };
  };

  /**
   * The chain's own calls in session order. A namespaced `Task` variant is a
   * chain member the segment predicate does not recognise; its rows still carry
   * the call id the chain names, so they are the fallback set.
   */
  const orderedCallsOf = (chain: ReadonlySet<string>): CallRow[] => {
    const segments = calls.filter((call) => chain.has(call.callId) && call.segment);
    if (segments.length > 0) return segments;
    const fallback: CallRow[] = [];
    for (let order = 0; order < toolRows.length; order += 1) {
      const message = toolRows[order];
      const callId = message.toolCallId;
      if (!callId || !chain.has(callId)) continue;
      fallback.push({
        callId,
        delegationId: delegationIdForMessage(message),
        order,
        snapshot: parseSubagentMetrics(toolResultPayload(message)),
        segment: isTaskSegmentTool(message),
        message,
      });
    }
    return fallback;
  };

  const metricsOf = (delegationId: string): SubagentMetrics | null => {
    const target = delegationId.trim();
    if (!target) return null;
    const cached = foldedMetrics.get(target);
    if (cached !== undefined) return cached;
    const chain = chainCallIds(target);
    const result = chain.size === 0 ? null : foldChain(orderedCallsOf(chain));
    foldedMetrics.set(target, result);
    return result;
  };

  const latestCallId = (delegationId: string): string | null => {
    const target = delegationId.trim();
    if (!target) return null;
    const cached = latestCalls.get(target);
    if (cached !== undefined) return cached;
    const chain = chainCallIds(target);
    let latest: CallRow | undefined;
    for (const call of delegationCalls) {
      if (chain.has(call.callId)) latest = call;
    }
    const value = latest ? latest.callId : null;
    latestCalls.set(target, value);
    return value;
  };

  const title = (delegationId: string): string => {
    const chain = chainCallIds(delegationId);
    if (chain.size === 0) return "";
    let earliest: { order: number; title: string } | undefined;
    for (const id of chain) {
      const named = firstTitle.get(id);
      if (!named) continue;
      if (!earliest || named.order < earliest.order) earliest = named;
    }
    return earliest?.title ?? "";
  };

  const { titles, chainKeys, agents } = batchMaps(delegationCalls, resumeLink);

  // One fold per chain, published under every call id the chain holds, so a card
  // of any segment reads the figures of the work it belongs to.
  const metricsByCallId = new Map<string, SubagentMetrics>();
  const seen = new Set<string>();
  for (const call of delegationCalls) {
    if (seen.has(call.callId)) continue;
    const chain = chainCallIds(call.delegationId);
    if (chain.size === 0) continue;
    for (const id of chain) seen.add(id);
    const aggregate = metricsOf(call.delegationId);
    if (!aggregate) continue;
    for (const id of chain) metricsByCallId.set(id, aggregate);
  }

  return {
    chainCallIds,
    latestCallId,
    latestDelegationId: (delegationId: string): string => {
      const latest = latestCallId(delegationId);
      if (!latest) return delegationId.trim() ? delegationId.trim() : delegationId;
      for (const call of delegationCalls) {
        if (call.callId === latest) return call.delegationId;
      }
      return latest;
    },
    title,
    metrics: metricsOf,
    titles,
    agents,
    chainKeys,
    metricsByCallId,
  };
}

function collectRosterMetrics(
  message: UiMessage,
  into: Map<string, SubagentMetrics>,
): void {
  const payload = asRecord(toolResultPayload(message));
  if (!payload) return;
  for (const key of ["delegations", "stopped"] as const) {
    const entries = payload[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const record = asRecord(entry);
      if (!record) continue;
      const id = record.delegationId;
      if (typeof id !== "string" || !id) continue;
      const parsed = parseSubagentMetrics(record);
      if (parsed) into.set(id, { ...parsed, contextProvenance: "lifecycle" });
    }
  }
}

/**
 * The batch maps the transcript providers hand down: every `Task` call's title
 * and requested agent, each keyed by the identity its row is keyed by, and
 * every identity's chain key.
 *
 * One chain is one child session however many `Task` rows opened it, so all
 * three maps name a chain by its earliest call: the resume edges point a
 * continuation at the call it continues, and walking to the earliest ancestor
 * names the component without re-reading the conversation once per call.
 */
function batchMaps(
  calls: readonly CallRow[],
  resumeLink: ReadonlyMap<string, string>,
): {
  titles: ReadonlyMap<string, string>;
  agents: ReadonlyMap<string, string>;
  chainKeys: ReadonlyMap<string, string>;
} {
  const titles = new Map<string, string>();
  const agents = new Map<string, string>();
  const chainKeys = new Map<string, string>();
  if (calls.length === 0) return { titles, agents, chainKeys };
  const parentOf = new Map<string, string>();
  for (const [prior, next] of resumeLink) {
    if (!parentOf.has(next)) parentOf.set(next, prior);
  }
  const rootOf = (callId: string): string => {
    let root = callId;
    for (let guard = 0; guard <= calls.length; guard += 1) {
      const parent = parentOf.get(root);
      if (!parent || parent === root) break;
      root = parent;
    }
    return root;
  };
  // Session order decides: the chain's first description is its title, and a
  // continuation's own description never replaces it. The requested agent
  // follows the same rule: the chain's earliest named role is the delegation.
  const titleByRoot = new Map<string, string>();
  const agentByRoot = new Map<string, string>();
  for (const call of calls) {
    const root = rootOf(call.callId);
    if (!titleByRoot.has(root)) {
      const dispatchTitle = delegateTaskTitle(call.message);
      if (dispatchTitle) titleByRoot.set(root, dispatchTitle);
    }
    if (!agentByRoot.has(root)) {
      const dispatchAgent = delegateTaskAgent(call.message);
      if (dispatchAgent) agentByRoot.set(root, dispatchAgent);
    }
  }
  for (const call of calls) {
    const key = rootOf(call.callId);
    chainKeys.set(call.callId, key);
    if (!chainKeys.has(call.delegationId)) chainKeys.set(call.delegationId, key);
    titles.set(call.delegationId, titleByRoot.get(key) ?? "");
    agents.set(call.delegationId, agentByRoot.get(key) ?? "");
  }
  return { titles, agents, chainKeys };
}
