import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  ReviewDiffReason,
  WorkspaceDiff,
} from "@pi-desktop/shared";

/**
 * Working-tree diff collection for the work panel review tab (D098) and the
 * remote Review tab.
 *
 * The host keeps the Git roles it always had — `HEAD` as the comparison base,
 * `git status` as the changed-file list, and `-M` for rename detection — and
 * bounds every part of the work:
 *
 * - the file list is read from `git status` before any patch command starts;
 *   only the first `MAX_DIFF_FILES` entries are compared, and their paths
 *   (old and new for a rename) become the literal pathspecs, so a file name
 *   containing `*`, `:(glob)`, or a leading `:` can never widen the scope;
 * - `git diff` output streams through a bounded reader: crossing
 *   `MAX_DIFF_OUTPUT_BYTES` kills the child instead of buffering the tree;
 * - one request shares a `DIFF_DEADLINE_MS` clock, kept under the RACP 15 s
 *   read/metadata deadline; a deadline kills the running child and waits for
 *   it to be reaped;
 * - a patch over `MAX_PATCH_BYTES` keeps its exact counts and drops its
 *   hunks; a binary patch reports no line counts at all;
 * - anything the host could not compare is reported through
 *   `countsKnown: false` plus a `reason` and never as the legacy zero, and a
 *   request that cannot run Git sets `WorkspaceDiff.reason` with
 *   `clean: false`.
 *
 * Parsers stay pure so the parsing rules remain unit-testable without a
 * checkout; only `collectWorkspaceDiff` talks to the Git CLI.
 */

/** Rows in one answer; the file list is read before any patch is computed. */
export const MAX_DIFF_FILES = 100;
/** Per-file patch text kept for display; larger patches keep exact counts. */
export const MAX_PATCH_BYTES = 200 * 1024;
/** Aggregate `git diff` stdout for one request, tracked and untracked alike. */
export const MAX_DIFF_OUTPUT_BYTES = 2 * 1024 * 1024;
/** `git status` stdout for one request; only `MAX_DIFF_FILES` entries are used. */
export const MAX_STATUS_OUTPUT_BYTES = 256 * 1024;
/**
 * Whole-request wall clock. RACP gives a read/metadata operation 15 s, and
 * the local Electron handler answers the same request, so the Git work stops
 * well before either deadline can cut it off.
 */
export const DIFF_DEADLINE_MS = 8_000;

/**
 * Git stderr is always drained so a chatty child cannot block on a full pipe.
 * A probe may retain this many bytes as an internal diagnostic, used only to
 * tell a known "no repository" answer apart from a refused or broken one. The
 * text never enters the answer, a log line, or any client payload: it can
 * echo repository paths and environment detail.
 */
export const STDERR_DIAGNOSTIC_MAX_BYTES = 4 * 1024;

/**
 * Git's own wording for "this directory is outside a work tree", which is the
 * only fatal probe answer that means a known, clean non-repository. The same
 * exit code also covers refusals such as dubious ownership or a corrupt
 * object store, and those mean the answer is unknown.
 */
const NOT_A_WORK_TREE_DIAGNOSTIC = "not a git repository";

/** Bounds overridable by tests; production callers use the defaults above. */
export type WorkspaceDiffLimits = {
  /** Whole-request wall clock; defaults to `DIFF_DEADLINE_MS`. */
  deadlineMs?: number;
  /** Aggregate diff stdout; defaults to `MAX_DIFF_OUTPUT_BYTES`. */
  outputMaxBytes?: number;
  /** `git status` stdout; defaults to `MAX_STATUS_OUTPUT_BYTES`. */
  statusMaxBytes?: number;
};

const NULL_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * Repository redirects that would point a command at another index, work
 * tree, object store or config; a workspace-configured value must not move
 * the comparison outside the authorized root.
 */
const REDIRECT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXTERNAL_DIFF",
] as const;

/**
 * Options that keep a workspace's own configuration from executing code:
 * no fsmonitor helper, no hooks, no external diff, no textconv. Pathspecs are
 * taken literally both through the top-level option and `GIT_LITERAL_PATHSPECS`.
 */
