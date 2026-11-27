/**
 * The delegate's current live activity: a pure projection of the parent's
 * live tail, independent of the entry, the panel, and the reading window.
 *
 * These tests cover the selector only — chain resolution without an entry,
 * in-flight tool and streaming-assistant rows, Task-root exclusion, window
 * dedupe, foreign-chain isolation, and settled-row exit. The store contract
 * (one initial read, historical window) lives in scoped-subagent-history.test.mjs;
 * the pinned visible section lives in the rendered probe
 * (scripts/e2e/scoped-subagent-history.tsx).
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { subagentLiveActivityRows } = await import("../src/lib/subagent-history.ts");

const stamp = (index) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();

const taskRow = (callId, delegationId) => ({
  id: `${callId}-row`,
  role: "tool",
  toolName: "Task",
  toolCallId: callId,
  toolArgs: { prompt: "delegate" },
  toolResult: { delegationId },
  content: "delegated",
  createdAt: stamp(1),
});

const childRow = (index, parentToolCallId) => ({
  id: `child-${index}`,
  role: "tool",
  toolName: "Read",
  toolCallId: `read-${index}`,
  parentToolCallId,
  toolArgs: { path: `file-${index}.ts` },
  content: `read file-${index}`,
  createdAt: stamp(index),
});

test("live activity shows parallel running tools and streaming replies without repeating the window", () => {
  const runningTask = { ...taskRow("call-1", "d1"), toolStatus: "running", status: "streaming" };
  const first = { ...childRow(2001, "call-1"), toolCallId: "bash-2001", toolStatus: "running", status: "streaming" };
  const second = { ...childRow(2002, "call-1"), toolCallId: "read-2002", toolStatus: "preparing", status: "streaming" };
  const settledChild = { ...childRow(1999, "call-1"), toolCallId: "bash-1999", toolStatus: "success", status: "complete" };
  const streamingReply = {
    id: "asst-2001",
    role: "assistant",
    content: "working through it",
    status: "streaming",
    parentToolCallId: "call-1",
    createdAt: stamp(2001),
  };
  const foreign = { ...childRow(3000, "call-9"), toolCallId: "bash-3000", toolStatus: "running", status: "streaming" };
  const live = [runningTask, settledChild, first, second, streamingReply, foreign];
  const ids = (rows) => rows.map((message) => message.id);
  // Root dispatches are briefs the history owns; settled and foreign rows are
  // never activity. Everything in flight on this chain shows, in live order.
  assert.deepEqual(ids(subagentLiveActivityRows(undefined, live, "d1", new Set())), [
    "child-2001",
    "child-2002",
    "asst-2001",
  ]);
  // A following tail merges those rows inline: the projection yields to the
  // window instead of showing them twice.
  assert.deepEqual(ids(subagentLiveActivityRows(undefined, live, "d1", new Set(["child-2001", "asst-2001"]))), [
    "child-2002",
  ]);
  // A chain the live array never names has no activity, even with rows present.
  assert.deepEqual(subagentLiveActivityRows(undefined, live, "d9", new Set()), []);
});
