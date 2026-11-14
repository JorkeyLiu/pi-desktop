import { describe, expect, it } from "vitest";
import {
  acceptanceText,
  DeliveryReceipts,
  type DeliveryBatch,
} from "./delivery-receipt.js";
import type { ProgramDeliveryRecord } from "./delegation-coordinator.js";

type Record = ProgramDeliveryRecord & { reportDelivered?: boolean };

function settlingRecord(
  delegationId: string,
  overrides: Partial<Record> = {},
): Record {
  return {
    delegationId,
    status: "completed",
    ...overrides,
  };
}

function batch(
  text: string,
  records: Record[],
  included: string[] = [],
): DeliveryBatch {
  return {
    text,
    records,
    includedDelegationIds: new Set(included),
  };
}

function textBlocks(...values: string[]) {
  return values.map((value) => ({ type: "text", text: value }));
}

describe("acceptanceText", () => {
  it("reads the plain text of the content a provider or tool result carries", () => {
    expect(acceptanceText("whole report")).toBe("whole report");
    expect(
      acceptanceText([
        { type: "text", text: "part one " },
        { type: "image", data: "…", mimeType: "image/png" },
        { type: "text", text: "part two" },
      ]),
    ).toBe("part one part two");
  });

  it("returns no text for content that cannot carry a report", () => {
    expect(acceptanceText(undefined)).toBe("");
    expect(acceptanceText(null)).toBe("");
    expect(acceptanceText([{ type: "toolCall", id: "call-1", name: "Task" }])).toBe("");
  });
});

describe("idle resume receipts", () => {
  it("marks only the settled records the accepted prompt included", () => {
    const receipts = new DeliveryReceipts();
    const inBatch = settlingRecord("in-batch");
    const omitted = settlingRecord("omitted");
    const running = settlingRecord("running", { status: "running" });
    receipts.expectAutoResume(
      batch("report", [inBatch, omitted, running], ["in-batch", "running"]),
    );

    const marked = receipts.accept({
      role: "user",
      content: textBlocks("report"),
    });

    expect(marked).toEqual(["in-batch"]);
    expect(inBatch.reportDelivered).toBe(true);
    expect(omitted.reportDelivered).toBeUndefined();
    expect(running.reportDelivered).toBeUndefined();
    expect(receipts.pendingCount).toBe(0);
  });

  it("ignores an accepted message whose text is not this batch", () => {
    const receipts = new DeliveryReceipts();
    const record = settlingRecord("pending");
    receipts.expectAutoResume(batch("the report text", [record], ["pending"]));

    expect(receipts.accept({ role: "user", content: textBlocks("something else") })).toEqual([]);
    expect(record.reportDelivered).toBeUndefined();
    expect(receipts.pendingCount).toBe(1);

    expect(receipts.accept({ role: "assistant", content: textBlocks("the report text") })).toEqual([]);
    expect(record.reportDelivered).toBeUndefined();

    expect(receipts.accept({ role: "user", content: textBlocks("the report text") })).toEqual([
      "pending",
    ]);
    expect(record.reportDelivered).toBe(true);
  });

  it("marks once, and a repeated accepted message is a no-op", () => {
    const receipts = new DeliveryReceipts();
    const record = settlingRecord("once");
    receipts.expectAutoResume(batch("report", [record], ["once"]));

    expect(receipts.accept({ role: "user", content: textBlocks("report") })).toEqual(["once"]);
    expect(receipts.accept({ role: "user", content: textBlocks("report") })).toEqual([]);
    expect(record.reportDelivered).toBe(true);
  });

  it("hands the caller the same acceptance answer through a receipt handle", () => {
    const receipts = new DeliveryReceipts();
    const record = settlingRecord("handled");
    const handle = receipts.expectAutoResume(batch("report", [record], ["handled"]));
    expect(handle.accepted()).toBe(false);
    receipts.accept({ role: "user", content: textBlocks("report") });
    expect(handle.accepted()).toBe(true);
    handle.cancel();
    expect(record.reportDelivered).toBe(true);
    expect(receipts.pendingCount).toBe(0);
  });

  it("drops a cancelled receipt without marking, so the report stays pending", () => {
    const receipts = new DeliveryReceipts();
    const record = settlingRecord("cancelled");
    const handle = receipts.expectAutoResume(batch("report", [record], ["cancelled"]));
    handle.cancel();
    expect(handle.accepted()).toBe(false);
    expect(receipts.pendingCount).toBe(0);
    expect(receipts.accept({ role: "user", content: textBlocks("report") })).toEqual([]);
    expect(record.reportDelivered).toBeUndefined();
  });

  it("keeps a bounded backlog and drops the oldest receipt unmarked", () => {
    const receipts = new DeliveryReceipts();
    const records: Record[] = [];
    for (let index = 0; index <= 16; index += 1) {
      const record = settlingRecord(`record-${index}`);
      records.push(record);
      receipts.expectAutoResume(batch(`report-${index}`, [record], [record.delegationId]));
    }
    expect(receipts.pendingCount).toBe(16);
    expect(receipts.accept({ role: "user", content: textBlocks("report-0") })).toEqual([]);
    expect(records[0].reportDelivered).toBeUndefined();
  });
});

