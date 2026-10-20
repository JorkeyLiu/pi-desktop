import { useChatSessionCapability } from "../hooks/use-chat-session-capability";
import { memo, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ReviewChange,
  ReviewChangeStatus,
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

/**
 * The `+a/−d` pair a change reports, shared by the standalone card's header and
 * the tool row that produced the change (which shows them at its end instead of
 * repeating the file name in a second collapsed row).
 */
export function ReviewChangeCounts({
  change,
  className,
}: {
  change: Pick<ReviewChange, "additions" | "deletions">;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cx("review-change-card-counts", "diff-counts", className)}
      aria-label={t("chat.reviewChangeCounts", change)}
    >
      {change.additions > 0 && (
        <span className="diff-count-add">+{change.additions}</span>
      )}
      {change.deletions > 0 && (
        <span className="diff-count-del">−{change.deletions}</span>
      )}
    </span>
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
      {change.binary ? (
        <div className="review-change-note">{t("panel.review.binary")}</div>
      ) : change.truncated ? (
        <div className="review-change-note">{t("panel.review.tooLarge")}</div>
      ) : change.hunks.length > 0 ? (
        <div className="review-change-diff">
          {change.hunks.map((hunk, hunkIndex) => (
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
      ) : (
        <div className="review-change-note">{t("panel.review.noLineDetails")}</div>
      )}

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
    additions: change.additions,
    deletions: change.deletions,
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
