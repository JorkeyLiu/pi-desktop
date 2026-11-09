/**
 * A delegate's self-handoff: threshold bookkeeping, the submission tool, and
 * the context it installs.
 *
 * The runtime never composes a handoff on the model's behalf. At a safe turn
 * boundary it *asks* — one user message in the request context, not in the
 * durable transcript — and the model answers by calling
 * `SUBAGENT_HANDOFF_TOOL_NAME` with one free-form text: the handoff it wants
 * its future self to read. A valid submission is held until the next boundary,
 * where it replaces the previous handoff and the execution segment it absorbed,
 * while the original dispatch header and every user direction the delegate was
 * given stay in place. The run, its identity, its worktree, its cancellation
 * handle, and its single report relationship are all unaffected: a handoff is a
 * context operation, not a lifecycle event.
 *
 * The submission is deliberately unstructured. What a continuation needs
 * depends on the task, so the runtime does not impose a field list: the
 * delegate organizes its own continuation, and the runtime only requires that
 * something was written and bounds its size. A fixed field checklist would
 * force filler into the fields a task does not have and lose what it does.
 *
 * Successful rollovers are deliberately uncapped: a delegate working a long
 * autonomous task may roll its context over as often as its threshold asks.
 * What is bounded is the failure side — consecutive invalid submissions,
 * consecutive requests the delegate ignored, and consecutive rollovers that
 * did not bring occupancy below a threshold the fixed header already exceeds.
 * Each counter is reset by a valid submission or a successful rollover, so a
 * delegate that starts participating again never inherits a spent budget from
 * an earlier segment.
 *
 * `SUBTLE`: `AgentLoopUpdate.messages` cannot be forced through a named tool —
 * pi-ai's `ToolChoice` is `"auto" | "none"` — so scheduling is a request the
 * model may decline. Declining is safe: one request is charged, the
 * consecutive-unanswered bound stops the asks, and the normal context
 * protection (ADR 0299) still bounds the request itself.
 */

import { Type } from "typebox";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
  ResolvedSubagentSelfHandoffSettings,
  SubagentSelfHandoffKind,
} from "@pi-desktop/shared";

/** The delegate-visible tool the model submits its handoff through. */
export const SUBAGENT_HANDOFF_TOOL_NAME = "SubagentHandoff";

/** Consecutive requests a delegate may ignore before the asks stop. */
export const MAX_SUBAGENT_HANDOFF_UNANSWERED = 3;
/** Consecutive invalid submissions that stop the asks for the segment. */
export const MAX_SUBAGENT_HANDOFF_FAILURES = 3;
/** Consecutive rollovers that left the trigger still satisfied. */
export const MAX_SUBAGENT_HANDOFF_NO_PROGRESS = 2;
/** Tool calls that must land before a no-progress rollover rearms. */
export const HANDOFF_REARM_TOOL_CALLS = 2;

/**
 * Longest handoff a delegate may submit, in characters.
 *
 * Chosen so genuine technical continuation always fits — a handoff of this
 * size is several thousand tokens of paths, decisions, check outcomes, and
 * open work — while a submission cannot become an unbounded context of its
 * own. It is a bound on the text, not on its shape: there is no item count and
 * no per-section cap, because a list of sections would cap continuation by
 * field instead of by content.
 */
export const MAX_SUBAGENT_HANDOFF_CHARS = 12_000;

/**
 * One accepted submission: the text the delegate authored for its future self.
 *
 * Kept as a single string on purpose. Only the delegate knows what a
 * continuation of its own task needs and how that is best organized, so the
 * runtime carries the text verbatim and bounds nothing but its length.
 */
export type SubagentHandoffPayload = {
  text: string;
};

/**
 * Per-run handoff bookkeeping.
 *
 * `handoffs` is a metric, not a budget: successful rollovers are unbounded.
 * The counters below it describe consecutive failure streaks and are reset
 * whenever the delegate hands off successfully or submits a valid payload.
 */
export type SubagentHandoffState = {
  /** Tool calls in the current segment (since the last successful handoff). */
  toolCalls: number;
  /** Provider turns in the current segment. */
  turns: number;
  /** Start of the current segment: run start, or the last successful handoff. */
  segmentStartedAt: number;
  /** Successful rollovers. Reported, never capped. */
  handoffs: number;
  /** True while the runtime has asked and the delegate has not answered. */
  requested: boolean;
  /** Consecutive requests that produced no submission. */
  unanswered: number;
  /** Segment tool calls at the last request (the re-ask progress gate). */
  requestedAtToolCalls: number;
  /** Consecutive invalid submissions. */
  failures: number;
  /** Consecutive rollovers that did not drop below the context threshold. */
  noProgress: number;
};

