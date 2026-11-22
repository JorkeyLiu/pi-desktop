import assert from "node:assert/strict";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";
import {
  editDiffFromMessage,
  reviewChangeFromMessage,
} from "../src/lib/workspace-review.ts";

/*
 * Unified per-call Edit diffs: a successful Edit on workspace, scratch, or a
 * permission-authorized external path carries the same actual before/after
 * counts and expanded hunks, independent of Git tracking. The producer still
 * records each call's own root, but the collapsed head prints the file and
 * its counts with no directory badge. Workspace-only rollback and
 * review.files totals are untouched: no durable review snapshot is
 * synthesized for scratch/external,
 * and only the durable workspace record drives rollback.
 */

const preview = (overrides = {}) => ({
  version: 1,
  path: "source.txt",
  root: "scratch",
  operation: "edit",
  status: "modified",
  additions: 1,
  deletions: 1,
  hunks: [
    {
      header: "@@ -1,2 +1,2 @@",
      lines: [
        { type: "context", text: "one" },
        { type: "del", text: "two" },
        { type: "add", text: "TWO" },
      ],
    },
  ],
  ...overrides,
});

const message = (details, overrides = {}) => ({
  id: "tool-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-18T00:00:00.000Z",
  status: "complete",
  toolName: "Edit",
  toolCallId: "call-tool-1",
  toolStatus: "success",
  toolArgs: { path: "source.txt", tag: "abcd", ops: "PUT 2.=2:\n+TWO\n" },
  toolResult: { content: [{ type: "text", text: "{}" }], details },
  ...overrides,
});

test("a scratch edit preview parses with its counts and hunks", () => {
  const parsed = editDiffFromMessage(message({ root: "scratch", editDiff: preview() }));
  assert(parsed);
  assert.equal(parsed.root, "scratch");
  assert.equal(parsed.status, "modified");
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].lines[2].text, "TWO");
  assert.equal(reviewChangeFromMessage(message({ root: "scratch", editDiff: preview() })), null);
});

test("an external edit preview parses with the external root", () => {
  const parsed = editDiffFromMessage(
    message({
      root: "external",
      path: "/outside/out.txt",
      editDiff: preview({ root: "external", path: "/outside/out.txt" }),
    }),
  );
  assert(parsed);
  assert.equal(parsed.root, "external");
  assert.equal(parsed.additions, 1);
});

test("a legacy workspace review still parses with no preview to fall back from", () => {
  const details = {
    root: "workspace",
    review: {
      version: 1,
      snapshotId: "snapshot-1",
      messageId: "tool-1",
      path: "src/a.ts",
      operation: "edit",
      status: "modified",
      state: "active",
      additions: 4,
      deletions: 1,
      hunks: [],
      reversible: true,
    },
  };
  assert.equal(editDiffFromMessage(message(details)), null);
  assert(reviewChangeFromMessage(message(details)));
});

test("a malformed preview reads as absent so no fake diff renders", () => {
  const malformed = [
    { root: "scratch", editDiff: { ...preview(), version: 2 } },
    { root: "scratch", editDiff: { ...preview(), root: "nowhere" } },
    { root: "scratch", editDiff: { ...preview(), status: "renamed" } },
    { root: "scratch", editDiff: { ...preview(), path: "  " } },
    { root: "scratch", editDiff: { ...preview(), operation: "write" } },
    { root: "scratch", editDiff: { hunks: [] } },
    { root: "scratch" },
  ];
  for (const details of malformed) {
    assert.equal(editDiffFromMessage(message(details)), null, JSON.stringify(details));
  }
  assert.equal(
    editDiffFromMessage(
      message({ root: "scratch", editDiff: preview() }, { toolStatus: "error" }),
    ),
    null,
  );
  assert.equal(
    editDiffFromMessage(
      message({ root: "scratch", editDiff: preview() }, { toolName: "Write" }),
    ),
    null,
  );
});

test("an uncounted preview omits counts instead of reporting zero", () => {
  const { additions, deletions, ...rest } = preview({ root: "external" });
  void additions;
  void deletions;
  const parsed = editDiffFromMessage(
    message({ root: "external", editDiff: { ...rest, truncated: true, reason: "fileTooLarge" } }),
  );
  assert(parsed);
  assert.equal(parsed.additions, undefined);
  assert.equal(parsed.deletions, undefined);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.reason, "fileTooLarge");
});
test("scratch and external roots stay in the payload while the head shows no directory badge", async (t) => {
  const ssr = await slotSsr(t);
  const { headerToolChips, toolResultChips } = await ssr.load("/src/lib/tool-presentation.ts");
  const scratchChips = toolResultChips(message({ root: "scratch", editDiff: preview() }));
  assert(scratchChips.some((chip) => chip.role === "scratch"), "the producer keeps the scratch root");
  assert(!scratchChips.some((chip) => chip.role === "external"));
  const externalChips = toolResultChips(
    message({ root: "external", editDiff: preview({ root: "external" }) }),
  );
  assert(externalChips.some((chip) => chip.role === "external"), "the producer keeps the external root");
  assert(!externalChips.some((chip) => chip.role === "scratch"));
  assert.deepEqual(
    headerToolChips(message({ root: "scratch", editDiff: preview() })),
    [],
    "the collapsed head carries no directory badge",
  );
  assert.deepEqual(
    headerToolChips(message({ root: "external", editDiff: preview({ root: "external" }) })),
    [],
    "the collapsed head carries no directory badge",
  );
});

test("a valid preview suppresses the raw ops echo and hides preview metadata", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const blocks = buildToolPresentation(message({ root: "scratch", editDiff: preview() }));
  const text = JSON.stringify(blocks);
  assert(!text.includes("PUT 2.=2"), "raw PUT body must not echo beside the diff");
  assert(!text.includes("editDiff"), "preview metadata must not leak into fields");
});

test("a valid preview keeps warnings while suppressing only the ops echo", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const blocks = buildToolPresentation(
    message({ root: "scratch", warnings: ["stale tag applied at head"], editDiff: preview() }),
  );
  const text = JSON.stringify(blocks);
  assert(text.includes("stale tag applied at head"), "warnings stay visible");
  assert(!text.includes("PUT 2.=2"), "raw PUT body stays suppressed");
});

test("a malformed preview falls back to the stated ops instead of a fake diff", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const blocks = buildToolPresentation(
    message({ root: "scratch", editDiff: { ...preview(), status: "renamed" } }),
  );
  assert(JSON.stringify(blocks).includes("PUT 2.=2"), "unevidenced edits keep their ops");
});
