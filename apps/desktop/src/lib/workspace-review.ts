import type {
  DiffHunk,
  ReviewChange,
  ReviewChangeState,
  ReviewChangeStatus,
  ReviewDiffReason,
  ReviewFileChange,
  UiMessage,
} from "@pi-desktop/shared";

const REVIEW_CHANGE_TOOLS = new Set(["Write", "Edit"]);
const REVIEW_CHANGE_STATUSES = new Set<ReviewChangeStatus>([
  "added",
  "modified",
  "deleted",
]);
const REVIEW_CHANGE_OPERATIONS = new Set(["write", "edit", "delete"]);
const REVIEW_CHANGE_STATES = new Set<ReviewChangeState>([
  "active",
  "rolledBack",
]);
const REVIEW_DIFF_REASONS = new Set<ReviewDiffReason>([
  "fileTooLarge",
  "diffTooComplex",
  "diffTooLarge",
  "baselineUnavailable",
  "unreadable",
  "workspaceUnavailable",
  "requestBudgetExceeded",
]);

export type ReviewChangeEntry = {
  message: UiMessage;
  change: ReviewChange;
};

export type ReviewChangesSummary = {
  changeCount: number;
  activeCount: number;
  rolledBackCount: number;
  additions: number;
  deletions: number;
};

export type ReviewFilesSummary = {
  fileCount: number;
  additions: number;
  deletions: number;
  /** At least one file could not be counted, so the totals are a lower bound. */
  partial: boolean;
};

