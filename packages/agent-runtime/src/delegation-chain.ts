/**
 * In-memory chain registry for resumable delegations (ADR 0279).
 *
 * The registry is rebuilt from the session transcript at launch, then updated
 * as `Task` calls settle. It never appears in a tool parameter: the parent
 * only ever passes a `delegationId`, and the reverse map finds the chain.
 */

import { MAX_RESUMABLE_CHAINS_PER_AGENT } from "@pi-desktop/shared";
import {
  formatResumableList,
  type DelegationChain,
  type ResumableChain,
} from "./delegation-history.js";

/**
 * How a chain's last run ended is a historical fact, never a barrier: every
 * settled outcome (`completed`, `failed`, `timed_out`, `interrupted`,
 * `stopped`, `aborted`) can be continued. The only liveness gate is a still
 * running run — continuing it would fork a second execution on one chain.
 */
export type ChainLookupError =
  | { kind: "unknown" }
  | { kind: "running"; delegationId: string }
  | { kind: "agent-mismatch"; expected: string; actual: string };

export class DelegationChainRegistry {
  private readonly chains = new Map<string, DelegationChain>();
  /** Every live `delegationId` on a chain, pointing at that chain's session id. */
  private readonly byDelegationId = new Map<string, string>();

  hydrate(chains: DelegationChain[]): void {
    this.chains.clear();
    this.byDelegationId.clear();
    for (const chain of chains) this.install(chain);
  }

  lookup(delegationId: string): DelegationChain | undefined {
    const sessionId = this.byDelegationId.get(delegationId);
    if (!sessionId) return undefined;
    return this.chains.get(sessionId);
  }

  resolveResume(options: {
    resume: string;
    agentName: string;
    runningDelegationIds: ReadonlySet<string>;
  }): { ok: true; chain: DelegationChain } | { ok: false; error: ChainLookupError } {
    const chain = this.lookup(options.resume);
    if (!chain) return { ok: false, error: { kind: "unknown" } };
    if (chain.agentName !== options.agentName) {
      return {
        ok: false,
        error: {
          kind: "agent-mismatch",
          expected: chain.agentName,
          actual: options.agentName,
        },
      };
    }
    const latest = chain.latestDelegationId;
    if (latest && options.runningDelegationIds.has(latest)) {
      return { ok: false, error: { kind: "running", delegationId: latest } };
    }
    // No status or read-budget gate: a chain's settled outcome and how much it
    // read are history, not a permanent ban. The caller seeds the continued
    // run from the retained rows and lets the delegate's own budget protect
    // its context.
    return { ok: true, chain };
  }

  start(options: {
    delegateSessionId: string;
    delegationId: string;
    toolCallId: string;
    agentName: string;
    originalTask: string;
    objective: string;
    latestModelId?: string;
    /** `providerId/modelId` key that resolved, so a resume can re-resolve it. */
    latestModelKey?: string;
    resumedFrom?: DelegationChain;
  }): DelegationChain {
    const existing = options.resumedFrom
      ? this.chains.get(options.resumedFrom.delegateSessionId)
      : undefined;
    const chain: DelegationChain = existing
      ? {
          ...existing,
          toolCallIds: [...existing.toolCallIds, options.toolCallId],
          delegationIds: [...existing.delegationIds, options.delegationId],
          latestDelegationId: options.delegationId,
          latestObjective: options.objective || existing.latestObjective,
          latestModelId: options.latestModelId ?? existing.latestModelId,
          latestModelKey: options.latestModelKey ?? existing.latestModelKey,
          latestStatus: "running",
          lastActivityAt: Date.now(),
        }
      : {
          delegateSessionId: options.delegateSessionId,
          toolCallIds: [options.toolCallId],
          delegationIds: [options.delegationId],
          agentName: options.agentName,
          readFiles: [],
          readLineCount: 0,
          originalTask: options.originalTask,
          latestDelegationId: options.delegationId,
          latestObjective: options.objective,
          latestModelId: options.latestModelId,
          latestModelKey: options.latestModelKey,
          latestStatus: "running",
          lastActivityAt: Date.now(),
        };
    this.install(chain);
    return chain;
  }

