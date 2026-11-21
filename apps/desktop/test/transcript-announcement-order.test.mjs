/**
 * Two position rules, one authority each, shared by both transcript paths.
 *
 * A live-named tool row's position is fixed at its first announcement;
 * completion, refresh, and replay rewrite values but must never move it.
 * Both paths share `orderRowsByLiveAnnouncement` for that: rows the live
 * tail names keep the announcement order the transcript already showed.
 * For those rows `createdAt` is display metadata, never a position key.
 * Rows the live tail does not name stay on the chronological history
 * baseline (`createdAt` order with arrival tiebreak): the delegate view
 * restores `orderedRows`, so paging, focus islands, and context keep the
 * semantics the existing scoped-history tests pin down. No completion or
 * status re-sort may move a row the baseline already placed.
 */
 import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { mergeLiveSessionMessages, orderRowsByLiveAnnouncement } = await import(
  "../src/lib/session-transcript.ts"
);
const { applySubagentHistoryPage, createSubagentHistoryEntry, subagentHistoryMessages } = await import(
  "../src/lib/subagent-history.ts"
);

const stamp = (ms) => new Date(Date.parse("2026-10-13T00:00:00.000Z") + ms).toISOString();

const tool = (id, createdAt, status = "running") => ({
  id,
  role: "tool",
  toolCallId: id,
  toolName: "Bash",
  content: id,
  createdAt,
  toolStatus: status,
  status: status === "running" ? "streaming" : "complete",
});

const liveOrderOf = (rows) => {
  const order = new Map();
  for (const [index, row] of rows.entries()) {
    if (!order.has(row.id)) order.set(row.id, index);
  }
  return order;
};

test("shared helper restores announcement order over a finish-ordered skeleton", () => {
  const merged = [tool("b", stamp(130), "success"), tool("a", stamp(130), "success")];
  const live = [tool("a", stamp(110)), tool("b", stamp(110))];
  const out = orderRowsByLiveAnnouncement(merged, liveOrderOf(live), () => true);
  assert.deepEqual(out.map((row) => row.id), ["a", "b"]);
});

test("shared helper leaves durable-only rows on the skeleton", () => {
  const old = { ...tool("old", stamp(10), "success"), parentToolCallId: undefined };
  const merged = [old, tool("b", stamp(130), "success"), tool("a", stamp(130), "success")];
  const live = [tool("a", stamp(110)), tool("b", stamp(110))];
  const out = orderRowsByLiveAnnouncement(merged, liveOrderOf(live), (row) => row.id !== "old");
  assert.deepEqual(out.map((row) => row.id), ["old", "a", "b"]);
  assert.equal(out[0], old);
});

test("shared helper returns the same array when announcement order holds", () => {
  const merged = [tool("a", stamp(110)), tool("b", stamp(120))];
  const live = [tool("a", stamp(110)), tool("b", stamp(120))];
  const out = orderRowsByLiveAnnouncement(merged, liveOrderOf(live), () => true);
  assert.equal(out, merged);
});

test("main merge keeps announcement order when durable persists finish order", () => {
  const durable = [
    { ...tool("b", stamp(130), "success"), toolCompletedAt: stamp(200) },
    { ...tool("a", stamp(130), "success"), toolCompletedAt: stamp(300) },
  ];
   const live = [tool("a", stamp(110)), tool("b", stamp(110), "success")];
  const merged = mergeLiveSessionMessages(durable, live);
  assert.deepEqual(merged.map((row) => row.id), ["a", "b"]);
  // Durable values stay authoritative on the main path.
  assert.equal(merged[1].toolCompletedAt, stamp(200));
});

test("main merge keeps older live-only rows before a newer durable window", () => {
  const durable = [tool("new", stamp(500), "success")];
  const live = [tool("old-live", stamp(100)), tool("new", stamp(500))];
  const merged = mergeLiveSessionMessages(durable, live);
  assert.deepEqual(merged.map((row) => row.id), ["old-live", "new"]);
});

