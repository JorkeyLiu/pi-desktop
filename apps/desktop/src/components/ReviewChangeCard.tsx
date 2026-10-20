import { useChatSessionCapability } from "../hooks/use-chat-session-capability";
import { memo, useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DiffHunk,
  ReviewChange,
  ReviewChangeStatus,
  ReviewDiffReason,
  ReviewFileChange,
  UiMessage,
} from "@pi-desktop/shared";
import { reviewChangeFromMessage } from "../lib/workspace-review";
import { useAppStore } from "../stores/app-store";
import { cx } from "./ui";
import { IconCheck, IconChevronRight, IconSnapshot } from "./icons";

/* Git-status letters carry the status without relying on color alone; the
   localized word stays in the row's accessible name. */
const STATUS_MARKS: Record<ReviewChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

/** Why the host could not produce line evidence, worded per cause. */
function limitNote(reason: ReviewDiffReason | undefined, truncated: boolean) {
  if (reason === "fileTooLarge") return "panel.review.limit.fileTooLarge";
  if (reason === "diffTooComplex") return "panel.review.limit.diffTooComplex";
  if (reason === "baselineUnavailable") {
    return "panel.review.limit.baselineUnavailable";
  }
  if (reason === "unreadable") return "panel.review.limit.unreadable";
  if (reason === "workspaceUnavailable") {
    return "panel.review.limit.workspaceUnavailable";
  }
  if (reason === "requestBudgetExceeded") {
    return "panel.review.limit.requestBudgetExceeded";
  }
  if (reason === "diffTooLarge" || truncated) return "panel.review.tooLarge";
  return null;
}

