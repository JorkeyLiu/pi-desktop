import type { UiMessage } from "@pi-desktop/shared";
import { subagentChainCallIds, subagentResumeLinks } from "./subagent-chain";
import { delegationIdForMessage } from "./subagent-panel";
import { isDelegationStartTool } from "./tool-display";

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

/**
 * The title of the delegation `delegationId` names, resolved from the stored
 * `Task` calls of its resume chain: the earliest call that carries a
 * description is the original title, and a later `Task(resume …)` continuation
 * never renames the work it continues even when it sends its own description.
 *
 * `messages` only has to contain the chain's `Task` calls. An empty result
 * means no call of the chain ever carried one — an older log — and the caller
 * falls back to the role that ran the child, then to its own unnamed label.
 */
export function subagentTaskTitle(
  messages: readonly UiMessage[],
  delegationId: string,
): string {
  const target = delegationId.trim();
  if (!target) return "";
  const chain = subagentChainCallIds(messages, target);
  if (chain.size === 0) return "";
  for (const message of messages) {
    if (!message.toolCallId || !chain.has(message.toolCallId)) continue;
    const title = delegateTaskTitle(message);
    if (title) return title;
  }
  return "";
}

/**
 * The original task title of every `Task` call in `messages`, keyed by the
 * delegation identity a transcript row is keyed by.
 *
 * A card and the tab it opens can live in different activity groups: a
 * `Task(resume …)` continuation often lands in a later group than the call it
 * continues. Resolving over the calls of one group alone would then rename the
 * work on that card, so the transcript resolves titles once over the whole
 * conversation and hands the result down. Each entry is exactly what
 * `subagentTaskTitle` resolves for that delegation.
 */
export function subagentTaskTitles(
  messages: readonly UiMessage[],
): ReadonlyMap<string, string> {
  const calls = messages.filter(
    (message) =>
      message.role === "tool" &&
      isDelegationStartTool(message.toolName) &&
      Boolean(message.toolCallId),
  );
  const titles = new Map<string, string>();
  if (calls.length === 0) return titles;
  // Each resume edge points a continuation at the call it continues, so a chain
  // is the connected component those edges form: walking to the earliest
  // ancestor names it without re-reading the session once per call.
  const { resumeLink } = subagentResumeLinks(calls);
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
  // continuation's own description never replaces it.
  const titleByRoot = new Map<string, string>();
  for (const call of calls) {
    const root = rootOf(call.toolCallId as string);
    if (titleByRoot.has(root)) continue;
    const title = delegateTaskTitle(call);
    if (title) titleByRoot.set(root, title);
  }
  for (const call of calls) {
    const title = titleByRoot.get(rootOf(call.toolCallId as string)) ?? "";
    titles.set(delegationIdForMessage(call), title);
  }
  return titles;
}
