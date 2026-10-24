/**
 * Tool-call preparation: the window between "the model named this call" and
 * "the call actually runs".
 *
 * Pi reports a tool call block while it is still writing that block's
 * arguments. Providers differ: some emit an id and name up front, some start
 * with both empty and backfill them through argument deltas (including empty
 * ones), and some emit the whole call at once. The identity is only usable once
 * both are present, so this tracker reports each content block at most twice,
 * in content order: once when it becomes identifiable, and once when its
 * arguments are complete. Nothing is reported before there is an identity, and
 * a call whose identity only settles with its final arguments is reported once,
 * already complete.
 *
 * The tracker holds no transcript state of its own: it only answers "which
 * calls changed in this update", which the caller forwards as a transient
 * `tool_prepare` event. Nothing here is persisted. `toolcall_end` marks the end
 * of argument generation; execution may start later (or never), so the caller
 * never infers preparation from execution events.
 */

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export type PreparingToolCall = {
  toolCallId: string;
  toolName: string;
  /** Bounded short description of a delegation start call, when parseable. */
  taskTitle?: string;
  /**
   * Set only when this update reports the end of argument generation: the call
   * is fully written and its identity is final, so the preparing pulse stops.
   * Execution itself is still a separate, later event.
   */
  ready?: boolean;
};

export type ToolArgsPreparation = {
  /** Preparation changes from one stream event, in content order. */
  observe(event: AssistantMessageEvent): readonly PreparingToolCall[];
  /** Forget this message's progress when the next one starts. */
  reset(): void;
};

const NOTHING: readonly PreparingToolCall[] = Object.freeze([]);

/** A card title, not a brief: one line, bounded, never the raw arguments. */
const MAX_TASK_TITLE = 200;

/** Delegation start calls: the only calls whose card names their work. */
const DELEGATION_TOOLS = new Set(["task", "subagent"]);

function bareToolName(toolName: string): string {
  const tail = toolName.split(".").pop() ?? toolName;
  return tail.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function taskTitle(toolName: string, args: unknown): string | undefined {
  if (!DELEGATION_TOOLS.has(bareToolName(toolName))) return undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const description = (args as { description?: unknown }).description;
  if (typeof description !== "string") return undefined;
  const title = description.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, MAX_TASK_TITLE) : undefined;
}

type PreparedBlock = {
  toolCallId: string;
  toolName: string;
  /** Argument generation already ended for this content block. */
  ready: boolean;
};

export function createToolArgsPreparation(): ToolArgsPreparation {
  /** Content index → what is already known about that call. */
  const preparedContent = new Map<number, PreparedBlock>();
  return {
    observe(event) {
      if (
        event.type !== "toolcall_start" &&
        event.type !== "toolcall_delta" &&
        event.type !== "toolcall_end"
      ) {
        return NOTHING;
      }
      const final = event.type === "toolcall_end";
      // A batch's parallel calls stream and finish independently: only the
      // block this frame ended is complete, never its still-streaming siblings.
      const finalIndex = final ? event.contentIndex : -1;
      const content = event.partial.content;
      let updates: PreparingToolCall[] | undefined;
      for (let index = 0; index < content.length; index += 1) {
        const block = content[index];
        if (!block || block.type !== "toolCall") continue;
        // An empty id or name is not an identity yet: the call becomes
        // identifiable only when both are present, however late that is.
        const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
        const toolName = typeof block.name === "string" ? block.name.trim() : "";
        if (!toolCallId || !toolName) continue;
        const known = preparedContent.get(index);
        if (known) {
          // Already identified: only the end of argument generation is news.
          if (known.ready || index !== finalIndex) continue;
          known.ready = true;
          updates ??= [];
          // The description is complete only now, so this frame carries its
          // final bounded spelling — never a per-delta resend of a
          // half-written argument. An ordinary tool carries no title.
          const title = taskTitle(toolName, block.arguments);
          updates.push({
            toolCallId,
            toolName,
            ...(title ? { taskTitle: title } : {}),
            ready: true,
          });
          continue;
        }
        const title = taskTitle(toolName, block.arguments);
        preparedContent.set(index, { toolCallId, toolName, ready: index === finalIndex });
        updates ??= [];
        updates.push({
          toolCallId,
          toolName,
          ...(title ? { taskTitle: title } : {}),
          // A call whose identity first appears with its final arguments never
          // pulses: it is already complete on arrival.
          ...(index === finalIndex ? { ready: true } : {}),
        });
      }
      return updates ?? NOTHING;
    },
    reset() {
      preparedContent.clear();
    },
  };
}
