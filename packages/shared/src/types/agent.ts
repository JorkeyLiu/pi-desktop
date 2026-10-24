/** Shared public types grouped by the owning application domain. */
import type { AppError } from "../errors.js";
import type { PlanExecution, PlanningStateEvent } from "./plans.js";
import type { ContextCompactionFallback, ContextCompactionMark, ContextCompactionReason } from "./sessions.js";
import type { AgentStatus } from "./sessions.js";
import type { MessageUsage, ToolTokenUsage, UiMessage, VoiceOrigin } from "./messages.js";
import type { PermissionDecision, Risk } from "./permissions.js";
import type { ThinkingLevel } from "./models.js";
import type { RacpPermissionMode } from "../racp.js";

export type AgentPromptRequest = {
  sessionId: string;
  content: string;
  /** Host-owned collaboration delivery; its durable record supplies the input. */
  sessionMessageId?: string;
  /** Attachments are resolved by Electron main and never trusted by the sidecar. */
  attachments?: AgentPromptAttachment[];
  /**
   * When set, truncate the durable transcript to this many leading messages
   * before appending the new user turn. Used by regenerate / edit-resend so
   * the branch replaces the tail instead of stacking a duplicate turn.
   *
   * Prefer `truncateFromMessageId`: a count is only correct when the renderer
   * holds the entire history, and it is kept for older callers.
   */
  truncateBefore?: number;
  /**
   * Identity of the first message to drop. The host resolves it against its own
   * transcript, so a bounded window or a deduplicated renderer array cannot
   * shift the cut. Takes precedence over `truncateBefore`.
   */
  truncateFromMessageId?: string;
  /**
   * Renderer-chosen id for the new user message (D288). The renderer inserts
   * the row under this id before the host round trip, and the host persists
   * and echoes the durable row under the same id so the echo replaces the
   * optimistic row in place instead of adding a second one. Must be a UUID
   * that is not already in the session; anything else is ignored and the host
   * mints its own.
   */
  messageId?: string;
  /** Main-trusted source metadata for a Live Voice work admission. */
  voiceOrigin?: VoiceOrigin;
  /**
   * Renderer snapshot of the chat session visible when the prompt was sent.
   * Electron installs it before asynchronous turn setup for notification
   * suppression; missing, null, or mismatched values fail safe.
   */
  viewingSessionId?: string | null;
  /**
   * Per-turn permission ceiling override (spec §7.3): the effective mode the
   * remote layer computed for this specific turn, which the runtime must apply
   * for tool decisions instead of the session's stored mode. Absent means the
   * session's stored mode is used. Accepted only when the requested mode is
   * narrower than or equal to the session's mode; a wider request is refused
   * before the turn starts. The bridge forwards this end-to-end so the
   * host-core scoping (still pending, R1 leftover) can enforce it turn-locally
   * once it lands.
   */
  permissionMode?: RacpPermissionMode;
};

export type AgentPromptAttachment = {
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  size?: number;
  /**
   * The `@path` text this attachment occupies inline in `content`. Electron main
   * fills it for an attachment the user's draft placed between words, so the
   * runtime keeps the image block at that position instead of trailing the
   * prompt text. Absent for older callers and formatted messages.
   */
  inlinePath?: string;
};

export type AgentSteerRequest = Pick<
  AgentPromptRequest,
  "sessionId" | "content" | "attachments" | "messageId" | "voiceOrigin"
> & {
  expectedTurnId: string;
};

export type AgentPromptResponse = {
  accepted: boolean;
  turnId: string;
};

export type AgentExecuteApprovedPlanRequest = {
  sessionId: string;
  turnId: string;
  execution: PlanExecution;
};

export type AgentExecuteApprovedPlanResponse = {
  accepted: boolean;
  turnId: string;
};

export type AgentAbortRequest = {
  sessionId: string;
  turnId?: string;
};

/** Request a stop at the next completed agent turn boundary. */
export type AgentStopRequest = {
  sessionId: string;
  turnId?: string;
};

export type AgentStopResponse = {
  requested: boolean;
};

/** One entry of the Host-owned turn queue as the renderer mirrors it (D386). */
export type QueuedTurnSummary = {
  id: string;
  sessionId: string;
  content: string;
  sessionMessageId?: string;
  userMessageId?: string;
  voiceOrigin?: VoiceOrigin;
  attachments?: AgentPromptAttachment[];
  position: number;
  /** Set only for promoted entries; entries arrive in delivery order. */
  priority?: number;
  createdAt: string;
};

export type AgentQueuePushRequest = {
  sessionId: string;
  content: string;
  sessionMessageId?: string;
  userMessageId?: string;
  voiceOrigin?: VoiceOrigin;
  attachments?: AgentPromptAttachment[];
  idempotencyKey?: string;
};

export type AgentQueueChangedEvent = {
  sessionId: string;
  entries: QueuedTurnSummary[];
};

export type AgentCompactRequest = {
  sessionId: string;
};

export type AgentCompactResponse = {
  accepted: boolean;
};

