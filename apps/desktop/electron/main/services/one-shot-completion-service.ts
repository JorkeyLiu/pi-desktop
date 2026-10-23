import {
  completeOneShot,
  type RuntimeProviderConfig,
} from "@pi-desktop/agent-runtime";
import type { SessionThinkingLevel, ThinkingLevel } from "@pi-desktop/shared";
import type { Context } from "@earendil-works/pi-ai";
import type { createSessionLaunchRuntime } from "../runtime/session-launch";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
type Launch = Awaited<ReturnType<ReturnType<typeof createSessionLaunchRuntime>["resolveAgentRuntimeLaunch"]>>;

type CompletionSession = Record<string, unknown> | null | undefined;

export type OneShotCompletionInput = {
  sessionId: string;
  providerId: string;
  modelId: string;
  context: Context;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  emptyErrorCode?: string;
  emptyErrorMessage?: string;
};

export function createOneShotCompletionService(dependencies: {
  getHost: () => {
    call<T>(method: string, input?: Record<string, unknown>): Promise<T>;
  } | null;
  resolveAgentRuntimeLaunch: (
    sessionId: string,
    session: CompletionSession,
    settings: unknown,
    overrides: {
      mode: "agent";
      providerId: string;
      modelId: string;
      thinkingLevel?: SessionThinkingLevel;
    },
  ) => Promise<Launch>;
  vendorOAuth: VendorOAuth;
  complete?: typeof completeOneShot;
}) {
  const run = dependencies.complete ?? completeOneShot;

  return async function complete(input: OneShotCompletionInput) {
    const host = dependencies.getHost();
    if (!host) {
      throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    }
    const settings = await host.call<unknown>("settings.get");
    const session = input.sessionId
      ? (await host.call<{ session?: CompletionSession }>("session.get", { id: input.sessionId })).session
      : {};
    const launch = await dependencies.resolveAgentRuntimeLaunch(
      input.sessionId,
      session ?? {},
      settings,
      {
        mode: "agent",
        providerId: input.providerId,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
      },
    );
    const provider: RuntimeProviderConfig = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => dependencies.vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    };
    const result = await run(
      provider,
      input.context,
      launch.sidecarParams.thinkingLevel === "omit" ? "off" : launch.sidecarParams.thinkingLevel,
      {
        signal: input.signal,
        sessionId: input.sessionId,
        ...(input.emptyErrorCode ? { emptyErrorCode: input.emptyErrorCode } : {}),
        ...(input.emptyErrorMessage ? { emptyErrorMessage: input.emptyErrorMessage } : {}),
      },
    );
    return {
      ...result,
      modelKey: `${launch.providerId}/${launch.modelId}`,
      thinkingLevel: launch.sidecarParams.thinkingLevel,
    };
  };
}
