import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { UiMessage, SessionDetail } from "@pi-desktop/shared";
import { en } from "@pi-desktop/i18n";
import { MessageRow } from "../../apps/desktop/src/features/chat/transcript/MessageRow";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import { readEditorValue, setEditorSelection } from "../../apps/desktop/src/features/chat/composer/editor";
import {
  deleteComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from "../../apps/desktop/src/lib/composer-draft-cache";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=";

/** The chip editor of an open message edit; null while hydration is pending. */
function editInput(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".message-edit .composer-input");
}
function editChips(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".message-edit .composer-reference")];
}
/** Append text at the editor end through the native path, like real typing. */
function typeAtEditEnd(host: HTMLElement, value: string) {
  const editor = editInput(host);
  assert(editor, "no open message editor to type into");
  editor.focus();
  const selection = window.getSelection();
  assert(selection, "no selection to type with");
  selection.selectAllChildren(editor);
  selection.collapseToEnd();
  assert(document.execCommand("insertText", false, value), "insertText at editor end failed");
}

/** Enter from the actual Edit control; replace only the Host and prompt APIs. */
export async function transcriptEditProbe() {
  const initial = useAppStore.getState();
  const originalRead = api.getSession;
  const originalPrompt = api.prompt;
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sessionId = "full-edit-fixture";
  const full: UiMessage = {
    id: "long-log", role: "user", createdAt: "2026-09-23T00:00:00Z",
    content: "INFO normal request\n".repeat(4000) + "FATAL payment timeout",
    attachments: [{ ref: "/fixture/screenshot.png", name: "screenshot.png", kind: "image", mimeType: "image/png" }],
  };
  // Independent slash fixture: the stored content is the expanded template
  // body while `command` is the original typed invocation. The long log
  // above stays a non-command message so its canonical full content is what
  // the editor must preserve.
  const slash: UiMessage = {
    id: "slash-turn", role: "user", createdAt: "2026-09-23T00:00:00Z",
    content: "Expanded template body for payment logs.",
    command: "/review logs",
  };
  const session: SessionDetail = {
    id: sessionId, title: "Log review", source: "pi-native", mode: "agent",
    permissionMode: "ask", thinkingLevel: "off", messageCount: 1,
    createdAt: full.createdAt, updatedAt: full.createdAt, messages: [full],
  };
  function Row() {
    const message = useAppStore((s) => s.messages[0]);
    return message ? <MessageRow message={message} isRunning={false} /> : null;
  }
  const sent: Parameters<typeof api.prompt>[0][] = [];
  const toasts: string[] = [];
  api.prompt = async (input) => { sent.push(input); return { accepted: true }; };
  try {
    for (const scenario of ["long", "slash", "read-failure", "switch", "round-trip"] as const) {
      const canonical = scenario === "slash" ? slash : full;
      let finish!: () => void;
      const readGate = new Promise<void>((resolve) => { finish = resolve; });
      api.getSession = async () => {
        await readGate;
        if (scenario === "read-failure") throw new Error("fixture read failed");
        return { session: { ...session, messages: [canonical] } };
      };
      flushSync(() => useAppStore.setState({
        activeSessionId: sessionId, selectingSessionId: null, isRunning: false,
        messages: [{
          ...canonical,
          // The long log is display-limited; the short slash turn shows whole.
          content: scenario === "slash"
            ? canonical.content
            : `${full.content.slice(0, 65500)}[truncated for display]`,
        }],
        sessionHistory: { [sessionId]: { messageStart: 0, hasMoreBefore: false, contentLimited: true } },
        pendingPlans: {}, showToast: (message) => { toasts.push(String(message)); },
      }));
      flushSync(() => root.render(<I18nextProvider i18n={i18n}><SlotSessionProvider sessionId={sessionId}><Row key={scenario} /></SlotSessionProvider></I18nextProvider>));
      host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
      await painted();
      assert(!editInput(host), "Edit must wait for full text instead of exposing clipped display text");
      if (scenario === "switch") flushSync(() => useAppStore.setState({ activeSessionId: "other-chat" }));
      const originalMessages = useAppStore.getState().messages;
      if (scenario === "round-trip") flushSync(() => {
        // Retained panes can return with the exact same message-array identity.
        useAppStore.setState({ activeSessionId: "other-chat" });
        useAppStore.setState({ activeSessionId: sessionId, messages: originalMessages });
      });
      finish();
      await painted();
      await painted();
      if (scenario === "round-trip") {
        assert(!editInput(host), "A→B→A must invalidate the pending edit even when the message array is unchanged");
        assert(useAppStore.getState().messages === originalMessages, "cancelled edit must not publish stale history");
        host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
        await painted();
        await painted();
      }
      if (scenario === "read-failure" || scenario === "switch") {
        assert(!editInput(host), `${scenario}: stale or failed read must not open an editor`);
        continue;
      }
      const draft = readEditorValue(editInput(host)!);
      if (scenario === "slash") {
        // Baseline slash contract: the draft seeds the original typed
        // invocation alone, so an unchanged retry re-expands the template.
        assert(draft === "/review logs",
          "slash: editor must seed the typed invocation, not the stored expansion");
        host.querySelector<HTMLButtonElement>(".message-edit-submit")!.click();
        await painted();
        await painted();
        const request = sent.at(-1);
        assert(request?.content === "/review logs" &&
          request.truncateFromMessageId === slash.id,
          "slash: unchanged retry must resend the invocation for re-expansion");
        continue;
      }
      const expected = canonical.content;
      assert(draft.startsWith(expected),
        `${scenario}: editor must contain canonical text, not clipped display text`);
      assert(draft.includes("FATAL payment timeout"),
        `${scenario}: editor must carry the final log lines, not clipped display text`);
      // The existing attachment is an explicit inline chip, not hidden state.
      const chips = editChips(host);
      assert(chips.length === 1 && chips[0].textContent === "@screenshot.png",
        `${scenario}: the existing attachment must render as one inline chip`);
      typeAtEditEnd(host, "\nPlease focus on payment failures.");
      host.querySelector<HTMLButtonElement>(".message-edit-submit")!.click();
      await painted();
      await painted();
      const request = sent.at(-1);
      assert(request?.content.startsWith(expected) &&
        request.content.includes("Please focus on payment failures.") &&
        request.truncateFromMessageId === canonical.id,
        `${scenario}: resend must preserve the complete edited content`);
      assert(request.attachments?.[0]?.path === full.attachments?.[0]?.ref,
        "editing must preserve image attachments");
    }
    assert(toasts.includes("fixture read failed"), "failed hydration must remain visible");
    return { fullTextAndResend: true, slashSeed: true, failedRead: true, sessionSwitch: true, roundTripNavigation: true };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    api.getSession = originalRead;
    api.prompt = originalPrompt;
    useAppStore.setState(initial, true);
  }
}

