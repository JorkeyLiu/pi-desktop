import { IPC, type AppSettings } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import { createAutomaticSessionTitleService, MAX_TITLE_PROMPT_CHARS } from "../services/automatic-session-title";
import type { OneShotCompletionInput } from "../services/one-shot-completion-service";
import type { IpcRegistrar } from "./types";

export function registerFastModelTitleIpc(input: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSettings: () => Promise<AppSettings | null>;
  complete: (request: OneShotCompletionInput) => Promise<{ text: string }>;
  logger: Pick<Logger, "app">;
}): void {
  const generate = createAutomaticSessionTitleService({
    getSettings: input.getSettings,
    complete: input.complete,
    logger: input.logger,
    setAutomaticTitle: ({ id, expectedTitle, title }) => {
      const host = input.getHost();
      if (!host) throw new Error("host unavailable");
      return host.call("session.setAutomaticTitle", { id, expectedTitle, title });
    },
  });
  input.registrar.handle(IPC.invoke.sessionTitleGenerate, async (request: unknown) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw Object.assign(new Error("title request is invalid"), { errorCode: "INVALID_ARGUMENT" });
    }
    const value = request as Record<string, unknown>;
    const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
    const prompt = typeof value.prompt === "string" ? value.prompt : "";
    const fallbackTitle = typeof value.fallbackTitle === "string" ? value.fallbackTitle : "";
    if (!sessionId || sessionId.length > 128 || sessionId.startsWith("native-pi:") || !prompt.trim() || prompt.length > MAX_TITLE_PROMPT_CHARS || !fallbackTitle.trim() || fallbackTitle.length > 256) {
      throw Object.assign(new Error("title request is invalid"), { errorCode: "INVALID_ARGUMENT" });
    }
    // Resolve locally stored session source before spending. Remote sessions never
    // reach local credentials; their own host may use the existing fallback path.
    const host = input.getHost();
    if (!host) return { updated: false };
    const result = await host.call<{ session?: { source?: string } }>("session.get", { id: sessionId });
    if (!result.session || result.session.source === "remote" || result.session.source === "pi-native") return { updated: false };
    await generate({ sessionId, prompt, expectedTitle: fallbackTitle, source: result.session.source });
    return { updated: true };
  });
}