  noteReads(
    delegateSessionId: string,
    files: readonly string[],
    lineCount: number,
  ): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    const merged = [...chain.readFiles];
    for (const file of files) {
      if (!merged.includes(file)) merged.push(file);
    }
    this.chains.set(delegateSessionId, {
      ...chain,
      readFiles: merged,
      readLineCount: chain.readLineCount + lineCount,
      lastActivityAt: Date.now(),
    });
  }

  /** Record the binding the running delegate switched to (fallback models). */
  retarget(
    delegateSessionId: string,
    binding: { modelKey?: string; modelId: string },
  ): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    this.chains.set(delegateSessionId, {
      ...chain,
      ...(binding.modelKey ? { latestModelKey: binding.modelKey } : {}),
      latestModelId: binding.modelId,
      lastActivityAt: Date.now(),
    });
  }

  settle(delegateSessionId: string, status: string): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    this.chains.set(delegateSessionId, {
      ...chain,
      latestStatus: status,
      lastActivityAt: Date.now(),
    });
  }

  drop(delegateSessionId: string): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    this.chains.delete(delegateSessionId);
    for (const id of chain.delegationIds) this.byDelegationId.delete(id);
  }

  /**
   * Chains the parent prompt may advertise, newest first. Every retained chain
   * is addressable by `Task(resume)` regardless of this list; the bound exists
   * only so a long session cannot grow the prompt without limit. The only
   * exclusion is a still-running run, which the parent should steer or wait on
   * instead of forking a second execution.
   */
  resumableList(options: {
    runningDelegationIds: ReadonlySet<string>;
  }): ResumableChain[] {
    const candidates: ResumableChain[] = [];
    for (const chain of this.chains.values()) {
      const latest = chain.latestDelegationId;
      if (!latest) continue;
      // A run still working is steered or waited on, never offered as a
      // continuation target. `runningDelegationIds` is the live authority;
      // `latestStatus` covers a chain the caller did not enumerate.
      if (chain.latestStatus === "running") continue;
      if (options.runningDelegationIds.has(latest)) continue;
      candidates.push({
        ...chain,
        latestDelegationId: latest,
        latestObjective: chain.latestObjective ?? "",
      });
    }
    candidates.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
    const listed: ResumableChain[] = [];
    const perAgent = new Map<string, number>();
    for (const chain of candidates) {
      const count = perAgent.get(chain.agentName) ?? 0;
      if (count >= MAX_RESUMABLE_CHAINS_PER_AGENT) continue;
      perAgent.set(chain.agentName, count + 1);
      listed.push(chain);
    }
    return listed;
  }

  promptBlock(options: {
    runningDelegationIds: ReadonlySet<string>;
  }): string {
    return formatResumableList(this.resumableList(options));
  }

  unknownResumeError(resume: string, list: readonly ResumableChain[]): string {
    const available = resumableSummary(list);
    return available
      ? `Unknown delegation "${resume}". Reusable: ${available}.`
      : `Unknown delegation "${resume}". No reusable subagent sessions in this conversation.`;
  }

  /**
   * A chain resolved but has nothing left to replay: its rows are gone from the
   * transcript (a truncated branch, or a delegation that died before writing
   * any). The caller drops the chain first, so the id in the error can never
   * also appear in its own "reusable" list (ADR 0279 §4).
   */
  noHistoryResumeError(resume: string, list: readonly ResumableChain[]): string {
    const available = resumableSummary(list);
    return available
      ? `Delegation "${resume}" has no recorded history in this conversation and cannot be continued. Reusable: ${available}.`
      : `Delegation "${resume}" has no recorded history in this conversation and cannot be continued. Start a new delegation.`;
  }

  private install(chain: DelegationChain): void {
    this.chains.set(chain.delegateSessionId, chain);
    for (const id of chain.delegationIds) {
      this.byDelegationId.set(id, chain.delegateSessionId);
    }
  }
}

/** `<agent> / <delegationId>` pairs for an error message's hint. */
function resumableSummary(list: readonly ResumableChain[]): string {
  return list
    .map((chain) => `${chain.agentName} / ${chain.latestDelegationId}`)
    .join(", ");
}