export function createSubagentHandoffState(now: number): SubagentHandoffState {
  return {
    toolCalls: 0,
    turns: 0,
    segmentStartedAt: now,
    handoffs: 0,
    requested: false,
    unanswered: 0,
    requestedAtToolCalls: 0,
    failures: 0,
    noProgress: 0,
  };
}

/** What the boundary measured when it evaluated the trigger. */
export type SubagentHandoffSnapshot = {
  /** Occupancy the next request would carry, in tokens. */
  contextTokens?: number;
  /** Elapsed milliseconds since the current segment started. */
  segmentElapsedMs: number;
  /** Tool calls in the current segment. */
  toolCalls: number;
  /** Turns in the current segment. */
  turns: number;
};

/** Why a boundary did not ask for a handoff. Diagnostics only. */
export type SubagentHandoffWaitReason =
  | "disabled"
  | "below-threshold"
  | "awaiting-submission"
  | "rearm"
  | "no-progress"
  | "attempts";

export type SubagentHandoffDecision =
  | { action: "request" }
  | { action: "wait"; reason: SubagentHandoffWaitReason };

function crossed(
  kind: SubagentSelfHandoffKind,
  value: number,
  snapshot: SubagentHandoffSnapshot,
): boolean {
  if (kind === "tool-calls") return snapshot.toolCalls >= value;
  if (kind === "runtime") return snapshot.segmentElapsedMs >= value * 1_000;
  if (kind === "context-tokens") {
    return typeof snapshot.contextTokens === "number" && snapshot.contextTokens >= value;
  }
  return false;
}

/**
 * Decide whether this boundary asks the delegate to hand off.
 *
 * Ordering matters: the consecutive-failure and no-progress gates come before
 * the trigger, so a streak that has already been punished cannot re-ask; the
 * rearm gate comes last, so a trigger that is still satisfied right after a
 * rollover cannot spin on the fixed header.
 */
export function decideSubagentHandoff(input: {
  settings: ResolvedSubagentSelfHandoffSettings;
  state: SubagentHandoffState;
  snapshot: SubagentHandoffSnapshot;
}): SubagentHandoffDecision {
  const { settings, state, snapshot } = input;
  if (settings.kind === "off") return { action: "wait", reason: "disabled" };
  if (state.failures >= MAX_SUBAGENT_HANDOFF_FAILURES) {
    return { action: "wait", reason: "attempts" };
  }
  if (state.unanswered >= MAX_SUBAGENT_HANDOFF_UNANSWERED) {
    return { action: "wait", reason: "attempts" };
  }
  if (state.noProgress >= MAX_SUBAGENT_HANDOFF_NO_PROGRESS) {
    return { action: "wait", reason: "no-progress" };
  }
  const value = settings.value;
  if (typeof value !== "number") return { action: "wait", reason: "disabled" };
  if (!crossed(settings.kind, value, snapshot)) {
    return { action: "wait", reason: "below-threshold" };
  }
  // A request that has not been answered is repeated only after the delegate
  // did more work: a boundary that re-asks with nothing new in between would
  // just crowd the same turn with duplicate instructions.
  if (state.requested && snapshot.toolCalls <= state.requestedAtToolCalls) {
    return { action: "wait", reason: "awaiting-submission" };
  }
  // A rollover that did not clear the threshold means the header itself is the
  // occupancy. Require real work before asking again, so a fixed header can
  // never produce an immediate second rollover. The boundary's own measurement
  // is authoritative here, so a stale counter cannot rearm by accident.
  if (state.noProgress > 0 && snapshot.toolCalls < HANDOFF_REARM_TOOL_CALLS) {
    return { action: "wait", reason: "rearm" };
  }
  return { action: "request" };
}

/**
 * The boundary's request to the model. Transient: it is handed to the loop as
 * context for one request and never written to the run's own message list, so
 * the transcript shows what the delegate did, not the runtime's prompts.
 *
 * The prompt asks for a continuation, not a form. It names the categories a
 * handoff usually needs as examples, tells the delegate that none of them is
 * required, and leaves the organization to the writer — the same text is read
 * back by the delegate itself, which is the best judge of what it will need.
 */
