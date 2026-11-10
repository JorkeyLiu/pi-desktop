/**
 * Delegation resume: resolving a `Task(resume)` id to its chain and seeding
 * the continued run's history (ADR 0279).
 *
 * Kept out of `runtime.ts` so the hotspot owns only the call sites. Chain
 * storage stays with the runtime; every function here takes the chains,
 * the transcript, and the model bindings it needs explicitly.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  latestDelegationHandoffCheckpoint,
  type DelegationHandoffCheckpoint,
  type DelegationHandoffDirective,
  type SubagentDefinition,
  type UiMessage,
} from "@pi-desktop/shared";
import { hydrateAttachmentHistory } from "./attachment-history.js";
import type { DelegationChainRegistry } from "./delegation-chain.js";
import {
  chainDeliveryDirectives,
  chainRowsToMessages,
  mergeDeliveryDirectives,
  originalTaskFromTranscript,
  restorableHandoffCheckpoint,
  seedDelegateMessages,
  seedHandoffCheckpointMessages,
  selectChainRows,
  type DelegationChain,
} from "./delegation-history.js";
import { contextBudgetLimitsFor } from "./context-budget.js";
import { buildProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";

export type ResumeChainLookup =
  | { ok: true; chain: DelegationChain }
  | { ok: false; message: string };

function unknownResumeMessage(
  chains: DelegationChainRegistry,
  runningDelegationIds: ReadonlySet<string>,
  resume: string,
): string {
  return chains.unknownResumeError(
    resume,
    chains.resumableList({ runningDelegationIds }),
  );
}

function noHistoryResumeMessage(
  chains: DelegationChainRegistry,
  runningDelegationIds: ReadonlySet<string>,
  resume: string,
): string {
  return chains.noHistoryResumeError(
    resume,
    chains.resumableList({ runningDelegationIds }),
  );
}

/**
 * Resolve a `Task.resume` id to its chain, or fail with a message that tells
 * the model how to proceed (ADR 0276). The parent only ever sees
 * `delegationId`; the chain identity behind it stays internal.
 */
export function resolveResumeChain(
  chains: DelegationChainRegistry,
  runningDelegationIds: ReadonlySet<string>,
  resume: string,
  agentName: string,
): ResumeChainLookup {
  const lookup = chains.resolveResume({
    resume,
    agentName,
    runningDelegationIds,
  });
  if (lookup.ok) return lookup;
  const error = lookup.error;
  switch (error.kind) {
    case "unknown":
      return { ok: false, message: unknownResumeMessage(chains, runningDelegationIds, resume) };
    case "running":
      return {
        ok: false,
        message: `Delegation ${error.delegationId} is still running. Call TaskWait to converge with it first, or start a new delegation. Resuming a running delegation is not queued.`,
      };
    case "agent-mismatch":
      return {
        ok: false,
        message: `Delegation ${resume} belongs to the ${error.expected} subagent, not ${error.actual}. Resume it with the matching agent name, or start a new delegation.`,
      };
  }
}

export function unknownResumeErrorMessage(
  chains: DelegationChainRegistry,
  runningDelegationIds: ReadonlySet<string>,
  resume: string,
): string {
  return unknownResumeMessage(chains, runningDelegationIds, resume);
}

/**
 * A chain resolved but has nothing to replay. The caller drops it first, so
 * the id can never be advertised as reusable in its own error (ADR 0279 §4).
 */
export function noHistoryResumeErrorMessage(
  chains: DelegationChainRegistry,
  runningDelegationIds: ReadonlySet<string>,
  resume: string,
): string {
  return noHistoryResumeMessage(chains, runningDelegationIds, resume);
}

export type ResumeModelContext = {
  /** Definition pins plus fallback keys this definition may resolve. */
  definitionKeys: (definition: SubagentDefinition) => Set<string>;
  /** Opt-in override keys, separate from definition-only pinned bindings. */
  availableOverrideKeys: () => string[];
  /** Current binding for a delegation-model key, when granted. */
  bindingFor: (key: string) => RuntimeProviderConfig | undefined;
  /** This definition's own provider (its pin, or the session model). */
  definitionProvider: (
    definition: SubagentDefinition,
  ) => RuntimeProviderConfig | undefined;
  sessionProvider: RuntimeProviderConfig;
  /** On-demand grant resolution for a previously resolved key. */
  resolveModel: (key: string) => Promise<RuntimeProviderConfig | undefined>;
};

/**
 * The binding a resumed run keeps (ADR 0279 §4). A live chain records the
 * `providerId/modelId` key it resolved, which is preferred here; a chain
 * rebuilt from the transcript only knows the model id. Both paths are limited
 * to this definition's pins, session inheritance, and current override grants.
 */
