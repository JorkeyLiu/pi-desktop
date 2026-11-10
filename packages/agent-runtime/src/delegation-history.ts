/**
 * Rebuild a delegate's model context from its persisted transcript rows
 * (ADR 0279).
 *
 * Every row a delegate emits lands in the session transcript with
 * `parentToolCallId` (the `Task` call that spawned it) and `agentName`. Those
 * rows are written for review and never replayed into the parent's context
 * (`runtime.ts` skips them on rebuild) — but they carry everything a resumed
 * delegate needs: tool call/result pairs, thinking blocks, and the original
 * `task` on the first `Task` tool row's arguments.
 *
 * A chain is the sequence of `Task` calls that share one delegate session: the
 * first call plus every `resume`. Rows are keyed by the *call*, so
 * reconstructing the chain means selecting every row whose `parentToolCallId`
 * is one of the chain's calls.
 *
 * The conversion mirrors `historyToEntries` in `runtime.ts` (failed assistant
 * rows stay transcript-only, tool rows attach to the assistant above them, an
 * orphan tool row gets a synthesized carrier) but is parameterized by the
 * delegate's own provider: a pinned delegation model is not the session model,
 * and api/replay details depend on the binding.
 */

import { estimateTokens } from "./pi-runtime-estimates.js";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  Api,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  MAX_RESUMABLE_LISTED_FILES,
  isDelegationHandoffCheckpoint,
  isDelegationHandoffDirective,
  normalizeSubagentName,
  splitInlineContent,
  type DelegationHandoffCheckpoint,
  type DelegationHandoffDirective,
  type MessageAttachment,
  type UiMessage,
} from "@pi-desktop/shared";
import { isRecord, timestampMs, toJsonObject, toJsonValue, usageToPi } from "./agent-messages.js";
import type { ContextBudgetLimits } from "./context-budget.js";
import {
  apiBindingForProviderModel,
  type RuntimeProviderConfig,
} from "./provider-binding.js";

/** One chain of `Task` calls that share a delegate session. */
export type DelegationChain = {
  /** Stable identity across every `resume`; never appears in a tool or prompt. */
  delegateSessionId: string;
  /** Every `Task` toolCallId on this chain, oldest first. */
  toolCallIds: string[];
  /** Every `delegationId` issued on this chain, oldest first. */
  delegationIds: string[];
  agentName: string;
  /** Read-only tool targets, accumulated across the whole chain. */
  readFiles: string[];
  /** Cumulative lines the chain's read-only tools have produced. */
  readLineCount: number;
  /** First `task` brief; seeds the resumed run's opening user turn. */
  originalTask?: string;
  /** Settled `delegationId` of the chain's latest run, for the prompt listing. */
  latestDelegationId?: string;
  /** Latest run's one-line objective, from the `description` or `task` text. */
  latestObjective?: string;
  /** Provider/model used by the latest run; resume must keep it. */
  latestModelId?: string;
  /** `providerId/modelId` key the latest run resolved (ADR 0279 §4). */
  latestModelKey?: string;
  /** Settled status of the latest run; `running` while it works. Historical
   * context only: no status bans continuation (ADR 0279). */
  latestStatus?: string;
  /**
   * Installed self-handoff checkpoints on this chain, newest first.
   *
   * A resume restores the newest one whose boundary cursor still exists in the
   * persisted rows; older entries stay as the fallback when the newest cannot
   * be placed. Empty means no handoff was ever installed — the pre-checkpoint
   * full-history seed applies exactly as before.
   */
  handoffCheckpoints?: DelegationHandoffCheckpoint[];
  /** Latest activity timestamp; orders the prompt listing, newest first. */
  lastActivityAt: number;
};

export type ResumableChain = DelegationChain & {
  latestDelegationId: string;
  latestObjective: string;
};

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "BrowserPreview"]);
const MISSING_TOOL_RESULT_PLACEHOLDER = "[no tool result recorded]";

export function isReadOnlyToolName(name: string): boolean {
  return READ_TOOLS.has(name);
}

/**
 * Extract read-only tool targets from a delegate's tool rows. Write-tool
 * targets are deliberately excluded: the parent needs to know what a delegate
 * *saw*, and write serialization is already the path lock's job.
 */
