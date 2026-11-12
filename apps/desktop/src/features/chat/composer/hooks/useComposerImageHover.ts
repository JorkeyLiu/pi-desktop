import { useEffect, useState, type RefObject } from "react";
import { IMAGE_REFERENCE_SELECTOR } from "../reference-tokens";

export type ComposerImageHoverTarget = {
  id: string;
  /** Viewport rect of the hovered reference, used to place the preview card. */
  anchor: { left: number; top: number; bottom: number; width: number };
};

/** Pointer dwell before an image reference reveals its preview. */
const HOVER_DELAY_MS = 180;

/**
 * Track the image reference under the pointer inside the composer editor.
 * References are painted imperatively, so the editor delegates pointer movement
 * here instead of every token owning preview state.
 */
export function useComposerImageHover(
  editorRef: RefObject<HTMLDivElement | null>,
  idForToken: (token: string) => string | null,
): ComposerImageHoverTarget | null {
  const [target, setTarget] = useState<ComposerImageHoverTarget | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let timer: number | null = null;
    let pending: string | null = null;
    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      pending = null;
    };
    const hide = () => {
      cancel();
      setTarget(null);
    };
    const referenceOf = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element ? node.closest<HTMLElement>(IMAGE_REFERENCE_SELECTOR) : null;
    const reveal = (reference: HTMLElement, id: string) => {
      const rect = reference.getBoundingClientRect();
      setTarget({
        id,
        anchor: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width },
      });
    };
    const onPointerOver = (event: PointerEvent) => {
      const reference = referenceOf(event.target);
      const id = reference ? idForToken(reference.dataset.token ?? "") : null;
      if (!reference || !id) {
        hide();
        return;
      }
      if (pending === id) return;
      cancel();
      pending = id;
      timer = window.setTimeout(() => {
        timer = null;
        if (pending === id) reveal(reference, id);
      }, HOVER_DELAY_MS);
    };
    const onPointerOut = (event: PointerEvent) => {
      const reference = referenceOf(event.target);
      if (!reference || referenceOf(event.relatedTarget) === reference) return;
      hide();
    };
    editor.addEventListener("pointerover", onPointerOver);
    editor.addEventListener("pointerout", onPointerOut);
    // A reference that moves under the pointer (typing, wrapping, scrolling)
    // must never leave a stale card behind.
    editor.addEventListener("input", hide);
    editor.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      cancel();
      editor.removeEventListener("pointerover", onPointerOver);
      editor.removeEventListener("pointerout", onPointerOut);
      editor.removeEventListener("input", hide);
      editor.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [editorRef, idForToken]);

  return target;
}
