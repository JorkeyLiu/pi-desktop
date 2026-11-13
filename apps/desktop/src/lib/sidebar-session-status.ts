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
