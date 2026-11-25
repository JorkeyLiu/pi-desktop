import type { RemoteHostsBoot } from "../bootstrap/remote-hosts";
import type { ToolCallCancellation, ToolCancellationRegistry } from "../runtime/tool-cancellations";

export type RemoteWorkspaceToolRequest = {
  requestId: string;
  sessionId: string;
  /**
   * Runtime turn identity of the call, forwarded unchanged from the host.
   * It is correlation and attribution only: dispatch never waits for a live
   * turn, so an absent id, or one whose turn already ended, changes nothing.
   */
  turnId?: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  remoteWorkspace: { hostKey: string; path: string };
  timeoutMs?: number;
  expectedCommandShellId?: string;
  expectedCommandShellDialect?: string;
};

type HostReply = { call(method: string, params: Record<string, unknown>): Promise<unknown> };
type Dependencies = {
  getBoot: () => RemoteHostsBoot | null;
  isCurrent: () => boolean;
  /**
   * The one cancellation fact for this call. It is the same registry that
   * receives `tools.aborted` from the host, so a stop and a remote dispatch
   * never disagree. The relay adds no authority: it can only stop the exact
   * `(sessionId, toolCallId)` the runtime already cancelled.
   */
  cancellations: ToolCancellationRegistry;
  log: (message: string, error: unknown) => void;
};

type ActiveCall = {
  request: RemoteWorkspaceToolRequest;
  cancellation: ToolCallCancellation | undefined;
  aborted: boolean;
  abortSent: boolean;
};

const abortedError = (message: string) =>
  Object.assign(new Error(message), { errorCode: "TOOL_ABORTED" });

/** Local permission admission precedes this relay. No models or credentials cross it. */
export function createRemoteWorkspaceToolRelay(host: HostReply, deps: Dependencies) {
  const active = new Map<string, ActiveCall>();
  const keyFor = (request: Pick<RemoteWorkspaceToolRequest, "sessionId" | "toolCallId">) =>
    JSON.stringify([request.sessionId, request.toolCallId]);
  const failure = (error: unknown) => ({
    ok: false,
    isError: true,
    errorCode: error && typeof error === "object" && "errorCode" in error && typeof error.errorCode === "string"
      ? error.errorCode : "REMOTE_TOOL_FAILED",
    content: { error: error instanceof Error ? error.message : String(error) },
  });
  const abort = async (request: RemoteWorkspaceToolRequest) => {
    await deps.getBoot()?.abortWorkspaceTool({ hostKey: request.remoteWorkspace.hostKey,
      sessionId: request.sessionId, toolCallId: request.toolCallId });
  };
  return {
    async execute(request: RemoteWorkspaceToolRequest) {
      const key = keyFor(request);
      let result: unknown;
      let entry: ActiveCall | undefined;
      try {
        if (!deps.isCurrent()) throw abortedError("remote tool host generation was replaced");
        // Refuse a second request for the same call before taking any record:
        // the admitted call keeps owning its cancellation.
        if (active.has(key)) throw new Error("duplicate remote tool dispatch");
        const boot = deps.getBoot();
        if (!boot) throw new Error("remote host is unavailable");
        // A consumed tombstone means the user already cancelled this call
        // before the host reached this relay; nothing may start.
        const cancellation = deps.cancellations.begin(request.sessionId, request.toolCallId);
        if (cancellation?.aborted) {
          cancellation.dispose();
          throw abortedError("remote tool call was cancelled before dispatch");
        }
        const current: ActiveCall = { request, cancellation, aborted: false, abortSent: false };
        const onAbort = () => {
          if (!current.abortSent) {
            current.abortSent = true;
            current.aborted = true;
            void abort(request).catch((error) => deps.log("remote tool cancellation failed", error));
            return;
          }
          current.aborted = true;
        };
        cancellation?.signal.addEventListener("abort", onAbort, { once: true });
        active.set(key, current);
        entry = current;
        try {
          result = await boot.executeWorkspaceTool({
            ...request.remoteWorkspace,
            sessionId: request.sessionId,
            ...(typeof request.turnId === "string" ? { turnId: request.turnId } : {}),
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            args: request.args,
            ...(typeof request.timeoutMs === "number" ? { timeoutMs: request.timeoutMs } : {}),
            ...(request.expectedCommandShellId ? { expectedCommandShellId: request.expectedCommandShellId } : {}),
            ...(request.expectedCommandShellDialect ? { expectedCommandShellDialect: request.expectedCommandShellDialect } : {}),
          });
        } finally {
          cancellation?.signal.removeEventListener("abort", onAbort);
        }
        if (!deps.isCurrent() || current.aborted) {
          throw abortedError("remote tool call was cancelled");
        }
      } catch (error) {
        // A cancellation settles as TOOL_ABORTED even when the remote await
        // failed because of it: the user's stop already decided this call,
        // and the runtime must not spend a mutation-recovery budget on it.
        result = failure(entry?.aborted ? abortedError("remote tool call was cancelled") : error);
      } finally {
        if (entry) {
          // Cleanup is bound to this exact registration: a replacement call
          // for the same pair must never be removed by a stale one.
          if (active.get(key) === entry) active.delete(key);
          entry.cancellation?.dispose();
        }
      }
      // A previous host generation never answers for a call its successor owns.
      if (!deps.isCurrent()) return;
      try { await host.call("tools.remoteComplete", { requestId: request.requestId, result }); }
      catch (error) { deps.log("remote tool completion failed", error); }
    },
    cancel(input: { sessionId: string; toolCallId: string }) {
      // Cancellation is recorded on the call's own identity whether or not the
      // host has reached this relay yet: an active call is aborted, and an
      // earlier stop leaves a bounded tombstone that refuses a late start.
      deps.cancellations.noteAbort(input.sessionId, input.toolCallId);
    },
    dispose() {
      for (const entry of [...active.values()]) {
        entry.aborted = true;
        deps.cancellations.noteAbort(entry.request.sessionId, entry.request.toolCallId);
      }
    },
  };
}