export type ToolPermissionRequest = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argsPreview: unknown;
  risk: Risk;
  reason: string;
  /** Subagent that asked, when the call came from a delegate (ADR 0062). */
  agentName?: string;
  /** `Task` call that spawned the asking delegate. */
  parentToolCallId?: string;
  /** Immediate tool parent when this request came from nested execution. */
  nestedParentToolCallId?: string;
};

export type ToolPermissionResolution = {
  requestId: string;
  decision: PermissionDecision;
};

/** A selectable asktool answer: a plain label or a label with supporting copy. */
export type AskToolOption =
  | string
  | {
      label: string;
      description?: string;
    };

/** Maximum length of one asktool prompt, counted in Unicode code points. */
export const MAX_ASK_TOOL_QUESTION_CHARS = 300;

export function isAskToolQuestionWithinLimit(question: string): boolean {
  let characterCount = 0;
  for (const _character of question) {
    if (characterCount >= MAX_ASK_TOOL_QUESTION_CHARS) return false;
    characterCount += 1;
  }
  return true;
}

/** Normalize a model-provided asktool option and discard malformed/empty values. */
export function normalizeAskToolOption(value: unknown): AskToolOption | undefined {
  if (typeof value === "string") {
    const label = value.trim();
    return label || undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const option = value as Record<string, unknown>;
  const label = typeof option.label === "string" ? option.label.trim() : "";
  if (!label) return undefined;
  const description =
    typeof option.description === "string" ? option.description.trim() : "";
  return description ? { label, description } : { label };
}

export function askToolOptionLabel(option: AskToolOption): string {
  return typeof option === "string" ? option : option.label;
}

export function askToolOptionDescription(
  option: AskToolOption,
): string | undefined {
  if (typeof option === "string") return undefined;
  const description = option.description?.trim();
  return description || undefined;
}

/** A model-created question shown in the inline asktool card. */
export type AskToolQuestion = {
  question: string;
  options: AskToolOption[];
  multiSelect?: boolean;
};

export type AskToolRequest = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  questions: AskToolQuestion[];
};

/**
 * Every interactive request one session is currently waiting on. Host state,
 * not connection state: a renderer that reloaded reads this instead of holding
 * a card that no longer exists, and it stays empty for a session with nothing
 * pending.
 */
export type PendingInteractiveRequests = {
  asks: AskToolRequest[];
  permissions: ToolPermissionRequest[];
};

/** `null` means the user skipped that question or declined the whole prompt. */
export type AskToolResolution = {
  requestId: string;
  sessionId: string;
  answers: Array<string[] | null>;
};

/** Stable model-facing serialization for one asktool result. */
export function formatAskToolOutput(
  questions: AskToolQuestion[],
  answers: Array<string[] | null>,
): string {
  return questions
    .map((question, index) => {
      const answer = answers[index]?.join("、") ?? "";
      return `${question.question}：${answer}`;
    })
    .join("\n---\n");
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messageIds: string[] }
  | { type: "turn_start" }
  | { type: "usage"; usage: MessageUsage }
  | { type: "turn_end"; subagentUsage?: MessageUsage }
  | { type: "message_start"; message: UiMessage }
  | {
      type: "message_update";
      message: UiMessage;
      deltaText?: string;
      deltaThinking?: string;
      /**
       * Append-only streaming frame. Growing `content` / `thinking` are omitted
       * from `message`; apply `deltaText` / `deltaThinking` onto the live row.
       * Snapshot replacements omit this field and still carry a full `message`.
       */
      stream?: "delta";
      resetText?: boolean;
      resetThinking?: boolean;
    }
  | { type: "message_end"; message: UiMessage; precedingAssistant?: UiMessage; replacesMessageId?: string }
  | { type: "user_message_persisted"; optimisticMessageId: string; message: UiMessage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; partialResult?: unknown }
  | {
      type: "tool_end";
      toolCallId: string;
      result: unknown;
      isError?: boolean;
      toolUsage?: ToolTokenUsage;
    }
  | ({ type: "planning_state" } & Omit<PlanningStateEvent, "sessionId">)
  | { type: "tool_permission_request"; request: ToolPermissionRequest }
  | { type: "asktool_request"; request: AskToolRequest }
  | {
      type: "compaction_start";
      reason: ContextCompactionReason;
    }
  | {
      type: "compaction_end";
      reason: ContextCompactionReason;
      ok: boolean;
      tokensBefore?: number;
      firstKeptMessageId?: string;
      willRetry: boolean;
      fallback?: ContextCompactionFallback;
      /** Present when a checkpoint was installed: it feeds the transcript row
       * and the context inspector. */
      mark?: ContextCompactionMark;
      error?: { code: string; message: string };
    }
  | { type: "error"; error: AppError }
  | { type: "status"; status: AgentStatus };

export type AgentEventEnvelope = {
  sessionId: string;
  turnId?: string;
  ts: number;
  event: AgentEvent;
  /**
   * Set on every event emitted from inside a subagent (ADR 0062): the `Task`
   * tool call that owns the delegate. Main tags persisted rows with it and
   * skips the turn-lifecycle handling that belongs to the parent alone.
   */
  parentToolCallId?: string;
  /** Immediate nested-tool parent; never identifies subagent ownership. */
  nestedParentToolCallId?: string;
  /** Definition name of the emitting subagent. */
  agentName?: string;
};

