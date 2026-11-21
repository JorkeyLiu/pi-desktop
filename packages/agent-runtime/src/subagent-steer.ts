/**
 * TaskSteer: the parent model's own steering channel.
 *
 * The user steers a live child from its transcript tab through
 * `runtime.steerSubagent` (sidecar `agent.steerSubagent`). The parent model
 * had no equivalent: `Task(resume)` refuses a still-running delegation, so a
 * model that spotted a problem mid-run could only misuse `Task(resume)`.
 * `TaskSteer` closes that gap with its own authorization boundary.
 *
 * Rules, in order:
 *
 * - Identity: `delegationId` names exactly one target. There is no
 *   broadcast, no call-id alias, and no resume/spawn fallback. Unknown,
 *   settled, stopping, or loop-less targets fail with a structured error
 *   and no side effect.
 * - Ownership: only the session's own registry is searched (cross-session
 *   steering is impossible by construction), the caller must be the parent
 *   model rather than a delegate, and user-controlled runs stay out of
 *   reach. A delegate's tool call can never steer its parent, a sibling,
 *   or any other run. `expectedTurnId` is never consulted: turn recency is
 *   not an ownership proof.
 * - Liveness: the existing `validateSubagentSteer` machinery decides
 *   whether the child loop can receive the message; a run that settles in
 *   the race reads as `DELEGATION_NOT_RUNNING`, never as a silent drop.
 * - Receipt, not consumption: a successful call only queues the message for
 *   the child's next turn boundary. The tool result says `queued`, never
 *   `consumed` or `executed`, and the schema promises no exactly-once
 *   delivery beyond the existing dedupe contract.
 * - Provenance: the queued row keeps the existing `user` role (it is a
 *   conversation input, never a system instruction), and the request is
 *   marked `source: "model"` in the tool-result metadata. No persisted
 *   format changes: the source marking rides the receipt, not the DB.
 */

import {
  applyValidatedSteer,
  validateSubagentSteer,
  type SteerTargetState,
  type ValidatedSubagentSteer,
} from "./subagent-control.js";
import { isRecord } from "./agent-messages.js";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Ownership failure: the caller may not steer this delegation. */
export const MODEL_STEER_OWNERSHIP_ERROR = "DELEGATION_NOT_OWNED";

/** Provenance marker the model tool stamps on its receipt. */
export const MODEL_STEER_SOURCE = "model" as const;
export type ModelSteerSource = typeof MODEL_STEER_SOURCE;

/** Delivery semantics a TaskSteer receipt promises. */
export const MODEL_STEER_DELIVERY = "next_turn" as const;

/**
 * A delegation as the model-steer decision reads it: the live-run facts
 * `validateSubagentSteer` needs, plus who controls the run.
 */
export type ModelSteerRecordState = SteerTargetState & {
  /** True when the user started or continued this run directly. */
  userOrigin?: boolean;
};

/**
 * Who issued the `TaskSteer` call. The parent model owns its direct
 * children; a delegate owns nothing steerable (nested delegation tools
 * stay denied, so a delegate caller is always out of bounds).
 */
export type ModelSteerCaller =
  | { kind: "parent" }
  | { kind: "delegate"; delegationId?: string };

/** Raw `TaskSteer` arguments before validation. */
export type ModelSteerRequest = {
  delegationId: unknown;
  message: unknown;
};

export type ValidatedModelSteer = {
  delegationId: string;
  message: string;
  validated: ValidatedSubagentSteer;
};

