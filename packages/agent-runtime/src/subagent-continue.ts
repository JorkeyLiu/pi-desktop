/**
 * Direct child continuation: validation, delivery ownership, and transcript
 * rows for a user-origin `agentContinueSubagent` that resumes a settled chain
 * without asking the parent model to emit `Task(resume)` first.
 *
 * Kept out of `runtime.ts` so the hotspot owns only thin call sites. Spawning
 * reuses the `Task(resume)` tool implementation; everything else here is pure
 * over its inputs. Error identities (`errorCode`) are part of the contract:
 * the sidecar and Electron main surface them to the UI without reinterpreting
 * the text.
 *
 * Delivery rule (definitive): the parent receives a run's report only while it
 * expects THIS chain — the source run started in the current parent epoch,
 * its report was never delivered, it was not stopped/aborted, and its owning
 * turn is still alive. A settled source that still meets all four keeps the
 * `parent` delivery; anything else (delivered report, ended parent, detached
 * chain) continues as `user`-owned: no parent wake, no parent model context,
 * no billing of an unrelated turn. `expectedTurnId` is only a stale guard;
 * the source record decides the relationship.
 */

import { randomUUID } from "node:crypto";
import {
  isUuid,
  type AgentEventEnvelope,
  type MessageAttachment,
  type SubagentDeliveryOwner,
  type UiMessage,
} from "@pi-desktop/shared";

import type { ImageContent } from "@earendil-works/pi-ai";
import { DEFAULT_SUBAGENT_PERMISSION } from "@pi-desktop/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SubagentDefinition } from "@pi-desktop/shared";
import { nowIso } from "./agent-messages.js";
import type { DelegationChain } from "./delegation-history.js";

/**
 * Transport bound on images in one child input.
 *
 * Electron main holds the authoritative limit and refuses an over-limit request
 * before any byte crosses the sidecar; this re-check catches a hand-written or
 * corrupted payload that skipped it. The number matches the host's, and the
 * bound belongs in `@pi-desktop/shared` once the workspace resolves its own
 * packages rather than a sibling checkout's build.
 */
const MAX_CHILD_INPUT_IMAGES = 8;

