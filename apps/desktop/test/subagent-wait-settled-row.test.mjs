/**
 * A `TaskWait` row that has returned states that it waited.
 *
 * The badge is read from the backend-owned `details.status`/`wakeReason`, never
 * from the row's transport status. A `wakeup` checkpoint
 * (`time`/`tool-calls`/`context-tokens`) returned while its delegates may still
 * be running: the row is settled, so it must not keep saying it is waiting, and
 * nothing was delivered, so it must not claim results either. The live state of
 * the subagents is stated by the delegation card above and the waiting activity
 * below — this row only says what the call did.
 *
 * Rendered through the production `ToolRow` (SSR first frame) so the test reads
 * the badge the transcript actually prints, in the shipped catalogs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const startedAt = 1_000;
const delegations = [
  {
    delegationId: "delegation-1",
    agent: "manifestor",
    status: "running",
    startedAt,
  },
];

/** One `TaskWait` row; `extra` carries its transport status and result. */
const taskWait = (extra) => ({
  id: "wait-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-13T00:00:00.000Z",
  status: "complete",
  toolName: "TaskWait",
  toolCallId: "wait-1",
  toolArgs: { delegationIds: ["delegation-1"], timeoutMs: 300_000 },
  ...extra,
});

/** A settled wait whose backend outcome is a wakeup on `wakeReason`. */
const settledWakeup = (wakeReason) =>
  taskWait({
    toolStatus: "success",
    toolResult: {
      content: [{ type: "text", text: "Wait returned: subagents still running." }],
      details: {
        status: "wakeup",
        wakeReason,
        delegationIds: ["delegation-1"],
        delegations,
      },
    },
  });

/** An active `TaskList`: it blocked on the coordinator and woke on progress. */
const taskListSettled = (wakeReason) => ({
  ...settledWakeup(wakeReason),
  id: "list-1",
  toolName: "TaskList",
  toolCallId: "list-1",
});

/** A wait whose delegates settled and whose reports are in this result. */
const settledCompletion = taskWait({
  toolStatus: "success",
  toolResult: {
    content: [{ type: "text", text: "manifestor: done" }],
    details: {
      status: "completed",
      completion: "all",
      delegationIds: ["delegation-1"],
      delegations: [{ ...delegations[0], status: "completed", completedAt: 2_000 }],
    },
  },
});

/** A wait cut short: the outer bound elapsed, or new user input arrived. */
const settledShort = (status) =>
  taskWait({
    toolStatus: "success",
    toolResult: {
      content: [{ type: "text", text: "Subagents are still running." }],
      details: {
        status,
        delegationIds: ["delegation-1"],
        delegations,
      },
    },
  });

/** The wait call itself is still in flight: it has no result yet. */
const runningWait = taskWait({ toolStatus: "running", status: "streaming" });

/** The row's own status badge text, as the transcript prints it. */
function stateBadge(html) {
  const match = html.match(
    /<span class="tool-row-state (is-[a-z]+)" role="status" aria-live="polite"><span class="tool-row-state-dot" aria-hidden="true"><\/span>([^<]*)<\/span>/,
  );
  assert.ok(match, `the row rendered no status badge:\n${html}`);
  return { tone: match[1], label: match[2] };
}

test("a returned wakeup checkpoint reads as a settled wait, not as a live one", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const render = (message) => ssr.render(createElement(ToolRow, { message }));

  // Every wake reason the coordinator can return folds into the same settled
  // statement: the call waited and returned.
  for (const reason of ["time", "tool-calls", "context-tokens"]) {
    const html = render(settledWakeup(reason));
    const badge = stateBadge(html);
    assert.equal(badge.label, "Waited for subagents", `wakeup/${reason} is not settled`);
    assert.equal(badge.tone, "is-done");
    // The bug: a returned row kept the live "waiting" wording, including the
    // context-progress variant a delegate's token growth produces.
    assert.doesNotMatch(html, /Waiting for subagents/);
    assert.doesNotMatch(html, /context progress|tool-call progress|progress check/);
    // Nothing arrived, so no result is claimed either.
    assert.doesNotMatch(html, /Results arrived/);
    // The roster the runtime returned still names the delegate.
    assert.match(html, /1 subagent/);
  }

  // A wait whose call is still in flight keeps its live wording untouched.
  const running = stateBadge(render(runningWait));
  assert.equal(running.label, "Waiting for subagents");
  assert.equal(running.tone, "is-running");

  // The settled outcomes that already had their own wording keep it: a wait
  // whose bound elapsed or that new input cut says so while the delegates run.
  const timeout = render(settledShort("timeout"));
  assert.equal(stateBadge(timeout).label, "Wait timed out · still working");
  const interrupted = render(settledShort("interrupted"));
  assert.equal(stateBadge(interrupted).label, "Wait interrupted · still working");

  // Only a `completed` wait delivered reports, and it still says so.
  const completed = render(settledCompletion);
  assert.equal(stateBadge(completed).label, "Results arrived");
});

