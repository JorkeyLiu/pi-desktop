/*
  Frame sampling for the upward-anchor probe.

  Every animation frame it records the scroller's offset, height, and the
  geometry of every mounted row, plus whether the reader's own wheel moved in
  that frame. The reader input helpers mark their movement here so a measured
  shift can be separated from the shift the reader asked for.
*/

export const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

export async function until(predicate: () => boolean, label: string, maxFrames = 900) {
  for (let index = 0; index < maxFrames; index++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`Timed out: ${label}`);
}

export function requireScroller(scroller: () => HTMLDivElement | null): HTMLDivElement {
  const element = scroller();
  assert(element, "the visible pane has no transcript scroller");
  return element;
}

export type RowBox = { id: string; top: number; bottom: number };
export type Sample = {
  at: number;
  /** A wheel gesture was dispatched since the previous sample. */
  input: boolean;
  /**
   * How far the reader's own wheel moved the scroller in this frame. It is the
   * movement a reader asked for, so it is subtracted from the measured screen
   * shift: what is left is the movement no input explains.
   */
  inputDelta: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  rows: RowBox[];
};

export type Sampler = {
  /** Every frame captured since the last `startRecording`. */
  readonly samples: Sample[];
  /** Cost of a forced layout read: the mounted window has to be placed. */
  readonly forcedLayouts: number[];
  readonly longTasks: number[];
  start: () => void;
  stop: () => void;
  startRecording: () => void;
  capture: () => Sample;
  /** The reader dispatched a wheel gesture since the previous sample. */
  markInput: () => void;
  addInputDelta: (delta: number) => void;
};

export function createSampler(options: { scroller: () => HTMLDivElement | null }): Sampler {
  const { scroller } = options;
  const requireVisibleScroller = () => requireScroller(scroller);
  let pendingInput = false;
  let pendingInputDelta = 0;
  let sampling = true;
  let samples: Sample[] = [];
  let forcedLayouts: number[] = [];
  let longTasks: number[] = [];
  const observer = PerformanceObserver.supportedEntryTypes.includes("longtask")
    ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)))
    : undefined;
  observer?.observe({ type: "longtask" });

  const capture = (): Sample => {
    const element = requireVisibleScroller();
    const box = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].map((node) => {
      const rect = node.getBoundingClientRect();
      return { id: node.dataset.messageId!, top: rect.top - box.top, bottom: rect.bottom - box.top };
    });
    return {
      at: performance.now(), input: pendingInput, inputDelta: pendingInputDelta,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, rows,
    };
  };
  const sampler = () => {
    if (!sampling) return;
    if (scroller()) {
      samples.push(capture());
      pendingInput = false;
      pendingInputDelta = 0;
      const start = performance.now();
      void requireVisibleScroller().scrollHeight;
      forcedLayouts.push(performance.now() - start);
    }
    requestAnimationFrame(sampler);
  };

  return {
    get samples() { return samples; },
    get forcedLayouts() { return forcedLayouts; },
    get longTasks() { return longTasks; },
    start() { requestAnimationFrame(sampler); },
    stop() {
      sampling = false;
      observer?.disconnect();
    },
    startRecording() {
      samples = [];
      forcedLayouts = [];
      longTasks = [];
    },
    capture,
    markInput() { pendingInput = true; },
    addInputDelta(delta: number) { pendingInputDelta += delta; },
  };
}
