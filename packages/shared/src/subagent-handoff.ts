import type { MessageAttachment } from "./types.js";

/**
 * Subagent self-handoff: a running delegate rolls its own model context over,
 * on its own terms, without ending the delegation.
 *
 * A delegate's context grows exactly like a session's, but a delegate has no
 * durable checkpoint of its own — compaction (ADR 0299) rewrites the request
 * blindly with a provider summary. Self-handoff is the model-authored
 * alternative: at a safe turn boundary the runtime asks the delegate to submit
 * a structured handoff (completed work, checks, binding decisions, remaining
 * work, pending operations), and a valid submission replaces the previous
 * handoff plus the execution segment it absorbed, keeping the original
 * dispatch prompt as an immutable header. The same run, identity, worktree,
 * cancellation handle, and report relationship continue; nothing settles.
 *
 * Shape is one setting, matching the wake contract's single-select discipline:
 * - `kind: "context-tokens"` — hand off when the next request's occupancy
 *   (system prompt, tool schemas, and messages, not cumulative spend) crosses N.
 * - `kind: "tool-calls"` — hand off after each additional N tool calls.
 * - `kind: "runtime"` — hand off after N elapsed minutes of the segment.
 * - `kind: "off"` — no self-handoff (the product default; absent settings,
 *   including every settings document written before this feature, read here).
 *
 * Units: the stored value is always the canonical runtime unit — tokens,
 * integer calls, and seconds — so persistence stays integer and comparable.
 * Only the settings UI converts: k tokens for `context-tokens`, minutes for
 * `runtime`. The conversions live here so the runtime, the renderer, and the
 * settings validators cannot drift apart.
 */

/** `context-tokens` is an occupancy estimate, so the floor stays coarse. */
export const MIN_SUBAGENT_HANDOFF_TOKENS = 1_000;
export const MAX_SUBAGENT_HANDOFF_TOKENS = 1_000_000;
/**
 * Remembered default when the context threshold kind is selected: 200k
 * tokens, the same figure the wake trigger uses.
 */
export const DEFAULT_SUBAGENT_HANDOFF_TOKENS = 200_000;
/** The settings UI edits context thresholds in thousands of tokens. */
export const SUBAGENT_HANDOFF_TOKENS_PER_K = 1_000;

/** `tool-calls` counts calls inside the current segment; below 1 is meaningless. */
export const MIN_SUBAGENT_HANDOFF_TOOL_CALLS = 1;
export const MAX_SUBAGENT_HANDOFF_TOOL_CALLS = 10_000;
/** Remembered default when the tool-call kind is selected. */
export const DEFAULT_SUBAGENT_HANDOFF_TOOL_CALLS = 50;

/**
 * `runtime` is stored in seconds and edited in whole minutes. The user-set
 * ceiling is 300 minutes; the floor stays one minute.
 */
export const MIN_SUBAGENT_HANDOFF_RUNTIME_SECONDS = 60;
export const MAX_SUBAGENT_HANDOFF_RUNTIME_SECONDS = 300 * 60;
/** Remembered default when the runtime kind is selected: 15 minutes. */
export const DEFAULT_SUBAGENT_HANDOFF_RUNTIME_SECONDS = 15 * 60;
export const SECONDS_PER_MINUTE = 60;

/** The single selectable self-handoff trigger. */
export type SubagentSelfHandoffKind =
  | "off"
  | "context-tokens"
  | "tool-calls"
  | "runtime";

/** Canonical stored shape. `off` carries no value; every other kind requires one. */
export type SubagentSelfHandoffSettings = {
  kind: SubagentSelfHandoffKind;
  value?: number;
};

/** Canonical with every default applied. */
export type ResolvedSubagentSelfHandoffSettings = {
  kind: SubagentSelfHandoffKind;
  value?: number;
};

/** Product default: self-handoff off, i.e. the behavior before this feature. */
export const DEFAULT_SUBAGENT_SELF_HANDOFF_SETTINGS: SubagentSelfHandoffSettings = {
  kind: "off",
};

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function isSelfHandoffKind(value: unknown): value is SubagentSelfHandoffKind {
  return (
    value === "off" ||
    value === "context-tokens" ||
    value === "tool-calls" ||
    value === "runtime"
  );
}

/** Per-kind default used when a kind is selected without a valid value. */
export function defaultSubagentSelfHandoffValue(
  kind: SubagentSelfHandoffKind,
): number | undefined {
  if (kind === "context-tokens") return DEFAULT_SUBAGENT_HANDOFF_TOKENS;
  if (kind === "tool-calls") return DEFAULT_SUBAGENT_HANDOFF_TOOL_CALLS;
  if (kind === "runtime") return DEFAULT_SUBAGENT_HANDOFF_RUNTIME_SECONDS;
  return undefined;
}

