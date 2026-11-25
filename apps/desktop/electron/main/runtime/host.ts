import { ErrorCodes, IPC, type AgentEventEnvelope, type PlanExecutionFinishStatus, type Risk } from "@pi-desktop/shared";
import { assertLinuxGlibcSupported } from "../linux-glibc";
import { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginRuntime } from "../plugin-runtime";
import type { UserMcpRuntime } from "../user-mcp";
import type { RuntimeState } from "./context";
import type { FinishTurn } from "./plans";
import { getActiveRemoteHostsBoot } from "../bootstrap/remote-hosts";
import { createRemoteWorkspaceToolRelay, type RemoteWorkspaceToolRequest } from "../remote/remote-workspace-tools";
import type { ToolCancellationRegistry } from "./tool-cancellations";

export type HostRuntimeDependencies = {
  runtimeState: RuntimeState;
  dataDir: string;
  logger: Logger;
  persistenceOutbox: PersistenceOutbox;
  activeToolCalls: Map<string, any>;
  activeToolCallKey: (sessionId: string, toolCallId: string) => string;
  sessionProjects: Map<string, string | null>;
  plugins: PluginRuntime;
  userMcp: UserMcpRuntime;
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
  sendToRenderer: (channel: string, payload: unknown) => void;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  togglePluginLauncher: () => Promise<void>;
  finishTurn: FinishTurn;
  finishApprovedExecution: (
    executionId: string,
    status: PlanExecutionFinishStatus,
    errorCode?: string,
  ) => Promise<void>;
  /**
   * Per-call cancellation of host-bound tool calls. `tools.aborted` names one
   * concrete call, so main can stop the plugin JS or MCP call it already
   * started for that call. It carries no turn authority and no liveness claim:
   * a call is judged only by its own `(sessionId, toolCallId)`.
   */
  /**
   * Turn gate for the remote-workspace tool relay only: a remote runner request
   * is issued on behalf of a live turn. Plugin and MCP dispatch no longer
   * consult it — those calls are judged by their own per-call identity.
   */
  isTurnDispatchable: (sessionId: string, turnId: string | null | undefined) => boolean;
  toolCancellations: ToolCancellationRegistry;
  /** Identity of the turn a host crash interrupted, captured before teardown. */
  activeTurns: Map<string, string>;
  approvedExecutionIdsBySession: Map<string, string>;
  claimedExecutionSessions: Map<string, string>;
  importLegacyScheduled: () => Promise<unknown>;
  superviseRestart: (kind: "host" | "sidecar") => Promise<void>;
  isQuitting: () => boolean;
  ensureSystemProxyRelay: () => Promise<string>;
};