export async function resumedChainProvider(
  chain: DelegationChain,
  definition: SubagentDefinition,
  context: ResumeModelContext,
): Promise<RuntimeProviderConfig | undefined> {
  const modelId = chain.latestModelId?.trim().toLowerCase();
  if (!modelId) return undefined;
  const keys = new Set([
    ...context.definitionKeys(definition),
    ...context.availableOverrideKeys(),
  ]);
  const binding = (key: string) =>
    keys.has(key) ? context.bindingFor(key) : undefined;
  const matches = (candidate: RuntimeProviderConfig | undefined) =>
    candidate?.modelId.trim().toLowerCase() === modelId;
  if (chain.latestModelKey) {
    const keyed = binding(chain.latestModelKey) ??
      await context.resolveModel(chain.latestModelKey);
    // A known binding must not silently become a different account with the
    // same model id after its grant disappears.
    return matches(keyed) ? keyed : undefined;
  }
  return [
    context.definitionProvider(definition),
    context.sessionProvider,
    ...[...keys].map(binding),
  ].find(matches);
}

/**
 * Roots a replayed delegate input may read an attachment from. Same
 * roots the session history uses; the attachment directory is the
 * host's content-addressed blob store for this session.
 */
export type ResumeAttachmentRoots = {
  scratchDir?: string;
  projectPath?: string;
  attachmentsDir?: string;
};

/** True when a hydrated row still carries image bytes the child can send. */
function rowCarriesImage(row: UiMessage): boolean {
  return (
    row.role === "user" &&
    (row.attachments ?? []).some(
      (attachment) =>
        attachment.kind === "image" &&
        typeof attachment.data === "string" &&
        attachment.data.length > 0,
    )
  );
}

/**
 * Re-read a delegate's persisted image inputs before replay.
 *
 * Older/refused refs and missing blobs degrade to the path text the row
 * recorded, matching restored session history. Capability metadata is not
 * consulted: a delegate input is images only, the host validated the bytes
 * when the user attached them, and the child endpoint decides what it can
 * read.
 */
async function hydrateResumedRows(
  rows: readonly UiMessage[],
  roots: ResumeAttachmentRoots,
): Promise<UiMessage[]> {
  if (!rows.some((row) => row.attachments?.length)) return [...rows];
  return hydrateAttachmentHistory([...rows], {
    scratchDir: roots.scratchDir,
    projectPath: roots.projectPath,
    attachmentsDir: roots.attachmentsDir,
    supportsVision: true,
  });
}

export type ResumedDelegateContext = {
  /**
   * Context this run replays for its first request.
   *
   * A checkpoint restores the installed context; a chain without one replays
   * its full history. It is replayed, never pinned: a later rollover rebuilds
   * from `directives`, so an old summary or an execution tail cannot survive one.
   */
  replay: AgentMessage[];
  /**
   * The fixed instruction header: the chain's original task and every delivered
   * `Task` or child-steering direction, in delivery order, each exactly once.
   *
   * This is what a rollover replaces the context with, together with the new
   * summary. It deliberately contains no summary and no execution history.
   */
  directives: AgentMessage[];
  /** The same instructions as durable records the next checkpoint carries. */
  directiveRecords: DelegationHandoffDirective[];
};

/**
 * The chain's replay seed plus the fixed instruction header a rollover needs.
 *
 * `undefined` means nothing can be continued: no text brief and no recoverable
 * image. The caller reports that as an unresumable chain.
 */
export async function seedResumedDelegateContext(
  transcriptHistory: readonly UiMessage[],
  chain: DelegationChain,
  provider: RuntimeProviderConfig,
  roots: ResumeAttachmentRoots = {},
): Promise<ResumedDelegateContext | undefined> {
  // A chain begun with an image-only input has no text brief in either the
  // live chain or its `Task` row. The hydrated rows are then the whole seed;
  // only a chain with no text and no recoverable image has nothing to resume.
  const originalTask = (
    chain.originalTask ??
    originalTaskFromTranscript(transcriptHistory, chain) ??
    ""
  ).trim();
  const rows = await hydrateResumedRows(
    selectChainRows(transcriptHistory, chain),
    roots,
  );
  if (!originalTask && !rows.some(rowCarriesImage)) return undefined;
  // The seed is truncated against the delegate's own budget (ADR 0299 §7),
  // derived from the same model the resumed run will use, so the first
  // request fits the window instead of overflowing on arrival.
  const model = buildProviderModel(provider);
  const budget = contextBudgetLimitsFor(model);
  // An installed handoff is the boundary this resume must honour: the context
  // it restores is the original task, the delivered directions, the installed
  // summary, then only the rows written after that boundary. The execution
  // history the handoff absorbed is never replayed. A checkpoint whose
  // boundary row is gone is skipped, and when none can be placed the seed is
  // exactly the pre-checkpoint full history.
  const checkpoint = restorableHandoffCheckpoint(chain.handoffCheckpoints, rows);
  const installed = checkpoint
    ? seedHandoffCheckpointMessages({
        checkpoint,
        rows,
        directives: checkpointDirectiveRows(checkpoint, rows),
        provider,
        model,
        budget,
      })
    : undefined;
  const replay =
    installed ??
    seedDelegateMessages({ originalTask, rows, provider, model, budget });
  const fixed = await resumedHandoffDirectives({
    transcriptHistory,
    chain,
    rows,
    provider,
    model,
    roots,
  });
  return { replay, ...fixed };
}

