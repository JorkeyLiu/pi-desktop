import type { RemoteWorkspace } from "@pi-desktop/shared";

export type RecentProject = {
  remote?: RemoteWorkspace;
  path: string;
  name: string;
  branch?: string;
  openedAt: number;
  pinned?: boolean;
  color?: string;
};

const KEY = "pi.desktop.recentProjects";
const MAX = 24;

const COLORS = ["#6b6b6b", "#5d5d5d", "#4f4f4f", "#414141", "#383838", "#303030"];

function normalizedProjectPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function projectColor(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function loadRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentProject[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p.path === "string" && typeof p.name === "string")
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

/**
 * Register a project the user reached, refreshing its workspace metadata.
 *
 * `openedAt` is the entry's registration time, not its last access: it is the
 * only ordering input the Projects index and the home switcher have, so an
 * existing project keeps the time it entered the list and only a project the
 * user did not have yet is registered with the current time.
 */
export function rememberProject(input: {
  remote?: RemoteWorkspace;
  path: string;
  name: string;
  branch?: string | null;
}): RecentProject[] {
  const existing = loadRecentProjects();
  const prev = existing.find((p) => p.path === input.path);
  const record: RecentProject = {
    ...(input.remote ? { remote: input.remote } : {}),
    path: input.path,
    name: input.name,
    branch: input.branch || undefined,
    openedAt: prev?.openedAt ?? Date.now(),
    pinned: prev?.pinned,
    color: prev?.color || projectColor(input.path),
  };
  // An existing project is refreshed in place, so its list position cannot
  // change. Only a newly registered project joins the list.
  const next = prev
    ? existing.map((project) => (project.path === input.path ? record : project))
    : [record, ...existing].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function setProjectPinned(path: string, pinned: boolean): RecentProject[] {
  const next = loadRecentProjects().map((p) => (p.path === path ? { ...p, pinned } : p));
  next.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.openedAt - a.openedAt);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function renameRecentProject(path: string, name: string): RecentProject[] {
  const key = normalizedProjectPath(path);
  const next = loadRecentProjects().map((project) => {
    const projectKey = normalizedProjectPath(project.path);
    return projectKey === key ? { ...project, name } : project;
  });
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function removeRecentProject(path: string): RecentProject[] {
  const key = normalizedProjectPath(path);
  const next = loadRecentProjects().filter(
    (project) => normalizedProjectPath(project.path) !== key,
  );
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
