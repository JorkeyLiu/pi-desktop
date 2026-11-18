/**
 * Block-level thinking phase shared by the session runtime and subagent runs.
 *
 * pi-ai emits `thinking_start` / `thinking_delta` / `thinking_end` per
 * content block, and pi-agent-core forwards each one as a `message_update`
 * whose `assistantMessageEvent` carries that frame. The assistant message
 * itself stays `status: "streaming"` through all of it, and the cumulative
 * thinking text stops growing before the end frame — so a producer that only
 * emits on content deltas swallows the end of thinking. This tracker folds
 * those frames into one explicit phase per assistant bubble:
 *
 * - `thinking_start` opens its block and reports `streaming`,
 * - `thinking_end` closes only its own block; the phase reports `complete`
 *   once no block is still open,
 * - a duplicate or stale end for a block that is not open is ignored, so it
 *   can never clear a newer block,
 * - text and tool-call frames never move the phase: later activity is not an
 *   end of thinking,
 * - `finish()` completes still-open thinking at a terminal boundary
 *   (`message_end`, abort, error, run teardown) for providers that terminate
 *   the stream without `thinking_end`,
 * - `reset()` starts a fresh bubble with no phase.
 *
 * Methods that change the phase return it; methods that leave it untouched
 * return `undefined` so producers emit only on real phase changes.
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export type ThinkingPhase = "streaming" | "complete";

export type ThinkingPhaseTracker = {
  observe(event: AssistantMessageEvent | undefined): ThinkingPhase | undefined;
  /** Compatibility for real thinking deltas that arrived without typed frames. */
  noteThinkingDelta(): ThinkingPhase | undefined;
  /** Terminal fallback: complete still-open thinking at stream teardown. */
  finish(): ThinkingPhase | undefined;
  reset(): void;
  phase(): ThinkingPhase | undefined;
};

export function createThinkingPhaseTracker(): ThinkingPhaseTracker {
  const open = new Set<number>();
  let current: ThinkingPhase | undefined;

  const set = (next: ThinkingPhase): ThinkingPhase | undefined => {
    if (current === next) return undefined;
    current = next;
    return next;
  };

  return {
    observe(event) {
      if (!event) return undefined;
      switch (event.type) {
        case "thinking_start":
          open.add(event.contentIndex);
          return set("streaming");
        case "thinking_delta":
          open.add(event.contentIndex);
          return set("streaming");
        case "thinking_end":
          // Only the matching open block closes. A repeated or stray end for
          // a block that is not open is ignored: it must not clear a newer
          // block and it must not resurrect a completed phase.
          if (!open.has(event.contentIndex)) return undefined;
          open.delete(event.contentIndex);
          if (open.size > 0) return undefined;
          return set("complete");
        default:
          // Text, tool-call, hosted-search, start/done/error frames carry no
          // block transition for thinking; later activity never ends it here.
          return undefined;
      }
    },

    noteThinkingDelta() {
      return set("streaming");
    },

    finish() {
      if (current !== "streaming") return undefined;
      open.clear();
      return set("complete");
    },

    reset() {
      open.clear();
      current = undefined;
    },

    phase() {
      return current;
    },
  };
}
