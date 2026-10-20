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

/*
 * A card that names itself must not be wrapped in a second, vaguer heading.
 * The document card prints its own title and section heads, the checklist its
 * own progress row, the raw payload its own disclosure summary — so the frame
 * above them would only repeat a word ("Output"/"Details"/"Raw") the reader
 * already has.
 */

const unknownPayloadMessage = {
  id: "unknown-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-18T00:00:00.000Z",
  status: "complete",
  toolName: "plugin_deployer",
  toolCallId: "call-unknown-1",
  toolStatus: "success",
  toolArgs: {},
  toolResult: {
    content: [{ type: "text", text: "{\"id\":7}" }],
    details: { id: 7, label: "deploy" },
  },
};

const skillMessage = {
  id: "skill-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-18T00:00:00.000Z",
  status: "complete",
  toolName: "Skill",
  toolCallId: "call-skill-1",
  toolStatus: "success",
  toolArgs: { id: "review" },
  toolResult: {
    content: [
      {
        type: "text",
        text: "# Skill: Review (review)\nLocation: /skills/review/SKILL.md\n\n# Review\n\nRead the diff.",
      },
    ],
  },
};

test("an unknown payload names its raw form once, behind its own disclosure", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation(unknownPayloadMessage);
  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));

  // One heading for the readable fields, and the raw entry's own summary.
  assert.equal(occurrences(html, ">Details<"), 1);
  assert.equal(occurrences(html, "tool-raw-summary"), 1);
  assert.equal(occurrences(html, ">Raw<"), 1);
  // The copy control survives the removed duplicate head.
  assert.match(html, /tool-row-copy/);
});

test("a loaded document is not wrapped in an extra output heading", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation(skillMessage);
  assert.equal(blocks[0].kind, "document");
  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));

  // The document's own title heads it once; the body's own Markdown heading is
  // its content, not a second card heading.
  assert.equal(occurrences(html, "tool-document-title"), 1);
  assert.doesNotMatch(html, />Output</);
  // The document's own section head still labels the body it copies.
  assert.match(html, />File content</);
});

test("a checklist keeps its copy control but no generic heading", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation(todoMessage([]));
  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));

  // No visible "Details" heading above a card that states its own progress…
  assert.doesNotMatch(html, />Details</);
  // …but the copy control keeps an accessible name for what it copies.
  assert.match(html, /aria-label="Copy Checklist"/);
  assert.match(html, /tool-row-copy/);
});

test("an empty search says so without a heading above the sentence", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation({
    toolName: "Grep",
    toolArgs: { pattern: "nothing-matches" },
    toolResult: {
      content: [{ type: "text", text: "{\"matches\":[]}" }],
      details: { matches: [], count: 0, truncated: false },
    },
  });
  assert.deepEqual(blocks.map((block) => block.kind), ["empty"]);
  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));

  assert.match(html, /No matches/);
  assert.doesNotMatch(html, /tool-row-section-head/);
  // The payload metadata is not printed as a body.
  assert.doesNotMatch(html, /truncated/);
});

test("a stop roster heads each outcome with its own words", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const blocks = buildToolPresentation({
    toolName: "TaskStop",
    toolArgs: {},
    toolResult: {
      content: [{ type: "text", text: "Cancellation requested for 2 subagents; 1 have not confirmed termination and remain running." }],
      details: {
        stopped: [{ delegationId: "a", agent: "fixer", status: "stopped" }],
        stopPending: [{ delegationId: "b", agent: "runner", status: "running" }],
      },
    },
  });
  const html = ssr.render(createElement(ToolDetailBlocks, { blocks }));

  assert.match(html, />Stopped</);
  assert.match(html, /Stop requested — still running/);
  assert.doesNotMatch(html, /stopPending/);
});
