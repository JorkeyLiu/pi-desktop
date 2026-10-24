import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  COMPOSER_MAX_VISIBLE_ROWS,
  COMPOSER_MIN_HEIGHT_PX,
  cssPixels,
} from "../model";

/**
 * Grow a contenteditable composer between COMPOSER_MIN_HEIGHT_PX and
 * COMPOSER_MAX_VISIBLE_ROWS lines, then scroll instead of clipping.
 *
 * Layout only: the editor keeps owning its text and caret, so the surface that
 * owns the draft stays free to be the main composer or a panel composer. The
 * measured line height and vertical chrome are cached per reset key (the
 * composer variant), so switching surfaces re-measures once.
 */
export function useComposerAutosize(
  ref: RefObject<HTMLElement | null>,
  value: string,
  resetKey: string,
): void {
  const metricsRef = useRef<{ lineHeight: number; verticalChrome: number } | null>(null);
  const appliedHeightRef = useRef<number | null>(null);
  const appliedOverflowRef = useRef<string | null>(null);
  useEffect(() => {
    metricsRef.current = null;
    appliedHeightRef.current = null;
    appliedOverflowRef.current = null;
  }, [resetKey]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let metrics = metricsRef.current;
    if (!metrics) {
      const style = window.getComputedStyle(el);
      metrics = {
        lineHeight: cssPixels(style.lineHeight) || COMPOSER_MIN_HEIGHT_PX,
        verticalChrome:
          cssPixels(style.paddingTop) +
          cssPixels(style.paddingBottom) +
          cssPixels(style.borderTopWidth) +
          cssPixels(style.borderBottomWidth),
      };
      metricsRef.current = metrics;
    }
    const maxHeight = Math.ceil(
      metrics.lineHeight * COMPOSER_MAX_VISIBLE_ROWS + metrics.verticalChrome,
    );
    const applied =
      appliedHeightRef.current !== null &&
      el.style.height === `${appliedHeightRef.current}px`
        ? appliedHeightRef.current
        : null;
    let content = applied === null ? -1 : el.scrollHeight;
    if (
      applied === null ||
      (content <= el.clientHeight && applied > COMPOSER_MIN_HEIGHT_PX)
    ) {
      el.style.height = "auto";
      content = el.scrollHeight;
    }
    const next = Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(content, maxHeight));
    const overflowY = content > maxHeight ? "auto" : "hidden";
    if (appliedHeightRef.current !== next || el.style.height !== `${next}px`) {
      el.style.height = `${next}px`;
      appliedHeightRef.current = next;
    }
    if (appliedOverflowRef.current !== overflowY) {
      el.style.overflowY = overflowY;
      appliedOverflowRef.current = overflowY;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the editor ref is stable
  }, [value]);
}