export function extractReadFiles(rows: readonly UiMessage[]): {
  files: string[];
  lineCount: number;
} {
  const files: string[] = [];
  let lineCount = 0;
  for (const row of rows) {
    if (row.role !== "tool" || !row.toolName || !READ_TOOLS.has(row.toolName)) {
      continue;
    }
    const target = readToolTarget(row);
    if (target) files.push(target);
    lineCount += readToolLineCount(row);
  }
  return { files: uniquePreserveOrder(files), lineCount };
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function readToolTarget(row: UiMessage): string | undefined {
  const args = isRecord(row.toolArgs) ? row.toolArgs : undefined;
  const direct =
    typeof args?.path === "string"
      ? args.path
      : typeof args?.file_path === "string"
        ? args.file_path
        : typeof args?.pattern === "string"
          ? args.pattern
          : undefined;
  return direct?.trim() || undefined;
}

function readToolLineCount(row: UiMessage): number {
  const text = toolResultText(row);
  if (!text) return 0;
  // A line count is all this gate needs; exact accounting is not load-bearing.
  return text.split("\n").length;
}

function toolResultText(row: UiMessage): string | undefined {
  const raw = row.toolResult;
  if (typeof raw === "string") return raw;
  if (!isRecord(raw)) return undefined;
  const content = raw.content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        isRecord(block) && typeof block.text === "string" ? block.text : "",
      )
      .join("\n");
  }
  if (typeof raw.text === "string") return raw.text;
  return undefined;
}

/**
 * Select this chain's rows out of a session transcript, in order.
 *
 * `Task` tool rows themselves carry no `parentToolCallId` (they belong to the
 * parent), so callers pass the chain's calls in and get back the delegate's own
 * rows only.
 */
export function selectChainRows(
  transcript: readonly UiMessage[],
  chain: Pick<DelegationChain, "toolCallIds" | "agentName">,
): UiMessage[] {
  const calls = new Set(chain.toolCallIds);
  return transcript.filter(
    (row) =>
      typeof row.parentToolCallId === "string" &&
      calls.has(row.parentToolCallId) &&
      row.agentName === chain.agentName,
  );
}

/**
 * The first user turn of a resumed delegate is the original `task`, recovered
 * from the persisted `Task` tool arguments. Returns `undefined` when the row or
 * its arguments are gone (a truncated branch), in which case the chain is not
 * resumable and the caller reports it as unknown.
 */
export function originalTaskFromTranscript(
  transcript: readonly UiMessage[],
  chain: Pick<DelegationChain, "toolCallIds">,
): string | undefined {
  const first = chain.toolCallIds[0];
  if (!first) return undefined;
  const row = transcript.find(
    (candidate) =>
      candidate.role === "tool" &&
      candidate.toolName === "Task" &&
      candidate.toolCallId === first,
  );
  if (!row) return undefined;
  const args = isRecord(row.toolArgs) ? row.toolArgs : undefined;
  const task = typeof args?.task === "string" ? args.task.trim() : "";
  return task || undefined;
}

export function taskObjectiveFromArgs(args: unknown): string {
  if (!isRecord(args)) return "";
  const description =
    typeof args.description === "string" ? args.description.trim() : "";
  if (description) return description;
  const task = typeof args.task === "string" ? args.task.trim() : "";
  return task;
}


/**
 * One delivered instruction of a chain, with the persisted row that carried it.
 *
 * A `Task` invocation delivers the chain's opening task and every later
 * `Task(resume)` directive; a user continuation of the chain is the same
 * instruction delivered twice in the transcript — a parent `Task` marker row
 * and its tagged child echo row. Identity, not text, decides which is which:
 * the invocation's `toolCallId` and the echo's `parentToolCallId` are the same
 * value, so one instruction stays one directive while two intentionally
 * identical instructions stay two.
 */
export type DelegationDirective = {
  /** `Task` toolCallId that delivered the instruction, when one did. */
  toolCallId?: string;
  /** Persisted child row that delivered the instruction, when one exists. */
  rowId?: string;
  /** The instruction exactly as delivered; images ride in `attachments`. */
  text: string;
  /** Durable attachment refs (no inline bytes). */
  attachments?: MessageAttachment[];
  /** True for the chain's opening instruction, which is preserved once. */
  opening: boolean;
  /** Row this directive renders through; hydrated by the resume caller. */
  row: UiMessage;
};

function directiveAttachmentRefs(
  row: UiMessage,
): MessageAttachment[] | undefined {
  const images = row.attachments?.filter((attachment) => attachment.kind === "image");
  if (!images?.length) return undefined;
  return images.map(({ data: _data, ...rest }) => rest);
}

function directiveKey(directive: {
  toolCallId?: string;
  rowId?: string;
}): string | undefined {
  return directive.toolCallId ?? directive.rowId;
}

/**
 * Every instruction this chain delivered, in transcript order, each once.
 *
 * Sources are provenance only — a successful `Task` invocation row, or a
 * tagged child row the runtime itself created for a delivered direction. A
 * plain user row is never classified as an instruction. The child echo row of
 * a user continuation is matched to its `Task` invocation by identity
 * (`parentToolCallId` equals `toolCallId`), never by text, so the same words
 * sent twice stay two directives and one continuation is never doubled.
 */
