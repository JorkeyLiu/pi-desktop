import type { UiMessage } from "@pi-desktop/shared";

/** Conservative visible-content estimate for an interrupted response without provider usage. */
export function estimateVisibleResponseOutputTokens(
  message: Pick<UiMessage, "content" | "thinking">,
): number | undefined {
  const visible = `${message.thinking ?? ""}\n${message.content}`.trim();
  if (!visible) return undefined;
  return Math.max(1, Math.ceil(Array.from(visible).length / 4));
}
