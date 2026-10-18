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
    case "not-resumable":
      return {
        ok: false,
        message: `Delegation ${resume} ended as "${error.status}" and cannot be resumed. Only completed, failed, timed-out, or interrupted delegations continue; start a new delegation instead.`,
      };
    case "agent-mismatch":
      return {
        ok: false,
        message: `Delegation ${resume} belongs to the ${error.expected} subagent, not ${error.actual}. Resume it with the matching agent name, or start a new delegation.`,
      };
    case "over-budget":
      return {
        ok: false,
        message: `Delegation ${resume} has read too much to resume cheaply. Start a new delegation and point it at the specific files it should re-read.`,
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
 * Rebuild the delegate's prior conversation from its transcript rows. The
 * rows carry `parentToolCallId` for exactly the chain's `Task` calls, so the
 * replay never picks up the parent's own rows or a sibling delegate's.
 */
export function seedResumedDelegate(
  transcriptHistory: readonly UiMessage[],
  chain: DelegationChain,
  provider: RuntimeProviderConfig,
): AgentMessage[] | undefined {
  const originalTask =
    chain.originalTask ??
    originalTaskFromTranscript(transcriptHistory, chain);
  if (!originalTask) return undefined;
  const rows = selectChainRows(transcriptHistory, chain);
  if (rows.length === 0) return undefined;
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
