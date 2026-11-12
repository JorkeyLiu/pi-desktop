import { formatSessionLink, serializeInlineComposerFileReferences, type MessageAttachment } from "@pi-desktop/shared";
import { useComposerInputHistory } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerInputHistory";
import type { AppState } from "../../apps/desktop/src/stores/app-state";
import { createQueueSlice } from "../../apps/desktop/src/stores/slices/queue-slice";
import type { SessionRuntime } from "../../apps/desktop/src/stores/runtime/session-runtime";
import { useComposerSubmit } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerSubmit";
import { verifyComposerSubmission } from "./composer-submission";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { isBlockingOverlayActive } from "../../apps/desktop/src/lib/blocking-overlay";
import type { TFunction } from "i18next";
import { en } from "@pi-desktop/i18n";
import {
  ComposerInput,
  type ComposerInputProps,
} from "../../apps/desktop/src/features/chat/composer/ComposerInput";
import { useComposerAttachments } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerAttachments";
import { useComposerClipboard } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerClipboard";
import {
  useComposerDraft,
  type ComposerDraftController,
} from "../../apps/desktop/src/features/chat/composer/hooks/useComposerDraft";
import {
  createFileReference,
  editorSelectionRange,
  readEditorValue,
  setEditorCaret,
  type ComposerFileReference,
} from "../../apps/desktop/src/features/chat/composer/editor";
import { COMPOSER_CLIPBOARD_MIME } from "../../apps/desktop/src/features/chat/composer/clipboard";
import { api } from "../../apps/desktop/src/lib/api";
import { FilesTab } from "../../apps/desktop/src/components/workpanel/FilesTab";
import { FileRefChip, MessageAttachmentImage } from "../../apps/desktop/src/features/chat/transcript/shared";
import { useOpenChatFileRef } from "../../apps/desktop/src/hooks/use-preview-target";
import {
  readComposerDraft,
  resetComposerDraftCache,
} from "../../apps/desktop/src/lib/composer-draft-cache";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var composerPreviewPointer: (input: { type: "mousePressed" | "mouseMoved" | "mouseReleased"; x: number; y: number }) => Promise<void>;
  var composerPreviewDrag: (input: { from: { x: number; y: number }; to: { x: number; y: number } }) => Promise<void>;
  var composerPreviewPressKey: (input: string | { key: string; modifiers?: string[]; text?: string }) => Promise<void>;
  var composerPreviewCapture: (() => Promise<void>) | undefined;
  var composerPasteProbe: () => Promise<unknown>;
  var composerReferenceTokenProbe: () => Promise<unknown>;
  var composerHistoryProbe: (phase: "prepare" | "verify") => Promise<unknown>;
}
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const sessions = [{ id: "paste-a" }, { id: "paste-b" }, { id: "history-created-session" }];
const noop = () => {};
let controller: ComposerDraftController;
let pastePending: Promise<unknown> | undefined;
let submitted = 0;
let rejectSubmission: () => Promise<void>;
let historySendPrompt: AppState["sendPrompt"] = async () => false;
let latestSubmission: Promise<void> = Promise.resolve();
function Fixture({ sessionId, t, workspacePath }: { sessionId: string; t: TFunction; workspacePath: string }) {
  const draft = useComposerDraft({
    variant: "docked",
    activeSessionId: sessionId || null,
    workspacePath,
    sessions,
    composerPrefill: null,
    clearComposerPrefill: noop,
    t,
    invalidateComposerTransforms: noop,
    inputBlocked: false,
  });
  controller = draft;
  const inputHistory = useComposerInputHistory({
    draftKey: draft.draftKey,
    referenceSessionId: sessionId,
    draft,
  });
  const submitController = useComposerSubmit({
    value: draft.value, draftKey: draft.draftKey, activeSessionId: sessionId || null,
    thinkingLevel: "off", modelReady: true, sendBlocked: false, pasting: false,
    activeFileReferences: draft.activeFileReferences, t, draft,
    recordHistory: inputHistory.record,
    invalidateComposerTransforms: noop,
    sendPrompt: (...args) => historySendPrompt(...args),
    steerPrompt: async () => false, showToast: noop,
  });
  rejectSubmission = submitController.submit;
  const submitFromComposer = (steering?: boolean) => {
    inputHistory.exitBrowsing();
    submitted++;
    return submitController.submit(steering);
  };
  const attachments = useComposerAttachments({
    inputBlocked: false,
    activeSessionId: sessionId || null,
    draftKey: draft.draftKey,
    largePasteThreshold: 600,
    t,
    draft,
  });
  const composerClipboard = useComposerClipboard({
    draft: { ref: draft.ref, fileReferencesRef: draft.fileReferencesRef },
    activeSessionId: sessionId || null,
  });
  return (
    <div className="composer-stack">
      <div className="composer-shell">
      <ComposerInput
        imagePreview={draft.imagePreview}
        inputRef={draft.ref}
        value={draft.value}
        placeholderText=""
        placeholderKey="fixture"
        inputBlocked={attachments.pasting}
        pasting={attachments.pasting}
        enterToSend={true}
        runActive={false}
        composerAc={
          { open: false, close: noop } as ComposerInputProps["composerAc"]
        }
        onPaste={(event) => {
          pastePending = Promise.resolve(attachments.pasteClipboardFiles(event));
        }}
        onCopy={composerClipboard.onCopy}
        onCut={composerClipboard.onCut}
        onAcceptCompletion={noop}
        onSubmit={(steering) => { latestSubmission = submitFromComposer(steering); }}
        onHistoryNavigate={inputHistory.navigate}
        onInsertNewline={draft.insertNewlineInEditor}
        onInput={(source, caret) => { inputHistory.exitBrowsing(); draft.handleInput(source, caret); }}
        onActivateReference={(token) => {
          // Optional so the probe also compiles against a build without it.
          const activate = (draft as Partial<ComposerDraftController>).activateReference;
          activate?.(token);
        }}
        onCompositionStart={noop}
        onCompositionEnd={noop}
        onSettledInput={() => draft.setComposing(false)}
        onFocus={noop}
        onBlur={noop}
      />
      </div>
    </div>
  );
}

function Mp4AttachmentChips({ scratchPath }: { scratchPath: string }) {
  const openFile = useOpenChatFileRef();
  return (
    <div className="mp4-attachment-chips">
      {[
        { name: "a.mp4", path: `attachments/${"a".repeat(64)}` },
        { name: "b.mp4", path: `attachments/${"b".repeat(64)}` },
        { name: "scratch.mp4", path: scratchPath },
      ].map((video) => (
        <FileRefChip
          key={video.name}
          name={video.name}
          path={video.path}
          mimeType="video/mp4"
          onOpen={openFile}
        />
      ))}
    </div>
  );
}

