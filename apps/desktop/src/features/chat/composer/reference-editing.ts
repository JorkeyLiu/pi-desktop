import {
  editorSelectionRange,
  insertTextOutsideReference,
  normalizeEditorSelection,
  readEditorValue,
  setEditorCaret,
  setEditorSelection,
} from "./editor";
import {
  referenceDeletionSpan,
  skipReferenceCaret,
} from "./reference-selection";
import { referenceElementFor } from "./reference-tokens";

/** A pointer that travels further than this is a selection drag, not a click. */
const CLICK_SLOP_PX = 4;

type PointerPress = {
  readonly token: string;
  readonly action: string;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
};

/**
 * Editing behavior for inline draft references.
 *
 * A reference paints as real text (`@name`), so the browser can put a caret
 * inside its label and can select part of it. This installer owns the rules
 * that keep a reference one atomic draft character: the caret only sits before
 * or after the token, a selection that touches it covers it whole, crossing it
 * with an arrow moves by the token, Backspace/Delete remove the token instead
 * of one label character, and a click — never a selection drag — runs the
 * reference's existing action.
 */
export function installComposerReferenceEditing(
  editor: HTMLElement,
  onActivate: (token: string, action: string) => void,
): () => void {
  // The press in progress, and the one its click event consumes. The browser
  // fires `click` on the nearest common ancestor of press and release, so a
  // drag that leaves the token never targets it; a drag inside it does, which
  // is why the travelled distance is recorded here.
  let press: PointerPress | null = null;
  let finishedPress: PointerPress | null = null;

  /** The selection, when it actually belongs to this editor. */
  const selectionOf = (): Selection | null => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      return null;
    }
    return selection;
  };

  const onSelectionChange = () => {
    const selection = selectionOf();
    if (!selection) return;
    // During a press the browser owns both edges: a collapsed caret may sit in a
    // label until the press turns into a click or a drag, and rewriting the
    // selection mid-drag would end Chromium's own selection extension. The
    // release below normalizes the finished selection instead.
    if (press) return;
    normalizeEditorSelection(editor);
  };

  const onBeforeInput = (event: Event) => {
    if (!(event instanceof InputEvent)) return;
    if (event.isComposing) return;
    // The selection is repaired before the browser applies the edit, so an
    // insertion can never land inside a label.
    if (!event.inputType.startsWith("insert") && !event.inputType.startsWith("delete")) return;
    const selection = selectionOf();
    if (!selection) return;
    normalizeEditorSelection(editor);
    // A caret that Blink would place inside a label is repaired here: the edit
    // is taken over so the text lands after the token instead of in its label.
    if (
      event.inputType.startsWith("insert") &&
      event.data &&
      insertTextOutsideReference(editor, event.data)
    ) {
      event.preventDefault();
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: event.inputType,
          data: event.data,
        }),
      );
    }
  };

  const deleteAcrossReference = (event: KeyboardEvent, direction: -1 | 1): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    const selection = selectionOf();
    if (!selection || !selection.isCollapsed) return false;
    const value = readEditorValue(editor);
    const span = referenceDeletionSpan(value, editorSelectionRange(editor).start, direction);
    if (!span) return false;
    event.preventDefault();
    setEditorSelection(editor, span.start, span.end);
    // The native editing command keeps the deletion on the undo stack, so undo
    // restores the token and the reference metadata the draft reconciles back.
    document.execCommand("delete");
    return true;
  };

  const moveAcrossReference = (event: KeyboardEvent, direction: -1 | 1): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    const selection = selectionOf();
    if (!selection) return false;
    const range = selection.getRangeAt(0);
    const value = readEditorValue(editor);
    const { start, end } = editorSelectionRange(editor);
    if (range.collapsed && !event.shiftKey) {
      const target = skipReferenceCaret(value, start, direction);
      if (target === null) return false;
      event.preventDefault();
      setEditorCaret(editor, target);
      return true;
    }
    if (!event.shiftKey) return false;
    // Shift+Arrow would otherwise stop inside a label or stall on a boundary
    // that the browser considers equivalent; the token is one character.
    const anchorIsStart =
      range.startContainer === selection.anchorNode && range.startOffset === selection.anchorOffset;
    const anchor = anchorIsStart ? start : end;
    const focus = anchorIsStart ? end : start;
    const target = skipReferenceCaret(value, focus, direction);
    if (target === null) return false;
    event.preventDefault();
    setEditorSelection(editor, anchor, target);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowLeft") {
      moveAcrossReference(event, -1);
      return;
    }
    if (event.key === "ArrowRight") {
      moveAcrossReference(event, 1);
      return;
    }
    if (event.key === "Backspace") {
      deleteAcrossReference(event, -1);
      return;
    }
    if (event.key === "Delete") {
      deleteAcrossReference(event, 1);
    }
  };

  const endPress = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!press || press.moved) return;
    if (
      Math.abs(event.clientX - press.startX) <= CLICK_SLOP_PX &&
      Math.abs(event.clientY - press.startY) <= CLICK_SLOP_PX
    ) {
      return;
    }
    press.moved = true;
  };

  const onPointerUp = () => {
    finishedPress = press;
    press = null;
    endPress();
    // A release ends the browser's own edge movement: repair the selection now
    // so the click that follows sees a collapsed or whole-token selection.
    normalizeEditorSelection(editor);
  };

  const onPointerCancel = () => {
    press = null;
    finishedPress = null;
    endPress();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    finishedPress = null;
    const element = referenceElementFor(event.target as Node | null);
    const action = element?.dataset.action ?? "";
    const token = element?.dataset.token ?? "";
    if (!element || !action || !token) return;
    press = {
      token,
      action,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  const onClick = (event: MouseEvent) => {
    const element = referenceElementFor(event.target as Node | null);
    const action = element?.dataset.action ?? "";
    const token = element?.dataset.token ?? "";
    if (!element || !action || !token) return;
    const presses = finishedPress;
    finishedPress = null;
    // A press that travelled selected text: the drag owns this gesture and must
    // never open a preview, expand a file, or switch conversations.
    if (presses?.moved || (presses && presses.token !== token)) return;
    const selection = selectionOf();
    if (!selection || !selection.isCollapsed) return;
    normalizeEditorSelection(editor);
    onActivate(token, action);
  };

  document.addEventListener("selectionchange", onSelectionChange);
  editor.addEventListener("beforeinput", onBeforeInput, true);
  editor.addEventListener("keydown", onKeyDown);
  editor.addEventListener("pointerdown", onPointerDown);
  editor.addEventListener("click", onClick);
  return () => {
    if (press) endPress();
    press = null;
    finishedPress = null;
    document.removeEventListener("selectionchange", onSelectionChange);
    editor.removeEventListener("beforeinput", onBeforeInput, true);
    editor.removeEventListener("keydown", onKeyDown);
    editor.removeEventListener("pointerdown", onPointerDown);
    editor.removeEventListener("click", onClick);
  };
}
