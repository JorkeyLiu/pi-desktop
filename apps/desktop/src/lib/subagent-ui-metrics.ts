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
 * Only what the runtime reported is stated. A counter that was never sent is
 * omitted rather than printed as a zero, and an occupancy the runtime never
 * reported keeps the panel's labelled dash instead of a made-up number.
 */

/** The separator between two pieces of child information, on every surface. */
export const SUBAGENT_INFO_SEPARATOR = " · ";

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
 * One child's reported figures, localized and in a fixed order: turns, tool
 * calls, context occupancy, then total spend. Both the card and the dock print
 * exactly this, so the same report cannot read two ways.
 */
export function subagentMetricsParts(
  metrics: SubagentInfoMetrics | null | undefined,
  t: Translate,
  language: string,
): string[] {
  if (!metrics) return [];
  const parts: string[] = [];
  const turns = metrics.turns ?? 0;
  const toolCalls = metrics.toolCalls ?? 0;
  const counted = turns > 0 || toolCalls > 0;
  if (turns > 0) {
    parts.push(
      `${t("chat.subagentMetricsTurnsLabel")} ${formatCount(turns, language)}`,
    );
  }
  if (toolCalls > 0) {
    parts.push(
      `${t("chat.subagentMetricsCallsLabel")} ${formatCount(toolCalls, language)}`,
    );
  }
  // Occupancy first: a child that reported no occupancy keeps the labelled dash
  // the chain panel shows, and a child that reported counters only still gets
  // the label rather than a silent gap.
  if (metrics.contextTokens !== undefined) {
    const estimated = metrics.contextEstimated
      ? ` ${t("chat.subagentMetricsEstimated")}`
      : "";
    parts.push(
      `${t("chat.subagentMetricsContextLabel")} ${formatCompactTokens(metrics.contextTokens, language)}${estimated}`,
    );
  } else if (counted) {
    parts.push(`${t("chat.subagentMetricsContextLabel")} —`);
  }
  // Spend is cumulative billed tokens, never the occupancy above it.
  const total = metrics.usage?.totalTokens;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) {
    parts.push(
      `${t("chat.subagentMetricsSpendLabel")} ${formatCompactTokens(total, language)}`,
    );
  }
  return parts;
}

/** One child's figures as a single localized line, or `""` when it reported none. */
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
