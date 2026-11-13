/**
 * Delivery acceptance receipts: a delegation report batch counts as delivered
 * only once the complete message that carries it is accepted into the parent
 * `Agent.state.messages`. Assembly, a `TaskWait` `execute` return, a resolved
 * prompt, or a successfully streamed model response are not that boundary.
 *
 * pi-agent-core reports an accepted message through `message_end` and pushes
 * the same message into `state.messages` *before* running the listeners, so a
 * `message_end` observed here is already history. Two carriers deliver reports:
 *
 * - the idle resume prompt (a `user` message), identified by the exact text
 *   the batch was assembled into, and
 * - a `TaskWait` result (a `toolResult` message), identified by the tool call
 *   it answers plus that same assembled text. The loop may replace or drop a
 *   tool result before it becomes history (`afterToolCall`, a thrown `execute`,
 *   cancellation), so the call id alone does not prove the report arrived.
 *
 * A receipt marks only the settled, parent-owned records the batch actually
 * included (the same rule `markProgramDelivery` owns). Everything else stays
 * pending: a report that never reached history is delivered by a later batch,
 * exactly once. A batch accepted into history is marked there even if the
 * provider request that follows fails; accepted history is never replayed.
 *
 * Receipts are short-lived bookkeeping, never a second delivery protocol:
 * `cancel` drops one, `clear` drops every pending receipt without marking, and
 * the runtime clears them when its run ends or it is disposed.
 */

import {
  markProgramDelivery,
  type ProgramDeliveryRecord,
} from "./delegation-coordinator.js";

/** One assembled report batch and the records it is allowed to consume. */
export type DeliveryBatch = {
  /** Exact text the batch was assembled into; the accepted message echoes it. */
  text: string;
  records: readonly ProgramDeliveryRecord[];
  includedDelegationIds: ReadonlySet<string>;
};

type AutoResumeReceipt = {
  carrier: "user";
  text: string;
  batch: DeliveryBatch;
};

type WaitResultReceipt = {
  carrier: "toolResult";
  toolCallId: string;
  text: string;
  batch: DeliveryBatch;
};

/** Structural view of the accepted message the runtime hands over. */
export type AcceptedMessage = {
  role: string;
  content?: unknown;
  toolCallId?: string;
};

/**
 * Caller-side view of one pending receipt. `accepted()` turns true when the
 * acceptance boundary consumed it — never because of `cancel`.
 */
export type ReceiptHandle = {
  /** Drop this receipt without marking; safe after acceptance. */
  cancel: () => void;
  /** True once an accepted message consumed this receipt. */
  accepted: () => boolean;
};

/**
 * Cap on receipts that were registered but never accepted inside one run. A
 * run registers one at a time, so this only bounds a pathological loop; the
 * oldest pending receipt drops out unmarked, which keeps its report pending
 * instead of consuming it.
 */
const MAX_PENDING_RECEIPTS = 16;

/**
 * The plain text of an accepted message: `text` blocks joined, or the string
 * itself for legacy rows. Non-text blocks carry no report and are ignored.
 */
export function acceptanceText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type !== "text" || typeof candidate.text !== "string") continue;
    texts.push(candidate.text);
  }
  return texts.join("");
}

/**
 * Pending receipts for report-bearing messages that have been assembled but
 * not yet accepted into history. Pure bookkeeping: it holds no timers, no
 * promises, and no provider state.
 */
export class DeliveryReceipts {
  private autoResume: AutoResumeReceipt[] = [];
  private waitResults = new Map<string, WaitResultReceipt>();
  /** Receipts the acceptance boundary consumed, readable through a handle. */
  private consumed = new WeakSet<AutoResumeReceipt | WaitResultReceipt>();

  /** Expect one idle resume prompt carrying `batch.text` to reach history. */
  expectAutoResume(batch: DeliveryBatch): ReceiptHandle {
    const receipt: AutoResumeReceipt = { carrier: "user", text: batch.text, batch };
    this.autoResume.push(receipt);
    if (this.autoResume.length > MAX_PENDING_RECEIPTS) this.autoResume.shift();
    return this.handleFor(receipt, () => {
      const index = this.autoResume.indexOf(receipt);
      if (index >= 0) this.autoResume.splice(index, 1);
    });
  }

  /**
   * Expect the result of `toolCallId` carrying `batch.text` to reach history.
   * A re-executed call id replaces its predecessor: only the newest assembled
   * batch can become the accepted result.
   */
  expectWaitResult(toolCallId: string, batch: DeliveryBatch): ReceiptHandle {
    const receipt: WaitResultReceipt = {
      carrier: "toolResult",
      toolCallId,
      text: batch.text,
      batch,
    };
    this.waitResults.set(toolCallId, receipt);
    if (this.waitResults.size > MAX_PENDING_RECEIPTS) {
      const oldest = this.waitResults.keys().next();
      if (!oldest.done) this.waitResults.delete(oldest.value);
    }
    return this.handleFor(receipt, () => {
      if (this.waitResults.get(toolCallId) === receipt) {
        this.waitResults.delete(toolCallId);
      }
    });
  }

  private handleFor(
    receipt: AutoResumeReceipt | WaitResultReceipt,
    cancel: () => void,
  ): ReceiptHandle {
    return { cancel, accepted: () => this.consumed.has(receipt) };
  }

  /**
   * One accepted message. Marks the matching batch and returns the newly
   * marked delegation ids; an unmatched message changes nothing.
   */
  accept(message: AcceptedMessage): string[] {
    const text = acceptanceText(message.content);
    if (message.role === "user") {
      const index = this.autoResume.findIndex((receipt) => receipt.text === text);
      if (index < 0) return [];
      // The idle loop is serial, so one accepted prompt answers one receipt.
      const [receipt] = this.autoResume.splice(index, 1);
      this.consumed.add(receipt);
      return markBatch(receipt.batch);
    }
    if (message.role !== "toolResult") return [];
    const toolCallId = message.toolCallId;
    if (typeof toolCallId !== "string") return [];
    const receipt = this.waitResults.get(toolCallId);
    if (!receipt) return [];
    this.consumed.add(receipt);
    // A replaced, truncated, or failed result is history, but not this batch:
    // leave the report pending rather than marking a report that never arrived.
    this.waitResults.delete(toolCallId);
    if (receipt.text !== text) return [];
    return markBatch(receipt.batch);
  }

  /** Drop every pending receipt without marking anything. */
  clear(): void {
    this.autoResume = [];
    this.waitResults.clear();
  }

  /** Pending receipt count, for lifecycle assertions and tests. */
  get pendingCount(): number {
    return this.autoResume.length + this.waitResults.size;
  }
}

function markBatch(batch: DeliveryBatch): string[] {
  return markProgramDelivery(batch.records, batch.includedDelegationIds);
}
