import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import {
  reviewFilesFromResult,
  summarizeReviewFiles,
  type ReviewFilesState,
} from "../../lib/workspace-review";
import { useAppStore } from "../../stores/app-store";
import { IconDiff } from "../icons";
import { ReviewFileChangeCard } from "../ReviewChangeCard";
import { WorkTabEmpty } from "./WorkTabEmpty";

const EMPTY: ReviewFilesState = {
  files: [],
  truncated: false,
  unreadableRecords: 0,
};

type View = ReviewFilesState & {
  /** The session this view describes; anything else is not rendered. */
  sessionId: string | null;
  loading: boolean;
  failed: boolean;
};

const EMPTY_VIEW: View = {
  ...EMPTY,
  sessionId: null,
  loading: false,
  failed: false,
};

/**
 * The session's net change per file. The host owns the set: it scans the
 * session's own snapshot records, so a new file row appears even when the edit
 * happened before the transcript's visible window. The transcript's per-tool
 * records stay on their tool rows and are not this list.
 */
export function ReviewTab() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const requests = useRef(0);
  const [view, setView] = useState<View>(EMPTY_VIEW);

  const load = useCallback(async (target: string) => {
    const ticket = requests.current + 1;
    requests.current = ticket;
    try {
      const result = await api.workspaceReviewFiles({ sessionId: target });
      if (requests.current !== ticket) return;
      setView({
        ...reviewFilesFromResult(result),
        sessionId: target,
        loading: false,
        failed: false,
      });
    } catch {
      if (requests.current !== ticket) return;
      // A failed read never repaints another session's rows as this one's.
      setView({ ...EMPTY, sessionId: target, loading: false, failed: true });
    }
  }, []);

  useEffect(() => {
    // The previous session's rows must not stay on screen, and must not stay
    // clickable, while this session's answer is in flight.
    requests.current += 1;
    setView(
      sessionId
        ? { ...EMPTY, sessionId, loading: true, failed: false }
        : EMPTY_VIEW,
    );
    if (sessionId) void load(sessionId);
    return () => {
      requests.current += 1;
    };
  }, [load, sessionId]);

  const current = view.sessionId === sessionId ? view : EMPTY_VIEW;
  const summary = useMemo(() => summarizeReviewFiles(current), [current]);
  const roots = useMemo(
    () => new Set(current.files.map((file) => file.root ?? "")),
    [current.files],
  );
  // A single root keeps the familiar relative path; two folders that share a
  // relative name are told apart by their folder name.
  const multiRoot = roots.size > 1;

  if (current.failed) {
    return (
      <div className="review-tab">
        <div className="review-change-note">{t("panel.review.loadFailed")}</div>
      </div>
    );
  }

  if (current.files.length === 0) {
    if (current.loading) return <div className="review-tab" />;
    return (
      <WorkTabEmpty
        icon={IconDiff}
        title={t("panel.review.noChanges")}
      />
    );
  }

  const totalsLabel = summary.partial
    ? t(
        current.unreadableRecords > 0
          ? "panel.review.countsIncomplete"
          : "panel.review.countsPartial",
      )
    : undefined;

  return (
    <div className="review-tab">
      <div className="review-toolbar">
        <span className="review-summary">
          {t("panel.review.filesChanged", { count: summary.fileCount })}
        </span>
        <span
          className="review-toolbar-counts diff-counts"
          {...(totalsLabel ? { title: totalsLabel, "aria-label": totalsLabel } : {})}
        >
          <span className="diff-count-add">+{summary.additions}</span>
          <span className="diff-count-del">−{summary.deletions}</span>
          {summary.partial ? (
            <span className="diff-count-unknown" aria-hidden>
              …
            </span>
          ) : null}
        </span>
      </div>
      <div className="review-scroll">
        {current.files.map((file) => (
          <ReviewFileChangeCard
            key={`${file.root ?? ""}\u0000${file.path}`}
            file={file}
            sessionId={current.sessionId}
            showRoot={multiRoot}
            onRolledBack={() => {
              if (current.sessionId) void load(current.sessionId);
            }}
          />
        ))}
      </div>
    </div>
  );
}