/** What one `review.files` answer carried, including how complete it is. */
export type ReviewFilesState = {
  files: ReviewFileChange[];
  /** The host bounded the answer, so the list and totals are a lower bound. */
  truncated: boolean;
  /** Records the host could not read at all. */
  unreadableRecords: number;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function toolResultDetails(message: UiMessage): Record<string, unknown> | null {
  return recordValue(recordValue(message.toolResult)?.details);
}

function parseHunks(value: unknown): DiffHunk[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((hunk) => {
    const record = recordValue(hunk);
    const header = nonEmptyString(record?.header);
    if (!header || !Array.isArray(record?.lines)) return [];
    const lines: DiffHunk["lines"] = record.lines.flatMap((line) => {
      const lineRecord = recordValue(line);
      const type = lineRecord?.type;
      const text = typeof lineRecord?.text === "string" ? lineRecord.text : null;
      const lineType =
        type === "add" || type === "del" || type === "context" ? type : null;
      if (
        text === null ||
        lineType === null
      ) {
        return [];
      }
      return [{ type: lineType, text }];
    });
    return [{ header, lines }];
  });
}

function parseReason(value: unknown): ReviewDiffReason | undefined {
  return typeof value === "string" &&
    REVIEW_DIFF_REASONS.has(value as ReviewDiffReason)
    ? (value as ReviewDiffReason)
    : undefined;
}

/**
 * Read the durable change record embedded in one successful tool message.
 * The message owns this evidence; no current Git state is consulted.
 *
 * The counts are `null` when the host could not count the change, so callers
 * never read an unknown count as zero.
 */
export function reviewChangeFromMessage(message: UiMessage): ReviewChange | null {
  if (
    message.role !== "tool" ||
    message.toolStatus !== "success" ||
    !REVIEW_CHANGE_TOOLS.has(message.toolName || "")
  ) {
    return null;
  }

  const details = toolResultDetails(message);
  if (details?.root !== "workspace") return null;
  const review = recordValue(details.review);
  if (!review || review.version !== 1) return null;

  const snapshotId = nonEmptyString(review.snapshotId);
  const messageId = nonEmptyString(review.messageId);
  const path = nonEmptyString(review.path);
  const operation = review.operation;
  const status = review.status;
  const state = review.state;
  const additions = nonNegativeInteger(review.additions);
  const deletions = nonNegativeInteger(review.deletions);
  if (
    !snapshotId ||
    !messageId ||
    !path ||
    typeof operation !== "string" ||
    !REVIEW_CHANGE_OPERATIONS.has(operation) ||
    typeof status !== "string" ||
    !REVIEW_CHANGE_STATUSES.has(status as ReviewChangeStatus) ||
    typeof state !== "string" ||
    !REVIEW_CHANGE_STATES.has(state as ReviewChangeState)
  ) {
    return null;
  }

  const reason = parseReason(review.reason);
  return {
    version: 1,
    snapshotId,
    messageId,
    path,
    operation: operation as ReviewChange["operation"],
    status: status as ReviewChangeStatus,
    state: state as ReviewChangeState,
    ...(additions === null ? {} : { additions }),
    ...(deletions === null ? {} : { deletions }),
    hunks: parseHunks(review.hunks),
    ...(review.binary === true ? { binary: true } : {}),
    ...(review.truncated === true ? { truncated: true } : {}),
    ...(reason ? { reason } : {}),
    reversible: review.reversible === true,
  };
}

export function reviewChangesFromMessages(
  messages: UiMessage[],
): ReviewChangeEntry[] {
  return messages.flatMap((message) => {
    const change = reviewChangeFromMessage(message);
    return change ? [{ message, change }] : [];
  });
}

/** One file's net change as the host reported it. */
export function parseReviewFileChange(value: unknown): ReviewFileChange | null {
  const record = recordValue(value);
  if (!record || record.version !== 1) return null;
  const path = nonEmptyString(record.path);
  const status = record.status;
  const snapshotIds = Array.isArray(record.snapshotIds)
    ? record.snapshotIds.filter(
        (id): id is string => typeof id === "string" && id.trim() !== "",
      )
    : [];
  if (
    !path ||
    typeof status !== "string" ||
    !REVIEW_CHANGE_STATUSES.has(status as ReviewChangeStatus)
  ) {
    return null;
  }
  const additions = nonNegativeInteger(record.additions);
  const deletions = nonNegativeInteger(record.deletions);
  const reason = parseReason(record.reason);
  const root = nonEmptyString(record.root);
  return {
    version: 1,
    ...(root ? { root } : {}),
    path,
    status: status as ReviewChangeStatus,
    ...(additions === null ? {} : { additions }),
    ...(deletions === null ? {} : { deletions }),
    hunks: parseHunks(record.hunks),
    ...(record.binary === true ? { binary: true } : {}),
    ...(record.truncated === true ? { truncated: true } : {}),
    ...(reason ? { reason } : {}),
    reversible: record.reversible === true,
    rolledBack: record.rolledBack === true,
    snapshotIds,
  };
}

export function reviewFilesFromResult(value: unknown): ReviewFilesState {
  const record = recordValue(value);
  if (!record || !Array.isArray(record.files)) {
    return { files: [], truncated: false, unreadableRecords: 0 };
  }
  return {
    files: record.files.flatMap((file) => {
      const change = parseReviewFileChange(file);
      return change ? [change] : [];
    }),
    truncated: record.truncated === true,
    unreadableRecords: nonNegativeInteger(record.unreadableRecords) ?? 0,
  };
}

/**
 * Net totals for the changed-file rows. Files without exact counts contribute
 * nothing and mark the totals as a lower bound instead of a zero.
 */
export function summarizeReviewFiles(
  state: Pick<ReviewFilesState, "files" | "truncated" | "unreadableRecords">,
): ReviewFilesSummary {
  let additions = 0;
  let deletions = 0;
  let partial = state.truncated || state.unreadableRecords > 0;
  for (const file of state.files) {
    if (file.additions === undefined || file.deletions === undefined) {
      partial = true;
      continue;
    }
    additions += file.additions;
    deletions += file.deletions;
  }
  return { fileCount: state.files.length, additions, deletions, partial };
}

/** Totals for the per-tool records, counted only where the counts are exact. */
export function summarizeReviewChanges(
  changes: ReviewChangeEntry[] | ReviewChange[],
): ReviewChangesSummary {
  return changes.reduce<ReviewChangesSummary>(
    (summary, entry) => {
      const change = "change" in entry ? entry.change : entry;
      summary.changeCount += 1;
      summary.additions += change.additions ?? 0;
      summary.deletions += change.deletions ?? 0;
      if (change.state === "rolledBack") summary.rolledBackCount += 1;
      else summary.activeCount += 1;
      return summary;
    },
    {
      changeCount: 0,
      activeCount: 0,
      rolledBackCount: 0,
      additions: 0,
      deletions: 0,
    },
  );
}

/** Update only the persisted message-local review state after a rollback. */
export function withReviewChangeState(
  message: UiMessage,
  state: ReviewChangeState,
): UiMessage {
  const toolResult = recordValue(message.toolResult);
  const details = recordValue(toolResult?.details);
  const review = recordValue(details?.review);
  if (!toolResult || !details || !review) return message;
  return {
    ...message,
    toolResult: {
      ...toolResult,
      details: {
        ...details,
        review: {
          ...review,
          state,
        },
      },
    },
  };
}
