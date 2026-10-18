/**
 * Subagent wakeup: the single configurable condition under which a waiting
 * parent is told about delegate progress (ADR 0089 follow-up, single-kind
 * correction).
 *
 * Canonical shape is one setting, not four independent rows:
 * - `kind: "time"` — periodic heartbeat while delegates run (default 600s).
 * - `kind: "tool-calls"` — wake after each additional N tool calls.
 * - `kind: "context-tokens"` — wake on upward crossing of N tokens.
 * - `kind: "off"` — disable proactive progress checks (the original
 *   "disable progress polling" request). No value.
 *
 * Result delivery is unconditional: whenever a delegate settles, its report
 * wakes the parent. There is no completion toggle. `TaskWait` remains an
 * explicit sync barrier; both `TaskWait` and the idle resume obey the
 * selected progress kind.
 *
 * Backward compatibility: persisted settings written by the previous
 * four-field shape (`timeSeconds` / `onCompletion` / `toolCalls` /
 * `contextTokens`) are migrated at read time to the single kind
 * (context first, then tool calls, then time, then off). `onCompletion` is
 * ignored: result delivery is unconditional.
 */

import type { MessageUsage } from "./types/messages.js";

/** Periodic heartbeat default: the historical `TaskWait` wait. */
export const DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS = 600;
export const MIN_SUBAGENT_WAKEUP_TIME_SECONDS = 1;
export const MAX_SUBAGENT_WAKEUP_TIME_SECONDS = 900;

/** `tool-calls` wakes after each additional N calls; below 1 is meaningless. */
export const MIN_SUBAGENT_WAKEUP_TOOL_CALLS = 1;
export const MAX_SUBAGENT_WAKEUP_TOOL_CALLS = 10_000;
/** Remembered default when switching to the tool-calls kind. */
export const DEFAULT_SUBAGENT_WAKEUP_TOOL_CALLS = 10;

/** `context-tokens` is an occupancy estimate, so the floor stays coarse. */
export const MIN_SUBAGENT_WAKEUP_CONTEXT_TOKENS = 1_000;
export const MAX_SUBAGENT_WAKEUP_CONTEXT_TOKENS = 1_000_000;
/** Remembered default when switching to the context kind. */
export const DEFAULT_SUBAGENT_WAKEUP_CONTEXT_TOKENS = 20_000;

/** The single selectable progress-check kind. */
export type SubagentWakeupKind = "time" | "tool-calls" | "context-tokens" | "off";

/**
 * Canonical wake configuration. `off` carries no value; every other kind
 * requires one (clamped at read time).
 */
export type SubagentWakeupSettings = {
  kind: SubagentWakeupKind;
  value?: number;
};

/** Product default: periodic 600s heartbeat. */
export const DEFAULT_SUBAGENT_WAKEUP_SETTINGS: SubagentWakeupSettings = {
  kind: "time",
  value: DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS,
};

/**
 * Legacy four-field shape written before the single-kind correction.
 * Accepted at read time and migrated; never written by new code.
 */
export type LegacySubagentWakeupSettings = {
  timeSeconds?: number | null;
  onCompletion?: boolean;
  toolCalls?: number | null;
  contextTokens?: number | null;
};

/** Stored or incoming wakeup: canonical or legacy (migration path). */
export type AnySubagentWakeupInput = SubagentWakeupSettings & Partial<LegacySubagentWakeupSettings>;

/**
 * Wake configuration with every default applied: the single canonical
 * `{kind, value?}`. `off` carries no value.
 */
export type ResolvedSubagentWakeupSettings = {
  kind: SubagentWakeupKind;
  value?: number;
};

/** Why a wait returned before its outer deadline. */
export type SubagentWakeReason =
  | "time"
  | "completion"
  | "tool-calls"
  | "context-tokens";

/** How a delegation wait settled. */
export type SubagentWaitStatus =
  | "completed"
  | "timeout"
  | "wakeup"
  | "interrupted";

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

/** Per-kind default used when a kind is selected without a valid value. */
export function defaultSubagentWakeupValue(kind: SubagentWakeupKind): number | undefined {
  if (kind === "time") return DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS;
  if (kind === "tool-calls") return DEFAULT_SUBAGENT_WAKEUP_TOOL_CALLS;
  if (kind === "context-tokens") return DEFAULT_SUBAGENT_WAKEUP_CONTEXT_TOKENS;
  return undefined;
}

/** Bounds for one kind: [min, max]. `off` has no bounds. */
export function subagentWakeupBounds(kind: SubagentWakeupKind): readonly [number, number] | null {
  if (kind === "time") return [MIN_SUBAGENT_WAKEUP_TIME_SECONDS, MAX_SUBAGENT_WAKEUP_TIME_SECONDS] as const;
  if (kind === "tool-calls") return [MIN_SUBAGENT_WAKEUP_TOOL_CALLS, MAX_SUBAGENT_WAKEUP_TOOL_CALLS] as const;
  if (kind === "context-tokens")
    return [MIN_SUBAGENT_WAKEUP_CONTEXT_TOKENS, MAX_SUBAGENT_WAKEUP_CONTEXT_TOKENS] as const;
  return null;
}

function clampWakeValue(kind: SubagentWakeupKind, value: number): number {
  const bounds = subagentWakeupBounds(kind);
  if (!bounds) return DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS;
  return clampInt(value, bounds[0], bounds[1]);
}

function productDefault(): ResolvedSubagentWakeupSettings {
  return { kind: "time", value: DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS };
}

