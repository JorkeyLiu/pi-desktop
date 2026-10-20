import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * An expanded tool body has exactly one heading per section (D192). The
 * section frame already prints the translated label and its copy control, so a
 * card that repeats the same label as its own head renders it twice — the
 * duplicate "activated / activated" a ToolSearch row used to show. A routine
 * successful result also used to end with a generic "Note" section restating
 * what the row above already said; only a real warning belongs there.
 */

const toolSearchMessage = {
  id: "toolsearch-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-10T00:00:00.000Z",
  status: "complete",
  toolName: "ToolSearch",
  toolCallId: "call-toolsearch-1",
  toolStatus: "success",
  toolArgs: { query: "browser" },
  toolResult: {
    content: [
      {
        type: "text",
        text: "Activated on-demand tools: BrowserPreview. They are available on the next model turn.",
      },
    ],
    details: {
      query: "browser",
      matches: ["BrowserPreview", "Browser"],
      activated: ["BrowserPreview"],
      addedToolNames: ["BrowserPreview"],
    },
  },
};

const todoMessage = (warnings) => ({
  id: "todo-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-10T00:00:00.000Z",
  status: "complete",
  toolName: "TodoWrite",
  toolCallId: "call-todo-1",
  toolStatus: "success",
  toolArgs: {
    todos: [
      { content: "Read the row", status: "completed" },
      { content: "Unify the card", status: "in_progress", priority: "high" },
    ],
  },
  toolResult: {
    content: [{ type: "text", text: "Checklist updated: 1/2 completed; current: Unify the card" }],
    details: {
      text: "Checklist updated: 1/2 completed; current: Unify the card",
      revision: 3,
      summary: { completed: 1, total: 2, inProgress: 1, cancelled: 0 },
      warnings,
    },
  },
});

const occurrences = (html, needle) => html.split(needle).length - 1;

test("a values list is headed once by its section frame", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation(toolSearchMessage);
  assert.deepEqual(
    blocks.map((block) => block.label),
    ["activated", "matches"],
  );

  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));
  // One heading per group: the frame's own, with its copy control…
  assert.equal(occurrences(html, ">activated<"), 1);
  assert.equal(occurrences(html, ">matches<"), 1);
  assert.match(html, /tool-row-section-head/);
  // …and no second head inside the list card.
  assert.doesNotMatch(html, /tool-values-head/);
  // The names themselves still render, once per list they belong to.
  assert.equal(occurrences(html, ">BrowserPreview<"), 2);
});

test("a run row's unlabeled frame leaves the card its own head", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation(toolSearchMessage);

  const html = ssr.render(createElement(ToolDetailBlocks, { blocks, plain: true }));
  // The frame suppresses visible headings in a run body, so the card names
  // itself instead of losing the label.
  assert.match(html, /class="tool-values-head"[^>]*>activated</);
  assert.match(html, /class="sr-only">activated</);
});

test("a routine write adds no generic note section", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation(todoMessage([]));

  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));
  // The checklist is the body; the host's success sentence is not a section.
  assert.match(html, /tool-todo/);
  assert.doesNotMatch(html, />Note</);
  assert.doesNotMatch(html, /Checklist updated/);
});

test("a real warning still opens its own note section", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const warning = "Only one item is in progress at a time";
  const blocks = buildToolPresentation(todoMessage([warning]));

  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));
  // Trimming routine notes must not silence the ones that carry information.
  assert.match(html, />Note</);
  assert.match(html, new RegExp(warning));
});