export function renderSubagentHandoffRequest(input: {
  settings: ResolvedSubagentSelfHandoffSettings;
  snapshot: SubagentHandoffSnapshot;
}): string {
  const { settings, snapshot } = input;
  const measured =
    settings.kind === "context-tokens"
      ? `its context threshold (about ${snapshot.contextTokens ?? 0} of ${settings.value ?? 0} tokens)`
      : settings.kind === "tool-calls"
        ? `its tool-call threshold (${snapshot.toolCalls} of ${settings.value ?? 0} calls)`
        : `its runtime threshold (${Math.floor(snapshot.segmentElapsedMs / 60_000)} of ${
            Math.floor((settings.value ?? 0) / 60)
          } minutes)`;
  return [
    `[Context handoff required] This delegated run reached ${measured}.`,
    `Call the \`${SUBAGENT_HANDOFF_TOOL_NAME}\` tool now and write, in whatever form you like, the handoff your future self needs to continue this task.`,
    `Any length up to ${MAX_SUBAGENT_HANDOFF_CHARS} characters in any structure — prose, bullets, notes, a plan — is accepted. There is no required outline. Facts that still matter, decisions and constraints that bind the remaining work, the files and state involved, what you verified and how, what is left to do, and anything still pending or running are the usual content of a handoff, but include only what this task actually needs and leave out the rest.`,
    "Before you submit, check your own handoff: could you resume this task from it alone, with none of the earlier history? The run continues with the same task, tools, and permissions. The original task and every direction the user sent to this run are kept verbatim and replayed to you after the rollover, so do not restate them; say what they now mean only where a later direction changed the earlier one. Everything else you do not write is gone. Keep it concise, but do not leave out something you would have to rediscover.",
    "Do not start new work before submitting it.",
  ].join("\n");
}

export type NormalizedHandoff =
  | { ok: true; payload: SubagentHandoffPayload }
  | { ok: false; error: string };

/**
 * Validate and normalize one submission.
 *
 * The only requirements are that the delegate wrote something and that it fits
 * the bound: there is no field to fill and no section to cover, because the
 * content is the delegate's own choice. Length is rejected rather than
 * truncated — a free-form technical text cut at an arbitrary character loses
 * exactly the detail a continuation needs. A submission that fails returns the
 * reason verbatim to the model, which can correct it in the same turn; nothing
 * is installed and nothing is cleared.
 */
export function normalizeHandoffPayload(args: unknown): NormalizedHandoff {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      ok: false,
      error: "The handoff must be submitted as the `handoff` text field.",
    };
  }
  const candidate = (args as Record<string, unknown>).handoff;
  if (typeof candidate !== "string") {
    return {
      ok: false,
      error:
        "The handoff is missing: put the continuation text in the `handoff` field.",
    };
  }
  // Only the outer whitespace is dropped; internal line breaks, indentation,
  // and list markers are the author's formatting and are kept verbatim.
  const text = candidate.trim();
  if (!text) {
    return {
      ok: false,
      error:
        "The handoff is empty: write what your future self needs to continue this task.",
    };
  }
  if (text.length > MAX_SUBAGENT_HANDOFF_CHARS) {
    return {
      ok: false,
      error: `The handoff is ${text.length} characters; the limit is ${MAX_SUBAGENT_HANDOFF_CHARS}. Keep it concise but complete, then resubmit.`,
    };
  }
  return { ok: true, payload: { text } };
}

/**
 * The transcript-shaped summary that replaces the absorbed segment.
 *
 * One short framing line states what happened and what did not change, and the
 * delegate's own text follows unchanged — no headings, no reordering, no
 * paraphrase. `generation` numbers the rollover so the prefix of a later one
 * is visibly not the earlier one. It is a user message: the delegate is being
 * handed its own state back, and no assistant turn was produced that could own
 * it.
 *
 * The framing says the user's directions are above it because the rebuilt
 * context really does place them there: a delegate reading a later generation
 * must know that the raw directions still bind it, and that the handoff is the
 * place where they are reconciled with what was learned since.
 */
export function renderSubagentHandoffSummary(input: {
  payload: SubagentHandoffPayload;
  generation: number;
}): string {
  return [
    `[Delegated-task handoff ${input.generation}] Your earlier working history for this delegated task was replaced by the handoff below, which you wrote. The task, the tools, and the permissions are unchanged. The original task and the directions the user sent to this run are kept above it, unchanged; follow the latest of them where they differ. Continue from the handoff and do not redo what it records as done.`,
    "",
    input.payload.text,
  ].join("\n");
}