function codedError(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

export type ContinueChainState = {
  delegationId: string;
  agentName: string;
  latestDelegationId?: string;
  latestStatus?: string;
};

export type ContinueOwnership = {
  expectedParentTurnId?: unknown;
  currentTurnId?: string;
  /** True when the parent turn is live and dispatchable. */
  turnAlive: boolean;
  /** True when the runtime currently owns a live parent turn. */
  runtimeRunning: boolean;
  /**
   * Allow a named-but-unknown turn as a fresh execution owner when idle.
   * The host begins it (accounting only); the runtime adopts it after this
   * validation. Never applies while a parent turn is live.
   */
  allowFreshExecutionTurn?: boolean;
};

export type ContinueInput = {
  delegationId: unknown;
  text: unknown;
  messageId?: unknown;
  /** Durable refs the echoed child row keeps; never carries bytes. */
  attachments?: MessageAttachment[];
  /** Image blocks the new run's opening user turn carries. */
  images?: ImageContent[];
};
export type ValidatedSubagentContinue =
  | {
      outcome: "continue";
      delegationId: string;
      chain: DelegationChain;
      text: string;
      /** Image blocks the continued run's opening user turn carries. */
      images: ImageContent[];
      /** Durable refs the echoed child row keeps; never carries bytes. */
      attachments?: MessageAttachment[];
      /** Real `Task(resume)` tool invocation id owning the new run's rows. */
      toolCallId: string;
      /** Idempotency key for the synthetic action, when the caller gave one. */
      idempotencyKey?: string;
      taskMessage: UiMessage;
      childMessage: UiMessage;
    }
  | { outcome: "already-applied"; delegationId: string; newDelegationId: string };

/**
 * Decide one settled-chain continuation without touching any loop.
 *
 * Guards, in order: identity, chain liveness (a still-running chain names its
 * live run — steer it instead of forking a second run), then the stale guard.
 * A settled chain continues regardless of how its last run ended: the outcome
 * is history, not a barrier. An
 * explicit `expectedParentTurnId` must name the live parent turn; an absent
 * one is allowed only when the runtime holds no live turn (the idle path,
 * where the host opens a new durable execution turn first). A repeated
 * caller message id returns `already-applied` with the first new run's id,
 * so retries execute the continuation exactly once.
 */
export function validateSubagentContinue(
  chain: DelegationChain | undefined,
  request: ContinueInput,
  ownership: ContinueOwnership,
  runningDelegationIds: ReadonlySet<string>,
  seenContinuations?: Map<string, string>,
): ValidatedSubagentContinue {
  const delegationId =
    typeof request.delegationId === "string" ? request.delegationId.trim() : "";
  if (!delegationId) {
    throw codedError("delegationId required", "DELEGATION_NOT_FOUND");
  }
  if (!chain) {
    throw codedError(
      `Unknown delegation "${delegationId}". Call TaskList to see them.`,
      "DELEGATION_NOT_FOUND",
    );
  }
  const rawText = typeof request.text === "string" ? request.text : "";
  const images = request.images ?? [];
  // An image-only continuation is a real input: the user sent a picture with
  // no words, and the continued run still starts from that picture.
  if (!rawText.trim() && images.length === 0) {
    throw codedError("Continuation text required", "INVALID_ARGUMENT");
  }
  if (rawText.trim().length > 20_000) {
    throw codedError("continueSubagent payload out of bounds", "INVALID_ARGUMENT");
  }
  const candidateId =
    typeof request.messageId === "string" ? request.messageId.trim() : "";
  const idempotencyKey = candidateId ? candidateId : undefined;
  if (idempotencyKey && idempotencyKey.length > 128 && !isUuid(idempotencyKey)) {
    throw codedError("messageId is invalid", "INVALID_ARGUMENT");
  }
  if (idempotencyKey && seenContinuations?.has(idempotencyKey)) {
    return {
      outcome: "already-applied",
      delegationId,
      newDelegationId: seenContinuations.get(idempotencyKey) as string,
    };
  }
  const latest = chain.latestDelegationId;
  if (latest && runningDelegationIds.has(latest)) {
    throw codedError(
      `Delegation "${delegationId}" is still running. Steer the live run instead of starting a second one.`,
      "CHAIN_BUSY",
    );
  }
  const expected =
    typeof ownership.expectedParentTurnId === "string"
      ? ownership.expectedParentTurnId.trim()
      : "";
  if (expected) {
    if (expected.length > 128) {
      throw codedError("expectedTurnId is invalid", "INVALID_ARGUMENT");
    }
    // An idle runtime adopts a host-begun execution turn after validation;
    // the delivery decision still separates attached from detached sources.
    if (ownership.allowFreshExecutionTurn && !ownership.runtimeRunning) {
      // Accepted as a fresh execution owner; adopted by the caller.
    } else if (expected !== ownership.currentTurnId || !ownership.turnAlive) {
      throw codedError("The target turn has ended", "TURN_NOT_FOUND");
    }
  } else if (ownership.runtimeRunning) {
    throw codedError(
      "Session has an active turn; pass its expectedTurnId to attach this continuation",
      "AGENT_BUSY",
    );
  }
  const { taskMessage, childMessage, toolCallId } = buildContinueSyntheticMessages({
    chain,
    delegationId,
    text: rawText.trim(),
    messageId: idempotencyKey,
    ...(request.attachments?.length ? { attachments: request.attachments } : {}),
  });
  return {
    outcome: "continue",
    delegationId,
    chain,
    text: rawText.trim(),
    images,
    ...(request.attachments?.length ? { attachments: request.attachments } : {}),
    toolCallId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    taskMessage,
    childMessage,
  };
}

/** The source-run fields the delivery decision reads. */
export type ContinueSourceState = {
  delegationId: string;
  /** `user`-owned sources never reattach on their own. */
  delivery?: SubagentDeliveryOwner;
  startedEpoch: number;
  reportDelivered: boolean;
  status: string;
};

/**
 * Decide who receives the new run's report. Attached (`parent`) only when the
 * source is parent-owned, started in the current parent epoch, undelivered,
 * not stopped/aborted, and its owning turn is still alive. Everything else is
 * detached (`user`): the source already reported, the parent moved on, or the
 * chain was never the parent's. A busy runtime with a detached source stays
 * busy — it must not attach to an unrelated live parent.
 */
export function decideContinueDelivery(
  source: ContinueSourceState | undefined,
  currentEpoch: number,
  turnAlive: boolean,
  runtimeRunning: boolean,
): { delivery: SubagentDeliveryOwner } | { rejected: "AGENT_BUSY" } {
  const attached =
    source !== undefined &&
    (source.delivery ?? "parent") === "parent" &&
    source.startedEpoch === currentEpoch &&
    !source.reportDelivered &&
    source.status !== "stopped" &&
    source.status !== "aborted" &&
    turnAlive;
  if (attached) return { delivery: "parent" };
  // Detached continuations never bill or wake an unrelated live parent turn.
  if (runtimeRunning) return { rejected: "AGENT_BUSY" };
  return { delivery: "user" };
}

/**
 * Map a failed `Task(resume)` spawn's detail text back to a coded rejection.
 * The spawn races authorization and settlement, so a chain that validated can
 * still fail here; the caller must see the same identities either way.
 */
export function mapContinueSpawnError(message: string): Error {
  const text = message.trim() || "Delegation could not be continued.";
  if (/still running/i.test(text)) {
    return codedError(text, "CHAIN_BUSY");
  }
  if (/unknown delegation|no longer available|delegation is unavailable/i.test(text)) {
    return codedError(text, "DELEGATION_NOT_FOUND");
  }
  if (/cannot be continued|no recorded history/i.test(text)) {
    return codedError(text, "NOT_RESUMABLE");
  }
  if (/target turn has ended|parent turn ended/i.test(text)) {
    return codedError(text, "TURN_NOT_FOUND");
  }
  if (/maximum|concurrency|too many/i.test(text)) {
    return codedError(text, "AGENT_BUSY");
  }
  return codedError(text, "AGENT_UNAVAILABLE");
}

/**
 * Build the two transcript rows a user-origin continuation persists.
 *
 * The `Task` marker row keeps the REAL `Task(resume)` invocation id (paired
 * with the provider tool call the runtime actually executed — never a minted
 * id) and carries `toolArgs.resume` plus `toolArgs.source: "user"` so chain
 * replay (`selectChainRows`) links it while the parent's model context skips
 * it. It is a parent row (no `parentToolCallId`): the envelope that emits it
 * must not tag it as a child. The child user row carries that invocation as
 * its `parentToolCallId` so replay links it while the parent context skips
 * it. No stray main user prompt is emitted: the parent never sees the
 * followup as its own input.
 */
export function buildContinueSyntheticMessages(options: {
  chain: Pick<ContinueChainState, "agentName">;
  /** The continued `delegationId` (any id on the chain). */
  delegationId: string;
  text: string;
  messageId?: string;
  /** Durable refs the echoed child row carries; an image-only input has none
   * of its own text, so the row reads as the image the user sent. */
  attachments?: MessageAttachment[];
  /** Real `Task(resume)` invocation id; mints only before the spawn assigns it. */
  toolCallId?: string;
}): { taskMessage: UiMessage; childMessage: UiMessage; toolCallId: string } {
  const toolCallId = options.toolCallId ?? randomUUID();
  const now = nowIso();
  const taskMessage: UiMessage = {
    id: toolCallId,
    role: "tool",
    content: JSON.stringify({
      content: [{ type: "text", text: `Delegation continued by the user.` }],
      details: {
        delegationId: toolCallId,
        agent: options.chain.agentName,
        status: "running",
        resumedFrom: options.delegationId,
      },
    }),
    createdAt: now,
    toolCallId,
    toolName: "Task",
    toolArgs: {
      agent: options.chain.agentName,
      task: options.text,
      resume: options.delegationId,
      source: "user",
    },
    toolStatus: "success",
    toolResult: {
      content: [{ type: "text", text: `Delegation continued by the user.` }],
      details: {
        delegationId: toolCallId,
        agent: options.chain.agentName,
        status: "running",
        resumedFrom: options.delegationId,
      },
    },
    toolCompletedAt: now,
    toolDurationMs: 0,
    status: "complete",
    isError: false,
    steering: true,
  };
  const childMessage: UiMessage = {
    id:
      options.messageId && isUuid(options.messageId)
        ? options.messageId
        : randomUUID(),
    role: "user",
    content: options.text,
    createdAt: now,
    status: "complete",
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    steering: true,
    parentToolCallId: toolCallId,
    agentName: options.chain.agentName,
  };
  return { taskMessage, childMessage, toolCallId };
}

/** Whether a persisted `Task` row is a user-origin marker, not a parent call. */
export function isUserContinueTaskRow(message: UiMessage): boolean {
  if (message.role !== "tool" || message.toolName !== "Task") return false;
  const args = message.toolArgs as Record<string, unknown> | undefined;
  return !!args && args.source === "user" && typeof args.resume === "string";
}

/**
 * Envelopes for the two continuation rows. The marker emits as a parent row
 * (no child tags — it IS the parent ledger entry); the followup emits tagged
 * so chain replay and the delegate transcript own it.
 */
export function continueEmissions(options: {
  sessionId: string;
  turnId: string;
  agentName: string;
  toolCallId: string;
  taskMessage: UiMessage;
  childMessage: UiMessage;
  now?: number;
}): { marker: AgentEventEnvelope; followup: AgentEventEnvelope } {
  const ts = options.now ?? Date.now();
  const base = { sessionId: options.sessionId, turnId: options.turnId, ts };
  return {
    marker: {
      ...base,
      event: { type: "message_end", message: options.taskMessage },
    },
    followup: {
      ...base,
      event: { type: "message_end", message: options.childMessage },
      parentToolCallId: options.toolCallId,
      agentName: options.agentName,
    },
  };
}

/**
 * Parse a sidecar `agent.continueSubagent` call. The runtime revalidates the
 * chain, decides delivery, and adopts the execution turn after this dispatch,
 * so a stale or busy target fails there with its coded error rather than
 * continuing the wrong chain here.
 */
export function parseContinueSidecarParams(params: unknown): {
  sessionId: string;
  delegationId: string;
  expectedTurnId?: string;
  content: string;
  images?: ImageContent[];
  attachments?: MessageAttachment[];
  messageId?: string;
} {
  const source = (params ?? {}) as Record<string, unknown>;
  const sessionId = typeof source.sessionId === "string" ? source.sessionId.trim() : "";
  const delegationId = typeof source.delegationId === "string" ? source.delegationId.trim() : "";
  const expectedTurnId =
    typeof source.expectedTurnId === "string" && source.expectedTurnId.trim()
      ? source.expectedTurnId.trim()
      : undefined;
  const content = typeof source.content === "string" ? source.content : "";
  const images = parseChildInputImages(source.images);
  const attachments = parseChildInputAttachments(source.attachments);
  const messageId =
    typeof source.messageId === "string" && source.messageId.trim()
      ? source.messageId.trim()
      : undefined;
  // An image-only continuation is valid: the user sent a picture with no words.
  if (!sessionId || !delegationId.trim() || (!content.trim() && images.length === 0)) {
    throw codedError("delegationId and content required", "INVALID_ARGUMENT");
  }
  if (delegationId.length > 128 || (expectedTurnId && expectedTurnId.length > 128) || content.length > 20_000) {
    throw codedError("continueSubagent payload out of bounds", "INVALID_ARGUMENT");
  }
  return {
    sessionId,
    delegationId,
    ...(expectedTurnId ? { expectedTurnId } : {}),
    content,
    ...(images.length ? { images } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

/**
 * Image blocks one child input carries over the sidecar transport.
 *
 * Electron main already resolved every path against the session roots,
 * enforced the size and count bounds, and coded each refusal; this parses the
 * transport form and re-checks the count so a hand-written sidecar call cannot
 * exceed what main allows. Malformed entries are dropped, never trusted.
 */
export function parseChildInputImages(value: unknown): ImageContent[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  if (value.length > MAX_CHILD_INPUT_IMAGES) {
    throw codedError("A subagent input carries too many images", "INVALID_ARGUMENT");
  }
  return value.flatMap((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const data = typeof record.data === "string" ? record.data.trim() : "";
    const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim().toLowerCase() : "";
    if (!data || !mimeType.startsWith("image/")) return [];
    return [{ type: "image" as const, data, mimeType }];
  });
}

/**
 * Durable refs one child input keeps on its own transcript row.
 *
 * `data` is deliberately dropped: the row renders from the content-addressed
 * ref, and base64 never belongs in persisted transcript state.
 */
export function parseChildInputAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const kind =
      record.kind === "image" ? "image" : record.kind === "file" ? "file" : undefined;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const ref = typeof record.ref === "string" ? record.ref.trim() : "";
    if (!kind || !name || !ref) return [];
    const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "";
    const inlinePath = typeof record.inlinePath === "string" ? record.inlinePath.trim() : "";
    return [
      {
        kind,
        name,
        ref,
        ...(mimeType ? { mimeType } : {}),
        ...(typeof record.size === "number" && Number.isFinite(record.size)
          ? { size: record.size }
          : {}),
        ...(inlinePath ? { inlinePath } : {}),
      },
    ];
  });
}

/**
 * Launch payload for hydrating an idle sidecar runtime after a restart.
 *
 * The host sends its normal launch preparation (`sidecarParams`: same model
 * binding, permissions, workspace) alongside the continuation when it owns
 * no live runtime. The sidecar reuses a live runtime when one exists and
 * only hydrates when absent: `runtimeFor` rebuilds history and chains from
 * the persisted transcript and constructs the runtime, without running a
 * parent model prompt before the child starts. Returns the params object
 * itself when it carries a usable launch; `undefined` when the caller sent
 * a bare continuation (preserves the previous `TURN_NOT_FOUND`).
 */
export function continueHydrationSource(params: unknown): Record<string, unknown> | undefined {
  const source = (params ?? {}) as Record<string, unknown>;
  const provider = source.provider as Record<string, unknown> | undefined;
  const shell = source.commandShell as Record<string, unknown> | undefined;
  if (!provider || typeof provider !== "object") return undefined;
  if (typeof (provider as { modelId?: unknown }).modelId !== "string") return undefined;
  if (!shell || typeof shell !== "object" || (shell as { available?: unknown }).available !== true) {
    return undefined;
  }
  return source;
}

/** Host state the continuation preparation reads; the runtime binds it. */
export type ContinueHostState = {
  turnId?: string;
  turnEpoch: number;
  disposed: boolean;
  runCancelled: boolean;
  turnHadError: boolean;
  /** Parent-scoped liveness: detached user runs never count as running. */
  isRunning: boolean;
  lookupChain: (delegationId: string) => DelegationChain | undefined;
  lookupRecord:
    | ((delegationId: string) => ContinueSourceState | undefined)
    | undefined;
  runningDelegationIds: ReadonlySet<string>;
  seenContinuations?: Map<string, string>;
  adoptExecutionTurn: (turnId: string) => void;
  mintTurnId: () => string;
};

export type PreparedSubagentContinue =
  | { outcome: "already-applied"; newDelegationId: string }
  | {
      outcome: "ready";
      validated: Extract<ValidatedSubagentContinue, { outcome: "continue" }>;
      delivery: SubagentDeliveryOwner;
      executionTurnId: string;
    };

/**
 * Validate, decide delivery, and adopt the execution owner without spawning.
 * Throws the same coded errors as the spawn path, before any state changes
 * except the idle execution-turn adoption (which touches no live parent).
 */
export function prepareSubagentContinue(
  request: {
    delegationId: unknown;
    text: unknown;
    messageId?: unknown;
    expectedParentTurnId?: unknown;
    attachments?: MessageAttachment[];
    images?: ImageContent[];
  },
  state: ContinueHostState,
): PreparedSubagentContinue {
  const delegationId =
    typeof request.delegationId === "string" ? request.delegationId.trim() : "";
  const chain = delegationId ? state.lookupChain(delegationId) : undefined;
  const turnAlive =
    !state.disposed && !state.runCancelled && !state.turnHadError && state.isRunning;
  const validated = validateSubagentContinue(
    chain,
    {
      delegationId: request.delegationId,
      text: request.text,
      messageId: request.messageId,
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
      ...(request.images?.length ? { images: request.images } : {}),
    },
    {
      expectedParentTurnId: request.expectedParentTurnId,
      currentTurnId: state.turnId,
      turnAlive,
      runtimeRunning: state.isRunning,
      allowFreshExecutionTurn: true,
    },
    state.runningDelegationIds,
    state.seenContinuations,
  );
  if (validated.outcome === "already-applied") {
    return { outcome: "already-applied", newDelegationId: validated.newDelegationId };
  }
  const source =
    (delegationId ? state.lookupRecord?.(delegationId) : undefined) ??
    (chain?.latestDelegationId
      ? state.lookupRecord?.(chain.latestDelegationId)
      : undefined);
  const decision = decideContinueDelivery(
    source ?? undefined,
    state.turnEpoch,
    turnAlive,
    state.isRunning,
  );
  if ("rejected" in decision) {
    throw codedError(
      "Session has an active turn unrelated to this delegation; stop it or wait for it to settle before continuing here",
      "AGENT_BUSY",
    );
  }
  if (decision.delivery === "parent") {
    if (!state.turnId) throw codedError("The target turn has ended", "TURN_NOT_FOUND");
    return { outcome: "ready", validated, delivery: "parent", executionTurnId: state.turnId };
  }
  const expected =
    typeof request.expectedParentTurnId === "string"
      ? request.expectedParentTurnId.trim()
      : "";
  // Detached runs execute under their own accounting turn: the host-begun id
  // when provided, a minted local owner otherwise. No parent prompt runs.
  const executionTurnId = expected || state.mintTurnId();
  if (executionTurnId !== state.turnId) state.adoptExecutionTurn(executionTurnId);
  return { outcome: "ready", validated, delivery: "user", executionTurnId };
}

/** Spawn-target lookup for a prepared continuation; throws coded errors. */
export function resolveContinueSpawnTarget<Definition, TaskTool>(options: {
  definitions: readonly Definition[];
  nameOf: (definition: Definition) => string;
  agentName: string;
  taskTool: TaskTool | undefined;
}): { definition: Definition; taskTool: TaskTool } {
  const definition = options.definitions.find(
    (candidate) => options.nameOf(candidate) === options.agentName,
  );
  if (!definition) {
    throw codedError(
      `Subagent "${options.agentName}" is no longer available.`,
      "DELEGATION_NOT_FOUND",
    );
  }
  if (!options.taskTool) {
    throw codedError("Delegation is unavailable in this session", "AGENT_UNAVAILABLE");
  }
  return { definition, taskTool: options.taskTool };
}

/**
 * Repoint the marker at the spawned run and build every emission for it.
 * The marker keeps the real invocation id and the user-origin tag; the
 * followup links through that id. Neither enters the parent model context.
 */
export function buildContinueSpawnEmissions(options: {
  sessionId: string;
  executionTurnId: string;
  agentName: string;
  validated: Extract<ValidatedSubagentContinue, { outcome: "continue" }>;
  newDelegationId: string;
  now?: number;
}): {
  taskMessage: UiMessage;
  appendEnvelope: AgentEventEnvelope;
  markerStart: AgentEventEnvelope;
  markerEnd: AgentEventEnvelope;
  followupStart: AgentEventEnvelope;
  followupEnd: AgentEventEnvelope;
} {
  const { validated, newDelegationId } = options;
  // The marker is the run's parent ledger row, so it names the run's own
  // execution turn: a tab reopened later reads it back from the persisted row
  // instead of guessing which turn owns the continuation's steering.
  const details = {
    delegationId: newDelegationId,
    agent: options.agentName,
    status: "running",
    resumedFrom: validated.delegationId,
    executionTurnId: options.executionTurnId,
  };
  const taskMessage: UiMessage = {
    ...validated.taskMessage,
    content: JSON.stringify({
      content: [{ type: "text", text: `Delegation continued by the user.` }],
      details,
    }),
    toolResult: {
      content: [{ type: "text", text: `Delegation continued by the user.` }],
      details,
    },
  };
  const emissions = continueEmissions({
    sessionId: options.sessionId,
    turnId: options.executionTurnId,
    agentName: options.agentName,
    toolCallId: validated.toolCallId,
    taskMessage,
    childMessage: validated.childMessage,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const ts = options.now ?? Date.now();
  const base = { sessionId: options.sessionId, turnId: options.executionTurnId, ts };
  return {
    taskMessage,
    appendEnvelope: {
      ...base,
      event: { type: "message_end", message: validated.childMessage },
      parentToolCallId: validated.toolCallId,
      agentName: options.agentName,
    },
    markerStart: {
      ...base,
      event: { type: "message_start", message: taskMessage },
    },
    markerEnd: emissions.marker,
    followupStart: {
      ...base,
      event: { type: "message_start", message: validated.childMessage },
      parentToolCallId: validated.toolCallId,
      agentName: options.agentName,
    },
    followupEnd: emissions.followup,
  };
}

/**
 * Delegate tool scope for one run: same permission/mutation Owner as `Task`.
 * The ledger stays optional so direct callers (and older call shapes) keep
 * working: without an owners binding the scope still applies, it is just not
 * recorded in the runtime maps.
 */
export function scopeDelegateTools(
  tools: AgentTool[],
  definition: SubagentDefinition,
  mutationOwner: string,
  worktreeKey?: string | undefined,
  owners?: {
    mutationOwners: Map<string, string>;
    permissionScopes: Map<string, unknown>;
    worktrees: Map<string, string>;
  },
): AgentTool[] {
  const scope = definition.permission ?? DEFAULT_SUBAGENT_PERMISSION;
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      owners?.mutationOwners.set(toolCallId, mutationOwner);
      if (scope !== DEFAULT_SUBAGENT_PERMISSION) {
        owners?.permissionScopes.set(toolCallId, scope);
      }
      if (worktreeKey) owners?.worktrees.set(toolCallId, worktreeKey);
      try {
        return await tool.execute(toolCallId, args, signal, onUpdate);
      } finally {
        owners?.permissionScopes.delete(toolCallId);
        owners?.worktrees.delete(toolCallId);
        owners?.mutationOwners.delete(toolCallId);
      }
    },
  }));
}

/** Whether a delegate needs its own worktree (ADR 0329, Q11). */
export function delegateNeedsWorktree(
  workspaceRoot: string | undefined,
  toolNames: readonly string[],
): boolean {
  return (
    workspaceRoot !== undefined &&
    toolNames.some((name) => name === "Write" || name === "Edit")
  );
}