test("an active TaskList keeps its own progress wording", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");

  // Untouched by the settled TaskWait wording: a `TaskList` that blocked on the
  // coordinator still names the reason it woke, with the roster in its tooltip.
  const labels = {
    time: "Waiting for subagents · progress check",
    "tool-calls": "Waiting for subagents · tool-call progress",
    "context-tokens": "Waiting for subagents · context progress",
  };
  for (const [reason, label] of Object.entries(labels)) {
    const html = ssr.render(createElement(ToolRow, { message: taskListSettled(reason) }));
    assert.equal(stateBadge(html).label, label, `TaskList wakeup/${reason}`);
    assert.match(html, new RegExp(`title="${label} · manifestor"`));
  }
});

test("the Chinese catalog prints the same settled wait", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { SlotSessionProvider } = await ssr.load(
    "/src/plugins/renderer-slots/use-slots.tsx",
  );
  const i18n = createInstance();
  await i18n.init({
    lng: "zh-CN",
    resources: { "zh-CN": { translation: catalogs["zh-CN"] } },
  });
  const render = (message) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          SlotSessionProvider,
          { sessionId: "session-1" },
          createElement(ToolRow, { message }),
        ),
      ),
    );

  // The reported symptom, verbatim: a returned wait read "正在等待子智能体 ·
  // 上下文进度" while the subagent card and activity were the live UI.
  const settled = render(settledWakeup("context-tokens"));
  assert.equal(stateBadge(settled).label, "已等待子智能体");
  assert.doesNotMatch(settled, /正在等待子智能体/);
  assert.doesNotMatch(settled, /上下文进度/);
  assert.doesNotMatch(settled, /结果已送达/);

  // The live wait call is unchanged.
  const running = render(runningWait);
  assert.equal(stateBadge(running).label, "正在等待子智能体");
});

/** A `Task` call: the description is the task title the conversation carries. */
const taskCall = (delegationId, description, agent = "explorer") => ({
  id: `task-${delegationId}`,
  role: "tool",
  content: "",
  createdAt: "2026-10-13T00:00:00.000Z",
  toolStatus: "success",
  toolName: "Task",
  toolCallId: `task-${delegationId}`,
  toolArgs: {
    agent,
    task: "The full brief the model wrote, which is never a title.",
    ...(description ? { description } : {}),
  },
  toolResult: { details: { delegationId, agent, status: "completed" } },
});

/** A delivered wait: a `completed` result body carrying these blocks. */
const deliveredWait = (details) =>
  taskWait({
    toolStatus: "success",
    toolResult: {
      content: [{ type: "text", text: "## explorer (d-a) — completed\ndone" }],
      details: { status: "completed", completion: "all", ...details },
    },
  });

/** The row's summary cell, as the transcript prints it; `null` when absent. */
function summaryText(html) {
  const match = html.match(/<span class="tool-row-summary[^"]*"[^>]*>([^<]*)<\/span>/);
  return match ? match[1] : null;
}

 /** The row's third-slot chip, as the transcript prints it; `null` when absent. */
 function chipText(html) {
   const spans = html.match(/<span class="tool-row-agent[^"]*"[^>]*>([^<]*)<\/span>/g);
   if (!spans) return null;
   const last = spans[spans.length - 1];
   return last.replace(/<[^>]*>/g, "");
 }

