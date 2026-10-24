/**
 * Delegation resume: resolving a `Task(resume)` id to its chain and seeding
 * the continued run's history (ADR 0279).
 *
 * Kept out of `runtime.ts` so the hotspot owns only the call sites. Chain
 * storage stays with the runtime; every function here takes the chains,
 * the transcript, and the model bindings it needs explicitly.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SubagentDefinition, UiMessage } from "@pi-desktop/shared";
import { hydrateAttachmentHistory } from "./attachment-history.js";
import type { DelegationChainRegistry } from "./delegation-chain.js";
import {
  originalTaskFromTranscript,
  selectChainRows,
  seedDelegateMessages,
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

/**
 * Rebuild the delegate's prior conversation from its transcript rows. The
 * rows carry `parentToolCallId` for exactly the chain's `Task` calls, so the
 * replay never picks up the parent's own rows or a sibling delegate's.
 *
 * A run stopped before it emitted a single child event leaves no rows, but the
 * chain's original brief still seeds the continued run: the seed is that
 * brief alone, with no fabricated history. A chain that began with an
 * image-only input has no brief at all, so its hydrated image row is the
 * seed. Only a chain with neither text nor a recoverable image has nothing to
 * continue from, and returns `undefined`.
 */
export async function seedResumedDelegate(
  transcriptHistory: readonly UiMessage[],
  chain: DelegationChain,
  provider: RuntimeProviderConfig,
  roots: ResumeAttachmentRoots = {},
): Promise<AgentMessage[] | undefined> {
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
  return seedDelegateMessages({
    originalTask,
    rows,
    provider,
    model,
    budget: contextBudgetLimitsFor(model),
  });
}
