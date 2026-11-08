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