/** The tooltip the row's fixed identity carries. */
function nameTitle(html) {
  const match = html.match(/<span class="tool-row-name" title="([^"]*)">/);
  return match ? match[1] : null;
}

 /**
  * A completed `TaskWait` keeps four slots: the fixed identity, the full roster
  * agent summary it was issued with, the delivered tasks' own titles in place
  * of the roster count chip, and the delivered outcome (D268).
  */
 test("a delivered wait keeps its roster and names the delivered tasks in the chip", async (t) => {
   const ssr = await slotSsr(t);
   const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
   const { SubagentTitleProvider } = await ssr.load(
     "/src/lib/subagent-title-provider.tsx",
   );
   const messages = [
     taskCall("d-a", "Find the slow query"),
     taskCall("d-b", "Review the migration", "code-reviewer"),
     taskCall("d-c", undefined, "test-runner"),
   ];
   const wait = deliveredWait({
     // `d-run` was a target of this wait but its report has not settled, so the
     // body carried a heartbeat block instead of a report: it is not delivered.
     // `d-untouched` was never a target at all.
     includedDelegationIds: ["d-a", "d-b", "d-c"],
     delegations: [
       { delegationId: "d-a", agent: "explorer", status: "completed" },
       { delegationId: "d-b", agent: "code-reviewer", status: "completed" },
       { delegationId: "d-c", agent: "test-runner", status: "completed" },
       { delegationId: "d-run", agent: "fixer", status: "running" },
     ],
   });
   const html = ssr.render(
     createElement(
       SubagentTitleProvider,
       { messages },
       createElement(ToolRow, { message: wait }),
     ),
   );

   // Slot 1: the fixed identity is untouched.
   assert.equal(
     html.match(/<span class="tool-row-name"[^>]*>([^<]*)<\/span>/)?.[1],
     "Task wait",
   );
   // Slot 2: the full roster agent summary the call was issued with,
   // including the delegate that is still running.
   assert.equal(
     summaryText(html),
     "explorer, code-reviewer, test-runner, fixer",
   );
   assert.doesNotMatch(summaryText(html) ?? "", /Find the slow query/);
   // Slot 3: the delivered tasks' own descriptions replace the roster count
   // chip. The one the conversation never titled falls back to the agent that
   // ran it; a still-running delegate is not a delivered task. The roster
   // count chip is gone because the count no longer sits in this slot.
   assert.equal(
     chipText(html),
     "Find the slow query, Review the migration, test-runner",
   );
   assert.match(html, /tool-row-agent is-delivered/);
   assert.doesNotMatch(html, /tool-row-agent is-count/);
   assert.doesNotMatch(html, /\d+ subagents?/);
   assert.doesNotMatch(chipText(html) ?? "", /fixer/);
   assert.doesNotMatch(html, /The full brief the model wrote/);
   assert.doesNotMatch(html, /d-a|d-b|d-c/);
   // Slot 4: the outcome stays.
   assert.equal(stateBadge(html).label, "Results arrived");
   // The tooltip agrees with the roster summary it sits beside.
   assert.equal(
     nameTitle(html),
     "Results arrived · explorer, code-reviewer, test-runner, fixer",
   );
 });

 test("a delivered wait names one delivered task out of a larger roster", async (t) => {
   const ssr = await slotSsr(t);
   const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
   const { SubagentTitleProvider } = await ssr.load(
     "/src/lib/subagent-title-provider.tsx",
   );
   const messages = [taskCall("d-a", "Find the slow query")];
   const wait = deliveredWait({
     includedDelegationIds: ["d-a"],
     delegations: [
       { delegationId: "d-a", agent: "explorer", status: "completed" },
       { delegationId: "d-b", agent: "manifestor", status: "running" },
       { delegationId: "d-c", agent: "inspector", status: "running" },
     ],
   });
   const html = ssr.render(
     createElement(
       SubagentTitleProvider,
       { messages },
       createElement(ToolRow, { message: wait }),
     ),
   );

   assert.equal(
     html.match(/<span class="tool-row-name"[^>]*>([^<]*)<\/span>/)?.[1],
     "Task wait",
   );
   assert.equal(summaryText(html), "explorer, manifestor, inspector");
   assert.equal(chipText(html), "Find the slow query");
   assert.match(html, /tool-row-agent is-delivered/);
   assert.doesNotMatch(html, /tool-row-agent is-count/);
   assert.equal(stateBadge(html).label, "Results arrived");
   assert.equal(nameTitle(html), "Results arrived · explorer, manifestor, inspector");
 });

 test("a delivered wait lists each same-agent task instead of counting it", async (t) => {
   const ssr = await slotSsr(t);
   const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
   const { SubagentTitleProvider } = await ssr.load(
     "/src/lib/subagent-title-provider.tsx",
   );
   const messages = [
     taskCall("d-a", "Alpha task", "inspector"),
     taskCall("d-b", "Beta task", "inspector"),
   ];
   const wait = deliveredWait({
     includedDelegationIds: ["d-a", "d-b"],
     delegations: [
       { delegationId: "d-a", agent: "inspector", status: "completed" },
       { delegationId: "d-b", agent: "inspector", status: "completed" },
     ],
   });
   const html = ssr.render(
     createElement(
       SubagentTitleProvider,
       { messages },
       createElement(ToolRow, { message: wait }),
     ),
   );

   assert.equal(
     html.match(/<span class="tool-row-name"[^>]*>([^<]*)<\/span>/)?.[1],
     "Task wait",
   );
   // The roster still counts the repeated agent; the chip never merges tasks.
   assert.equal(summaryText(html), "inspector ×2");
   assert.equal(chipText(html), "Alpha task, Beta task");
   assert.match(html, /tool-row-agent is-delivered/);
   assert.doesNotMatch(html, /tool-row-agent is-count/);
   assert.equal(stateBadge(html).label, "Results arrived");
   assert.equal(nameTitle(html), "Results arrived · inspector ×2");
 });