/** Bounds for one kind: `[min, max]` in that kind's stored unit. */
export function subagentSelfHandoffBounds(
  kind: SubagentSelfHandoffKind,
): readonly [number, number] | null {
  if (kind === "context-tokens") {
    return [MIN_SUBAGENT_HANDOFF_TOKENS, MAX_SUBAGENT_HANDOFF_TOKENS] as const;
  }
  if (kind === "tool-calls") {
    return [MIN_SUBAGENT_HANDOFF_TOOL_CALLS, MAX_SUBAGENT_HANDOFF_TOOL_CALLS] as const;
  }
  if (kind === "runtime") {
    return [
      MIN_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
      MAX_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
    ] as const;
  }
  return null;
}

function clampHandoffValue(kind: SubagentSelfHandoffKind, value: number): number {
  const bounds = subagentSelfHandoffBounds(kind);
  if (!bounds) return DEFAULT_SUBAGENT_HANDOFF_TOKENS;
  return clampInt(value, bounds[0], bounds[1]);
}

/**
 * Apply defaults and bounds to a stored or incoming section.
 *
 * Anything that is not a well-shaped enabled kind — absent, `null`, a legacy or
 * unknown shape, a mistyped value, or a non-positive number — resolves to
 * `off`. Defaulting a broken selection to "off" is the only safe direction:
 * an accidental handoff costs an extra provider round trip on every delegate,
 * while a disabled one only costs the feature.
 */
export function normalizeSubagentSelfHandoffSettings(
  input?: SubagentSelfHandoffSettings | null,
): ResolvedSubagentSelfHandoffSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { kind: "off" };
  }
  const candidate = input as Record<string, unknown>;
  if (!isSelfHandoffKind(candidate.kind)) return { kind: "off" };
  if (candidate.kind === "off") return { kind: "off" };
  const fallback = defaultSubagentSelfHandoffValue(candidate.kind);
  const value = candidate.value;
  // Below one whole unit a value is meaningless — it would ask for a handoff on
  // every boundary — so it falls back to the kind's remembered default instead
  // of clamping up, exactly as the wake contract treats its own sub-unit values.
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return { kind: candidate.kind, value: clampHandoffValue(candidate.kind, value) };
  }
  return {
    kind: candidate.kind,
    value: clampHandoffValue(candidate.kind, fallback ?? 0),
  };
}

/**
 * Shape check for a stored or incoming section (settings writes, IPC).
 *
 * Types only: range clamping stays with the normalizer, so a write that is
 * merely out of range still lands and reads back clamped, while a value of the
 * wrong type is rejected at the boundary.
 */
export function isSubagentSelfHandoffSettings(
  value: unknown,
): value is SubagentSelfHandoffSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isSelfHandoffKind(candidate.kind)) return false;
  if (candidate.kind === "off") return candidate.value === undefined;
  if (candidate.value !== undefined) {
    if (typeof candidate.value !== "number" || !Number.isFinite(candidate.value)) {
      return false;
    }
  }
  return true;
}

/** Whether the section enables one of the three handoff triggers. */
export function subagentSelfHandoffEnabled(
  settings: Pick<SubagentSelfHandoffSettings, "kind"> | null | undefined,
): boolean {
  return settings?.kind !== undefined && settings.kind !== "off";
}

/** Stored tokens → the k-token figure the settings UI edits. */
export function subagentHandoffTokensToKTokens(tokens: number): number {
  return tokens / SUBAGENT_HANDOFF_TOKENS_PER_K;
}

/** The k-token figure the settings UI edits → stored tokens. */
export function subagentHandoffKTokensToTokens(kTokens: number): number {
  return Math.round(kTokens * SUBAGENT_HANDOFF_TOKENS_PER_K);
}

/** Stored seconds → the minute figure the settings UI edits. */
export function subagentHandoffSecondsToMinutes(seconds: number): number {
  return seconds / SECONDS_PER_MINUTE;
}

/** The minute figure the settings UI edits → stored seconds. */
export function subagentHandoffMinutesToSeconds(minutes: number): number {
  return Math.round(minutes * SECONDS_PER_MINUTE);
}

/**
 * One user instruction a durable checkpoint restores verbatim.
 *
 * `text` is carried so a restored run still receives the instruction when its
 * persisted row is gone; `rowId` is the provenance of the row that actually
 * delivered it, so two intentionally identical instructions stay two rows in
 * delivery order. Attachments ride as durable refs only — never bytes — and a
 * resume hydrates them exactly like a replayed child row.
 *
 * A `Task` invocation is itself an instruction, and its `toolCallId` is the
 * identity that survives while a run has no child row of its own (a parent
 * `Task(resume)` delivers its text as the resumed run's opening turn). Two
 * independently delivered instructions with the same text therefore stay two
 * directives even when neither has a child echo row.
 */
export type DelegationHandoffDirective = {
  /** `Task` toolCallId that delivered this instruction, when one did. */
  toolCallId?: string;
  /** Id of the persisted child row that delivered this instruction. */
  rowId?: string;
  /** The instruction exactly as delivered. */
  text: string;
  /** Durable attachment refs (no inline bytes). */
  attachments?: MessageAttachment[];
  /** True for the chain's opening task, which is not a persisted child row. */
  opening?: boolean;
};

