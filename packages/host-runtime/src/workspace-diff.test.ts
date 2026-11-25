import { existsSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_DIFF_FILES,
  MAX_PATCH_BYTES,
  collectWorkspaceDiff,
  parseFilePatch,
  parseStatusZ,
} from "./workspace-diff.js";

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
/**
 * These cases need a POSIX `git` found through PATH or literal `:`/`*` path
 * names, so they are skipped on Windows instead of failing there.
 */
const posixOnly = (name: string, run: () => void | Promise<void>): void => {
  if (process.platform === "win32") it.skip(name, run);
  else it(name, run);
};

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function makeRepo(prefix: string): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(tempRoot);
  const root = join(tempRoot, "repo");
  await mkdir(root);
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.name", "Workspace diff test"]);
  await git(root, ["config", "user.email", "workspace-diff@example.invalid"]);
  // Deterministic line endings and no signing on any contributor machine.
  await git(root, ["config", "core.autocrlf", "false"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "--quiet", "-m", message]);
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * A `git` executable that answers the commands the collector issues, always
 * logging its argv and the literal-pathspec environment. Modes that hang
 * publish their pid first and then write a `ready` marker, so a test proves
 * the process reached the hanging point instead of passing because the kill
 * raced its startup.
 */
const FAKE_GIT_SOURCE = `#!/usr/bin/env node
function main() {
const fs = require("node:fs");
const args = process.argv.slice(2);
const pidFile = process.env.FAKE_GIT_PID;
const mode = process.env.FAKE_GIT_MODE;
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({
  args,
  literal: process.env.GIT_LITERAL_PATHSPECS ?? null,
  locale: process.env.LC_ALL ?? null,
}) + "\\n");
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
const isProbe = args.includes("rev-parse") && args.includes("--is-inside-work-tree");
const isHead = args.includes("rev-parse") && args.includes("--verify");
const isStatus = args.includes("status");
const isDiff = args.includes("diff");
function hang() {
  if (pidFile) fs.writeFileSync(pidFile + ".ready", "ready\\n");
  setInterval(() => {}, 1000);
}
if (mode === "status-overflow" && isStatus) {
  const records = [];
  for (let index = 0; index < 40000; index += 1) {
    records.push(" M f" + String(index).padStart(5, "0") + ".txt\\0");
  }
  process.stdout.write(records.join(""));
}
if (mode === "status-overflow" && isHead) {
  process.stdout.write("1111111111111111111111111111111111111111\\n");
  process.exit(0);
}
if (mode === "status-overflow" && isDiff) {
  const separator = args.indexOf("--");
  if (separator < 0) process.exit(0);
  for (const path of args.slice(separator + 1)) {
    process.stdout.write(
      "diff --git a/" + path + " b/" + path + "\\n--- a/" + path +
      "\\n+++ b/" + path + "\\n@@ -1 +1 @@\\n-a\\n+b\\n",
    );
  }
  process.exit(0);
}
if (mode === "probe-timeout" && isProbe) {
  hang();
  return;
}
if ((mode === "diff-timeout" || mode === "diff-failure") && isProbe) {
  process.stdout.write("true\\n");
  process.exit(0);
}
if ((mode === "diff-timeout" || mode === "diff-failure") && isStatus) {
  process.stdout.write(" M tracked.txt\\0");
  process.exit(0);
}
if ((mode === "diff-timeout" || mode === "diff-failure") && isHead) {
  process.stdout.write("1111111111111111111111111111111111111111\\n");
  process.exit(0);
}
if (mode === "diff-timeout" && isDiff) {
  hang();
  return;
}
if (mode === "probe-dubious" && isProbe) {
  process.stderr.write("fatal: detected dubious ownership in repository at '/private/foreign-repo'\\n");
  process.stderr.write("To add an exception for this directory, call:\\n\\n\\tgit config --global --add safe.directory /private/foreign-repo\\n");
  process.exit(128);
}
if (mode === "probe-opaque-failure" && isProbe) {
  process.stderr.write("fatal: secret repository detail must stay internal\\n");
  process.exit(128);
}
if (mode === "diff-failure" && isDiff) {
  process.stderr.write("fatal: secret repository detail must stay internal\\n");
  process.exit(1);
}
if (mode === "status-failure" && isStatus) {
  process.stderr.write("fatal: secret repository detail must stay internal\\n");
  process.exit(1);
}
if (isProbe) {
  process.stdout.write("true\\n");
  process.exit(0);
}
process.exit(0);
}
main();
`;