const INLINE_PATH = "/fixture/pasted/inline-a.png";
const INLINE_MARKER = `@${INLINE_PATH}`;
/** The content-addressed ref main stores for those bytes, never the source path. */
const INLINE_BLOB = `attachments/${"a".repeat(64)}`;

/** A durable user row after main prepared an image the draft named inline. */
const inlineDurableRow = (): UiMessage => ({
  id: "inline-durable",
  role: "user",
  createdAt: "2026-09-23T00:00:00Z",
  content: `compare ${INLINE_MARKER} with the rest`,
  attachments: [
    {
      kind: "image",
      name: "inline-a.png",
      ref: INLINE_BLOB,
      mimeType: "image/png",
      size: 70,
      inlinePath: INLINE_MARKER,
    },
  ],
});

/**
 * One image, one place, after the real Edit → resend control: the row main
 * persisted names the user's `@path` while its attachment keeps the stored blob,
 * so the resend has to carry the recorded placement rather than re-derive it
 * from the ref. Also covers an edit that removes the marker, an attachment that
 * never had a placement, and an assistant retry of the same turn.
 */
export async function inlineAttachmentResendProbe() {
  const initial = useAppStore.getState();
  const originalRead = api.getSession;
  const originalPrompt = api.prompt;
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sessionId = "inline-resend-fixture";
  const sent: Parameters<typeof api.prompt>[0][] = [];
  const toasts: string[] = [];
  function Row() {
    const message = useAppStore((s) => s.messages[0]);
    return message ? <MessageRow message={message} isRunning={false} /> : null;
  }
  // Inline chips are direct children of the prose run; a trailing attachment
  // lives in its own list inside the same bubble.
  const inlineChips = () =>
    host.querySelectorAll(".message-user-text > .message-attachment-image-chip");
  const trailingChips = () =>
    host.querySelectorAll(".message-attachments .message-attachment-image-chip");
  const trailingList = () => host.querySelector(".message-attachments");
  const flat = (element: Element | null) =>
    (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const prose = () => flat(host.querySelector(".message-user-text"));
  const paintRow = (messages: UiMessage[]) => {
    flushSync(() => useAppStore.setState({
      activeSessionId: sessionId, selectingSessionId: null, isRunning: false,
      messages, pendingPlans: {}, sessionHistory: {},
      showToast: (message) => { toasts.push(String(message)); },
    }));
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><SlotSessionProvider sessionId={sessionId}><Row /></SlotSessionProvider></I18nextProvider>));
  };
  /**
   * Enter from the real Edit control; replace only the prompt API. The leading
   * and trailing prose are replaced around the surviving chip through the
   * draft's own offsets: a replacement range ending exactly on the chip's
   * leading edge canonicalizes into its label in Chromium, so each replaced
   * span stops one space short of the chip ("compare" / "with the rest",
   * keeping the shared spaces). The resend contract under test — edited
   * prose around a surviving chip with its recorded placement — is unchanged.
   */
  const editAndResend = async (before: string, after: string) => {
    host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
    await painted();
    const editor = editInput(host);
    assert(editor, "message edit did not open");
    const chip = editor.querySelector(".composer-reference");
    assert(chip, "existing attachment did not hydrate into a chip");
    editor.focus();
    const tokenIndex = readEditorValue(editor).search(/[\ue000-\uf8ff]/);
    assert(tokenIndex > 0, "chip token is missing from the edit value");
    setEditorSelection(editor, 0, tokenIndex - 1);
    assert(document.execCommand("insertText", false, before.trimEnd()), "leading edit failed");
    const placed = readEditorValue(editor).search(/[\ue000-\uf8ff]/);
    assert(placed === before.trimEnd().length + 1, `leading edit landed at ${placed}`);
    const value = readEditorValue(editor);
    setEditorSelection(editor, placed + 2, value.length);
    assert(document.execCommand("insertText", false, after.trimStart()), "trailing edit failed");
    host.querySelector<HTMLButtonElement>(".message-edit-submit")!.click();
    await painted();
    await painted();
    return sent.at(-1)!;
  };
  /** Delete one chip the way Backspace does: the reference leaves with it. */
  const removeChip = (label: string) => {
    const editor = editInput(host);
    assert(editor, "message edit did not open");
    const chip = editChips(host).find((candidate) => candidate.textContent === label);
    assert(chip, `chip ${label} is missing`);
    const token = chip.getAttribute("data-token") ?? "";
    const index = token ? readEditorValue(editor).indexOf(token) : -1;
    assert(index >= 0, `chip ${label} has no token in the edit value`);
    setEditorSelection(editor, index, index + 1);
    assert(document.execCommand("delete"), `deleting chip ${label} failed`);
  };
  api.prompt = async (input) => { sent.push(input); return { accepted: true }; };
  api.getSession = async () => ({ session: { ...durableFixture(sessionId), messages: [inlineDurableRow()] } });
  try {
    // The durable row already renders the image where the user typed it.
    paintRow([inlineDurableRow()]);
    assert(inlineChips().length === 1 && !trailingList(),
      `durable row: ${inlineChips().length} inline / ${trailingChips().length} trailing`);
    assert(prose() === "compare inline-a.png with the rest",
      `durable row kept its position: ${prose()}`);

    // Edit and resend, keeping the marker at a new place in the sentence.
    paintRow([inlineDurableRow()]);
    const request = await editAndResend("Actually ", " matters more than the log.");
    assert(request.content === `Actually ${INLINE_MARKER} matters more than the log.`,
      `the resend carries the edited text: ${request.content}`);
    assert(request.attachments?.length === 1, "the attached image travels with the edit");
    assert(request.attachments?.[0]?.path === INLINE_BLOB,
      `the stored blob keeps identifying the image: ${request.attachments?.[0]?.path}`);
    assert(request.attachments?.[0]?.inlinePath === INLINE_MARKER,
      `the recorded placement travels with the resend: ${request.attachments?.[0]?.inlinePath}`);
    assert(inlineChips().length === 1 && !trailingList(),
      `edit-resend: ${inlineChips().length} inline / ${trailingChips().length} trailing`);
    assert(prose() === "Actually inline-a.png matters more than the log.",
      `edit-resend kept one image at its new position: ${prose()}`);

    // Deleting the chip removes the attachment on resend; nothing trails behind.
    paintRow([inlineDurableRow()]);
    host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
    await painted();
    removeChip("@inline-a.png");
    assert(editChips(host).length === 0, "the deleted chip leaves the editor");
    host.querySelector<HTMLButtonElement>(".message-edit-submit")!.click();
    await painted();
    await painted();
    const removed = sent.at(-1)!;
    assert(removed.attachments?.length === 0, "a deleted chip removes its attachment");
    assert(!removed.content.includes(INLINE_PATH), `the removed marker leaves no path text: ${removed.content}`);

    // An attachment that never had a placement keeps today's trailing position.
    paintRow([{
      ...inlineDurableRow(),
      content: "look at the log",
      attachments: [{ kind: "image", name: "inline-a.png", ref: INLINE_BLOB, mimeType: "image/png" }],
    }]);
    assert(inlineChips().length === 0 && trailingChips().length === 1,
      `unplaced attachment: ${inlineChips().length} inline / ${trailingChips().length} trailing`);

    // A direct retry of the assistant answer replays the same user turn.
    paintRow([
      inlineDurableRow(),
      {
        id: "inline-answer", role: "assistant", status: "complete",
        createdAt: "2026-09-23T00:00:01Z", content: "A log line",
      },
    ]);
    await useAppStore.getState().retryAssistantMessage("inline-answer");
    await painted();
    await painted();
    const retried = sent.at(-1)!;
    assert(retried.content === inlineDurableRow().content, "the retry replays the user prompt");
    assert(retried.attachments?.[0]?.inlinePath === INLINE_MARKER,
      `the retry carries the recorded placement: ${retried.attachments?.[0]?.inlinePath}`);
    assert(inlineChips().length === 1 && !trailingList(),
      `assistant retry: ${inlineChips().length} inline / ${trailingChips().length} trailing`);
    return { durablePlacement: true, editResend: true, chipRemoved: true, unplacedTrailing: true, assistantRetry: true };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    api.getSession = originalRead;
    api.prompt = originalPrompt;
    useAppStore.setState(initial, true);
  }
}

