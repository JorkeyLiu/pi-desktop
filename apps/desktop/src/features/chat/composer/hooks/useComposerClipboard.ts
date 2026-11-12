import type { ClipboardEvent } from "react";
import {
  COMPOSER_CLIPBOARD_MIME,
  composerClipboardSlice,
  type ComposerClipboardSlice,
} from "../clipboard";
import { editorSelectionRange, readEditorValue } from "../editor";
import type { ComposerDraftController } from "./useComposerDraft";

type UseComposerClipboardOptions = {
  draft: Pick<ComposerDraftController, "ref" | "fileReferencesRef">;
  activeSessionId: string | null | undefined;
};

export type ComposerClipboardController = {
  onCopy: (event: ClipboardEvent<HTMLDivElement>) => void;
  onCut: (event: ClipboardEvent<HTMLDivElement>) => void;
};

/**
 * Copy and cut for a draft selection that holds attachment chips.
 *
 * An atomic chip has no clipboard representation of its own, so the browser's
 * default would either drop the attachment or leak a renderer sentinel. This
 * hook describes only selections that actually cover a chip: `text/plain` gets
 * the readable `@path` the send path produces, and a versioned application
 * payload carries the ordered parts for a paste inside this application. A
 * selection without a chip keeps the browser's native copy and cut untouched.
 *
 * A cut deletes through the browser's own editing command after the clipboard
 * write succeeded, so the deletion stays on the native undo stack; the draft
 * hook restores the removed chip metadata when undo brings the chip DOM back.
 */
export function useComposerClipboard({
  draft,
  activeSessionId,
}: UseComposerClipboardOptions): ComposerClipboardController {
  const publishSelection = (
    event: ClipboardEvent<HTMLDivElement>,
    cut: boolean,
  ): void => {
    const editor = draft.ref.current;
    const data = event.clipboardData;
    if (!editor || !data) return;
    const selection = editorSelectionRange(editor);
    if (selection.start === selection.end) return;
    const sessionId = activeSessionId ?? "";
    const references = draft.fileReferencesRef.current.filter(
      (reference) => reference.sessionId === sessionId,
    );
    const slice: ComposerClipboardSlice = composerClipboardSlice(
      readEditorValue(editor),
      references,
      selection,
      sessionId,
    );
    // Text and readable text agree only when no chip is inside the selection,
    // so a plain selection keeps the browser's own copy and cut.
    if (slice.text === slice.plainText) return;
    // A failed clipboard write must leave the draft untouched, so a cut never
    // deletes content the clipboard did not receive.
    try {
      data.setData("text/plain", slice.plainText);
      if (slice.payload) {
        data.setData(COMPOSER_CLIPBOARD_MIME, JSON.stringify(slice.payload));
      }
    } catch {
      return;
    }
    event.preventDefault();
    if (!cut) return;
    // `delete` is the native editing command, not a draft-state replacement:
    // undo and redo keep working on the text and on the restored chips.
    document.execCommand("delete");
  };
  return {
    onCopy: (event) => publishSelection(event, false),
    onCut: (event) => publishSelection(event, true),
  };
}
