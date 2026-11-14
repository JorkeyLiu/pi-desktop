import { normalizeSessionHistoryScope, type SessionHistoryScope } from "@pi-desktop/shared";

/** Which transport answers a `session.get` read. */
export type SessionHistoryBackend = "host" | "native" | "remote";

/**
 * The scope a backend read may carry.
 *
 * Only the local host implements scoped history. Native Pi sessions and remote
 * hosts answer the legacy physical transcript and cannot select a scope, so the
 * field is dropped before the request leaves the main process. Dropping it is
 * deliberate and visible: the answer then carries no scope echo, and the
 * renderer keeps its legacy behavior instead of filtering rows the backend did
 * send — a silent filter would hide delegate rows a legacy host legitimately
 * returned.
 */
export function historyScopeForBackend(
  scope: unknown,
  backend: SessionHistoryBackend,
): SessionHistoryScope | undefined {
  if (backend !== "host") return undefined;
  return normalizeSessionHistoryScope(scope);
}

/** The request field to spread into a `session.get` call. */
export function historyScopeForwarding(
  scope: unknown,
  backend: SessionHistoryBackend,
): { historyScope?: SessionHistoryScope } {
  const resolved = historyScopeForBackend(scope, backend);
  return resolved ? { historyScope: resolved } : {};
}
