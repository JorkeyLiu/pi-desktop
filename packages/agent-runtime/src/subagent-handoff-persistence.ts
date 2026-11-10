/**
 * Durable handoff boundary: turning one installed context into the delegation
 * chain's checkpoint record (ADR 0333).
 *
 * Kept out of `runtime.ts` so the hotspot owns only the call site. The caller
 * owns the live record and the chain registry; this module owns the record's
 * shape, the boundary cursor, and the append that makes it durable.
 *
 * The write goes through the existing `session.appendMessage` path and is
 * awaited. Host-core rewrites a `Task` row's snapshot in place, so the record
 * lives in that row's open `details` — no schema, migration, or event.
 */

import {
  DELEGATION_HANDOFF_CHECKPOINT_VERSION,
  type DelegationHandoffCheckpoint,
  type DelegationHandoffDirective,
  type UiMessage,
} from "@pi-desktop/shared";
import type { RuntimeHost } from "./host-client.js";
import {
  chainDeliveryDirectives,
  mergeDeliveryDirectives,
  selectChainRows,
  type DelegationChain,
} from "./delegation-history.js";
import { settledDelegationMessage } from "./delegation-message.js";
import type { InstalledSubagentHandoff } from "./subagent-handoff.js";

/** The delegation facts a checkpoint names; the live record is the caller's. */
export type HandoffCheckpointTask = {
  delegationId: string;
  /** The `Task` call that started the run owning this checkpoint. */
  sourceToolCallId: string;
  /** Turn that owns the `Task` row. */
  turnId?: string;
  /** Persisted `Task` row the checkpoint rides. */
  taskMessage?: UiMessage;
  /** Open `Task` row details the caller already computed for this run. */
  details: Record<string, unknown>;
};

export type WrittenHandoffCheckpoint = {
  checkpoint: DelegationHandoffCheckpoint;
  /** The `Task` row exactly as it was appended. */
  taskMessage: UiMessage;
};

/**
 * Resolve the durable boundary cursor from the rows the installed context
 * absorbed.
 *
 * Every id the run reports must be a persisted child row; the latest one in
 * chain order is the boundary. A run that reports no placeable row is refused
 * rather than recorded against a guessed position — the chain then keeps its
 * previous checkpoint or none.
 */
function boundaryRow(
  transcriptHistory: readonly UiMessage[],
  chain: DelegationChain,
  absorbedRowIds: readonly string[],
): UiMessage | undefined {
  const chainRows = selectChainRows(transcriptHistory, chain);
  let last: UiMessage | undefined;
  let lastIndex = -1;
  for (const id of absorbedRowIds) {
    const row = chainRows.find((candidate) => candidate.id === id);
    if (!row) continue;
    const index = chainRows.indexOf(row);
    if (index > lastIndex) {
      last = row;
      lastIndex = index;
    }
  }
  return last;
}

/**
 * The delivered instructions the installed context held, in delivery order.
 *
 * The run's own records are the durable base (a `Task` directive has no child
 * row of its own), live rows supply the identity and durable refs for what is
 * still persisted, and anything already sitting after the boundary is excluded
 * because the resumed tail replays it there. Matching is by `toolCallId` /
 * row id, never by text, so repeated identical instructions stay repeated.
 */
function boundaryDirectives(options: {
  transcriptHistory: readonly UiMessage[];
  chain: DelegationChain;
  recorded: readonly DelegationHandoffDirective[];
  boundary: UiMessage;
}): DelegationHandoffDirective[] {
  const chainRows = selectChainRows(options.transcriptHistory, options.chain);
  const cursor = chainRows.indexOf(options.boundary);
  const merged = mergeDeliveryDirectives(
    options.recorded,
    chainDeliveryDirectives(options.transcriptHistory, options.chain),
  );
  const kept: DelegationHandoffDirective[] = [];
  for (const directive of merged) {
    const row = directive.rowId
      ? chainRows.find((candidate) => candidate.id === directive.rowId)
      : undefined;
    if (row && cursor >= 0 && chainRows.indexOf(row) > cursor) continue;
    kept.push({
      ...(directive.toolCallId ? { toolCallId: directive.toolCallId } : {}),
      ...(directive.rowId ? { rowId: directive.rowId } : {}),
      text: directive.text,
      ...(directive.attachments?.length
        ? { attachments: directive.attachments }
        : {}),
      ...(kept.length === 0 ? { opening: true } : {}),
    });
  }
  return kept;
}

/**
 * Append one installed boundary to the delegation's `Task` row.
 *
 * Throws when the boundary cannot be named or the row has no persisted
 * `Task` message yet; the caller reports the failure and keeps the previous
 * boundary. It never mutates the live record: success or failure is the
 * caller's to apply.
 */
export async function writeInstalledHandoffCheckpoint(options: {
  host: Pick<RuntimeHost, "call">;
  sessionId: string;
  transcriptHistory: readonly UiMessage[];
  chain: DelegationChain;
  task: HandoffCheckpointTask;
  /** Durable instructions the run was given before it installed the boundary. */
  recorded: readonly DelegationHandoffDirective[];
  installed: InstalledSubagentHandoff;
}): Promise<WrittenHandoffCheckpoint> {
  const boundary = boundaryRow(
    options.transcriptHistory,
    options.chain,
    options.installed.absorbedRowIds,
  );
  if (!boundary) {
    throw new Error(
      "The installed handoff boundary has no persisted child row to name.",
    );
  }
  const taskMessage = options.task.taskMessage;
  if (!taskMessage) {
    throw new Error(
      "The delegation has no persisted Task row to carry a checkpoint.",
    );
  }
  const checkpoint: DelegationHandoffCheckpoint = {
    version: DELEGATION_HANDOFF_CHECKPOINT_VERSION,
    delegateSessionId: options.chain.delegateSessionId,
    delegationId: options.task.delegationId,
    sourceToolCallId: options.task.sourceToolCallId,
    agentName: options.chain.agentName,
    generation: options.installed.generation,
    throughRowId: boundary.id,
    summary: options.installed.summary,
    originalTask: options.chain.originalTask ?? "",
    directives: boundaryDirectives({
      transcriptHistory: options.transcriptHistory,
      chain: options.chain,
      recorded: options.recorded,
      boundary,
    }),
    installedAt: new Date(options.installed.installedAt).toISOString(),
  };
  const row = settledDelegationMessage(
    taskMessage,
    { ...options.task.details, handoffCheckpoint: checkpoint },
  );
  await options.host.call("session.appendMessage", {
    sessionId: options.sessionId,
    turnId: options.task.turnId,
    message: row,
  });
  return { checkpoint, taskMessage: row };
}
