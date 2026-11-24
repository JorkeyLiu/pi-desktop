import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  formatPromptPathText,
  formatSessionLink,
  normalizeLargePasteThreshold,
  parseSessionLinks,
  sessionLinkSpans,
  type MessageAttachment,
  type UiMessage,
} from "@pi-desktop/shared";
import { ComposerInput } from "../composer/ComposerInput";
import { ComposerImageHover } from "../composer/ComposerImageHoverPreview";
import { ComposerImagePreview } from "../composer/ComposerImagePreview";
import {
  allocateChipTokens,
  COMPOSER_CLIPBOARD_MIME,
  parseComposerClipboard,
  placeComposerPaste,
  planComposerPaste,
} from "../composer/clipboard";
import {
  editSeedContent,
  hydrateUserMessageEdit,
  serializeUserMessageEdit,
  tagStagedEditReferences,
  type EditDraftReference,
} from "../composer/edit-draft";
import {
  classifyClipboardIntake,
  clipboardFilePayload,
  insertStagedReferences,
  largeTextPayload,
} from "../composer/attachment-intake";
import {
  clipboardFiles,
  createFileReference,
  editorSelectionRange,
  formatDroppedDirectoryPath,
  insertClipboardText,
  insertNewlineAtCaret,
  isEditableTextReference,
  normalizeClipboardLineEndings,
  paintEditorValue,
  readEditorValue,
  setEditorCaret,
} from "../composer/editor";
import { isImageReference } from "../composer/image-attachments";
import { REFERENCE_SELECTOR } from "../composer/reference-tokens";
import { useComposerClipboard } from "../composer/hooks/useComposerClipboard";
import { useComposerImagePreview } from "../composer/hooks/useComposerImagePreview";
import {
  composerDropItems,
  hasComposerFileDrag,
} from "../../../lib/composer-drop";
import { sessionAllows } from "../../../lib/remote-session-safety";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { Button, TooltipButton } from "../../../components/ui";
import { IconPlus } from "../../../components/icons";

type UserMessageEditorProps = {
  /** The canonical full message hydrate loaded; never clipped display text. */
  message: UiMessage;
  sessionId: string;
  attachmentsAllowed: boolean;
  /** A retry is in flight; the editor is read-only until it settles. */
  busy: boolean;
  onCancel: () => void;
  onSubmit: (content: string, attachments: MessageAttachment[]) => void;
};

/**
 * Inline chip editor for an existing user message.
 *
 * This is the main composer's input surface — atomic `@name` chips, image
 * hover and modal preview, shared clipboard/drop/picker intake — bound to a
 * local edit lifecycle instead of the composer's session draft store. Nothing
 * here reads or writes the main composer draft or session state: cancel drops
 * the local state, and submit serializes back through the existing
 * edit/truncation interface.
 */