function resolvedFromKind(kind: SubagentWakeupKind, value?: number): ResolvedSubagentWakeupSettings {
  if (kind === "off") {
    return { kind: "off" };
  }
  const fallback = defaultSubagentWakeupValue(kind) ?? DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS;
  const next = typeof value === "number" && Number.isFinite(value) ? clampWakeValue(kind, value) : fallback;
  return { kind, value: next };
}

function isWakeupKind(value: unknown): value is SubagentWakeupKind {
  return value === "time" || value === "tool-calls" || value === "context-tokens" || value === "off";
}

/** Migrate a legacy four-field section to the single kind (priority: context → tool → time → off). */
function migrateLegacyWakeup(input: LegacySubagentWakeupSettings): ResolvedSubagentWakeupSettings {
  const contextTokens = input.contextTokens;
  if (typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens >= 1) {
    return { kind: "context-tokens", value: clampWakeValue("context-tokens", contextTokens) };
  }
  const toolCalls = input.toolCalls;
  if (typeof toolCalls === "number" && Number.isFinite(toolCalls) && toolCalls >= 1) {
    return { kind: "tool-calls", value: clampWakeValue("tool-calls", toolCalls) };
  }
  const timeSeconds = input.timeSeconds;
  if (timeSeconds === null) {
    return { kind: "off" };
  }
  if (typeof timeSeconds === "number" && Number.isFinite(timeSeconds)) {
    return { kind: "time", value: clampWakeValue("time", timeSeconds) };
  }
  if (input.timeSeconds === null) return { kind: "off" };
  // Absent/empty legacy section (including a legacy onCompletion-only write)
  // means the historical product default. onCompletion is ignored: result
  // delivery is unconditional.
  return productDefault();
}

/**
 * Apply defaults and bounds. Canonical `{kind, value}` wins when present;
 * otherwise a legacy section migrates (context → tool → time → off).
 * A malformed canonical value falls back to the product default (periodic
 * time), never to a value that would wake on every evaluation.
 * `off` carries no value.
 */
export function normalizeSubagentWakeupSettings(
  input?: SubagentWakeupSettings | LegacySubagentWakeupSettings | AnySubagentWakeupInput | null,
): ResolvedSubagentWakeupSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return productDefault();
  }
  const candidate = input as Record<string, unknown>;
  if (isWakeupKind(candidate.kind)) {
    if (candidate.kind === "off") return { kind: "off" };
    const value = candidate.value;
    if (candidate.kind === "time") {
      // Time clamps into bounds (0 → minimum); non-finite falls back.
      if (typeof value === "number" && Number.isFinite(value)) {
        return { kind: candidate.kind, value: clampWakeValue(candidate.kind, value) };
      }
      return productDefault();
    }
    // Tool/context below one wake unit are meaningless: fall back to the
    // product default rather than clamping up to a wake-on-everything.
    if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
      return { kind: candidate.kind, value: clampWakeValue(candidate.kind, value) };
    }
    return productDefault();
  }
  return migrateLegacyWakeup(candidate as LegacySubagentWakeupSettings);
}

/**
 * One delegate's live progress, as `Task` launch / `TaskList` / `TaskWait` /
 * settlement details and the idle-resume prompt report it.
 *
 * `contextTokens` is the current estimated occupancy of the delegate's model
 * context (an estimate, recomputed from its live messages with the same
 * estimator the compaction budget uses). `usage` is the cumulative billed
 * spend the delegate's provider requests reported, merged by physical
 * operation identity so re-reports and replays never double-charge. The two
 * must not be confused: occupancy says how full the window is, spend says
 * what was billed.
 */
export type SubagentProgressMetrics = {
  toolCalls: number;
  turns: number;
  /** Current estimated context occupancy in tokens, when known. */
  contextTokens?: number;
  /** Cumulative billed usage, ledger-deduped by operation identity. */
  usage?: MessageUsage;
};

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the value is a UUID shaped row/turn identity. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isWakeupNumberOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Shape check for a stored or incoming wakeup section (settings writes, IPC).
 * Accepts the canonical `{kind, value?}` and, for migration, the legacy
 * four-field shape. Types only — range clamping stays with the normalizers
 * so a write that is merely out of range still lands and reads back clamped,
 * while a value of the wrong type is rejected at the boundary.
 */
export function isSubagentWakeupSettings(value: unknown): value is SubagentWakeupSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== undefined) {
    if (!isWakeupKind(candidate.kind)) return false;
    if (candidate.kind === "off") {
      return candidate.value === undefined;
    }
    // Canonical kinds accept an absent value (normalized to the product
    // default) but reject a mistyped one at the boundary.
    if (candidate.value !== undefined && (typeof candidate.value !== "number" || !Number.isFinite(candidate.value))) {
      return false;
    }
    return true;
  }
  for (const key of ["timeSeconds", "toolCalls", "contextTokens"] as const) {
    if (
      candidate[key] !== undefined &&
      !isWakeupNumberOrNull(candidate[key])
    ) {
      return false;
    }
  }
  return (
    candidate.onCompletion === undefined ||
    typeof candidate.onCompletion === "boolean"
  );
}

/** One-line metrics suffix for heartbeats and result headers. */
export function formatSubagentProgressMetrics(
  metrics: Pick<SubagentProgressMetrics, "toolCalls" | "contextTokens" | "usage">,
): string {
  const parts = [`${metrics.toolCalls} tool call${metrics.toolCalls === 1 ? "" : "s"}`];
  if (typeof metrics.contextTokens === "number") {
    parts.push(`ctx ~${compactTokens(metrics.contextTokens)} tokens`);
  }
  if (metrics.usage) {
    parts.push(`spent ${compactTokens(metrics.usage.totalTokens)} tokens`);
  }
  return parts.join(", ");
}