/**
 * The runtime-authored directions still in the delegate's context.
 *
 * A direction is recognized by provenance, never by inspection: the runtime
 * records the exact message object it handed to the child loop's `steer()`,
 * so a row is a direction because the runtime created it — not because it is a
 * user message, and not because its text looks like an instruction.
 *
 * Two consequences follow, and both are load-bearing:
 *
 * - **Identity, not text.** A user may legitimately send the same sentence
 *   twice; each delivery is its own row and neither is deduplicated away.
 * - **Presence, not queue state.** Steering that pi drained at the end of a
 *   turn but has not yet handed to the model is absent from `messages`. Such a
 *   row stays absent here, so the loop delivers it after the rollover through
 *   its own mechanism — exactly once, never twice. Rows a lossy protection
 *   pass removed are absent as well, so a handoff never resurrects history that
 *   compaction deliberately summarized.
 *
 * A row already sitting in the header is skipped too: rebuilding must never
 * duplicate the dispatch turn into a direction.
 */
export function handoffSteeringMessages(input: {
  /** Rows the runtime authored through `steer()`, in delivery order. */
  ledger: readonly AgentMessage[];
  /** The delegate's current context. */
  messages: readonly AgentMessage[];
  /** The dispatch header the context is rebuilt from. */
  header: readonly AgentMessage[];
}): AgentMessage[] {
  const present = new Set<AgentMessage>(input.messages);
  const inHeader = new Set<AgentMessage>(input.header);
  const kept: AgentMessage[] = [];
  const seen = new Set<AgentMessage>();
  for (const message of input.ledger) {
    if (seen.has(message)) continue;
    if (!present.has(message) || inHeader.has(message)) continue;
    seen.add(message);
    kept.push(message);
  }
  return kept;
}

/**
 * The replacement context: the immutable dispatch header, the user directions
 * the delegate was given, then exactly one handoff summary.
 *
 * Rebuilding from the header is what keeps handoff generations from
 * concatenating — the previous summary and the segment it absorbed are dropped,
 * never stacked. The directions between them are the one thing a rollover must
 * not absorb: they are the user's own instruction to this run, so they survive
 * every generation, in the order they were delivered and each exactly once.
 */
export function buildSubagentHandoffContext(input: {
  header: readonly AgentMessage[];
  /** Delivered user directions, in delivery order. See `handoffSteeringMessages`. */
  steering?: readonly AgentMessage[];
  summary: string;
  now: number;
}): AgentMessage[] {
  const handoff: AgentMessage = {
    role: "user",
    content: input.summary,
    timestamp: input.now,
  };
  return [...input.header, ...(input.steering ?? []), handoff];
}

/**
 * The one field the model fills in: its own handoff, as free-form text.
 *
 * `handoff` is required and bounded, which is the whole schema. Describing a
 * fixed outline here would push every delegate into the same shape whatever
 * its task and would cost tokens on every delegate that reads the schema, so
 * the description states the audience and the bound and leaves the content to
 * the delegate.
 */
export const SUBAGENT_HANDOFF_PARAMETERS = Type.Object({
  handoff: Type.String({
    minLength: 1,
    maxLength: MAX_SUBAGENT_HANDOFF_CHARS,
    description:
      "What your future self needs to continue this delegated task. " +
      "Free form: prose, bullets, notes, or any structure you can read back. " +
      "You lose the earlier history, so write it for a reader who has only this text and the original task.",
  }),
});

/**
 * The delegate-side tool. It carries no host capability: it only records the
 * submission in the run that owns it, so a delegate cannot use it to reach any
 * permission it does not already have.
 */
export function createSubagentHandoffTool(options: {
  onSubmit: (args: unknown) => { ok: true } | { ok: false; error: string };
}): AgentTool {
  return {
    name: SUBAGENT_HANDOFF_TOOL_NAME,
    label: "Context handoff",
    description:
      "Record a handoff for this delegated task so the run can continue with a smaller context. " +
      "Call it only when the runtime asks for one. The original task, the tools, and the permissions stay in place; " +
      "the handoff replaces the earlier working history, so write everything you would need to finish.",
    parameters: SUBAGENT_HANDOFF_PARAMETERS,
    execute: async (_toolCallId, args) => {
      const submitted = options.onSubmit(args);
      if (!submitted.ok) {
        return {
          content: [{ type: "text" as const, text: submitted.error }],
          details: { accepted: false },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "Handoff recorded. Continue the task; your context is replaced at the next turn boundary.",
          },
        ],
        details: { accepted: true },
      };
    },
  };
}
