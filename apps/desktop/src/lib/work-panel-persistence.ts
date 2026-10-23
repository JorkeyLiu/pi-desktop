import {
  isKnownWorkPanelTab,
  normalizeWorkPanelFilePath,
  parsePluginViewRef,
  type WorkPanelContext,
  type WorkPanelTab,
  type WorkPanelTabKind,
} from "./work-panel-tabs";
import {
  WORK_PANEL_COMPACT_MIN_WIDTH,
  WORK_PANEL_DEFAULT_WIDTH,
  clampWorkPanelWidth,
} from "./work-panel-resize";

/**
 * One renderer preference blob per profile.
 *
 * The legacy shape was `{ width }`; the current record adds the panel's open
 * flag and every conversation's ordered tabs with its active tab. Older
 * records keep loading their width and nothing else, so an upgrade never
 * invents panel content the user did not have.
 */
export const WORK_PANEL_STORAGE_KEY = "pi.desktop.workPanel";
export const WORK_PANEL_SNAPSHOT_VERSION = 2;

/** Upper bounds keep a corrupted or hostile record from bloating storage. */
const MAX_SESSION_CONTEXTS = 60;
const MAX_TABS_PER_CONTEXT = 40;
const MAX_ID_CHARS = 1024;
const MAX_RESOURCE_CHARS = 4096;
const MAX_LOCATION_CHARS = 4096;
const MAX_LABEL_CHARS = 200;
const MAX_MIME_TYPE_CHARS = 200;

export type WorkPanelSnapshot = {
  width: number;
  open: boolean;
  /** Restored resource state keyed by session id; file requests are rebuilt. */
  contexts: Record<string, WorkPanelContext>;
};

export type WorkPanelPersistable = {
  workPanelOpen: boolean;
  workPanelWidth: number;
  activeSessionId?: string;
  workPanelTabs: readonly WorkPanelTab[];
  activeWorkPanelTabId: string | null;
  workPanelContexts: Record<string, WorkPanelContext>;
};

