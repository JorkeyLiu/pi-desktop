/** Shared public types grouped by the owning application domain. */
// --- Work panel (review / browser / files / plugin views) ---

export type DiffLineType = "add" | "del" | "context";

export type DiffLine = {
  type: DiffLineType;
  text: string;
};

export type DiffHunk = {
  /** Raw `@@ -a,b +c,d @@ …` header line. */
  header: string;
  lines: DiffLine[];
};

export type ReviewChangeOperation = "write" | "edit" | "delete";
export type ReviewChangeStatus = "added" | "modified" | "deleted";
export type ReviewChangeState = "active" | "rolledBack";

/**
 * Why a recorded comparison carries no trustworthy line evidence. The reasons
 * are kept apart so the UI can say whether the file, the change, the retained
 * bytes, or the path is the problem.
 */
export type ReviewDiffReason =
  | "fileTooLarge"
  | "diffTooComplex"
  | "diffTooLarge"
  | "baselineUnavailable"
  | "unreadable"
  /** The record's workspace root is not one this session still has. */
  | "workspaceUnavailable"
  /** The request's total comparison work was already spent. */
  | "requestBudgetExceeded";

/**
 * Durable, message-owned change evidence returned by a workspace mutation.
 * Unlike WorkspaceDiff, this record remains valid after a git commit.
 *
 * `additions` / `deletions` are absent when the change could not be counted;
 * an unknown count is never reported as zero.
 */
export type ReviewChange = {
  version: 1;
  snapshotId: string;
  messageId: string;
  path: string;
  operation: ReviewChangeOperation;
  status: ReviewChangeStatus;
  state: ReviewChangeState;
  additions?: number;
  deletions?: number;
  hunks: DiffHunk[];
  binary?: boolean;
  truncated?: boolean;
  reason?: ReviewDiffReason;
  reversible: boolean;
};
/**
 * Which file-mutation tool the per-call preview below was produced for.
 * Only `Edit` and `Write` carry this preview; the tool name selects the only
 * operation and the only statuses the preview may report.
 */
export type FileMutationTool = "Edit" | "Write";

type FileMutationPreviewBase = {
  version: 1;
  path: string;
  root: "workspace" | "scratch" | "external";
  additions?: number;
  deletions?: number;
  hunks: DiffHunk[];
  binary?: boolean;
  truncated?: boolean;
  reason?: ReviewDiffReason;
};

/**
 * The single tool-to-preview policy: each supported tool maps to its only
 * legal operation and statuses. Renderers enforce tool/operation/status
 * together from this table instead of maintaining separate tool, operation,
 * and status sets whose Cartesian product would admit combinations the host
 * never produces (for example `write`/`deleted` or an `Edit` row carrying a
 * `write` preview).
 */
export const FILE_MUTATION_PREVIEW_POLICY = {
  Edit: {
    operation: "edit",
    statuses: ["modified", "deleted", "moved"],
  },
  Write: {
    operation: "write",
    statuses: ["added", "modified"],
  },
} as const;

/**
 * The per-call diff preview one successful `Edit` or `Write` carries in its
 * own result, on workspace, scratch, and explicitly approved external paths
 * alike. Unlike `ReviewChange` this is not durable: it holds no snapshot
 * identity, no rollback state, and no reversible flag, so a scratch or
 * external call gets the same line evidence as a workspace call without
 * review snapshots or aggregate/revert capabilities.
 *
 * The union is derived from `FILE_MUTATION_PREVIEW_POLICY`, so the legal
 * operation/status combinations live in exactly one place: an `edit` preview
 * reports `modified`, `deleted`, or `moved`, while a `write` preview reports
 * `added` (a creation reads as all lines added) or `modified`.
 * A move carries no line change of its own: the path moved, so the content
 * diff is empty rather than a deletion plus an addition.
 *
 * `additions` / `deletions` are absent when the change could not be counted;
 * an unknown count is never reported as zero.
 *
 * The wire field that carries this preview stays `editDiff`.
 */
export type FileMutationPreview = {
  [Tool in FileMutationTool]: FileMutationPreviewBase & {
    operation: (typeof FILE_MUTATION_PREVIEW_POLICY)[Tool]["operation"];
    status: (typeof FILE_MUTATION_PREVIEW_POLICY)[Tool]["statuses"][number];
  };
}[FileMutationTool];

export type FileMutationOperation = FileMutationPreview["operation"];

export type FileMutationStatus = FileMutationPreview["status"];

/**
 * Legacy aliases for the file-mutation preview contract above. Prefer the
 * `FileMutation*` names in new code; the persisted wire field stays
 * `editDiff`.
 */
export type EditDiffOperation = FileMutationOperation;

export type EditDiffStatus = FileMutationStatus;

export type EditDiffPreview = FileMutationPreview;

/**
 * One file's net change: the bytes the conversation first recorded for it,
 * compared with the working tree as it is now. Per-tool records stay on their
 * messages; the host owns this set because it scans the session's own records.
 */
export type ReviewFileChange = {
  version: 1;
  /**
   * The workspace root this file belongs to. Two project folders can hold the
   * same relative path, so the row is identified by root and path together.
   */
  root?: string;
  path: string;
  status: ReviewChangeStatus;
  additions?: number;
  deletions?: number;
  hunks: DiffHunk[];
  binary?: boolean;
  truncated?: boolean;
  reason?: ReviewDiffReason;
  reversible: boolean;
  rolledBack: boolean;
  snapshotIds: string[];
};

/**
 * One `review.files` answer. `truncated` says the host bounded the answer, and
 * `unreadableRecords` counts records it could not read at all, so the panel can
 * state a lower bound instead of presenting a partial view as complete.
 */
export type ReviewFileChangeResult = {
  files: ReviewFileChange[];
  truncated?: boolean;
  unreadableRecords?: number;
};

export type ReviewFileRollbackMark = {
  snapshotId: string;
  messageId: string;
};

export type ReviewFileRollbackResult = {
  status: ReviewRollbackStatus;
  /** The root the file was resolved in, when the host could resolve one. */
  root?: string;
  path: string;
  rolledBack: ReviewFileRollbackMark[];
};

export type ReviewRollbackStatus =
  | "rolledBack"
  | "alreadyRolledBack"
  | "conflict"
  | "unavailable";

export type ReviewRollbackResult = {
  status: ReviewRollbackStatus;
  snapshotId: string;
  messageId?: string;
  path?: string;
};

export type DiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
  /** Patch exceeded the per-file cap; hunks are omitted. */
  tooLarge?: boolean;
  hunks: DiffHunk[];
};

export type WorkspaceDiff = {
  /** Workspace root is a git work tree. */
  repo: boolean;
  /** No pending changes (only meaningful when repo). */
  clean: boolean;
  files: DiffFile[];
  /** File list hit the cap; more changes exist than listed. */
  truncated?: boolean;
};

export type BrowserAction = "back" | "forward" | "reload" | "stop";

export type BrowserState = {
  /** Main-owned origin for retained browser resource tabs. */
  sessionId?: string;
  tabId?: string;
  /** Navigation failure; the previous document must not be presented as ready. */
  loadError?: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};