export function chainDeliveryDirectives(
  transcript: readonly UiMessage[],
  chain: Pick<DelegationChain, "toolCallIds" | "agentName">,
): DelegationDirective[] {
  const ordered: Array<{
    directive: DelegationDirective;
    position: number;
    order: number;
  }> = [];
  const consumedRows = new Set<string>();
  for (const toolCallId of chain.toolCallIds) {
    const call = transcript.find(
      (row) =>
        row.role === "tool" && row.toolName === "Task" && row.toolCallId === toolCallId,
    );
    // A failed invocation never delivered work to a delegate, so it is not an
    // instruction of the chain.
    if (!call || call.isError || call.toolStatus === "error") continue;
    const args = isRecord(call.toolArgs) ? call.toolArgs : undefined;
    const text = typeof args?.task === "string" ? args.task : "";
    const echo = transcript.find(
      (row) =>
        row.role === "user" &&
        row.parentToolCallId === toolCallId &&
        row.steering === true,
    );
    if (echo) consumedRows.add(echo.id);
    const body = echo?.content ?? text;
    const attachments = echo ? directiveAttachmentRefs(echo) : undefined;
    if (!body.trim() && !attachments?.length) continue;
    const row: UiMessage = echo ?? {
      id: `handoff-task-${toolCallId}`,
      role: "user",
      content: text,
      createdAt: call.createdAt,
      status: "complete",
    };
    ordered.push({
      directive: {
        toolCallId,
        ...(echo ? { rowId: echo.id } : {}),
        text: body,
        ...(attachments?.length ? { attachments } : {}),
        opening: false,
        row,
      },
      position: transcript.indexOf(call),
      order: ordered.length,
    });
  }
  // A direction the runtime delivered through child steering keeps its own
  // persisted row; the opening task above is the only instruction that has no
  // row of its own.
  for (const row of selectChainRows(transcript, chain)) {
    if (row.role !== "user" || row.steering !== true) continue;
    if (consumedRows.has(row.id)) continue;
    const attachments = directiveAttachmentRefs(row);
    if (!row.content?.trim() && !attachments?.length) continue;
    ordered.push({
      directive: {
        rowId: row.id,
        text: row.content ?? "",
        ...(attachments?.length ? { attachments } : {}),
        opening: false,
        row,
      },
      position: transcript.indexOf(row),
      order: ordered.length,
    });
  }
  return ordered
    .sort(
      (left, right) => left.position - right.position || left.order - right.order,
    )
    .map((entry, index) => ({ ...entry.directive, opening: index === 0 }));
}

/**
 * The chain's delivered instructions, with a checkpoint's recorded list as the
 * durable base.
 *
 * A record outlives the rows it was built from (a truncated branch keeps the
 * checkpoint, not the transcript), so recorded entries come first and any
 * live instruction the record does not know about is appended in transcript
 * order. Matching is by identity again, so a record and its live row are one
 * directive and two identical texts remain two.
 */
export function mergeDeliveryDirectives(
  recorded: readonly unknown[],
  live: readonly DelegationDirective[],
): DelegationDirective[] {
  const liveByKey = new Map<string, DelegationDirective>();
  for (const directive of live) {
    const key = directiveKey(directive);
    if (key) liveByKey.set(key, directive);
  }
  const used = new Set<string>();
  const merged: DelegationDirective[] = [];
  for (const record of recorded) {
    if (!isDelegationHandoffDirective(record)) continue;
    const key = directiveKey(record);
    const liveEntry = key ? liveByKey.get(key) : undefined;
    if (liveEntry) used.add(key!);
    merged.push(liveEntry ?? directiveFromRecord(record, merged.length));
  }
  for (const directive of live) {
    const key = directiveKey(directive);
    if (key && used.has(key)) continue;
    merged.push(directive);
  }
  return merged.map((directive, index) => ({ ...directive, opening: index === 0 }));
}

function directiveFromRecord(
  record: DelegationHandoffDirective,
  index: number,
): DelegationDirective {
  const attachments = record.attachments?.filter(
    (attachment) => attachment.kind === "image",
  );
  const row: UiMessage = {
    id: record.rowId ?? `handoff-directive-${index}`,
    role: "user",
    content: record.text,
    createdAt: "",
    status: "complete",
    ...(attachments?.length ? { attachments } : {}),
  };
  return {
    ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
    ...(record.rowId ? { rowId: record.rowId } : {}),
    text: record.text,
    ...(attachments?.length ? { attachments } : {}),
    opening: Boolean(record.opening),
    row,
  };
}

