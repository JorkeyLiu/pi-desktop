/**
 * Transient tool-call preparation rows.
 *
 * While the model writes a tool call's arguments the call has an identity but
 * no arguments and no result. The renderer shows that stretch as the call's own
 * row at its chronological position, and the row becomes the executing row in
 * place when `tool_start` arrives. Argument generation can end before execution
 * begins, so a prepared row also outlives its pulse: it keeps its position and
 * its identity until the call really runs. Everything here is deliberately
 * ephemeral: nothing in this module is persisted, and a prepared call that never
 * executes is dropped again.
 */

import type {
  AgentEvent,
  AgentEventEnvelope,
  UiMessage,
} from "./types.js";

export type ToolPrepareEvent = Extract<AgentEvent, { type: "tool_prepare" }>;

/** Which execution the preparing rows of one event belong to. */
export type ToolPreparationScope = {
  parentToolCallId?: string;
  nestedParentToolCallId?: string;
};

/**
 * A call whose identity is settled but whose arguments are still streaming.
 * This is the stretch that breathes; once the arguments are complete the row
 * stays, but stops its preparing animation.
 */
export function isPreparingTool(message: UiMessage): boolean {
  return (
    message.role === "tool" &&
    message.toolStatus === "preparing" &&
    message.toolArgsComplete !== true
  );
}

/**
 * A call whose arguments are complete and whose execution has not started.
 * The row is still not history — it renders no execution outcome yet — but the
 * model is no longer writing it, so it no longer breathes.
 */
export function isPreparedTool(message: UiMessage): boolean {
  return (
    message.role === "tool" &&
    message.toolStatus === "preparing" &&
    message.toolArgsComplete === true
  );
}

/**
 * A row for a call that has not executed: either still being written or fully
 * prepared and waiting. Such rows are never durable, so they leave the
 * transcript when the attempt that produced them ends without running them.
 */
export function isUnexecutedTool(message: UiMessage): boolean {
  return message.role === "tool" && message.toolStatus === "preparing";
}

export function toolPreparationScope(
  envelope: Pick<AgentEventEnvelope, "parentToolCallId" | "nestedParentToolCallId">,
): ToolPreparationScope {
  return {
    ...(envelope.parentToolCallId
      ? { parentToolCallId: envelope.parentToolCallId }
      : {}),
    ...(envelope.nestedParentToolCallId
      ? { nestedParentToolCallId: envelope.nestedParentToolCallId }
      : {}),
  };
}

/** Whether a row belongs to the same execution as `scope`. */
export function toolPreparationMatches(
  message: UiMessage,
  scope: ToolPreparationScope,
): boolean {
  return (
    message.parentToolCallId === scope.parentToolCallId &&
    message.nestedParentToolCallId === scope.nestedParentToolCallId
  );
}

/**
 * The row a prepared call renders as.
 *
 * The id is the call id, exactly the id `tool_start` and `tool_end` use, so the
 * row keeps its identity and its position for the whole call. `taskTitle` is a
 * parsed, bounded description — never the raw streaming arguments — and only a
 * delegation start call carries one. A `ready` frame marks argument completion
 * on the same row.
 */
export function preparingToolMessage(
  envelope: Pick<AgentEventEnvelope, "ts" | "parentToolCallId" | "nestedParentToolCallId" | "agentName">,
  event: ToolPrepareEvent,
): UiMessage {
  return {
    id: event.toolCallId,
    role: "tool",
    content: "",
    createdAt: new Date(envelope.ts).toISOString(),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    toolStatus: "preparing",
    status: "streaming",
    ...(event.taskTitle ? { toolArgs: { description: event.taskTitle } } : {}),
    ...(event.ready ? { toolArgsComplete: true } : {}),
    ...(envelope.parentToolCallId
      ? { parentToolCallId: envelope.parentToolCallId }
      : {}),
    ...(envelope.nestedParentToolCallId
      ? { nestedParentToolCallId: envelope.nestedParentToolCallId }
      : {}),
    ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
  };
}
