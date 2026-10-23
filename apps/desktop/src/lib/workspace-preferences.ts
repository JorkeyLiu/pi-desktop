/**
 * Launch-time workspace preferences.
 *
 * These keys describe the workspace and session the app reopens on the next
 * launch, so they belong to workspace restoration rather than to the sidebar's
 * own display preferences. Storage stays best effort: an unavailable or invalid
 * value must never block startup.
 */

export const LAST_SELECTED_SESSION_KEY = "pi.desktop.lastSelectedSessionId";
export function loadLastSelectedSession(): string | undefined {
  const value = read(LAST_SELECTED_SESSION_KEY);
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function saveLastSelectedSession(sessionId: string): void {
  write(LAST_SELECTED_SESSION_KEY, sessionId);
}

export function clearLastSelectedSession(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(LAST_SELECTED_SESSION_KEY);
  } catch {
    // Preferences are best effort and must never block the app.
  }
}

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}
function read(key: string): unknown {
  const store = storage();
  if (!store) return undefined;
  try {
    const value = store.getItem(key);
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}
function write(key: string, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Preferences are best effort and must never block the app.
  }
}