const GIT_ISOLATION_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${NULL_HOOKS_PATH}`,
  "--literal-pathspecs",
] as const;

const DIFF_ARGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "-M",
  "--unified=3",
] as const;

/** The diff of an unborn `HEAD`, matching Git's own empty tree object. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

type GitRunOptions = {
  /** When the whole request's clock runs out. */
  deadlineAt: number;
  /** Bytes of stdout this command may add before it is killed. */
  maxStdoutBytes: number;
  /** Keep the stdout text; streaming callers pass `false`. */
  collectStdout?: boolean;
  /** Receives decoded stdout while the byte budget lasts. */
  onStdout?: (text: string) => void;
  /**
   * Retain a bounded stderr diagnostic for the caller's own classification.
   * Only the command that decides "repository or not" asks for it; the text
   * stays internal and the stream is always drained regardless.
   */
  collectStderrDiagnostic?: boolean;
};

type GitRun = {
  started: boolean;
  /** Exit code, or `null` when the command never started or was killed. */
  code: number | null;
  timedOut: boolean;
  overflowed: boolean;
  /** Accepted stdout bytes (never the bytes read after the budget was spent). */
  bytes: number;
  stdout: string;
  /** Bounded, internal-only stderr text; never part of any answer. */
  stderrDiagnostic: string;
};

function runGit(
  cwd: string,
  args: string[],
  options: GitRunOptions,
): Promise<GitRun> {
  const timeoutMs = options.deadlineAt - Date.now();
  if (timeoutMs <= 0) {
    return Promise.resolve({
      started: false,
      code: null,
      timedOut: true,
      overflowed: false,
      bytes: 0,
      stdout: "",
      stderrDiagnostic: "",
    });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_TERMINAL_PROMPT: "0",
    // Diagnostic matching below relies on Git's own English wording. Setting
    // this on the child environment keeps it deterministic without touching
    // the host process's locale.
    LC_ALL: "C",
  };
  for (const name of REDIRECT_ENV) delete env[name];

  return new Promise((resolve) => {
    const child = spawn("git", [...GIT_ISOLATION_ARGS, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = options.collectStdout ?? true;
    const collectStderr = options.collectStderrDiagnostic ?? false;
    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let bytes = 0;
    let stderrBytes = 0;
    let stderrDiagnostic = "";
    let timedOut = false;
    let overflowed = false;
    let started = false;
    let settled = false;

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        started,
        code,
        timedOut,
        overflowed,
        bytes,
        stdout,
        stderrDiagnostic,
      });
    };
    const stop = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited; `close` still settles the promise.
      }
    };

    child.on("spawn", () => {
      started = true;
    });
    child.stdout?.on("data", (data: Buffer) => {
      if (timedOut || overflowed) return;
      if (bytes + data.length > options.maxStdoutBytes) {
        // Dropping the crossing chunk keeps clipped bytes out of the answer,
        // and killing the child bounds the work instead of draining a tree.
        overflowed = true;
        stop();
        return;
      }
      bytes += data.length;
      const text = decoder.write(data);
      if (collect) stdout += text;
      options.onStdout?.(text);
    });
    child.stdout?.on("end", () => {
      if (timedOut || overflowed) return;
      const tail = decoder.end();
      if (!tail) return;
      if (collect) stdout += tail;
      options.onStdout?.(tail);
    });
    child.stderr?.on("data", (data: Buffer) => {
      // Always drained. Retained only for the caller's own classification, and
      // only up to the diagnostic budget; the rest is dropped on the way.
      if (!collectStderr) return;
      const room = STDERR_DIAGNOSTIC_MAX_BYTES - stderrBytes;
      if (room <= 0 || timedOut || overflowed) return;
      const accepted = data.length <= room ? data : data.subarray(0, room);
      stderrBytes += accepted.length;
      stderrDiagnostic += stderrDecoder.write(accepted);
    });
    child.stderr?.on("end", () => {
      if (!collectStderr) return;
      stderrDiagnostic += stderrDecoder.end();
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
  });
}

/**
 * Classify a failed repository probe from its bounded, internal diagnostic.
 *
 * Git exits 128 both for "this directory is outside a work tree" and for
 * refusing or misreading a repository it was handed — dubious ownership, a
 * corrupt `HEAD`, an unreadable `.git`. Git even reuses its "not a git
 * repository" wording for a broken `.git`, so the message alone cannot tell
 * the two apart: a repository marker in the requested root means the answer
 * is unknown. Only a root with no marker at all gets the known, clean
 * "no repository" answer. The diagnostic text itself never leaves this
 * function, and nothing here is logged or returned.
 */
function probeFailureIsKnownNonRepository(run: GitRun, cwd: string): boolean {
  if (!run.started || run.timedOut || run.overflowed) return false;
  if (run.code !== 128 || run.stdout.trim() !== "") return false;
  const diagnostic = run.stderrDiagnostic.toLowerCase().replace(/\s+/g, " ");
  if (!diagnostic.includes(NOT_A_WORK_TREE_DIAGNOSTIC)) return false;
  return !existsSync(join(cwd, ".git"));
}

export type StatusEntry = {
  path: string;
  /** Previous path for renames/copies. */
  oldPath?: string;
  status: DiffFileStatus;
  untracked: boolean;
};

function statusFromXY(xy: string): DiffFileStatus {
  if (xy === "??") return "untracked";
  if (xy.includes("R") || xy.includes("C")) return "renamed";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  return "modified";
}

/**
 * Parse `git status --porcelain=v1 -z` output. Rename entries consume the
 * following NUL record (new path first, then original). A clipped status
 * stream ends the request before this parser runs, so no partial path is
 * reported as a changed file.
 */
export function parseStatusZ(raw: string): StatusEntry[] {
  const records = raw.split("\0").filter((record) => record.length > 0);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    if (xy === "!!") continue;
    const path = record.slice(3);
    const status = statusFromXY(xy);
    if (status === "renamed") {
      const oldPath = records[i + 1];
      i += 1;
      entries.push({
        path,
        ...(oldPath ? { oldPath } : {}),
        status,
        untracked: false,
      });
    } else {
      entries.push({ path, status, untracked: status === "untracked" });
    }
  }
  return entries;
}

/** Strip the a/ or b/ prefix git adds to diff header paths. */
function stripPathPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

function unquoteGitPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}

/**
 * Parse a single-file unified diff chunk into a DiffFile. `statusHint`
 * overrides the derived status (used to mark untracked files, which are
 * diffed via --no-index and would otherwise read as "added").
 */
export function parseFilePatch(
  chunk: string,
  statusHint?: DiffFileStatus,
): DiffFile | null {
  const lines = chunk.split("\n");
  if (!lines[0]?.startsWith("diff --git ")) return null;

  let path = "";
  let oldPath: string | undefined;
  let status: DiffFileStatus = statusHint ?? "modified";
  let binary = false;
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let current: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      const p = unquoteGitPath(line.slice(4).trim());
      if (p !== "/dev/null") oldPath = stripPathPrefix(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = unquoteGitPath(line.slice(4).trim());
      if (p !== "/dev/null") path = stripPathPrefix(p);
      continue;
    }
    if (line.startsWith("new file mode")) {
      if (!statusHint) status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      oldPath = unquoteGitPath(line.slice("rename from ".length).trim());
      status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      path = unquoteGitPath(line.slice("rename to ".length).trim());
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      additions += 1;
      current.lines.push({ type: "add", text: line.slice(1) } satisfies DiffLine);
    } else if (line.startsWith("-")) {
      deletions += 1;
      current.lines.push({ type: "del", text: line.slice(1) } satisfies DiffLine);
    } else if (line.startsWith(" ")) {
      // An empty context line is always written as a single space; the empty
      // string that a trailing newline produces is not context and is dropped.
      current.lines.push({ type: "context", text: line.slice(1) } satisfies DiffLine);
    }
    // "\ No newline at end of file" markers are dropped.
  }

  if (!path && oldPath) path = oldPath; // deletions have no +++ path
  if (!path) {
    // Binary patches carry no ---/+++ lines; recover the path from the
    // `diff --git a/<p> b/<p>` header (quoted paths included).
    const header = lines[0].slice("diff --git ".length).trim();
    const quoted = header.match(/"((?:[^"\\]|\\.)*)"\s*$/);
    const bPath = quoted
      ? unquoteGitPath(`"${quoted[1]}"`)
      : header.split(" b/").pop() ?? "";
    path = stripPathPrefix(bPath);
  }
  if (!path) return null;

  const base = {
    path,
    ...(status === "renamed" && oldPath ? { oldPath } : {}),
    status,
  };
  if (binary) {
    return {
      ...base,
      additions: 0,
      deletions: 0,
      binary: true,
      countsKnown: false,
      hunks: [],
    };
  }
  const tooLarge = Buffer.byteLength(chunk, "utf8") > MAX_PATCH_BYTES;
  if (tooLarge) {
    return {
      ...base,
      additions,
      deletions,
      reason: "diffTooLarge",
      tooLarge: true,
      hunks: [],
    };
  }
  return { ...base, additions, deletions, hunks };
}

/** A row whose line evidence the host could not produce. */
function unavailableDiffFile(
  entry: { path: string; oldPath?: string; status: DiffFileStatus },
  reason: ReviewDiffReason,
): DiffFile {
  return {
    path: entry.path,
    ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
    status: entry.status,
    additions: 0,
    deletions: 0,
    countsKnown: false,
    reason,
    hunks: [],
  };
}

/**
 * Split a streaming `git diff` byte stream into per-file patch chunks. A
 * chunk is final only once the next `diff --git` header proves it complete,
 * or the command finishes cleanly: a chunk still open when the output was cut
 * is never emitted, so clipped bytes cannot become counts or hunks.
 */
function createDiffChunkSink(onPatch: (patch: string) => void) {
  let carry = "";
  let lines: string[] | null = null;
  const flush = () => {
    if (lines) onPatch(lines.join("\n"));
    lines = null;
  };
  const pushLine = (line: string) => {
    if (line.startsWith("diff --git ")) {
      flush();
      lines = [line];
      return;
    }
    if (lines) lines.push(line);
  };
  return {
    write(text: string): void {
      let start = 0;
      for (;;) {
        const newline = text.indexOf("\n", start);
        if (newline < 0) {
          carry += text.slice(start);
          return;
        }
        pushLine(carry + text.slice(start, newline));
        carry = "";
        start = newline + 1;
      }
    },
    end(complete: boolean): void {
      if (carry) pushLine(carry);
      carry = "";
      if (complete) flush();
      lines = null;
    },
  };
}

function untrackedDiffArgs(path: string): string[] {
  return ["diff", ...DIFF_ARGS, "--no-index", "--", "/dev/null", path];
}

/**
 * Compare the working tree against `HEAD` inside one authorized workspace
 * root. Every command is scoped, bounded by bytes and by one request clock,
 * and killed and reaped when it overruns either.
 */
export async function collectWorkspaceDiff(
  cwd: string,
  limits: WorkspaceDiffLimits = {},
): Promise<WorkspaceDiff> {
  const deadlineAt = Date.now() + (limits.deadlineMs ?? DIFF_DEADLINE_MS);
  const statusMaxBytes = limits.statusMaxBytes ?? MAX_STATUS_OUTPUT_BYTES;
  let diffBytesLeft = limits.outputMaxBytes ?? MAX_DIFF_OUTPUT_BYTES;

  const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], {
    deadlineAt,
    maxStdoutBytes: statusMaxBytes,
    collectStderrDiagnostic: true,
  });
  if (probe.timedOut) {
    return { repo: false, clean: false, files: [], reason: "requestBudgetExceeded" };
  }
  if (!probe.started) {
    return { repo: false, clean: false, files: [], reason: "unreadable" };
  }
  if (probe.code === 128) {
    // Only a root with no repository marker and Git's own outside-work-tree
    // message is a known answer. A refusal of an existing repository (dubious
    // ownership, corrupt HEAD, unreadable .git) shares the exit code but
    // leaves the comparison unknown, so it must not read as a clean
    // non-repository.
    return probeFailureIsKnownNonRepository(probe, cwd)
      ? { repo: false, clean: true, files: [] }
      : { repo: false, clean: false, files: [], reason: "unreadable" };
  }
  if (probe.code !== 0) {
    return { repo: false, clean: false, files: [], reason: "unreadable" };
  }
  const insideWorkTree = probe.stdout.trim();
  // A bare repository is a repository without a work tree to compare.
  if (insideWorkTree === "false") {
    return { repo: false, clean: true, files: [] };
  }
  if (insideWorkTree !== "true") {
    return { repo: false, clean: false, files: [], reason: "unreadable" };
  }

  const status = await runGit(
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { deadlineAt, maxStdoutBytes: statusMaxBytes },
  );
  if (status.timedOut) {
    return { repo: true, clean: false, files: [], reason: "requestBudgetExceeded" };
  }
  if (status.overflowed) {
    // The stream was cut at the byte budget, so the list is unknown and partial;
    // reporting it as a read failure would misstate why the answer is incomplete.
    return { repo: true, clean: false, files: [], truncated: true, reason: "diffTooLarge" };
  }
  if (!status.started || status.code !== 0) {
    return { repo: true, clean: false, files: [], reason: "unreadable" };
  }
  const entries = parseStatusZ(status.stdout);
  const truncated = entries.length > MAX_DIFF_FILES;
  if (entries.length === 0) {
    return { repo: true, clean: true, files: [] };
  }

  // Only the rows that will be answered are compared, and a rename names
  // both of its paths; the literal pathspec flags make those exactly literal.
  const scoped = entries.slice(0, MAX_DIFF_FILES);
  const trackedEntries = scoped.filter((entry) => !entry.untracked);
  const untrackedEntries = scoped.filter((entry) => entry.untracked);
  const trackedSpecs: string[] = [];
  for (const entry of trackedEntries) {
    trackedSpecs.push(entry.path);
    if (entry.oldPath) trackedSpecs.push(entry.oldPath);
  }

  const head = trackedEntries.length > 0
    ? await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], {
        deadlineAt,
        maxStdoutBytes: statusMaxBytes,
      })
    : null;
  let trackedFailure: ReviewDiffReason | undefined;
  if (head?.timedOut) trackedFailure = "requestBudgetExceeded";
  else if (head?.overflowed) trackedFailure = "diffTooLarge";
  else if (head && !head.started) trackedFailure = "unreadable";
  else if (head && head.code !== null && head.code !== 0 && head.code !== 1) {
    // Exit 1 is the unborn repository Git reports with `--verify --quiet`: no
    // commit exists yet. Any other failure means the base is unknown, so the
    // comparison must not be invented against an empty tree.
    trackedFailure = "unreadable";
  }
  const base = head?.stdout.trim() || EMPTY_TREE;

  const files: DiffFile[] = [];
  const parsedByPath = new Map<string, DiffFile>();
  const acceptPatch = (patch: string) => {
    const file = parseFilePatch(patch);
    if (file) parsedByPath.set(file.path, file);
  };

  // The output budget is spent before a patch command is launched, not after.
  if (trackedEntries.length > 0 && !trackedFailure && diffBytesLeft <= 0) {
    trackedFailure = "diffTooLarge";
  }
  if (trackedEntries.length > 0 && !trackedFailure) {
    const sink = createDiffChunkSink(acceptPatch);
    const tracked = await runGit(
      cwd,
      ["diff", base, ...DIFF_ARGS, "--", ...trackedSpecs],
      {
        deadlineAt,
        maxStdoutBytes: diffBytesLeft,
        collectStdout: false,
        onStdout: sink.write,
      },
    );
    diffBytesLeft -= tracked.bytes;
    if (tracked.overflowed) diffBytesLeft = 0;
    const complete = !tracked.timedOut && !tracked.overflowed && tracked.code === 0;
    sink.end(complete);
    if (tracked.timedOut) trackedFailure = "requestBudgetExceeded";
    else if (tracked.overflowed) trackedFailure = "diffTooLarge";
    else if (!tracked.started || tracked.code !== 0) trackedFailure = "unreadable";
  }

  for (const entry of trackedEntries) {
    const parsed = parsedByPath.get(entry.path);
    if (parsed) {
      files.push(parsed);
      continue;
    }
    files.push(unavailableDiffFile(entry, trackedFailure ?? "unreadable"));
  }

  // Untracked files are compared one at a time against the null device;
  // exit code 0 (identical, i.e. empty) and 1 (differs) both mean the file
  // was read, and only an empty answer for those codes is a known zero.
  for (const entry of untrackedEntries) {
    if (diffBytesLeft <= 0) {
      files.push(unavailableDiffFile(entry, "diffTooLarge"));
      continue;
    }
    let parsed: DiffFile | null = null;
    const sink = createDiffChunkSink((patch) => {
      if (!parsed) parsed = parseFilePatch(patch, "untracked");
    });
    const untracked = await runGit(cwd, untrackedDiffArgs(entry.path), {
      deadlineAt,
      maxStdoutBytes: diffBytesLeft,
      collectStdout: false,
      onStdout: sink.write,
    });
    diffBytesLeft -= untracked.bytes;
    if (untracked.overflowed) diffBytesLeft = 0;
    const complete =
      !untracked.timedOut && !untracked.overflowed && (untracked.code === 0 || untracked.code === 1);
    sink.end(complete);
    const file: DiffFile | null = parsed;
    if (file) {
      files.push(file);
      continue;
    }
    if (untracked.timedOut) {
      files.push(unavailableDiffFile(entry, "requestBudgetExceeded"));
    } else if (untracked.overflowed) {
      files.push(unavailableDiffFile(entry, "diffTooLarge"));
    } else if (untracked.started && (untracked.code === 0 || untracked.code === 1)) {
      files.push({
        path: entry.path,
        status: "untracked",
        additions: 0,
        deletions: 0,
        hunks: [],
      });
    } else {
      files.push(unavailableDiffFile(entry, "unreadable"));
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    repo: true,
    clean: files.length === 0,
    files,
    ...(truncated ? { truncated: true } : {}),
  };
}
