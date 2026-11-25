/**
 * Per-call cancellation for host-bound tool calls.
 *
 * host-core owns the authoritative cancellation: `tools.abort` cancels an
 * approval wait, a queued dispatch, or a running tool, keyed by
 * `(sessionId, toolCallId)`, and it reports the live cancellation back to
 * Electron main as `tools.aborted`. That report is what lets main stop the
 * side effect it started — plugin JS and MCP calls already run in this
 * process, so host-core alone cannot reach them.
 *
 * This registry is resource lifecycle only: one controller per in-flight
 * call, plus a short-lived tombstone for an abort whose `plugins.execute`
 * notification has not been handled yet. It grants no authority over any
 * call — every call is dispatched on its own identity, and the only thing
 * this can do is stop one exact `(sessionId, toolCallId)` that the runtime
 * already cancelled.
 */

/** The error an aborted call carries; `TOOL_ABORTED` is the documented code. */
function toolAbortedError(): Error & { code: string } {
  return Object.assign(new Error("tool call aborted"), { code: "TOOL_ABORTED" });
}

export type ToolCallCancellation = {
  /** Aborted while this call was live, or cancelled before it began. */
  readonly aborted: boolean;
  /** Signal handed to the plugin/MCP runtime for this exact call. */
  readonly signal: AbortSignal;
  /** Drop this call's controller; a later abort must not reach it again. */
  dispose(): void;
};

/**
 * Aborts older than this are forgotten, so a stale notice can never cancel a
 * newer call. Tool call ids are per-call identities; the window only has to
 * outlast the gap between `tools.aborted` and the `plugins.execute` it may
 * belong to.
 */
const ABORT_TOMBSTONE_TTL_MS = 30_000;
/** Bound on remembered tombstones; the oldest is dropped first. */
const MAX_ABORT_TOMBSTONES = 256;

export function createToolCancellationRegistry({
  tombstoneTtlMs = ABORT_TOMBSTONE_TTL_MS,
  maxTombstones = MAX_ABORT_TOMBSTONES,
  now = () => Date.now(),
}: {
  tombstoneTtlMs?: number;
  maxTombstones?: number;
  now?: () => number;
} = {}) {
  type Live = { controller: AbortController; aborted: boolean };
  const live = new Map<string, Live>();
  const tombstones = new Map<string, number>();

  /** A session id never contains a NUL, so the pair cannot be confused. */
  const callKey = (sessionId: string, toolCallId: string) => `${sessionId}\u0000${toolCallId}`;

  function prune(): void {
    const at = now();
    for (const [key, requestedAt] of tombstones) {
      if (at - requestedAt >= tombstoneTtlMs) tombstones.delete(key);
    }
    while (tombstones.size > maxTombstones) {
      const oldest = [...tombstones.entries()].sort((a, b) => a[1] - b[1])[0];
      if (!oldest) return;
      tombstones.delete(oldest[0]);
    }
  }

  /**
   * The user cancelled this call. An in-flight call is aborted here; a call
   * that has not been dispatched yet leaves a tombstone that `begin` consumes,
   * so it is refused instead of starting after the cancel.
   */
  function noteAbort(sessionId: string | null | undefined, toolCallId: string | null | undefined): void {
    if (!sessionId?.trim() || !toolCallId?.trim()) return;
    const key = callKey(sessionId, toolCallId);
    const entry = live.get(key);
    if (entry) {
      entry.aborted = true;
      entry.controller.abort(toolAbortedError());
      return;
    }
    prune();
    tombstones.set(key, now());
  }

  /**
   * Take responsibility for one call. `undefined` means the payload names no
   * per-call identity, so nothing can ever address a cancel to it. A consumed
   * tombstone aborts the call before anything starts; `probe.aborted` is then
   * true and the caller must not dispatch.
   */
  function begin(
    sessionId: string | null | undefined,
    toolCallId: string | null | undefined,
  ): ToolCallCancellation | undefined {
    if (!sessionId?.trim() || !toolCallId?.trim()) return undefined;
    const key = callKey(sessionId, toolCallId);
    prune();
    const cancelledBeforeDispatch = tombstones.delete(key);
    const controller = new AbortController();
    const entry: Live = { controller, aborted: cancelledBeforeDispatch === true };
    if (entry.aborted) controller.abort(toolAbortedError());
    live.set(key, entry);
    return {
      get aborted() {
        return entry.aborted;
      },
      get signal() {
        return controller.signal;
      },
      dispose() {
        if (live.get(key) === entry) live.delete(key);
      },
    };
  }

  /**
   * Drop every per-call record: the host that owned them is gone.
   *
   * A plugin or MCP call already dispatched is still running in this process
   * even though its host is gone, so each live controller is aborted first —
   * the signal reaches the runtime that started the work, and the replacement
   * host is never answered for a call its predecessor owned. Aborting before
   * clearing is what makes that reachable: `dispose()` is bound to this exact
   * entry, so a newer registration for the same `(sessionId, toolCallId)` is
   * untouched by the old generation.
   */
  function clear(): void {
    for (const entry of live.values()) {
      entry.aborted = true;
      entry.controller.abort(toolAbortedError());
    }
    live.clear();
    tombstones.clear();
  }

  return { begin, noteAbort, clear };
}

export type ToolCancellationRegistry = ReturnType<typeof createToolCancellationRegistry>;