test("main merge preserves steering and general message order", () => {
  const durable = [
    { id: "u1", role: "user", content: "steer", createdAt: stamp(115), status: "complete" },
    { ...tool("b", stamp(130), "success"), toolCompletedAt: stamp(200) },
    { ...tool("a", stamp(130), "success"), toolCompletedAt: stamp(300) },
  ];
  const live = [
    { id: "u1", role: "user", content: "steer", createdAt: stamp(115), status: "complete" },
    tool("a", stamp(110)),
    tool("b", stamp(110)),
  ];
  const merged = mergeLiveSessionMessages(durable, live);
  assert.deepEqual(merged.map((row) => row.id), ["u1", "a", "b"]);
});

 const taskRoot = (callId, delegationId, createdAt) => ({
   id: `${callId}-row`,
   role: "tool",
   toolName: "Task",
   toolCallId: callId,
   content: "delegated",
   createdAt,
   toolStatus: "running",
   status: "streaming",
   toolResult: { details: { delegationId } },
 });

 const delegateEntry = (messages) => {
   let entry = createSubagentHistoryEntry("s", "task-1", 1);
   entry = {
     ...entry,
     messages,
     context: [taskRoot("task-1", "d-task-1", stamp(100))],
     status: "ready",
     finalized: true,
   };
   return entry;
 };

const child = (id, parent, createdAt, status = "running") => ({
  ...tool(id, createdAt, status),
  parentToolCallId: parent,
});

test("delegate render keeps announcement order over a finish-ordered page with tied stamps", () => {
  const entry = delegateEntry([
    child("b", "task-1", stamp(130), "success"),
    child("a", "task-1", stamp(130), "success"),
  ]);
  const live = [child("a", "task-1", stamp(110)), child("b", "task-1", stamp(110))];
  const out = subagentHistoryMessages(entry, live);
   assert.deepEqual(out.map((row) => row.id), ["task-1-row", "a", "b"]);
  // Live values win on the delegate render path.
   assert.equal(out[1].createdAt, stamp(110));
});

 test("delegate render keeps durable-only rows on the chronological baseline", () => {
   // The root record predates its children (ingestion persists the `Task`
   // call before the child rows, as in every real fixture): the baseline
   // therefore holds the root first and the durable-only child by creation
   // time. The earlier revision of this test dated the durable-only child
   // before the root, which no real entry can hold and which contradicts the
   // existing scoped-history chronology — corrected here, expectation kept.
   const entry = delegateEntry([
     child("old", "task-1", stamp(105), "success"),
     child("b", "task-1", stamp(130), "success"),
   ]);
   const live = [child("a", "task-1", stamp(110)), child("b", "task-1", stamp(130), "success")];
   const out = subagentHistoryMessages(entry, live);
   // Root records stay first (the entry keeps them apart from child rows);
   // a durable-only child keeps its chronological baseline slot and the live
   // overlay only moves rows the live tail names — the live-only `a` takes
   // announcement order ahead of `b` without pulling `old` along.
   assert.deepEqual(out.map((row) => row.id), ["task-1-row", "old", "a", "b"]);
 });

 test("delegate render keeps A/B when completion re-stamps A newer than B", () => {
   // Sparse overlap: the live tail names only the re-stamped A while the
   // completed B is a durable-only anchor. A full baseline re-sort would put
   // the re-stamped A after B; the baseline sort skips live-named rows, so
   // the overlay keeps A ahead and B never drags it along.
   const entry = delegateEntry([
     { ...child("a", "task-1", stamp(130), "success"), toolCompletedAt: stamp(160) },
     { ...child("b", "task-1", stamp(120), "success"), toolCompletedAt: stamp(150) },
   ]);
   const live = [{ ...child("a", "task-1", stamp(130), "success"), toolCompletedAt: stamp(160) }];
   const out = subagentHistoryMessages(entry, live);
   assert.deepEqual(out.map((row) => row.id), ["task-1-row", "a", "b"]);
 });

test("delegate render keeps distinct-stamp time order untouched", () => {
  const entry = delegateEntry([
    child("b", "task-1", stamp(140), "success"),
    child("a", "task-1", stamp(130), "success"),
  ]);
  const live = [child("a", "task-1", stamp(110)), child("b", "task-1", stamp(140), "success")];
  const out = subagentHistoryMessages(entry, live);
   assert.deepEqual(out.map((row) => row.id), ["task-1-row", "a", "b"]);
});

test("delegate render survives a latest refresh that persists finish order", () => {
  let entry = delegateEntry([child("a", "task-1", stamp(110))]);
  const page = {
    session: {
      id: "s",
      messages: [
        child("b", "task-1", stamp(130), "success"),
        child("a", "task-1", stamp(130), "success"),
      ],
      messageStart: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
      historyScope: { kind: "delegation", id: "task-1" },
      historyContext: [],
    },
  };
  entry = applySubagentHistoryPage(entry, page, "latest", 2);
  const live = [child("a", "task-1", stamp(110)), child("b", "task-1", stamp(110))];
  const out = subagentHistoryMessages(entry, live);
   assert.deepEqual(out.map((row) => row.id), ["task-1-row", "a", "b"]);
});
