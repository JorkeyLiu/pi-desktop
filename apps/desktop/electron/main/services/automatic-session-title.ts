import type { AppSettings } from "@pi-desktop/shared";
import type { Logger } from "../logger";
import type { OneShotCompletionInput } from "./one-shot-completion-service";

export const MAX_TITLE_PROMPT_CHARS = 4_000;
export const MAX_GENERATED_TITLE_CHARS = 72;
const TITLE_TIMEOUT_MS = 12_000;

export function cleanGeneratedSessionTitle(value: string): string | null {
  const cleaned = value.replace(/^\s*```[^\n]*\n?/u, "").replace(/\n?```\s*$/u, "")
    .replace(/^\s*(?:title|session title)\s*:\s*/iu, "").replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ").replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, "").trim();
  const title = [...cleaned].slice(0, MAX_GENERATED_TITLE_CHARS).join("").trim();
  return title || null;
}

export function createAutomaticSessionTitleService(dependencies: {
  getSettings: () => Promise<AppSettings | null>;
  complete: (input: OneShotCompletionInput) => Promise<{ text: string }>;
  logger: Pick<Logger, "app">;
  setAutomaticTitle: (input: { id: string; expectedTitle: string; title: string }) => Promise<{ updated: boolean }>;
}) {
  const active = new Set<string>();
  return async function generate(input: { sessionId: string; prompt: string; expectedTitle: string; source?: string }): Promise<void> {
    if (!input.sessionId || input.source === "remote" || input.source === "pi-native" || active.has(input.sessionId)) return;
    const prompt = input.prompt.slice(0, MAX_TITLE_PROMPT_CHARS).trim();
    if (!prompt) return;
    const settings = await dependencies.getSettings();
    const providerId = settings?.fastModelProviderId ?? undefined;
    const modelId = settings?.fastModelId ?? undefined;
    if (!providerId || !modelId || active.has(input.sessionId)) return;
    active.add(input.sessionId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
    try {
      const result = await dependencies.complete({
        sessionId: `title:${input.sessionId}`, providerId, modelId,
        context: {
          systemPrompt: "Create a concise title for the user's first request. Return only a short title in the same language.",
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        thinkingLevel: "off", signal: controller.signal,
      });
      const title = cleanGeneratedSessionTitle(result.text);
      if (!title || controller.signal.aborted) return;
      await dependencies.setAutomaticTitle({ id: input.sessionId, expectedTitle: input.expectedTitle, title });
    } catch (error) {
      dependencies.logger.app("session", "warn", "automatic session title generation failed", {
        sessionId: input.sessionId,
        code: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      });
    } finally {
      clearTimeout(timer);
      active.delete(input.sessionId);
    }
  };
}