type FakeGitState = { pidFile: string; logFile: string };

async function withFakeGit<T>(
  mode: string,
  run: (state: FakeGitState) => Promise<T>,
): Promise<T> {
  const tempRoot = await makeTempDir("pi-workspace-diff-fake-");
  const bin = join(tempRoot, "bin");
  await mkdir(bin);
  const fakeGit = join(bin, "git");
  await writeFile(fakeGit, FAKE_GIT_SOURCE, "utf8");
  await chmod(fakeGit, 0o755);
  const state: FakeGitState = {
    pidFile: join(tempRoot, "git-pid"),
    logFile: join(tempRoot, "git-log"),
  };
  const saved = {
    PATH: process.env.PATH,
    FAKE_GIT_PID: process.env.FAKE_GIT_PID,
    FAKE_GIT_MODE: process.env.FAKE_GIT_MODE,
    FAKE_GIT_LOG: process.env.FAKE_GIT_LOG,
  };
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  process.env.FAKE_GIT_PID = state.pidFile;
  process.env.FAKE_GIT_MODE = mode;
  process.env.FAKE_GIT_LOG = state.logFile;
  try {
    return await run(state);
  } finally {
    const restore = (key: keyof typeof saved) => {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    for (const key of Object.keys(saved) as (keyof typeof saved)[]) restore(key);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for the killed child to be reaped; the collector resolves on exit. */
async function expectReaped(pidFile: string, readyFile: string): Promise<void> {
  const ready = await readFile(readyFile, "utf8").catch(() => "");
  expect(ready, "fake git never reached its hanging point").toBe("ready\n");
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(Number.isInteger(pid)).toBe(true);
  for (let attempt = 0; attempt < 100 && isAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(isAlive(pid), "timed-out git child was left running").toBe(false);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workspace diff parsing", () => {
  it("keeps hunk lines exact and drops the newline artifact after a patch", () => {
    const chunk = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+three",
      "",
    ].join("\n");

    const file = parseFilePatch(chunk);
    expect(file).not.toBeNull();
    expect(file?.hunks).toHaveLength(1);
    expect(file?.hunks[0].lines).toEqual([
      { type: "context", text: "one" },
      { type: "del", text: "two" },
      { type: "add", text: "three" },
    ]);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.countsKnown).toBeUndefined();
  });

  it("reports binary content as unknown counts instead of zero", () => {
    const file = parseFilePatch(
      "diff --git a/image.bin b/image.bin\nBinary files a/image.bin and b/image.bin differ\n",
    );
    expect(file).toMatchObject({
      path: "image.bin",
      binary: true,
      countsKnown: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    });
    expect(file?.hunks).toEqual([]);
  });

  it("keeps exact counts and omits hunks when a patch exceeds the display cap", () => {
    // 2000 changed lines of 120 characters stay well over MAX_PATCH_BYTES.
    const lineCount = 1000;
    const longLine = "x".repeat(120);
    const hunkLines = [
      `@@ -1,${lineCount} +1,${lineCount} @@`,
      ...Array.from({ length: lineCount }, () => `-${longLine}`),
      ...Array.from({ length: lineCount }, () => `+${longLine}`),
    ];
    const chunk = [
      "diff --git a/large.txt b/large.txt",
      "--- a/large.txt",
      "+++ b/large.txt",
      ...hunkLines,
    ].join("\n");
    expect(Buffer.byteLength(chunk, "utf8")).toBeGreaterThan(MAX_PATCH_BYTES);

    const file = parseFilePatch(chunk);
    expect(file).toMatchObject({
      path: "large.txt",
      additions: lineCount,
      deletions: lineCount,
      tooLarge: true,
      reason: "diffTooLarge",
      hunks: [],
    });
    expect(file?.countsKnown).toBeUndefined();
  });

  it("maps status records, renames, and untracked files", () => {
    const entries = parseStatusZ(
      "R  new.txt\0old.txt\0 M changed.txt\0?? added.txt\0!! ignored.txt\0",
    );
    expect(entries).toEqual([
      { path: "new.txt", oldPath: "old.txt", status: "renamed", untracked: false },
      { path: "changed.txt", status: "modified", untracked: false },
      { path: "added.txt", status: "untracked", untracked: true },
    ]);
  });
});

describe("collectWorkspaceDiff", () => {
  it("does not execute a repository-configured fsmonitor command", async () => {
    const tempRoot = await makeTempDir("pi-workspace-diff-fsmonitor-");
    const root = join(tempRoot, "repo");
    await mkdir(root);

    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "user.name", "Workspace diff test"]);
    await git(root, ["config", "user.email", "workspace-diff@example.invalid"]);
    await writeFile(join(root, "tracked.txt"), "content\n", "utf8");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "--quiet", "-m", "initial"]);

    const marker = join(tempRoot, "fsmonitor-ran");
    const hook = join(tempRoot, "fsmonitor-hook.cjs");
    await writeFile(
      hook,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
      "utf8",
    );
    const command = shellQuote(process.execPath) + " " + shellQuote(hook);
    await git(root, ["config", "core.fsmonitor", command]);

    // Prove this Git build would execute the configured command without the
    // host runner's overrides, then clear the marker before testing the host.
    await execFile("git", ["status", "--porcelain=v1", "-z"], {
      cwd: root,
      encoding: "utf8",
    }).catch(() => undefined);
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const diff = await collectWorkspaceDiff(root);

    expect(diff).toMatchObject({ repo: true, clean: true, files: [] });
    expect(diff.reason).toBeUndefined();
    expect(existsSync(marker)).toBe(false);

    await git(root, ["config", "--unset", "core.fsmonitor"]);
    const injectedConfig = [
      ["GIT_CONFIG_COUNT", process.env.GIT_CONFIG_COUNT],
      ["GIT_CONFIG_KEY_0", process.env.GIT_CONFIG_KEY_0],
      ["GIT_CONFIG_VALUE_0", process.env.GIT_CONFIG_VALUE_0],
    ] as const;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
    process.env.GIT_CONFIG_VALUE_0 = command;
    try {
      const envDiff = await collectWorkspaceDiff(root);
      expect(envDiff).toMatchObject({ repo: true, clean: true, files: [] });
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const [key, value] of injectedConfig) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("does not execute repository-configured textconv commands", async () => {
    const root = await makeRepo("pi-workspace-diff-textconv-");
    await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(
      join(root, ".gitattributes"),
      "tracked.txt diff=probe\nuntracked.txt diff=probe\n",
      "utf8",
    );
    await git(root, ["add", ".gitattributes"]);
    await git(root, ["commit", "--quiet", "-m", "diff attributes"]);

    const marker = join(root, "..", "textconv-ran");
    const command = join(root, "..", "textconv.cjs");
    await writeFile(
      command,
      `const fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(marker)}, "ran\\n");\nprocess.stdout.write(fs.readFileSync(process.argv.at(-1)));\n`,
      "utf8",
    );
    const textconv = shellQuote(process.execPath) + " " + shellQuote(command);
    await git(root, ["config", "diff.probe.textconv", textconv]);
    await writeFile(join(root, "tracked.txt"), "changed\n", "utf8");
    await writeFile(join(root, "untracked.txt"), "new file\n", "utf8");

    // Prove the repository's textconv command is active before the host runs.
    await execFile("git", ["diff", "--textconv", "--", "tracked.txt"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const diff = await collectWorkspaceDiff(root);

    expect(diff.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["tracked.txt", "untracked.txt"]),
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("compares tracked, renamed, binary, untracked, empty, and unusual paths in one answer", async () => {
    const root = await makeRepo("pi-workspace-diff-mixed-");
    await writeFile(join(root, "tracked.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(root, "old-name.txt"), "a\nb\nc\n", "utf8");
    await writeFile(
      join(root, "binary.bin"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0x03]),
    );
    await writeFile(join(root, ":colon.txt"), "before\n", "utf8");
    await writeFile(join(root, "-dash.txt"), "before\n", "utf8");
    await commitAll(root, "initial");

    await writeFile(join(root, "tracked.txt"), "one\nTWO\nthree\n", "utf8");
    await git(root, ["mv", "old-name.txt", "new-name.txt"]);
    await writeFile(join(root, "new-name.txt"), "a\nb\nc\nd\n", "utf8");
    await writeFile(
      join(root, "binary.bin"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x08, 0x00, 0x07]),
    );
    await writeFile(join(root, ":colon.txt"), "after\n", "utf8");
    await writeFile(join(root, "-dash.txt"), "after\n", "utf8");
    await writeFile(join(root, "untracked.txt"), "new\nline\n", "utf8");
    await writeFile(join(root, "empty-new.txt"), "", "utf8");

    const diff = await collectWorkspaceDiff(root);

    expect(diff.repo).toBe(true);
    expect(diff.clean).toBe(false);
    expect(diff.reason).toBeUndefined();
    expect(diff.truncated).toBeUndefined();
    expect(diff.files).toHaveLength(7);
    expect(new Set(diff.files.map((file) => file.path))).toEqual(new Set([
      "binary.bin",
      ":colon.txt",
      "-dash.txt",
      "empty-new.txt",
      "new-name.txt",
      "tracked.txt",
      "untracked.txt",
    ]));

    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    expect(byPath.get("tracked.txt")).toMatchObject({
      additions: 1,
      deletions: 1,
      status: "modified",
    });
    expect(byPath.get("tracked.txt")?.countsKnown).toBeUndefined();

    expect(byPath.get("new-name.txt")).toMatchObject({
      oldPath: "old-name.txt",
      status: "renamed",
      additions: 1,
      deletions: 0,
    });

    expect(byPath.get("binary.bin")).toMatchObject({
      binary: true,
      countsKnown: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    });

    expect(byPath.get(":colon.txt")).toMatchObject({
      status: "modified",
      additions: 1,
      deletions: 1,
      hunks: expect.any(Array),
    });
    expect(byPath.get(":colon.txt")?.reason).toBeUndefined();

    expect(byPath.get("untracked.txt")).toMatchObject({
      status: "untracked",
      additions: 2,
      deletions: 0,
    });
    expect(byPath.get("untracked.txt")?.countsKnown).toBeUndefined();

    expect(byPath.get("empty-new.txt")).toMatchObject({
      status: "untracked",
      additions: 0,
      deletions: 0,
      hunks: [],
    });
    expect(byPath.get("empty-new.txt")?.countsKnown).toBeUndefined();

    for (const file of diff.files) {
      if (!file.binary) {
        expect(file.additions + file.deletions).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("caps the final answer at the first changed files and marks the list truncated", async () => {
    const root = await makeRepo("pi-workspace-diff-many-");
    for (let index = 0; index < MAX_DIFF_FILES + 20; index += 1) {
      const name = `file-${String(index).padStart(4, "0")}.txt`;
      await writeFile(join(root, name), "before\n", "utf8");
    }
    await commitAll(root, "initial");
    for (let index = 0; index < MAX_DIFF_FILES + 20; index += 1) {
      const name = `file-${String(index).padStart(4, "0")}.txt`;
      await writeFile(join(root, name), "after\n", "utf8");
    }

    const diff = await collectWorkspaceDiff(root);

    expect(diff.files).toHaveLength(MAX_DIFF_FILES);
    expect(diff.truncated).toBe(true);
    expect(diff.clean).toBe(false);
    for (const file of diff.files) {
      expect(file.countsKnown).toBeUndefined();
      expect(file.additions).toBe(1);
      expect(file.deletions).toBe(1);
    }
  });

  it("keeps exact counts but drops hunks past the per-file display cap", async () => {
    const root = await makeRepo("pi-workspace-diff-large-");
    const lineCount = 12000;
    const beforeLines = Array.from(
      { length: lineCount },
      (_value, index) => `a${String(index).padStart(25, "0")}`,
    );
    const afterLines = Array.from(
      { length: lineCount },
      (_value, index) => `b${String(index).padStart(25, "0")}`,
    );
    await writeFile(join(root, "large.txt"), `${beforeLines.join("\n")}\n`, "utf8");
    await commitAll(root, "initial");
    await writeFile(join(root, "large.txt"), `${afterLines.join("\n")}\n`, "utf8");

    const diff = await collectWorkspaceDiff(root);

    expect(diff.files).toHaveLength(1);
    const file = diff.files[0];
    expect(file).toMatchObject({
      path: "large.txt",
      status: "modified",
      additions: lineCount,
      deletions: lineCount,
      tooLarge: true,
      reason: "diffTooLarge",
      hunks: [],
    });
    expect(file.countsKnown).toBeUndefined();
  });

  it("reports an empty and an unborn repository truthfully", async () => {
    const emptyRoot = await makeRepo("pi-workspace-diff-empty-");
    const empty = await collectWorkspaceDiff(emptyRoot);
    expect(empty).toEqual({ repo: true, clean: true, files: [] });

    const root = await makeRepo("pi-workspace-diff-unborn-");
    await writeFile(join(root, "staged.txt"), "line\n", "utf8");
    await git(root, ["add", "staged.txt"]);
    await writeFile(join(root, "untracked.txt"), "one\ntwo\n", "utf8");

    const diff = await collectWorkspaceDiff(root);
    expect(diff.repo).toBe(true);
    expect(diff.clean).toBe(false);
    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    expect(byPath.get("staged.txt")).toMatchObject({
      status: "added",
      additions: 1,
      deletions: 0,
    });
    expect(byPath.get("untracked.txt")).toMatchObject({
      status: "untracked",
      additions: 2,
      deletions: 0,
    });
    expect(byPath.get("staged.txt")?.reason).toBeUndefined();
  });

  it("reports a directory outside any work tree as not a repository", async () => {
    const dir = await makeTempDir("pi-workspace-diff-nonrepo-");
    const diff = await collectWorkspaceDiff(dir);
    expect(diff).toEqual({ repo: false, clean: true, files: [] });
    expect(diff.reason).toBeUndefined();
  });

  posixOnly("treats Git's dubious-ownership refusal as an unreadable repository", async () => {
    // Git exits 128 both outside a work tree and when it refuses the repository
    // itself. Only the outside-work-tree message may read as a clean
    // "no repository" answer; a refusal means the answer is unknown.
    const root = await makeTempDir("pi-workspace-diff-probe-dubious-");
    await withFakeGit("probe-dubious", async (state) => {
      const diff = await collectWorkspaceDiff(root);
      expect(diff).toEqual({ repo: false, clean: false, files: [], reason: "unreadable" });
      expect(JSON.stringify(diff)).not.toContain("dubious ownership");
      expect(JSON.stringify(diff)).not.toContain("safe.directory");
      const log = await readFile(state.logFile, "utf8");
      expect(log).toContain('"locale":"C"');
    });
  });

  posixOnly("does not treat an opaque Git failure as a non-repository", async () => {
    const root = await makeTempDir("pi-workspace-diff-probe-opaque-");
    await withFakeGit("probe-opaque-failure", async (state) => {
      const diff = await collectWorkspaceDiff(root);
      expect(diff).toEqual({ repo: false, clean: false, files: [], reason: "unreadable" });
      expect(JSON.stringify(diff)).not.toContain("secret");
      const log = await readFile(state.logFile, "utf8");
      expect(log).toContain('"locale":"C"');
    });
  });
  posixOnly("does not read a broken repository as a clean non-repository", async () => {
    // Real Git reports a corrupt HEAD with the same "not a git repository"
    // wording and exit code as a directory outside any work tree, so the
    // repository marker in the root is what keeps the answer unknown.
    const root = await makeRepo("pi-workspace-diff-corrupt-");
    await writeFile(join(root, ".git", "HEAD"), "garbage\n", "utf8");
    const diff = await collectWorkspaceDiff(root);
    expect(diff).toEqual({ repo: false, clean: false, files: [], reason: "unreadable" });
  });


  it("stops at the aggregate output cap without publishing clipped counts", async () => {
    const root = await makeRepo("pi-workspace-diff-output-");
    const beforeLines = Array.from({ length: 600 }, (_value, index) => `old-${index}`);
    const afterLines = Array.from({ length: 600 }, (_value, index) => `new-${index}`);
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      await writeFile(join(root, name), `${beforeLines.join("\n")}\n`, "utf8");
    }
    await commitAll(root, "initial");
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      await writeFile(join(root, name), `${afterLines.join("\n")}\n`, "utf8");
    }

    // A cap below one file's patch: no chunk can complete before the kill.
    const diff = await collectWorkspaceDiff(root, { outputMaxBytes: 2048 });

    expect(diff.repo).toBe(true);
    expect(diff.clean).toBe(false);
    expect(diff.files).toHaveLength(3);
    for (const file of diff.files) {
      expect(file).toMatchObject({
        countsKnown: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        reason: "diffTooLarge",
      });
    }
  });

  posixOnly("distinguishes a failed Git command from a clean workspace and keeps stderr internal", async () => {
    const root = await makeTempDir("pi-workspace-diff-status-failure-");
    await withFakeGit("status-failure", async () => {
      const diff = await collectWorkspaceDiff(root);
      expect(diff).toMatchObject({ repo: true, clean: false, files: [] });
      expect(diff.reason).toBe("unreadable");
      expect(JSON.stringify(diff)).not.toContain("secret");
    });
  });

  posixOnly("reports a failed patch command as unavailable rows and passes literal pathspecs", async () => {
    const root = await makeTempDir("pi-workspace-diff-diff-failure-");
    await withFakeGit("diff-failure", async (state) => {
      const diff = await collectWorkspaceDiff(root);
      expect(diff).toMatchObject({ repo: true, clean: false });
      expect(diff.reason).toBeUndefined();
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]).toMatchObject({
        path: "tracked.txt",
        countsKnown: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        reason: "unreadable",
      });
      expect(JSON.stringify(diff)).not.toContain("secret");

      const calls = (await readFile(state.logFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; literal: string | null });
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.args).toContain("--literal-pathspecs");
        expect(call.literal).toBe("1");
      }
    });
  });

  posixOnly("kills and reaps a Git command that misses the request deadline", async () => {
    const root = await makeTempDir("pi-workspace-diff-probe-timeout-");
    await withFakeGit("probe-timeout", async (state) => {
      // The fake child must reach its hang point before the deadline kills it;
      // process startup on a loaded machine is slower than the budget itself.
      const diff = await collectWorkspaceDiff(root, { deadlineMs: 2_000 });
      expect(diff).toMatchObject({ repo: false, clean: false, files: [] });
      expect(diff.reason).toBe("requestBudgetExceeded");
      await expectReaped(state.pidFile, `${state.pidFile}.ready`);
    });
  });

  posixOnly("returns unavailable rows instead of counts when the patch command times out", async () => {
    const root = await makeTempDir("pi-workspace-diff-diff-timeout-");
    await withFakeGit("diff-timeout", async (state) => {
      const diff = await collectWorkspaceDiff(root, { deadlineMs: 2_000 });
      expect(diff).toMatchObject({ repo: true, clean: false });
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]).toMatchObject({
        path: "tracked.txt",
        countsKnown: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        reason: "requestBudgetExceeded",
      });
      await expectReaped(state.pidFile, `${state.pidFile}.ready`);
    });
  });

  posixOnly("bounds the status stream before any patch command starts", async () => {
    const root = await makeTempDir("pi-workspace-diff-status-overflow-");
    await withFakeGit("status-overflow", async () => {
      const diff = await collectWorkspaceDiff(root, { statusMaxBytes: 512 });
      expect(diff).toMatchObject({ repo: true, clean: false, files: [] });
      expect(diff.truncated).toBe(true);
      expect(diff.reason).toBe("diffTooLarge");
    });
  });

  posixOnly("compares a file whose name Git would otherwise read as pathspec magic", async () => {
    const root = await makeRepo("pi-workspace-diff-literal-");
    await writeFile(join(root, ":colon.txt"), "before\n", "utf8");
    await writeFile(join(root, "star*.txt"), "before\n", "utf8");
    await writeFile(join(root, "star-other.txt"), "before\n", "utf8");
    await commitAll(root, "initial");
    await writeFile(join(root, ":colon.txt"), "after\n", "utf8");
    await writeFile(join(root, "star*.txt"), "after\n", "utf8");
    await writeFile(join(root, "star-other.txt"), "after\n", "utf8");

    const diff = await collectWorkspaceDiff(root);
    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    expect(byPath.get(":colon.txt")).toMatchObject({
      additions: 1,
      deletions: 1,
      status: "modified",
    });
    expect(byPath.get(":colon.txt")?.reason).toBeUndefined();
    expect(byPath.get("star*.txt")).toMatchObject({
      additions: 1,
      deletions: 1,
      status: "modified",
    });
  });
});

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