test("the same delivered row reads the same in Chinese", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { SubagentTitleProvider } = await ssr.load(
    "/src/lib/subagent-title-provider.tsx",
  );
  const { SlotSessionProvider } = await ssr.load(
    "/src/plugins/renderer-slots/use-slots.tsx",
  );
  const i18n = createInstance();
  await i18n.init({
    lng: "zh-CN",
    resources: { "zh-CN": { translation: catalogs["zh-CN"] } },
  });
  const messages = [
    taskCall("d-a", "找出慢查询"),
    taskCall("d-b", "检查这次迁移"),
  ];
  const wait = deliveredWait({
    includedDelegationIds: ["d-a", "d-b"],
    delegations: [
      { delegationId: "d-a", agent: "explorer", status: "completed" },
      { delegationId: "d-b", agent: "code-reviewer", status: "completed" },
    ],
  });
  const html = renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        SlotSessionProvider,
        { sessionId: "session-1" },
        createElement(
          SubagentTitleProvider,
          { messages },
          createElement(ToolRow, { message: wait }),
        ),
      ),
    ),
  );
   assert.equal(
     html.match(/<span class="tool-row-name"[^>]*>([^<]*)<\/span>/)?.[1],
     "等待任务",
   );
   assert.equal(summaryText(html), "explorer, code-reviewer");
   assert.equal(chipText(html), "找出慢查询, 检查这次迁移");
   assert.match(html, /tool-row-agent is-delivered/);
   assert.doesNotMatch(html, /tool-row-agent is-count/);
   assert.equal(stateBadge(html).label, "结果已送达");
   assert.doesNotMatch(html, /个 Subagent/);
   assert.equal(nameTitle(html), "结果已送达 · explorer, code-reviewer");
});

test("a delivered wait without the delivered ids falls back to its settled roster", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { SubagentTitleProvider } = await ssr.load(
    "/src/lib/subagent-title-provider.tsx",
  );
  const messages = [taskCall("d-a", "Find the slow query")];
   const render = (message) =>
     ssr.render(
       createElement(
         SubagentTitleProvider,
         { messages },
         createElement(ToolRow, { message }),
       ),
     );

   // A row persisted before the runtime recorded its delivered blocks: the
   // settled members of its roster are the best evidence it still has, and a
   // delegate that was still running was never a delivered result. The roster
   // summary still names the whole roster; only the chip falls back.
   const legacy = render(
     deliveredWait({
       delegations: [
         { delegationId: "d-a", agent: "explorer", status: "completed" },
         { delegationId: "d-run", agent: "fixer", status: "running" },
       ],
     }),
   );
   assert.equal(summaryText(legacy), "explorer, fixer");
   assert.equal(chipText(legacy), "Find the slow query");
   assert.doesNotMatch(chipText(legacy) ?? "", /fixer/);
   assert.match(legacy, /tool-row-agent is-delivered/);
   assert.doesNotMatch(legacy, /tool-row-agent is-count/);
   assert.equal(stateBadge(legacy).label, "Results arrived");

   // An explicit empty list says this body carried no block at all: the chip
   // stays absent while the roster summary still names who was waited on.
   const empty = render(
     deliveredWait({
       includedDelegationIds: [],
       delegations: [
         { delegationId: "d-a", agent: "explorer", status: "completed" },
       ],
     }),
   );
   assert.equal(summaryText(empty), "explorer");
   assert.equal(chipText(empty), null);
   assert.doesNotMatch(empty, /tool-row-agent is-delivered/);
   assert.doesNotMatch(empty, /tool-row-agent is-count/);
   assert.equal(stateBadge(empty).label, "Results arrived");

   // Every other lifecycle state keeps the roster summary and its count: only a
   // delivered wait swaps the count chip for the delivered task titles.
  const progressed = render(
    taskWait({
      toolStatus: "success",
      toolResult: {
        content: [{ type: "text", text: "still running" }],
        details: {
          status: "wakeup",
          wakeReason: "time",
          delegations,
        },
      },
    }),
  );
  assert.equal(stateBadge(progressed).label, "Waited for subagents");
  assert.match(progressed, /tool-row-agent is-count/);
  assert.match(progressed, /1 subagent/);
  assert.equal(summaryText(progressed), "manifestor");

  const timedOut = render(settledShort("timeout"));
  assert.match(timedOut, /tool-row-agent is-count/);
  assert.equal(summaryText(timedOut), "manifestor");
});
