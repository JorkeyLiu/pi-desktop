/**
 * Subagents: bounded delegate agent loops spawned by the `Task` tool (ADR 0062).
 *
 * A delegate is a second pi `Agent` inside the same sidecar process, with its
 * own system prompt, its own (possibly pinned) provider/model, and only the
 * tools its definition declares. It shares the session's host connection, so
 * every tool call it makes goes through the same host-core permission and
 * containment path as the parent's.
 *
 * Two boundaries define the design:
 * - The parent's model context only ever gains the delegate's final report
 *   (and a one-line heartbeat while it runs). Child messages and tool rows
 *   are emitted for the transcript and persisted for review, but the session
 *   runtime filters them out when it rebuilds model context.
 * - A delegate's lifecycle never reaches Electron main's turn handling. It
 *   runs in the background under the session runtime (ADR 0089 / D328):
 *   `Task` starts it and returns, `TaskWait` may converge early, and when it
 *   finishes the runtime delivers the report to the parent even if the parent
 *   already stopped calling tools. Only user Stop or `TaskStop` aborts it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { estimateVisibleResponseOutputTokens } from "./response-token-estimate.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Agent,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type AgentTool,
  type PrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  addUsage,
  cumulativeDelta,
  isCertificateVerificationError,
  normalizeSubagentSelfHandoffSettings,
  subagentCanMutate,
  subagentToolsLabel,
  type AgentEventEnvelope,
  type MessageUsage,
  type ResolvedSubagentSelfHandoffSettings,
  type SubagentDefinition,
  type SubagentRunStatus as SharedSubagentRunStatus,
  type SubagentSelfHandoffSettings,
  type SubagentThinkingLevel,
  type UiMessage,
} from "@pi-desktop/shared";
import { classifyAgentError } from "./agent-errors.js";
import { createToolArgsPreparation } from "./tool-args-preparation.js";
import { readLocalRequestErrorDetails } from "./local-request-errors.js";
import { withProviderFetchFailure } from "./provider-transport-recovery.js";
import {
  assistantContent,
  nowIso,
  usageFromPi,
} from "./agent-messages.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { clampThinkingLevel } from "./thinking-level.js";
import { subagentModelBinding, type SubagentProviderRetryState } from "./subagent-model-binding.js";
import { contextBudgetFor, contextBudgetForStreaming, contextBudgetLimitsFor } from "./context-budget.js";
import { convertToLlm } from "./pi-runtime-messages.js";
import {
  delegateRequestTokens,
  delegateRetentionMode,
  delegateSummaryModels,
  prepareDelegateTurnContext,
  replaceContextMessages,
  subagentContextOverflowError,
  type DelegateTurnUpdate,
} from "./subagent-context.js";
import { STREAM_PROGRESS_EVALUATION_CHARS } from "./subagent-progress.js";
import {
  buildSubagentHandoffContext,
  createSubagentHandoffState,
  createSubagentHandoffTool,
  decideSubagentHandoff,
  handoffSteeringMessages,
  normalizeHandoffPayload,
  renderSubagentHandoffRequest,
  renderSubagentHandoffSummary,
  type SubagentHandoffPayload,
  type SubagentHandoffSnapshot,
  type SubagentHandoffState,
} from "./subagent-handoff.js";
import {
  dedupeToolCallMessages,
  reportDuplicateToolCallDrop,
} from "./tool-call-dedupe.js";
import {
  classifyProviderError,
  delayWithAbort,
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_TRANSIENT_MAX_RETRIES,
  isTransientProviderRetryCode,
  providerRateLimitDelayMs,
  providerSetupRetryDelayMs,
} from "./provider-retry.js";

export const SUBAGENT_TOOL_NAME = "Task";
/** Converge on running delegations and read their reports (ADR 0089). */
export const SUBAGENT_WAIT_TOOL_NAME = "TaskWait";
/** Report on the session's delegations without waiting (ADR 0089). */
export const SUBAGENT_LIST_TOOL_NAME = "TaskList";
/** Stop running delegations (ADR 0089). */
export const SUBAGENT_STOP_TOOL_NAME = "TaskStop";

/** The report is the only thing that enters the parent's context; keep it
 * from becoming the context problem delegation was supposed to avoid. */
export const MAX_SUBAGENT_REPORT_CHARS = 12_000;

export type SubagentRunStatus = SharedSubagentRunStatus;

export type SubagentRunResult = {
  agentName: string;
  /** Provider/model used by this run after delegation resolution. */
  modelId: string;
  /** Thinking selection passed to the delegate after inheritance/clamping. */
  thinkingLevel: SubagentThinkingLevel;
  status: SubagentRunStatus;
  /** Text handed back to the parent model. */
  report: string;
  /** Provider requests the delegate spent. */
  turns: number;
  toolCalls: number;
  usage?: MessageUsage;
  modelFailures?: Array<{ model: string; code: string; message: string }>;
  /** In-memory context compactions the run needed (ADR 0299). */
  contextCompactions?: number;
  /** True when the run had to discard working history without a summary. */
  contextDegraded?: boolean;
  /** True when the delegate response hit the model's output token limit. */
  outputTruncated?: boolean;
  /** Context handoffs this run performed on its own context. */
  handoffs?: number;
  /** File path in session scratch where the unclipped report was preserved (ADR 0062). */
  scratchReportPath?: string;
  error?: {
    code: string;
    message: string;
    resumeId?: string;
    charactersProduced?: number;
  };
};

export type SubagentToolOutcome = {
  isError?: boolean;
  terminate?: boolean;
  error?: { code: string; message: string };
};

export type SubagentRunOptions = {
  definition: SubagentDefinition;
  sessionId: string;
  /** Parent durable turn; child rows are attributed to the same turn. */
  turnId?: string;
  /** `Task` call that owns this delegate. */
  parentToolCallId: string;
  /** Delegation identifier issued by the runtime for this task run (ADR 0279). */
  delegationId?: string;
  /** Session scratch workspace root for persistent spillover artifacts (ADR 0062). */
  scratchDir?: string;
  /** The delegated instruction, written by the parent model. */
  task: string;
  /** Provider resolved by Electron main (the definition's pin, or the
   * session's provider when the definition pins nothing). */
  provider: RuntimeProviderConfig;
  /** Inherited session policy for retrying transient provider failures. */
  infiniteProviderRetry?: boolean;
  thinkingLevel: SubagentThinkingLevel;
  /** User-owned definition pins only, in configured order. Missing bindings fail visibly. */
  fallbackModels?: Array<{ key: string; provider?: RuntimeProviderConfig }>;
  /** Original parent thinking selection, before primary-model clamping. */
  inheritedThinkingLevel?: SubagentThinkingLevel;
  onModelChange?: (provider: RuntimeProviderConfig, thinkingLevel: SubagentThinkingLevel) => void;
  /** Fully composed child system prompt (see `composeSubagentSystemPrompt`). */
  systemPrompt: string;
  /** Host-backed tools, built by the session runtime so a delegate's calls
   * take the exact same path as the parent's. */
  tools: AgentTool[];
  onEvent: (envelope: AgentEventEnvelope) => void;
  /**
   * Result of the parent's own `afterToolCall` bookkeeping for one call, so a
   * host failure reaches the delegate's tool-error channel the same way it
   * reaches the parent's.
   */
  resolveToolOutcome?: (
    context: AfterToolCallContext,
  ) => SubagentToolOutcome | undefined;
  signal?: AbortSignal;
  /**
   * Prior chain messages that seed this run (ADR 0279). Omitted for a cold
   * start. The original `task` is still passed to `prompt()` as the new user
   * turn; these messages are everything that came before it.
   */
  initialMessages?: AgentMessage[];

  /**
   * Image blocks this run's opening user turn carries.
   *
   * Only a direct user continuation sets them: the user's own input may be
   * images only, and the parent's `Task` brief never carries attachments. The
   * bytes are inlined regardless of what the child model's capability
   * metadata claims — the delegate's real endpoint is the authority, and a
   * refusal must surface as a provider error, not a silent text-only turn.
   */
  initialImages?: ImageContent[];

  /**
   * Self-handoff trigger for this run (`AppSettings.subagentSelfHandoff`).
   * Absent or `off` attaches no handoff tool and changes nothing about the
   * run; every other kind adds one runtime-owned tool and one transient
   * request message at the turn boundaries that cross the threshold.
   */
  selfHandoff?: SubagentSelfHandoffSettings;
};

