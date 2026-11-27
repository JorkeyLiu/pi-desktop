import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { subagentLatestReplyStartedAt } = await import("../src/lib/subagent-transcript.ts");

const stamp = (seconds) => new Date(Date.UTC(2026, 9, 13, 0, 0, seconds)).toISOString();
const at = (seconds) => Date.parse(stamp(seconds));

const taskCall = (callId = "task-1", delegationId = "d1") => ({
  id: `${callId}-row`,
  role: "tool",
  content: "",
  createdAt: stamp(1),
  toolName: "Task",
  toolCallId: callId,
  toolStatus: "success",
  toolArgs: { task: "investigate" },
  toolResult: { delegationId },
});

const childAssistant = (id, seconds, extra = {}) => ({
  id,
  role: "assistant",
  content: `reply ${id}`,
  createdAt: stamp(seconds),
  parentToolCallId: "task-1",
  agentName: "explorer",
  ...extra,
});

const childTool = (id) => ({
  id,
  role: "tool",
  content: "",
  createdAt: stamp(2),
  toolName: "Read",
  toolCallId: id,
  toolStatus: "running",
  status: "streaming",
  parentToolCallId: "task-1",
});

test("the baseline is the latest child reply, not the delegation start", () => {
  const messages = [
    taskCall(),
    childAssistant("a-1", 10),
    childTool("read-1"),
    childAssistant("a-2", 40),
  ];
  assert.equal(subagentLatestReplyStartedAt(messages, "d1"), at(40));
});

test("a streaming update of the same reply keeps the baseline", () => {
  const before = [taskCall(), childAssistant("a-1", 10)];
  const updated = [
    taskCall(),
    { ...childAssistant("a-1", 10), content: "reply a-1 with more tokens" },
  ];
  assert.equal(
    subagentLatestReplyStartedAt(updated, "d1"),
    subagentLatestReplyStartedAt(before, "d1"),
  );
});

test("a new reply id resets the baseline to its own creation time", () => {
  const before = [taskCall(), childAssistant("a-1", 10)];
  const after = [...before, childAssistant("a-2", 90)];
  const previous = subagentLatestReplyStartedAt(before, "d1");
  const next = subagentLatestReplyStartedAt(after, "d1");
  assert.equal(previous, at(10));
  assert.equal(next, at(90));
  assert.notEqual(next, previous);
});

test("the same transcript restores the same baseline after a remount", () => {
  const messages = [taskCall(), childAssistant("a-1", 10), childAssistant("a-2", 40)];
  const firstMount = subagentLatestReplyStartedAt(messages, "d1");
  const secondMount = subagentLatestReplyStartedAt([...messages], "d1");
  assert.equal(firstMount, at(40));
  assert.equal(secondMount, firstMount);
});

test("no child reply yet leaves the baseline to the delegation timing fallback", () => {
  assert.equal(subagentLatestReplyStartedAt([taskCall()], "d1"), undefined);
  assert.equal(subagentLatestReplyStartedAt([], "d1"), undefined);
  assert.equal(subagentLatestReplyStartedAt([taskCall()], "  "), undefined);
});

test("replies outside the chain never move the baseline", () => {
  const messages = [
    taskCall("task-1", "d1"),
    childAssistant("a-1", 10),
    { ...childAssistant("a-9", 80), parentToolCallId: "task-other" },
  ];
  assert.equal(subagentLatestReplyStartedAt(messages, "d1"), at(10));
});