/**
 * Convert a delegate's transcript rows into provider messages.
 *
 * Mirrors the parent's rebuild: an assistant row carries its text and thinking;
 * a tool row appends its call to the assistant above it and emits a paired
 * result. An orphan tool row (its assistant lost to a truncated branch) gets a
 * synthesized carrier so the pair stays well-formed — providers reject an
 * unpaired `toolUse`.
 *
 * Assistant transport identity is `model.provider` / `model.id` (the same
 * values live requests use), not the account row id. A vendorKey-bound model
 * has `model.provider !== provider.id`; tagging history with the account id
 * makes pi-ai treat same-model reasoning as foreign and empty
 * `reasoning_content` on Task(resume).
 */
/** A hydrated image attachment on a delegate row, with its bytes in memory. */
type RowImage = {
  path: string;
  name: string;
  kind: "image";
  mimeType?: string;
  size?: number;
  inlinePath?: string;
  data: string;
};

function rowImages(row: UiMessage): RowImage[] {
  return (row.attachments ?? []).flatMap((attachment): RowImage[] => {
    if (
      attachment.kind !== "image" ||
      typeof attachment.data !== "string" ||
      attachment.data.length === 0
    ) {
      return [];
    }
    return [
      {
        path: attachment.ref,
        name: attachment.name,
        kind: "image",
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
        ...(attachment.inlinePath ? { inlinePath: attachment.inlinePath } : {}),
        data: attachment.data,
      },
    ];
  });
}

/**
 * A user row's provider content: the text with each image at the position the
 * user placed it, or the images alone when the user sent no words. Returns
 * `undefined` for a row with neither, which has nothing to replay.
 */
function delegateUserContent(row: UiMessage): UserMessage["content"] | undefined {
  const text = row.content ?? "";
  const images = rowImages(row);
  if (!images.length) {
    return text.trim() ? [{ type: "text", text }] : undefined;
  }
  const { parts, trailing } = splitInlineContent(text, images);
  const blocks: Array<{ type: "text"; text: string } | ImageContent> = parts.flatMap(
    (part): Array<{ type: "text"; text: string } | ImageContent> =>
      part.kind === "text"
        ? part.text
          ? [{ type: "text" as const, text: part.text }]
          : []
        : [
            {
              type: "image" as const,
              data: part.attachment.data,
              mimeType: part.attachment.mimeType || "image/png",
            },
          ],
  );
  blocks.push(
    ...trailing.map(
      (image): ImageContent => ({
        type: "image",
        data: image.data,
        mimeType: image.mimeType || "image/png",
      }),
    ),
  );
  return blocks;
}

export function chainRowsToMessages(
  rows: readonly UiMessage[],
  provider: RuntimeProviderConfig,
  model: Model<Api>,
): Message[] {
  const api = apiBindingForProviderModel(provider).api;
  const deepSeekCompletionsReplay =
    api === "openai-completions" &&
    (
      model.compat as
        | { requiresReasoningContentOnAssistantMessages?: boolean }
        | undefined
    )?.requiresReasoningContentOnAssistantMessages === true;

  const messages: Message[] = [];
  let toolCarrier: AssistantMessage | undefined;

  for (const row of rows) {
    const timestamp = timestampMs(row.createdAt) || Date.now();
    if (row.role === "user") {
      toolCarrier = undefined;
      const content = delegateUserContent(row);
      if (!content) continue;
      const userMessage: UserMessage = { role: "user", content, timestamp };
      messages.push(userMessage);
    } else if (row.role === "assistant") {
      toolCarrier = undefined;
      // Failed provider responses stay transcript-only: replaying one would
      // hand the model a stopReason the provider never agreed to.
      if (row.status === "error" || row.isError || row.error) continue;
      const content: AssistantMessage["content"] = [];
      if (row.thinking?.trim()) {
        content.push({
          type: "thinking",
          thinking: row.thinking,
          ...(deepSeekCompletionsReplay
            ? { thinkingSignature: "reasoning_content" as const }
            : {}),
        });
      }
      if (row.content?.trim()) {
        content.push({ type: "text", text: row.content });
      }
      const assistant: AssistantMessage = {
        role: "assistant",
        content,
        api,
        provider: model.provider,
        model: model.id,
        usage: usageToPi(row.usage),
        stopReason: "stop",
        timestamp,
      };
      messages.push(assistant);
      toolCarrier = assistant;
    } else if (row.role === "tool") {
      if (!row.toolCallId || !row.toolName) continue;
      if (!toolCarrier) {
        toolCarrier = {
          role: "assistant",
          content: [],
          api,
          provider: model.provider,
          model: model.id,
          usage: usageToPi(undefined),
          stopReason: "toolUse",
          timestamp,
        };
        messages.push(toolCarrier);
      }
      toolCarrier.content.push({
        type: "toolCall",
        id: row.toolCallId,
        name: row.toolName,
        arguments: toJsonObject(row.toolArgs),
      });
      toolCarrier.stopReason = "toolUse";
      messages.push(toolResultFromUi(row, timestamp));
    }
  }

  // A call-only turn with no text is a legitimate carrier; an assistant that
  // ended with neither text nor calls carries nothing to the model.
  return messages.filter(
    (message) =>
      message.role !== "assistant" || message.content.length > 0,
  );
}

