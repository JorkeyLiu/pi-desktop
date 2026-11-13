import { useTranslation } from "react-i18next";
import { IconCheck, IconCircleAlert } from "../../components/icons";
import { TooltipButton } from "../../components/ui";
import {
  sidebarSessionStatusIsTogglable,
  type SidebarSessionStatus,
} from "../../lib/sidebar-session-status";

/**
 * The one leading status mark a sidebar session row reserves. Work in flight, a
 * pending permission, and an unread task outcome are informational; only the
 * manual idle mark toggles, so a click can never replace a glyph that reports
 * something the user has not read yet.
 */
export function SessionStatusMark({
  status,
  sessionId,
  onTogglePending,
}: {
  status: SidebarSessionStatus;
  sessionId: string;
  onTogglePending: (id: string) => void;
}) {
  const { t } = useTranslation();
  const marked = status === "pending";

  if (sidebarSessionStatusIsTogglable(status)) {
    return (
      <TooltipButton
        type="button"
        className={`thread-item-status ${status} toggleable`}
        data-session-status={status}
        data-session-id={sessionId}
        aria-pressed={marked}
        ariaLabel={t("nav.sessionPendingMarker", { defaultValue: "Pending marker" })}
        tooltip={
          marked
            ? t("nav.sessionClearPending", { defaultValue: "Clear pending marker" })
            : t("nav.sessionMarkPending", { defaultValue: "Mark as pending" })
        }
        draggable={false}
        onDragStart={(event) => {
          // A toggle inside a draggable row must not start the row drag.
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onTogglePending(sessionId);
        }}
      />
    );
  }

  const label =
    status === "running"
      ? t("nav.sessionRunning", { defaultValue: "In progress" })
      : status === "completed"
        ? t("nav.sessionCompleted", { defaultValue: "Completed" })
        : status === "failed"
          ? t("nav.sessionFailed", { defaultValue: "Failed" })
          : t("nav.sessionPermission", { defaultValue: "Permission required" });

  return (
    <span
      className={`thread-item-status ${status}`}
      data-session-status={status}
      data-session-id={sessionId}
      aria-label={label}
      title={label}
      // Informational marks are not controls, but they swallow the click so a
      // pointer can never select the row or acknowledge an unread outcome.
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {status === "completed" ? <IconCheck size={10} aria-hidden /> : null}
      {status === "failed" ? <IconCircleAlert size={11} aria-hidden /> : null}
    </span>
  );
}
