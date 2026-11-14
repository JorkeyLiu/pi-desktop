import type { SessionHistoryScope } from "./types/sessions.js";

/**
 * The one history-scope contract shared by the renderer API surface, Electron
 * IPC forwarding, and the remote/native fallbacks.
 *
 * A read without a scope keeps the legacy meaning: the whole physical
 * transcript of the session. A scoped read selects the records of one
 * presentation scope — the main transcript's own top-level rows, or the child
 * rows of one delegation chain — so a history page never has to carry a
 * delegate's detail to render the main conversation, and a delegate's detail
 * never depends on the main transcript's viewport.
 */
export const MAIN_HISTORY_SCOPE: SessionHistoryScope = Object.freeze({ kind: "main" });

/** Stable delegation scope for one task chain identity. */
export function delegationHistoryScope(id: string): SessionHistoryScope {
  return { kind: "delegation", id };
}

const MAX_SCOPE_ID_LENGTH = 512;

/**
 * Normalize a scope arriving from untrusted input (renderer IPC, a plugin, a
 * remote host). An invalid scope resolves to `undefined`, which is the legacy
 * full-transcript meaning: never a silently filtered runtime transcript.
 */
export function normalizeSessionHistoryScope(
  value: unknown,
): SessionHistoryScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "main") return MAIN_HISTORY_SCOPE;
  if (kind !== "delegation") return undefined;
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > MAX_SCOPE_ID_LENGTH) return undefined;
  return { kind: "delegation", id: trimmed };
}

/** Whether two scopes name the same reading range. */
export function sameHistoryScope(
  left: SessionHistoryScope | undefined,
  right: SessionHistoryScope | undefined,
): boolean {
  if (!left || !right) return left === right;
  // Ordinary `||` does not narrow, so compare the kinds before using an id.
  if (left.kind === "main" || right.kind === "main") return left.kind === right.kind;
  return left.id === right.id;
}
