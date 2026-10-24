import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  insertNewlineAtCaret,
  paintEditorText,
  readEditorValue,
} from "../editor";

/**
 * Draft of a chip-less contenteditable composer.
 *
 * The browser owns typing: the editor DOM is written by the user and only
 * mirrored into state, so a keystroke never repaints the editor or moves the
 * caret mid-word. The hook repaints only when the draft changes from outside
 * the editor (an accepted send clearing it, or a tab switch). Attachments,
 * persistence, history, and submission stay with the surface that owns them.
 */
export type ComposerTextDraft = {
  ref: RefObject<HTMLDivElement | null>;
  /** Last draft value seen from the editor; drives the send-enablement UI. */
  value: string;
  /** Replace the draft from outside the editor; the editor repaints. */
  setValue: (next: string) => void;
  /** Native editor input: mirror the DOM into state without repainting it. */
  handleInput: (source: string) => void;
  /** Commit the DOM after a change that fired no input event (paste, IME end). */
  syncFromEditor: () => void;
  /** Insert one draft-model newline at the caret. */
  insertNewline: () => void;
  /** Live DOM value, the truthful draft during an in-flight render. */
  readValue: () => string;
};

export function useComposerTextDraft(): ComposerTextDraft {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValueState] = useState("");
  const valueRef = useRef(value);
  // `null` forces the first paint: React renders no children into the editor.
  const paintedRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || paintedRef.current === value) return;
    paintEditorText(element, value);
    paintedRef.current = value;
  }, [value]);

  // A value written by the editor itself is already in the DOM; a value written
  // from outside (an accepted send, a tab switch) still has to be painted, so
  // only the editor-authored path records the DOM as current.
  const commitFromEditor = (next: string) => {
    paintedRef.current = next;
    valueRef.current = next;
    setValueState(next);
  };

  return {
    ref,
    value,
    setValue: (next: string) => {
      valueRef.current = next;
      setValueState(next);
    },
    handleInput: commitFromEditor,
    syncFromEditor: () => {
      const element = ref.current;
      if (!element) return;
      commitFromEditor(readEditorValue(element));
    },
    insertNewline: () => {
      const element = ref.current;
      if (element && insertNewlineAtCaret(element)) commitFromEditor(readEditorValue(element));
    },
    readValue: () =>
      ref.current ? readEditorValue(ref.current) : valueRef.current,
  };
}