export function UserMessageEditor({
  message,
  sessionId,
  attachmentsAllowed,
  busy,
  onCancel,
  onSubmit,
}: UserMessageEditorProps) {
  const { t } = useTranslation();
  const ownerSessionId = sessionId;
  const [initial] = useState(() =>
    hydrateUserMessageEdit(
      editSeedContent(message.command, message.content || ""),
      message.attachments,
      ownerSessionId,
    ),
  );
  const [text, setTextState] = useState(initial.text);
  const [references, setReferencesState] = useState<EditDraftReference[]>(
    initial.references,
  );
  const [, setComposing] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pickerInFlight, setPickerInFlight] = useState(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef(initial.text);
  const referencesRef = useRef<EditDraftReference[]>(initial.references);
  const carriedRef = useRef(initial.carried);
  const deletedRef = useRef(new Map<string, EditDraftReference>());
  const largePasteThreshold = normalizeLargePasteThreshold(
    useAppStore((s) => s.settings?.largePasteThreshold),
  );
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const setText = useCallback((next: string) => {
    textRef.current = next;
    setTextState(next);
  }, []);
  const setReferences = useCallback((next: EditDraftReference[]) => {
    referencesRef.current = next;
    setReferencesState(next);
  }, []);
  const imagePreview = useComposerImagePreview({
    references,
    value: text,
    sessionId: ownerSessionId,
    editorRef,
  });
  const clipboard = useComposerClipboard({
    draft: { ref: editorRef, fileReferencesRef: referencesRef },
    activeSessionId: ownerSessionId,
  });
  const toastError = useCallback((error: unknown) => {
    useAppStore
      .getState()
      .showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
  }, []);

  // A session switch discards the local draft: async staging resolves against
  // the owner session and can never leak into the newly shown conversation.
  useEffect(() => {
    const cancel = () => {
      if (useAppStore.getState().activeSessionId !== ownerSessionId) {
        onCancelRef.current();
      }
    };
    return useAppStore.subscribe((state, previous) => {
      if (state.activeSessionId !== previous.activeSessionId) cancel();
    });
  }, [ownerSessionId]);

  const paint = useCallback(
    (nextText: string, nextReferences: EditDraftReference[]) => {
      const editor = editorRef.current;
      if (!editor) return;
      const byToken = new Map<string, EditDraftReference>();
      for (const reference of nextReferences) {
        if (reference.token) byToken.set(reference.token, reference);
      }
      paintEditorValue(editor, nextText, byToken);
    },
    [],
  );

  const applyEdit = useCallback(
    (
      nextText: string,
      nextReferences: EditDraftReference[],
      caret: number,
      focus = true,
    ) => {
      setText(nextText);
      setReferences(nextReferences);
      paint(nextText, nextReferences);
      if (!focus) return;
      requestAnimationFrame(() => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus();
        try {
          setEditorCaret(editor, caret);
        } catch {
          // The caret follows on the next paint; typing is unaffected.
        }
      });
    },
    [paint, setReferences, setText],
  );

  const reconcileReferences = useCallback(
    (sourceText: string) => {
      const editor = editorRef.current;
      const current = referencesRef.current;
      const next = current.filter(
        (reference) => !reference.token || sourceText.includes(reference.token),
      );
      if (editor) {
        for (const element of editor.querySelectorAll<HTMLElement>(
          REFERENCE_SELECTOR,
        )) {
          const token = element.dataset.token ?? "";
          if (!token || !sourceText.includes(token)) continue;
          if (next.some((item) => item.token === token)) continue;
          const restored = deletedRef.current.get(token);
          if (!restored) continue;
          next.push(restored);
          deletedRef.current.delete(token);
        }
      }
      for (const reference of current) {
        if (
          reference.token &&
          !sourceText.includes(reference.token) &&
          !deletedRef.current.has(reference.token)
        ) {
          deletedRef.current.set(reference.token, reference);
        }
      }
      if (
        next.length !== current.length ||
        next.some((reference, index) => reference !== current[index])
      ) {
        setReferences(next);
      }
    },
    [setReferences],
  );

  const syncFromEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return { value: textRef.current, caret: textRef.current.length };
    const value = readEditorValue(editor);
    const { start } = editorSelectionRange(editor);
    setText(value);
    reconcileReferences(value);
    return { value, caret: start };
  }, [reconcileReferences, setText]);

  // First paint: React never renders children into the contenteditable.
  useLayoutEffect(() => {
    paint(textRef.current, referencesRef.current);
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    try {
      setEditorCaret(editor, textRef.current.length);
    } catch {
      // Focus without a placed caret still takes typing.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only seed
  }, []);

  const readSelection = () => {
    const editor = editorRef.current;
    const sourceValue = editor ? readEditorValue(editor) : textRef.current;
    const { start, end } = editor
      ? editorSelectionRange(editor)
      : { start: sourceValue.length, end: sourceValue.length };
    return { editor, sourceValue, start, end };
  };

  const toastCount = useCallback(
    (key: string, count: number) => {
      useAppStore.getState().showToast(t(key, { count }), { variant: "success" });
    },
    [t],
  );

  const stageFiles = useCallback(
    async (files: File[], origin: "paste" | "drop" | "pick") => {
      const { sourceValue, start, end } = readSelection();
      setPasting(true);
      try {
        const staged = await api.pasteFiles(
          ownerSessionId,
          await clipboardFilePayload(files),
        );
        if (useAppStore.getState().activeSessionId !== ownerSessionId) return;
        if (!staged.files.length) return;
        const placed = insertStagedReferences({
          text: sourceValue,
          references: referencesRef.current,
          start,
          end,
          staged: staged.files,
          sessionId: ownerSessionId,
        });
        const nextReferences = placed.references as EditDraftReference[];
        tagStagedEditReferences(nextReferences, staged.files.length);
        applyEdit(placed.text, nextReferences, placed.caret);
        toastCount(
          origin === "paste" ? "chat.filesPasted" : "chat.filesAttached",
          staged.files.length,
        );
      } catch (error) {
        toastError(error);
      } finally {
        setPasting(false);
      }
    },
    [applyEdit, ownerSessionId, toastCount, toastError],
  );

  const stageLargeText = useCallback(
    async (pastedText: string) => {
      const { sourceValue, start, end } = readSelection();
      setPasting(true);
      try {
        const staged = await api.pasteFiles(
          ownerSessionId,
          largeTextPayload(pastedText),
        );
        if (useAppStore.getState().activeSessionId !== ownerSessionId) return;
        if (!staged.files.length) return;
        const placed = insertStagedReferences({
          text: sourceValue,
          references: referencesRef.current,
          start,
          end,
          staged: staged.files,
          sessionId: ownerSessionId,
        });
        const nextReferences = placed.references as EditDraftReference[];
        tagStagedEditReferences(nextReferences, staged.files.length);
        applyEdit(placed.text, nextReferences, placed.caret);
        useAppStore.getState().showToast(
          t("chat.largeTextPasted", {
            name: staged.files[0]?.name ?? "pasted-text",
          }),
          { variant: "success" },
        );
      } catch (error) {
        toastError(error);
      } finally {
        setPasting(false);
      }
    },
    [applyEdit, ownerSessionId, t, toastError],
  );

  const insertSessionChips = useCallback(
    (pastedText: string, selection: { sourceValue: string; start: number; end: number }) => {
      const { sourceValue, start, end } = selection;
      const owner = ownerSessionId;
      const previousReferences = referencesRef.current;
      const tokens = allocateChipTokens(
        sessionLinkSpans(pastedText).length,
        sourceValue,
        previousReferences,
      );
      let pasted = pastedText;
      const sessionReferences: EditDraftReference[] = [];
      const titleOf = (id: string) =>
        (
          useAppStore.getState().sessions.find((session) => session.id === id)
            ?.title ?? ""
        ).trim();
      let tokenIndex = 0;
      for (const span of [...sessionLinkSpans(pastedText)].reverse()) {
        const token = tokens[tokenIndex];
        tokenIndex += 1;
        if (!token) throw new Error("message edit ran out of chip tokens");
        pasted = pasted.slice(0, span.start) + token + pasted.slice(span.end);
        const name = `${t("chat.sessionReference")} · ${titleOf(span.id) || span.id.slice(0, 8)}`;
        sessionReferences.unshift({
          ...createFileReference(span.id, name, owner, {
            kind: "session",
            token,
          }),
          marker: formatSessionLink(span.id),
          placed: false,
          staged: true,
        });
      }
      if (!sessionReferences.length) return;
      const nextText =
        sourceValue.slice(0, start) + pasted + sourceValue.slice(end);
      applyEdit(
        nextText,
        [...previousReferences, ...sessionReferences],
        start + pasted.length,
      );
    },
    [applyEdit, ownerSessionId, t],
  );

  const insertInternalPaste = useCallback(
    (
      plan: ReturnType<typeof planComposerPaste>,
      selection: { sourceValue: string; start: number; end: number },
    ) => {
      const { sourceValue, start, end } = selection;
      const tokens = allocateChipTokens(
        plan.referenceCount,
        sourceValue,
        referencesRef.current,
      );
      const placed = placeComposerPaste(plan, tokens, ownerSessionId);
      const nextText =
        sourceValue.slice(0, start) + placed.inserted + sourceValue.slice(end);
      const retained = referencesRef.current.filter(
        (reference) => !reference.token || nextText.includes(reference.token),
      );
      const staged = placed.references.map((reference) => ({
        ...reference,
        marker:
          reference.kind === "session"
            ? formatSessionLink(reference.path)
            : formatPromptPathText(reference.path),
        placed: false,
        staged: true as const,
      }));
      applyEdit(
        nextText,
        [...retained, ...staged],
        start + placed.inserted.length,
      );
    },
    [applyEdit, ownerSessionId],
  );

  const insertPlainText = useCallback(
    (insert: string) => {
      const editor = editorRef.current;
      if (editor && insertClipboardText(editor, insert)) {
        syncFromEditor();
        return;
      }
      if (!editor) {
        const next = textRef.current + insert;
        setText(next);
        reconcileReferences(next);
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(
        document.createTextNode(normalizeClipboardLineEndings(insert)),
      );
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      syncFromEditor();
    },
    [reconcileReferences, setText, syncFromEditor],
  );

  // NOTE: this handler must stay reachable through React's root listener:
  // stopping paste propagation in a capture handler above the editable would
  // swallow the editor's own paste (no document-level paste listener exists
  // that needs shielding from it).
  const onPaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      const editor = editorRef.current;
      if (!editor) return;
      if (!attachmentsAllowed) {
        event.preventDefault();
        const pastedText = event.clipboardData.getData("text/plain");
        if (!pastedText) return;
        const { sourceValue, start, end } = readSelection();
        const next =
          sourceValue.slice(0, start) + pastedText + sourceValue.slice(end);
        const retained = referencesRef.current.filter(
          (reference) => !reference.token || next.includes(reference.token),
        );
        applyEdit(next, retained, start + pastedText.length);
        return;
      }
      const composerPayload = parseComposerClipboard(
        event.clipboardData.getData(COMPOSER_CLIPBOARD_MIME),
      );
      if (composerPayload.ok) {
        const plan = planComposerPaste(composerPayload.payload, ownerSessionId);
        if (plan.referenceCount > 0) {
          event.preventDefault();
          insertInternalPaste(plan, readSelection());
          return;
        }
      }
      const pastedText = event.clipboardData.getData("text/plain");
      const pastedFiles = clipboardFiles(event.clipboardData);
      const intake = classifyClipboardIntake({
        text: pastedText,
        files: pastedFiles,
        largePasteThreshold,
        resolveNativePath: api.getDroppedFilePath,
      });
      if (intake === "files") {
        event.preventDefault();
        void stageFiles(pastedFiles, "paste");
        return;
      }
      if (intake === "large-text") {
        event.preventDefault();
        void stageLargeText(pastedText);
        return;
      }
      const sessionIds = parseSessionLinks(pastedText);
      if (sessionIds.length) {
        event.preventDefault();
        void api.recordClipboardPaste(pastedText).catch(() => undefined);
        insertSessionChips(pastedText, readSelection());
        return;
      }
      // Small text paste stays plain so rich HTML never enters the draft.
      event.preventDefault();
      if (!pastedText) return;
      void api.recordClipboardPaste(pastedText).catch(() => undefined);
      insertPlainText(pastedText);
    },
    [
      applyEdit,
      attachmentsAllowed,
      insertInternalPaste,
      insertPlainText,
      insertSessionChips,
      largePasteThreshold,
      ownerSessionId,
      stageFiles,
      stageLargeText,
    ],
  );

  const pickAndAttach = useCallback(async () => {
    if (pickerInFlight || pasting || busy || !attachmentsAllowed) return;
    setPickerInFlight(true);
    setPasting(true);
    try {
      const result = await api.pickFiles();
      if (result.canceled || !result.token) return;
      const { sourceValue, start, end } = readSelection();
      const imported = await api.importFiles(ownerSessionId, result.token);
      if (useAppStore.getState().activeSessionId !== ownerSessionId) return;
      if (!imported.files.length) return;
      const placed = insertStagedReferences({
        text: sourceValue,
        references: referencesRef.current,
        start,
        end,
        staged: imported.files,
        sessionId: ownerSessionId,
      });
      const nextReferences = placed.references as EditDraftReference[];
      tagStagedEditReferences(nextReferences, imported.files.length);
      applyEdit(placed.text, nextReferences, placed.caret);
      toastCount("chat.filesAttached", imported.files.length);
    } catch (error) {
      toastError(error);
    } finally {
      setPickerInFlight(false);
      setPasting(false);
    }
  }, [
    applyEdit,
    attachmentsAllowed,
    busy,
    ownerSessionId,
    pasting,
    pickerInFlight,
    toastCount,
    toastError,
  ]);

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLFormElement>) => {
      if (!hasComposerFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (!attachmentsAllowed || pasting || busy) return;
      const items = composerDropItems(
        event.dataTransfer,
        api.getDroppedFilePath,
      );
      const files = items.filter((item) => !item.isDirectory).map((item) => item.file);
      const directories = items.filter((item) => item.isDirectory);
      if (directories.length) {
        insertPlainText(
          directories
            .map((item) => (item.path ? formatDroppedDirectoryPath(item.path) : ""))
            .filter(Boolean)
            .join(" "),
        );
      }
      if (files.length) void stageFiles(files, "drop");
    },
    [attachmentsAllowed, busy, insertPlainText, pasting, stageFiles],
  );

  const expandTextReference = useCallback(
    async (token: string) => {
      const reference = referencesRef.current.find(
        (candidate) => candidate.token === token,
      );
      const editor = editorRef.current;
      if (!reference || !isEditableTextReference(reference) || !editor) return;
      if (!readEditorValue(editor).includes(token)) return;
      try {
        const state = useAppStore.getState();
        if (
          !sessionAllows(
            state.sessions.find((session) => session.id === ownerSessionId),
            "canAttach",
          )
        ) {
          return;
        }
        const result = await api.fsRead(
          reference.path,
          reference.mimeType,
          ownerSessionId,
        );
        if (result.kind !== "text" || result.content === undefined) {
          const failed =
            result.kind === "tooLarge"
              ? t("panel.files.tooLarge")
              : result.kind === "binary"
                ? t("panel.files.binary")
                : t("panel.files.error");
          useAppStore.getState().showToast(failed, { variant: "error" });
          return;
        }
        const liveEditor = editorRef.current;
        const liveReference = referencesRef.current.find(
          (candidate) => candidate.token === token,
        );
        if (
          !liveEditor ||
          useAppStore.getState().activeSessionId !== ownerSessionId ||
          !liveReference ||
          liveReference.sessionId !== ownerSessionId ||
          liveReference.path !== reference.path
        ) {
          return;
        }
        const source = readEditorValue(liveEditor);
        const index = source.indexOf(token);
        if (index === -1) return;
        const nextText =
          source.slice(0, index) + result.content + source.slice(index + token.length);
        const nextReferences = referencesRef.current.filter(
          (candidate) => candidate.token !== token,
        );
        deletedRef.current.delete(token);
        applyEdit(nextText, nextReferences, index + result.content.length);
      } catch (error) {
        toastError(error);
      }
    },
    [applyEdit, ownerSessionId, t, toastError],
  );

  const onActivateReference = useCallback(
    (token: string) => {
      const reference = referencesRef.current.find(
        (candidate) => candidate.token === token,
      );
      if (!reference) return;
      if (reference.kind === "session") {
        void useAppStore
          .getState()
          .selectSession(reference.path)
          .catch(() => undefined);
        return;
      }
      if (isImageReference(reference)) {
        imagePreview.open(reference);
        return;
      }
      if (isEditableTextReference(reference)) void expandTextReference(token);
    },
    [expandTextReference, imagePreview],
  );

  const survivors = useMemo(() => {
    const live = text;
    const kept = references.filter(
      (reference) => reference.token && live.includes(reference.token),
    );
    return { kept, count: kept.length + carriedRef.current.length };
  }, [references, text]);
  const canSubmit =
    !pasting && !busy && (text.trim().length > 0 || survivors.count > 0);

  const submit = useCallback(() => {
    if (pasting || busy) return;
    const editor = editorRef.current;
    const live = editor ? readEditorValue(editor) : textRef.current;
    const { content, attachments } = serializeUserMessageEdit(
      live,
      referencesRef.current,
      carriedRef.current,
    );
    if (!content.trim() && !attachments.length) return;
    onSubmit(content, attachments);
  }, [busy, onSubmit, pasting]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <form
      className="message-edit"
      aria-busy={busy || pasting || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragOver={(event) => {
        if (hasComposerFileDrag(event.dataTransfer)) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="message-edit-input-host" onKeyDown={onKeyDown}>
        <ComposerInput
          imagePreview={imagePreview}
          inputRef={editorRef}
          value={text}
          placeholderText=""
          placeholderKey="message-edit"
          inputBlocked={busy}
          pasting={pasting}
          enterToSend={false}
          runActive={false}
          onCopy={clipboard.onCopy}
          onCut={clipboard.onCut}
          onPaste={onPaste}
          onSubmit={() => submit()}
          onInsertNewline={() => {
            const editor = editorRef.current;
            if (editor && insertNewlineAtCaret(editor)) syncFromEditor();
          }}
          onInput={(source) => {
            setText(source);
            reconcileReferences(source);
          }}
          onActivateReference={onActivateReference}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onSettledInput={() => setComposing(false)}
          onFocus={() => undefined}
          onBlur={() => undefined}
          ariaLabel={t("chat.editMessage")}
        />
        <ComposerImageHover controller={imagePreview} editorRef={editorRef} />
      </div>
      <ComposerImagePreview controller={imagePreview} />
      <div className="message-edit-actions">
        {attachmentsAllowed ? (
          <TooltipButton
            type="button"
            className="icon-btn"
            tooltip={t("chat.addFiles")}
            ariaLabel={t("chat.addFiles")}
            disabled={busy || pasting}
            onClick={() => void pickAndAttach()}
          >
            <IconPlus size={15} aria-hidden="true" />
          </TooltipButton>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="message-edit-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          {t("chat.cancelEdit")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          className="message-edit-submit"
          disabled={!canSubmit}
        >
          {busy ? t("chat.retryingEdit") : t("chat.retryEdit")}
        </Button>
      </div>
    </form>
  );
}
