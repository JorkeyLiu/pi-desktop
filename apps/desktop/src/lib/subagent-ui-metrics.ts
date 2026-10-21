/**
 * Presentation of a subagent's own figures on the chat surfaces (the child card
 * and the composer's running-subagent dock).
 *
 * This is UI vocabulary only. The runtime's own strings are untouched: the
 * model-facing lines (`formatSubagentMetricsLine`) keep their compact
 * `turns/tool calls/ctx/spent` form for topology nodes and headers, while a
 * card or a dock row reads `Turns 1 · Tool calls 2 · Context 12K · Spent 3.4K`
 * in the user's language, with the same centred `·` between every boundary and
 * the same order on both surfaces. Every figure is stated as a label and its
 * value, never as a value with a trailing unit, so the line parses the same way
 * in a language whose unit follows the number and one whose label leads.
 *
 * The four slots are not conditional. A figure the runtime reported is stated,
 * including a reported zero; a figure it never reported — or reported as
 * something that is not a non-negative count — keeps the labelled dash instead
 * of being invented as a zero. So every card and every dock row holds exactly
 * turns, tool calls, context and spend, in that order: the line never appears
 * or disappears as a child reports, two surfaces listing the same child state
 * the same four figures, and neither surface changes height from one child to
 * the next.
 */

/** The separator between two pieces of child information, on every surface. */
export const SUBAGENT_INFO_SEPARATOR = " · ";

/** The dash a slot keeps when the child reported no figure for it. */
export const SUBAGENT_METRIC_ABSENT = "—";

/** A translator as `react-i18next`'s `t` resolves through the app catalogs. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The figures one child reported for itself: its own counters, the occupancy
 * of its own window, and its own cumulative spend. Never the parent's.
 */
export type SubagentInfoMetrics = {
  turns?: number;
  toolCalls?: number;
  /** Occupancy of the child's window; absent means "not reported". */
  contextTokens?: number;
  contextEstimated?: boolean;
  /** Cumulative billed spend; `totalTokens` is the figure the row states. */
  usage?: { totalTokens?: number } | undefined;
};

/**
 * Join the parts of one information line with the shared separator.
 *
 * Empty parts are dropped so a line never starts, ends or doubles a separator,
 * which is what produced the old `Running·` fragment on the dock.
 */
export function joinSubagentInfo(
  parts: ReadonlyArray<string | null | undefined | false>,
): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(SUBAGENT_INFO_SEPARATOR);
}

/**
 * A figure the runtime actually reported, or `undefined` when the value is not
 * a non-negative finite count. A reported zero is a report; anything else is
 * not, and the slot keeps its labelled dash for it.
 */
function reportedValue(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** One slot: its localized label with the formatted figure, or the labelled dash. */
function figurePart(
  label: string,
  value: number | undefined,
  language: string,
  format: (value: number, language: string) => string,
  suffix = "",
): string {
  const reported = reportedValue(value);
  return reported === undefined
    ? `${label} ${SUBAGENT_METRIC_ABSENT}`
    : `${label} ${format(reported, language)}${suffix}`;
}

/**
 * One child's reported figures, localized and in a fixed order: turns, tool
 * calls, context occupancy, then total spend. Both the card and the dock print
 * exactly these four slots, so the same report cannot read two ways and neither
 * surface can state a different number of figures than the other.
 */
export function subagentMetricsParts(
  metrics: SubagentInfoMetrics | null | undefined,
  t: Translate,
  language: string,
): string[] {
  // An estimate marks a figure that was reported; the dash estimates nothing.
  const estimated =
    reportedValue(metrics?.contextTokens) !== undefined && metrics?.contextEstimated
      ? ` ${t("chat.subagentMetricsEstimated")}`
      : "";
  return [
    figurePart(
      t("chat.subagentMetricsTurnsLabel"),
      metrics?.turns,
      language,
      formatCount,
    ),
    figurePart(
      t("chat.subagentMetricsCallsLabel"),
      metrics?.toolCalls,
      language,
      formatCount,
    ),
    // Occupancy of the child's own window, never a sum of spend.
    figurePart(
      t("chat.subagentMetricsContextLabel"),
      metrics?.contextTokens,
      language,
      formatCompactTokens,
      estimated,
    ),
    // Spend is cumulative billed tokens, never the occupancy above it.
    figurePart(
      t("chat.subagentMetricsSpendLabel"),
      metrics?.usage?.totalTokens,
      language,
      formatCompactTokens,
    ),
  ];
}

/**
 * One child's figures as a single localized line. The line always holds the
 * four labelled slots, so it is never empty and never changes shape.
 */
export function subagentMetricsLine(
  metrics: SubagentInfoMetrics | null | undefined,
  t: Translate,
  language: string,
): string {
  return joinSubagentInfo(subagentMetricsParts(metrics, t, language));
}

/**
 * The child's state as an ordered pair: the localized outcome, then its
 * runtime. The separator is added by the caller's join, so an inline line never
 * runs the two together and a missing duration leaves no trailing dot.
 */
export function subagentStateParts({
  status,
  duration,
}: {
  status: string;
  duration?: string;
}): string[] {
  return duration ? [status, duration] : [status];
}

/** Thousands-grouped integer count, in the reader's locale. */
export function formatCount(value: number, language: string): string {
  try {
    return new Intl.NumberFormat(language || undefined).format(value);
  } catch {
    return `${value}`;
  }
}

/** Compact token figure (41.2K), in the reader's locale. */
export function formatCompactTokens(value: number, language: string): string {
  try {
    return new Intl.NumberFormat(language || undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return `${value}`;
  }
}