/**
 * Replay seed only, for callers that do not install a handoff header.
 *
 * A run that rolls its context over needs the split form above; keeping this
 * entry point means a caller without self-handoff sees exactly the previous
 * seed.
 */
export async function seedResumedDelegate(
  transcriptHistory: readonly UiMessage[],
  chain: DelegationChain,
  provider: RuntimeProviderConfig,
  roots: ResumeAttachmentRoots = {},
): Promise<AgentMessage[] | undefined> {
  const context = await seedResumedDelegateContext(
    transcriptHistory,
    chain,
    provider,
    roots,
  );
  return context?.replay;
}

/**
 * The chain's fixed instruction header, as provider messages and durable
 * records.
 *
 * The live derivation reads the transcript by provenance (a successful `Task`
 * invocation, or a tagged child row), and the newest checkpoint's recorded
 * list supplies instructions whose rows a truncated branch no longer holds.
 * Merging is identity-based, so a checkpoint and its live row never double and
 * two intentionally identical texts stay two instructions.
 */
async function resumedHandoffDirectives(options: {
  transcriptHistory: readonly UiMessage[];
  chain: DelegationChain;
  /** Hydrated chain rows, so a direction reuses the seed's own image bytes. */
  rows: readonly UiMessage[];
  provider: RuntimeProviderConfig;
  model: ReturnType<typeof buildProviderModel>;
  roots: ResumeAttachmentRoots;
}): Promise<Pick<ResumedDelegateContext, "directives" | "directiveRecords">> {
  const live = chainDeliveryDirectives(options.transcriptHistory, options.chain);
  const known = new Map<string, UiMessage>();
  for (const row of options.rows) known.set(row.id, row);
  for (const directive of live) {
    const hydrated = known.get(directive.row.id);
    if (hydrated) directive.row = hydrated;
  }
  const recorded =
    latestDelegationHandoffCheckpoint(options.chain.handoffCheckpoints ?? [])
      ?.directives ?? [];
  const merged = mergeDeliveryDirectives(recorded, live);
  // A recorded instruction whose row is gone still restores its text and refs;
  // hydrate those refs exactly like a replayed child row.
  const missing = merged
    .map((directive) => directive.row)
    .filter((row) => !known.has(row.id));
  if (missing.length) {
    for (const row of await hydrateResumedRows(missing, options.roots)) {
      known.set(row.id, row);
    }
  }
  const directives = chainRowsToMessages(
    merged.map((directive) => known.get(directive.row.id) ?? directive.row),
    options.provider,
    options.model,
  );
  const directiveRecords = merged.map(
    (directive, index): DelegationHandoffDirective => ({
      ...(directive.toolCallId ? { toolCallId: directive.toolCallId } : {}),
      ...(directive.rowId ? { rowId: directive.rowId } : {}),
      text: directive.text,
      ...(directive.attachments?.length
        ? { attachments: directive.attachments }
        : {}),
      ...(index === 0 ? { opening: true } : {}),
    }),
  );
  return { directives, directiveRecords };
}

/**
 * The delivered directions a checkpoint restores, as rows: the persisted row
 * that delivered each one when it still exists and lies before the boundary,
 * otherwise a synthesized row carrying what the checkpoint recorded.
 *
 * Identity, not text, decides which row is which — two intentionally identical
 * instructions stay two rows — and a direction whose row already sits after
 * the boundary is left out, because the restored tail replays it there.
 */
function checkpointDirectiveRows(
  checkpoint: DelegationHandoffCheckpoint,
  rows: readonly UiMessage[],
): UiMessage[] {
  const cursor = rows.findIndex((row) => row.id === checkpoint.throughRowId);
  const kept: UiMessage[] = [];
  for (const [index, directive] of checkpoint.directives.entries()) {
    const row = directive.rowId
      ? rows.find((candidate) => candidate.id === directive.rowId)
      : directive.toolCallId
        ? rows.find(
            (candidate) =>
              candidate.role === "user" &&
              candidate.parentToolCallId === directive.toolCallId &&
              candidate.steering === true,
          )
        : undefined;
    if (directive.opening) {
      // The original task is seeded first from the record's own text; its row
      // is only needed when the opening instruction carried images.
      if (!checkpoint.originalTask.trim() && row) kept.push(row);
      continue;
    }
    if (row && cursor >= 0) {
      if (rows.indexOf(row) > cursor) continue;
      kept.push(row);
      continue;
    }
    if (!row && !directive.text.trim() && !directive.attachments?.length) continue;
    kept.push({
      id: directive.rowId ?? `handoff-directive-${index}`,
      role: "user",
      content: directive.text,
      createdAt: checkpoint.installedAt,
      status: "complete",
      ...(directive.attachments?.length
        ? { attachments: directive.attachments }
        : {}),
    });
  }
  return kept;
}
