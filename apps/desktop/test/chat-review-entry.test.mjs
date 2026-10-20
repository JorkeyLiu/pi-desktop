import {
  readStoreSource,
  readStoreModule,
  readTranscriptSource,
} from "./helpers/source-contracts.mjs";
import { readAppSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  reviewChangeFromMessage,
  reviewChangesFromMessages,
  reviewFilesFromResult,
  summarizeReviewChanges,
  summarizeReviewFiles,
} from "../src/lib/workspace-review.ts";

const transcriptSource = await readTranscriptSource();
const cardSource = await readFile(
  new URL("../src/components/ReviewChangeCard.tsx", import.meta.url),
  "utf8",
);
const reviewSource = await readFile(
  new URL("../src/components/workpanel/ReviewTab.tsx", import.meta.url),
  "utf8",
);
const messageStylesSource = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);
const workPanelStylesSource = await readFile(
  new URL("../src/styles/work-panel.css", import.meta.url),
  "utf8",
);
const responsiveStylesSource = await readFile(
  new URL("../src/styles/responsive.css", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const storeSource = await readStoreSource();
const appStoreSource = await readStoreModule("app-store.ts");
const eventsSource = await readStoreModule("slices/events-slice.ts");
const transcriptSliceSource = await readStoreModule("slices/transcript-slice.ts");

const baseReview = {
  version: 1,
  snapshotId: "snapshot-1",
  messageId: "tool-1",
  path: "src/a.ts",
  operation: "edit",
  status: "modified",
  state: "active",
  additions: 4,
  deletions: 1,
  hunks: [
    {
      header: "@@ -1,2 +1,3 @@",
      lines: [
        { type: "context", text: "const before = true;" },
        { type: "del", text: "const removed = true;" },
        { type: "add", text: "const added = true;" },
      ],
    },
  ],
  reversible: true,
};

function message(overrides = {}) {
  return {
    id: "tool-1",
    role: "tool",
    content: "",
    createdAt: new Date().toISOString(),
    toolName: "Edit",
    toolStatus: "success",
    toolArgs: { path: "src/a.ts" },
    toolResult: { details: { root: "workspace", review: baseReview } },
    ...overrides,
  };
}

test("review evidence is read from the successful message, not Git", () => {
  const change = reviewChangeFromMessage(message());
  assert.equal(change?.path, "src/a.ts");
  assert.equal(change?.status, "modified");
  assert.equal(change?.additions, 4);
  assert.equal(change?.deletions, 1);
  assert.equal(change?.hunks[0].lines[1].type, "del");

  const entries = reviewChangesFromMessages([
    message(),
    message({
      id: "tool-2",
      toolName: "Write",
      toolResult: {
        details: {
          root: "workspace",
          review: {
            ...baseReview,
            snapshotId: "snapshot-2",
            messageId: "tool-2",
            path: "new.ts",
            operation: "write",
            status: "added",
            additions: 3,
            deletions: 0,
          },
        },
      },
    }),
    message({
      id: "tool-3",
      toolResult: {
        details: {
          root: "workspace",
          review: {
            ...baseReview,
            snapshotId: "snapshot-3",
            messageId: "tool-3",
            path: "old.ts",
            status: "deleted",
            additions: 0,
            deletions: 8,
          },
        },
      },
    }),
  ]);
  assert.deepEqual(
    entries.map(({ change }) => [change.status, change.path]),
    [
      ["modified", "src/a.ts"],
      ["added", "new.ts"],
      ["deleted", "old.ts"],
    ],
  );
  assert.deepEqual(summarizeReviewChanges(entries), {
    changeCount: 3,
    activeCount: 3,
    rolledBackCount: 0,
    additions: 7,
    deletions: 9,
  });
});

test("failed and scratch tool rows cannot manufacture review evidence", () => {
  assert.equal(reviewChangeFromMessage(message({ toolStatus: "error" })), null);
  assert.equal(
    reviewChangeFromMessage(
      message({
        toolResult: { details: { root: "scratch", review: baseReview } },
      }),
    ),
    null,
  );
  assert.equal(
    reviewChangeFromMessage(
      message({ toolResult: { details: { root: "workspace" } } }),
    ),
    null,
  );
});

test("chat renders one message-owned review inside the tool row that made it", () => {
  assert.equal(transcriptSource.includes("<WorkspaceChangesEntry />"), false);
  assert.equal(transcriptSource.includes("review-changes-entry"), false);
  // The change lives in the row that produced it: its +a/−d sit at the end of
  // the row and its diff in the row's own body, so the transcript never grows a
  // second collapsed row naming the same file (D192).
  assert.match(
    transcriptSource,
    /\{review \? <ReviewChangeCounts change=\{review\} \/> : null\}[\s\S]*?<ReviewChangeBody message=\{message\} \/>/,
  );
  assert.doesNotMatch(transcriptSource, /<ReviewChangeCard\b/);
  // The standalone card is the review panel's row for a change no tool row
  // shows, and it stays the only place that repeats the file name.
  assert.match(reviewSource, /<ReviewFileChangeCard/);
  assert.doesNotMatch(transcriptSource, /workspaceDiff|findWorkspaceChange/);
  assert.match(cardSource, /aria-expanded=\{open\}/);
  assert.match(cardSource, /chat\.reviewChangeShow/);
  assert.match(cardSource, /hunks\.map/);
  assert.match(cardSource, /workspaceReviewRollback|rollbackWorkspaceChange/);
  assert.match(
    storeSource,
    /rollbackWorkspaceChange:[\s\S]*api\.workspaceReviewRollback[\s\S]*withReviewChangeState/,
  );
  assert.doesNotMatch(
    eventsSource,
    /shouldOpenReviewArtifact|toolWorkPanelTab\("review"\)/,
  );
  assert.doesNotMatch(storeSource, /workspaceReviewSessions/);
});

test("rollback outcomes reach the toast instead of a second card row", () => {
  // The store already reports both outcomes; the card only owns the action.
  assert.match(
    transcriptSliceSource,
    /rollbackConflict[\s\S]{0,120}variant: "warning"/,
  );
  assert.match(
    transcriptSliceSource,
    /rollbackUnavailable[\s\S]{0,120}variant: "warning"/,
  );
  assert.doesNotMatch(cardSource, /rollbackStatus/);
  assert.doesNotMatch(cardSource, /review-change-rollback-note is-warning/);
  assert.doesNotMatch(cardSource, /panel\.review\.rollbackConflict/);
});

test("Review shows one row per file from its recorded baseline", () => {
  // The panel asks the host for each file's net change, and the transcript's
  // per-tool records are not the panel's list.
  assert.doesNotMatch(reviewSource, /reviewFileRefs/);
  assert.match(reviewSource, /api\.workspaceReviewFiles/);
  assert.match(reviewSource, /<ReviewFileChangeCard/);
  assert.match(reviewSource, /summarizeReviewFiles/);
  assert.match(reviewSource, /panel\.review\.filesChanged/);
  assert.match(reviewSource, /panel\.review\.noChanges/);
  assert.doesNotMatch(reviewSource, /reviewChangesFromMessages|summarizeReviewChanges/);
  assert.doesNotMatch(reviewSource, /workspaceDiff|refreshWorkspaceDiff|api\.workspaceDiff/);
  assert.doesNotMatch(appSource, /reviewRev|refreshWorkspaceDiff|workspaceDiff/);
});

test("a file rollback restores the first baseline and mirrors the marks", () => {
  assert.match(
    storeSource,
    /rollbackReviewFile:[\s\S]*api\.workspaceReviewRollbackFile[\s\S]*withReviewChangeState/,
  );
  assert.match(
    storeSource,
    /rollbackReviewFile: async \(sessionId, root, path\)[\s\S]{0,400}activeSessionId !== sessionId/,
  );
  assert.match(cardSource, /rollbackReviewFile/);
  assert.match(cardSource, /rollback\(sessionId, file\.root, file\.path\)/);
  assert.match(cardSource, /panel\.review\.fileShow/);
  assert.match(cardSource, /panel\.review\.limit\.workspaceUnavailable/);
  assert.match(cardSource, /panel\.review\.limit\.requestBudgetExceeded/);
});

test("unknown counts are never rendered as zero", () => {
  assert.match(cardSource, /panel\.review\.countsUnknown/);
  assert.match(cardSource, /diff-count-unknown/);
  assert.match(cardSource, /additions === undefined \|\| deletions === undefined/);
});

test("review surfaces keep visual state, focus, and motion feedback", () => {
  assert.match(cardSource, /data-state=\{change\.state\}/);
  assert.match(cardSource, /data-status=\{change\.status\}/);
  assert.match(messageStylesSource, /\.review-change-card-header:focus-visible/);
  assert.match(messageStylesSource, /\.review-change-card\[data-status="added"\]/);
  assert.match(messageStylesSource, /@keyframes review-change-reveal/);
  assert.match(workPanelStylesSource, /\.review-toolbar-counts/);
  assert.match(responsiveStylesSource, /\.review-change-card-body\s*\{[\s\S]*animation: none/);
});

test("a recorded change is a single flat row, not a card", () => {
  // Status travels as a git-style letter plus color, never color alone, and
  // the localized word stays in the accessible name.
  assert.match(cardSource, /review-change-card-mark/);
  assert.match(cardSource, /added: "A"[\s\S]*modified: "M"[\s\S]*deleted: "D"/);
  assert.doesNotMatch(
    cardSource,
    /review-change-card-(icon|status|state|main|meta)\b/,
  );
  assert.match(cardSource, /rolledBack"\s*\?\s*`\$\{baseLabel\}/);
  assert.match(
    messageStylesSource,
    /\.review-change-card-mark\s*\{[\s\S]*var\(--review-change-rail\)/,
  );
  // The row borrows the tool-row rhythm: no card border, rail, or shadow.
  const cardRule = messageStylesSource.match(/\n\.review-change-card \{[\s\S]*?\n\}/)?.[0];
  assert.ok(cardRule, "expected a .review-change-card rule");
  assert.doesNotMatch(cardRule, /^\s*(border|box-shadow|background)\s*:/m);
  assert.match(
    messageStylesSource,
    /\.review-change-card-header \{[\s\S]*min-height: 24px/,
  );
  // The Git-diff era file rows are gone; only the +/− counts helper survives.
  assert.doesNotMatch(workPanelStylesSource, /\.diff-file/);
  assert.match(workPanelStylesSource, /\.diff-counts \{/);
});

test("the review panel asks the host for the session's files", () => {
  // The panel no longer derives a file list from the transcript window, so a
  // long conversation cannot lose an early edit, and a record whose display
  // payload was trimmed cannot drop a snapshot from the list.
  assert.match(reviewSource, /api\.workspaceReviewFiles\(\{ sessionId: target \}\)/);
  assert.doesNotMatch(reviewSource, /reviewFileRefs|reviewChangesFromMessages/);
  assert.doesNotMatch(reviewSource, /messages: /);
  assert.match(reviewSource, /file\.root/);
});

test("switching sessions clears the rows before the next answer lands", () => {
  // The effect resets the view on a session change and ignores a late answer
  // for a session that is no longer active.
  assert.match(
    reviewSource,
    /useEffect\(\(\) => \{[\s\S]{0,400}setView\(\s*sessionId\s*\?\s*\{ \.\.\.EMPTY, sessionId, loading: true/,
  );
  assert.match(reviewSource, /view\.sessionId === sessionId \? view : EMPTY_VIEW/);
  assert.match(reviewSource, /sessionId=\{current\.sessionId\}/);
});

test("a reported file row never invents a count", () => {
  const { files: reported } = reviewFilesFromResult({
    truncated: true,
    unreadableRecords: 2,
    files: [
      {
        version: 1,
        path: "docs/big.md",
        status: "modified",
        truncated: true,
        reason: "diffTooComplex",
        hunks: [],
        reversible: true,
        rolledBack: false,
        snapshotIds: ["snapshot-1"],
      },
    ],
  });
  const [file] = reported;
  assert.equal(file.additions, undefined);
  assert.equal(file.deletions, undefined);
  assert.equal(file.reason, "diffTooComplex");
  // Unknown totals stay a lower bound instead of silently counting as zero.
  assert.deepEqual(summarizeReviewFiles({ files: [file] }), {
    fileCount: 1,
    additions: 0,
    deletions: 0,
    partial: true,
  });
  // A bounded answer or an unreadable record makes the totals a lower bound
  // even when every listed row counted its own change.
  assert.deepEqual(
    summarizeReviewFiles({
      files: [{ ...file, path: "b.ts", additions: 2, deletions: 1, truncated: false }],
      truncated: true,
    }),
    { fileCount: 1, additions: 2, deletions: 1, partial: true },
  );
  assert.deepEqual(
    summarizeReviewFiles({
      files: [{ ...file, path: "c.ts", additions: 2, deletions: 1, truncated: false }],
      unreadableRecords: 1,
    }),
    { fileCount: 1, additions: 2, deletions: 1, partial: true },
  );
  assert.deepEqual(
    summarizeReviewFiles({
      files: [
        { ...file, path: "a.ts", additions: 3, deletions: 1, truncated: false },
        file,
      ],
    }),
    { fileCount: 2, additions: 3, deletions: 1, partial: true },
  );
  // The root is part of a row's identity and is parsed with it.
  const [rooted] = reviewFilesFromResult({
    files: [{ ...file, root: "/projects/second", additions: 1, deletions: 0 }],
  }).files;
  assert.equal(rooted.root, "/projects/second");
  // A record without exact counts is still parsed, so its row and its reason
  // reach the panel.
  const change = reviewChangeFromMessage(
    message({
      toolResult: {
        details: {
          root: "workspace",
          review: {
            ...baseReview,
            additions: undefined,
            deletions: undefined,
            truncated: true,
            reason: "fileTooLarge",
          },
        },
      },
    }),
  );
  assert.equal(change.additions, undefined);
  assert.equal(change.reason, "fileTooLarge");
});
