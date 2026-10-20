import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The checklist card a `TodoWrite` row renders.
 *
 * The host counts a cancelled item as neither completed nor outstanding, so the
 * progress ratio has no denominator left when every item was dropped. Printing
 * "0/0" (and an equally meaningless progress bar) claimed the work had made no
 * progress and gave assistive technology an invalid range. Each state now
 * speaks for itself: an empty checklist says it was cleared, an all-cancelled
 * one says so, and a mixed one keeps its ratio and names the cancellations.
 */

const message = (details, args) => ({
  id: "todo-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-20T00:00:00.000Z",
  status: "complete",
  toolName: "TodoWrite",
  toolCallId: "call-todo-1",
  toolStatus: "success",
  toolArgs: args,
  toolResult: { content: [{ type: "text", text: details.text }], details },
});

test("a mixed checklist keeps its ratio and names the cancelled items", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation(
    message(
      {
        text: "Checklist updated: 1/2 completed, 1 cancelled",
        revision: 6,
        summary: { completed: 1, total: 2, inProgress: 0, cancelled: 1 },
        warnings: [],
        todos: [
          { content: "Verified item", status: "completed", priority: "medium" },
          { content: "Dropped item", status: "cancelled", priority: "medium" },
          { content: "Still open", status: "pending", priority: "medium" },
        ],
      },
      {
        todos: [
          { content: "Verified item", status: "completed", priority: "medium" },
          { content: "Dropped item", status: "cancelled", priority: "medium" },
          { content: "Still open", status: "pending", priority: "medium" },
        ],
      },
    ),
  );

  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));
  // The cumulative ratio excludes the cancelled item, and the count is named
  // beside it instead of silently disappearing.
  assert.match(html, /1\/2 completed/);
  assert.match(html, /1 cancelled/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuemax="2"/);
  assert.match(html, /aria-valuenow="1"/);
  // Three rows: the cancelled one is still listed, not swallowed by the ratio.
  assert.equal(html.match(/class="tool-todo-row/g)?.length, 3);
});

test("an all-cancelled checklist states it instead of showing 0/0", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation(
    message(
      {
        text: "Checklist updated: 0/0 completed, 2 cancelled",
        revision: 7,
        summary: { completed: 0, total: 0, inProgress: 0, cancelled: 2 },
        warnings: [],
        todos: [
          { content: "First dropped item", status: "cancelled", priority: "medium" },
          { content: "Second dropped item", status: "cancelled", priority: "medium" },
        ],
      },
      {
        todos: [
          { content: "First dropped item", status: "cancelled", priority: "medium" },
          { content: "Second dropped item", status: "cancelled", priority: "medium" },
        ],
      },
    ),
  );

  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));
  assert.match(html, /All 2 items cancelled/);
  // A ratio over an empty denominator is not progress: no bar is offered.
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.doesNotMatch(html, /0\/0/);
  assert.doesNotMatch(html, /aria-valuemax="0"/);
  // The rows themselves stay readable.
  assert.match(html, /First dropped item/);
  assert.match(html, /Second dropped item/);
});

test("an empty checklist says it holds nothing and offers no progress", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation(
    message(
      {
        text: "Checklist updated: 0/0 completed",
        revision: 8,
        summary: { completed: 0, total: 0, inProgress: 0, cancelled: 0 },
        warnings: [],
        todos: [],
      },
      { todos: [] },
    ),
  );

  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));
  assert.match(html, /Checklist cleared/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.doesNotMatch(html, /tool-todo-row/);
});

test("a cleared checklist row still has a body for its disclosure", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const html = ssr.render(
    createElement(ToolRow, {
      message: message(
        {
          text: "Checklist updated: 0/0 completed",
          revision: 9,
          summary: { completed: 0, total: 0, inProgress: 0, cancelled: 0 },
          warnings: [],
          todos: [],
        },
        { todos: [] },
      ),
    }),
  );

  const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controls, "the open checklist row names the body it controls");
  assert.match(html, new RegExp(`id="${controls}"`));
  assert.match(html, /Checklist cleared/);
});