/**
 * Compose the delegate's system prompt.
 *
 * The session runtime owns the shared parts (shell dialect, scratch
 * directory, project instruction chain) because it is the only place that
 * knows them; this function only decides the framing and the ordering, with
 * the definition body ahead of the workspace guidance so a project's own
 * instructions still have the last word.
 */
export function composeSubagentSystemPrompt(options: {
  definition: SubagentDefinition;
  /** Guidance blocks inherited from the session (shell, scratch, rules). */
  guidance?: string[];
  /** Spawn-time tool names after inherit resolution. */
  toolNames?: readonly string[];
}): string {
  const { definition } = options;
  const resolved = options.toolNames;
  const toolList =
    resolved && resolved.length > 0
      ? resolved.join(", ")
      : subagentToolsLabel(definition);
  const framing = [
    `You are the \"${definition.name}\" subagent inside PI-Desktop, working on one task delegated by the main agent.`,
    `You cannot see the user, ask questions, or delegate further. Finish the task with the tools you have: ${toolList}.`,
    subagentCanMutate(definition, resolved)
      ? "You may change files, but only the ones the task is about; leave everything else untouched. If the final report would exceed ~8,000 characters, write the full report to a file yourself and make the final message a compact summary plus the file path."
      : "You have no tools that change files or run commands, so never report an edit you could not have made.",
    "Your final message is the report the main agent receives when you finish. Make it self-contained: what you did, what you found with exact paths and line numbers, and anything you could not finish.",
    "Keep the report tight. Report findings, not narration, and never pad it with a summary of your own process.",
    "If you discover in the first few turns that you lack a tool essential to the task (e.g. no Bash when shell commands are needed), stop immediately with a one-sentence report naming the missing capability. Do not attempt workarounds or pad the report with unrelated reading.",
  ].join("\n");
  return [framing, definition.prompt, ...(options.guidance ?? [])]
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}

function boundedReport(value: string): string {
  const text = value.trim();
  if (text.length <= MAX_SUBAGENT_REPORT_CHARS) return text;
  const marker = "\n\n[subagent report truncated]\n\n";
  const available = MAX_SUBAGENT_REPORT_CHARS - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

/** Keep opaque provider/tool-call ids inside the session scratch directory. */
function scratchPathSegment(value: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..") {
    return value;
  }
  return `id-${encodeURIComponent(value)}`;
}

export { addUsage };

/** One delegate execution. A resumed run is still a new instance; it is
 * seeded with the prior chain's messages rather than kept warm in memory. */
export class SubagentRun {
  private readonly agent: Agent;
  private readonly opts: SubagentRunOptions;
  private currentAssistant?: UiMessage;
  /** Calls whose identity settled while their arguments were still streaming. */
  private readonly toolArgsPreparation = createToolArgsPreparation();
  /**
   * Estimate-relevant size of the assistant row this run is streaming: the text
   * and thinking the transcript shows plus the names and arguments of the tool
   * calls pi is writing into it.
   *
   * pi's estimator charges exactly those parts, so this number moves when this
   * delegate's context estimate can move. It is accumulated from deltas rather
   * than measured off the row: `JSON.stringify` of a half-written argument on
   * every frame would cost more than the estimate it gates.
   */
  private streamedRowChars = 0;
  /** Argument characters written into the streaming row's tool calls so far. */
  private streamedToolCallChars = 0;
  /** `streamedRowChars` at the last emitted frame: bounds argument-only frames. */
  private emittedRowChars = 0;
  private lastReportText = "";
  private streamStartedAt?: number;
  private lastReportTruncated = false;
  private turns = 0;
  private toolCalls = 0;
  private usage?: MessageUsage;
  private streamError?: { code: string; message: string };
  private mutationTermination?: { code: string; message: string };
  /** Set when a settled message reads as a cancel — `stopReason: "aborted"`, or
   * a local marker whose preserved cause name is `AbortError`. pi-ai can wrap
   * an abort that fired before the parent signal flipped, so this is the only
   * trace of the Stop and the run has to report `aborted` from it. */
  private turnAborted = false;
  private contextCompactions = 0;
  private contextDegraded = false;
  /** Set when the turn-boundary guard throws because even the degraded
   * context does not fit; the synthetic stream error keeps this code. */
  private pendingContextOverflow?: { code: "SUBAGENT_CONTEXT_OVERFLOW"; message: string };
  private pendingProviderRetry?: ReturnType<typeof classifyAgentError>;
  private providerRetryInProgress = false;
  private providerTransientRetryAttempt = 0;
  private providerRateLimitRetryAttempt = 0;
  private provider: RuntimeProviderConfig;
  private thinkingLevel: SubagentThinkingLevel;
  private fallbackIndex = 0;
  private readonly attemptedModels = new Set<string>();
  private readonly modelFailures: NonNullable<SubagentRunResult["modelFailures"]> = [];
  private readonly retryState: SubagentProviderRetryState = {
    claim: (error, phase) => this.claimProviderRetry(error, phase),
  };
  private readonly runAbortController = new AbortController();
  /** Set once `run()` settles; steering a settled run is a no-op rejection. */
  private finished = false;
  /** Resolved self-handoff trigger; `off` keeps the whole feature inert. */
  private readonly selfHandoff: ResolvedSubagentSelfHandoffSettings;
  private readonly handoffState: SubagentHandoffState;
  /** A validated submission waiting for the next safe turn boundary. */
  private pendingHandoff?: SubagentHandoffPayload;
  /** The dispatch turn, kept verbatim across every handoff generation. */
  private handoffHeader?: AgentMessage[];
  /**
   * The rows this runtime authored through the child loop's `steer()`, in the
   * order the user sent them.
   *
   * This is the only record of which rows in the delegate's context are user
   * directions. A rollover rebuilds that context from scratch, so without this
   * ledger every direction the user sent after the dispatch turn would be
   * deleted at the first handoff — the delegate would keep working on a task
   * the user had already amended. Keeping the message objects makes retention
   * identity-based and duplicate-free; `handoffSteeringMessages` decides which
   * of them the current context actually holds.
   */
  private readonly steeringLedger: AgentMessage[] = [];
  /**
   * The transient request the next provider request carries.
   *
   * Held outside `state.messages` on purpose: the transcript records what the
   * delegate did, not the runtime's prompts, and an unanswered request must not
   * become permanent history. It is injected through `transformContext`, which
   * every provider request passes through — including the ones `agent.continue()`
   * issues after a provider retry or a model fallback.
   */
  private handoffRequest?: AgentMessage;