/**
 * Seed a resumed run: original task as the first user turn, then history.
 *
 * An empty `originalTask` means the chain began with an image-only user input;
 * its hydrated first row is then the opening turn and no synthetic text turn is
 * added. The seed is truncated against the delegate's budget (ADR 0299 §7) so a
 * resumed run's first request fits its own window instead of overflowing on
 * arrival. Truncation drops the oldest tool results first and never splits a
 * call from its result; the task brief itself is always kept.
 */
export function seedDelegateMessages(options: {
  originalTask: string;
  rows: readonly UiMessage[];
  provider: RuntimeProviderConfig;
  model: Model<Api>;
  budget: ContextBudgetLimits;
}): Message[] {
  const history = chainRowsToMessages(options.rows, options.provider, options.model);
  // A chain that began with an image-only user input has no text brief: its
  // first user row is the picture, and fabricating an empty text turn ahead
  // of it would both lose the brief and break providers that reject empty
  // text blocks.
  const brief = options.originalTask.trim();
  if (!brief) {
    return truncateSeededMessages(history, options.budget.hardLimit);
  }
  const first: UserMessage = {
    role: "user",
    content: [{ type: "text", text: options.originalTask }],
    timestamp: timestampMs(options.rows[0]?.createdAt) || Date.now(),
  };
  const rest = history.filter(
    (message) =>
      !(
        message.role === "user" &&
        typeof message.content !== "string" &&
        message.content.length === 1 &&
        message.content[0]?.type === "text" &&
        message.content[0].text === options.originalTask
      ),
  );
  return truncateSeededMessages(
    [first, ...rest],
    options.budget.hardLimit,
  );
}

/**
 * The newest installed checkpoint whose boundary still exists in the persisted
 * rows, or `undefined` when none can be placed.
 *
 * Validity is checked against what the resume actually holds, not against the
 * record alone: a checkpoint whose `throughRowId` was lost to a truncated
 * branch describes a boundary this transcript no longer has, so the next older
 * checkpoint (or the pre-checkpoint full-history seed) is used instead.
 */
export function restorableHandoffCheckpoint(
  checkpoints: readonly DelegationHandoffCheckpoint[] | undefined,
  rows: readonly UiMessage[],
): DelegationHandoffCheckpoint | undefined {
  for (const checkpoint of checkpoints ?? []) {
    if (rows.some((row) => row.id === checkpoint.throughRowId)) return checkpoint;
  }
  return undefined;
}

/**
 * Seed a resumed run from an installed handoff checkpoint: the runtime-owned
 * system prompt stays where it is, then the chain's original task, the
 * delivered directions in order, the installed summary, and only the persisted
 * rows that came after the boundary — the execution history the handoff already
 * absorbed is never replayed.
 *
 * Returns `undefined` when the boundary row is missing, which is the caller's
 * signal to fall back to the full-history seed rather than install half a
 * context. The head and summary are protected from truncation (ADR 0299 §7
 * still bounds the whole seed); only the replayed tail is reduced.
 */
export function seedHandoffCheckpointMessages(options: {
  checkpoint: DelegationHandoffCheckpoint;
  /** This chain's persisted rows, hydrated, in transcript order. */
  rows: readonly UiMessage[];
  /** Delivered directions resolved (and hydrated) in delivery order. */
  directives: readonly UiMessage[];
  provider: RuntimeProviderConfig;
  model: Model<Api>;
  budget: ContextBudgetLimits;
}): Message[] | undefined {
  const cursor = options.rows.findIndex(
    (row) => row.id === options.checkpoint.throughRowId,
  );
  if (cursor < 0) return undefined;
  const head: Message[] = [];
  const originalTask = options.checkpoint.originalTask.trim();
  if (originalTask) {
    head.push({
      role: "user",
      content: [{ type: "text", text: options.checkpoint.originalTask }],
      timestamp: timestampMs(options.rows[0]?.createdAt) || Date.now(),
    });
  }
  head.push(
    ...chainRowsToMessages(options.directives, options.provider, options.model),
  );
  const installedAt = timestampMs(options.checkpoint.installedAt) || Date.now();
  const summary: UserMessage = {
    role: "user",
    content: options.checkpoint.summary,
    timestamp: installedAt,
  };
  const tail = chainRowsToMessages(
    options.rows.slice(cursor + 1),
    options.provider,
    options.model,
  );
  return truncateSeededMessages(
    [...head, summary, ...tail],
    options.budget.hardLimit,
    head.length + 1,
  );
}

