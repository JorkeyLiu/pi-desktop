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
 * device-local manual pending marker, and an idle row is never blank: it shows
 * the hollow mark that carries the manual toggle.
 */
export function sidebarSessionStatus({
  running,
  outcome,
  pending,
  hasPendingPermission,
}: {
  running: boolean;
  outcome?: SidebarSessionOutcome;
  pending?: boolean;
  hasPendingPermission?: boolean;
}): SidebarSessionStatus {
  if (hasPendingPermission) return "permission";
  if (running) return "running";
  if (outcome) return outcome;
  if (pending) return "pending";
  return "idle";
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
 * its visible state has to be the idle or manual mark. Live work, a pending
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
}: {
  known: boolean;
  running: boolean;
  outcome?: SidebarSessionOutcome;
  pending?: boolean;
  hasPendingPermission?: boolean;
}): boolean {
  if (!known) return false;
  return sidebarSessionStatusIsTogglable(
    sidebarSessionStatus({ running, outcome, pending, hasPendingPermission }),
  );
}