export function createHostRuntime({
  runtimeState,
  dataDir,
  logger,
  persistenceOutbox,
  activeToolCalls,
  activeToolCallKey,
  sessionProjects,
  plugins,
  userMcp,
  pluginActiveInProject,
  sendToRenderer,
  emitAgentEvent,
  togglePluginLauncher,
  finishTurn,
  isTurnDispatchable,
  toolCancellations,
  finishApprovedExecution,
  activeTurns,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  importLegacyScheduled,
  superviseRestart,
  isQuitting,
  ensureSystemProxyRelay,
}: HostRuntimeDependencies): {
  wireHost: (host: HostProcess) => void;
  startHost: () => Promise<void>;
} {
  /**
   * Stop the agent runs whose turn belonged to the host process that just died.
   *
   * host-core gives up every running turn when it boots. A checklist write from
   * such a turn still lands, but the run itself lives in the sidecar, which
   * survives a host restart, and nothing else would ever tell it to stop — it
   * keeps executing a turn the host no longer has, spending tokens on a round
   * nobody is reading, and its session stays busy so the next prompt is refused.
   * The owner of the host process therefore settles it here, the way the sidecar
   * crash path settles its own dead runs, with the identity captured before the
   * first await because a newer turn may own the session by the time this
   * unwinds.
   *
   * The settlement is claimed before the stop request leaves: the stop makes the
   * run emit its own terminal event, and that event must join this abort instead
   * of closing the turn as completed. Nothing is revived or retried — the durable
   * row already ended as aborted inside the replacement host.
   */
  const settleTurnsInterruptedByHostExit = (skip: ReadonlySet<string>) => {
    const sidecar = runtimeState.sidecar;
    for (const [sessionId, turnId] of [...activeTurns]) {
      if (skip.has(sessionId)) continue;
      finishTurn(sessionId, "aborted", "TURN_ABORTED", { turnId }).catch((error: unknown) => {
        logger.app("runtime", "warn", "turn finalization failed after host exit", {
          sessionId,
          data: String(error),
        });
      });
      if (!sidecar) continue;
      // A run that already ended, and a turn that moved on, are refused by the
      // sidecar's own identity check, so this can never stop a newer turn.
      void sidecar.call("agent.abort", { sessionId, turnId }).catch((error: unknown) => {
        logger.app("runtime", "warn", "interrupted turn was not stopped in the agent sidecar", {
          sessionId,
          data: String(error),
        });
      });
    }
  };

  /**
   * A cancelled or refused call keeps its protocol code on every dispatch
   * path: plugin runtime errors carry `code`, and an MCP rejection carries
   * either `code` (the client's own errors) or `errorCode` (its host services).
   * Anything else is an ordinary failure, which each caller maps on its own.
   */
  const toolRefusalCode = (error: unknown): "TOOL_ABORTED" | "PERMISSION_DENIED" | undefined => {
    if (!error || typeof error !== "object") return undefined;
    const declared =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "errorCode" in error && typeof (error as { errorCode?: unknown }).errorCode === "string"
          ? (error as { errorCode: string }).errorCode
          : undefined;
    return declared === "TOOL_ABORTED" || declared === "PERMISSION_DENIED" ? declared : undefined;
  };

  const wireHost = (h: HostProcess) => {
  const remoteTools = createRemoteWorkspaceToolRelay(h, {
    getBoot: getActiveRemoteHostsBoot,
    isCurrent: () => runtimeState.host === h,
    isTurnDispatchable: (sessionId, turnId) => isTurnDispatchable(sessionId, turnId),
    log: (message, error) => logger.app("diagnostics", "warn", message, { data: String(error) }),
  });

  h.onNotification((method, params) => {
    // Notifications from a previous host generation must never reach the
    // current plugin/renderer bridge after a restart.
    if (runtimeState.host !== h) return;
    if (method === "tools.remoteExecute") {
      void remoteTools.execute(params as RemoteWorkspaceToolRequest);
      return;
    }
    if (method === "tools.remoteAbort") {
      remoteTools.cancel(params as { sessionId: string; toolCallId: string });
      return;
    }
    // The host cancelled one concrete tool call. Main may own the side effect
    // (plugin JS or an MCP call), so the report is relayed to the per-call
    // registry; it addresses that call only.
    if (method === "tools.aborted") {
      const cancelled = params as { sessionId?: string; toolCallId?: string };
      toolCancellations.noteAbort(cancelled.sessionId, cancelled.toolCallId);
      return;
    }
    // An install reports itself, so the dialog that shows it can follow the
    // phases, the mirror being tried and the bytes that have arrived. Nothing
    // here decides anything: the request's own answer is still the outcome.
    if (method === "plugin.installProgress") {
      sendToRenderer(IPC.event.pluginInstallProgress, params);
      return;
    }
    if (method === "permissions.request") {
      const permission = params as {
        requestId: string;
        sessionId: string;
        toolCallId: string;
        toolName: string;
        argsPreview: string;
        risk: Risk;
        reason: string;
      };
      // A delegate's call is already in `activeToolCalls` by the time the host
      // asks: the sidecar forwards `tool_start` before it executes the tool.
      // Without this the dialog would attribute a delegate's write to the main
      // agent, which is the one thing the user must not be confused about.
      const asking = activeToolCalls.get(
        activeToolCallKey(
          permission.sessionId,
          permission.toolCallId,
        ),
      );
      logger.app("permission", "info", "permission requested", {
        requestId: permission.requestId,
        sessionId: permission.sessionId,
        turnId: asking?.turnId,
        toolCallId: permission.toolCallId,
        parentToolCallId: asking?.parentToolCallId,
        agentName: asking?.agentName,
        data: {
          toolName: permission.toolName,
          risk: permission.risk,
          reason: permission.reason,
        },
      });
      const envelope: AgentEventEnvelope = {
        sessionId: permission.sessionId,
        ts: Date.now(),
        event: {
          type: "tool_permission_request",
          request: {
            requestId: permission.requestId,
            sessionId: permission.sessionId,
            toolCallId: permission.toolCallId,
            toolName: permission.toolName,
            argsPreview: permission.argsPreview,
            risk: permission.risk,
            reason: permission.reason,
            ...(asking?.agentName ? { agentName: asking.agentName } : {}),
            ...(asking?.parentToolCallId
              ? { parentToolCallId: asking.parentToolCallId }
              : {}),
            ...(asking?.nestedParentToolCallId
              ? { nestedParentToolCallId: asking.nestedParentToolCallId }
              : {}),
          },
        },
      };
      emitAgentEvent(envelope);
    } else if (method === "plugins.execute") {
      void (async () => {
        const q = params as {
          executionId: string;
          sessionId?: string;
          /**
           * Runtime turn identity of the tool call, forwarded unchanged from the
           * host so a plugin receives the same identity `session:turnEnded`
           * carries. Dispatch never depends on it: the call is judged by its own
           * `(sessionId, toolCallId)`, so an absent turn id changes nothing.
           */
          turnId?: string;
          toolCallId?: string;
          toolName: string;
          args: unknown;
          mode?: string;
        };
        const projectPath = q.sessionId
          ? (sessionProjects.get(q.sessionId) ?? null)
          : null;
        const tool = plugins.getTools().find((t) => t.fullName === q.toolName);
        // One cancellation record for this concrete call. The host registered
        // the call before asking, so a `tools.abort` that already happened left
        // a tombstone this consumes — the call is refused instead of starting
        // late — while a later abort reaches this exact call and nothing else.
        const call = toolCancellations.begin(q.sessionId, q.toolCallId);
        let payload: Record<string, unknown> | undefined;
        try {
          // Cancelled before this handler ran: the host already settled the
          // call, so nothing may start and nothing may be answered.
          if (call?.aborted) return;
          if (q.toolName.startsWith("mcp_")) {
            try {
              const result = await userMcp.callTool(
                q.toolName,
                q.args,
                projectPath,
                q.sessionId,
                call?.signal,
              );
              payload = { executionId: q.executionId, ok: true, content: result ?? null };
            } catch (e) {
              // A cancelled call is settled by the host; main must not answer.
              if (call?.aborted) return;
              payload = {
                executionId: q.executionId,
                ok: false,
                errorCode:
                  toolRefusalCode(e) ?? (e as { errorCode?: string })?.errorCode ?? "TOOL_FAILED",
                content: { error: e instanceof Error ? e.message : String(e) },
              };
            }
          } else if (!tool) {
            payload = {
              executionId: q.executionId,
              ok: false,
              errorCode: "TOOL_NOT_FOUND",
              content: { error: `plugin tool not loaded: ${q.toolName}` },
            };
          } else if (!pluginActiveInProject(tool.pluginId, projectPath)) {
            // The catalog already hid it, but a session assembled before the
            // scope changed can still ask.
            payload = {
              executionId: q.executionId,
              ok: false,
              errorCode: "TOOL_NOT_FOUND",
              content: {
                error: `plugin tool ${q.toolName} is not enabled for this project`,
              },
            };
          } else {
            try {
              let modelKey: string | undefined;
              let thinkingLevel: string | undefined;
              // Host-core sends the session mode; fall back to a session.get
              // call when it is missing (legacy callers). The plugin-runtime
              // uses the mode to enforce plan-safe action restrictions
              // (ADR 0211).
              let sessionMode: "agent" | "plan" | "goal" | undefined;
              const normalizedMode = typeof q.mode === "string" ? q.mode : undefined;
              if (
                normalizedMode === "agent" ||
                normalizedMode === "plan" ||
                normalizedMode === "goal"
              ) {
                sessionMode = normalizedMode;
              } else if (q.sessionId && runtimeState.host) {
                try {
                  const detail = await runtimeState.host.call<{
                    session?: {
                      mode?: string;
                      providerId?: string;
                      modelId?: string;
                      thinkingLevel?: string;
                    };
                  }>("session.get", { id: q.sessionId });
                  const session = detail?.session;
                  if (
                    session?.mode === "agent" ||
                    session?.mode === "plan" ||
                    session?.mode === "goal"
                  ) {
                    sessionMode = session.mode;
                  }
                  if (session?.providerId && session?.modelId) {
                    modelKey = `${session.providerId}/${session.modelId}`;
                  }
                  thinkingLevel = session?.thinkingLevel;
                } catch {
                  // Executor identity is best-effort; the tool can still run.
                }
              }
              // The dispatch below is the first side effect, and every await
              // (the session read above included) is behind us: a call the user
              // cancelled while this handler was awaiting must not begin now.
              if (call?.aborted) return;
              const result = await tool.execute(q.args, {
                sessionId: q.sessionId,
                turnId: q.turnId,
                mode: sessionMode,
                modelKey,
                thinkingLevel,
                signal: call?.signal,
              });
              // A cancel that landed while the tool ran already settled the
              // call in the host; this finished result must not answer twice.
              if (call?.aborted) return;
              payload = {
                executionId: q.executionId,
                ok: true,
                content: result ?? null,
              };
            } catch (e) {
              if (call?.aborted) return;
              payload = {
                executionId: q.executionId,
                ok: false,
                errorCode: toolRefusalCode(e) ?? "TOOL_FAILED",
                content: { error: e instanceof Error ? e.message : String(e) },
              };
            }
          }
        } finally {
          call?.dispose();
        }
        for (const toast of plugins.drainToasts()) {
          sendToRenderer(IPC.event.toast, { message: toast });
        }
        if (!payload) return;
        logger.app("plugin", "info", "plugin tool executed", {
          toolCallId: q.toolCallId,
          pluginId: tool?.pluginId,
          data: { toolName: q.toolName, ok: payload.ok === true },
        });
        try {
          await h.call("plugins.resolveExecution", payload);
        } catch (e) {
          logger.app("plugin", "warn", "plugin execution resolve failed", {
            data: String(e),
          });
        }
      })();
    } else if (
      method === "keyboard.shortcut" &&
      process.platform === "win32" &&
      (params as { binding?: unknown })?.binding === "Alt+Space"
    ) {
      void togglePluginLauncher().catch((error) =>
        logger.app("diagnostics", "error", "Windows global shortcut failed", {
          data: String(error),
        }),
      );
    } else if (method === "plans.changed") {
      sendToRenderer(IPC.event.plansChanged, params);
    } else if (method === "todos.changed") {
      sendToRenderer(IPC.event.todosChanged, params);
    } else if (method === "configSync.changed") {
      sendToRenderer(IPC.event.configSyncChanged, params);
    } else if (method === "configSync.progress") {
      // A sync is one request that answers only when it is over, so these
      // reports are the only thing the page has to show while it runs. The
      // request's own answer is still the outcome.
      sendToRenderer(IPC.event.configSyncProgress, params);
    }
  });
  h.onExit(({ code, signal, intentional }) => {
    remoteTools.dispose();
    // The host that registered those calls is gone; every per-call record it
    // owns is stale, including tombstones for a generation that can no longer
    // send a `plugins.execute`.
    toolCancellations.clear();
    if (runtimeState.host !== h) return;
    logger.flushChild("host");
    runtimeState.host = null;
    if (intentional || isQuitting()) return;
    // Sessions whose interrupted turn the approved-execution branch settles with
    // its own error code and its own execution record.
    const settledWithExecution = new Set<string>();
    for (const [executionId, sessionId] of claimedExecutionSessions) {
      if (approvedExecutionIdsBySession.get(sessionId) === executionId) {
        // Captured before the teardown awaits: the turn this interrupted is the
        // one running now, and it must not be inferred later.
        const interruptedTurnId = activeTurns.get(sessionId);
        if (interruptedTurnId) {
          settledWithExecution.add(sessionId);
          void finishTurn(sessionId, "aborted", "PLAN_EXECUTION_INTERRUPTED", {
            turnId: interruptedTurnId,
          }).catch((error: unknown) => {
            // Nothing above can await this: the host is already gone. Log it
            // rather than let the rejection surface as an unhandled one.
            logger.app("runtime", "warn", "turn finalization failed after host exit", {
              sessionId,
              data: String(error),
            });
          });
        }
      }
      void finishApprovedExecution(
        executionId,
        "interrupted",
        "PLAN_EXECUTION_INTERRUPTED",
      );
    }
    settleTurnsInterruptedByHostExit(settledWithExecution);
    logger.app("runtime", "error", "host-core exited unexpectedly", {
      code: ErrorCodes.HOST_UNAVAILABLE,
      data: { exitCode: code, signal },
    });
    sendToRenderer(IPC.event.hostStatus, {
      ok: false,
      component: "host",
      restarting: true,
    });
    void superviseRestart("host");
  });
  };
  const startHost = async (): Promise<void> => {

  assertLinuxGlibcSupported();
  const systemProxyRelayUrl = await ensureSystemProxyRelay();
  const h = new HostProcess(dataDir, (text) => logger.child("host", text));
  wireHost(h);
  runtimeState.host = h;
  try {
    await h.handshake();
    await h.call("network.configureSystemProxyRelay", {
      url: systemProxyRelayUrl,
    });
    logger.app("runtime", "info", "host-core handshake ok", {
      data: { generation: h.generation },
    });
    void importLegacyScheduled();
    // Drain before the renderer can session.get. Assistant/tool rows live in
    // this outbox until host-core appends them; a cold start that raced the
    // flush showed only user prompts (issue #42 / D327). Boot leaves
    // completed checkpoints in place so this drain can land the finished
    // row first; leftovers are then promoted as complete.
    await persistenceOutbox.flush(() => runtimeState.host);
    try {
      await h.call("session.recoverInflightMessages");
    } catch (error) {
      logger.app("persistence", "warn", "in-flight reply recovery after outbox drain failed", {
        data: String(error),
      });
    }
  } catch (error) {
    if (runtimeState.host === h) runtimeState.host = null;
    logger.flushChild("host");
    await h.dispose();
    throw error;
  }
  };
  return { wireHost, startHost };
}