/**
 * Bring a seeded chain under the delegate's hard limit (ADR 0299 §7).
 *
 * `messages[0]` is the original task brief and is never dropped. The oldest
 * tool results go first: they are the bulkiest entries, and the delegate can
 * re-read a file but cannot reconstruct its most recent turns. A result always
 * leaves together with its call, and a carrier left with neither text nor
 * calls is removed too, so the replay never holds an orphaned `toolUse` /
 * `toolResult` pair (providers reject those). If stripping every pair is not
 * enough, whole messages go oldest-first until only the brief is left; a brief
 * that alone crosses the limit is kept as is, because a resume cannot start
 * with less than its task.
 *
 * Sizes are measured with the per-message heuristic rather than
 * `estimateContextTokens`: that estimator anchors on the last assistant's
 * recorded usage, which still counts the history this truncation drops, so the
 * anchor could never fall below the limit no matter how much is removed.
 */
function truncateSeededMessages(
  messages: Message[],
  hardLimit: number,
  /**
   * Leading messages a checkpoint seed must keep: the original task, the
   * delivered directions, and the installed summary. The default protects only
   * the original task brief, which is the pre-checkpoint behavior.
   */
  protectedPrefix = 1,
): Message[] {
  const kept = [...messages];
  const tokenCounts = kept.map((message) => estimateTokens(message));
  let total = tokenCounts.reduce((sum, count) => sum + count, 0);
  if (total < hardLimit) return kept;

  // Phase 1: strip tool call/result pairs, oldest first.
  for (let i = protectedPrefix; i < kept.length && total >= hardLimit; ) {
    const message = kept[i];
    if (message.role !== "assistant") {
      i += 1;
      continue;
    }
    const callIds = new Set(
      message.content
        .filter((block): block is ToolCall => block.type === "toolCall")
        .map((block) => block.id),
    );
    if (callIds.size === 0) {
      i += 1;
      continue;
    }
    const content = message.content.filter((block) => block.type !== "toolCall");
    // A carrier whose calls are gone must not keep claiming "toolUse" — the
    // replay would hand the model a stopReason no provider produced (the same
    // rule chainRowsToMessages applies to failed rows above).
    const carrier: AssistantMessage | undefined =
      content.length > 0 ? { ...message, content, stopReason: "stop" } : undefined;
    const carrierTokens = carrier ? estimateTokens(carrier) : 0;
    // A carrier's results sit directly behind it, one per call, in order.
    let end = i + 1;
    while (end < kept.length) {
      const next = kept[end];
      if (next.role !== "toolResult" || !callIds.has(next.toolCallId)) break;
      total -= tokenCounts[end];
      end += 1;
    }
    total -= tokenCounts[i] - carrierTokens;
    kept.splice(i, end - i, ...(carrier ? [carrier] : []));
    tokenCounts.splice(i, end - i, ...(carrier ? [carrierTokens] : []));
  }

  // Phase 2: no pairs remain; drop whole messages oldest-first down to the
  // brief.
  for (let i = protectedPrefix; i < kept.length && total >= hardLimit; ) {
    total -= tokenCounts[i];
    kept.splice(i, 1);
    tokenCounts.splice(i, 1);
  }
  return kept;
}