globalThis.composerPasteProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, {
    onUncaughtError: (error) => errors.push(error),
  });
  let key = 0;
  const render = (sessionId = "paste-a", workspacePath = "") => {
    useAppStore.setState({ activeSessionId: sessionId });
    flushSync(() =>
      root.render(<I18nextProvider i18n={i18n}><Fixture key={key} sessionId={sessionId} t={i18n.t} workspacePath={workspacePath} /></I18nextProvider>),
    );
    assert(
      errors.length === 0,
      `React failed: ${errors.map(String).join("; ")}`,
    );
  };
  const reset = async (
    source = "prefix REPLACE suffix",
    start = 7,
    end = 14,
  ) => {
    key++;
    resetComposerDraftCache();
    useAppStore.setState({ workPanelOpen: false, workspace: null });
    render();
    const editor = controller.ref.current!;
    flushSync(() => controller.applyEditorDraft(source, [], start));
    await new Promise(requestAnimationFrame);
    editor.focus();
    const range = document.createRange();
    range.setStart(editor.firstChild!, start);
    range.setEnd(editor.firstChild!, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return editor;
  };
  const dispatchPaste = async (
    editor: HTMLDivElement,
    text: string,
    files: File[],
  ) => {
    const data = new DataTransfer();
    if (text) {
      data.setData("text/plain", text);
      data.setData("text/html", `<b>${text}</b>`);
    }
    for (const file of files) data.items.add(file);
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    flushSync(() => editor.dispatchEvent(event));
    await pastePending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(event.defaultPrevented, "paste was not handled");
    assert(
      errors.length === 0,
      `React failed: ${errors.map(String).join("; ")}`,
    );
    return editor;
  };
  const paste = async (text: string, files: File[], empty = false) =>
    dispatchPaste(await (empty ? reset("", 0, 0) : reset()), text, files);
  const select = (editor: HTMLElement, start: number, end: number) => {
    setEditorCaret(editor, start);
    const selection = window.getSelection()!;
    const range = selection.getRangeAt(0).cloneRange();
    setEditorCaret(editor, end);
    const last = selection.getRangeAt(0);
    range.setEnd(last.startContainer, last.startOffset);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  try {
    // Settings replaces ChatSurface, then remounts the composer in the same
    // workspace. Exercise the real draft hook and DOM across that lifecycle.
    render("paste-a", "/project-a");
    const referenceDraft = "Check \uE001 and \uE002";
    const references = [
      createFileReference("src/main.ts", "main.ts", "paste-a", { token: "\uE001" }),
      createFileReference("/scratch/paste-a/notes.txt", "notes.txt", "paste-a", { token: "\uE002" }),
    ];
    flushSync(() => controller.applyEditorDraft(referenceDraft, references, referenceDraft.length));
    await new Promise(requestAnimationFrame);
    flushSync(() => root.render(null));
    render("paste-a", "/project-a");
    await new Promise(requestAnimationFrame);
    assert(readEditorValue(controller.ref.current!) === referenceDraft,
      "Settings round-trip lost a workspace file reference from the draft");
    assert(controller.fileReferences.length === 2 && controller.ref.current!.textContent!.includes("main.ts"),
      "Settings round-trip must restore both workspace and scratch chips");
    flushSync(() => root.render(null));
    render("paste-a", "/project-b");
    await new Promise(requestAnimationFrame);
    assert(readEditorValue(controller.ref.current!) === "Check  and \uE002",
      "changing workspace while the composer is unmounted must remove the previous workspace's chip");
    assert(controller.fileReferences.length === 1 && controller.fileReferences[0].path === references[1].path,
      "changing workspace must preserve scratch references");

    // Keep the source attachment snapshot when a paste finishes in another session.
    await reset("keep \uE010 ", 7, 7);
    const originalReference = createFileReference("/scratch/paste-a/original.txt", "original.txt", "paste-a", { token: "\uE010", kind: "file" });
    flushSync(() => controller.applyEditorDraft("keep \uE010 ", [originalReference], 7));
    await new Promise(requestAnimationFrame);
    const originalPasteFiles = api.pasteFiles;
    let releasePaste!: () => void;
    const responseGate = new Promise<void>((resolve) => { releasePaste = resolve; });
    let started = false;
    api.pasteFiles = async () => {
      started = true;
      await responseGate;
      return { files: [{ path: "/scratch/paste-a/new.txt", name: "new.txt", kind: "file", mimeType: "text/plain" }] };
    };
    try {
      const pendingPaste = dispatchPaste(controller.ref.current!, "", [new File(["new"], "new.txt", {type: "text/plain"})]);
      while (!started) await new Promise(requestAnimationFrame);
      render("paste-b");
      await new Promise(requestAnimationFrame);
      releasePaste();
      await pendingPaste;
      assert(controller.value === "", "pending paste changed the destination draft");
      render("paste-a");
      const restoreDeadline = performance.now() + 3000;
      while (!controller.fileReferences.some((reference) => reference.name === "new.txt") &&
        performance.now() < restoreDeadline) {
        await new Promise(requestAnimationFrame);
      }
      const names = controller.fileReferences.map((r) => r.name);
      assert(names.includes("original.txt") && names.includes("new.txt"),
        "PENDING_PASTE_SESSION_SWITCH lost original attachment: " + JSON.stringify({ names, text: readEditorValue(controller.ref.current!), visible: controller.ref.current!.textContent }));
    } finally {
      releasePaste();
      api.pasteFiles = originalPasteFiles;
    }
    const nativeFiles = Array.from(
      (document.getElementById("native-files") as HTMLInputElement).files!,
    );
    assert(
      nativeFiles.length === 2 &&
        nativeFiles.every((file) => api.getDroppedFilePath(file)),
      "native File paths unavailable through real preload",
    );
    const image = new File([await nativeFiles[0].arrayBuffer()], "image.png", {
      type: "image/png",
    });
    assert(
      !api.getDroppedFilePath(image),
      "synthetic clipboard image unexpectedly has a native path",
    );
    const text = "Word paragraph 中文\nsecond line";
    let editor = await paste(text, [image]);
    assert(
      readEditorValue(editor) === `prefix ${text} suffix`,
      `Word text mismatch: ${JSON.stringify(readEditorValue(editor))}; white-space=${getComputedStyle(editor).whiteSpace}; contenteditable=${editor.contentEditable}; DOM=${editor.innerHTML}`,
    );
    assert(
      controller.fileReferences.length === 0,
      "Word text created an image reference",
    );
    assert(
      editorSelectionRange(editor).start === 7 + text.length,
      `text paste caret moved: ${editorSelectionRange(editor).start} expected ${7 + text.length}; DOM=${editor.innerHTML}`,
    );
    assert(!editor.querySelector("b"), "rich HTML entered the draft");

    const multilineCases = [
      "first\r\n\r\nlast\r\n",
      '<img src=x onerror="throw 1">\n<&> "quotes" \'single\'',
      "  leading \ntrailing  ",
      "line\n\n",
      // A Word selection can start above the copied text, so the pasted string
      // may begin with one or more line breaks.
      "\nsecond",
      "\n\nline",
      "\nA\nB\n",
    ];
    for (const content of multilineCases) {
      editor = await paste(content, [image]);
      const normalized = content.replace(/\r\n?/g, "\n");
      assert(
        readEditorValue(editor) === `prefix ${normalized} suffix`,
        `multiline text changed: ${JSON.stringify(readEditorValue(editor))}`,
      );
      assert(
        editorSelectionRange(editor).start === 7 + normalized.length,
        "multiline caret moved",
      );
      assert(
        !editor.querySelector("img,script,b"),
        "plain text interpreted as HTML",
      );
      assert(document.execCommand("undo"), "native undo unavailable");
      await new Promise(requestAnimationFrame);
      assert(
        readEditorValue(editor) === "prefix REPLACE suffix",
        "undo did not restore the replaced selection",
      );
      assert(document.execCommand("redo"), "native redo unavailable");
      await new Promise(requestAnimationFrame);
      assert(
        readEditorValue(editor) === `prefix ${normalized} suffix`,
        "redo lost multiline text",
      );
    }
    editor = await paste("line\n\n", [image], true);
    assert(
      readEditorValue(editor) === "line\n\n",
      `trailing newlines lost: ${JSON.stringify(readEditorValue(editor))}`,
    );
    assert(
      editorSelectionRange(editor).start === 6,
      "empty editor paste caret moved",
    );

    // Forced insertHTML failure: the raw-DOM fallback must still store the
    // editor's LF draft model instead of the clipboard's CRLF bytes.
    const realExecCommand = document.execCommand.bind(document);
    document.execCommand = ((
      commandId: string,
      ...rest: [boolean?, string?]
    ) =>
      commandId === "insertHTML"
        ? false
        : realExecCommand(commandId, ...rest)) as typeof document.execCommand;
    try {
      editor = await paste("fallback\r\ntext", [image], true);
      assert(
        readEditorValue(editor) === "fallback\ntext",
        `fallback kept clipboard line endings: ${JSON.stringify(readEditorValue(editor))}`,
      );
    } finally {
      document.execCommand = realExecCommand;
    }

    const beforeReplace = "one\nTWO\nthree";
    editor = await paste(beforeReplace, [image], true);
    assert(
      editor.querySelector("br"),
      "multiline fixture is missing a real BR",
    );
    select(editor, 2, 8);
    await dispatchPaste(editor, "A\nB", [image]);
    assert(
      readEditorValue(editor) === "onA\nBthree",
      "replacement across BR changed surrounding text",
    );
    assert(
      editorSelectionRange(editor).start === 5,
      "replacement across BR moved caret",
    );
    assert(document.execCommand("undo"), "cross-BR undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(
      readEditorValue(editor) === beforeReplace,
      "cross-BR undo changed text",
    );
    assert(document.execCommand("redo"), "cross-BR redo unavailable");
    await new Promise(requestAnimationFrame);
    assert(
      readEditorValue(editor) === "onA\nBthree",
      "cross-BR redo changed text",
    );

    const longText = "字".repeat(601);
    editor = await paste(longText, [image]);
    assert(
      controller.fileReferences.length === 1 &&
        controller.fileReferences[0].mimeType === "text/plain",
      "large mixed paste did not use the text threshold",
    );
    assert(
      readEditorValue(editor) ===
        `prefix ${controller.fileReferences[0].token} suffix`,
      "large text chip lost the selection boundary",
    );
    const longTextPath = controller.fileReferences[0].path;
    await paste("", [new File([new Uint8Array(512 * 1024 + 1)], "clip.mp4", {
      type: "video/mp4",
    })]);
    assert(controller.fileReferences.length === 1 &&
      controller.fileReferences[0].mimeType === "video/mp4" &&
      controller.fileReferences[0].path.endsWith(".mp4"),
    "a pasted MP4 did not retain its playable scratch filename");
    const scratchVideoPath = controller.fileReferences[0].path;

    // Preview the persisted long-text attachment through the public work-panel
    // entry point, with no project open (the temporary-task user path).
    const previewHost = document.createElement("div");
    document.body.append(previewHost);
    const previewRoot = createRoot(previewHost);
    const originalFsOpen = api.fsOpen;
    const openRequests: Array<ReturnType<typeof api.fsOpen>> = [];
    api.fsOpen = (path: string, mimeType?: string) => {
      const request = originalFsOpen(path, mimeType);
      openRequests.push(request);
      return request;
    };
    try {
      flushSync(() => previewRoot.render(
        <I18nextProvider i18n={i18n}><FilesTab /><Mp4AttachmentChips scratchPath={scratchVideoPath} /></I18nextProvider>,
      ));
      assert(previewHost.textContent?.includes(i18n.t("panel.files.noWorkspace")),
        "file browsing without a project should show the empty state");
      flushSync(() => useAppStore.getState().openFileInWorkPanel(
        longTextPath, "text/plain",
      ));
      const deadline = performance.now() + 3000;
      while (!previewHost.querySelector(".file-viewer-code") && performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
      }
      assert(previewHost.querySelector(".file-viewer-code")?.textContent === longText,
        "temporary-task attachment did not display its saved text in the file preview");
      for (const [index, [hash, expected]] of [
        ["a", i18n.t("panel.files.tooLarge")],
        ["b", i18n.t("panel.files.binary")],
        ["scratch", i18n.t("panel.files.tooLarge")],
      ].entries()) {
        const chip = previewHost.querySelector<HTMLButtonElement>(
          `.mp4-attachment-chips [aria-label^="${hash}.mp4"]`,
        );
        assert(chip, `MP4 attachment chip is missing: ${hash}`);
        flushSync(() => chip!.click());
        const deadline = performance.now() + 3000;
        while (!previewHost.textContent?.includes(expected) && performance.now() < deadline) {
          await new Promise(requestAnimationFrame);
        }
        assert(previewHost.textContent?.includes(expected),
          `MP4 attachment did not reach its expected preview state: ${hash}`);
        const open = Array.from(previewHost.querySelectorAll<HTMLButtonElement>("button"))
          .find((button) => button.textContent === i18n.t("chat.openFile"));
        assert(open, `MP4 attachment has no system-player action: ${hash}`);
        flushSync(() => open!.click());
        assert(openRequests.length === index + 1, `MP4 open did not reach IPC: ${hash}`);
        await openRequests[index];
      }
      flushSync(() => useAppStore.getState().openFileInWorkPanel("untrusted.sh", "video/mp4"));
      const unsafeDeadline = performance.now() + 3000;
      while ((previewHost.querySelector(".file-viewer-path")?.textContent !== "untrusted.sh" ||
        !previewHost.textContent?.includes(i18n.t("panel.files.tooLarge"))) &&
        performance.now() < unsafeDeadline) {
        await new Promise(requestAnimationFrame);
      }
      assert(!Array.from(previewHost.querySelectorAll<HTMLButtonElement>("button"))
        .some((button) => button.textContent === i18n.t("chat.openFile")),
      "a spoofed video MIME must not offer an OS-open action for a script");
      const back = previewHost.querySelector<HTMLButtonElement>(
        `[aria-label="${i18n.t("panel.files.back")}"]`,
      );
      assert(back, "file preview must provide back navigation");
      flushSync(() => back!.click());
      assert(previewHost.textContent?.includes(i18n.t("panel.files.noWorkspace")),
        "back from a temporary attachment should restore the no-project empty state");
    } finally {
      api.fsOpen = originalFsOpen;
      flushSync(() => previewRoot.unmount());
      previewHost.remove();
    }

    await paste("", [image]);
    assert(
      controller.fileReferences.length === 1 &&
        controller.fileReferences[0].kind === "image",
      "image-only paste changed",
    );
    await paste("native-image.png", [nativeFiles[0]]);
    assert(
      controller.fileReferences.length === 1 &&
        controller.fileReferences[0].kind === "image",
      "native image file was mistaken for text",
    );
    // Pasted images paint as inline reference tokens, exactly like a pasted file.
    const draftText = () => {
      let text = readEditorValue(controller.ref.current!);
      for (const reference of controller.fileReferences) {
        if (reference.token) text = text.split(reference.token).join("");
      }
      return text;
    };
    const imageChipByToken = (token: string) => controller.ref.current!
      .querySelector<HTMLElement>(`.composer-reference[data-image][data-token="${token}"]`);
    const chip = imageChipByToken(controller.fileReferences[0].token!)!;
    assert(chip, "pasted images must render as an inline reference token");
    assert(!document.querySelector(".composer-image-attachments"), "the detached attachment row must be gone");
    // The token is text: a readable `@name`, no capsule chrome and no icon.
    // Its label is selectable like any draft character, and it is a keyboard
    // reachable link so the action it runs is possible without a pointer.
    assert(chip.textContent === "@native-image.png", `image token label was ${chip.textContent}`);
    assert(chip.title === controller.fileReferences[0].path, "image token lost its full path title");
    assert(
      chip.getAttribute("role") === "link" && chip.tabIndex === 0,
      "an image token must be a keyboard reachable link",
    );
    assert(
      chip.getAttribute("aria-label") ===
        `${controller.fileReferences[0].name} — ${controller.fileReferences[0].path}`,
      `an image token must carry its file name and full path as an accessible name, got ${
        chip.getAttribute("aria-label")
      }`,
    );
    assert(!chip.querySelector("svg") && !chip.querySelector("button") && !chip.querySelector("img"),
      "an image token must not carry chip chrome");
    assert(getComputedStyle(chip).userSelect !== "none", "an image token must stay selectable text");
    assert(draftText() === "prefix  suffix", "image token changed the surrounding draft text");
    // #117: enter through the real chip, read through sandboxed image IPC,
    // and keep the draft, caret, and work-panel state independent of inspection.
    editor = controller.ref.current!;
    const beforePreview = readEditorValue(editor);
    const imageReference = controller.fileReferences[0];
    const dialog = () => document.querySelector<HTMLDialogElement>("dialog.composer-image-preview[open]");
    const until = async (condition: () => unknown, message: string) => {
      const deadline = performance.now() + 5000;
      while (!condition() && performance.now() < deadline) await new Promise(requestAnimationFrame);
      assert(condition(), `${message}; errors=${errors.map(String)}; dialog=${dialog()?.textContent}; image=${dialog()?.querySelector("img")?.outerHTML}`);
    };
    let previewCheck = 0;
    const previewReady = async () => {
      previewCheck++;
      await until(() => {
        const img = dialog()?.querySelector<HTMLImageElement>(".composer-image-preview-viewport img");
        return img?.complete && img.naturalWidth > 0 && img.style.width !== "";
      }, `image preview did not load at check ${previewCheck}`);
      await new Promise(requestAnimationFrame);
      return dialog()!.querySelector<HTMLImageElement>(".composer-image-preview-viewport img")!;
    };
    const button = (label: string) => Array.from(dialog()!.querySelectorAll<HTMLButtonElement>("button"))
      .find((element) => element.getAttribute("aria-label") === label || element.textContent === label)!;
    const close = () => flushSync(() => button(i18n.t("common.close")).click());
    // Hovering the chip reveals its preview card without opening the modal.
    chip.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await until(() => document.querySelector<HTMLImageElement>(".image-hover-card img")?.naturalWidth === 1,
      "hover preview card missing");
    chip.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    await until(() => !document.querySelector(".image-hover-card"), "hover preview card outlived the pointer");
    editor.focus();
    // A sent message's image attachment is that same chip, and hovering it shows
    // the shared preview card instead of an inline thumbnail.
    const messageHost = document.createElement("div");
    messageHost.style.cssText = "position: relative;";
    document.body.append(messageHost);
    const messageRoot = createRoot(messageHost);
    try {
      const messageAttachment: MessageAttachment = {
        kind: "image",
        ref: imageReference.path,
        name: imageReference.name,
      };
      flushSync(() => messageRoot.render(
        <I18nextProvider i18n={i18n}>
          <div role="list">
            <MessageAttachmentImage attachment={messageAttachment} onOpenFile={noop} />
          </div>
        </I18nextProvider>,
      ));
      await new Promise(requestAnimationFrame);
      const messageChip = messageHost.querySelector<HTMLElement>(".message-attachment-image-chip .chat-file-chip");
      assert(messageChip, "a message image attachment must render as a chip");
      assert(!messageHost.querySelector("img"), "a message image attachment must not inline a thumbnail");
      messageChip!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await until(() => document.querySelector<HTMLImageElement>(".image-hover-card img")?.naturalWidth === 1,
        "message hover preview card missing");
      messageChip!.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
      await until(() => !document.querySelector(".image-hover-card"), "message hover card outlived the pointer");
    } finally {
      flushSync(() => messageRoot.unmount());
      messageHost.remove();
    }
    setEditorCaret(editor, 7);
    flushSync(() => chip.click());
    assert(dialog(), "image attachment must open an overlay instead of the work panel");
    assert(dialog()!.matches(":modal"), "preview must use native modal focus containment");
    assert(isBlockingOverlayActive(), "preview must suppress native plugin surfaces");
    const preview = await previewReady();
    editor.focus();
    assert(dialog()!.contains(document.activeElement), "modal allowed background input focus");
    button(i18n.t("chat.imagePreview.fit")).focus();
    await globalThis.composerPreviewPressKey("Tab");
    await until(() => dialog()?.contains(document.activeElement), "Tab escaped the preview");
    assert(preview.naturalWidth === 1 && preview.getBoundingClientRect().width === 1,
      "small image must not be stretched to fill the window");
    assert(!useAppStore.getState().workPanelOpen, "preview opened the work panel");
    const viewport = dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!;
    assert(Math.abs((preview.getBoundingClientRect().left + preview.getBoundingClientRect().right) / 2 -
      (viewport.getBoundingClientRect().left + viewport.getBoundingClientRect().right) / 2) <= 1,
      "preview must be horizontally centered");
    assert(readEditorValue(editor) === beforePreview && controller.fileReferences.length === 1,
      "preview changed the unsent draft");
    flushSync(() => button(i18n.t("menu.zoomIn")).click());
    assert(dialog()!.querySelector("output")?.textContent === "125%", `zoom in failed: ${dialog()!.querySelector("output")?.textContent}, disabled=${button(i18n.t("menu.zoomIn")).disabled}, imageStyle=${preview.getAttribute("style")}`);
    flushSync(() => button(i18n.t("chat.imagePreview.fit")).click());
    assert(dialog()!.querySelector("output")?.textContent === "100%", "fit did not reset zoom");
    const download = dialog()!.querySelector<HTMLAnchorElement>("a[download]")!;
    assert(download.download === imageReference.name && download.href === preview.src,
      "download did not point to the original image with its filename");
    close();
    assert(!dialog() && !isBlockingOverlayActive(), "closing left the modal or native-view blocker active");
    assert(document.activeElement === editor && editorSelectionRange(editor).start === 7,
      "closing did not restore the draft caret");
    // A reference is draft text that is also a keyboard reachable link: it
    // carries one focus stop and the action Enter/Space run is the same one a
    // pointer click runs. Closing the preview hands focus back to the draft
    // caret.
    assert(chip.tabIndex === 0 && chip.getAttribute("role") === "link",
      "an image token must stay a keyboard reachable link");
    assert(document.activeElement === editor && editorSelectionRange(editor).start === 7,
      "closing the preview lost the draft caret");
    assert(readEditorValue(editor) === beforePreview && submitted === 0,
      "preview interaction changed or sent the draft");
    // The isolated host supplies real images within the allowed scratch directory.
    const wide = createFileReference(imageReference.path.replace(/[^/\\]+$/, "wide-fixture.png"), "wide.png", "paste-a", {
      kind: "image", mimeType: "image/png", token: "\ueffe",
    });
    flushSync(() => controller.applyEditorDraft(`${beforePreview}${wide.token}`, [imageReference, wide], 7));
    flushSync(() => imageChipByToken(imageReference.token!)!.click());
    await previewReady();
    assert(button(i18n.t("chat.imagePreview.previous")).disabled, "first image should disable previous");
    flushSync(() => button(i18n.t("chat.imagePreview.next")).click());
    const widePreview = await previewReady();
    const rect = widePreview.getBoundingClientRect();
    assert(widePreview.naturalWidth === 1200 && Math.abs(rect.width / rect.height - 2) < 0.02,
      "wide preview lost its original aspect ratio");
    assert(rect.width <= dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!.clientWidth + 1 && rect.height <= dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!.clientHeight + 1,
      "large image did not fit the preview viewport");
    assert(button(i18n.t("chat.imagePreview.next")).disabled, "last image should disable next");
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    await globalThis.composerPreviewPointer({ type: "mousePressed", x: startX, y: startY });
    await globalThis.composerPreviewPointer({ type: "mouseMoved", x: startX + 80, y: startY + 40 });
    await globalThis.composerPreviewPointer({ type: "mouseReleased", x: startX + 80, y: startY + 40 });
    await new Promise(requestAnimationFrame);
    assert(dialog() && Math.abs(widePreview.getBoundingClientRect().left - rect.left - 80) <= 1 &&
      Math.abs(widePreview.getBoundingClientRect().top - rect.top - 40) <= 1,
      "dragging the image must move it without dismissing the preview");
    flushSync(() => button(i18n.t("chat.imagePreview.fit")).click());
    assert(Math.abs(widePreview.getBoundingClientRect().left - rect.left) <= 1,
      "fit must recenter a dragged image");
    const panViewport = dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!;
    flushSync(() => panViewport.dispatchEvent(new WheelEvent("wheel", { deltaX: 30, deltaY: 20, bubbles: true, cancelable: true })));
    assert(Math.abs(widePreview.getBoundingClientRect().left - rect.left + 30) <= 1,
      "ordinary scrolling must pan the image");
    flushSync(() => button(i18n.t("chat.imagePreview.fit")).click());
    let capturedPointer = -1;
    widePreview.addEventListener("pointerdown", (event) => { capturedPointer = event.pointerId; }, { once: true });
    await globalThis.composerPreviewPointer({ type: "mousePressed", x: startX, y: startY });
    assert(capturedPointer !== -1 && widePreview.hasPointerCapture(capturedPointer), "image drag did not capture its pointer");
    flushSync(() => widePreview.dispatchEvent(new PointerEvent("pointercancel", { pointerId: capturedPointer, bubbles: true })));
    assert(!widePreview.hasPointerCapture(capturedPointer) && !widePreview.hasAttribute("data-dragging"),
      "cancelling must release capture and clear the dragging cursor");
    await globalThis.composerPreviewPointer({ type: "mouseMoved", x: startX + 60, y: startY + 20 });
    await globalThis.composerPreviewPointer({ type: "mouseReleased", x: startX + 60, y: startY + 20 });
    await new Promise(requestAnimationFrame);
    assert(dialog() && Math.abs(widePreview.getBoundingClientRect().left - rect.left) <= 1,
      "cancelled pointer kept moving or dismissed the image");


    flushSync(() => button(i18n.t("menu.zoomIn")).click());
    const zoomedViewport = dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!;
    const zoomedRect = widePreview.getBoundingClientRect();
    assert(Math.abs((zoomedRect.left + zoomedRect.right) / 2 -
      (zoomedViewport.getBoundingClientRect().left + zoomedViewport.getBoundingClientRect().right) / 2) <= 1,
      "zoom must preserve the image center");
    await globalThis.composerPreviewPointer({ type: "mousePressed", x: startX, y: startY });
    await globalThis.composerPreviewPointer({ type: "mouseMoved", x: startX - 100, y: startY - 50 });
    await globalThis.composerPreviewPointer({ type: "mouseReleased", x: startX - 100, y: startY - 50 });
    await new Promise(requestAnimationFrame);
    assert(Math.abs(widePreview.getBoundingClientRect().left - zoomedRect.left + 100) <= 1 && dialog(),
      "zoomed image must support dragging");
    flushSync(() => dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    await previewReady();
    assert(dialog()!.querySelector("output")?.textContent === "100%", "gallery switch retained another image's zoom");
    flushSync(() => dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    const returnedPreview = await previewReady();
    assert(Math.abs(returnedPreview.getBoundingClientRect().left - rect.left) <= 1,
      "switching images must reset the pan position");
    const backdrop = dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!;
    flushSync(() => backdrop.click());
    assert(!dialog(), "blank-area click did not close preview");
    if (globalThis.composerPreviewCapture) await globalThis.composerPreviewCapture();
    editor.focus();
    const galleryDraft = readEditorValue(editor);
    select(editor, 0, galleryDraft.length);
    assert(document.execCommand("insertText", false, "new prompt"), "text replacement failed");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 0,
      "replacing the whole draft removed its inline image chips");
    assert(controller.draftSnapshot("new prompt").fileReferences.length === 0,
      "submission snapshot kept a replaced image");
    assert(document.execCommand("undo"), "image draft text undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(readEditorValue(editor) === galleryDraft && controller.fileReferences.length === 2,
      "text undo did not restore the inline image chips");

    // Cancelled image reads must never overwrite a later draft's image.
    const realRead = api.fsReadImageDataUrl;
    let rejectRead: ((reason: Error) => void) | undefined;
    const delayed = createFileReference(imageReference.path, "delayed.png", "paste-a", {
      kind: "image", mimeType: "image/png", token: imageReference.token,
    });
    api.fsReadImageDataUrl = () => new Promise((_resolve, reject) => { rejectRead = reject; });
    try {
      flushSync(() => controller.applyEditorDraft(beforePreview, [delayed], 7));
      flushSync(() => imageChipByToken(imageReference.token!)!.click());
      assert(rejectRead && dialog(), "deferred image read was not started");
      api.fsReadImageDataUrl = realRead;
      flushSync(() => controller.applyEditorDraft(beforePreview, [imageReference], 7));
      assert(!dialog(), "removed preview attachment left the dialog open");
      flushSync(() => imageChipByToken(imageReference.token!)!.click());
      await previewReady();
      rejectRead!(new Error("late fixture read failure"));
      await new Promise(requestAnimationFrame);
      assert(dialog()?.querySelector("img"), "stale failure replaced the newer preview");
    } finally { api.fsReadImageDataUrl = realRead; }
    render("paste-b");
    await new Promise(requestAnimationFrame);
    assert(!dialog() && !isBlockingOverlayActive(), "session switch retained the old preview");
    render("paste-a");
    await new Promise(requestAnimationFrame);
    editor = controller.ref.current!;
    const currentChip = imageChipByToken(imageReference.token!)!;
    assert(currentChip, "returning to the session did not restore its image reference");
    useAppStore.setState({ activeSessionId: "paste-b" });
    flushSync(() => currentChip.click());
    assert(!dialog(), "old reference opened in another session");
    useAppStore.setState({ activeSessionId: "paste-a" });
    // Deleting a reference is one Backspace: the token is atomic, so there is no
    // per-reference remove control and no label character to delete separately.
    const tokenIndex = readEditorValue(editor).indexOf(imageReference.token!);
    assert(tokenIndex >= 0, "the draft no longer holds the image reference token");
    setEditorCaret(editor, tokenIndex + 1);
    const backspace = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    flushSync(() => editor.dispatchEvent(backspace));
    assert(backspace.defaultPrevented, "Backspace beside a reference must delete the whole token");
    await new Promise(requestAnimationFrame);
    assert(!dialog() && submitted === 0, "reference delete opened the preview or submitted the prompt");
    assert(controller.fileReferences.length === 0 && draftText() === "prefix  suffix",
      "reference delete did not preserve the surrounding draft");

    // Failed images remain attached, show a retry action, and never blank the draft.
    const missing = createFileReference(`${imageReference.path}.missing.png`, "missing.png", "paste-a", {
      kind: "image", mimeType: "image/png", token: imageReference.token,
    });
    flushSync(() => controller.applyEditorDraft(beforePreview, [missing], 7));
    flushSync(() => imageChipByToken(imageReference.token!)!.click());
    await until(() => dialog()?.textContent?.includes(i18n.t("chat.imagePreview.error")), "missing image did not show an error");
    assert(readEditorValue(editor) === beforePreview && controller.fileReferences.length === 1,
      "failed preview lost the draft");
    api.fsReadImageDataUrl = () => realRead(imageReference.path, imageReference.mimeType);
    try {
      flushSync(() => button(i18n.t("chat.imagePreview.retry")).click());
      await previewReady();
    } finally { api.fsReadImageDataUrl = realRead; }
    close();
    const corrupt = createFileReference(imageReference.path.replace(/[^/\\]+$/, "corrupt-fixture.png"), "corrupt.png", "paste-a", {
      kind: "image", mimeType: "image/png", token: imageReference.token,
    });
    flushSync(() => controller.applyEditorDraft(beforePreview, [corrupt], 7));
    flushSync(() => imageChipByToken(imageReference.token!)!.click());
    await until(() => dialog()?.textContent?.includes(i18n.t("chat.imagePreview.error")), "undecodable image did not show retry");
    assert(readEditorValue(editor) === beforePreview, "decode failure changed the draft");
    close();

    // An image-only draft remains sendable and survives session switching.
    editor = await paste("", [image], true);
    assert(controller.ref.current!.querySelectorAll(".composer-reference[data-image]").length === 1 &&
      controller.draftSnapshot(readEditorValue(controller.ref.current!)).fileReferences.length === 1,
      "image-only draft lost its sendable attachment");
    const attachedId = controller.fileReferences[0].path;
    flushSync(() => controller.restoreDraftForKey("paste-a", { text: "older draft", fileReferences: [] }));
    assert(controller.ref.current!.querySelector(".composer-reference[data-image]") &&
      controller.fileReferences[0]?.path === attachedId,
      "restoring an old draft overwrote a newer image-only draft");
    render("paste-b");
    flushSync(() => controller.restoreDraftForKey("paste-a", { text: "older draft", fileReferences: [] }));
    render("paste-a");
    // The restored draft hydrates from the cache in the switch effect, so give
    // the layout paint a bounded window before asserting the chip is back.
    const restoredDeadline = performance.now() + 2000;
    while (
      (controller.fileReferences[0]?.path !== attachedId ||
        !controller.ref.current!.querySelector(".composer-reference[data-image]")) &&
      performance.now() < restoredDeadline
    ) {
      await new Promise(requestAnimationFrame);
    }
    assert(controller.fileReferences[0]?.path === attachedId &&
      controller.ref.current!.querySelector(".composer-reference[data-image]"),
      "image-only draft did not survive session switching");

    // A pasted conversation link is an inline chip, and the submitted text
    // carries that link again.
    const linkedSession = "session-link-fixture";
    editor = await paste(`continue from ${formatSessionLink(linkedSession)}`, []);
    const linkChip = editor.querySelector<HTMLElement>(
      `.composer-reference[data-session-id="${linkedSession}"]`,
    );
    assert(linkChip, "a pasted conversation link must render as an inline reference");
    assert(
      !readEditorValue(editor).includes(formatSessionLink(linkedSession)),
      "the chip replaces the raw link in the draft text",
    );
    assert(
      serializeInlineComposerFileReferences(readEditorValue(editor), controller.fileReferences)
        .includes(formatSessionLink(linkedSession)),
      "the submitted text carries the conversation link",
    );
    assert(
      linkChip!.textContent === `@${i18n.t("chat.sessionReference")} · ${linkedSession.slice(0, 8)}`,
      `the reference names the conversation it opens: ${linkChip!.textContent}`,
    );

    await paste("file names", nativeFiles);
    assert(
      controller.fileReferences.length === 2,
      "mixed native files were lost",
    );
    assert(
      controller.fileReferences[1].mimeType === "text/plain",
      "native text file became inline text",
    );

    const mixedDraft = controller.value;
    const mixedReferences = controller.fileReferences;
    flushSync(() => controller.ref.current!.querySelector<HTMLElement>('[data-action="expand-text-reference"]')!.click());
    const textDeadline = performance.now() + 5000;
    while (controller.fileReferences.length !== 1 && performance.now() < textDeadline) {
      await new Promise(requestAnimationFrame);
    }
    assert(controller.value.includes("native file bytes") && controller.fileReferences[0]?.kind === "image",
      "text chip no longer expands while preserving the image attachment");
    flushSync(() => controller.applyEditorDraft(mixedDraft, mixedReferences, mixedDraft.length));
    const saved = readComposerDraft("paste-a");
    assert(
      saved?.fileReferences.length === 2,
      "file references did not persist in the owning draft",
    );
    render("paste-b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(controller.value === "", "attachments leaked into another session");
    render("paste-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(
      controller.fileReferences.length === 2,
      "session switch lost attachments",
    );
    const reference = createFileReference("/fixture/file.bin", "file.bin", "paste-a", { kind: "file", token: "\ueffd" });
    flushSync(() =>
      controller.applyEditorDraft(
        `left${reference.token}right`,
        [reference],
        4,
      ),
    );
    await new Promise(requestAnimationFrame);
    editor = controller.ref.current!;
    select(editor, 3, 6);
    await dispatchPaste(editor, "X\nY", [image]);
    assert(
      readEditorValue(editor) === "lefX\nYight",
      "replacement across attachment chip changed surrounding text",
    );
    assert(
      controller.fileReferences.length === 0,
      "replaced attachment stayed in draft metadata",
    );
    // No store subscription forces a render between clearing and rejection.
    const retryImage = createFileReference(imageReference.path, "retry.png", "paste-a", { kind: "image", mimeType: "image/png" });
    flushSync(() => controller.applyEditorDraft("retry draft", [retryImage], 11));
    await new Promise(requestAnimationFrame);
    await rejectSubmission();
    await new Promise(requestAnimationFrame);
    const retryToken = controller.fileReferences[0]?.token ?? "";
    assert(
      retryToken !== "" &&
        readEditorValue(controller.ref.current!) === `retry draft${retryToken}` &&
        controller.fileReferences[0]?.path === imageReference.path,
      "fast rejection before React commits must restore the text and attachments",
    );
    // Native undo must restore reference metadata as well as the visible chip.
    await reset("inspect \uE050 please", 8, 9);
    const undoReference = createFileReference("src/main.ts", "main.ts", "paste-a", { token: "\uE050" });
    flushSync(() => controller.applyEditorDraft("inspect \uE050 please", [undoReference], 9));
    await new Promise(requestAnimationFrame);
    const undoEditor = controller.ref.current!;
    undoEditor.focus();
    select(undoEditor, 8, 9);
    assert(document.execCommand("delete"), "native chip deletion unavailable");
    await new Promise(requestAnimationFrame);
    assert(document.execCommand("undo"), "native chip undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.some(r => r.path === "src/main.ts"), "Undo restored the chip without its file reference metadata");
    assert(serializeInlineComposerFileReferences(readEditorValue(undoEditor), controller.activeFileReferences) === "inspect @src/main.ts please",
      "undo must restore the path used by submission");
    assert(document.execCommand("redo"), "native chip redo unavailable");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 0, "redo retained a deleted attachment");
    assert(document.execCommand("undo"), "second native chip undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 1, "repeated undo lost the attachment");
    render("paste-b");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 0, "undo metadata leaked into another chat");
    render("paste-a");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.some(r => r.path === "src/main.ts"),
      "the restored reference did not survive a chat round-trip");
    const restoredEditor = controller.ref.current!;
    restoredEditor.focus();
    select(restoredEditor, 8, 9);
    assert(document.execCommand("delete"), "second chip deletion unavailable");
    await new Promise(requestAnimationFrame);
    assert(document.execCommand("insertText", false, "\uE050"), "private-use text insertion unavailable");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 0,
      "typing a removed chip's token must not resurrect an attachment");

    // A batched away-and-back project change must invalidate deleted history,
    // too: native undo must never attach the old relative path to a new context.
    const priorWorkspace = useAppStore.getState().workspace;
    await reset("inspect \uE050 please", 8, 9);
    flushSync(() => controller.applyEditorDraft("inspect \uE050 please", [undoReference], 9));
    await new Promise(requestAnimationFrame);
    const workspaceUndoEditor = controller.ref.current!;
    workspaceUndoEditor.focus();
    select(workspaceUndoEditor, 8, 9);
    assert(document.execCommand("delete"), "workspace undo deletion unavailable");
    await new Promise(requestAnimationFrame);
    flushSync(() => {
      useAppStore.setState({ workspace: { path: "/other-project", name: "Other" } });
      useAppStore.setState({ workspace: priorWorkspace });
    });
    assert(document.execCommand("undo"), "workspace native undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 0,
      "undo resurrected a reference after a batched workspace round-trip");
    // Internal copy/cut/paste: a selection that covers a chip must carry the
    // attachment identity, its order, and the exact surrounding text, while a
    // plain-text consumer only ever sees a readable `@path`. The OS clipboard
    // edge is the only mocked part: the events, editor, and draft hooks are real.
    const clipboardMime = "application/x-pi-desktop-composer+json";
    const isSentinel = (char: string) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0xe000 && code <= 0xf8ff;
    };
    const sentinels = (value: string) => Array.from(value).filter(isSentinel);
    const dispatchClipboard = (type: "copy" | "cut", target: HTMLElement) => {
      const data = new DataTransfer();
      const event = new ClipboardEvent(type, {
        clipboardData: data, bubbles: true, cancelable: true,
      });
      flushSync(() => target.dispatchEvent(event));
      return {
        event,
        data,
        plain: data.getData("text/plain"),
        structured: data.getData(clipboardMime),
      };
    };
    const dispatchInternalPaste = async (target: HTMLElement, data: DataTransfer) => {
      const event = new ClipboardEvent("paste", {
        clipboardData: data, bubbles: true, cancelable: true,
      });
      flushSync(() => target.dispatchEvent(event));
      await pastePending;
      await new Promise(requestAnimationFrame);
      assert(errors.length === 0, `React failed: ${errors.map(String).join("; ")}`);
      return event;
    };
    const chipTokens = (target: HTMLElement) =>
      Array.from(target.querySelectorAll<HTMLElement>(".composer-reference"))
        .map((chip) => chip.dataset.token ?? "");
    const pathsInOrder = (tokens: readonly string[]) =>
      tokens.map((token) =>
        controller.fileReferences.find((reference) => reference.token === token)?.path);

    const copiedAbsolute = "/scratch/paste-a/copied.png";
    const copiedRelative = "src/copied.ts";
    const clipboardSource = "alpha \ue070 beta \ue071 gamma";
    await reset("", 0, 0);
    flushSync(() => controller.applyEditorDraft(
      clipboardSource,
      [
        createFileReference(copiedAbsolute, "copied.png", "paste-a", {
          kind: "image", mimeType: "image/png", token: "\ue070",
        }),
        createFileReference(copiedRelative, "copied.ts", "paste-a", {
          kind: "file", token: "\ue071",
        }),
      ],
      clipboardSource.length,
    ));
    await new Promise(requestAnimationFrame);
    const clipboardEditor = controller.ref.current!;
    clipboardEditor.focus();
    select(clipboardEditor, 0, clipboardSource.length);
    const copied = dispatchClipboard("copy", clipboardEditor);
    assert(copied.event.defaultPrevented,
      "copying a selection that holds chips must be handled by the composer");
    assert(
      copied.plain === `alpha @${copiedAbsolute} beta @${copiedRelative} gamma`,
      `the plain fallback lost an attachment path: ${JSON.stringify(copied.plain)}`,
    );
    assert(sentinels(copied.plain).length === 0,
      "a renderer sentinel reached the plain clipboard");
    const payload = JSON.parse(copied.structured) as {
      v: number; s: string; parts: Array<Record<string, unknown>>;
    };
    assert(payload.v === 1 && payload.s === "paste-a",
      `the structured clipboard is not the versioned draft format: ${copied.structured}`);
    assert(payload.parts.length === 5,
      `structured parts lost a text run: ${JSON.stringify(payload.parts)}`);
    assert(!copied.structured.includes("\ue070") && !copied.structured.includes("\ue071"),
      "the structured clipboard carried a renderer sentinel");
    assert(
      controller.fileReferences.length === 2 &&
        readEditorValue(clipboardEditor) === clipboardSource,
      "copying changed the draft",
    );

    // Paste the same payload twice into its own draft: fresh tokens both times.
    setEditorCaret(clipboardEditor, clipboardSource.length);
    await dispatchInternalPaste(clipboardEditor, copied.data);
    assert(controller.fileReferences.length === 4,
      `internal paste did not carry both chips: ${controller.fileReferences.length}`);
    const firstPasteTokens = chipTokens(clipboardEditor);
    assert(firstPasteTokens.length === 4 && new Set(firstPasteTokens).size === 4,
      "internal paste reused a chip token");
    assert(
      pathsInOrder(firstPasteTokens).join("|") ===
        [copiedAbsolute, copiedRelative, copiedAbsolute, copiedRelative].join("|"),
      `internal paste changed the chip order: ${JSON.stringify(pathsInOrder(firstPasteTokens))}`,
    );
    assert(sentinels(readEditorValue(clipboardEditor)).length === 4,
      "internal paste lost the surrounding text");
    await dispatchInternalPaste(clipboardEditor, copied.data);
    assert(controller.fileReferences.length === 6 && new Set(chipTokens(clipboardEditor)).size === 6,
      "a repeated internal paste collided with the tokens it had just inserted");

    // A subset that holds one chip copies only that chip, and the paste
    // restores exactly one attachment with a fresh token.
    const subsetToken = chipTokens(clipboardEditor).find(
      (token) => pathsInOrder([token])[0] === copiedRelative,
    );
    assert(subsetToken, "the repeated paste lost the relative reference");
    const subsetIndex = readEditorValue(clipboardEditor).indexOf(subsetToken);
    select(clipboardEditor, subsetIndex, subsetIndex + 1);
    const subset = dispatchClipboard("copy", clipboardEditor);
    assert(subset.event.defaultPrevented,
      "copying a subset that holds a chip must be handled by the composer");
    assert(subset.plain === `@${copiedRelative}`,
      `a chip-only subset lost its readable path: ${JSON.stringify(subset.plain)}`);
    const subsetPayload = JSON.parse(subset.structured) as { parts: unknown[] };
    assert(subsetPayload.parts.length === 1,
      `a chip-only subset carried extra parts: ${subset.structured}`);
    setEditorCaret(clipboardEditor, readEditorValue(clipboardEditor).length);
    await dispatchInternalPaste(clipboardEditor, subset.data);
    assert(controller.fileReferences.length === 7 && chipTokens(clipboardEditor).length === 7,
      "a subset paste did not add exactly one attachment");
    assert(
      controller.fileReferences.filter((reference) => reference.token === subsetToken).length === 1,
      "a subset paste duplicated the source chip instead of allocating a fresh token",
    );

    // Cut publishes readable content first, removes only the selection, and
    // native undo restores the text, the chips, and their reference metadata.
    const beforeCutText = readEditorValue(clipboardEditor);
    const beforeCutTokens = chipTokens(clipboardEditor);
    select(clipboardEditor, 0, beforeCutText.length);
    const cut = dispatchClipboard("cut", clipboardEditor);
    assert(cut.event.defaultPrevented && cut.plain.includes(`@${copiedAbsolute}`),
      "cut must publish the readable selection before deleting it");
    assert(sentinels(cut.plain).length === 0, "cut leaked a renderer sentinel");
    assert(readEditorValue(clipboardEditor) === "" && controller.fileReferences.length === 0,
      `cut did not remove exactly the selection: ${JSON.stringify(readEditorValue(clipboardEditor))}`);
    assert(document.execCommand("undo"), "native cut undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(readEditorValue(clipboardEditor) === beforeCutText,
      "native undo did not restore the cut text");
    assert(
      controller.fileReferences.map((reference) => reference.token).join("") ===
        beforeCutTokens.join(""),
      "native undo did not restore the cut attachments in order",
    );
    assert(chipTokens(clipboardEditor).join("") === beforeCutTokens.join(""),
      "native undo did not restore the cut chips");
    assert(document.execCommand("redo"), "native cut redo unavailable");
    await new Promise(requestAnimationFrame);
    assert(readEditorValue(clipboardEditor) === "" && controller.fileReferences.length === 0,
      "native redo kept the cut selection");
    assert(document.execCommand("undo"), "second native cut undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(
      readEditorValue(clipboardEditor) === beforeCutText &&
        controller.fileReferences.length === beforeCutTokens.length,
      "repeated undo lost the cut draft",
    );

    const relativeCount = controller.fileReferences.filter(
      (reference) => reference.path === copiedRelative,
    ).length;
    // Another draft cannot resolve this draft's scratch file: that chip stays
    // readable text, while the relative workspace path keeps its chip.
    render("paste-b");
    await new Promise(requestAnimationFrame);
    const crossEditor = controller.ref.current!;
    crossEditor.focus();
    setEditorCaret(crossEditor, 0);
    await dispatchInternalPaste(crossEditor, cut.data);
    assert(readEditorValue(crossEditor).includes(`@${copiedAbsolute}`),
      "another draft did not receive this draft's scratch path as readable text");
    assert(
      controller.fileReferences.length === relativeCount &&
        controller.fileReferences.every((reference) => reference.path === copiedRelative),
      `cross-draft paste kept an unresolvable chip: ${JSON.stringify(controller.fileReferences.map((reference) => reference.path))}`,
    );
    assert(chipTokens(crossEditor).length === relativeCount,
      "cross-draft paste rendered the wrong number of chips");

    // A payload this build cannot trust never becomes an attachment.
    const hostile = new DataTransfer();
    hostile.setData("text/plain", "@src/evil.ts");
    hostile.setData(clipboardMime, JSON.stringify({
      v: 1,
      s: "paste-a",
      parts: [{
        ref: {
          kind: "file", path: "src/evil.ts", name: "evil.ts",
          plugin: { kind: "mark", pluginId: "evil", send: "" },
        },
      }],
    }));
    setEditorCaret(crossEditor, readEditorValue(crossEditor).length);
    await dispatchInternalPaste(crossEditor, hostile);
    assert(controller.fileReferences.length === relativeCount,
      "a malformed clipboard payload added an attachment");
    assert(readEditorValue(crossEditor).endsWith("@src/evil.ts"),
      `a malformed clipboard payload did not fall back to its plain text: ${JSON.stringify(readEditorValue(crossEditor))}`);
    const oversized = new DataTransfer();
    oversized.setData("text/plain", "untrusted");
    oversized.setData(clipboardMime, JSON.stringify({
      v: 1,
      s: "paste-a",
      parts: Array.from({ length: 240 }, () => ({
        ref: { kind: "file", path: "x", name: "y" },
      })),
    }));
    setEditorCaret(crossEditor, readEditorValue(crossEditor).length);
    await dispatchInternalPaste(crossEditor, oversized);
    assert(controller.fileReferences.length === relativeCount,
      "an oversized clipboard payload added an attachment");
    assert(readEditorValue(crossEditor).endsWith("untrusted"),
      "an oversized clipboard payload did not fall back to its plain text");
    // A clipboard write that fails must not let the native action run: a native
    // cut would delete the selection and its chip metadata, and a native copy
    // would replace the composer's readable selection with a chip-less fallback.
    const failingClipboard = (
      type: "copy" | "cut",
      failWhen: "first" | "after-plain",
    ) => {
      const data = new DataTransfer();
      const writes: string[] = [];
      const clipboardData = new Proxy(data, {
        get(target, property) {
          if (property === "setData") {
            return (format: string, value: string) => {
              if (failWhen === "first" || format !== "text/plain") {
                throw new Error(`clipboard write failed: ${format}`);
              }
              writes.push(format);
              target.setData(format, value);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const event = new ClipboardEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: clipboardData });
      return { event, data, writes };
    };
    const execCommands: string[] = [];
    const nativeExecCommand = document.execCommand;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: (command: string) => {
        execCommands.push(command);
        return nativeExecCommand.call(document, command);
      },
    });
    try {
      const failingSource = "before \uE0B0 after";
      const failingReference = createFileReference(
        "/scratch/paste-a/failing.png",
        "failing.png",
        "paste-a",
        { kind: "image", mimeType: "image/png", token: "\uE0B0" },
      );
      const failingEditor = await reset("", 0, 0);
      flushSync(() =>
        controller.applyEditorDraft(failingSource, [failingReference], failingSource.length),
      );
      await new Promise(requestAnimationFrame);
      failingEditor.focus();
      select(failingEditor, 0, failingSource.length);
      const failedFirstWrite = failingClipboard("cut", "first");
      flushSync(() => failingEditor.dispatchEvent(failedFirstWrite.event));
      assert(
        failedFirstWrite.event.defaultPrevented,
        "a handled cut whose clipboard write failed let the native deletion run",
      );
      assert(failedFirstWrite.writes.length === 0,
        "the failing clipboard received a write");
      assert(
        readEditorValue(failingEditor) === failingSource &&
          controller.fileReferences.length === 1 &&
          controller.fileReferences[0].path === failingReference.path,
        `a failed clipboard write changed the draft: ${JSON.stringify(readEditorValue(failingEditor))}`,
      );
      assert(!execCommands.includes("delete"),
        "a cut deleted the selection after the clipboard write failed");
      assert(chipTokens(failingEditor).join("") === "\uE0B0",
        "a failed cut removed the chip");
      // The plain write succeeded but the structured one did not: the copy is
      // cancelled rather than falling back to a native chip-less copy, and the
      // clipboard is never claimed to hold the structured payload.
      select(failingEditor, 0, readEditorValue(failingEditor).length);
      const partiallyWritten = failingClipboard("copy", "after-plain");
      flushSync(() => failingEditor.dispatchEvent(partiallyWritten.event));
      assert(
        partiallyWritten.event.defaultPrevented,
        "a handled copy whose structured write failed let the native copy replace it",
      );
      assert(partiallyWritten.writes.includes("text/plain"),
        "the failing copy did not attempt its readable text");
      assert(partiallyWritten.data.getData(clipboardMime) === "",
        "a failed structured write reported a valid structured clipboard");
      assert(
        readEditorValue(failingEditor) === failingSource &&
          controller.fileReferences.length === 1 &&
          chipTokens(failingEditor).join("") === "\uE0B0",
        "a failed copy changed the draft",
      );
      assert(!execCommands.includes("delete"),
        "a copy deleted part of the selection");
    } finally {
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        writable: true,
        value: nativeExecCommand,
      });
    }
    // A plain-text selection still belongs to the browser: the composer must
    // not intercept it, attempt a write, or cancel its native copy.
    const plainEditor = await reset("native plain copy", 0, 0);
    select(plainEditor, 0, readEditorValue(plainEditor).length);
    const plainNative = failingClipboard("copy", "first");
    flushSync(() => plainEditor.dispatchEvent(plainNative.event));
    assert(
      !plainNative.event.defaultPrevented && plainNative.writes.length === 0,
      "a selection without a chip was intercepted by the composer clipboard",
    );
    assert(
      controller.fileReferences.length === 0 &&
        readEditorValue(plainEditor) === "native plain copy",
      "the native plain copy path changed the draft",
    );
    await reset("", 0, 0);
    const replacementToken = "\uE0C0";
    const replacementPath = "/scratch/paste-a/replaced.png";
    const replacementSource = `replace ${replacementToken} once`;
    const replacementEditor = await reset("", 0, 0);
    flushSync(() =>
      controller.applyEditorDraft(
        replacementSource,
        [
          createFileReference(replacementPath, "replaced.png", "paste-a", {
            kind: "image", mimeType: "image/png", token: replacementToken,
          }),
        ],
        replacementSource.length,
      ),
    );
    await new Promise(requestAnimationFrame);
    replacementEditor.focus();
    select(replacementEditor, 0, replacementSource.length);
    const replacementPayload = dispatchClipboard("copy", replacementEditor);
    assert(replacementPayload.event.defaultPrevented,
      "copying a draft that holds an image must be handled by the composer");
    const previousTokens = chipTokens(replacementEditor);
    select(replacementEditor, 0, readEditorValue(replacementEditor).length);
    await dispatchInternalPaste(replacementEditor, replacementPayload.data);
    const replacedTokens = chipTokens(replacementEditor);
    assert(
      replacedTokens.length === 1 && controller.fileReferences.length === 1,
      `a replace-all paste kept the replaced image: ${JSON.stringify(
        replacedTokens.map((token) =>
          controller.fileReferences.find((reference) => reference.token === token)?.path,
        ),
      )}`,
    );
    assert(
      replacedTokens.every((token) => !previousTokens.includes(token)) &&
        !sentinels(readEditorValue(replacementEditor)).includes(replacementToken),
      "a replace-all paste kept the replaced image's token",
    );
    assert(
      readEditorValue(replacementEditor) ===
          replacementSource.replace(replacementToken, replacedTokens[0]) &&
        pathsInOrder(replacedTokens).join("|") === replacementPath,
      `a replace-all paste appended the replaced image: ${JSON.stringify(readEditorValue(replacementEditor))}`,
    );
    const replacedCache = readComposerDraft(controller.draftKey);
    assert(
      replacedCache?.text === readEditorValue(replacementEditor) &&
        replacedCache.fileReferences.length === 1 &&
        replacedCache.fileReferences[0].path === replacementPath &&
        replacedCache.fileReferences[0].token === replacedTokens[0],
      `a replace-all paste cached a stale image reference: ${JSON.stringify(replacedCache)}`,
    );
    // A partial replacement consumes only the chips it covered: the untouched
    // image keeps its identity and place instead of being re-inserted.
    const partialFirst = "\uE0C1";
    const partialSecond = "\uE0C2";
    const partialFirstPath = "/scratch/paste-a/partial-first.png";
    const partialSecondPath = "/scratch/paste-a/partial-second.png";
    const partialSource = `left ${partialFirst} middle ${partialSecond} right`;
    const partialEditor = await reset("", 0, 0);
    flushSync(() =>
      controller.applyEditorDraft(
        partialSource,
        [
          createFileReference(partialFirstPath, "partial-first.png", "paste-a", {
            kind: "image", mimeType: "image/png", token: partialFirst,
          }),
          createFileReference(partialSecondPath, "partial-second.png", "paste-a", {
            kind: "image", mimeType: "image/png", token: partialSecond,
          }),
        ],
        partialSource.length,
      ),
    );
    await new Promise(requestAnimationFrame);
    partialEditor.focus();
    select(partialEditor, 0, partialSource.length);
    const partialPayload = dispatchClipboard("copy", partialEditor);
    const replacedStart = readEditorValue(partialEditor).indexOf(partialFirst);
    const replacedEnd = readEditorValue(partialEditor).indexOf(partialSecond);
    select(partialEditor, replacedStart, replacedEnd);
    await dispatchInternalPaste(partialEditor, partialPayload.data);
    const partialTokens = chipTokens(partialEditor);
    const partialPaths = pathsInOrder(partialTokens);
    assert(
      partialTokens.length === 3 &&
        partialPaths.join("|") === [partialFirstPath, partialSecondPath, partialSecondPath].join("|"),
      `a partial replacement misplaced the remaining image: ${JSON.stringify(partialPaths)}`,
    );
    assert(
      !sentinels(readEditorValue(partialEditor)).includes(partialFirst) &&
        sentinels(readEditorValue(partialEditor)).includes(partialSecond),
      `a partial replacement kept the replaced image: ${JSON.stringify(readEditorValue(partialEditor))}`,
    );
    assert(
      controller.fileReferences.some((reference) =>
        reference.path === partialSecondPath && reference.token === partialSecond,
      ) && !controller.fileReferences.some((reference) => reference.token === partialFirst),
      `a partial replacement lost the untouched image's identity: ${JSON.stringify(controller.fileReferences.map((reference) => reference.token))}`,
    );
    const partialCache = readComposerDraft(controller.draftKey);
    assert(
      partialCache?.text === readEditorValue(partialEditor) &&
        partialCache.fileReferences.length === 3,
      `a partial replacement cached stale references: ${JSON.stringify(partialCache)}`,
    );
    const restoredText = readEditorValue(partialEditor);
    flushSync(() => root.render(null));
    render("paste-a");
    await new Promise(requestAnimationFrame);
    const remountedEditor = controller.ref.current!;
    assert(
      readEditorValue(remountedEditor) === restoredText &&
        chipTokens(remountedEditor).length === 3 &&
        controller.fileReferences.length === 3,
      `a remount did not restore the replaced draft: ${JSON.stringify(readEditorValue(remountedEditor))}`,
    );
    flushSync(() => root.render(null));
    resetComposerDraftCache();

    await verifyComposerSubmission(imageReference.path, i18n);
    return {
      ok: true,
      fullComposerSubmissionAndOverflow: true,
      mixedShortText: true,
      multilineAndUndoRedo: true,
      fileReferenceUndoRedo: true,
      crossBreakAndChipSelection: true,
      mixedLongText: true,
      temporaryTaskTextPreview: true,
      mp4AttachmentOpen: true,
      imageOnly: true,
      nativeImageFile: true,
      imagePreviewAndKeyboard: true,
      centeredImageGallery: true,
      imageDragAndReset: true,
      inlineImageChips: true,
      imageZoomFocusAndRecovery: true,
      nativeMultipleFiles: true,
      selectionAndSessionDrafts: true,
      workspaceReferencesAcrossRemount: true,
      pendingPasteAcrossSessionSwitch: true,
      attachmentSelectionClipboard: true,
      replacementPasteConsumesCoveredChip: true,
      clipboardWriteFailureCancelsNativeEdit: true,
    };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    resetComposerDraftCache();
  }
};

