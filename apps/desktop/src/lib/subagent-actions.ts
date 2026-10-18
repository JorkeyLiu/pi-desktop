import type { SubagentOutcome } from "./subagent-topology";

/**
 * Pure child-action model (no React, no IPC): continuability + safe identity
 * capture. The runner (panel/footer) owns session capture and the actual IPC
 * call so an `await` never switches the active session.
 */

export function isSubagentRunning(outcome: SubagentOutcome | string | null | undefined): boolean {
  return outcome === "running";
}

/** Settled means the child loop ended; every settled instance can continue. */
export function isSubagentSettled(outcome: SubagentOutcome | string | null | undefined): boolean {
  return outcome !== undefined && outcome !== null && outcome !== "running";
}

export type SubagentSteerBlock =
  | "read-only"
  | "unavailable";

export type SubagentSteerGate = {
  readOnlySession: boolean;
  canSteerParent: boolean;
  /** The delegate itself is live (backend-owned outcome, not parent UI). */
  running: boolean;
  /**
   * Turn owning this steering: the live parent turn for an attached
   * delegate, the delegate's execution-accounting turn for a detached
   * user-owned run (kept from the continue/steer response or the current
   * status). The backend validates it; the renderer never infers the
   * relationship from the parent session's generic running flag, because a
   * running child may outlive parent UI idleness.
   */
  expectedTurnId?: string;
};

/**
 * Disabled-matrix for the child composer: one pure gate so the
 * permission / remote / liveness matrix is executable without React.
 * Returns null when steering is allowed, otherwise the stable block reason.
 *
 * Liveness is the delegate's own `running` outcome plus a known owner turn;
 * the parent session's generic running flag is intentionally not consulted.
 * A stale or mismatched owner turn is the backend's rejection to make
 * (`TURN_NOT_FOUND`/busy) with the draft preserved — never a local guess.
 */
export function subagentSteerBlockedReason(gate: SubagentSteerGate): SubagentSteerBlock | null {
  if (gate.readOnlySession) return "read-only";
  if (!gate.canSteerParent) return "unavailable";
  if (!gate.running) return "unavailable";
  if (!gate.expectedTurnId) return "unavailable";
  return null;
}

export type CapturedSteerIdentity =
  | { ok: true; sessionId: string; turnId: string }
  | { ok: false; reason: SubagentSteerBlock };

/**
 * Capture turn identity before the steer `await` (F6): a session switch or a
 * liveness change during dispatch must reject instead of steering the wrong
 * child. Pure so tests can assert the captured identity without React.
 */
export function captureSteerIdentity(input: {
  sessionId?: string;
  turnId?: string;
  source?: string;
  sessionStartsWithRemote?: boolean;
  sessionStartsWithNative?: boolean;
  canSteer: boolean;
}): CapturedSteerIdentity {
  const sessionId = input.sessionId;
  const turnId = input.turnId;
  if (!sessionId || !turnId) return { ok: false, reason: "unavailable" };
  if (
    input.source === "remote" ||
    input.source === "pi-native" ||
    input.sessionStartsWithRemote ||
    input.sessionStartsWithNative
  ) {
    return { ok: false, reason: "read-only" };
  }
  if (!input.canSteer) return { ok: false, reason: "unavailable" };
  return { ok: true, sessionId, turnId };
}

/**
 * Whether the settled delegate can continue directly through the backend
 * `agent.continueSubagent` path (no parent prompt).
 *
 * Every instantiated settled child continues regardless of how it ended —
 * `completed`, `failed`, `timed_out`, `interrupted`, `stopped`, `aborted`, and
 * any future terminal outcome. The outcome is history, not a gate: nothing is
 * permanently uncontinuable. A live run steers instead (never a second
 * simultaneous run), and a call with no backend instance — a denied
 * never-started call, or a tab whose Task chain is missing — has no child to
 * continue. Unlike steering, the parent turn need not be running: an idle
 * parent omits `expectedTurnId` and a live parent passes its current turn as a
 * guard.
 */
