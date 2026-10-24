import type { UiMessage } from "@pi-desktop/shared";
import { delegationChainMaps } from "./assistant-turns";
import { isDelegationStartTool } from "./tool-display";
import { delegationIdForMessage } from "./subagent-panel";
import { toolResultPayload } from "./tool-presentation";
import { subagentDeliveryOwner } from "./subagent-actions";

/**
 * Shared resume-chain resolution for the subagent transcript tab and its
 * metrics (F4). Both read the same connected component of `Task` calls so a
 * `Task(resume …)` that cites either a prior `delegationId` (the runtime's
 * shape) or a bare prior `toolCallId` (legible before any result lands)
 * closes the chain identically in both views.
 */

function resumeTarget(
  resume: unknown,
  callByDelegationId: ReadonlyMap<string, string>,
): string | null {
  if (typeof resume !== "string" || !resume.trim()) return null;
  return callByDelegationId.get(resume.trim()) ?? resume.trim();
}

function resumeArgOf(message: UiMessage): unknown {
  const args = message.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  return (args as { resume?: unknown }).resume;
}

/**
 * `childOf` plus the bare-call-id fallback: `delegationChainMaps` only links
 * the delegation-id form, so a resume that names the prior call id directly
 * needs its own edge to keep the chain connected before results land.
 */
export function subagentResumeLinks(messages: readonly UiMessage[]): {
  callByDelegationId: Map<string, string>;
  resumeLink: Map<string, string>;
} {
  const { callByDelegationId, childOf } = delegationChainMaps(messages);
  const resumeLink = new Map(childOf);
  for (const message of messages) {
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) continue;
    const target = resumeTarget(resumeArgOf(message), callByDelegationId);
    if (!target || !message.toolCallId) continue;
    if (!resumeLink.has(target)) resumeLink.set(target, message.toolCallId);
  }
  return { callByDelegationId, resumeLink };
}

function resumedCallIds(
  messages: readonly UiMessage[],
  priorCallIds: ReadonlySet<string>,
  callByDelegationId: ReadonlyMap<string, string>,
): Set<string> {
  const next = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) continue;
    const target = resumeTarget(resumeArgOf(message), callByDelegationId);
    if (!target) continue;
    if (priorCallIds.has(target) && message.toolCallId) next.add(message.toolCallId);
  }
  return next;
}

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
  const target = delegationId.trim();
  if (!target) return new Set();
  const { callByDelegationId, resumeLink } = subagentResumeLinks(messages);
  const calls = messages.filter(
    (message) =>
      message.role === "tool" &&
      isDelegationStartTool(message.toolName) &&
      Boolean(message.toolCallId),
  );
  let chain = new Set(
    calls
      .filter(
        (call) =>
          delegationIdForMessage(call) === target || call.toolCallId === target,
      )
      .map((call) => call.toolCallId as string),
  );
  for (;;) {
    const forward = resumedCallIds(messages, chain, callByDelegationId);
    const backward = new Set(
      [...chain].flatMap((callId) =>
        [...resumeLink.entries()]
          .filter(([, next]) => next === callId)
          .map(([priorId]) => priorId),
      ),
    );
    const grown = new Set([
      ...chain,
      ...[...forward, ...backward].filter((id) => !chain.has(id)),
    ]);
    if (grown.size === chain.size) break;
    chain = grown;
  }
  return chain;
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
  const target = delegationId.trim();
  if (!target) return delegationId;
  const last = subagentChainLatestCall(messages, target);
  if (!last) return target;
  return delegationIdForMessage(last);
}

/**
 * The chain's last `Task` call in session order. One resolution for the view,
 * the report owner, and the run's execution turn, so they can never disagree
 * about which segment of the chain is current.
 */
function subagentChainLatestCall(
  messages: readonly UiMessage[],
  delegationId: string,
): UiMessage | undefined {
  const target = delegationId.trim();
  if (!target) return undefined;
  const chain = subagentChainCallIds(messages, target);
  if (chain.size === 0) return undefined;
  return messages
    .filter(
      (message) =>
        message.role === "tool" &&
        isDelegationStartTool(message.toolName) &&
        message.toolCallId &&
        chain.has(message.toolCallId),
    )
    .at(-1);
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
  const chain = subagentChainCallIds(messages, target);
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

/**
 * Who receives the chain-latest run's report, from the latest `Task` call's
 * own backend-owned fields (`details.delivery` or the user-origin marker's
 * `toolArgs.source`). Earlier segments never override the latest run:
 * a user continuation of a parent chain is user-owned from that segment on.
 */
export function subagentChainDeliveryOwner(
  messages: readonly UiMessage[],
  delegationId: string,
): "parent" | "user" {
  const last = subagentChainLatestCall(messages, delegationId);
  if (!last) return "parent";
  return subagentDeliveryOwner({
    details: toolResultPayload(last),
    toolArgs: last.toolArgs,
  });
}

/**
 * The chain-latest run's own execution turn, as the runtime published it on the
 * `Task` result (`details.executionTurnId`).
 *
 * A continuation opened while the parent was idle runs under a child-only
 * execution-accounting turn, and that turn — never the parent's current turn —
 * is what owns its steering. Publishing it on the persisted `Task` row means a
 * reopened tab or a rebuilt renderer still names the authoritative turn
 * instead of depending on in-memory state that did not survive.
 */
export function subagentChainExecutionTurnId(
  messages: readonly UiMessage[],
  delegationId: string,
): string | undefined {
  const last = subagentChainLatestCall(messages, delegationId);
  const payload = last ? toolResultPayload(last) : undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const turnId = (payload as { executionTurnId?: unknown }).executionTurnId;
  return typeof turnId === "string" && turnId.trim() ? turnId.trim() : undefined;
}
