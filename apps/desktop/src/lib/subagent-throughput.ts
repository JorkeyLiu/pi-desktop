import type { UiMessage } from "@pi-desktop/shared";

export type SubagentThroughput = {
  tokens: number;
  durationMs: number;
  samples: number;
  estimated: boolean;
  tokensPerSecond: number | null;
};

type Sample = {
  tokens: number;
  durationMs: number;
  estimated: boolean;
};

function isValidDuration(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function providerOutputTokens(message: UiMessage): number | undefined {
  const value = message.usage?.outputTokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Output tokens for one settled assistant turn, plus whether the figure is an
 * estimate.
 *
 * The runtime writes `responseOutputTokens` only for an interrupted stream
 * whose provider usage carried no positive output count, so its presence means
 * the provider count is unusable and the estimate wins (a provider `0` there
 * is a placeholder, not a measurement). A provider count is preferred
 * otherwise — including a real `0` from a completed response with no estimate.
 * The wait, tool, and `responseDurationMs` fields never contribute.
 */
function outputFor(message: UiMessage): { tokens: number; estimated: boolean } | null {
  const provider = providerOutputTokens(message);
  const fallback = message.responseOutputTokens;
  const estimate =
    typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0
      ? fallback
      : undefined;
  if (estimate !== undefined && (provider === undefined || provider <= 0)) {
    return { tokens: estimate, estimated: true };
  }
  return provider === undefined ? null : { tokens: provider, estimated: false };
}

function sampleFor(message: UiMessage): Sample | null {
  const durationMs = message.modelStreamDurationMs;
  if (!isValidDuration(durationMs)) return null;
  const output = outputFor(message);
  return output ? { ...output, durationMs } : null;
}

/**
 * Source assistant rows of the selected delegate chain, keyed by message id so
 * a repeated id (live update plus hydrated copy, or a replayed page) counts
 * once. The latest settled representation wins: an earlier stale row never
 * resurrects after a later settled row superseded it, and nested delegates,
 * unrelated children, in-flight rows, and incomplete data are not samples.
 */
function selectedSamples(
  messages: readonly UiMessage[],
  chainCallIds: ReadonlySet<string>,
): UiMessage[] {
  const latest = new Map<string, UiMessage>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (message.status !== "complete" && message.status !== "aborted") continue;
    // A nested delegate reports through its own immediate tool call; it is
    // never part of this delegate's own model stream, even when the owning
    // Task call sits in the selected chain.
    if (message.nestedParentToolCallId) continue;
    const callId = message.parentToolCallId;
    if (!callId || !chainCallIds.has(callId)) continue;
    latest.set(message.id, message);
  }
  return [...latest.values()];
}

/** Aggregate settled direct-child model responses across a resume chain. */
export function aggregateSubagentThroughput(
  messages: readonly UiMessage[],
  chainCallIds: ReadonlySet<string>,
): SubagentThroughput {
  let tokens = 0;
  let durationMs = 0;
  let samples = 0;
  let estimated = false;

  for (const message of selectedSamples(messages, chainCallIds)) {
    const sample = sampleFor(message);
    if (!sample) continue;
    tokens += sample.tokens;
    durationMs += sample.durationMs;
    samples += 1;
    estimated ||= sample.estimated;
  }

  return {
    tokens,
    durationMs,
    samples,
    estimated,
    tokensPerSecond: samples > 0 && durationMs > 0 ? tokens / (durationMs / 1000) : null,
  };
}