export function canContinueSubagent(
  outcome: SubagentOutcome | string | null | undefined,
  hasInstance: boolean,
): boolean {
  if (!hasInstance) return false;
  return isSubagentSettled(outcome);
}

export function shouldShowSubagentContinue(input: {
  outcome: SubagentOutcome | string | null | undefined;
  hasInstance: boolean;
  canPromptParent: boolean;
  readOnlySession: boolean;
  isStaleTab: boolean;
}): boolean {
  if (input.isStaleTab) return false;
  if (!input.canPromptParent || input.readOnlySession) return false;
  return canContinueSubagent(input.outcome, input.hasInstance);
}

export type CapturedContinueIdentity =
  | { ok: true; sessionId: string; turnId?: string }
  | { ok: false; reason: SubagentSteerBlock };

/**
 * Who receives one delegation run's report, from backend-owned persisted
 * fields — never inferred from parent UI state.
 *
 * The runtime marks user-owned runs explicitly: `details.delivery ===
 * "user"` on a recorded summary, or a user-origin `Task` marker row
 * (`toolArgs.source === "user"` with a `resume` target). Parent-owned runs
 * omit both (backward-compatible default).
 */
export function subagentDeliveryOwner(input: {
  details?: unknown;
  toolArgs?: unknown;
}): "parent" | "user" {
  const details = input.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    if ((details as { delivery?: unknown }).delivery === "user") return "user";
  }
  const args = input.toolArgs;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const record = args as { source?: unknown; resume?: unknown };
    if (
      record.source === "user" &&
      typeof record.resume === "string" &&
      record.resume.trim()
    ) {
      return "user";
    }
  }
  return "parent";
}

/**
 * Resolve the owner turn for one child steer: a response-kept execution
 * turn for this delegation wins (covers the status-lag window after a
 * detached continue), otherwise the status's current turn — which the host
 * already points at the runtime's turn (the live parent turn when attached,
 * the adopted execution turn when detached).
 */
export function resolveSteerOwnerTurn(input: {
  keptTurnId?: string;
  currentTurnId?: string;
}): string | undefined {
  const kept = input.keptTurnId?.trim();
  if (kept) return kept;
  const current = input.currentTurnId?.trim();
  return current || undefined;
}/**
 * Capture continue identity before the `await`: the session is pinned, and
 * the parent turn travels only when it is live. An idle parent omits
 * `expectedTurnId`; a read-only session or a session without prompt rights
 * is rejected before any IPC leaves the renderer.
 */
export function captureContinueIdentity(input: {
  sessionId?: string;
  turnId?: string;
  source?: string;
  sessionStartsWithRemote?: boolean;
  sessionStartsWithNative?: boolean;
  canPrompt: boolean;
}): CapturedContinueIdentity {
  const sessionId = input.sessionId;
  if (!sessionId) return { ok: false, reason: "unavailable" };
  if (
    input.source === "remote" ||
    input.source === "pi-native" ||
    input.sessionStartsWithRemote ||
    input.sessionStartsWithNative
  ) {
    return { ok: false, reason: "read-only" };
  }
  if (!input.canPrompt) return { ok: false, reason: "unavailable" };
  const turnId = input.turnId?.trim() ? input.turnId : undefined;
  return turnId ? { ok: true, sessionId, turnId } : { ok: true, sessionId };
}

/**
 * Whether a steer/follow-up draft may be cleared after the send `await`.
 *
 * The tab clears only on success and only when the composer still targets the
 * same session *and* the same chain-latest delegation it sent to. A tab or
 * session switch, or a chain continuation (d1 -> d2) arriving mid-dispatch,
 * moves the composer to a different target, so the (possibly retyped) draft
 * is preserved. Failures never clear — the caller owns clearing on success.
 */
export function shouldClearSteerDraft(input: {
  sendSucceeded: boolean;
  capturedSessionId?: string;
  currentSessionId?: string;
  capturedDelegationId: string;
  currentDelegationId: string;
}): boolean {
  if (!input.sendSucceeded) return false;
  if (!input.capturedSessionId || input.currentSessionId !== input.capturedSessionId) {
    return false;
  }
  return input.currentDelegationId === input.capturedDelegationId;
}