export const EMPTY_WORK_PANEL_SNAPSHOT: WorkPanelSnapshot = {
  width: WORK_PANEL_DEFAULT_WIDTH,
  open: false,
  contexts: {},
};

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readRecord(): Record<string, unknown> | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(WORK_PANEL_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSnapshot(payload: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(WORK_PANEL_STORAGE_KEY, payload);
  } catch {
    // Preferences are best effort and must never block the app.
  }
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

function positionValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

/**
 * One tab as it may be restored. Ids, kinds, and the kind's required resource
 * are validated here rather than trusted from storage: an unknown kind or a
 * plugin resource without `pluginId/viewId` cannot be rendered, so it is
 * discarded instead of reaching a component lookup. A file tab's id is rebuilt
 * from its normalized path, exactly as the live open path builds it.
 */
export function restoreWorkPanelTab(raw: unknown): WorkPanelTab | null {
  if (!isRecord(raw)) return null;
  const id = boundedText(raw.id, MAX_ID_CHARS);
  if (!id) return null;
  if (typeof raw.kind !== "string") return null;
  const kind = raw.kind as WorkPanelTabKind;
  if (!isKnownWorkPanelTab({ id, kind })) return null;

  const resource = boundedText(raw.resource, MAX_RESOURCE_CHARS);
  const location = boundedText(raw.location, MAX_LOCATION_CHARS);
  const label = boundedText(raw.label, MAX_LABEL_CHARS);
  const mimeType = boundedText(raw.mimeType, MAX_MIME_TYPE_CHARS);
  const line = positionValue(raw.line);
  const column = positionValue(raw.column);

  const tab: WorkPanelTab = { id, kind };
  if (label) tab.label = label;
  if (location) tab.location = location;
  if (mimeType) tab.mimeType = mimeType;
  if (line !== undefined) tab.line = line;
  if (column !== undefined) tab.column = column;

  switch (kind) {
    case "plugin": {
      if (!resource || !parsePluginViewRef(resource)) return null;
      return { ...tab, resource };
    }
    case "file": {
      if (!resource) return null;
      const normalized = normalizeWorkPanelFilePath(resource);
      if (!normalized) return null;
      return { ...tab, id: `file:${normalized}`, resource: normalized };
    }
    case "subagent": {
      if (!resource) return null;
      return { ...tab, resource };
    }
    default:
      return tab;
  }
}

/** Ordered, de-duplicated, renderable tabs with a repaired active tab. */
export function restoreWorkPanelTabs(
  rawTabs: unknown,
  rawActiveTabId: unknown,
): { tabs: WorkPanelTab[]; activeTabId: string | null } {
  if (!Array.isArray(rawTabs)) return { tabs: [], activeTabId: null };
  const seen = new Set<string>();
  const tabs: WorkPanelTab[] = [];
  for (const item of rawTabs) {
    if (tabs.length >= MAX_TABS_PER_CONTEXT) break;
    const tab = restoreWorkPanelTab(item);
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
  }
  // The active id is only meaningful relative to the tabs that survived, so a
  // record whose active tab was invalid selects the first survivor instead.
  const activeTabId =
    typeof rawActiveTabId === "string" &&
    tabs.some((tab) => tab.id === rawActiveTabId)
      ? rawActiveTabId
      : (tabs[0]?.id ?? null);
  return { tabs, activeTabId };
}

function restoreContexts(raw: unknown): Record<string, WorkPanelContext> {
  if (!isRecord(raw)) return {};
  const contexts: Record<string, WorkPanelContext> = {};
  let restored = 0;
  // Stored order is save order, which writes the conversation the user was
  // reading first, so the bound keeps the entries that matter. An unusable
  // entry is skipped without consuming a slot.
  for (const [sessionId, value] of Object.entries(raw)) {
    if (restored >= MAX_SESSION_CONTEXTS) break;
    const id = boundedText(sessionId, MAX_ID_CHARS);
    if (!id || id.startsWith("remote:") || !isRecord(value)) continue;
    const { tabs, activeTabId } = restoreWorkPanelTabs(
      value.tabs,
      value.activeTabId,
    );
    if (!tabs.length) continue;
    contexts[id] = { tabs, activeTabId, fileRequest: null };
    restored += 1;
  }
  return contexts;
}

function restoredWidth(value: unknown): number {
  const width = Number(value);
  return Number.isFinite(width)
    ? clampWorkPanelWidth(Math.round(width), WORK_PANEL_COMPACT_MIN_WIDTH)
    : WORK_PANEL_DEFAULT_WIDTH;
}

export function loadWorkPanelSnapshot(): WorkPanelSnapshot {
  const record = readRecord();
  if (!record) return { ...EMPTY_WORK_PANEL_SNAPSHOT, contexts: {} };
  const width = restoredWidth(record.width);
  // Only the current version defines open state and session contexts. A legacy
  // `{ width }` record (or one from a newer, unknown version) restores width
  // and leaves the panel closed with no tabs, exactly as before.
  if (record.version !== WORK_PANEL_SNAPSHOT_VERSION) {
    return { width, open: false, contexts: {} };
  }
  return {
    width,
    open: record.open === true,
    contexts: restoreContexts(record.sessions),
  };
}

/** Serialize one context for storage, or null when it holds nothing. */
function storedContext(
  context: WorkPanelContext | undefined,
): { tabs: WorkPanelTab[]; activeTabId: string | null } | null {
  if (!context || !Array.isArray(context.tabs)) return null;
  const { tabs, activeTabId } = restoreWorkPanelTabs(
    context.tabs,
    context.activeTabId,
  );
  return tabs.length ? { tabs, activeTabId } : null;
}

export function workPanelSnapshotChanged(
  previous: WorkPanelPersistable,
  next: WorkPanelPersistable,
): boolean {
  return (
    previous.workPanelOpen !== next.workPanelOpen ||
    previous.workPanelWidth !== next.workPanelWidth ||
    previous.activeSessionId !== next.activeSessionId ||
    previous.workPanelTabs !== next.workPanelTabs ||
    previous.activeWorkPanelTabId !== next.activeWorkPanelTabId ||
    previous.workPanelContexts !== next.workPanelContexts
  );
}

let lastSerializedSnapshot: string | null = null;

/**
 * Write the whole panel preference: open flag, committed width, and each
 * conversation's ordered tabs plus its active tab. The visible conversation is
 * written first from the projected tabs, so it can never be shadowed by a
 * retained context and never be the entry the size bound drops; retained
 * contexts fill only the slots it leaves. Runtime-only file requests are never
 * stored, and a visible conversation with no tabs stays out of the record.
 */
export function saveWorkPanelSnapshot(state: WorkPanelPersistable): void {
  const sessions: Record<
    string,
    { tabs: WorkPanelTab[]; activeTabId: string | null }
  > = {};
  const visibleId = boundedText(state.activeSessionId, MAX_ID_CHARS);
  const visibleSessionId =
    visibleId && !visibleId.startsWith("remote:") ? visibleId : undefined;
  if (visibleSessionId) {
    const stored = storedContext({
      tabs: [...state.workPanelTabs],
      activeTabId: state.activeWorkPanelTabId,
      fileRequest: null,
    });
    if (stored) sessions[visibleSessionId] = stored;
  }
  let retained = Object.keys(sessions).length;
  for (const [sessionId, context] of Object.entries(state.workPanelContexts)) {
    if (retained >= MAX_SESSION_CONTEXTS) break;
    const id = boundedText(sessionId, MAX_ID_CHARS);
    if (!id || id.startsWith("remote:") || id === visibleSessionId) continue;
    const stored = storedContext(context);
    if (!stored) continue;
    sessions[id] = stored;
    retained += 1;
  }

  const payload = JSON.stringify({
    version: WORK_PANEL_SNAPSHOT_VERSION,
    width: restoredWidth(state.workPanelWidth),
    open: state.workPanelOpen === true,
    sessions,
  });
  if (payload === lastSerializedSnapshot) return;
  lastSerializedSnapshot = payload;
  writeSnapshot(payload);
}