/** Minimal session detail the probe's read stub answers with. */
const durableFixture = (sessionId: string): Omit<SessionDetail, "messages"> => ({
  id: sessionId, title: "Inline image", source: "pi-native", mode: "agent",
  permissionMode: "ask", thinkingLevel: "off", messageCount: 1,
  createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z",
});

/**
 * Shared editor surface: an existing message hydrates into main-composer
 * chips, a picked image joins through the shared intake, deleting a chip
 * drops its attachment on resend, cancelling restores the bubble without
 * touching the main composer draft, and a session switch during async staging
 * leaks nothing into the new conversation.
 */
export async function userMessageEditAttachmentsProbe() {
  const initial = useAppStore.getState();
  const originalPrompt = api.prompt;
  const originalRead = api.getSession;
  const originalPick = api.pickFiles;
  const originalImport = api.importFiles;
  const originalImage = api.fsReadImageDataUrl;
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sessionId = "edit-attachments-fixture";
  const row = (): UiMessage => ({
    id: "with-files", role: "user", createdAt: "2026-09-23T00:00:00Z",
    content: `compare ${INLINE_MARKER} with the rest`,
    attachments: [
      { kind: "image", name: "inline-a.png", ref: INLINE_BLOB, mimeType: "image/png", size: 70, inlinePath: INLINE_MARKER },
      { kind: "file", name: "notes.txt", ref: "/fixture/notes.txt", mimeType: "text/plain", size: 4 },
    ],
  });
  function Row() {
    const message = useAppStore((s) => s.messages[0]);
    return message ? <MessageRow message={message} isRunning={false} /> : null;
  }
  const sent: Parameters<typeof api.prompt>[0][] = [];
  api.prompt = async (input) => { sent.push(input); return { accepted: true }; };
  api.getSession = async () => ({
    session: { ...durableFixture(sessionId), messages: [row()] },
  });
  api.fsReadImageDataUrl = async () => ({ kind: "image", dataUrl: PNG_DATA_URL });
  const openEdit = async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
    await painted();
    await painted();
    assert(editInput(host), "message edit did not open");
  };
  const submitEdit = async () => {
    host.querySelector<HTMLButtonElement>(".message-edit-submit")!.click();
    await painted();
    await painted();
  };
  try {
    flushSync(() => useAppStore.setState({
      activeSessionId: sessionId, selectingSessionId: null, isRunning: false,
      messages: [row()], pendingPlans: {},
      showToast: () => undefined,
    }));
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><SlotSessionProvider sessionId={sessionId}><Row /></SlotSessionProvider></I18nextProvider>));

    // Existing attachments hydrate as main-composer chips: the inline image at
    // its position, the unplaced file as an explicit removable chip.
    await openEdit();
    assert(
      editChips(host).map((chip) => chip.textContent).join(" ") === "@inline-a.png @notes.txt",
      `existing attachments did not hydrate into chips: ${editChips(host).map((chip) => chip.textContent)}`,
    );
    assert(
      readEditorValue(editInput(host)!).includes(INLINE_BLOB) === false,
      "the editor must show the chip label, never the stored blob ref",
    );

    // An image chip opens the same modal preview the composer uses.
    const imageChip = editChips(host)[0];
    imageChip.focus();
    assert(document.activeElement === imageChip, "image chip did not take keyboard focus");
    imageChip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await painted();
    await painted();
    assert(
      document.body.querySelector(".composer-image-preview"),
      "activating an image chip did not open the preview",
    );
    document.body.querySelector<HTMLButtonElement>(".composer-image-preview [aria-label=\"Close\"]")!.click();
    await painted();

    // Picking a file stages it through the shared intake as a new chip.
    api.pickFiles = async () => ({ token: "probe-token" });
    api.importFiles = async () => ({
      files: [{ path: "/scratch/probe-new.png", name: "probe-new.png", kind: "image", mimeType: "image/png", size: 8 }],
    });
    host.querySelector<HTMLButtonElement>(`[aria-label="${en.chat.addFiles}"]`)!.click();
    await painted();
    await painted();
    assert(
      editChips(host).some((chip) => chip.textContent === "@probe-new.png"),
      "a picked file did not stage into the editor",
    );

    // Deleting a chip removes its attachment; the resend keeps the placed
    // image with its recorded placement plus the staged file.
    const notesChip = editChips(host).find((chip) => chip.textContent === "@notes.txt");
    assert(notesChip, "trailing file chip is missing");
    const notesToken = notesChip.getAttribute("data-token") ?? "";
    const notesIndex = notesToken ? readEditorValue(editInput(host)!).indexOf(notesToken) : -1;
    assert(notesIndex >= 0, "trailing chip has no token in the edit value");
    setEditorSelection(editInput(host)!, notesIndex, notesIndex + 1);
    assert(document.execCommand("delete"), "deleting the trailing chip failed");
    await submitEdit();
    const request = sent.at(-1)!;
    assert(
      request.content === `compare ${INLINE_MARKER} with the rest @/scratch/probe-new.png`,
      `resend content is wrong: ${request.content}`,
    );
    assert(
      request.attachments?.map((attachment) => attachment.path).join(" ") ===
        `${INLINE_BLOB} /scratch/probe-new.png`,
      `resend attachments are wrong: ${JSON.stringify(request.attachments)}`,
    );
    assert(
      request.attachments?.[0]?.inlinePath === INLINE_MARKER &&
        request.attachments?.[1]?.inlinePath === "@/scratch/probe-new.png",
      "resend placements are wrong",
    );

    // The stubbed prompt leaves an optimistic running turn behind; restore the
    // idle row before exercising cancel and session isolation.
    flushSync(() => useAppStore.setState({
      activeSessionId: sessionId, messages: [row()], isRunning: false,
      runningSessions: {},
    }));
    await painted();

    // Cancelling restores the bubble and sends nothing. The edit draft is
    // local, so a seeded main-composer draft for this session — text and
    // attachment row — must survive the edit untouched.
    writeComposerDraft(sessionId, {
      text: "main composer words",
      fileReferences: [
        { path: "/main/keep.png", name: "keep.png", kind: "image" as const },
      ],
    });
    await openEdit();
    typeAtEditEnd(host, " (do not send)");
    host.querySelector<HTMLButtonElement>(".message-edit-cancel")!.click();
    await painted();
    assert(!editInput(host), "cancel did not close the editor");
    assert(sent.length === 1, "cancel sent a prompt it must not send");
    const mainDraft = readComposerDraft(sessionId);
    assert(
      mainDraft?.text === "main composer words" &&
        mainDraft.fileReferences.length === 1 &&
        mainDraft.fileReferences[0]?.path === "/main/keep.png",
      `cancel altered the main composer draft: ${JSON.stringify(mainDraft)}`,
    );
    deleteComposerDraft(sessionId);

    // A session switch while a pick is in flight cancels the editor and drops
    // the staged files instead of leaking them into the new conversation.
    await openEdit();
    let releasePick!: (value: { token: string }) => void;
    api.pickFiles = () => new Promise((resolve) => { releasePick = resolve; });
    host.querySelector<HTMLButtonElement>(`[aria-label="${en.chat.addFiles}"]`)!.click();
    await painted();
    flushSync(() => useAppStore.setState({ activeSessionId: "other-chat" }));
    releasePick({ token: "late-token" });
    await painted();
    await painted();
    assert(!editInput(host), "a session switch during staging left the editor open");
    return { chipsHydrated: true, previewOpened: true, picked: true, chipRemoved: true, cancelled: true, switchIsolated: true };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    document.body.querySelector(".composer-image-preview")?.remove();
    api.prompt = originalPrompt;
    api.getSession = originalRead;
    api.pickFiles = originalPick;
    api.importFiles = originalImport;
    api.fsReadImageDataUrl = originalImage;
    useAppStore.setState(initial, true);
  }
}

