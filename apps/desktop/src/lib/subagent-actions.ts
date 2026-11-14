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
   * The turn the runtime currently records for this run, when known. It is
   * informational: steering targets the live child itself, so the renderer
   * never blocks a steer on turn identity.
   */
  expectedTurnId?: string;
};

/**
 * Disabled-matrix for the child composer: one pure gate so the
 * permission / remote / liveness matrix is executable without React.
 * Returns null when steering is allowed, otherwise the stable block reason.
 *
 * Liveness is the delegate's own `running` outcome; the parent session's
 * generic running flag and turn identity are intentionally not consulted.
 */
export function subagentSteerBlockedReason(gate: SubagentSteerGate): SubagentSteerBlock | null {
  if (gate.readOnlySession) return "read-only";
  if (!gate.canSteerParent) return "unavailable";
  if (!gate.running) return "unavailable";
  return null;
}

export type CapturedSteerIdentity =
  | { ok: true; sessionId: string; turnId?: string }
  | { ok: false; reason: SubagentSteerBlock };

/**
 * Capture turn identity before the steer `await` (F6): a session switch during
 * dispatch must reject instead of steering the wrong child. The turn id is
 * informational and captured only when present. Pure so tests can assert the
 * captured identity without React.
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
  if (!sessionId) return { ok: false, reason: "unavailable" };
  if (
    input.source === "remote" ||
    input.source === "pi-native" ||
    input.sessionStartsWithRemote ||
    input.sessionStartsWithNative
  ) {
    return { ok: false, reason: "read-only" };
  }
  if (!input.canSteer) return { ok: false, reason: "unavailable" };
  return turnId ? { ok: true, sessionId, turnId } : { ok: true, sessionId };
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

/**
 * Whether the tab offers the continuation composer.
 *
 * A tab represents its whole resume chain, and its actions always target the
 * chain's newest run, so every tab of one chain is the same action surface.
 * No tab is "stale": a run continued from another tab or card keeps the
 * original tab operable, which is what lets the user keep working in the
 * window they already have. Concurrent sends are the backend's serial
 * admission to reject, not a local per-tab guess.
 */
export function shouldShowSubagentContinue(input: {
  outcome: SubagentOutcome | string | null | undefined;
  hasInstance: boolean;
  canPromptParent: boolean;
  readOnlySession: boolean;
}): boolean {
  if (!input.canPromptParent || input.readOnlySession) return false;
  return canContinueSubagent(input.outcome, input.hasInstance);
}

export type CapturedContinueIdentity =
  | { ok: true; sessionId: string; turnId?: string }
  | { ok: false; reason: SubagentSteerBlock };

/**
 * Whether a recorded `Task` row is a user-origin continuation marker: the
 * renderer sent that continuation directly from the delegate tab
 * (`toolArgs.source === "user"` with a `resume` target).
 *
 * This is input provenance, not ownership. The child it started is an ordinary
 * child of its session: it appears in status, TaskList, TaskWait and result
 * history like any other run. Historical rows may carry a retired
 * `details.delivery` field; it is ignored.
 */
export function isUserOriginTaskMarker(input: { toolArgs?: unknown }): boolean {
  const args = input.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const record = args as { source?: unknown; resume?: unknown };
  return (
    record.source === "user" &&
    typeof record.resume === "string" &&
    record.resume.trim().length > 0
  );
}

/**
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
 * The tab clears only on success, only while the composer still belongs to the
 * session it sent to, and only while it still holds exactly the text that was
 * sent — text the user typed after the capture is never wiped.
 *
 * The chain target may legitimately move during an accepted send: a
 * continuation opens the chain's next run, so the composer starts targeting the
 * delegation the send itself handed back. That is the same action surface, not
 * a different conversation, so it still clears. A target that is neither the
 * captured run nor the one this send opened was moved by something else, and
 * the text stays. Failures never clear — the caller owns clearing on success.
 */
export function shouldClearSteerDraft(input: {
  sendSucceeded: boolean;
  capturedSessionId?: string;
  currentSessionId?: string;
  capturedDelegationId: string;
  currentDelegationId: string;
  /**
   * The delegation the accepted send reported for the run it opened (a
   * continuation) or steered (a live run). Absent when the reply carried none.
   */
  sendDelegationId?: string;
  /** Whether the composer still holds exactly the text that was sent. */
  draftUnchanged: boolean;
}): boolean {
  if (!input.sendSucceeded) return false;
  if (!input.capturedSessionId || input.currentSessionId !== input.capturedSessionId) {
    return false;
  }
  if (!input.draftUnchanged) return false;
  if (input.currentDelegationId === input.capturedDelegationId) return true;
  return !!input.sendDelegationId && input.currentDelegationId === input.sendDelegationId;
}