function codedError(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/**
 * Authorize and validate one model steer without touching any loop.
 *
 * Pure over its inputs: lookup and caller classification are injected, so
 * this is unit-testable without a runtime. Throws coded rejections; the
 * caller maps them to the standard tool-error channel (`afterToolCall`
 * marks `isError`), never to a spawn, a stop, or a post-settle queue.
 */
export function validateModelSteer(
  caller: ModelSteerCaller,
  lookup: (delegationId: string) => ModelSteerRecordState | undefined,
  request: ModelSteerRequest,
): ValidatedModelSteer {
  const delegationId =
    typeof request.delegationId === "string" ? request.delegationId.trim() : "";
  if (!delegationId) {
    throw codedError("delegationId required", "DELEGATION_NOT_FOUND");
  }
  if (caller.kind === "delegate") {
    throw codedError(
      `Delegation "${delegationId}" is not yours to steer: a subagent cannot steer ` +
        `its parent, its siblings, or any other run. Only the parent agent steers ` +
        `the delegations it started itself.`,
      MODEL_STEER_OWNERSHIP_ERROR,
    );
  }
  const record = lookup(delegationId);
  if (!record) {
    throw codedError(
      `Unknown delegation "${delegationId}". Call TaskList to see them.`,
      "DELEGATION_NOT_FOUND",
    );
  }
  if (record.userOrigin) {
    throw codedError(
      `Delegation "${delegationId}" is user-controlled; steer it from its own ` +
        `transcript tab instead. TaskSteer only steers delegations this parent ` +
        `agent started itself.`,
      MODEL_STEER_OWNERSHIP_ERROR,
    );
  }
  const message = typeof request.message === "string" ? request.message : "";
  if (!message.trim()) {
    throw codedError(
      "TaskSteer needs a non-empty `message`: the follow-up direction to queue " +
        "into the child's conversation.",
      "INVALID_ARGUMENT",
    );
  }
  const validated = validateSubagentSteer(record, {
    delegationId,
    text: message,
  });
  return { delegationId, message, validated };
}

export type ModelSteerEffects = {
  sessionId: string;
  /** Turn the echo is attributed to; absent leaves it to the emitter. */
  ownerTurnId?: string;
  parentToolCallId: string;
  agentName: string;
  /** Hands the input to the child loop. */
  steerLoop: (text: string, images: readonly ImageContent[], rowId: string) => void;
  markSteered: (messageId: string) => void;
  appendRow: (envelope: AgentEventEnvelope, message: UiMessage) => void;
  emit: (envelope: AgentEventEnvelope) => void;
};

/**
 * Queue an authorized steer into the child loop. Thin wrapper over the
 * shared `applyValidatedSteer` machinery: a loop that settled in the race
 * throws `DELEGATION_NOT_RUNNING` with `Task(resume)` guidance instead of
 * queueing onto a dead run.
 */
export function applyModelSteer(
  validated: Extract<ValidatedSubagentSteer, { outcome: "steer" }>,
  deps: ModelSteerEffects,
): void {
  applyValidatedSteer(validated, deps);
}

/** Whether a tool-call error carries a coded rejection. */
export function isCodedSteerError(error: unknown): error is Error & { errorCode: string } {
  return (
    error instanceof Error &&
    typeof (error as { errorCode?: unknown }).errorCode === "string"
  );
}

export type ModelSteerReceipt = {
  content: [{ type: "text"; text: string }];
  details: {
    delegationId: string;
    messageId: string;
    /** Queueing stage this receipt confirms. Never `consumed`/`executed`. */
    status: "queued";
    /** Where the message surfaces: the child's next turn boundary. */
    delivery: typeof MODEL_STEER_DELIVERY;
    /** Provenance: the parent model, not the user. */
    source: ModelSteerSource;
  };
};

/**
 * Build the queueing receipt for an accepted steer. The text states what
 * happened (queued for the next turn boundary, current tool batch
 * untouched) and what it does not claim (consumption); the details carry
 * the structured, log-safe trace.
 */
export function modelSteerReceipt(
  delegationId: string,
  validated: ValidatedSubagentSteer,
): ModelSteerReceipt {
  const messageId =
    validated.outcome === "steer" ? validated.message.id : validated.delegationId;
  return {
    content: [
      {
        type: "text",
        text:
          `Steering queued for delegation "${delegationId}": the message reaches ` +
          `the child at its next turn boundary without interrupting its current ` +
          `tool batch. This receipt confirms queueing only, not consumption — ` +
          `check the child's next progress or TaskWait to see what it did with ` +
          `the message. A settled delegation cannot be steered; continue it ` +
          `with Task(resume: "${delegationId}") instead.`,
      },
    ],
    details: {
      delegationId,
      messageId,
      status: "queued",
      delivery: MODEL_STEER_DELIVERY,
      source: MODEL_STEER_SOURCE,
    },
  };
}

/** Read one raw `TaskSteer` argument record into its two fields. */
export function readModelSteerRequest(params: unknown): ModelSteerRequest {
  const record = isRecord(params) ? params : {};
  return { delegationId: record.delegationId, message: record.message };
}
