import type { SessionSummary } from "./types/sessions.js";

export type SessionSort = "recent" | "created" | "oldest" | "name" | "manual";
export type SessionPresentationMeta = {
  pinned?: boolean;
  archived?: boolean;
  order?: number;
};

/** Sort modes that produce a session order the user can actually see. */
export type ResolvedSessionSort = Exclude<SessionSort, "recent">;

/**
 * `recent` was the old default and ordered rows by activity, which moved them
 * while the user was reading. It stays accepted for stored preferences and
 * older callers, but resolves to the stable created-date order.
 */
export function resolveSessionSort(sort?: SessionSort | null): ResolvedSessionSort {
  return !sort || sort === "recent" ? "created" : sort;
}

export function sessionIsPinned(id: string, meta: Record<string, SessionPresentationMeta>): boolean {
  return meta[id]?.pinned === true;
}
export function sessionIsArchived(id: string, meta: Record<string, SessionPresentationMeta>): boolean {
  return meta[id]?.archived === true;
}

function manualOrder(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareOptionalNumber(
  a: number | undefined,
  b: number | undefined,
  descending: boolean,
): number {
  const hasA = typeof a === "number" && Number.isFinite(a);
  const hasB = typeof b === "number" && Number.isFinite(b);
  if (!hasA && !hasB) return 0;
  if (!hasA) return 1;
  if (!hasB) return -1;
  return descending ? (b as number) - (a as number) : (a as number) - (b as number);
}

export type SessionOrderOptions = {
  /** Display title used by the name order; defaults to the stored title. */
  titleOf?: (session: SessionSummary) => string;
};

/** A session row archived by its own record rather than by sidebar metadata. */
function sessionRowArchived(session: SessionSummary): boolean {
  return (session as SessionSummary & { archived?: boolean }).archived === true;
}

/**
 * Total order for one sidebar container: archived rows last, pinned rows
 * first, then the selected mode. Ties never depend on activity, so a row only
 * moves when the user reorders it, creates a session, or changes the mode.
 */
export function compareSessions(
  a: SessionSummary,
  b: SessionSummary,
  meta: Record<string, SessionPresentationMeta>,
  sort: SessionSort = "created",
  options?: SessionOrderOptions,
): number {
  const aMeta = meta[a.id] ?? {};
  const bMeta = meta[b.id] ?? {};
  const archiveOrder =
    Number(sessionIsArchived(a.id, meta) || sessionRowArchived(a)) -
    Number(sessionIsArchived(b.id, meta) || sessionRowArchived(b));
  if (archiveOrder !== 0) return archiveOrder;
  const pinOrder = Number(sessionIsPinned(b.id, meta)) - Number(sessionIsPinned(a.id, meta));
  if (pinOrder !== 0) return pinOrder;

  const resolved = resolveSessionSort(sort);
  if (resolved === "name") {
    const aTitle = options?.titleOf?.(a) ?? a.title;
    const bTitle = options?.titleOf?.(b) ?? b.title;
    const byName = aTitle.localeCompare(bTitle, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
  } else if (resolved === "oldest") {
    const byCreated = compareOptionalNumber(
      timestamp(a.createdAt) || undefined,
      timestamp(b.createdAt) || undefined,
      false,
    );
    if (byCreated !== 0) return byCreated;
  } else if (resolved === "manual") {
    // A session without an assigned rank is new to its container: it belongs on
    // top, while every ranked row keeps its relative order.
    const aOrder = manualOrder(aMeta.order);
    const bOrder = manualOrder(bMeta.order);
    if (aOrder === undefined && bOrder !== undefined) return -1;
    if (bOrder === undefined && aOrder !== undefined) return 1;
    if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) {
      return aOrder - bOrder;
    }
  }

  return (
    compareOptionalNumber(
      timestamp(a.createdAt) || undefined,
      timestamp(b.createdAt) || undefined,
      true,
    ) || a.id.localeCompare(b.id)
  );
}

export function sortSessions(
  sessions: SessionSummary[],
  meta: Record<string, SessionPresentationMeta>,
  sort: SessionSort = "created",
  includeArchived = false,
  options?: SessionOrderOptions,
): SessionSummary[] {
  const rows = includeArchived
    ? sessions
    : sessions.filter((session) => !sessionIsArchived(session.id, meta));
  return [...rows].sort((a, b) => compareSessions(a, b, meta, sort, options));
}
