import type { BrowserWindow } from "electron";
import {
  addUsage,
  type AgentEventEnvelope,
  type MessageUsage,
} from "@pi-desktop/shared";
import {
  shouldCreateTaskNotification as shouldCreateTaskNotificationPolicy,
} from "../notification-policy";

/**
 * Terminal state of one host turn. `aborted` is reserved for a turn the host
 * cancelled; a graceful stop still ends as `completed` (the runtime owns that
 * boundary decision), and `error` covers a failed or interrupted turn.
 */
export type TurnEndReason = "completed" | "aborted" | "error";

/** Payload of the `session:turnEnded` host event. */
export type TurnEndedPayload = {
  sessionId: string;
  turnId: string;
  reason: TurnEndReason;
};

export type SessionCoordinationDependencies = {
  activeTurns: Map<string, string>;
  getMainWindow: () => BrowserWindow | null;
  getViewingSessionId: () => string | null;
};

/**
 * The one coordination instance the main process creates. Domain modules take
 * this object rather than its individual functions, so turn identity, the abort
 * lock and the turn records always have exactly one owner and one reader.
 */
export type SessionCoordination = ReturnType<typeof createSessionCoordination>;

export function createSessionCoordination({
  activeTurns,
  getMainWindow,
  getViewingSessionId,
}: SessionCoordinationDependencies) {
  const sessionOperationTails = new Map<string, Promise<void>>();
  const turnSettlements = new Map<string, Set<() => void>>();
  const activeTurnUsages = new Map<string, MessageUsage>();
  /**
   * (sessionId, turnId) -> the in-flight finalization for that turn. Keyed by
   * the composite turn key, not by the session, so a late terminal event for an
   * older turn can never claim or release a newer turn's record.
   */
  const turnFinalizations = new Map<string, Promise<void>>();
  /**
   * (sessionId, turnId) -> the abort decision locked in before the cancel.
   * Short-lived on purpose: the first finalization freezes the reason and the
   * turn's teardown clears the lock, so no history and no eviction rule is
   * needed. A later terminal event for the same turn cannot restate it because
   * the frozen record already owns the turn.
   */
  const pendingAbortReasons = new Map<string, TurnEndReason>();
  /**
   * Live independent child runs, keyed by session then by the run's own
   * delegation id. A manually continued child (`agent.continueSubagent`)
   * runs with no durable parent turn, so the plugin dispatch gate cannot use
   * turn identity for its tools: the continuation path registers the run when
   * the sidecar accepts it, and a terminal delegation settlement observed on
   * the event channel revokes it. Per-run ids mean a delayed event from one
   * run can never authorize a newer run, and parent turn finalization never
   * touches this table.
   */
  const liveChildRuns = new Map<string, Set<string>>();
  /**
   * In-flight `agent.continueSubagent` acceptances, keyed by session. The
   * accepted run registers only when the sidecar response reaches main, but
   * the child's first tool call travels the host channel and can arrive
   * first. The plugins gate awaits this entry instead of failing closed, so
   * the authoritative registration is visible before the first tool
   * dispatches. Bounded by the acceptance call itself — never a grace
   * window — and settled runs still never register (F2 reports liveness).
   * Serialized per session by `acquireSessionOperation`, so one entry per
   * session is enough.
   */
  const pendingChildAcceptances = new Map<string, Promise<void>>();

  function trackPendingChildAcceptance(sessionId: string, pending: Promise<unknown>): void {
    const session = normalizeChildIdentity(sessionId);
    if (!session) return;
    const settled: Promise<void> = pending.then(
      () => undefined,
      () => undefined,
    );
    pendingChildAcceptances.set(session, settled);
    void settled.then(() => {
      if (pendingChildAcceptances.get(session) === settled) {
        pendingChildAcceptances.delete(session);
      }
    });
  }

  function pendingChildAcceptance(sessionId: string): Promise<void> | undefined {
    const session = normalizeChildIdentity(sessionId);
    if (!session) return undefined;
    return pendingChildAcceptances.get(session);
  }

  function normalizeChildIdentity(value: string | null | undefined): string | undefined {
    if (typeof value !== "string") return undefined;
    const id = value.trim();
    return id ? id : undefined;
  }

  function registerIndependentChildRun(sessionId: string, childRunId: string): void {
    const session = normalizeChildIdentity(sessionId);
    const run = normalizeChildIdentity(childRunId);
    if (!session || !run) return;
    let runs = liveChildRuns.get(session);
    if (!runs) {
      runs = new Set();
      liveChildRuns.set(session, runs);
    }
    runs.add(run);
  }

  function revokeIndependentChildRun(sessionId: string, childRunId: string): void {
    const session = normalizeChildIdentity(sessionId);
    const run = normalizeChildIdentity(childRunId);
    if (!session || !run) return;
    const runs = liveChildRuns.get(session);
    if (!runs) return;
    runs.delete(run);
    if (runs.size === 0) liveChildRuns.delete(session);
  }

  function isIndependentChildRunLive(
    sessionId: string,
    childRunId: string | null | undefined,
  ): boolean {
    const session = normalizeChildIdentity(sessionId);
    const run = normalizeChildIdentity(childRunId);
    if (!session || !run) return false;
    return liveChildRuns.get(session)?.has(run) ?? false;
  }

  /** Drop every child registration: the runtime state behind them is gone. */
  function clearIndependentChildRuns(): void {
    liveChildRuns.clear();
  }

  /**
   * Revoke the child run a terminal delegation settlement names. Only a
   * `Task`-row `message_end` whose details carry a non-`running` status
   * revokes anything: progress snapshots, rows for other tools, and
   * malformed payloads leave the table untouched. Revocation is idempotent,
   * and a run id is per-run, so a late event can neither reopen its own run
   * nor authorize a newer one.
   */
  function noteChildRunEvent(envelope: AgentEventEnvelope): void {
    if (!envelope || typeof envelope !== "object") return;
    const event = (envelope as { event?: unknown }).event;
    if (!event || typeof event !== "object") return;
    if ((event as { type?: unknown }).type !== "message_end") return;
    const message = (event as { message?: unknown }).message;
    if (!message || typeof message !== "object") return;
    const row = message as { role?: unknown; toolName?: unknown; toolResult?: unknown };
    if (row.role !== "tool" || row.toolName !== "Task") return;
    const result = row.toolResult;
    if (!result || typeof result !== "object") return;
    const details = (result as { details?: unknown }).details;
    if (!details || typeof details !== "object") return;
    const record = details as { delegationId?: unknown; status?: unknown };
    if (typeof record.delegationId !== "string" || !record.delegationId.trim()) return;
    if (typeof record.status !== "string" || record.status === "running") return;
    revokeIndependentChildRun(envelope.sessionId, record.delegationId);
  }

  async function acquireSessionOperation(sessionId: string): Promise<() => void> {
    const id = sessionId.trim();
    const previous = sessionOperationTails.get(id) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    const tail = previous.then(() => current);
    sessionOperationTails.set(id, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveCurrent();
      if (sessionOperationTails.get(id) === tail) {
        sessionOperationTails.delete(id);
      }
    };
  }

  function addActiveTurnUsage(
    sessionId: string,
    usage: MessageUsage | undefined,
  ): void {
    if (!usage) return;
    const next = addUsage(activeTurnUsages.get(sessionId), usage);
    if (next) activeTurnUsages.set(sessionId, next);
  }

  const activeToolCallKey = (sessionId: string, toolCallId: string) =>
    sessionId + ":" + toolCallId;

  /**
   * The composite (sessionId, turnId) key. Plan submission tracking, turn
   * settlements and turn finalizations all address a turn through this one rule,
   * so no module joins the two ids on its own. A session id never contains a
   * colon, which is what lets the busy check below find a session's turns by
   * prefix.
   */
  const planSubmissionTurnKey = (sessionId: string, turnId: string) =>
    sessionId + ":" + turnId;

  function waitForTurnSettlement(sessionId: string, turnId: string): Promise<void> {
    if (activeTurns.get(sessionId) !== turnId) return Promise.resolve();
    const key = planSubmissionTurnKey(sessionId, turnId);
    return new Promise((resolve) => {
      const waiters = turnSettlements.get(key) ?? new Set<() => void>();
      waiters.add(resolve);
      turnSettlements.set(key, waiters);
    });
  }

  /**
   * True while `turnId` still owns the session's live turn. A late terminal event
   * naming an older turn must not settle, release or answer for the current one.
   */
  function isActiveTurn(sessionId: string, turnId: string | null | undefined): boolean {
    if (typeof turnId !== "string") return false;
    const id = sessionId.trim();
    const turn = turnId.trim();
    if (!id || !turn) return false;
    return activeTurns.get(id) === turn;
  }

  /**
   * Record that this turn was cancelled. Called before the cancel request is
   * issued, so a terminal event arriving while it is in flight cannot restate the
   * abort as a completion. A session without a live turn keeps its existing
   * cancel behaviour but locks nothing and therefore announces nothing.
   */
  function lockAbortReason(sessionId: string, turnId: string | null | undefined): void {
    if (!isActiveTurn(sessionId, turnId)) return;
    pendingAbortReasons.set(
      planSubmissionTurnKey(sessionId.trim(), String(turnId).trim()),
      "aborted",
    );
  }

  /**
   * The reason locked for this turn, without consuming it: the lock lives until
   * the turn's teardown releases it, so an abort that is read by the finalization
   * is still visible to a terminal event arriving later in the same turn.
   * Only the turn the lock belongs to can read it.
   */
  function peekAbortReason(
    sessionId: string,
    turnId: string | null | undefined,
  ): TurnEndReason | undefined {
    if (typeof turnId !== "string") return undefined;
    const id = sessionId.trim();
    const turn = turnId.trim();
    if (!id || !turn) return undefined;
    return pendingAbortReasons.get(planSubmissionTurnKey(id, turn));
  }

  /** Drop a turn's lock. Called from that turn's own teardown, by identity. */
  function clearAbortReason(sessionId: string, turnId: string | null | undefined): void {
    if (typeof turnId !== "string") return;
    const id = sessionId.trim();
    const turn = turnId.trim();
    if (!id || !turn) return;
    pendingAbortReasons.delete(planSubmissionTurnKey(id, turn));
  }
  /**
   * Drop a turn's records when it can no longer finalize itself: its settlement
   * waiters and its cancellation lock. Only that turn's key is touched, so a
   * newer turn on the same session keeps its own records. Idempotent.
   */
  function releaseTurnClaims(sessionId: string, turnId: string): void {
    const key = planSubmissionTurnKey(sessionId.trim(), turnId.trim());
    pendingAbortReasons.delete(key);
    const waiters = turnSettlements.get(key);
    if (!waiters) return;
    turnSettlements.delete(key);
    for (const resolve of waiters) resolve();
  }

  /**
   * Last synchronous gate before a plugin side effect. A turn that is not the
   * session's live turn, has an abort decision recorded, or is already finalizing
   * must not start one. Callers must not await between this check and the
   * dispatch.
   */
  function isTurnDispatchable(
    sessionId: string,
    turnId: string | null | undefined,
  ): boolean {
    if (!isActiveTurn(sessionId, turnId)) return false;
    const key = planSubmissionTurnKey(sessionId.trim(), String(turnId).trim());
    return !pendingAbortReasons.has(key) && !turnFinalizations.has(key);
  }

  /**
   * Combined synchronous gate before a plugin side effect. A payload that
   * carries an explicit child identity is judged only by that identity: it
   * dispatches exactly when the continuation path registered the run as
   * live, even with no live parent turn, and never borrows a live parent
   * turn's authority. A payload without one dispatches exactly when its
   * turn still owns the session. Callers must not await between this check
   * and the dispatch.
   */
  function isPluginDispatchable(
    sessionId: string,
    turnId: string | null | undefined,
    childRunId?: string | null,
  ): boolean {
    if (normalizeChildIdentity(childRunId) !== undefined) {
       return isIndependentChildRunLive(sessionId, childRunId);
    }
    return isTurnDispatchable(sessionId, turnId);
  }

  /**
   * Whether the session is still occupied by a turn or by its teardown. The queue
   * must stay held across the window where `activeTurns` has already forgotten the
   * turn but its announcement has not run yet, so the finalization records are
   * part of the answer. That table only holds the turns still finalizing, so a
   * prefix scan is bounded by the number of concurrent finalizations and needs no
   * second index.
   */
  function isSessionBusy(sessionId: string): boolean {
    const id = sessionId.trim();
    if (!id) return false;
    if (activeTurns.has(id)) return true;
    const prefix = id + ":";
    for (const key of turnFinalizations.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * A root terminal event (`agent_end` / `error`) may only change the live turn's
   * state when it carries the identity of the turn that still owns the session.
   * An event with no identity cannot be attributed to any turn, and one naming
   * another turn belongs to that turn: neither may finish this turn, resolve its
   * approvals or advance its queue. Message and tool rows are unaffected and are
   * still archived as history.
   *
   * Both event entry points call this: the fan-out to Agent Host and the renderer,
   * and the persistence pass, which is a separate call and would otherwise still
   * apply terminal state effects on behalf of a turn that no longer exists.
   */
  function isStaleTerminalEvent(envelope: AgentEventEnvelope): boolean {
    const type = envelope.event.type;
    if (type !== "agent_end" && type !== "error") return false;
    // A delegate's terminal event settles the delegate. The agent runtime keeps a
    // delegate's `agent_end`, `turn_end` and error events inside the delegate, so
    // this is a guard rather than the normal path: a delegate finishing must never
    // end its parent's turn.
    if (envelope.parentToolCallId) return true;
    return !isActiveTurn(envelope.sessionId, envelope.turnId);
  }

  function shouldCreateTaskNotification(sessionId: string): boolean {
    const window = getMainWindow();
    const liveWindow = window !== null && !window.isDestroyed();
    return shouldCreateTaskNotificationPolicy({
      finishingSessionId: sessionId,
      viewingSessionId: getViewingSessionId(),
      windowVisible: liveWindow && window?.isVisible() === true,
      windowFocused: liveWindow && window?.isFocused() === true,
    });
  }

  return {
    /** The live turn map itself: turn identity is read and released through it. */
    activeTurns,
    sessionOperationTails,
    turnSettlements,
    activeTurnUsages,
    turnFinalizations,
    pendingAbortReasons,
    acquireSessionOperation,
    addActiveTurnUsage,
    activeToolCallKey,
    planSubmissionTurnKey,
    waitForTurnSettlement,
    shouldCreateTaskNotification,
    isActiveTurn,
    lockAbortReason,
    peekAbortReason,
    clearAbortReason,
    releaseTurnClaims,
    isTurnDispatchable,
    isPluginDispatchable,
    registerIndependentChildRun,
    revokeIndependentChildRun,
    trackPendingChildAcceptance,
    pendingChildAcceptance,
    isIndependentChildRunLive,
    clearIndependentChildRuns,
    noteChildRunEvent,
    isSessionBusy,
    isStaleTerminalEvent,
  };
}
