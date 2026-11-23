import { addThroughputTotals } from "@pi-desktop/shared";
import type { GenerationThroughputTotals, UiMessage } from "@pi-desktop/shared";

/**
 * The one session generation-throughput path both the main transcript and
 * every subagent surface share: canonical per-run totals parsed once,
 * folded additively, and rendered through one rate and one format.
 *
 * Nothing here knows about delegations, chains, or the transcript. Callers
 * pass rows (main) or per-run totals (child chains) and get the same answer
 * for the same figures.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function asNonNegativeFinite(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Canonical per-run throughput totals from one report. Every component is
 * validated: a real provider zero survives, while a missing, non-finite, or
 * negative component disqualifies the whole figure — a partial total is not
 * a measurement. Legacy payloads carry no `throughput` and stay absent.
 */
export function parseThroughputTotals(value: unknown): GenerationThroughputTotals | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const tokens = asNonNegativeInt(record.tokens);
  const durationMs = asNonNegativeFinite(record.durationMs);
  const samples = asNonNegativeInt(record.samples);
  if (tokens === undefined || durationMs === undefined || samples === undefined) {
    return undefined;
  }
  return { tokens, durationMs, samples };
}

/**
 * The one average TPS of canonical totals: exact provider output over the
 * summed first-content-to-end spans. `null` when there is no usable figure —
 * no samples, or no positive span — so callers render `—`, never a heuristic
 * estimate and never an invented zero. A real provider zero over a positive
 * span is a genuine `0`, not an absence.
 */
export function throughputPerSecond(
  totals: GenerationThroughputTotals | undefined | null,
): number | null {
  if (!totals) return null;
  if (!Number.isFinite(totals.tokens) || totals.tokens < 0) return null;
  if (!Number.isFinite(totals.samples) || totals.samples <= 0) return null;
  if (!Number.isFinite(totals.durationMs) || !(totals.durationMs > 0)) return null;
  return totals.tokens / (totals.durationMs / 1000);
}

/** Locale-shaped TPS figure: one fractional digit, never a grouping surprise. */
export function formatThroughputRate(value: number, language: string): string {
  try {
    return new Intl.NumberFormat(language || undefined, {
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return `${Math.round(value * 10) / 10}`;
  }
}

/**
 * One session's own generation throughput: every settled complete assistant
 * response this session produced, folded additively. Child-stream rows belong
 * to child sessions and never join the parent's figure; error and aborted rows
 * never contribute. Legacy rows without samples, malformed totals, and an
 * empty session stay absent — never an invented zero.
 */
export type OwnThroughputRow = Pick<
  UiMessage,
  "role" | "parentToolCallId" | "nestedParentToolCallId" | "status" | "throughput"
>;

export function sumOwnSessionThroughput(
  messages: readonly OwnThroughputRow[],
): GenerationThroughputTotals | undefined {
  let folded: GenerationThroughputTotals | undefined;
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    if (message.parentToolCallId || message.nestedParentToolCallId) continue;
    if (message.status === "error" || message.status === "aborted") continue;
    folded = addThroughputTotals(folded, parseThroughputTotals(message.throughput));
  }
  return folded;
}
