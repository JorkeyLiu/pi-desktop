import type { SubagentWakeupSettings } from "@pi-desktop/shared";

/** Minimal surface the configure pathway needs from a live runtime. */
export type WakeupConfigurableRuntime = {
  setSubagentWakeup: (input?: SubagentWakeupSettings | null) => void;
};

/**
 * Apply a `sidecar.configure` payload to every live runtime.
 *
 * Field-absent means untouched (an unrelated settings save must not churn
 * waits); field-present — including explicit `null`/`undefined` — replaces
 * the session base atomically through the runtime's live setter, which
 * re-evaluates in-flight waits without resolving them. Disposed entries
 * are pruned so a stale session never blocks the rest.
 *
 * Returns true when at least one runtime was updated.
 */
export function applySubagentWakeupConfigure(
  runtimes: Map<string, WakeupConfigurableRuntime>,
  params: unknown,
): boolean {
  if (!params || typeof params !== "object" || !("subagentWakeup" in params)) {
    return false;
  }
  const wakeup = (params as { subagentWakeup?: SubagentWakeupSettings | null })
    .subagentWakeup;
  let applied = false;
  for (const [sessionId, runtime] of [...runtimes.entries()]) {
    try {
      runtime.setSubagentWakeup(wakeup);
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
