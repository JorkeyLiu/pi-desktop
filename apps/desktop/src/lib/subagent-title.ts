import type { UiMessage } from "@pi-desktop/shared";
import { subagentTranscriptIndex } from "./subagent-index";

/**
 * The title of a delegation, resolved from the conversation's own analysis.
 *
 * A title belongs to the resume chain, not to the `Task` call a card happens to
 * represent: a `Task(resume …)` continuation usually lands in a later activity
 * group than the call whose description named the work. The index resolves the
 * chain once per messages snapshot, so every identity of the chain reads the
 * same earliest description without re-walking the transcript.
 */

export { delegateTaskTitle } from "./subagent-task-call";

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
  return subagentTranscriptIndex(messages).title(delegationId);
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
  return subagentTranscriptIndex(messages).titles;
}