globalThis.composerHistoryProbe = async (phase) => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, {
    onUncaughtError: (error) => errors.push(error),
  });
  const render = (sessionId: string) => {
    useAppStore.setState({ activeSessionId: sessionId || null });
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Fixture
            key={sessionId || "home"}
            sessionId={sessionId}
            t={i18n.t}
            workspacePath=""
          />
        </I18nextProvider>,
      ),
    );
    assert(errors.length === 0, `React failed: ${errors.map(String).join("; ")}`);
  };
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const press = async (key: string) => {
    controller.ref.current!.focus();
    await globalThis.composerPreviewPressKey(key);
    await frame();
    assert(errors.length === 0, `React failed after ${key}: ${errors.map(String).join("; ")}`);
  };
  try {
    resetComposerDraftCache();
    if (phase === "prepare") {
      historySendPrompt = async (_content, _draft, sessionId, onAccepted) => {
        if (!sessionId) throw new Error("a docked prompt must submit to its selected session");
        onAccepted?.(sessionId);
        return true;
      };
      render("paste-a");
      await frame();
      const send = async (text: string, references: ReturnType<typeof createFileReference>[] = []) => {
        flushSync(() => controller.applyEditorDraft(text, references, text.length));
        await frame();
        await press("Enter");
        await latestSubmission;
        await frame();
        assert(readEditorValue(controller.ref.current!) === "", "accepted send did not clear its draft");
      };
      await send("alpha");
      await send("beta");
      await send("beta");
      await press("ArrowUp");
      assert(readEditorValue(controller.ref.current!) === "beta", "ArrowUp did not recall the newest entry");
      await press("ArrowUp");
      assert(readEditorValue(controller.ref.current!) === "alpha", "ArrowUp did not walk to the older entry");
      await press("ArrowDown");
      assert(readEditorValue(controller.ref.current!) === "beta", "ArrowDown did not walk forward");
      await press("ArrowDown");
      assert(readEditorValue(controller.ref.current!) === "", "ArrowDown past newest did not clear the draft");

      const fileReference = createFileReference(
        "/scratch/paste-a/history.txt",
        "history.txt",
        "paste-a",
        { kind: "file", token: "\uE050" },
      );
      const attachedText = `inspect \uE050`;
      await send(attachedText, [fileReference]);
      await press("ArrowUp");
      assert(
        controller.fileReferences.some((reference) => reference.path === fileReference.path) &&
          controller.ref.current!.querySelector(".composer-reference")?.textContent === "@history.txt",
        "history recall did not restore and render the file attachment reference",
      );

      render("paste-b");
      await frame();
      await press("ArrowUp");
      assert(readEditorValue(controller.ref.current!) === "", "session B recalled session A history");
      await send("beta");
      await press("ArrowUp");
      assert(readEditorValue(controller.ref.current!) === "beta", "session B did not recall its own entry");
      render("paste-a");
      await frame();
      flushSync(() => controller.applyEditorDraft("", [], 0));
      await frame();
      await press("ArrowUp");
      assert(
        controller.fileReferences.some((reference) => reference.path === fileReference.path),
        "returning to session A did not restore its attached history entry",
      );

      render("");
      await frame();
      await press("ArrowUp");
      assert(readEditorValue(controller.ref.current!) === "", "the empty home composer recalled another session");
      const homeText = "first home prompt";
      flushSync(() => controller.applyEditorDraft(homeText, [], homeText.length));
      await frame();
      await frame();
      let signalStarted!: () => void;
      let releaseSend!: () => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
      const originalPrompt = api.prompt;
      let queueState = {
        activeSessionId: null,
        pendingPlans: {},
        runningSessions: {},
        sessions: [{ id: "history-created-session" }],
        messages: [],
        latestTurnResults: {},
        sessionOutcomes: {},
        isRunning: false,
      } as unknown as AppState;
      const queueRuntime = {
        beginNavigationIntent: () => 1,
        submittedComposerDrafts: new Map(),
        sessionTranscriptCache: new Map(),
        insertOptimisticUserMessage: () => {},
        retractOptimisticUserMessage: () => {},
      } as unknown as SessionRuntime;
      const queueSlice = createQueueSlice({
        get: () => queueState,
        set: (update) => {
          const next = typeof update === "function" ? update(queueState) : update;
          queueState = { ...queueState, ...next };
        },
        runtime: queueRuntime,
        promptAttachmentsFromDraft: () => [],
        withoutRecordKey: (record, key) => {
          const next = { ...record };
          delete next[key];
          return next;
        },
        viewingSessionIdForPrompt: () => null,
        messageErrorFromUnknown: () => { throw new Error("unexpected prompt failure"); },
        assistantErrorMessage: () => { throw new Error("unexpected prompt failure"); },
        materializeDraftSession: async () => "history-created-session",
      });
      historySendPrompt = queueSlice.sendPrompt;
      api.prompt = async (input) => {
        assert(input.sessionId === "history-created-session", "prompt used the wrong materialized session");
        signalStarted();
        await sendGate;
        queueState = { ...queueState, activeSessionId: "paste-b" };
        useAppStore.setState({ activeSessionId: "paste-b" });
      };
      try {
        await press("Enter");
        await started;
        const homeSubmission = latestSubmission;
        render("paste-b");
        releaseSend();
        await homeSubmission;
      } finally {
        api.prompt = originalPrompt;
      }
      render("history-created-session");
      await frame();
      await press("ArrowUp");
      assert(
        readEditorValue(controller.ref.current!) === "first home prompt",
        "home's first prompt was not recorded under its materialized session after navigation",
      );
      return {
        ok: true,
        arrowNavigation: true,
        sessionIsolation: true,
        renderedAttachmentRecall: true,
        homeSessionSwitchDuringSend: true,
      };
    }

    render("paste-a");
    await frame();
    await press("ArrowUp");
    const recalledText = readEditorValue(controller.ref.current!);
    assert(
      controller.fileReferences.some((reference) => reference.name === "history.txt") &&
        controller.ref.current!.querySelector(".composer-reference")?.textContent === "@history.txt",
      "attachment history did not survive the Electron process restart",
    );
    assert(recalledText === "inspect \uE050", "the latest attached prompt changed after restart");
    render("history-created-session");
    await frame();
    await press("ArrowUp");
    assert(
      readEditorValue(controller.ref.current!) === "first home prompt",
      "the Home-created session history did not survive the Electron process restart",
    );
    return {
      ok: true,
      processRestartPersistence: true,
      attachmentPersistence: true,
      materializedHomeSessionPersistence: true,
    };
  } finally {
    historySendPrompt = async () => false;
    flushSync(() => root.unmount());
    host.remove();
    resetComposerDraftCache();
  }
};