/**
 * Real clipboard paste at the external edge: a DataTransfer carrying an image
 * file and an ordinary file lands in the edit surface as chips, removing one
 * chip narrows the current set, and the retry carries each surviving
 * attachment exactly once — without touching the main composer draft.
 */
export async function userMessageEditPasteProbe() {
  const initial = useAppStore.getState();
  const originalPrompt = api.prompt;
  const originalRead = api.getSession;
  const originalPaste = api.pasteFiles;
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sessionId = "edit-paste-fixture";
  const row = (): UiMessage => ({ ...inlineDurableRow(), id: "paste-row" });
  function Row() {
    const message = useAppStore((s) => s.messages[0]);
    return message ? <MessageRow message={message} isRunning={false} /> : null;
  }
  const sent: Parameters<typeof api.prompt>[0][] = [];
  api.prompt = async (input) => { sent.push(input); return { accepted: true }; };
  api.getSession = async () => ({
    session: { ...durableFixture(sessionId), messages: [row()] },
  });
  api.pasteFiles = async () => ({
    files: [
      { path: "/scratch/pasted-photo.png", name: "pasted-photo.png", kind: "image", mimeType: "image/png", size: 6 },
      { path: "/scratch/memo.txt", name: "memo.txt", kind: "file", mimeType: "text/plain", size: 4 },
    ],
  });
  const waitFor = async (ready: () => boolean, label: string) => {
    for (let frame = 0; frame < 120; frame++) {
      if (ready()) return;
      await painted();
    }
    throw new Error(label);
  };
  const countOccurrences = (haystack: string, needle: string) =>
    haystack.split(needle).length - 1;
  try {
    flushSync(() => useAppStore.setState({
      activeSessionId: sessionId, selectingSessionId: null, isRunning: false,
      messages: [row()], pendingPlans: {},
      showToast: () => undefined,
    }));
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><SlotSessionProvider sessionId={sessionId}><Row /></SlotSessionProvider></I18nextProvider>));
    // A seeded main-composer draft must survive the whole edit untouched.
    writeComposerDraft(sessionId, {
      text: "main composer words",
      fileReferences: [
        { path: "/main/keep.png", name: "keep.png", kind: "image" as const },
      ],
    });
    host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
    await painted();
    await painted();
    assert(editInput(host), "message edit did not open");
    assert(
      editChips(host).map((chip) => chip.textContent).join(" ") === "@inline-a.png",
      "the existing attachment did not hydrate into one chip",
    );
    // A real clipboard paste: an image file plus an ordinary file on one
    // DataTransfer, dispatched at the editable like an external paste.
    const editor = editInput(host)!;
    editor.focus();
    const selection = window.getSelection();
    assert(selection, "no selection to paste with");
    selection.selectAllChildren(editor);
    selection.collapseToEnd();
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }));
    data.items.add(new File(["memo"], "memo.txt", { type: "text/plain" }));
    const paste = new ClipboardEvent("paste", {
      clipboardData: data, bubbles: true, cancelable: true,
    });
    editor.dispatchEvent(paste);
    assert(paste.defaultPrevented, "the edit surface did not handle the file paste");
    await waitFor(
      () => editChips(host).length === 3,
      "pasted files did not stage into the editor",
    );
    assert(
      editChips(host).map((chip) => chip.textContent).join(" ") ===
        "@inline-a.png @pasted-photo.png @memo.txt",
      `paste chips are wrong: ${editChips(host).map((chip) => chip.textContent)}`,
    );
    // Removing the ordinary-file chip narrows the current set; the kept chips
    // stay exactly once.
    const memoChip = editChips(host).find((chip) => chip.textContent === "@memo.txt");
    assert(memoChip, "ordinary file chip is missing");
    const memoToken = memoChip.getAttribute("data-token") ?? "";
    const memoIndex = memoToken ? readEditorValue(editInput(host)!).indexOf(memoToken) : -1;
    assert(memoIndex >= 0, "ordinary file chip has no token in the edit value");
    setEditorSelection(editInput(host)!, memoIndex, memoIndex + 1);
    assert(document.execCommand("delete"), "deleting the ordinary file chip failed");
    await painted();
    assert(
      editChips(host).map((chip) => chip.textContent).join(" ") === "@inline-a.png @pasted-photo.png",
      "removal did not narrow the chip set",
    );
    host.querySelector<HTMLButtonElement>(".message-edit-submit")!.click();
    await painted();
    await painted();
    assert(sent.length === 1, "the paste retry sent no prompt");
    const request = sent.at(-1)!;
    assert(
      countOccurrences(request.content, INLINE_MARKER) === 1 &&
        countOccurrences(request.content, "@/scratch/pasted-photo.png") === 1 &&
        !request.content.includes("memo"),
      `retry content is wrong: ${request.content}`,
    );
    assert(
      request.attachments?.map((attachment) => attachment.path).join(" ") ===
        `${INLINE_BLOB} /scratch/pasted-photo.png`,
      `retry attachments are wrong: ${JSON.stringify(request.attachments)}`,
    );
    const mainDraft = readComposerDraft(sessionId);
    assert(
      mainDraft?.text === "main composer words" &&
        mainDraft.fileReferences.length === 1 &&
        mainDraft.fileReferences[0]?.path === "/main/keep.png",
      `paste edit altered the main composer draft: ${JSON.stringify(mainDraft)}`,
    );
    deleteComposerDraft(sessionId);
    return { imagePasted: true, filePasted: true, removalKept: true, retryExact: true, mainDraftKept: true };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    api.prompt = originalPrompt;
    api.getSession = originalRead;
    api.pasteFiles = originalPaste;
    useAppStore.setState(initial, true);
  }
}
