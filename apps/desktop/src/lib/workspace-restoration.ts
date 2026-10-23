import {
  normalizeProjectPath,
  sessionIsArchived,
  type SessionMeta,
} from "./sidebar-preferences.ts";
import type { SessionSummary } from "@pi-desktop/shared";

/** Summary fields the launch restore reads; the archived flag is decoration. */
type RestorableSession = Pick<SessionSummary, "id" | "projectPath" | "source">;

/**
 * The session launch may reopen: an existing ordinary session that belongs to
 * the restored project.
 *
 * Workspace restoration does not require a project, so a session without a
 * project path is restored when the host restored no workspace either. Remote
 * sessions, archived rows, a selection that no longer exists, and a selection
 * bound to a different project all fall back to the empty home.
 */
export function restorableSessionId(
  selectedId: string | undefined,
  sessions: readonly RestorableSession[],
  projectPath: string | undefined,
  sessionMeta: Record<string, SessionMeta> = {},
): string | undefined {
  if (!selectedId) return undefined;
  const session = sessions.find((item) => item.id === selectedId);
  if (!session || session.source === "remote") return undefined;
  if (sessionIsArchived(selectedId, sessionMeta)) return undefined;
  // `decorateSessions` copies the sidebar archived flag onto the runtime row and
  // `SessionSummary` does not declare it, so read it defensively.
  if ((session as RestorableSession & { archived?: unknown }).archived === true) return undefined;
  if (normalizeProjectPath(session.projectPath) !== normalizeProjectPath(projectPath)) return undefined;
  return session.id;
}