describe("TaskWait result receipts", () => {
  it("marks the batch only when the accepted tool result echoes it", () => {
    const receipts = new DeliveryReceipts();
    const record = settlingRecord("waited");
    receipts.expectWaitResult("call-1", batch("wait result", [record], ["waited"]));

    expect(
      receipts.accept({
        role: "toolResult",
        toolCallId: "call-1",
        content: textBlocks("wait result"),
      }),
    ).toEqual(["waited"]);
    expect(record.reportDelivered).toBe(true);
    expect(receipts.pendingCount).toBe(0);
  });

  it("never marks a result the loop replaced, truncated, or failed", () => {
    const receipts = new DeliveryReceipts();
    const record = settlingRecord("replaced");
    receipts.expectWaitResult("call-1", batch("assembled report", [record], ["replaced"]));

    // `afterToolCall` may replace a result before it becomes history: same
    // call id, different text. Nothing was delivered, so nothing is marked.
    expect(
      receipts.accept({
        role: "toolResult",
        toolCallId: "call-1",
        content: textBlocks("replacement text"),
      }),
    ).toEqual([]);
    expect(record.reportDelivered).toBeUndefined();
    expect(receipts.pendingCount).toBe(0);
  });

  it("ignores an unrelated tool call and a missing call id", () => {
    const receipts = new DeliveryReceipts();
    const record = settlingRecord("waited");
    receipts.expectWaitResult("call-1", batch("wait result", [record], ["waited"]));

    expect(
      receipts.accept({ role: "toolResult", toolCallId: "call-2", content: textBlocks("wait result") }),
    ).toEqual([]);
    expect(
      receipts.accept({ role: "toolResult", content: textBlocks("wait result") }),
    ).toEqual([]);
    expect(record.reportDelivered).toBeUndefined();
    expect(receipts.pendingCount).toBe(1);
  });

  it("replaces one call's receipt with the newest assembly", () => {
    const receipts = new DeliveryReceipts();
    const first = settlingRecord("first");
    const second = settlingRecord("second");
    receipts.expectWaitResult("call-1", batch("first assembly", [first], ["first"]));
    receipts.expectWaitResult("call-1", batch("second assembly", [second], ["second"]));

    expect(
      receipts.accept({ role: "toolResult", toolCallId: "call-1", content: textBlocks("second assembly") }),
    ).toEqual(["second"]);
    expect(second.reportDelivered).toBe(true);
    expect(first.reportDelivered).toBeUndefined();
  });

  it("clear drops every pending receipt without marking anything", () => {
    const receipts = new DeliveryReceipts();
    const auto = settlingRecord("auto");
    const waited = settlingRecord("waited");
    receipts.expectAutoResume(batch("auto report", [auto], ["auto"]));
    receipts.expectWaitResult("call-1", batch("wait result", [waited], ["waited"]));
    expect(receipts.pendingCount).toBe(2);

    receipts.clear();
    expect(receipts.pendingCount).toBe(0);
    expect(receipts.accept({ role: "user", content: textBlocks("auto report") })).toEqual([]);
    expect(
      receipts.accept({ role: "toolResult", toolCallId: "call-1", content: textBlocks("wait result") }),
    ).toEqual([]);
    expect(auto.reportDelivered).toBeUndefined();
    expect(waited.reportDelivered).toBeUndefined();
  });
});
