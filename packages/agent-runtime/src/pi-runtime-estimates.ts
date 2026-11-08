import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  calculateContextTokens,
  estimateMessageTokens as estimateProviderMessageTokens,
  getLastAssistantUsageInfo,
} from "@earendil-works/pi-ai/utils/estimate";
import { LocalRequestError } from "@earendil-works/pi-ai";
import { validateHostedSearchMessages } from "@earendil-works/pi-ai/utils/hosted-search";
import type { Api, Message, Model } from "@earendil-works/pi-ai";

/** Keep character caps aligned with pi-ai 1.1.0's text-token estimator. */
export const ESTIMATED_TEXT_CHARS_PER_TOKEN = 3.5;

export type ContextUsageEstimate = {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
};

function textAndImageChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (Reflect.get(block, "type") === "text") {
      const text = Reflect.get(block, "text");
      if (typeof text === "string") chars += text.length;
    } else if (Reflect.get(block, "type") === "image") {
      chars += 4_800;
    }
  }
  return chars;
}

/** Provider messages use pi-ai's estimator; desktop-only rows keep their legacy heuristic. */
export function estimateTokens(
  message: AgentMessage,
  model?: Model<Api>,
): number {
  switch (message.role) {
    case "system":
    case "user":
    case "assistant":
    case "toolResult":
      return estimateProviderMessageTokens(message as unknown as Message, model);
    case "custom":
      return Math.ceil(textAndImageChars((message as { content?: unknown }).content) / 4);
    case "bashExecution": {
      const value = message as { command: string; output: string };
      return Math.ceil((value.command.length + value.output.length) / 4);
    }
    case "branchSummary":
    case "compactionSummary": {
      const summary = (message as { summary?: unknown }).summary;
      return typeof summary === "string" ? Math.ceil(summary.length / 4) : 0;
    }
    default:
      throw new LocalRequestError("context-validation");
  }
}

/** Preserve the provider-usage anchor, estimating only messages after it. */
export function estimateContextTokens(
  messages: AgentMessage[],
  model?: Model<Api>,
): ContextUsageEstimate {
  const providerMessages: Message[] = [];
  const providerMessageIndices: number[] = [];
  messages.forEach((message, index) => {
    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "toolResult"
    ) return;
    providerMessages.push(message as Message);
    providerMessageIndices.push(index);
  });
  validateHostedSearchMessages(providerMessages);
  const usageInfo = getLastAssistantUsageInfo(providerMessages);
  if (!usageInfo) {
    const tokens = messages.reduce((sum, message) => sum + estimateTokens(message, model), 0);
    return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
  }
  const lastUsageIndex = providerMessageIndices[usageInfo.index]!;
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let index = lastUsageIndex + 1; index < messages.length; index++) {
    trailingTokens += estimateTokens(messages[index]!, model);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex,
  };
}

/**
 * Estimate for the committed transcript plus the assistant row pi is still
 * streaming.
 *
 * The in-flight row must not be read as a usage anchor. A provider reports
 * usage before the body arrives — Anthropic sets input tokens at
 * `message_start` — and pi leaves `stopReason: "pending"` on that row until the
 * message stops, which `getLastAssistantUsageInfo` accepts. Anchoring on it
 * would freeze the estimate at the tokens reported before the body started
 * arriving and never charge the streamed content, so the anchor stays the last
 * committed one and the live row is charged as trailing content.
 *
 * Committed usage is untouched: once the row commits, its settled usage is the
 * anchor exactly as before.
 */
export function estimateLiveContextTokens(
  committed: AgentMessage[],
  live: AgentMessage | undefined,
  model?: Model<Api>,
): ContextUsageEstimate {
  const estimate = estimateContextTokens(committed, model);
  if (!live) return estimate;
  const liveTokens = estimateTokens(live, model);
  return {
    tokens: estimate.tokens + liveTokens,
    usageTokens: estimate.usageTokens,
    trailingTokens: estimate.trailingTokens + liveTokens,
    lastUsageIndex: estimate.lastUsageIndex,
  };
}