/**
 * The durable record of one installed self-handoff — the boundary a later
 * `Task(resume)` must honour.
 *
 * It is written only after the delegate's in-memory context was actually
 * replaced, never when a submission was merely accepted, so the recorded
 * boundary always describes a context that existed. `throughRowId` is a stable
 * cursor over persisted child rows: the last absorbed row, by identity, not by
 * timestamp. The head (`originalTask` + `directives` + `summary`) and the rows
 * after the cursor reconstruct the installed context without replaying the
 * execution history the handoff already absorbed.
 *
 * The record lives on the delegation's `Task` row details (open JSON that the
 * host already persists and rewrites in place), so it needs no schema change,
 * no migration, and never enters the parent's model context.
 */
export type DelegationHandoffCheckpoint = {
  /** Record version; an unknown version is not restored. */
  version: typeof DELEGATION_HANDOFF_CHECKPOINT_VERSION;
  /** Chain identity: stable across every `Task(resume)` of this conversation. */
  delegateSessionId: string;
  /** The delegation whose run installed this context. */
  delegationId: string;
  /** The `Task` toolCallId that started that run — the source request. */
  sourceToolCallId: string;
  agentName: string;
  /** 1-based generation of the installed handoff within the chain. */
  generation: number;
  /** Last persisted child row the installed context absorbed. */
  throughRowId: string;
  /** The summary message exactly as installed (framing plus authored text). */
  summary: string;
  /** The chain's original task, replayed first on resume. */
  originalTask: string;
  /** Delivered user directions in delivery order, each exactly once. */
  directives: DelegationHandoffDirective[];
  /** RFC3339 stamp of the install, for ordering two checkpoints. */
  installedAt: string;
};

/** The checkpoint record shape this build reads and writes. */
export const DELEGATION_HANDOFF_CHECKPOINT_VERSION = 1;

/**
 * Shape check for one directive a stored or incoming checkpoint records.
 *
 * A directive needs the text it restores; its identity and durable refs are
 * optional because an opening task has no child row and a text-only direction
 * has no attachments.
 */
export function isDelegationHandoffDirective(
  value: unknown,
): value is DelegationHandoffDirective {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.text !== "string") return false;
  for (const key of ["toolCallId", "rowId"] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
      return false;
    }
  }
  if (candidate.attachments !== undefined) {
    if (!Array.isArray(candidate.attachments)) return false;
    for (const attachment of candidate.attachments) {
      if (!attachment || typeof attachment !== "object") return false;
      const a = attachment as Record<string, unknown>;
      if (typeof a.kind !== "string" || typeof a.name !== "string") return false;
      if (typeof a.ref !== "string") return false;
    }
  }
  return true;
}

/**
 * Shape check for a stored or incoming checkpoint.
 *
 * A record that fails this check is not a boundary this build can restore: an
 * unknown version, a missing cursor, an empty summary, or a malformed
 * directive all read as "no checkpoint", which keeps the pre-checkpoint
 * full-history seed as the fallback instead of installing half a context.
 */
export function isDelegationHandoffCheckpoint(
  value: unknown,
): value is DelegationHandoffCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== DELEGATION_HANDOFF_CHECKPOINT_VERSION) return false;
  for (const key of [
    "delegateSessionId",
    "delegationId",
    "sourceToolCallId",
    "agentName",
    "throughRowId",
    "summary",
    "installedAt",
  ] as const) {
    if (typeof candidate[key] !== "string" || !(candidate[key] as string).trim()) {
      return false;
    }
  }
  if (typeof candidate.originalTask !== "string") return false;
  if (
    typeof candidate.generation !== "number" ||
    !Number.isInteger(candidate.generation) ||
    candidate.generation < 1
  ) {
    return false;
  }
  const directives = candidate.directives;
  if (!Array.isArray(directives)) return false;
  return directives.every(isDelegationHandoffDirective);
}

/**
 * The latest checkpoint a caller may restore, or `undefined` when none is
 * valid. Consecutive generations are ordered by `generation` first and
 * `installedAt` second, so a record rebuilt from a transcript picks the newest
 * install regardless of the order the `Task` rows appear in.
 */
export function latestDelegationHandoffCheckpoint(
  values: readonly unknown[],
): DelegationHandoffCheckpoint | undefined {
  let latest: DelegationHandoffCheckpoint | undefined;
  for (const value of values) {
    if (!isDelegationHandoffCheckpoint(value)) continue;
    if (!latest) {
      latest = value;
      continue;
    }
    if (value.generation > latest.generation) {
      latest = value;
      continue;
    }
    if (
      value.generation === latest.generation &&
      value.installedAt > latest.installedAt
    ) {
      latest = value;
    }
  }
  return latest;
}
