import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { GenerationThroughputTotals } from "@pi-desktop/shared";

/**
 * One monotonic generation-throughput sampler, shared by parent and child
 * paths so both sessions measure the identical figure.
 *
 * Tokens are the provider's exact output count, used as-is (reasoning stays
 * inside output per pi-ai's contract; a real provider zero is a sample).
 * Duration is the monotonic span from this attempt's first nonempty
 * model-generated event to the settled end. Failed, aborted, retried, and
 * usage-less attempts never contribute: the stamp is attempt-scoped
 * (`resetAttempt` on every `message_start`) and consumed single-shot by a
 * settled complete `message_end`.
 */
export class GenerationThroughputSampler {
  /**
   * Monotonic timestamp of this attempt's first nonempty model-generated
   * event. Set by the synchronous `message_update` hook before any emission
   * gate or stream coalescer, so coalesced or gated frames can never move the
   * stamp. A turn that never generates content — empty prelude, metadata-only
   * tool-call start, bare signature — leaves this unset and commits nothing.
   */
  private firstContentAt?: number;
  /** Exact-provider-output sums committed by settled complete turns. */
  private tokens = 0;
  private durationMs = 0;
  private samples = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * Stamp this attempt's first nonempty model-generated event.
   *
   * Only real generation counts: nonempty text, thinking, and tool-call
   * deltas, plus a whole-call snapshot whose arguments are more than a bare
   * signature. `undefined`, empty deltas, empty preludes, metadata-only starts,
   * and `*_start`/`*_end` framing never stamp.
   */
  noteEvent(event: AssistantMessageEvent | undefined): void {
    if (this.firstContentAt !== undefined || !event) return;
    switch (event.type) {
      case "text_delta":
      case "thinking_delta":
      case "toolcall_delta":
        if (event.delta.length > 0) this.firstContentAt = this.now();
        return;
      case "toolcall_start": {
        const block = event.partial.content[event.contentIndex];
        if (block?.type !== "toolCall") return;
        if ((JSON.stringify(block.arguments)?.length ?? 0) > 2) {
          this.firstContentAt = this.now();
        }
        return;
      }
      default:
        return;
    }
  }

  /** A new provider attempt starts: the previous attempt's stamp never leaks in. */
  resetAttempt(): void {
    this.firstContentAt = undefined;
  }

  /**
   * Commit one settled complete turn and return its single-sample carrier
   * (`samples: 1`) for the settled row, or undefined when nothing was
   * committable. The sampler still accumulates session totals; this is the
   * only commit core, so parent rows and child totals can never diverge.
   */
  commitRowSample(output: unknown): GenerationThroughputTotals | undefined {
    const startedAt = this.firstContentAt;
    this.firstContentAt = undefined;
    if (startedAt === undefined) return undefined;
    if (typeof output !== "number" || !Number.isFinite(output) || output < 0) return undefined;
    const durationMs = this.now() - startedAt;
    if (!(durationMs > 0)) return undefined;
    this.tokens += output;
    this.durationMs += durationMs;
    this.samples += 1;
    return { tokens: output, durationMs, samples: 1 };
  }

  /**
   * Commit one settled complete turn's sample. Returns true when a sample
   * was committed. The stamp is always consumed here, and a turn with no
   * stamp or no usable output commits nothing.
   */
  commitSample(output: unknown): boolean {
    return this.commitRowSample(output) !== undefined;
  }

  /** Canonical totals, present only when a sample was committed. */
  totals(): GenerationThroughputTotals | undefined {
    if (this.samples <= 0) return undefined;
    return { tokens: this.tokens, durationMs: this.durationMs, samples: this.samples };
  }
}
