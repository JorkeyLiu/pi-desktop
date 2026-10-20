import type { SessionSummary } from "@pi-desktop/shared";
import { normalizeProjectPath, sessionPinned } from "./sidebar-session-groups.ts";
import type { SessionMeta } from "./sidebar-preferences.ts";

/**
 * Sessions reorder only inside the list that renders them: the global pinned
 * section, one project group, or Temporary. A cross-project drag is a move, not
 * a reorder, so it never reaches these helpers.
 */
export function sessionOrderBucket(session: SessionSummary, meta: SessionMeta | undefined): string {
  if (sessionPinned(session, meta)) return "pinned";
  const path = normalizeProjectPath(session.projectPath);
  return path ? `project:${path}` : "temporary";
}

export function canReorderSidebarSessions(
  source: SessionSummary,
  target: SessionSummary,
  sessionMeta: Record<string, SessionMeta>,
): boolean {
  if (source.id === target.id) return false;
  return (
    sessionOrderBucket(source, sessionMeta[source.id]) ===
    sessionOrderBucket(target, sessionMeta[target.id])
  );
}

/**
 * Move one row next to another inside an ordered list. A target that is not in
 * the list leaves the order untouched, so a stale drop cannot rewrite ranks.
 */
export function moveSessionWithinOrder(
  orderedIds: readonly string[],
  sourceId: string,
  targetId: string,
  insertAfter: boolean,
): string[] {
  if (!sourceId || !targetId || sourceId === targetId) return [...orderedIds];
  if (!orderedIds.includes(sourceId)) return [...orderedIds];
  const remaining = orderedIds.filter((id) => id !== sourceId);
  const targetIndex = remaining.indexOf(targetId);
  if (targetIndex < 0) return [...orderedIds];
  remaining.splice(targetIndex + (insertAfter ? 1 : 0), 0, sourceId);
  return remaining;
}

/** Contiguous ranks for one container; other containers keep their own ranks. */
export function sessionOrderRanks(orderedIds: readonly string[]): Record<string, number> {
  const ranks: Record<string, number> = {};
  const seen = new Set<string>();
  let next = 0;
  for (const id of orderedIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ranks[id] = next;
    next += 1;
  }
  return ranks;
}

/** Drop a session's rank after it leaves its container, so it lands on top. */
export function withoutSessionOrder(
  sessionMeta: Record<string, SessionMeta>,
  id: string,
): Record<string, SessionMeta> {
  const current = sessionMeta[id];
  if (!current || current.order === undefined) return sessionMeta;
  const rest: SessionMeta = { ...current };
  delete rest.order;
  const next = { ...sessionMeta };
  if (Object.keys(rest).length) next[id] = rest;
  else delete next[id];
  return next;
}
