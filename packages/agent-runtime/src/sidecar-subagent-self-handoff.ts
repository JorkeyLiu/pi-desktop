import type { SubagentSelfHandoffSettings } from "@pi-desktop/shared";

/** Minimal surface the configure pathway needs from a live runtime. */
export type SelfHandoffConfigurableRuntime = {
  setSubagentSelfHandoff: (input?: SubagentSelfHandoffSettings | null) => void;
};

/**
 * Apply a `sidecar.configure` payload to every live runtime.
 *
 * Field-absent means untouched (an unrelated settings save must not churn a
 * session's trigger); field-present — including explicit `null`/`undefined` —
 * replaces the session base through the runtime's live setter, which governs
 * delegates spawned afterwards. Runs already in flight keep their trigger.
 * Disposed entries are pruned so a stale session never blocks the rest.
 *
 * Returns true when at least one runtime was updated.
 */
export function applySubagentSelfHandoffConfigure(
  runtimes: Map<string, SelfHandoffConfigurableRuntime>,
  params: unknown,
): boolean {
  if (!params || typeof params !== "object" || !("subagentSelfHandoff" in params)) {
    return false;
  }
  const selfHandoff = (
    params as { subagentSelfHandoff?: SubagentSelfHandoffSettings | null }
  ).subagentSelfHandoff;
  let applied = false;
  for (const [sessionId, runtime] of [...runtimes.entries()]) {
    try {
      runtime.setSubagentSelfHandoff(selfHandoff);
      applied = true;
    } catch (error) {
      if (error instanceof Error && error.message === "runtime disposed") {
        runtimes.delete(sessionId);
        continue;
      }
      throw error;
    }
  }
  return applied;
}