  constructor(opts: SubagentRunOptions) {
    this.opts = opts;
    this.provider = opts.provider;
    this.thinkingLevel = opts.thinkingLevel;
    this.selfHandoff = normalizeSubagentSelfHandoffSettings(opts.selfHandoff);
    this.handoffState = createSubagentHandoffState(Date.now());
    const tools = this.selfHandoff.kind === "off" ? opts.tools : this.toolsWithHandoff(opts.tools);
    this.attemptedModels.add(`${opts.provider.id}/${opts.provider.modelId}`);
    const binding = this.modelBinding();
    this.agent = new Agent({
      streamFn: binding.streamFn,
      getApiKey: binding.getApiKey,
      convertToLlm: (messages) =>
        convertToLlm(this.dedupeToolCalls(messages)),
      // The runtime's own request context; the durable transcript is untouched.
      // See `withHandoffRequest` for why the request travels here rather than
      // through the boundary's returned context.
      transformContext: async (messages) => this.withHandoffRequest(messages),
      // The same turn-boundary context protection the session has (ADR 0299):
      // re-estimate at each boundary, compact before the next request, degrade
      // before failing. The budget derives from this run's resolved model.
      prepareNextTurnWithContext: (context, signal) =>
        this.prepareNextTurn(context, signal),
      afterToolCall: async (context) => this.afterToolCall(context),
      initialState: {
        systemPrompt: opts.systemPrompt,
        model: binding.model,
        tools,
        thinkingLevel: binding.agentThinkingLevel,
        messages: opts.initialMessages ? [...opts.initialMessages] : [],
      },
      toolExecution: "sequential",
    });
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  async run(): Promise<SubagentRunResult> {
    const { signal } = this.opts;
    if (signal?.aborted) {
      this.finished = true;
      return this.result("aborted", "The delegated task was aborted before it started.");
    }
    const onAbort = () => {
      this.runAbortController.abort();
      this.agent.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let caughtError: ReturnType<typeof classifyAgentError> | undefined;
    try {
      const initialTaskMessage: AgentMessage = {
        role: "user",
        content: this.initialTaskContent(),
        timestamp: Date.now(),
      };
      const agentState = this.agent.state;
      const preflightModel = agentState?.model ?? this.modelBinding().model;
      const preflightMessages = (agentState?.messages ?? []).filter(
        (message) => message.role !== "system",
      );
      const preflightSystemPrompt =
        agentState?.systemPrompt ?? this.opts.systemPrompt;
      const preflightTools = agentState?.tools ?? this.opts.tools;
      const initialContext = await prepareDelegateTurnContext({
        messages: preflightMessages,
        additionalMessages: [initialTaskMessage],
        model: preflightModel,
        taskBrief: this.opts.task,
        retentionMode: "active_turn",
        summaryModels: () =>
          delegateSummaryModels(
            this.provider,
            preflightModel,
            this.opts.sessionId,
            usage => this.recordUsage(usage),
          ),
        systemPrompt: preflightSystemPrompt,
        tools: preflightTools,
        retainTaskBriefOnDegradation: false,
        thinkingLevel: agentState?.thinkingLevel ?? this.thinkingLevel,
        signal: this.runSignal(),
      });
      if (this.runSignal().aborted) {
        this.finished = true;
        return this.result("aborted", "The delegated task was aborted.");
      }
      if (initialContext.kind === "overflow") {
        return this.result(
          "failed",
          "",
          subagentContextOverflowError(this.provider.modelId),
        );
      }
      if (initialContext.kind !== "unchanged") {
        this.installContextOutcome(initialContext);
      }
      if (this.selfHandoff.kind !== "off") {
        // The dispatch header is fixed here, before the opening turn joins the
        // transcript: every handoff generation rebuilds from exactly these
        // rows, so the original task can never be summarized away by a model
        // that forgot to preserve it. Directions the user sends to this run
        // later are not part of the header — they are kept by the run's own
        // steering ledger, which the rebuild replays after it.
        this.handoffHeader = [
          ...(agentState?.messages ?? []).filter(
            (message) => message.role !== "system",
          ),
          initialTaskMessage,
        ];
      }
      await this.agent.prompt(initialTaskMessage);
      await this.agent.waitForIdle();
      while (!signal?.aborted) {
        if (this.pendingProviderRetry) {
          await this.retryPendingProviderFailure();
        } else if (this.streamError && this.useNextModel()) {
          await this.agent.continue();
          await this.agent.waitForIdle();
        } else {
          break;
        }
      }
    } catch (error) {
      caughtError = classifyAgentError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.finalizeCurrentAssistant();
      this.finished = true;
    }

    if (signal?.aborted) {
      return this.result("aborted", "The delegated task was aborted.");
    }

    // A cancel the settled message itself reported outranks any failure text:
    // pi-ai can wrap an AbortError that fired before the parent signal flipped,
    // and the marker's preserved cause name is the only trace of the Stop. The
    // session runtime reads that same marker as an aborted turn.
    if (this.turnAborted) {
      return this.result("aborted", "The delegated task was aborted.");
    }
    if (this.mutationTermination) {
      return this.result("failed", this.lastReportText, this.mutationTermination);
    }
    if (caughtError) {
      if (caughtError.code === "TURN_ABORTED") {
        return this.result("aborted", "The delegated task was aborted.");
      }
      return this.result("failed", "", this.terminalError(caughtError));
    }
    if (this.streamError) {
      return this.result("failed", "", this.terminalError(this.streamError));
    }
    if (!this.lastReportText.trim()) {
      return this.result("failed", "", {
        code: "SUBAGENT_NO_REPORT",
        message: "The subagent finished without writing a report.",
      });
    }
    if (this.lastReportTruncated) {
      const produced = this.lastReportText.length;
      const stats = ` (${produced} characters produced before truncation)`;
      const hint = this.opts.delegationId
        ? ` Resume this delegation with Task(resume: "${this.opts.delegationId}").`
        : "";
      return this.result("failed", this.lastReportText, {
        code: "SUBAGENT_OUTPUT_TRUNCATED",
        message:
          `The subagent response exceeded the model's output token limit and was truncated${stats}.${hint}`,
        ...(this.opts.delegationId ? { resumeId: this.opts.delegationId } : {}),
        charactersProduced: produced,
      });
    }
    return this.result("completed", this.lastReportText);
  }

  private modelBinding() {
    return this.bindingFor(this.provider, this.thinkingLevel);
  }

  /**
   * The opening user turn's content.
   *
   * A text-only input stays a plain string, exactly as before images existed.
   * With images it becomes a block list: the text block first (omitted when the
   * input was images only, because providers reject an empty text block), then
   * one image block per attachment. The bytes travel to whatever endpoint this
   * run is bound to; nothing here consults a capability label.
   */
  private initialTaskContent(): UserMessage["content"] {
    const images = this.opts.initialImages ?? [];
    if (images.length === 0) return this.opts.task;
    const text = this.opts.task.trim() ? this.opts.task : "";
    return [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images,
    ];
  }

  /** True once `run()` settled; steering afterwards must be rejected, not queued. */
  isSettled(): boolean {
    return this.finished;
  }

  /**
   * This delegate's live model context.
   *
   * A delegate owns its own conversation (ADR 0062), so a decision that asks
   * "has this agent already seen X" has to read these messages, not the
   * parent's. Read-only: callers observe context, they never rewrite it.
   */
  contextMessages(): readonly AgentMessage[] {
    return this.agent.state.messages;
  }

  /**
   * Feed one user turn into the live child conversation (child steer).
   *
   * The input enters only this delegate's agent loop: the runtime emits the
   * attributed transcript echo itself, so the parent's model context never
   * sees it. Tools are untouched — nested `Task` and `asktool` stay denied.
   * Images travel as blocks next to the text and are offered to this run's
   * endpoint as they are; the model's capability metadata is not a gate.
   * Throws when the run already settled, so a stale steer fails loudly
   * instead of queuing onto a dead loop.
   */
  steer(text: string, images: readonly ImageContent[] = []): void {
    if (this.finished) {
      throw new Error("The subagent run already settled.");
    }
    const body = text.trim() ? text : "";
    const content: UserMessage["content"] = images.length
      ? [...(body ? [{ type: "text" as const, text: body }] : []), ...images]
      : body;
    const message: UserMessage = { role: "user", content, timestamp: Date.now() };
    this.agent.steer(message);
    // Recorded only after the loop accepted it: this row is now this runtime's
    // own user direction, and each rollover has to carry it forward. The
    // message object is the identity a later rebuild recognizes, so an
    // identical sentence sent twice stays two distinct directions.
    this.steeringLedger.push(message);
  }

  /**
   * Live progress without touching the usage ledger.
   *
   * `contextTokens` is the current estimated occupancy of this run's model
   * context, computed with the same budget semantics the compaction guard
   * uses — an estimate, not spend. It covers the committed transcript plus the
   * live partial row: a single long streamed response reaches `messages` only
   * at `message_end`, and its growth must be visible while it streams. The
   * partial row is charged as content, never read as a usage anchor — its
   * reported usage is still in flight. `usage` is the cumulative billed spend
   * reported by this run's provider requests. Unknown estimator shapes (rows
   * the heuristic cannot score) leave occupancy unknown rather than failing the
   * read.
   */
  progress(): {
    toolCalls: number;
    turns: number;
    usage?: MessageUsage;
    contextTokens?: number;
  } {
    let contextTokens: number | undefined;
    try {
      contextTokens = contextBudgetForStreaming(
        this.agent.state.model,
        this.agent.state.messages,
        this.agent.state.streamingMessage,
      ).tokens;
    } catch {
      contextTokens = undefined;
    }
    return {
      toolCalls: this.toolCalls,
      turns: this.turns,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
    };
  }

  /**
   * Estimate-relevant size of the row this run is streaming, for readers that
   * gate on streamed growth (the `context-tokens` wake).
   *
   * The transcript row a frame carries holds text and thinking only, while the
   * estimate also charges tool-call names and arguments. A delegate writing one
   * long argument therefore grows its context without growing its visible row;
   * this counter is the measure that covers both.
   */
  streamedChars(): number {
    return this.streamedRowChars;
  }

  private dedupeToolCalls(messages: AgentMessage[]): AgentMessage[] {
    const drop = dedupeToolCallMessages(messages);
    reportDuplicateToolCallDrop(this.opts.sessionId, drop);
    return drop.messages;
  }

  private recordUsage(usage: MessageUsage): void {
    this.usage = addUsage(this.usage, usage);
    this.emit({ type: "usage", usage });
  }

  private bindingFor(
    provider: RuntimeProviderConfig,
    thinkingLevel: SubagentThinkingLevel,
  ) {
    return subagentModelBinding({
      provider,
      thinkingLevel,
      sessionId: this.opts.sessionId,
      maxTokens: this.opts.definition.maxTokens,
      onUsage: usage => this.recordUsage(usage),
    }, this.retryState);
  }

  private installContextOutcome(
    outcome: Extract<DelegateTurnUpdate, { kind: "compacted" | "degraded" }>,
  ): void {
    this.agent.state.messages = replaceContextMessages({
      messages: this.agent.state.messages,
      replacement: outcome.messages,
    });
    if (outcome.kind === "compacted") {
      this.contextCompactions += 1;
    } else {
      this.contextDegraded = true;
    }
  }

  /**
   * The runtime-owned handoff tool, appended after the definition's own tools.
   *
   * Only attached when a trigger is enabled, so a run with self-handoff off
   * carries exactly the tool list it carried before this feature. It reaches
   * no host capability: it records a submission in the run that owns it, which
   * is why it needs no entry in the definition's assignable tool names and no
   * permission scope.
   */
  private toolsWithHandoff(tools: AgentTool[]): AgentTool[] {
    return [
      ...tools,
      createSubagentHandoffTool({
        onSubmit: (args) => this.acceptHandoffSubmission(args),
      }),
    ];
  }

  /**
   * Validate one submission and hold it for the next safe boundary.
   *
   * Nothing is cleared here: the payload is parked and the replacement happens
   * in `installPendingHandoff`, so a run that never reaches another boundary
   * (or is aborted first) keeps the history it had. A rejected submission
   * returns its reason to the model verbatim and counts toward the failure
   * budget, which is what stops a delegate from retrying the same bad shape
   * for a whole segment.
   *
   * An invalid payload keeps the request outstanding, so the delegate can
   * correct it in the same turn (the tool error is the correction prompt); a
   * valid one closes the request and clears the transient message with it.
   */
  private acceptHandoffSubmission(
    args: unknown,
  ): { ok: true } | { ok: false; error: string } {
    if (this.pendingHandoff) {
      return {
        ok: false,
        error:
          "A handoff is already recorded for this boundary. Keep working until it is applied.",
      };
    }
    if (!this.handoffState.requested) {
      return {
        ok: false,
        error:
          "No handoff was requested. Keep working on the delegated task; the runtime asks for a handoff when it is needed.",
      };
    }
    // The request has been delivered and answered either way; it must not be
    // re-sent with the delegate's correction.
    this.handoffRequest = undefined;
    const normalized = normalizeHandoffPayload(args);
    if (!normalized.ok) {
      this.handoffState.failures += 1;
      this.handoffState.unanswered = 0;
      return { ok: false, error: normalized.error };
    }
    this.pendingHandoff = normalized.payload;
    this.handoffState.requested = false;
    this.handoffState.failures = 0;
    this.handoffState.unanswered = 0;
    this.handoffState.requestedAtToolCalls = 0;
    return { ok: true };
  }

  /** Occupancy the next request would carry, or undefined when unmeasurable. */
  private measureRequestTokens(): number | undefined {
    try {
      return delegateRequestTokens({
        messages: this.agent.state.messages,
        model: this.agent.state.model,
        systemPrompt: this.agent.state.systemPrompt,
        tools: this.agent.state.tools,
      });
    } catch {
      return undefined;
    }
  }

  private handoffSnapshot(): SubagentHandoffSnapshot {
    const snapshot: SubagentHandoffSnapshot = {
      toolCalls: this.handoffState.toolCalls,
      turns: this.handoffState.turns,
      segmentElapsedMs: Math.max(
        0,
        Date.now() - this.handoffState.segmentStartedAt,
      ),
    };
    if (this.selfHandoff.kind === "context-tokens") {
      const contextTokens = this.measureRequestTokens();
      if (contextTokens !== undefined) snapshot.contextTokens = contextTokens;
    }
    return snapshot;
  }

  /**
   * Decide the trigger and park the request the next provider request carries.
   *
   * The snapshot is taken before any compaction pass, so a token threshold is
   * measured against the request the delegate would send on its own — the
   * context it still owns and can describe. Measuring after compaction would
   * hide every threshold at or above the compaction trigger, which is exactly
   * where a long-running delegate lives.
   *
   * A boundary that stops asking also drops the parked message: the request is
   * bound to the boundary that made it, so no stale instruction can leak into
   * a later request.
   */
  private scheduleHandoffRequest(snapshot: SubagentHandoffSnapshot): boolean {
    if (this.selfHandoff.kind === "off") return false;
    const decision = decideSubagentHandoff({
      settings: this.selfHandoff,
      state: this.handoffState,
      snapshot,
    });
    if (decision.action !== "request") {
      this.handoffRequest = undefined;
      return false;
    }
    this.handoffState.requested = true;
    this.handoffState.unanswered += 1;
    this.handoffState.requestedAtToolCalls = snapshot.toolCalls;
    this.handoffRequest = {
      role: "user",
      content: renderSubagentHandoffRequest({
        settings: this.selfHandoff,
        snapshot,
      }),
      timestamp: Date.now(),
    };
    return true;
  }

  /**
   * The request the next provider request carries.
   *
   * It rides on `transformContext` rather than on the boundary's returned
   * context because a provider retry and a model fallback both resume through
   * `agent.continue()`, which rebuilds the loop's context from
   * `state.messages`. A message that only lived in the boundary's return value
   * would be lost exactly when the delegate still needs it, and a message
   * written into `state.messages` would become durable history the delegate
   * never wrote. This hook runs for every provider request and appends
   * nothing to either list.
   */
  private withHandoffRequest(messages: AgentMessage[]): AgentMessage[] {
    return this.handoffRequest ? [...messages, this.handoffRequest] : messages;
  }

  /**
   * Whether the request the delegate would send now still fits the model's
   * safety boundary. When it does, the handoff request itself is the context
   * operation for this boundary and the lossy protection pass is skipped;
   * when it does not, safety comes first and the delegate is still asked.
   */
  private requestFitsWindow(snapshot: SubagentHandoffSnapshot): boolean {
    const tokens = snapshot.contextTokens ?? this.measureRequestTokens();
    if (tokens === undefined) return false;
    return tokens < contextBudgetLimitsFor(this.agent.state.model).hardLimit;
  }

  /**
   * Replace the previous handoff and the segment it absorbed with the one just
   * submitted, keeping the dispatch header and the user's directions verbatim.
   *
   * Rebuilding from the header — rather than splicing — is what keeps
   * generations from concatenating: exactly one summary row survives, whatever
   * its generation. The directions are selected by provenance from the rows the
   * delegate's context still holds (see `handoffSteeringMessages`), which is
   * also what keeps a direction pi has queued but not yet delivered out of the
   * replacement: that one arrives through the loop's own delivery right after
   * this boundary.
   */
  private installPendingHandoff(): boolean {
    const payload = this.pendingHandoff;
    if (!payload) return false;
    this.pendingHandoff = undefined;
    const now = Date.now();
    this.handoffState.handoffs += 1;
    const header = this.handoffHeader ?? this.dispatchHeader();
    const steering = handoffSteeringMessages({
      ledger: this.steeringLedger,
      messages: this.agent.state.messages,
      header,
    });
    const summary = renderSubagentHandoffSummary({
      payload,
      generation: this.handoffState.handoffs,
    });
    this.agent.state.messages = replaceContextMessages({
      messages: this.agent.state.messages,
      replacement: buildSubagentHandoffContext({ header, steering, summary, now }),
    });
    this.handoffState.toolCalls = 0;
    this.handoffState.turns = 0;
    this.handoffState.segmentStartedAt = now;
    this.handoffState.requested = false;
    this.handoffState.unanswered = 0;
    this.handoffState.requestedAtToolCalls = 0;
    this.handoffState.failures = 0;
    // The request that produced this submission is spent; a new segment starts
    // without one.
    this.handoffRequest = undefined;
    // A rollover that leaves the context trigger satisfied means the fixed
    // dispatch header is already past the threshold: rearming then requires
    // real work, so no boundary can ask again immediately.
    const threshold = this.selfHandoff.value;
    const occupancy = this.measureRequestTokens();
    this.handoffState.noProgress =
      this.selfHandoff.kind === "context-tokens" &&
      typeof threshold === "number" &&
      typeof occupancy === "number" &&
      occupancy >= threshold
        ? this.handoffState.noProgress + 1
        : 0;
    return true;
  }

  /** The dispatch turn as recorded at run start; a fallback for older runs. */
  private dispatchHeader(): AgentMessage[] {
    const task = this.agent.state.messages.find(
      (message) => message.role === "user",
    );
    this.handoffHeader = task ? [task] : [];
    return this.handoffHeader;
  }

  /**
   * Shape the delegate's next in-run turn, mirroring the session's
   * `prepareNextTurn` (ADR 0299, decisions 2-4). A compaction rewrites only
   * this agent's in-memory messages; nothing is persisted anywhere.
   *
   * Order is the contract:
   *
   * 1. A validated handoff replaces the previous generation — the rollover the
   *    delegate already agreed to.
   * 2. The trigger is decided against the request the delegate would send now,
   *    before any protection pass rewrites it. A token threshold at or above
   *    the compaction trigger is otherwise invisible: the compaction would
   *    shrink the very occupancy that was supposed to cross it.
   * 3. Protection runs last, and only when it is still needed. While the
   *    boundary is asking and the request still fits the model window, the
   *    handoff *is* this boundary's context operation: compacting first would
   *    summarize away the segment the delegate is being asked to describe.
   *    A request that no longer fits is compacted or degraded first, exactly
   *    as before, and the delegate is asked anyway.
   */
  private async prepareNextTurn(
    turn: PrepareNextTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined> {
    const handedOff = this.installPendingHandoff();
    const snapshot = this.handoffSnapshot();
    const requested = this.scheduleHandoffRequest(snapshot);
    const outcome: DelegateTurnUpdate =
      requested && this.requestFitsWindow(snapshot)
        ? { kind: "unchanged" }
        : await prepareDelegateTurnContext({
            messages: this.agent.state.messages,
            systemPrompt: this.agent.state.systemPrompt,
            tools: this.agent.state.tools,
            model: this.agent.state.model,
            taskBrief: this.opts.task,
            retentionMode: delegateRetentionMode(turn),
            summaryModels: () =>
              delegateSummaryModels(
                this.provider,
                this.agent.state.model,
                this.opts.sessionId,
                usage => this.recordUsage(usage),
              ),
            thinkingLevel: this.agent.state.thinkingLevel,
            signal: signal ?? this.runSignal(),
          });
    if (outcome.kind === "overflow") {
      // The Agent wrapper converts this throw into the normal error/agent_end
      // sequence; `message_end` picks the pending overflow up so the run
      // surfaces SUBAGENT_CONTEXT_OVERFLOW instead of a classified provider
      // error, and `useNextModel` still gets its fallback pass first. The
      // parked request survives the throw, so a fallback attempt carries it.
      this.pendingContextOverflow = subagentContextOverflowError(
        this.provider.modelId,
      );
      throw new Error(this.pendingContextOverflow.message);
    }
    if (outcome.kind !== "unchanged") this.installContextOutcome(outcome);
    if (!handedOff && outcome.kind === "unchanged") return undefined;
    return {
      context: {
        // The loop owns its context array: pi appends every streamed assistant
        // message and every tool result to the array it was handed, while its
        // own `message_end` listener appends the same message to
        // `state.messages`. Handing over the live array stores each message of
        // the run's later iterations twice, which doubles the estimate at the
        // next boundary and leaves `useNextModel` a trailing assistant row it
        // cannot resume from (D620). The handoff request travels through
        // `transformContext` instead, so no prompt ever enters this array.
        messages: [...this.agent.state.messages],
        tools: this.agent.state.tools,
      },
    };
  }

  /** Continue the same agent at the failed request; never replay completed tools. */
  private useNextModel(): boolean {
    // An aborted turn never continues, whether the signal flipped yet or the
    // cancel was only visible on the settled message.
    if (this.runSignal().aborted || this.turnAborted || !this.streamError || this.streamError.code === "TURN_ABORTED") return false;
    if (!this.opts.fallbackModels?.length) return false;
    const failed = this.agent.state.messages.at(-1);
    // Only a provider's terminal assistant error permits fallback. Host/tool
    // failures, cancellation, and unexpected internal exceptions do not.
    if (failed?.role !== "assistant" || failed.stopReason !== "error") return false;
    if (readLocalRequestErrorDetails(failed)) return false;
    this.recordModelFailure(`${this.provider.id}/${this.provider.modelId}`, this.streamError);
    // What an alternative would actually carry: the current context minus the
    // failed assistant row (ADR 0299 decision 6 re-evaluates it against each
    // alternative's own window before switching).
    const carried = this.agent.state.messages.slice(0, -1);
    while (this.fallbackIndex < this.opts.fallbackModels.length) {
      const next = this.opts.fallbackModels[this.fallbackIndex++];
      if (!next.provider) {
        this.recordModelFailure(next.key, {
          code: "MODEL_NOT_CONFIGURED",
          message: "The configured fallback model could not be resolved.",
        });
        continue;
      }
      const identity = `${next.provider.id}/${next.provider.modelId}`;
      if (this.attemptedModels.has(identity)) continue;
      this.attemptedModels.add(identity);
      const requested = this.opts.definition.thinkingLevel ?? this.opts.inheritedThinkingLevel ?? this.opts.thinkingLevel;
      const thinking = requested === "omit" ? "omit" : clampThinkingLevel(next.provider, requested);
      const binding = this.bindingFor(next.provider, thinking);
      // An alternative whose window cannot hold the carried context would fail
      // identically to the model it replaces; skip it with the reason recorded
      // instead of burning the slot on the same overflow.
      const budget = contextBudgetFor(binding.model, carried);
      if (budget.tokens >= budget.hardLimit) {
        this.recordModelFailure(identity, {
          code: "SUBAGENT_CONTEXT_OVERFLOW",
          message: `The carried context (~${budget.tokens} tokens) does not fit this model's safe budget (${budget.hardLimit} tokens).`,
        });
        continue;
      }
      this.provider = next.provider;
      this.thinkingLevel = thinking;
      this.agent.state.model = binding.model;
      this.agent.state.thinkingLevel = binding.agentThinkingLevel;
      this.agent.streamFunction = binding.streamFn;
      this.agent.getApiKey = binding.getApiKey;
      this.agent.state.messages = carried;
      this.streamError = undefined;
      this.providerTransientRetryAttempt = 0;
      this.providerRateLimitRetryAttempt = 0;
      this.lastReportText = "";
      this.opts.onModelChange?.(this.provider, this.thinkingLevel);
      return !this.runSignal().aborted;
    }
    return false;
  }

  private recordModelFailure(model: string, error: { code: string; message: string }): void {
    this.modelFailures.push({ model, ...error });
    this.emit({
      type: "message_end",
      message: {
        ...this.newAssistantRow(),
        content: `Model ${model} failed (${error.code}): ${error.message}`,
        status: "error",
        isError: true,
      },
    });
  }

  private claimProviderRetry(
    error: ReturnType<typeof classifyAgentError>,
    phase: "request" | "stream",
  ): number | undefined {
    if (!error.retriable) return undefined;
    const infinite = this.opts.infiniteProviderRetry === true;
    if (error.code === "PROVIDER_RATE_LIMITED") {
      if (!infinite && this.providerRateLimitRetryAttempt >= PROVIDER_RATE_LIMIT_MAX_RETRIES) {
        return undefined;
      }
      return ++this.providerRateLimitRetryAttempt;
    }
    // Setup and stream failures share one bounded budget, exactly as the main
    // session does, so a delegate is not abandoned on a single gateway 502.
    void phase;
    if (!isTransientProviderRetryCode(error.code)) return undefined;
    if (!infinite && this.providerTransientRetryAttempt >= PROVIDER_TRANSIENT_MAX_RETRIES) {
      return undefined;
    }
    return ++this.providerTransientRetryAttempt;
  }

  private async retryPendingProviderFailure(): Promise<void> {
    const retryError = this.pendingProviderRetry;
    if (!retryError) return;
    this.pendingProviderRetry = undefined;
    const messages = [...this.agent.state.messages];
    if (messages.at(-1)?.role !== "assistant") {
      throw new Error("Cannot retry a subagent provider stream without its failed assistant message");
    }
    // A failed provider stream can leave more than one assistant row after a
    // tool round. Remove the entire failed suffix before continuing.
    while (messages.at(-1)?.role === "assistant") messages.pop();
    this.agent.state.messages = messages;
    this.providerRetryInProgress = true;
    try {
      const delayMs =
        retryError.code === "PROVIDER_RATE_LIMITED"
          ? providerRateLimitDelayMs(
              this.providerRateLimitRetryAttempt,
              this.retryState.headers,
            )
          : providerSetupRetryDelayMs(
              this.providerTransientRetryAttempt,
              undefined,
              this.retryState.headers,
            );
      await delayWithAbort(delayMs, this.runSignal());
      if (this.opts.signal?.aborted) return;
      await this.agent.continue();
      await this.agent.waitForIdle();
    } finally {
      this.providerRetryInProgress = false;
    }
  }

  /**
   * The failure the parent receives once no fallback can proceed. A provider
   * overflow is remapped to the actionable delegate code (ADR 0299, decision
   * 5) — but only here, after `useNextModel` had its chance, so a larger
   * fallback window still rescues the run.
   */
  private terminalError(error: { code: string; message: string }): { code: string; message: string } {
    if (error.code === "CONTEXT_TOO_LARGE" || error.code === "SUBAGENT_CONTEXT_OVERFLOW") {
      return subagentContextOverflowError(this.provider.modelId);
    }
    return error;
  }

  private saveScratchReport(text: string): string | undefined {
    if (!this.opts.scratchDir || text.length <= MAX_SUBAGENT_REPORT_CHARS) {
      return undefined;
    }
    try {
      const dir = join(
        this.opts.scratchDir,
        "delegations",
        scratchPathSegment(this.opts.parentToolCallId),
      );
      mkdirSync(dir, { recursive: true });
      const target = join(dir, "report.md");
      writeFileSync(target, text, "utf8");
      return target;
    } catch {
      return undefined;
    }
  }

  private result(
    status: SubagentRunStatus,
    report: string,
    error?: {
      code: string;
      message: string;
      resumeId?: string;
      charactersProduced?: number;
    },
  ): SubagentRunResult {
    const name = this.opts.definition.name;
    const body = report.trim();
    const text =
      status === "completed"
        ? body
        : status === "aborted"
          ? `The ${name} subagent was aborted after ${this.turns} turn(s).`
          : [
              `The ${name} subagent failed after ${this.turns} turn(s): ${error?.message ?? "unknown error"}.`,
              ...(body ? ["Its last output was:", body] : []),
            ].join("\n\n");
    // A degraded run must say so, or the parent would read a partial answer
    // as a complete one (ADR 0299, decision 4).
    const degradationNote = this.contextDegraded
      ? "Note: this subagent's context exceeded its model's window and older working history was discarded without a summary, so this report may be incomplete."
      : undefined;
    const preamble = [
      ...this.modelFailures.map(
        (failure) =>
          `Model ${failure.model} failed (${failure.code}): ${failure.message}`,
      ),
      ...(degradationNote ? [degradationNote] : []),
    ];
    const scratchReportPath = this.saveScratchReport(text);
    let finalReport: string;
    if (scratchReportPath) {
      const notice = `Complete subagent report (${text.length} characters) was saved to: ${scratchReportPath}`;
      finalReport =
        preamble.length > 0 ? `${preamble.join("\n\n")}\n\n${notice}` : notice;
    } else {
      finalReport = boundedReport([...preamble, text].join("\n\n"));
    }
    return {
      agentName: name,
      modelId: this.provider.modelId,
      thinkingLevel: this.thinkingLevel,
      status,
      report: finalReport,
      turns: this.turns,
      toolCalls: this.toolCalls,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.modelFailures.length ? { modelFailures: [...this.modelFailures] } : {}),
      ...(this.contextCompactions > 0 ? { contextCompactions: this.contextCompactions } : {}),
      ...(this.contextDegraded ? { contextDegraded: true } : {}),
      ...(this.lastReportTruncated ? { outputTruncated: true } : {}),
      ...(this.handoffState.handoffs > 0 ? { handoffs: this.handoffState.handoffs } : {}),
      ...(scratchReportPath ? { scratchReportPath } : {}),
      ...(error ? { error } : {}),
    };
  }

  /** Parent bookkeeping: host failures and a mutation-failure terminate. */
  private async afterToolCall(
    context: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> {
    const parent = this.opts.resolveToolOutcome?.(context);
    const terminate = parent?.terminate === true;
    if (!parent?.isError && !terminate) return undefined;
    if (terminate && parent?.error) this.mutationTermination = parent.error;
    return {
      ...(parent?.isError ? { isError: true } : {}),
      ...(terminate ? { terminate: true } : {}),
    };
  }

  private emit(event: AgentEventEnvelope["event"]): void {
    this.opts.onEvent({
      sessionId: this.opts.sessionId,
      turnId: this.opts.turnId,
      ts: Date.now(),
      event,
      parentToolCallId: this.opts.parentToolCallId,
      agentName: this.opts.definition.name,
    });
  }

  /**
   * Idle and duration watchdogs are withdrawn (D328). Stopping a delegate is
   * the parent agent's `TaskStop` or the user's Stop, not a timer, so the
   * only abort sources are the parent's signal and this run's own controller.
   */
  private runSignal(): AbortSignal {
    return AbortSignal.any(
      this.opts.signal
        ? [this.opts.signal, this.runAbortController.signal]
        : [this.runAbortController.signal],
    );
  }

  private newAssistantRow(): UiMessage {
    return {
      id: randomUUID(),
      role: "assistant",
      content: "",
      createdAt: nowIso(),
      status: "streaming",
      modelId: this.provider.modelId,
      providerId: this.provider.id,
      parentToolCallId: this.opts.parentToolCallId,
      agentName: this.opts.definition.name,
    };
  }

  /**
   * Tell the parent transcript which calls this delegate has named but not yet
   * finished writing. The rows are transient and execution-neutral: they only
   * put each call where it happened, and `tool_start` replaces it in place.
   */
  private prepareToolCalls(event: AssistantMessageEvent | undefined): void {
    // A synthetic or truncated update carries no provider frame: there is
    // nothing to learn from it, and nothing to prepare.
    if (!event) return;
    for (const call of this.toolArgsPreparation.observe(event)) {
      this.emit({
        type: "tool_prepare",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        ...(call.taskTitle ? { taskTitle: call.taskTitle } : {}),
        ...(call.ready ? { ready: true } : {}),
      });
    }
  }

  /**
   * Charge tool-call arguments as they are written.
   *
   * Arguments exist only as stream frames: by the time the call is in the row
   * it is settled, and measuring them then would `JSON.stringify` a
   * half-written argument on every frame. Deltas are the increment, so the
   * accounting stays O(delta) instead of O(arguments).
   */
  private trackStreamedToolCalls(event: AssistantMessageEvent | undefined): void {
    if (!event) return;
    if (event.type === "toolcall_delta") {
      this.streamedToolCallChars += event.delta.length;
      return;
    }
    // Some providers emit the whole call at once and never send a delta: the
    // block is already written when it first appears.
    if (event.type !== "toolcall_start") return;
    const block = event.partial.content[event.contentIndex];
    if (block?.type !== "toolCall") return;
    this.streamedToolCallChars +=
      block.name.length + (JSON.stringify(block.arguments)?.length ?? 0);
  }

  /**
   * Translate delegate events into transcript events.
   *
   * Only message and tool events are forwarded. `agent_end`, `turn_end` and
   * error events stay inside: Electron main ends the durable turn on those,
   * and a delegate finishing must never end the parent's turn.
   */
  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.turns += 1;
        this.handoffState.turns += 1;
        break;
      case "message_start": {
        if (event.message.role !== "assistant") break;
        const content = assistantContent((event.message as AssistantMessage).content);
        const retryingAssistant = this.providerRetryInProgress
          ? this.currentAssistant
          : undefined;
        this.streamStartedAt = Date.now();
        this.toolArgsPreparation.reset();
        this.streamedRowChars = 0;
        this.streamedToolCallChars = 0;
        this.emittedRowChars = 0;
        this.currentAssistant = {
          ...(retryingAssistant ?? this.newAssistantRow()),
          content: content.text,
          ...(content.hasThinking && content.thinking
            ? { thinking: content.thinking }
            : {}),
          status: "streaming",
        };
        if (retryingAssistant) {
          this.providerRetryInProgress = false;
          this.emit({ type: "message_update", message: this.currentAssistant });
        } else {
          this.emit({ type: "message_start", message: this.currentAssistant });
        }
        break;
      }
      case "message_update": {
        if (!this.currentAssistant || event.message.role !== "assistant") break;
        this.prepareToolCalls(event.assistantMessageEvent);
        this.trackStreamedToolCalls(event.assistantMessageEvent);
        const content = assistantContent((event.message as AssistantMessage).content);
        const previousText = this.currentAssistant.content;
        const previousThinking = this.currentAssistant.thinking ?? "";
        const nextText = content.hasText ? content.text : previousText;
        const nextThinking = content.hasThinking
          ? content.thinking
          : previousThinking;
        const textDelta = content.hasText
          ? cumulativeDelta(previousText, content.text)
          : { delta: "", reset: false };
        const thinkingDelta = content.hasThinking
          ? cumulativeDelta(previousThinking, content.thinking)
          : { delta: "", reset: false };
        this.currentAssistant = {
          ...this.currentAssistant,
          content: nextText,
          ...(nextThinking ? { thinking: nextThinking } : {}),
          status: "streaming",
        };
        this.streamedRowChars =
          nextText.length + nextThinking.length + this.streamedToolCallChars;
        const growing =
          this.streamedRowChars - this.emittedRowChars >=
          STREAM_PROGRESS_EVALUATION_CHARS;
        // A frame carries visible growth, or — when only tool-call arguments
        // are being written — one frame per growth quantum. The base waker
        // charges arguments, so without that frame an argument stream long
        // enough to cross the `context-tokens` threshold would stay invisible
        // until `message_end`, which is the one event a long response delays.
        const visibleDelta = Boolean(
          textDelta.delta || thinkingDelta.delta || textDelta.reset || thinkingDelta.reset,
        );
        if (visibleDelta || growing) {
          this.emittedRowChars = this.streamedRowChars;
          this.emit({
            type: "message_update",
            message: this.currentAssistant,
            ...(textDelta.delta ? { deltaText: textDelta.delta } : {}),
            ...(thinkingDelta.delta ? { deltaThinking: thinkingDelta.delta } : {}),
            ...(textDelta.reset ? { resetText: true } : {}),
            ...(thinkingDelta.reset ? { resetThinking: true } : {}),
            // A frame with no visible delta marks itself delta-shaped with an
            // empty `deltaText`: the wire slimmer and the stream coalescer then
            // treat it like every other append-only frame instead of
            // serializing the whole cumulative row for growth the renderer
            // already shows. The field is the existing one, so this adds no
            // protocol surface.
            ...(!visibleDelta ? { deltaText: "" } : {}),
          });
        }
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const message = event.message as AssistantMessage;
        const content = assistantContent(message.content);
        const stopReason = message.stopReason as string | undefined;
        // Read the cancel off the settled message, the same way the session
        // runtime does: pi-ai wraps an AbortError that fired before the signal
        // flipped in a local marker whose preserved cause name is the only
        // trace of the Stop. An abort is not a failure, so it neither retries
        // nor produces an error row; other local errors stay terminal below.
        const localError = readLocalRequestErrorDetails(message);
        const aborted =
          stopReason === "aborted" || localError?.causeName === "AbortError";
        if (aborted) this.turnAborted = true;
        const failed = !aborted && stopReason === "error";
        let classifiedError: ReturnType<typeof classifyAgentError> | undefined;
        let retryAttempt: number | undefined;
        if (failed) {
          const overflow = this.pendingContextOverflow;
          this.pendingContextOverflow = undefined;
          if (overflow) {
            // The boundary guard threw after degradation still did not fit.
            // The synthetic failure message carries the thrown text; keep the
            // actionable code instead of classifying it as a provider error.
            this.streamError = overflow;
          } else {
            classifiedError = withProviderFetchFailure(
              classifyProviderError(message, this.retryState.status),
              this.retryState.failure,
            );
            retryAttempt = classifiedError.details?.origin === "local"
              ? undefined : this.claimProviderRetry(classifiedError, "stream");
            if (retryAttempt !== undefined) {
              this.pendingProviderRetry = classifiedError;
            } else {
              this.streamError = classifiedError.details?.origin === "local"
                ? classifiedError
                : { code: classifiedError.code, message: classifiedError.message };
            }
          }
        }
        if (!failed && !aborted) {
          this.providerTransientRetryAttempt = 0;
          this.providerRateLimitRetryAttempt = 0;
        }
        const messageUsage = usageFromPi(message.usage);
        this.usage = addUsage(this.usage, messageUsage);
        // The report is the last assistant text; a call-only turn has none and
        // must not clear the text an earlier turn already produced.
        if (content.hasText && content.text.trim() && !failed) {
          this.lastReportText = content.text;
          this.lastReportTruncated =
            stopReason === "length" || stopReason === "max_tokens";
        }
        if (retryAttempt !== undefined) {
          this.currentAssistant = {
            ...(this.currentAssistant ?? this.newAssistantRow()),
            content: content.hasText
              ? content.text
              : (this.currentAssistant?.content ?? ""),
            ...(content.hasThinking && content.thinking
              ? { thinking: content.thinking }
              : {}),
            status: "streaming",
            ...(messageUsage ? { usage: messageUsage } : {}),
          };
          this.emit({ type: "message_update", message: this.currentAssistant });
          break;
        }
        const row: UiMessage = {
          ...(this.currentAssistant ?? this.newAssistantRow()),
          content: content.hasText
            ? content.text
            : (this.currentAssistant?.content ?? ""),
          ...(content.hasThinking && content.thinking
            ? { thinking: content.thinking }
            : {}),
          status: failed ? "error" : aborted ? "aborted" : "complete",
          ...(messageUsage ? { usage: messageUsage } : {}),
          ...(failed ? { isError: true } : {}),
          ...(classifiedError?.details?.origin === "local" ||
              isCertificateVerificationError(classifiedError?.details?.networkCode)
            ? { error: classifiedError } : {}),
        };
        const durationMs = this.streamStartedAt !== undefined
          ? Math.max(0, Date.now() - this.streamStartedAt)
          : undefined;
        const responseOutputTokens = aborted && (!messageUsage || messageUsage.outputTokens <= 0)
          ? estimateVisibleResponseOutputTokens({ content: row.content, thinking: row.thinking })
          : undefined;
        const settledRow: UiMessage = {
          ...row,
          ...(durationMs !== undefined ? { modelStreamDurationMs: durationMs } : {}),
          ...(aborted && durationMs !== undefined ? { responseDurationMs: durationMs } : {}),
          ...(responseOutputTokens !== undefined ? { responseOutputTokens } : {}),
        };
        this.streamStartedAt = undefined;
        this.currentAssistant = undefined;
        this.emit({ type: "message_end", message: settledRow });
        break;
      }
      case "tool_execution_start":
        this.toolCalls += 1;
        this.handoffState.toolCalls += 1;
        this.emit({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_update":
        this.emit({
          type: "tool_update",
          toolCallId: event.toolCallId,
          partialResult: event.partialResult,
        });
        break;
      case "tool_execution_end":
        this.emit({
          type: "tool_end",
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        });
        break;
      default:
        break;
    }
  }

  /** Close a bubble left streaming when the run died without a message_end. */
  private finalizeCurrentAssistant(): void {
    if (!this.currentAssistant) return;
    if (this.currentAssistant.content.trim()) {
      this.lastReportText = this.currentAssistant.content;
    }
    const row: UiMessage = { ...this.currentAssistant, status: "aborted" };
    this.currentAssistant = undefined;
    this.emit({ type: "message_end", message: row });
  }
}