function toolResultFromUi(m: UiMessage, timestamp: number): ToolResultMessage {
  const raw = m.toolResult;
  const blocks: ToolResultMessage["content"] = [];
  const rawBlocks =
    isRecord(raw) && Array.isArray(raw.content) ? raw.content : undefined;
  if (rawBlocks) {
    for (const block of rawBlocks) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        blocks.push({ type: "text", text: block.text });
      } else if (
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        blocks.push({
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
        });
      }
    }
  } else if (typeof raw === "string" && raw.trim()) {
    blocks.push({ type: "text", text: raw });
  } else if (raw !== undefined && raw !== null) {
    blocks.push({ type: "text", text: safeJson(raw) });
  }
  if (blocks.length === 0) {
    blocks.push({
      type: "text",
      text:
        m.toolStatus === "running"
          ? "[tool call was interrupted before a result was recorded]"
          : MISSING_TOOL_RESULT_PLACEHOLDER,
    });
  }
  const rawRecord = isRecord(raw) ? raw : undefined;
  const rawDetails = toJsonValue(rawRecord?.details);
  const legacyAddedToolNames =
    m.toolName === "ToolSearch" && Array.isArray(rawRecord?.addedToolNames)
      ? rawRecord.addedToolNames.filter(
          (name: unknown): name is string =>
            typeof name === "string" && name.length > 0,
        )
      : [];
  const canonicalAddedToolNames =
    isRecord(rawDetails) && Array.isArray(rawDetails.addedToolNames)
      ? rawDetails.addedToolNames.filter(
          (name: unknown): name is string =>
            typeof name === "string" && name.length > 0,
        )
      : [];
  const details =
    legacyAddedToolNames.length > 0 && canonicalAddedToolNames.length === 0
      ? {
          ...(isRecord(rawDetails) ? rawDetails : {}),
          addedToolNames: [...new Set(legacyAddedToolNames)],
        }
      : rawDetails;
  return {
    role: "toolResult",
    toolCallId: m.toolCallId ?? "",
    toolName: m.toolName ?? "",
    content: blocks,
    ...(details !== undefined ? { details } : {}),
    isError:
      m.toolStatus === "running" ||
      m.toolStatus === "error" ||
      m.toolStatus === "denied" ||
      m.isError === true,
    timestamp,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type RebuiltTaskCall = {
  toolCallId: string;
  delegationId: string;
  agentName: string;
  resume?: string;
  objective: string;
  task?: string;
  modelId?: string;
  createdAt: number;
  /** Settled status this call's `Task` row recorded, when it recorded one. */
  status?: string;
  /** Installed self-handoff checkpoint this `Task` row recorded, when any. */
  handoffCheckpoint?: unknown;
};
/**
 * Status a rebuilt chain carries after a restart (ADR 0279 §12). The settled
 * status is the one the settlement projection wrote onto the `Task` row. A run
 * the app closed while it still worked never settled, and reads as
 * `interrupted` rather than staying open forever. A row that records no status
 * at all — nothing this app writes does — is trusted as settled, because the
 * only alternative is to refuse every chain a partial transcript proves
 * nothing about.
 */
function chainStatusFromDetail(
  details: Record<string, unknown> | undefined,
  row: UiMessage,
): string | undefined {
  const status =
    typeof details?.status === "string" ? details.status.trim() : "";
  if (status) return status === "running" ? "interrupted" : status;
  if (row.toolStatus === "error") return "failed";
  if (row.toolStatus === "running") return "interrupted";
  return undefined;
}

/**
 * Scan persisted `Task` tool rows and group them into chains by their
 * `resume` links. Used at session launch so a restart does not lose
 * resumability (ADR 0279 §12). Every call carries the status its own `Task`
 * row recorded, so a chain rebuilt here is resumable exactly when the live
 * registry would consider it resumable.
 */
export function rebuildChainsFromTranscript(
  transcript: readonly UiMessage[],
): DelegationChain[] {
  const calls: RebuiltTaskCall[] = [];
  const callIndexByToolCallId = new Map<string, number>();
  for (const row of transcript) {
    if (row.role !== "tool" || row.toolName !== "Task" || !row.toolCallId) {
      continue;
    }
    const args = isRecord(row.toolArgs) ? row.toolArgs : undefined;
    const details =
      isRecord(row.toolResult) && isRecord(row.toolResult.details)
        ? row.toolResult.details
        : undefined;
    const delegationId =
      typeof details?.delegationId === "string" ? details.delegationId : "";
    // A `Task` row with no delegation id never produced a delegate — the call
    // was rejected (unknown agent, empty brief) and its "result" is the tool
    // error. Such a row is not a chain and must not become one.
    if (!delegationId) continue;
    // `agentName` is compared against the definition name and against the
    // transcript rows' `agentName`, so it is normalized the same way the tool
    // normalizes `Task.agent` (ADR 0279 §12).
    const agentName = normalizeSubagentName(
      typeof args?.agent === "string"
        ? args.agent
        : typeof details?.agent === "string"
          ? details.agent
          : "",
    );
    if (!agentName) continue;
    const resume = typeof args?.resume === "string" ? args.resume.trim() : "";
    const task = typeof args?.task === "string" ? args.task.trim() : "";
    const modelId =
      typeof details?.modelId === "string" ? details.modelId : undefined;
    const call: RebuiltTaskCall = {
      toolCallId: row.toolCallId,
      delegationId,
      agentName,
      ...(resume ? { resume } : {}),
      objective: taskObjectiveFromArgs(args),
      ...(task ? { task } : {}),
      ...(modelId ? { modelId } : {}),
      status: chainStatusFromDetail(details, row),
      ...(details?.handoffCheckpoint !== undefined
        ? { handoffCheckpoint: details.handoffCheckpoint }
        : {}),
      createdAt: timestampMs(row.createdAt) || Date.now(),
    };
    // Settling a delegation rewrites its `Task` row in place, so a transcript
    // that briefly holds both the immediate and the settled copy keeps the
    // newer one and the call is never rebuilt twice.
    const seenAt = callIndexByToolCallId.get(row.toolCallId);
    if (seenAt === undefined) {
      callIndexByToolCallId.set(row.toolCallId, calls.length);
      calls.push(call);
    } else {
      calls[seenAt] = call;
    }
  }

  const byDelegationId = new Map(calls.map((call) => [call.delegationId, call]));
  const children = new Map<string, RebuiltTaskCall[]>();
  const roots: RebuiltTaskCall[] = [];
  for (const call of calls) {
    if (!call.resume) {
      roots.push(call);
      continue;
    }
    const parent = byDelegationId.get(call.resume);
    if (!parent) {
      // A resume whose parent is gone is not a chain; skip it.
      continue;
    }
    const siblings = children.get(parent.delegationId) ?? [];
    siblings.push(call);
    children.set(parent.delegationId, siblings);
  }

  const chains: DelegationChain[] = [];
  for (const root of roots) {
    const ordered: RebuiltTaskCall[] = [];
    const walk = (call: RebuiltTaskCall) => {
      ordered.push(call);
      for (const child of children.get(call.delegationId) ?? []) {
        if (child.agentName !== root.agentName) continue;
        walk(child);
      }
    };
    walk(root);
    const toolCallIds = ordered.map((call) => call.toolCallId);
    const rows = selectChainRows(transcript, {
      toolCallIds,
      agentName: root.agentName,
    });
    const reads = extractReadFiles(rows);
    const checkpoints = rebuiltHandoffCheckpoints(ordered);
    const latest = ordered[ordered.length - 1];
    chains.push({
      delegateSessionId: root.delegationId,
      toolCallIds,
      delegationIds: ordered.map((call) => call.delegationId),
      agentName: root.agentName,
      readFiles: reads.files,
      readLineCount: reads.lineCount,
      originalTask: root.task,
      latestDelegationId: latest?.delegationId,
      latestObjective: latest?.objective ?? root.objective,
      latestModelId: latest?.modelId,
      latestStatus: latest?.status,
      lastActivityAt: latest?.createdAt ?? root.createdAt,
      ...(checkpoints.length > 0 ? { handoffCheckpoints: checkpoints } : {}),
    });
  }
  return chains;
}

/**
 * Every installed checkpoint the chain's own `Task` rows recorded, newest
 * first. One delegation installs at most one boundary per generation, and a
 * repeated call id keeps only its newest copy, so the same record can never
 * appear twice.
 */
function rebuiltHandoffCheckpoints(
  calls: readonly RebuiltTaskCall[],
): DelegationHandoffCheckpoint[] {
  const kept: DelegationHandoffCheckpoint[] = [];
  for (const call of calls) {
    if (!isDelegationHandoffCheckpoint(call.handoffCheckpoint)) continue;
    const candidate = call.handoffCheckpoint;
    const existing = kept.findIndex(
      (entry) => entry.delegationId === candidate.delegationId,
    );
    if (existing >= 0) kept.splice(existing, 1);
    kept.push(candidate);
  }
  return kept.sort((left, right) => right.generation - left.generation);
}

export function listedReadFiles(
  files: readonly string[],
  limit = MAX_RESUMABLE_LISTED_FILES,
): { files: string[]; omitted: number } {
  if (files.length <= limit) return { files: [...files], omitted: 0 };
  return { files: files.slice(0, limit), omitted: files.length - limit };
}

export function formatResumableList(chains: readonly ResumableChain[]): string {
  if (chains.length === 0) return "";
  const lines = [
    "Reusable subagent sessions (same conversation only). To continue one, pass its `resume` id on Task. Saying \"reuse\" in prose is not enough; omit `resume` to start a new session. Do not pass `model` when resuming.",
  ];
  for (const chain of chains) {
    const listed = listedReadFiles(chain.readFiles);
    const files =
      listed.files.length === 0
        ? "none recorded"
        : listed.omitted > 0
          ? `${listed.files.join(", ")} (+${listed.omitted} more)`
          : listed.files.join(", ");
    lines.push(
      `- ${chain.agentName} / ${chain.latestDelegationId}: ${chain.latestObjective || "(no label)"}`,
    );
    lines.push(`  Files read: ${files}`);
  }
  return lines.join("\n");
}
