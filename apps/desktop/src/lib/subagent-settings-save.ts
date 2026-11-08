import {
  subagentHandoffKTokensToTokens,
  subagentHandoffMinutesToSeconds,
  subagentHandoffSecondsToMinutes,
  subagentHandoffTokensToKTokens,
} from "@pi-desktop/shared";
import type { AppSettings } from "@pi-desktop/shared";

type WakeupPatch = NonNullable<AppSettings["subagentWakeup"]>;
type SelfHandoffPatch = NonNullable<AppSettings["subagentSelfHandoff"]>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Shallow patch with atomic replacement of the Subagent execution sections.
 *
 * `subagentWakeup` and `subagentSelfHandoff` are each ONE setting
 * (`{kind, value?}`): a delta replaces the whole section so a prior unit can
 * never leak into a newly selected kind (seconds persisted as tool calls,
 * minutes persisted as tokens). Unrelated top-level settings are preserved; the
 * two sections are never field-merged.
 */
export function mergeSettingsPatch(
  current: AppSettings,
  patch: Partial<AppSettings>,
): AppSettings {
  const next: AppSettings = { ...current, ...patch };
  const wake = asRecord((patch as { subagentWakeup?: unknown }).subagentWakeup);
  if (wake) next.subagentWakeup = { ...wake } as WakeupPatch;
  const selfHandoff = asRecord(
    (patch as { subagentSelfHandoff?: unknown }).subagentSelfHandoff,
  );
  if (selfHandoff) next.subagentSelfHandoff = { ...selfHandoff } as SelfHandoffPatch;
  return next;
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
 * saves. Valid input clamps into [minimum, maximum] and is rounded onto the
 * granularity the field edits in: `round` defaults to whole units, and the
 * k-token fields pass a token-exact rounding so a stored count that is not a
 * whole thousand keeps its exact figure instead of being rewritten by a blur.
 */
export function resolveWakeValueCommit(
  draft: string,
  resolvedValue: number | null | undefined,
  minimum: number,
  maximum: number,
  round: (value: number) => number = Math.floor,
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
  const next = Math.min(maximum, Math.max(minimum, round(parsed)));
  return { action: "save", next };
}

/**
 * Round a k-token field's figure onto whole tokens.
 *
 * The field edits thousands (`k tokens`) but every stored value is a token
 * count, including values written before the field changed unit. Rounding onto
 * whole tokens keeps such a value exact — 1500 tokens reads as 1.5 and stays
 * 1500 — so opening, leaving, or re-entering the field never rewrites it.
 */
export function roundSubagentKTokens(kTokens: number): number {
  return subagentHandoffTokensToKTokens(
    subagentHandoffKTokensToTokens(kTokens),
  );
}

/**
 * Round a minute field's figure onto whole stored seconds.
 *
 * The time trigger is stored in seconds and edited in minutes, so the display
 * figure is the stored second count divided by 60, kept to two decimals. Going
 * through whole seconds keeps a stored value that is not a whole minute exact —
 * 90 seconds reads as 1.5 and stays 90, and 100 seconds reads as 1.67 and is
 * never silently rewritten to 102 or 96 — so opening, leaving, or re-entering
 * the field never saves a value the user did not type.
 */
export function roundSubagentMinutes(minutes: number): number {
  return Number(
    subagentHandoffSecondsToMinutes(
      subagentHandoffMinutesToSeconds(minutes),
    ).toFixed(2),
  );
}

/**
 * Display rounding for one Subagent execution threshold field.
 *
 * The k-token context trigger keeps whole-token precision and the time trigger
 * keeps whole-second precision, so a stored count that is not a whole display
 * unit survives being shown and committed; every other field edits whole units
 * (calls, minutes of runtime).
 */
export function roundSubagentThresholdValue(
  value: number,
  kind: string,
): number {
  if (kind === "context-tokens") return roundSubagentKTokens(value);
  if (kind === "time") return roundSubagentMinutes(value);
  return Math.floor(value);
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
