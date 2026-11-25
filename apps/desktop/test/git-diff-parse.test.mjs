import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  MAX_PATCH_BYTES,
  collectWorkspaceDiff,
  parseFilePatch,
  parseStatusZ,
} from "../../../packages/host-runtime/src/workspace-diff.ts";

const execFile = promisify(execFileCallback);

async function git(cwd, args) {
  await execFile(
    "git",
    [
      "-c",
      "user.name=Workspace diff test",
      "-c",
      "user.email=workspace-diff@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
}

test("parses porcelain -z status including renames and untracked", () => {
  const raw = [
    " M apps/a.ts",
    "?? notes.md",
    "R  new-name.ts\0old-name.ts",
    "!! ignored.log",
    "A  added.ts",
  ].join("\0") + "\0";
  const entries = parseStatusZ(raw);
  assert.deepEqual(entries, [
    { path: "apps/a.ts", status: "modified", untracked: false },
    { path: "notes.md", status: "untracked", untracked: true },
    {
      path: "new-name.ts",
      oldPath: "old-name.ts",
      status: "renamed",
      untracked: false,
    },
    { path: "added.ts", status: "added", untracked: false },
  ]);
});

test("splits a multi-file git diff into per-file rows from a real work tree", async () => {
  // The chunk splitter is internal to the bounded collector, so the multiple
  // `diff --git` boundaries are exercised through the collector itself: one
  // patch command covers both files and the answer still carries one row per
  // file with its own path, status, counts and hunks.
  const root = await mkdtemp(join(tmpdir(), "pi-git-diff-parse-"));
  try {
    await git(root, ["init", "--quiet"]);
    for (const name of ["a.ts", "b.ts"]) {
      await writeFile(join(root, name), "old\ncontext\n", "utf8");
    }
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(root, "a.ts"), "new\ncontext\n", "utf8");
    await writeFile(join(root, "b.ts"), "y\ncontext\n", "utf8");

    const diff = await collectWorkspaceDiff(root);
    assert.equal(diff.repo, true);
    assert.equal(diff.clean, false);
    assert.deepEqual(
      diff.files.map((file) => [file.path, file.status]),
      [
        ["a.ts", "modified"],
        ["b.ts", "modified"],
      ],
    );
    for (const file of diff.files) {
      assert.equal(file.additions, 1);
      assert.equal(file.deletions, 1);
      assert.equal(file.tooLarge, undefined);
      assert.deepEqual(
        file.hunks.map((hunk) => hunk.header),
        ["@@ -1,2 +1,2 @@"],
      );
      assert.deepEqual(
        file.hunks[0].lines.map((line) => line.type),
        ["del", "add", "context"],
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a chunk parse rejects text that is not a file patch", () => {
  // Whitespace-only and header-less text carries no file chunk; a trailing
  // blank line is not an empty context line either.
  assert.equal(parseFilePatch("  \n"), null);
  const chunk = [
    "diff --git a/tail.txt b/tail.txt",
    "--- a/tail.txt",
    "+++ b/tail.txt",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  const file = parseFilePatch(chunk);
  assert.equal(file?.path, "tail.txt");
  assert.deepEqual(
    file?.hunks[0].lines.map((line) => line.type),
    ["del", "add"],
  );
});

test("parses a modified file patch with counts and hunks", () => {
  const chunk = [
    "diff --git a/src/x.ts b/src/x.ts",
    "index 111..222 100644",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1,3 +1,4 @@ function x()",
    " context",
    "-removed",
    "+added one",
    "+added two",
    "\\ No newline at end of file",
  ].join("\n");
  const file = parseFilePatch(chunk);
  assert.equal(file.path, "src/x.ts");
  assert.equal(file.status, "modified");
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks.length, 1);
  assert.equal(file.hunks[0].header, "@@ -1,3 +1,4 @@ function x()");
  assert.deepEqual(
    file.hunks[0].lines.map((l) => l.type),
    ["context", "del", "add", "add"],
  );
  // The no-newline marker never leaks into rendered lines.
  assert.ok(file.hunks[0].lines.every((l) => !l.text.includes("No newline")));
});

test("detects added, deleted, renamed, and binary patches", () => {
  const added = parseFilePatch(
    [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n"),
  );
  assert.equal(added.status, "added");
  assert.equal(added.additions, 1);

  const deleted = parseFilePatch(
    [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n"),
  );
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.path, "gone.ts");

  const renamed = parseFilePatch(
    [
      "diff --git a/old.ts b/renamed.ts",
      "similarity index 97%",
      "rename from old.ts",
      "rename to renamed.ts",
    ].join("\n"),
  );
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.path, "renamed.ts");
  assert.equal(renamed.oldPath, "old.ts");

  const binary = parseFilePatch(
    [
      "diff --git a/logo.png b/logo.png",
      "index 111..222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n"),
  );
  assert.equal(binary.binary, true);
  assert.equal(binary.countsKnown, false);
  assert.deepEqual(binary.hunks, []);
});

test("untracked hint overrides derived status and large patches drop hunks", () => {
  const untracked = parseFilePatch(
    [
      "diff --git a/draft.md b/draft.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/draft.md",
      "@@ -0,0 +1 @@",
      "+wip",
    ].join("\n"),
    "untracked",
  );
  assert.equal(untracked.status, "untracked");

  const bigBody = `+${"x".repeat(MAX_PATCH_BYTES)}`;
  const big = parseFilePatch(
    [
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -0,0 +1 @@",
      bigBody,
    ].join("\n"),
  );
  assert.equal(big.tooLarge, true);
  assert.equal(big.reason, "diffTooLarge");
  assert.deepEqual(big.hunks, []);
  assert.equal(big.additions, 1);
});

test("unquotes escaped git paths", () => {
  const file = parseFilePatch(
    [
      'diff --git "a/\\346\\226\\207\\346\\241\\243.md" "b/\\346\\226\\207\\346\\241\\243.md"',
      "index 111..222 100644",
      '--- "a/\\346\\226\\207\\346\\241\\243.md"',
      '+++ "b/\\346\\226\\207\\346\\241\\243.md"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n"),
  );
  assert.ok(file.path.endsWith(".md"));
  assert.ok(!file.path.startsWith('"'));
});
