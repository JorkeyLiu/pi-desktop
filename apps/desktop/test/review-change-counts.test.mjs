import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * An uncounted review header renders nothing for the counts: no ellipsis, no
 * label, no badge. Known +N/−N (and known zero) counts and the expanded
 * reason body stay exactly as they were, and the accessible name states the
 * change without inventing numbers.
 */

const reviewRecord = (overrides = {}) => ({
  version: 1,
  snapshotId: "snapshot-1",
  messageId: "tool-1",
  path: "docs/spec/06-delivery/04-e2e-test-plan.md",
  operation: "edit",
  status: "modified",
  state: "active",
  hunks: [],
  reversible: false,
  ...overrides,
});

const toolMessage = (review) => ({
  id: "tool-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-18T00:00:00.000Z",
  toolName: "Edit",
  toolCallId: "call-tool-1",
  toolStatus: "success",
  toolArgs: { path: review.path },
  toolResult: { details: { root: "workspace", review } },
});

const headerHtml = (markup) => {
  const match = markup.match(
    /<button[^>]*class="review-change-card-header"[^>]*>[\s\S]*?<\/button>/,
  );
  assert(match, "the collapsed card renders its header");
  return match[0];
};

test("a completed too-large Edit header renders no counts and no ellipsis", async (t) => {
  const ssr = await slotSsr(t);
  const { ReviewChangeCard } = await ssr.load(
    "/src/components/ReviewChangeCard.tsx",
  );
  const markup = ssr.render(
    createElement(ReviewChangeCard, {
      message: toolMessage(
        reviewRecord({ truncated: true, reason: "fileTooLarge" }),
      ),
    }),
    { sessionId: null },
  );
  const header = headerHtml(markup);
  assert(!header.includes("review-change-card-counts"), "no counts element");
  assert(!header.includes("diff-count"), "no count styling hooks");
  assert.doesNotMatch(header, /…/);
  const label = header.match(/aria-label="([^"]*)"/)?.[1] ?? "";
  assert.doesNotMatch(label, /…/);
  assert.doesNotMatch(label, /additions/);
  assert.doesNotMatch(label, /deletions/);
});

test("another uncountable reason also leaves no ellipsis in the header", async (t) => {
  const ssr = await slotSsr(t);
  const { ReviewChangeCard } = await ssr.load(
    "/src/components/ReviewChangeCard.tsx",
  );
  const markup = ssr.render(
    createElement(ReviewChangeCard, {
      message: toolMessage(
        reviewRecord({ truncated: true, reason: "diffTooComplex" }),
      ),
    }),
    { sessionId: null },
  );
  const header = headerHtml(markup);
  assert(!header.includes("review-change-card-counts"), "no counts element");
  assert.doesNotMatch(header, /…/);
});

test("known and zero counts render exactly as before", async (t) => {
  const ssr = await slotSsr(t);
  const { ReviewChangeCounts } = await ssr.load(
    "/src/components/ReviewChangeCard.tsx",
  );
  const known = ssr.render(
    createElement(ReviewChangeCounts, {
      change: { additions: 3, deletions: 1 },
    }),
    { sessionId: null },
  );
  assert.match(known, /\+3/);
  assert.match(known, /−1/);
  assert.doesNotMatch(known, /unavailable/);
  const zero = ssr.render(
    createElement(ReviewChangeCounts, {
      change: { additions: 0, deletions: 0 },
    }),
    { sessionId: null },
  );
  assert.doesNotMatch(zero, /diff-count-add/);
  assert.doesNotMatch(zero, /diff-count-del/);
  assert.doesNotMatch(zero, /unavailable/);
  assert.doesNotMatch(zero, /…/);
});

test("the expanded body still names the file-too-large reason", async (t) => {
  const ssr = await slotSsr(t);
  const { ReviewDiffView } = await ssr.load(
    "/src/components/ReviewChangeCard.tsx",
  );
  const markup = ssr.render(
    createElement(ReviewDiffView, {
      hunks: [],
      truncated: true,
      reason: "fileTooLarge",
    }),
    { sessionId: null },
  );
  assert.match(markup, /This file is too large to compare here/);
});