/** Explicit user cancellation; omitted IDs select this session's running delegates. */
export type AgentStopSubagentsRequest = {
  sessionId: string;
  delegationIds?: string[];
};

export type AgentStopSubagentsResponse = {
  pending: string[];
};

/**
 * User text steered into one live delegate (child steer).
 *
 * The delegate keeps running under its own tools: steering appends a user
 * turn to the child's conversation, never to the parent's model context. The
 * text is echoed into the child transcript with `parentToolCallId` /
 * `agentName` attribution so chain replay (`Task.resume`) sees exactly what
 * the resumed run saw. Nested `Task` and `asktool` stay denied inside the
 * child: steering changes its input, never its tool set.
 */
export type AgentSteerSubagentRequest = {
  sessionId: string;
  /** `delegationId` returned by `Task` for the running delegate. */
  delegationId: string;
  /**
   * Turn owning this steering: the live parent turn for an attached delegate,
   * the delegate's execution-accounting turn for a detached user-owned run.
   * Refused once that owner ends.
   */
  expectedTurnId: string;
  /**
   * The user's text for the child. Empty is allowed when `attachments` carries
   * at least one image: an image-only steer still reaches the child model.
   */
  content: string;
  /**
   * Images the user attached to the child's own input. Electron main resolves
   * every path against the session roots and inlines the bytes for the child
   * provider; they never enter the parent turn's context. Optional and
   * additive: a caller that sends text only keeps the previous behavior.
   */
  attachments?: AgentPromptAttachment[];
  /** Renderer-chosen id for the echoed user row (D288-style dedup). */
  messageId?: string;
};

export type AgentSteerSubagentResponse = {
  accepted: true;
  delegationId: string;
  turnId: string;
};

/**
 * Who receives a delegation run's report.
 *
 * - `parent`: the run was spawned by the parent model (`Task`/`Task(resume)`)
 *   or by an attached user continuation the parent still expects. Its report
 *   delivers through `TaskWait`/idle resume exactly once.
 * - `user`: the run was continued directly by the user after the parent
 *   stopped expecting this chain (report delivered, parent turn ended, or
 *   detached). Its report never auto-delivers to the parent model; only an
 *   explicit parent `Task(resume)` reattaches the chain. Absent means
 *   `parent` (backward-compatible default).
 */
export type SubagentDeliveryOwner = "parent" | "user";

/**
 * User text continuing one settled delegate as a new run of the SAME chain
 * (direct child followup).
 *
 * Running delegates use `AgentSteerSubagentRequest`; this request continues a
 * settled chain without asking the parent model to emit `Task(resume)` first.
 * How the run ended is history, never a permanent continuation ban: every
 * settled execution continues — the recorded outcomes `completed`, `failed`,
 * `aborted`, and `timed_out`, including a run surfaced as `stopped` (explicit
 * stop) or `interrupted` (app closed mid-run). A child stopped before its
 * first transcript event has no retained rows and still continues, seeded from
 * the chain's original brief. The runtime spawns the new run with the chain's
 * model/tools/permissions through the same spawn path as `Task(resume)`,
 * persists a user-origin `Task` marker row (`toolArgs.resume`,
 * `toolArgs.source: "user"`) for ledger and replay without entering the parent
 * model context, and attributes the followup text to the child. `expectedTurnId`
 * is only a stale guard: the server decides `parent` vs `user` delivery from
 * the source record (attached while the parent expects this chain, detached
 * otherwise).
 */
export type AgentContinueSubagentRequest = {
  sessionId: string;
  /** Any `delegationId` on the chain to continue. */
  delegationId: string;
  /**
   * The user's followup text for the child. Empty is allowed when
   * `attachments` carries at least one image.
   */
  content: string;
  /**
   * Images the user attached to the continuation. Same resolution and limits
   * as a child steer: Electron main confines every path to the session roots
   * and inlines the bytes for the child provider; nothing enters the parent
   * turn's context and no base64 is persisted in the transcript.
   */
  attachments?: AgentPromptAttachment[];
  /** Renderer-chosen id for idempotent retries (D288-style dedup). */
  messageId?: string;
  /**
   * Stale guard naming the turn the caller saw. Attached continuations name
   * the live parent turn; detached continuations name the execution-accounting
   * turn the host opened (or omit it when the host owns no turn yet).
   */
  expectedTurnId?: string;
};

export type AgentContinueSubagentResponse = {
  accepted: true;
  /** The new run's `delegationId` (same chain, new run). */
  delegationId: string;
  /**
   * Turn owning the continuation: the live parent turn when attached, the
   * child execution-accounting turn when detached. Omitted only when the
   * runtime minted a local execution owner the host did not begin.
   */
  turnId?: string;
  /** Who receives this run's report. */
  delivery: SubagentDeliveryOwner;
};