/** The last path segment of a root, for telling two folders apart. */
function rootName(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const trimmed = root.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * The `+a/−d` pair a change reports, shared by the standalone card's header and
 * the tool row that produced the change (which shows them at its end instead of
 * repeating the file name in a second collapsed row). A change the host could
 * not count shows a marker instead of a false zero.
 */
export function ReviewChangeCounts({
  change,
  className,
}: {
  change: Pick<ReviewChange, "additions" | "deletions">;
  className?: string;
}) {
  const { t } = useTranslation();
  const { additions, deletions } = change;
  if (additions === undefined || deletions === undefined) {
    return (
      <span
        className={cx("review-change-card-counts", "diff-counts", className)}
        aria-label={t("panel.review.countsUnknown")}
        title={t("panel.review.countsUnknown")}
      >
        <span className="diff-count-unknown">…</span>
      </span>
    );
  }
  return (
    <span
      className={cx("review-change-card-counts", "diff-counts", className)}
      aria-label={t("chat.reviewChangeCounts", { additions, deletions })}
    >
      {additions > 0 && (
        <span className="diff-count-add">+{additions}</span>
      )}
      {deletions > 0 && (
        <span className="diff-count-del">−{deletions}</span>
      )}
    </span>
  );
}

/**
 * A change's line evidence, or the reason there is none. Shared by the tool
 * row's body and the review panel's per-file row.
 */
export function ReviewDiffView({
  hunks,
  binary,
  truncated,
  reason,
}: {
  hunks: DiffHunk[];
  binary?: boolean;
  truncated?: boolean;
  reason?: ReviewDiffReason;
}) {
  const { t } = useTranslation();
  if (binary) {
    return <div className="review-change-note">{t("panel.review.binary")}</div>;
  }
  const note = limitNote(reason, truncated === true);
  if (note) {
    return <div className="review-change-note">{t(note)}</div>;
  }
  if (hunks.length === 0) {
    return (
      <div className="review-change-note">{t("panel.review.noLineDetails")}</div>
    );
  }
  return (
    <div className="review-change-diff">
      {hunks.map((hunk, hunkIndex) => (
        <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
          <div className="diff-line hunk">
            <span className="diff-line-text">{hunk.header}</span>
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <div className={cx("diff-line", line.type)} key={lineIndex}>
              <span className="diff-line-sign" aria-hidden>
                {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
              </span>
              <span className="diff-line-text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The change itself: its diff (or the reason there is none), and the rollback
 * action. Owned by whichever disclosure is showing the change — the standalone
 * card in the review panel, or the tool row in the transcript.
 */
export function ReviewChangeBody({
  message,
  compact = false,
}: {
  message: UiMessage;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const change = reviewChangeFromMessage(message);
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const rollback = useAppStore((state) => state.rollbackWorkspaceChange);
  const [rollingBack, setRollingBack] = useState(false);

  if (!change) return null;

  const runRollback = async () => {
    if (!localToolsAllowed || !change.reversible || change.state === "rolledBack" || rollingBack) return;
    setRollingBack(true);
    // A conflict or an unavailable snapshot is already reported through the
    // store's toast; this card owns the rollback action only.
    await rollback(message.id, change.snapshotId);
    setRollingBack(false);
  };

  return (
    <div className="review-change-card-body-content">
      <ReviewDiffView
        hunks={change.hunks}
        binary={change.binary}
        truncated={change.truncated}
        reason={change.reason}
      />

      <div className={cx("review-change-card-actions", compact && "is-compact")}>
        {change.state === "rolledBack" ? (
          <span className="review-change-state is-rolled-back">
            <IconCheck size={13} />
            {t("panel.review.rolledBack")}
          </span>
        ) : change.reversible && localToolsAllowed ? (
          <button
            type="button"
            className="review-change-rollback"
            onClick={() => void runRollback()}
            disabled={rollingBack}
          >
            <IconSnapshot size={13} />
            {rollingBack
              ? t("panel.review.rollingBack")
              : t("panel.review.rollback")}
          </button>
        ) : (
          <span className="review-change-rollback-note">
            {t("panel.review.rollbackUnavailable")}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One workspace change in the review panel, with its own collapsed row: the
 * panel lists changes that belong to no visible tool row. In the transcript the
 * change lives in the tool row that made it, so no second file-name row appears.
 */
export const ReviewChangeCard = memo(function ReviewChangeCard({
  message,
  compact = false,
}: {
  message: UiMessage;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const change = reviewChangeFromMessage(message);
  const detailsId = useId();
  const [open, setOpen] = useState(false);

  if (!change) return null;

  const statusLabel = t(`panel.review.status.${change.status}`);
  const baseLabel = t(open ? "chat.reviewChangeHide" : "chat.reviewChangeShow", {
    status: statusLabel,
    path: change.path,
    additions: change.additions ?? "…",
    deletions: change.deletions ?? "…",
  });
  // The collapsed row shows a rolled-back change struck through, so the state
  // has to reach the accessible name too.
  const accessibleLabel =
    change.state === "rolledBack"
      ? `${baseLabel} · ${t("panel.review.rolledBack")}`
      : baseLabel;

  return (
    <section
      className={cx("review-change-card", compact && "is-compact", open && "open")}
      data-state={change.state}
      data-status={change.status}
    >
      <button
        type="button"
        className="review-change-card-header"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="review-change-card-caret" aria-hidden>
          <IconChevronRight size={11} />
        </span>
        <span
          className={cx("review-change-card-mark", `is-${change.status}`)}
          aria-hidden
        >
          {STATUS_MARKS[change.status]}
        </span>
        <span className="review-change-card-path" title={change.path}>
          {change.path}
        </span>
        <ReviewChangeCounts change={change} />
      </button>
      {open ? (
        <div className="review-change-card-body" id={detailsId}>
          <ReviewChangeBody message={message} compact={compact} />
        </div>
      ) : null}
    </section>
  );
});

/**
 * One file's net change in the review panel: the bytes this conversation first
 * saw against the working tree as it is now. Its row is the panel's only row
 * per file; the per-tool records stay on their tool rows in the transcript.
 */
export const ReviewFileChangeCard = memo(function ReviewFileChangeCard({
  file,
  sessionId,
  showRoot = false,
  onRolledBack,
}: {
  file: ReviewFileChange;
  /** The session this row belongs to; a rollback never crosses sessions. */
  sessionId: string | null;
  /** Two folders can share a relative path, so the row names its folder. */
  showRoot?: boolean;
  onRolledBack: () => void;
}) {
  const { t } = useTranslation();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const rollback = useAppStore((state) => state.rollbackReviewFile);
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const runRollback = useCallback(async () => {
    if (!localToolsAllowed || !file.reversible || file.rolledBack || rollingBack) {
      return;
    }
    if (!sessionId) return;
    setRollingBack(true);
    const result = await rollback(sessionId, file.root, file.path);
    setRollingBack(false);
    if (result?.status === "rolledBack" || result?.status === "alreadyRolledBack") {
      onRolledBack();
    }
  }, [file, localToolsAllowed, onRolledBack, rollback, rollingBack, sessionId]);

  const statusLabel = t(`panel.review.status.${file.status}`);
  const countsLabel =
    file.additions === undefined || file.deletions === undefined
      ? t("panel.review.countsUnknown")
      : t("chat.reviewChangeCounts", file);
  const rootLabel = showRoot ? rootName(file.root) : undefined;
  const displayPath = rootLabel ? `${rootLabel}/${file.path}` : file.path;
  const fullPath = file.root ? `${file.root}/${file.path}` : file.path;
  const baseLabel = t(open ? "panel.review.fileHide" : "panel.review.fileShow", {
    status: statusLabel,
    path: displayPath,
  });
  const accessibleLabel = file.rolledBack
    ? `${baseLabel} - ${countsLabel} · ${t("panel.review.rolledBack")}`
    : `${baseLabel} - ${countsLabel}`;

  return (
    <section
      className={cx("review-change-card", "is-compact", open && "open")}
      data-state={file.rolledBack ? "rolledBack" : "active"}
      data-status={file.status}
      data-scope="file"
    >
      <button
        type="button"
        className="review-change-card-header"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="review-change-card-caret" aria-hidden>
          <IconChevronRight size={11} />
        </span>
        <span
          className={cx("review-change-card-mark", `is-${file.status}`)}
          aria-hidden
        >
          {STATUS_MARKS[file.status]}
        </span>
        <span className="review-change-card-path" title={fullPath}>
          {displayPath}
        </span>
        <ReviewChangeCounts change={file} />
      </button>
      {open ? (
        <div className="review-change-card-body" id={detailsId}>
          <div className="review-change-card-body-content">
            <ReviewDiffView
              hunks={file.hunks}
              binary={file.binary}
              truncated={file.truncated}
              reason={file.reason}
            />
            <div className="review-change-card-actions is-compact">
              {file.rolledBack ? (
                <span className="review-change-state is-rolled-back">
                  <IconCheck size={13} />
                  {t("panel.review.rolledBack")}
                </span>
              ) : file.reversible && localToolsAllowed ? (
                <button
                  type="button"
                  className="review-change-rollback"
                  onClick={() => void runRollback()}
                  disabled={rollingBack}
                >
                  <IconSnapshot size={13} />
                  {rollingBack
                    ? t("panel.review.rollingBack")
                    : t("panel.review.rollback")}
                </button>
              ) : (
                <span className="review-change-rollback-note">
                  {t("panel.review.rollbackUnavailable")}
                </span>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
});
