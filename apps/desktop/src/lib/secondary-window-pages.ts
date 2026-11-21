import type { SecondaryWindowKind } from "../components/SecondaryWindow";

/**
 * Single source of truth for the secondary-window page modules. The layer's
 * `lazy()` wrappers and the idle warmup below share these loaders, so there
 * is exactly one import per destination and never a duplicate fetch system.
 */
export const secondaryWindowPageLoaders = {
  settings: () => import("../pages/SettingsPage"),
  plugins: () => import("../pages/PluginsPage"),
  scheduled: () => import("../pages/ScheduledPage"),
} satisfies Record<SecondaryWindowKind, () => Promise<unknown>>;

let warmPromise: Promise<void> | null = null;

/**
 * Import the three page modules sequentially without mounting anything or
 * reading any API: opening a window later then only commits. A failed import
 * (a first-run code push mid-flight) clears the promise so the on-demand
 * open retries instead of caching the failure.
 */
export function warmSecondaryWindowPages(): Promise<void> {
  if (!warmPromise) {
    warmPromise = (async () => {
      try {
        const kinds = Object.keys(secondaryWindowPageLoaders) as SecondaryWindowKind[];
        for (const kind of kinds) {
          await secondaryWindowPageLoaders[kind]();
        }
      } catch {
        warmPromise = null;
      }
    })();
  }
  return warmPromise;
}

/**
 * Start the warmup once the main thread idles after startup. The timeout
 * still warms on a busy thread; the caller runs this after `ready` so chat
 * startup always wins. Returns a cleanup that cancels a pending schedule.
 */
export function scheduleSecondaryWindowWarmup(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(() => void warmSecondaryWindowPages(), {
      timeout: 8000,
    });
    return () => window.cancelIdleCallback(id);
  }
  const timer = window.setTimeout(() => void warmSecondaryWindowPages(), 2500);
  return () => window.clearTimeout(timer);
}