/**
 * Inline reference tokens: the draft paints every committed attachment as
 * `@name` text, one atomic token to the caret, selection, deletion and
 * clipboard, while a plain typed `@…` stays ordinary editable text.
 *
 * The pointer cases send real CDP mouse input through the Electron debugger,
 * and the keyboard cases send real Electron key events, so the browser's own
 * selection and editing behavior is what the assertions see.
 */
globalThis.composerReferenceTokenProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
  const frame = () => new Promise(requestAnimationFrame);
  const settle = async () => {
    await frame();
    await frame();
  };
  const assertClean = () => {
    assert(errors.length === 0, `React failed: ${errors.map(String).join("; ")}`);
  };
  let key = 0;
  const sessionId = "token-a";
  const render = () => {
    useAppStore.setState({ activeSessionId: sessionId, workPanelOpen: false, workspace: null });
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Fixture key={(key += 1)} sessionId={sessionId} t={i18n.t} workspacePath="" />
        </I18nextProvider>,
      ),
    );
    assertClean();
  };
  const draftInto = async (text: string, references: ComposerFileReference[], caret = text.length) => {
    flushSync(() => controller.applyEditorDraft(text, references, caret));
    await settle();
    assertClean();
  };
  const editor = () => controller.ref.current!;
  const tokens = () => Array.from(editor().querySelectorAll<HTMLElement>(".composer-reference"));
  const tokenFor = (token: string) =>
    editor().querySelector<HTMLElement>(`.composer-reference[data-token="${token}"]`);
  const draft = () => readEditorValue(editor());
  // A host text node keeps an invisible zero-width caret mark next to a token;
  // the browser's selection text includes it, while the user, the clipboard,
  // and the draft never see it.
  const selected = () => (window.getSelection()?.toString() ?? "").replaceAll("\u200B", "");
  const caret = () => editorSelectionRange(editor());
  const pointer = async (input: { type: "mousePressed" | "mouseMoved" | "mouseReleased"; x: number; y: number }) => {
    await globalThis.composerPreviewPointer(input);
    await settle();
  };
  const press = async (payload: string | { key: string; modifiers?: string[]; text?: string }) => {
    await globalThis.composerPreviewPressKey(payload);
    await settle();
  };
  const clickAt = async ({ x, y }: { x: number; y: number }) => {
    await pointer({ type: "mousePressed", x, y });
    await pointer({ type: "mouseReleased", x, y });
  };
  const dragFromTo = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await globalThis.composerPreviewDrag({ from, to });
    await settle();
  };
  /** Midpoint of one character cell, so a press lands inside real text. */
  const nodeCharPoint = (node: Node, index: number) => {
    const length = (node.nodeValue ?? "").length;
    const size = Math.max(1, length);
    const range = document.createRange();
    const start = Math.max(0, Math.min(index, size - 1));
    range.setStart(node, start);
    range.setEnd(node, Math.min(length, start + 1));
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const charPoint = (element: HTMLElement, index: number) => nodeCharPoint(element.firstChild!, index);
  const selectToken = (token: string) => {
    const element = tokenFor(token)!;
    const range = document.createRange();
    range.selectNode(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const clipboard = (type: "copy" | "cut" | "paste") => {
    const data = new DataTransfer();
    const event = new ClipboardEvent(type, {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    flushSync(() => editor().dispatchEvent(event));
    return { event, plain: data.getData("text/plain"), structured: data.getData(COMPOSER_CLIPBOARD_MIME) };
  };
  const reference = (
    path: string,
    name: string,
    kind: "file" | "image" | "session",
    token: string,
    mimeType?: string,
  ) => createFileReference(path, name, sessionId, { kind, token, ...(mimeType ? { mimeType } : {}) });
  try {
    resetComposerDraftCache();
    render();
    await settle();

    // 1. Every committed reference is exactly `@name` text: no icon, capsule,
    //    remove control, or separate focus target inside the draft.
    const text = "inspect \uE101";
    await draftInto(text, [reference("/scratch/token-a/notes.txt", "notes.txt", "file", "\uE101", "text/plain")]);
    const textToken = tokenFor("\uE101")!;
    assert(tokens().length === 1, "a committed file reference must paint one inline token");
    assert(textToken.textContent === "@notes.txt",
      `the visible label must be exactly the filename: ${JSON.stringify(textToken.textContent)}`);
    // The host text keeps an invisible zero-width mark that gives the browser
    // a real caret position next to a token; it is not draft text and must not
    // reach the draft, the clipboard, or a submission.
    assert(
      editor().textContent?.replaceAll("\u200B", "") === "inspect @notes.txt",
      "the token label is real draft text",
    );
    assert(textToken.getAttribute("title") === "/scratch/token-a/notes.txt",
      "the full reference stays in the tooltip");
    assert(!textToken.querySelector("svg") && !textToken.querySelector("button"),
      "a reference token must not paint an icon or a remove button");
    assert(editor().querySelectorAll("svg, button, .composer-chip-icon, .composer-chip-remove").length === 0,
      "the draft must not paint chip chrome inside the editable");
    const tokenStyle = getComputedStyle(textToken);
    assert(tokenStyle.backgroundColor === "rgba(0, 0, 0, 0)",
      `a reference token must have no capsule background: ${tokenStyle.backgroundColor}`);
    assert(tokenStyle.borderRadius === "0px" || tokenStyle.borderRadius === "",
      `a reference token must have no capsule radius: ${tokenStyle.borderRadius}`);
    assert(tokenStyle.userSelect !== "none",
      "a reference token must stay selectable text");
    assert(tokenStyle.textDecorationLine.includes("underline"),
      "a reference token reads as link-style text");
    // A typed `@…` is not a committed attachment: it stays ordinary text.
    await draftInto("@notes.txt is just text", []);
    assert(tokens().length === 0 && draft() === "@notes.txt is just text",
      "typed @text must stay editable text instead of becoming a token");
    await draftInto("@src/main", []);
    assert(tokens().length === 0, "an incomplete @ trigger must not become a token");

    // 2. Untruncated labels: a long name wraps inside the editor width and still
    //    reads whole, with no ellipsis and no full path in the body.
    const longName = `${"a".repeat(200)}.png`;
    const longPath = `/scratch/token-a/${longName}`;
    await draftInto("", [reference(longPath, longName, "image", "\uE10A", "image/png")]);
    const longToken = tokenFor("\uE10A")!;
    assert(longToken.textContent === `@${longName}`, "a long label must render untruncated");
    assert(getComputedStyle(longToken).textOverflow === "clip",
      "a reference label must not ellipsize");
    assert(longToken.getClientRects().length > 1, "a long label must wrap instead of overflowing");
    assert(longToken.scrollWidth <= longToken.clientWidth + 1,
      `a wrapped label must not overflow horizontally: ${longToken.scrollWidth}/${longToken.clientWidth}`);
    assert(!editor().textContent!.includes("/scratch/token-a/"),
      "the draft body must not show the full reference path");
    assert(longToken.getAttribute("title") === longPath, "the wrapped label keeps its full path tooltip");

    // 3. The caret never sits inside a label; clicking into the text snaps to a
    //    boundary, and typing there never edits the label.
    const notesText = "see \uE102 now";
    await draftInto(notesText, [reference("/scratch/token-a/image.png", "image.png", "image", "\uE102", "image/png")]);
    const imageToken = tokenFor("\uE102")!;
    const imageStart = draft().indexOf("\uE102");
    assert(imageStart === 4, `unexpected token index ${imageStart}`);
    const insideLabel = document.createRange();
    const labelNode = imageToken.firstChild!;
    insideLabel.setStart(labelNode, 3);
    insideLabel.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(insideLabel);
    await settle();
    assert(!imageToken.contains(window.getSelection()!.anchorNode),
      "a caret inside a label must snap out of the token");
    const snappedCaret = caret();
    assert(
      snappedCaret.start === imageStart || snappedCaret.start === imageStart + 1,
      `the snapped caret must sit on a token boundary: ${JSON.stringify(snappedCaret)}`,
    );
    await press({ key: "x", text: "x" });
    assert(tokenFor("\uE102")?.textContent === "@image.png",
      `typing next to a token must never edit its label: ${JSON.stringify(tokenFor("\uE102")?.textContent)}`);
    assert(draft() === "see x\uE102 now" || draft() === "see \uE102x now",
      `typing must stay outside the token: ${JSON.stringify(draft())}`);

    // 4. Backspace/Delete step over the token as one character, and native undo
    //    restores both the token and its reference metadata.
    await draftInto(notesText, [reference("/scratch/token-a/image.png", "image.png", "image", "\uE102", "image/png")]);
    setEditorCaret(editor(), imageStart + 1);
    await settle();
    await press("Backspace");
    assert(draft() === "see  now",
      `Backspace after a token must remove the whole token: ${JSON.stringify(draft())}`);
    assert(controller.fileReferences.length === 0,
      "deleting the token must drop its reference metadata");
    document.execCommand("undo");
    await settle();
    assert(tokenFor("\uE102") && draft() === notesText,
      "undo must restore the token text in place");
    assert(controller.fileReferences.some((item) => item.token === "\uE102"),
      "undo must restore the reference metadata");
    setEditorCaret(editor(), imageStart);
    await settle();
    await press("Delete");
    assert(draft() === "see  now",
      `Delete before a token must remove the whole token: ${JSON.stringify(draft())}`);
    document.execCommand("undo");
    await settle();
    assert(tokenFor("\uE102") && draft() === notesText,
      "undo must restore a forward-deleted token");

    // 5. Arrow keys and Shift+Arrow treat the token as one character.
    setEditorCaret(editor(), imageStart + 1);
    await settle();
    await press("ArrowLeft");
    assert(caret().start === imageStart && caret().start === caret().end,
      `ArrowLeft after a token must land before it: ${JSON.stringify(caret())}`);
    await press("ArrowRight");
    assert(caret().start === imageStart + 1,
      `ArrowRight before a token must land after it: ${JSON.stringify(caret())}`);
    setEditorCaret(editor(), imageStart + 1);
    await settle();
    await press({ key: "ArrowLeft", modifiers: ["shift"] });
    assert(
      caret().start === imageStart && caret().end === imageStart + 1,
      `Shift+ArrowLeft must select the whole token: ${JSON.stringify(caret())}`,
    );
    // The selection's own text carries the invisible caret mark that keeps the
    // browser outside the token; the highlight covers the whole label, and the
    // mark never reaches the clipboard or a submission.
    assert(selected() === "@image.png",
      `the visible highlight must cover the whole label: ${JSON.stringify(selected())}`);
    setEditorCaret(editor(), imageStart);
    await settle();
    await press({ key: "ArrowRight", modifiers: ["shift"] });
    assert(caret().start === imageStart && caret().end === imageStart + 1,
      "Shift+ArrowRight must select the whole token");

    // 6. A click runs the reference's own action; a drag doesn't.
    await draftInto("see \uE102 now", [reference("/scratch/token-a/image.png", "image.png", "image", "\uE102", "image/png")]);
    const dialog = () => document.querySelector<HTMLDialogElement>("dialog.composer-image-preview[open]");
    await clickAt(charPoint(tokenFor("\uE102")!, 4));
    await settle();
    assert(dialog(), "a click on an image reference must open its preview");
    assert(controller.imagePreview.preview, "the click must use the existing preview action");
    assert(draft() === "see \uE102 now", "opening a preview must not change the draft");
    controller.imagePreview.close();
    await settle();

    // 7. Real pointer drags starting on the token select it whole and never
    //    preview it: from its leading edge, its trailing edge, inside it, and
    //    across adjacent tokens.
    // Press on real glyphs: a press past the last glyph only places a caret, so
    // Chromium would not start a text selection drag from there. The release
    // stays inside the editable, or the drag is discarded instead of extended.
    const labelLength = "@image.png".length;
    const leading = charPoint(tokenFor("\uE102")!, 0);
    const trailing = charPoint(tokenFor("\uE102")!, labelLength - 1);
    const afterToken = nodeCharPoint(editor().lastChild!, 1);
    const beforeToken = nodeCharPoint(editor().firstChild!, 1);
    await dragFromTo(leading, afterToken);
    const afterLeadingDrag = caret();
    assert(afterLeadingDrag.start === imageStart && afterLeadingDrag.end >= imageStart + 1,
      `a drag from the leading edge must select the whole token: ${JSON.stringify(afterLeadingDrag)}`);
    assert(selected().startsWith("@image.png"),
      `the drag highlight must start with the whole label: ${JSON.stringify(selected())}`);
    assert(!dialog() && !controller.imagePreview.preview,
      "a selection drag must not open the preview");
    // A press inside the previous selection would start a drag of it instead of
    // a new selection, so each drag begins from a plain collapsed caret.
    setEditorCaret(editor(), imageStart + 1);
    await settle();
    await dragFromTo(trailing, beforeToken);
    const afterTrailingDrag = caret();
    assert(afterTrailingDrag.start <= imageStart && afterTrailingDrag.end >= imageStart + 1,
      `a drag from the trailing edge must cover the whole token: ${JSON.stringify(afterTrailingDrag)}`);
    assert(!dialog() && !controller.imagePreview.preview,
      "a backward selection drag must not open the preview");

    // Block-only: drag inside the token selects it whole.
    await draftInto("\uE102", [reference("/scratch/token-a/image.png", "image.png", "image", "\uE102", "image/png")]);
    const onlyRect = tokenFor("\uE102")!.getBoundingClientRect();
    await dragFromTo(
      { x: onlyRect.left + onlyRect.width * 0.55, y: onlyRect.top + onlyRect.height / 2 },
      { x: onlyRect.right - 2, y: onlyRect.top + onlyRect.height / 2 },
    );
    assert(caret().start === 0 && caret().end === 1,
      `a drag inside the only token must select it whole: ${JSON.stringify(caret())}`);
    assert(selected() === "@image.png",
      `the whole-label highlight must be visible: ${JSON.stringify(selected())}`);
    const dragSelection = window.getSelection()!;
    assert(!tokenFor("\uE102")!.contains(dragSelection.anchorNode),
      "the selection must start at the token boundary, not inside its label");
    assert(!dialog() && !controller.imagePreview.preview, "dragging inside a token must not preview");

    // Adjacent blocks: a drag from one token into the next covers both whole.
    await draftInto("\uE102\uE103", [
      reference("/scratch/token-a/image.png", "image.png", "image", "\uE102", "image/png"),
      reference("/scratch/token-a/second.png", "second.png", "image", "\uE103", "image/png"),
    ]);
    const first = tokenFor("\uE102")!.getBoundingClientRect();
    const second = tokenFor("\uE103")!.getBoundingClientRect();
    await dragFromTo(
      { x: first.left + first.width * 0.5, y: first.top + first.height / 2 },
      { x: second.left + second.width * 0.5, y: second.top + second.height / 2 },
    );
    assert(caret().start === 0 && caret().end === 2,
      `a drag across adjacent tokens must cover both whole: ${JSON.stringify(caret())}`);
    assert(selected() === "@image.png@second.png",
      `both labels must be visibly selected: ${JSON.stringify(selected())}`);
    assert(!dialog() && !controller.imagePreview.preview, "dragging across tokens must not preview");

    // 8. Copy and cut describe the whole reference, never a label fragment.
    await draftInto("see \uE102 now", [reference("/scratch/token-a/image.png", "image.png", "image", "\uE102", "image/png")]);
    const partial = document.createRange();
    const partialNode = tokenFor("\uE102")!.firstChild!;
    partial.setStart(partialNode, 4);
    partial.setEnd(editor(), editor().childNodes.length);
    const partialSelection = window.getSelection()!;
    partialSelection.removeAllRanges();
    partialSelection.addRange(partial);
    await settle();
    const expanded = caret();
    assert(expanded.start === imageStart && expanded.end > imageStart,
      `a partial token selection must expand to the whole token: ${JSON.stringify(expanded)}`);
    selectToken("\uE102");
    await settle();
    const copied = clipboard("copy");
    assert(copied.event.defaultPrevented, "copying a token must be composed by the composer");
    assert(copied.plain === "@/scratch/token-a/image.png",
      `an external copy must carry the full reference: ${JSON.stringify(copied.plain)}`);
    assert(copied.structured.includes("/scratch/token-a/image.png"),
      "the internal clipboard payload must carry the complete reference");
    assert(copied.structured.includes("@image.png") === false,
      "the internal payload must not reduce a reference to its label");
    const cutCopy = clipboard("cut");
    assert(cutCopy.event.defaultPrevented, "cutting a token must be composed by the composer");
    await settle();
    assert(draft() === "see  now",
      `cutting must remove the whole token: ${JSON.stringify(draft())}`);
    assert(controller.fileReferences.length === 0, "cutting the token drops its reference");
    document.execCommand("undo");
    await settle();
    assert(tokenFor("\uE102") && draft() === "see \uE102 now",
      "undo must restore the cut token");

    // 9. Plugin marks and conversation references keep one token path too.
    await draftInto("mark \uE104", [
      createFileReference("plugin-mark", "Mark label", sessionId, {
        token: "\uE104",
        plugin: { kind: "mark", pluginId: "demo.plugin", send: "plugin text" },
      }),
    ]);
    const markToken = tokenFor("\uE104")!;
    assert(markToken.textContent === "Mark label",
      `a plugin mark keeps the label it was given: ${JSON.stringify(markToken.textContent)}`);
    assert(markToken.getAttribute("data-plugin-mark") === "mark", "a plugin mark stays identifiable");
    assert(!markToken.getAttribute("data-action"), "a plugin mark has no activation");
    await draftInto("open \uE105", [
      reference("session-fixture-abc", "Session · fixture", "session", "\uE105"),
    ]);
    const sessionToken = tokenFor("\uE105")!;
    assert(sessionToken.textContent === "@Session · fixture",
      `a conversation reference reads @label: ${JSON.stringify(sessionToken.textContent)}`);
    assert(sessionToken.getAttribute("data-session-id") === "session-fixture-abc",
      "the conversation reference keeps its target");
    return {
      ok: true,
      visibleLabelText: true,
      noChipChrome: true,
      untruncatedWrapping: true,
      caretAtomic: true,
      deletionAndUndo: true,
      arrowTokenSteps: true,
      pointerClickActivation: true,
      dragSelectsWholeToken: true,
      adjacentTokens: true,
      clipboardWholeReference: true,
      pluginAndSessionTokens: true,
    };
  } catch (error) {
    return { ok: false, error: String(error), stack: (error as Error)?.stack };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    resetComposerDraftCache();
  }
};
