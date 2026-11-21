/**
 * Generation phase for thinking: the phase reports what the model is
 * currently generating, not which thinking blocks are still open.
 *
 * pi-ai emits `thinking_start` / `thinking_delta` / `thinking_end` per
 * content block, and pi-agent-core forwards each one as a `message_update`
 * carrying that frame in `assistantMessageEvent`. The assistant message
 * itself stays `status: "streaming"` through all of it, and the cumulative
 * thinking text stops growing before the end frame — so a producer that only
 * emits on content deltas swallows the end of thinking. Worse, some providers
 * move on to tool calls or reply text without ever ending the thinking block
 * (responses can `toolcall_start` before `reasoning output_item.done`;
 * completions stream one final finish block): a tracker that waits for
 * `thinking_end` keeps the row breathing while the tool row is already up.
 * This tracker folds typed generation frames into one explicit phase per
 * assistant bubble:
 *
 * - `thinking_start` / `thinking_delta` report `streaming` and make their
 *   block the one generating; a later pair re-activates thinking after other
 *   generation,
 * - a real text or tool-call `*_start` / `*_delta` means generation left
 *   thinking and reports `complete`, even though no block ended,
 * - `thinking_end` moves the phase only when the block it ends is the one
 *   still generating: a duplicate, stray, or late end for another block is
 *   ignored, so it can never clear a newer block nor resurrect a completed
 *   phase,
 * - text/tool `*_end` markers for another lane never move the phase,
 * - `finish()` completes still-generating thinking at an attempt boundary
 *   (`message_end`, silent/progress/overflow/provider-retry reruns, abort,
 *   error, run teardown) and forgets the lane, so the next attempt reopens
 *   thinking only on a real thinking frame,
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
  /** Attempt-boundary fallback: complete still-generating thinking. */
  finish(): ThinkingPhase | undefined;
  reset(): void;
  phase(): ThinkingPhase | undefined;
};

export function createThinkingPhaseTracker(): ThinkingPhaseTracker {
  /** What the model is currently generating, from the latest typed frame. */
  let lane: "thinking" | "other" | undefined;
  /** Content index of the thinking block currently generating, when known. */
  let activeThinking: number | undefined;
  let current: ThinkingPhase | undefined;

  const set = (next: ThinkingPhase): ThinkingPhase | undefined => {
    if (current === next) return undefined;
    current = next;
    return next;
  };

  /** Generation left thinking for text or tool content: thinking goes still. */
  const leaveThinking = (): ThinkingPhase | undefined => {
    if (lane !== "thinking") return undefined;
    lane = "other";
    activeThinking = undefined;
    return set("complete");
  };

  return {
    observe(event) {
      if (!event) return undefined;
      switch (event.type) {
        case "thinking_start":
        case "thinking_delta":
          lane = "thinking";
          activeThinking = event.contentIndex;
          return set("streaming");
        case "thinking_end": {
          // An authoritative end moves the phase only when the block it ends
          // is the one still generating. A repeated, stray, or late end for
          // another block is ignored: it must neither clear a newer block nor
          // resurrect a completed phase.
          if (lane !== "thinking") return undefined;
          if (activeThinking !== undefined && activeThinking !== event.contentIndex) {
            return undefined;
          }
          lane = "other";
          activeThinking = undefined;
          return set("complete");
        }
        case "text_start":
        case "text_delta":
        case "toolcall_start":
        case "toolcall_delta":
          // The model is now generating text or tool content: thinking is no
          // longer the active generation even though its block never ended.
          return leaveThinking();
        default:
          // `text_end`, `toolcall_end`, hosted-search, start/done/error frames
          // mark another lane's boundary; they say nothing about what is
          // generating now, so they never move the phase here.
          return undefined;
      }
    },

    noteThinkingDelta() {
      // Compatibility for real thinking deltas that arrived without typed
      // frames: they reopen thinking generation. Producers only fall back here
      // when the frame carries no typed event at all, so cumulative thinking
      // echoed inside a typed tool frame cannot reopen the phase.
      if (lane !== "thinking") {
        lane = "thinking";
        activeThinking = undefined;
      }
      return set("streaming");
    },

    finish() {
      // Every provider-attempt teardown lands here, including reruns that keep
      // the same assistant bubble: still-generating thinking stops, and the
      // lane is forgotten so the next attempt never inherits it.
      lane = undefined;
      activeThinking = undefined;
      if (current !== "streaming") return undefined;
      return set("complete");
    },

    reset() {
      lane = undefined;
      activeThinking = undefined;
      current = undefined;
    },

    phase() {
      return current;
    },
  };
}
