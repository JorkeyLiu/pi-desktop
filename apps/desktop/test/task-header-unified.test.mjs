/**
 * TaskSteer must reuse the TaskWait compact task header: left tool identity +
 * plain agent, right target title tile + state + chevron. The generic agent
 * pill + left text summary is the defect this test pins.
 *
 * Rendered through the production `ToolRow` with real `Task` records through
 * the real `SubagentTitleProvider`, so the data ownership (conversation
 * titles/agents maps, never steer args) is exercised, not asserted by regex.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const createdAt = "2026-10-18T00:00:00.000Z";

function envelope(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

/** A recorded `Task` call: title lives in `description`, agent in `args.agent`. */
function taskCall({ callId, agent, description, delegationId }) {
  return {
    id: `task-${callId}`,
    role: "tool",
    content: "",
    createdAt,
    toolName: "Task",
    toolCallId: callId,
    toolStatus: "success",
    toolArgs: { agent, description },
    toolResult: envelope({ delegationId, status: "completed" }),
  };
}

/** A real steer row: `delegationId` + `message` only, plus the queue receipt. */
function steerRow({ callId, delegationId, text, extraArgs = {}, extra = {} }) {
  return {
    id: `steer-${callId}`,
    role: "tool",
    content: "",
    createdAt,
    toolName: "TaskSteer",
    toolCallId: callId,
    toolStatus: "success",
    toolArgs: { delegationId, message: text, ...extraArgs },
    toolResult: envelope({
      delegationId,
      messageId: `msg-${callId}`,
      status: "queued",
      delivery: "next_turn",
      source: "model",
      ...extra.resultDetails,
    }),
    ...extra.message,
  };
}

/** A delivered `TaskWait`: completed result carrying the delegation report. */
function deliveredWait({ callId, delegationId, agent }) {
  return {
    id: `wait-${callId}`,
    role: "tool",
    content: "",
    createdAt,
    toolName: "TaskWait",
    toolCallId: callId,
    toolStatus: "success",
    toolArgs: { delegationIds: [delegationId] },
    toolResult: {
      content: [{ type: "text", text: `## ${agent} (${delegationId}) — completed\ndone` }],
      details: {
        status: "completed",
        completion: "all",
        includedDelegationIds: [delegationId],
        delegations: [{ delegationId, agent, status: "completed" }],
      },
    },
  };
}

const TITLE = "修复分页窗口合并";
const AGENT = "manifestor";
const GUIDANCE = "请复用现有分页窗口模型，并补充边界测试。";

const task = taskCall({
  callId: "call-a",
  agent: AGENT,
  description: TITLE,
  delegationId: "dlg-a",
});
const wait = deliveredWait({ callId: "call-w", delegationId: "dlg-a", agent: AGENT });
const steer = steerRow({ callId: "call-steer", delegationId: "dlg-a", text: GUIDANCE });

function headerHtml(html) {
  const match = html.match(/<button class="tool-row-header"[\s\S]*?<\/button>/);
  assert.ok(match, `no tool row header rendered:\n${html.slice(0, 800)}`);
  return match[0];
}

function stateBadge(html) {
  const match = html.match(
    /<span class="tool-row-state (is-[a-z]+)" role="status" aria-live="polite"><span class="tool-row-state-dot" aria-hidden="true"><\/span>([^<]*)<\/span>/,
  );
  assert.ok(match, `the row rendered no status badge:\n${html.slice(0, 1200)}`);
  return { tone: match[1], label: match[2] };
}

