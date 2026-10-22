import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { frame, requireScroller as requireVisibleScroller, until, type Sampler } from "./upward-anchor-sampling";

/*
  Reader actions against the mounted pane: where the reading line is, how the
  reader gets there, and when the scroller has held still. Every reader movement
  is marked on the sampler so the frames it touches can subtract the movement
  the reader asked for.
*/
export type Reader = {
  requireScroller: () => HTMLDivElement;
  atBottom: () => boolean;
  /** Top of one node relative to the scroller's own top edge. */
  topOf: (node: Element) => number;
  /** The element at the reading line: the first mounted fragment in view. */
  anchorElement: () => HTMLElement | null;
  /** Fragments rendered inside the row that holds this node. */
  fragmentsInRow: (node: Element) => number;
  wheelUp: (delta: number) => Promise<void>;
  /**
   * Put the reader at offset 0 with one gesture, without awaiting a frame: the
   * offset is deliberately reached, then the boundary asks what it asks for.
   */
  arriveAtTop: () => void;
  /** A push at offset 0, where the scroller cannot move and emits no scroll event. */
  pushAtTop: () => void;
  readToBand: (stopAt: number) => boolean;
  positionAt: (node: HTMLElement, offset: number) => Promise<void>;
  /** Wait until the scroller has held still for four frames. */
  settle: (label: string) => Promise<void>;
  select: (sessionId: string) => Promise<void>;
};

export function createReader(options: {
  scroller: () => HTMLDivElement | null;
  sampler: Sampler;
  host: HTMLElement;
}): Reader {
  const { scroller, sampler, host } = options;
  const requireScroller = () => requireVisibleScroller(scroller);

  const atBottom = () => {
    const element = scroller();
    if (!element) return false;
    return Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight)) < 2;
  };
  const topOf = (node: Element) => {
    const element = requireScroller();
    return node.getBoundingClientRect().top - element.getBoundingClientRect().top;
  };
  const anchorElement = (): HTMLElement | null => {
    const element = requireScroller();
    const box = element.getBoundingClientRect();
    const margin = Math.min(120, box.height / 4);
    const nodes = [...element.querySelectorAll<HTMLElement>("[data-message-id]")];
    return nodes.find((node) => node.getBoundingClientRect().bottom - box.top > margin) ?? nodes[0] ?? null;
  };
  const fragmentsInRow = (node: Element) => {
    const row = node.closest<HTMLElement>(".message-row") ?? node;
    return row.querySelectorAll("[data-message-id]").length;
  };

  const settle = async (label: string) => {
    let stable = 0;
    for (let index = 0; index < 300; index++) {
      const before = sampler.samples.at(-1);
      await frame();
      const after = sampler.samples.at(-1);
      if (!before || !after) continue;
      const still = !before.input &&
        Math.abs(after.scrollTop - before.scrollTop) < 0.5 &&
        Math.abs(after.scrollHeight - before.scrollHeight) < 0.5 &&
        after.rows.length === before.rows.length;
      stable = still ? stable + 1 : 0;
      if (stable >= 4) return;
    }
    throw new Error(`The scroller did not settle: ${label}`);
  };

  const wheelUp = async (delta: number) => {
    const element = requireScroller();
    const before = element.scrollTop;
    sampler.markInput();
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -delta }));
    element.scrollTop = Math.max(0, element.scrollTop - delta);
    // What the reader asked for: at the exact top the scroller cannot move, and
    // then the reader asked for nothing at all.
    sampler.addInputDelta(element.scrollTop - before);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    await frame();
  };

  /**
   * Reach the near-top band with one wheel gesture. The offset is the reader's;
   * what the pane does with it afterwards (anchoring the row while it grows the
   * window or lands a page) is the behaviour under test, so the reach is
   * reported as applied rather than as the offset seen later.
   */
  const readToBand = (stopAt: number) => {
    const element = requireScroller();
    // Already in the band: still a reach, so the wheel gesture itself is what
    // the pane has to answer.
    const delta = Math.max(1, element.scrollTop - stopAt);
    const before = element.scrollTop;
    sampler.markInput();
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -delta }));
    element.scrollTop = stopAt;
    sampler.addInputDelta(element.scrollTop - before);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return true;
  };

  /**
   * Put one fragment on the reading line, the way a reader scrolling to it
   * would: the scroller moves, and a wheel plus a scroll event carry the
   * position to the pane.
   */
  const positionAt = async (node: HTMLElement, offset: number) => {
    const element = requireScroller();
    const before = element.scrollTop;
    const target = Math.max(0, element.scrollTop + topOf(node) - offset);
    sampler.markInput();
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -(before - target) }));
    element.scrollTop = target;
    sampler.addInputDelta(element.scrollTop - before);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
  };

  const arriveAtTop = () => {
    const element = requireScroller();
    const before = element.scrollTop;
    sampler.markInput();
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -before }));
    element.scrollTop = 0;
    sampler.addInputDelta(element.scrollTop - before);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  };

  /**
   * The boundary gesture the exact-top phase is about: at offset 0 the scroller
   * cannot move, so this push produces no scroll event of its own and only the
   * wheel listener sees it.
   */
  const pushAtTop = () => {
    const element = requireScroller();
    const before = element.scrollTop;
    sampler.markInput();
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    sampler.addInputDelta(element.scrollTop - before);
  };

  const select = async (sessionId: string) => {
    await useAppStore.getState().selectSession(sessionId);
    await frame();
    await until(() => !host.querySelector('[data-transcript-settling="true"]'), `settle ${sessionId}`);
    await settle(`settled ${sessionId}`);
  };

  return {
    requireScroller, atBottom, topOf, anchorElement, fragmentsInRow,
    wheelUp, arriveAtTop, pushAtTop, readToBand, positionAt, settle, select,
  };
}
