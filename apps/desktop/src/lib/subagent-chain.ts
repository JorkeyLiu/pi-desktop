import type { UiMessage } from "@pi-desktop/shared";
import { delegationIdForMessage } from "./subagent-panel";
import { subagentTranscriptIndex } from "./subagent-index";
import { isDelegationStartTool } from "./tool-display";
import { toolResultPayload } from "./tool-presentation";

/**
 * Shared resume-chain resolution for the subagent transcript tab and its
 * metrics (F4). Both read the same connected component of `Task` calls so a
 * `Task(resume …)` that cites either a prior `delegationId` (the runtime's
 * shape) or a bare prior `toolCallId` (legible before any result lands)
 * closes the chain identically in both views.
 *
 * The component itself is resolved by the conversation's index
 * (`subagent-transcript-index`), once per messages snapshot: a chain question
 * about any identity is a lookup, not another walk of the transcript.
 */

/**
 * The resume links of one conversation: the delegation-id map and the
 * call-level link map the chain walk follows.
 */
export { subagentResumeLinks } from "./subagent-task-call";

/**
 * Every `Task` call id in the same resume chain as `delegationId`: the
 * initial call plus every `Task(resume …)` follow-up, forward and backward.
 *
 * Accepts either a delegation id or a bare call id as the entry point. The
 * bare form is a real state, not a legacy one: a tab opened while its `Task`
 * call is still being created is keyed by the call id, and the call identifies
 * itself by that id until the run's own result lands. Matching both keeps that
 * tab on its chain as the identity arrives, instead of stranding it and
 * requiring a second card.
 */
export function subagentChainCallIds(
  messages: readonly UiMessage[],
  delegationId: string,
): Set<string> {
  return new Set(subagentTranscriptIndex(messages).chainCallIds(delegationId));
}

/**
 * The chain-latest delegation identity (F5): the `delegationId` of the last
 * `Task` call in the chain, in session order. Falls back to the entry id
 * when the chain is empty so callers keep a stable key.
 */
export function subagentChainLatestDelegationId(
  messages: readonly UiMessage[],
  delegationId: string,
): string {
  return subagentTranscriptIndex(messages).latestDelegationId(delegationId);
}

/**
 * The transcript views one conversation's delegation chains are resolved over.
 *
 * A reader can be looking at a frozen range while the live tail keeps growing,
 * and the two hold different `Task` rows: the range carries calls the live
 * array has already dropped, the tail carries resume links issued after the
 * range was taken. Identity resolution needs both, so callers hand over every
 * view of the same conversation instead of picking one.
 */
export type SubagentChainEvidence = readonly (readonly UiMessage[])[];

/** Every `Task` call id of `delegationId`'s chain, across all evidence views. */
export function subagentChainCallIdsIn(
  evidence: SubagentChainEvidence,
  delegationId: string,
): Set<string> {
  const chain = new Set<string>();
  for (const messages of evidence) {
    for (const callId of subagentTranscriptIndex(messages).chainCallIds(delegationId)) {
      chain.add(callId);
    }
  }
  return chain;
}

/**
 * Whether two subagent identities name one logical subagent.
 *
 * A delegation chain is one child session however many `Task` rows opened it:
 * the original dispatch, a parent-issued `Task(resume …)`, a user
 * continuation, and the bare call id a card still carries before its handle
 * lands all resolve to the same connected component. Callers that key work by
 * identity — the work panel's tabs, for one — use this instead of comparing
 * strings, so the same child is never represented twice.
 */
export function subagentChainSameDelegate(
  messages: readonly UiMessage[],
  left: string,
  right: string,
): boolean {
  return subagentChainSameDelegateIn([messages], left, right);
}

/** `subagentChainSameDelegate` over several views of one conversation. */
export function subagentChainSameDelegateIn(
  evidence: SubagentChainEvidence,
  left: string,
  right: string,
): boolean {
  const target = left.trim();
  const other = right.trim();
  if (!target || !other) return false;
  if (target === other) return true;
  const chain = subagentChainCallIdsIn(evidence, target);
  if (chain.size === 0) return false;
  for (const callId of subagentChainCallIdsIn(evidence, other)) {
    if (chain.has(callId)) return true;
  }
  return false;
}

/**
 * Whether the delegation chain names a backend instance: at least one `Task`
 * call of the chain carries a backend-owned `delegationId`.
 *
 * A denied call that never started has no delegation identity, so it is not a
 * child and must not offer a continuation; a tab whose `Task` calls are
 * missing has no chain at all. Either way there is no instance to continue,
 * even though the tab itself is settled.
 */
export function subagentChainInstantiated(
  messages: readonly UiMessage[],
  delegationId: string,
): boolean {
  const target = delegationId.trim();
  if (!target) return false;
  const chain = subagentTranscriptIndex(messages).chainCallIds(target);
  if (chain.size === 0) return false;
  return messages.some((message) => {
    if (
      message.role !== "tool" ||
      !isDelegationStartTool(message.toolName) ||
      !message.toolCallId ||
      !chain.has(message.toolCallId)
    ) {
      return false;
    }
    const payload = toolResultPayload(message);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    const id = (payload as { delegationId?: unknown }).delegationId;
    return typeof id === "string" && id.length > 0;
  });
}