test("steer reuses the wait task header: plain agent left, title tile + Sent right", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { SubagentTitleProvider } = await ssr.load("/src/lib/subagent-title-provider.tsx");
  const render = (message) =>
    ssr.render(
      createElement(
        SubagentTitleProvider,
        { messages: [task, message] },
        createElement(ToolRow, { message }),
      ),
    );

  const waitHead = headerHtml(render(wait));
  const steerHead = headerHtml(render(steer));

  // The delivered wait keeps its four slots (D268): identity, roster summary,
  // delivered title tile, outcome.
  assert.match(waitHead, /<span class="tool-row-name"[^>]*>Task wait<\/span>/);
  assert.match(waitHead, /<span class="tool-row-summary[^"]*"[^>]*>manifestor<\/span>/);
  assert.match(waitHead, /<span class="tool-row-lifecycle">/);
  assert.match(waitHead, /<span class="tool-row-agent is-delivered"[^>]*>修复分页窗口合并<\/span>/);
  assert.equal(stateBadge(waitHead).label, "Results arrived");

  // The steer row keeps its own fixed identity.
  assert.match(steerHead, /<span class="tool-row-name"[^>]*>Task steer<\/span>/);
  // No generic agent pill: the agent reads as plain text, same slot/style as
  // the wait's roster summary.
  assert.doesNotMatch(steerHead, /tool-row-agent"(?! is-)/, "steer must not render a bare agent pill");
  assert.doesNotMatch(steerHead, /tool-row-agent is-count/, "steer is not a roster rollup");
  assert.match(steerHead, /<span class="tool-row-summary[^"]*"[^>]*>manifestor<\/span>/);
  // The target title sits in the same right tile group as the wait's
  // delivered chip, beside the same Sent state and the caret.
  assert.match(steerHead, /<span class="tool-row-lifecycle">/);
  assert.match(
    steerHead,
    /<span class="tool-row-agent is-delivered"[^>]*>修复分页窗口合并<\/span>/,
  );
  assert.equal(stateBadge(steerHead).label, "Sent");
  assert.equal(stateBadge(steerHead).tone, "is-done");
  assert.match(steerHead, /tool-row-caret/);
  // The routing id never reaches the head.
  assert.ok(!steerHead.includes("dlg-a"), "routing id leaked into the steer head");
});

test("steer without a resolvable target keeps the guidance fallback, never the id", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { SubagentTitleProvider } = await ssr.load("/src/lib/subagent-title-provider.tsx");
  const stray = steerRow({ callId: "call-stray", delegationId: "dlg-missing", text: "nudge" });
  const html = ssr.render(
    createElement(
      SubagentTitleProvider,
      { messages: [stray] },
      createElement(ToolRow, { message: stray }),
    ),
  );
  const head = headerHtml(html);
  assert.doesNotMatch(head, /tool-row-lifecycle/, "no title tile without a resolved target");
  assert.doesNotMatch(head, /tool-row-agent/, "no badge without a recorded target");
  assert.ok(!head.includes("dlg-missing"), "the routing id never reaches the head");
  assert.match(head, /<span class="tool-row-summary[^"]*"[^>]*>nudge<\/span>/);
});

test("steer running and failed states keep the shared header, error stays failure-only", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { SubagentTitleProvider } = await ssr.load("/src/lib/subagent-title-provider.tsx");
  const render = (message) =>
    headerHtml(
      ssr.render(
        createElement(
          SubagentTitleProvider,
          { messages: [task, message] },
          createElement(ToolRow, { message }),
        ),
      ),
    );

  // Running: the title tile is already named, the state never claims Sent.
  const running = steerRow({ callId: "call-run", delegationId: "dlg-a", text: GUIDANCE });
  running.toolStatus = "running";
  running.toolResult = undefined;
  const runningHead = render(running);
  assert.match(runningHead, /<span class="tool-row-agent is-delivered"[^>]*>修复分页窗口合并<\/span>/);
  assert.ok(!runningHead.includes(">Sent</span>"), "a running steer must not claim Sent");

  // Failed: title tile stays, badge reads Failed, body states only the cause.
  const failed = steerRow({
    callId: "call-fail",
    delegationId: "dlg-a",
    text: GUIDANCE,
    extra: {
      message: { toolStatus: "error" },
      resultDetails: { error: "delegation ended", errorCode: "E_GONE" },
    },
  });
  const failedHead = render(failed);
  assert.match(failedHead, /<span class="tool-row-agent is-delivered"[^>]*>修复分页窗口合并<\/span>/);
  assert.equal(stateBadge(failedHead).label, "Failed");
});

test("progress and count lifecycle rows are untouched by the steer header", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { SubagentTitleProvider } = await ssr.load("/src/lib/subagent-title-provider.tsx");
  const progressWait = {
    id: "wait-progress",
    role: "tool",
    content: "",
    createdAt,
    toolName: "TaskWait",
    toolCallId: "wait-progress",
    toolStatus: "success",
    toolArgs: { delegationIds: ["dlg-a"] },
    toolResult: {
      content: [{ type: "text", text: "still running" }],
      details: {
        status: "wakeup",
        wakeReason: "time",
        delegations: [{ delegationId: "dlg-a", agent: AGENT, status: "running" }],
      },
    },
  };
  const head = headerHtml(
    ssr.render(
      createElement(
        SubagentTitleProvider,
        { messages: [task, progressWait] },
        createElement(ToolRow, { message: progressWait }),
      ),
    ),
  );
  assert.match(head, /tool-row-agent is-count/);
  assert.match(head, /1 subagent/);
  assert.equal(stateBadge(head).label, "Waited for subagents");
});
