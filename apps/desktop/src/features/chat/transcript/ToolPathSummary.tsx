import { useLayoutEffect, useRef, useState } from "react";
import {
  fitToolPath,
  splitToolPath,
  type ToolPathParts,
} from "../../../lib/tool-path-display";

/**
 * The path hint of a collapsed tool row.
 *
 * The directory and the file name are separate boxes so the directory can give
 * up its width first (`.tool-row-summary.is-path` owns that layout), and the
 * pair is fitted from measured widths whenever the row changes width — a
 * sidebar drag, the child transcript, a window resize. The hidden measuring
 * span borrows the row's own font, so what is fitted is exactly what the row
 * paints, at whatever size that row happens to be.
 */
export function ToolPathSummary({ path }: { path: string }) {
  const measureRef = useRef<HTMLSpanElement | null>(null);
  // The unfitted path paints first: it is the row's own content, clipped the
  // way any overflowing hint is, and the layout effect below replaces it before
  // the frame reaches the screen.
  const [fit, setFit] = useState<ToolPathParts>(() => splitToolPath(path));

  useLayoutEffect(() => {
    const measurer = measureRef.current;
    // The box that clips the hint is the row's own summary span, which owns the
    // flex layout and therefore has the definite width to fit into.
    const box = measurer?.parentElement;
    if (!measurer || !box) return;
    const width = (text: string) => {
      measurer.textContent = text;
      return measurer.getBoundingClientRect().width;
    };
    let fittedWidth = -1;
    const refit = (available: number) => {
      // A row that is not painted yet has no width to fit into; the unfitted
      // value stays, and the observer refits as soon as it is measured.
      if (available <= 0) return;
      if (Math.abs(available - fittedWidth) < 0.5) return;
      fittedWidth = available;
      // One pixel of slack keeps a fitted value off the clip edge: the row
      // paints in whole pixels and the measurement does not.
      const budget = Math.max(0, available - 1);
      const next = fitToolPath(path, budget, width);
      measurer.textContent = "";
      setFit((current) =>
        current.dir === next.dir && current.base === next.base ? current : next,
      );
    };
    refit(box.getBoundingClientRect().width);
    // Without an observer (an environment that has no resize notifications) the
    // measured fit above still stands; it is simply not kept up to date.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) refit(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [path]);

  return (
    <>
      {fit.dir ? <span className="tool-path-dir">{fit.dir}</span> : null}
      <span className="tool-path-file">{fit.base}</span>
      <span ref={measureRef} className="tool-path-measure" aria-hidden="true" />
    </>
  );
}
