import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  createSubagentHydrationPump,
  initialSubagentHydration,
  subagentHydrationPending,
  subagentPaneVisible,
  subagentVisibleCount,
  type SubagentHydration,
  type SubagentHydrationPump,
} from "../../../../lib/subagent-hydration";

export type SubagentRowHydration = SubagentHydration & {
  /** The rows of the mounted run, in the same terms the projection uses. */
  visibleCount: number;
  /** Loaded rows a queued batch still has to mount. */
  pending: boolean;
  /** Stop the queued batch without losing what is mounted. */
  stop: () => void;
};

/**
 * The mounted run of a delegate transcript's loaded rows (see
 * `lib/subagent-hydration`).
 *
 * The pump is created once per pane and reused across every list it reconciles
 * with, so a replaced window, an older page, and a live row all go through the
 * same commit state instead of each render inventing one. It is disposed with
 * the pane, which cancels the queued frame: a tab switch, a chain change, or an
 * unmount never leaves a batch scheduled for rows that are gone.
 *
 * `visible` is the pane's own lifecycle gate - its layout box inside a
 * non-hidden window, from `useSubagentPaneVisible`. An invisible pane keeps the
 * rows it has mounted and schedules nothing; becoming visible again resumes the
 * batches from that same commit state, one batch per frame.
 *
 * `beforeBatch` runs synchronously before each batch commit that adds rows
 * above the reader, so the pane can capture the visible fragment while the
 * layout still holds it.
 */
export function useSubagentRowHydration(input: {
  /** Row identities of the whole loaded transcript, in physical order. */
  keys: readonly string[];
  /** Whether the pane has a visible box to draw into right now. */
  visible: boolean;
  beforeBatch?: () => void;
}): SubagentRowHydration {
  const beforeBatchRef = useRef(input.beforeBatch);
  beforeBatchRef.current = input.beforeBatch;
  const [state, setState] = useState<SubagentHydration>(() =>
    initialSubagentHydration(input.keys.length),
  );
  const pumpRef = useRef<SubagentHydrationPump | null>(null);
  if (!pumpRef.current) {
    pumpRef.current = createSubagentHydrationPump({
      publish: setState,
      beforeBatch: () => beforeBatchRef.current?.(),
    });
  }
  const pump = pumpRef.current;
  // The list identity is the whole input: `keys` is memoized on the transcript,
  // so this runs when rows appear, move, or are replaced - not on every
  // streamed character of a row that is already loaded.
  useLayoutEffect(() => {
    pump.observe(input.keys);
  }, [input.keys, pump]);
  useLayoutEffect(() => {
    pump.setActive(input.visible);
  }, [input.visible, pump]);
  useEffect(() => () => pump.dispose(), [pump]);
  return {
    ...state,
    visibleCount: subagentVisibleCount(state),
    pending: subagentHydrationPending(state),
    stop: pump.stop,
  };
}

/**
 * Whether a pane has a visible box: its own layout inside a non-hidden window.
 *
 * The two facts are read from the pane's owners instead of a global switch: a
 * `ResizeObserver` on the pane's scroll box reports whether it has layout (a
 * collapsed panel, a pane revealed by a layout change), and `visibilitychange`
 * reports whether the window is showing. Both are subscriptions, not polls, and
 * the observer is disconnected when the pane leaves.
 *
 * Server rendering has neither source, so the pane is visible by default there:
 * a single ssr commit must draw the bounded run it would draw in a window.
 */
export function useSubagentPaneVisible(elementRef: { readonly current: HTMLElement | null }): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const element = elementRef.current;
    const sync = () => {
      const windowVisible = document.visibilityState !== "hidden";
      const box = element?.getBoundingClientRect();
      setVisible(
        subagentPaneVisible({
          windowVisible,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
        }),
      );
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    const observer =
      typeof ResizeObserver === "function" && element
        ? new ResizeObserver(sync)
        : null;
    observer?.observe(element as HTMLElement);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      observer?.disconnect();
    };
  }, [elementRef]);
  return visible;
}
