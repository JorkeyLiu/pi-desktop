import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * A `TaskSteer` header names the delegation it steers: the target task title
 * plus the agent role the `Task` call recorded — never anything on the steer
 * row itself, which the runtime sends as exactly `delegationId` + `message`.
 */

const createdAt = "2026-10-18T00:00:00.000Z";

function envelope(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

/** A recorded `Task` call: the agent role lives in its own `args.agent`. */
function taskRow({ callId, agent, description, delegationId, args = {} }) {
  return {
    id: `task-${callId}`,
    role: "tool",
    content: "",
    createdAt,
    toolName: "Task",
    toolCallId: callId,
    toolStatus: "success",
    toolArgs: { agent, description, ...args },
    toolResult: envelope({ delegationId, status: "completed" }),
  };
}

/** A real steer row: `delegationId` + `message` only, plus the queue receipt. */
function steerRow({ callId, delegationId, text }) {
  return {
    id: `steer-${callId}`,
    role: "tool",
    content: "",
    createdAt,
    toolName: "TaskSteer",
    toolCallId: callId,
    toolStatus: "success",
    toolArgs: { delegationId, message: text },
    toolResult: envelope({
      delegationId,
      messageId: `msg-${callId}`,
      status: "queued",
      delivery: "next_turn",
      source: "model",
    }),
  };
}

const task = taskRow({
  callId: "call-a",
  agent: "manifestor",
  description: "修复分页窗口合并",
  delegationId: "dlg-a",
});
const steer = steerRow({
  callId: "call-steer",
  delegationId: "dlg-a",
  text: "请复用现有分页窗口模型，并补充边界测试。",
});

test("the steer badge reads the target Task record, never steer args", async (t) => {
  const ssr = await slotSsr(t);
  const { subagentTaskAgents } = await ssr.load("/src/lib/subagent-title.ts");
  assert.ok(!("agent" in steer.toolArgs), "steer args are delegationId/message only");
  assert.ok(!("agentName" in steer), "steer rows carry no run-lineage name");
  const agents = subagentTaskAgents([task, steer]);
  assert.equal(agents.get("dlg-a"), "manifestor");
});

test("a resume continuation never renames the delegation it continues", async (t) => {
  const ssr = await slotSsr(t);
  const { subagentTaskAgents, subagentTaskTitles } = await ssr.load(
    "/src/lib/subagent-title.ts",
  );
  const continuation = taskRow({
    callId: "call-b",
    agent: "impostor",
    description: "other work",
    delegationId: "dlg-b",
    args: { resume: "dlg-a" },
  });
  const agents = subagentTaskAgents([task, continuation, steer]);
  assert.equal(agents.get("dlg-a"), "manifestor");
  assert.equal(agents.get("dlg-b"), "manifestor");
  const titles = subagentTaskTitles([task, continuation, steer]);
  assert.equal(titles.get("dlg-b"), "修复分页窗口合并");
});

test("the collapsed head reads the recorded agent plainly and tiles the target task", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { SubagentTitleProvider } = await ssr.load("/src/lib/subagent-title-provider.tsx");
  const host = ssr.render(
    createElement(
      SubagentTitleProvider,
      { messages: [task, steer] },
      createElement(ToolRow, { message: steer }),
    ),
  );
  assert.ok(host.includes('data-tool-name="TaskSteer"'), "the row keeps its TaskSteer identity");
  // Unified task header: no generic agent pill. The recorded agent reads as
  // plain summary text while the target title sits in the shared right tile.
  assert.doesNotMatch(host, /<span class="tool-row-agent"(?! is-)/, "no generic agent pill");
  assert.ok(
    host.includes('<span class="tool-row-summary"') && host.includes(">manifestor</span>"),
    "the head names the target's recorded agent as plain text",
  );
  assert.ok(
    host.includes('<span class="tool-row-agent is-delivered"') &&
      host.includes("修复分页窗口合并"),
    "the head tiles the target task in the shared right cluster",
  );
});

test("an unknown target renders no badge, never the routing id", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { SubagentTitleProvider } = await ssr.load("/src/lib/subagent-title-provider.tsx");
  const stray = steerRow({ callId: "call-stray", delegationId: "dlg-missing", text: "nudge" });
  const host = ssr.render(
    createElement(
      SubagentTitleProvider,
      { messages: [stray] },
      createElement(ToolRow, { message: stray }),
    ),
  );
  assert.doesNotMatch(host, /tool-row-agent/, "no badge without a recorded target");
  assert.ok(!host.includes("dlg-missing"), "the routing id never reaches the head");
});
