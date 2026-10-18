import type { UiMessage } from "@pi-desktop/shared";
import { messageThinking, type SubagentRunItem } from "./assistant-turns";
import { isDelegationStartTool } from "./tool-display";
import { subagentChainCallIds } from "./subagent-chain";

/** One user/assistant exchange of a delegate session. */
export type SubagentTranscriptTurn = { task: string; rows: SubagentRunItem[] };

/**
 * A delegate's conversation as alternating turns: each Task call of the
 * delegation chain opens a turn with its `task` argument, followed by the
 * rows the delegate produced under that call.
 */
export type SubagentTranscript = {
  agentName?: string;
  turns: SubagentTranscriptTurn[];
};

function delegateTaskDescription(call: UiMessage): string {
  const args = call.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const task = (args as { task?: unknown }).task;
  return typeof task === "string" ? task.trim() : "";
}

function requestedAgentName(call: UiMessage): string {
  const args = call.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const agent = (args as { agent?: unknown }).agent;
  return typeof agent === "string" ? agent : "";
}

/** Chain membership shared with metrics so both views agree (F4). */
function chainCallIds(messages: readonly UiMessage[], delegationId: string): Set<string> {
  return subagentChainCallIds(messages, delegationId);
}

/**
 * Build the delegate's transcript from the session messages.
 *
 * A Task call belongs to the delegation of `delegationId` when the call
 * identifies itself by that id — via its result payload, or via its own call
 * id when the runtime recorded none — or when it resumed another call of that
 * chain. Turns appear in session order; each turn's rows are the messages
 * whose `parentToolCallId` names that call, mapped exactly like the
 * delegation card's run grouping. Returns null when no Task call matches, so
 * the tab can show its unavailable state instead of an empty conversation.
 */
export function buildSubagentTranscript(
  messages: readonly UiMessage[],
  delegationId: string,
): SubagentTranscript | null {
  const target = delegationId.trim();
  if (!target) return null;
  const calls = messages.filter(
    (message) =>
      message.role === "tool" &&
      isDelegationStartTool(message.toolName) &&
      Boolean(message.toolCallId),
  );
  // The chain is the connected component of resumed calls around the call
  // this delegation id names; shared with metrics so both views agree.
  const chain = chainCallIds(messages, target);
  if (chain.size === 0) return null;

  // Attribution prefers what the delegate's own rows carried; a chain whose
  // delegate has not produced a row yet falls back to the requested agent.
  const runAgentName = messages.find(
    (message) =>
      message.parentToolCallId &&
      chain.has(message.parentToolCallId) &&
      message.agentName,
  )?.agentName;
  const requestedName = calls
    .filter((call) => chain.has(call.toolCallId as string))
    .map(requestedAgentName)
    .find(Boolean);
  const agentName = runAgentName || requestedName;

  const turns: SubagentTranscriptTurn[] = [];
  for (const call of calls) {
    const callId = call.toolCallId as string;
    if (!chain.has(callId)) continue;
    const rows: SubagentRunItem[] = [];
    for (const message of messages) {
      if (message.parentToolCallId !== callId) continue;
      if (message.role === "tool") {
        rows.push({ kind: "tool", message });
        continue;
      }
      // Child steering echoes are attributed user rows: they enter only the
      // child's conversation via `agent.steerSubagent` and are already part
      // of chain replay (`selectChainRows`), so they render as the user side
      // here without changing replay membership.
      if (message.role === "user") {
        if ((message.content || "").trim() || message.error) {
          rows.push({ kind: "steering-user", message });
        }
        continue;
      }
      // A delegate turn can carry reasoning and text at once, and both are
      // worth showing: the text is the only place its narration and report
      // exist.
      if (messageThinking(message)) rows.push({ kind: "thinking", message });
      if ((message.content || "").trim() || message.error) {
        rows.push({ kind: "answer", message });
      }
    }
    turns.push({ task: delegateTaskDescription(call), rows });
  }

  return {
    ...(agentName ? { agentName } : {}),
    turns,
  };
}
