import type { AppSettings } from "@pi-desktop/shared";

type WakeupPatch = NonNullable<AppSettings["subagentWakeup"]>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Shallow patch with an atomic `subagentWakeup` replace.
 *
 * The wakeup section is ONE setting (`{kind, value?}`): a delta replaces the
 * whole section so a prior unit can never leak into a newly selected kind
 * (e.g. seconds persisted as tool calls). Unrelated top-level settings are
 * preserved; `subagentWakeup` itself is never field-merged.
 */
export function mergeSettingsPatch(
  current: AppSettings,
  patch: Partial<AppSettings>,
): AppSettings {
  const patchWake = asRecord(
    (patch as { subagentWakeup?: unknown }).subagentWakeup,
  );
  if (!patchWake) return { ...current, ...patch };
  return {
    ...current,
    ...patch,
    subagentWakeup: { ...patchWake } as WakeupPatch,
  };
}

/** Promise chain that serializes async saves without dropping rejections. */
export function createSerializedSaver(): {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
} {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * Resolve a numeric wake draft for one kind.
 * Blank or non-numeric input reverts to the current resolved value and never
 * saves. Valid input clamps into [minimum, maximum].
 */
export function resolveWakeValueCommit(
  draft: string,
  resolvedValue: number | null | undefined,
  minimum: number,
  maximum: number,
): { action: "save"; next: number } | { action: "revert"; draft: string } {
  const trimmed = draft.trim();
  if (trimmed === "") {
    return {
      action: "revert",
      draft: resolvedValue != null ? String(resolvedValue) : "",
    };
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return {
      action: "revert",
      draft: resolvedValue != null ? String(resolvedValue) : "",
    };
  }
  const next = Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
  return { action: "save", next };
}

/**
 * Resolve a time-heartbeat draft without the 1-second surprise (F1).
 * Blank or non-numeric input reverts to the current resolved value and never
 * saves, matching the other kinds.
 *
 * @deprecated Use `resolveWakeValueCommit`; kept for callers not yet migrated.
 */
export function resolveWakeTimeCommit(
  draft: string,
  resolvedTimeSeconds: number | null,
  minimum: number,
  maximum: number,
): { action: "save"; next: number } | { action: "revert"; draft: string } {
  return resolveWakeValueCommit(draft, resolvedTimeSeconds, minimum, maximum);
}
