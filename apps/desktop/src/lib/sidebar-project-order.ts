import type { ProjectMeta, ProjectSort } from "./sidebar-preferences.ts";
import { normalizeProjectPath } from "./sidebar-session-groups.ts";

/** The parts of a sidebar project group that decide its position. */
export type ProjectGroupOrderEntry = {
  /** Normalized project path. */
  key: string;
  name: string;
  meta: ProjectMeta;
  /** Session dates only; activity must never order project groups. */
  sessions: readonly { createdAt?: string }[];
};

/**
 * Rank retained tabs by visit recency: the path the user opened last has the
 * highest rank. Opening a project is an explicit user action, so it may move a
 * group; a message timestamp never can.
 */
export function projectVisitRanks(
  openProjectPaths: readonly string[],
): Record<string, number> {
  const ranks: Record<string, number> = {};
  openProjectPaths.forEach((path, index) => {
    const key = normalizeProjectPath(path);
    if (key) ranks[key] = index;
  });
  return ranks;
}

function timestamp(value?: string): number | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function compareOptionalNumber(
  a: number | null,
  b: number | null,
  descending: boolean,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

function firstCreatedAt(sessions: ProjectGroupOrderEntry["sessions"]): number | null {
  const values = sessions
    .map((session) => timestamp(session.createdAt))
    .filter((value): value is number => value !== null);
  return values.length ? Math.min(...values) : null;
}

function lastCreatedAt(sessions: ProjectGroupOrderEntry["sessions"]): number | null {
  const values = sessions
    .map((session) => timestamp(session.createdAt))
    .filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}

/**
 * Project-group order: archived last, pinned first, then the selected mode.
 * `recent` is the retained-tab visit order (falling back to the newest created
 * session for a project without an open tab), so creating or replying to a
 * conversation never reorders the projects themselves.
 */
export function compareProjectGroups(
  a: ProjectGroupOrderEntry,
  b: ProjectGroupOrderEntry,
  sort: ProjectSort,
  visitRanks: Record<string, number>,
): number {
  const archiveOrder = Number(!!a.meta.archived) - Number(!!b.meta.archived);
  if (archiveOrder !== 0) return archiveOrder;
  const pinOrder = Number(!!b.meta.pinned) - Number(!!a.meta.pinned);
  if (pinOrder !== 0) return pinOrder;

  if (sort === "manual") {
    const byOrder =
      (a.meta.order ?? Number.MAX_SAFE_INTEGER) - (b.meta.order ?? Number.MAX_SAFE_INTEGER);
    if (byOrder !== 0) return byOrder;
  } else if (sort === "name") {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
  } else if (sort === "created" || sort === "oldest") {
    const byCreated = compareOptionalNumber(
      sort === "oldest" ? firstCreatedAt(a.sessions) : lastCreatedAt(a.sessions),
      sort === "oldest" ? firstCreatedAt(b.sessions) : lastCreatedAt(b.sessions),
      sort === "created",
    );
    if (byCreated !== 0) return byCreated;
  } else {
    const byVisit = (visitRanks[b.key] ?? -1) - (visitRanks[a.key] ?? -1);
    if (byVisit !== 0) return byVisit;
    const byCreated = compareOptionalNumber(
      lastCreatedAt(a.sessions),
      lastCreatedAt(b.sessions),
      true,
    );
    if (byCreated !== 0) return byCreated;
  }

  return a.key.localeCompare(b.key);
}

export function sortProjectGroups<T extends ProjectGroupOrderEntry>(
  entries: readonly T[],
  sort: ProjectSort,
  visitRanks: Record<string, number>,
): T[] {
  return [...entries].sort((a, b) => compareProjectGroups(a, b, sort, visitRanks));
}
