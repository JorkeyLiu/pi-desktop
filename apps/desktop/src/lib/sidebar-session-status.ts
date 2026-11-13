export type SidebarSessionStatus =
  | "permission"
  | "running"
  | "completed"
  | "failed"
  | "pending"
  | "idle";
export type SidebarSessionOutcome = Extract<
  SidebarSessionStatus,
  "completed" | "failed"
>;

export { latestSessionOutcomes } from "@pi-desktop/shared";

/**
 * One leading status slot per session row. The unread task outcome outranks the
 * device-local manual pending marker. An unmarked row resolves to a status only
 * while it is the selected conversation: the selected idle row carries the
 * hollow mark that opens the manual toggle, and an unselected unmarked row
 * renders no mark at all, so no idle row is decorated and the gutter never
 * holds an invisible control.
 */
export function sidebarSessionStatus({
  running,
  outcome,
  pending,
  hasPendingPermission,
  selected,
}: {
  running: boolean;
  outcome?: SidebarSessionOutcome;
  pending?: boolean;
  hasPendingPermission?: boolean;
  selected: boolean;
}): SidebarSessionStatus | null {
  if (hasPendingPermission) return "permission";
  if (running) return "running";
  if (outcome) return outcome;
  if (pending) return "pending";
  return selected ? "idle" : null;
}

/**
 * Only the manual idle mark toggles. Work in flight, a pending permission, and
 * an unread outcome stay informational so a click can never replace them.
 */
export function sidebarSessionStatusIsTogglable(
  status: SidebarSessionStatus,
): boolean {
  return status === "pending" || status === "idle";
}

/**
 * The status rule a flip of the manual mark must pass at the action boundary
 * too, not only in the row control: the session has to exist in the sidebar and
 * its visible state has to be the selected idle hollow or the manual mark on
 * any row. That keeps a hidden idle row from toggling through a direct caller
 * while an unselected manual mark stays clearable, and live work, a pending
 * permission, and an unread outcome keep the mark informational, so no caller
 * can flip the stored flag under a glyph that reports something the user has
 * not acted on yet.
 */
export function sessionPendingToggleAllowed({
  known,
  running,
  outcome,
  pending,
  hasPendingPermission,
  selected,
}: {
  known: boolean;
  running: boolean;
  outcome?: SidebarSessionOutcome;
  pending?: boolean;
  hasPendingPermission?: boolean;
  selected: boolean;
}): boolean {
  if (!known) return false;
  const status = sidebarSessionStatus({
    running,
    outcome,
    pending,
    hasPendingPermission,
    selected,
  });
  return status !== null && sidebarSessionStatusIsTogglable(status);
}
