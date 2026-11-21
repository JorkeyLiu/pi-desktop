import type { UiMessage } from "@pi-desktop/shared";
import { delegationChainMaps, isAcceptedSubagentCall } from "./assistant-turns";
import { isDelegationStartTool } from "./tool-display";

/**
 * What one `Task` call says about itself: the short description it was
 * dispatched with and the call (or delegation) it resumes.
 *
 * These are the only facts a chain is built from, so they live together and are
 * read by the resume links, the transcript index and the title helpers instead
 * of each re-deriving them from `toolArgs`.
 */

/**
 * The task title one `Task` call carries: the short label the model wrote in
 * the call's optional `description`, never the `task` brief. A brief is a
 * paragraph and belongs to the expanded body, so it is never a title fallback.
 *
 * Whitespace is collapsed to one line because a card title and a tab label each
 * print it as a single run of text; the untruncated value stays reachable
 * through the element's `title`.
 */
export function delegateTaskTitle(call: UiMessage): string {
  const args = call.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const description = (args as { description?: unknown }).description;
  if (typeof description !== "string") return "";
  return description.replace(/\s+/g, " ").trim();
}

/** The `resume` argument a `Task(resume …)` call sends, unread if absent. */
export function resumeArgOf(message: UiMessage): unknown {
  const args = message.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  return (args as { resume?: unknown }).resume;
}

/**
 * The call id a `resume` argument names: the delegation id resolved to the call
 * that carried it, else the argument itself (a bare call id, which is a real
 * state before that call's result lands).
 */
export function resumeTarget(
  resume: unknown,
  callByDelegationId: ReadonlyMap<string, string>,
): string | null {
  if (typeof resume !== "string" || !resume.trim()) return null;
  return callByDelegationId.get(resume.trim()) ?? resume.trim();
}

/**
 * The resume links of one conversation.
 *
 * `childOf` plus the bare-call-id fallback: `delegationChainMaps` only links the
 * delegation-id form, so a resume that names the prior call id directly needs
 * its own edge to keep the chain connected before results land. Either form
 * only extends the chain from an executed call: a rejected resume is a request
 * attempt with no run behind it, so it builds no edge.
 */
export function subagentResumeLinks(messages: readonly UiMessage[]): {
  callByDelegationId: Map<string, string>;
  resumeLink: Map<string, string>;
} {
  const { callByDelegationId, childOf } = delegationChainMaps(messages);
  const resumeLink = new Map(childOf);
  const childParents = new Set<string>();
  const pending: { target: string; next: string; message: UiMessage }[] = [];
  for (const message of messages) {
    if (message.parentToolCallId) childParents.add(message.parentToolCallId);
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) continue;
    if (!message.toolCallId) continue;
    const target = resumeTarget(resumeArgOf(message), callByDelegationId);
    if (!target) continue;
    pending.push({ target, next: message.toolCallId, message });
  }
  // First link per target wins, as before; the gate runs after the pass so the
  // child rows a later call produced are visible when its acceptance is judged.
  for (const { target, next, message } of pending) {
    if (resumeLink.has(target)) continue;
    if (isAcceptedSubagentCall(message, childParents.has(next))) resumeLink.set(target, next);
  }
  return { callByDelegationId, resumeLink };
}
