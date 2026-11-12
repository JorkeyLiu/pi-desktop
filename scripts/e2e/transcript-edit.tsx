import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { UiMessage, SessionDetail } from "@pi-desktop/shared";
import { en } from "@pi-desktop/i18n";
import { MessageRow } from "../../apps/desktop/src/features/chat/transcript/MessageRow";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

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
      const canonical = scenario === "slash" ? { ...full, command: "/review logs" } : full;
      let finish!: () => void;
      const readGate = new Promise<void>((resolve) => { finish = resolve; });
      api.getSession = async () => {
        await readGate;
        if (scenario === "read-failure") throw new Error("fixture read failed");
        return { session: { ...session, messages: [canonical] } };
      };
      flushSync(() => useAppStore.setState({
        activeSessionId: sessionId, selectingSessionId: null, isRunning: false,
        messages: [{ ...canonical, content: full.content.slice(0, 65500) + "[truncated for display]" }],
        sessionHistory: { [sessionId]: { messageStart: 0, hasMoreBefore: false, contentLimited: true } },
        pendingPlans: {}, showToast: (message) => { toasts.push(String(message)); },
      }));
      flushSync(() => root.render(<I18nextProvider i18n={i18n}><Row key={scenario} /></I18nextProvider>));
      host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
      await painted();
      assert(!host.querySelector(".message-edit-input"), "Edit must wait for full text instead of exposing clipped display text");
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
      let editor = host.querySelector<HTMLTextAreaElement>(".message-edit-input");
      if (scenario === "round-trip") {
        assert(!editor, "A→B→A must invalidate the pending edit even when the message array is unchanged");
        assert(useAppStore.getState().messages === originalMessages, "cancelled edit must not publish stale history");
        host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
        await painted();
        await painted();
        editor = host.querySelector<HTMLTextAreaElement>(".message-edit-input");
      }
      if (scenario === "read-failure" || scenario === "switch") {
        assert(!editor, `${scenario}: stale or failed read must not open an editor`);
        continue;
      }
      const expected = canonical.command || canonical.content;
      assert(editor?.value === expected, `${scenario}: editor must contain canonical text or the original slash invocation`);
      const revised = expected + "\nPlease focus on payment failures.";
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(editor, revised);
      flushSync(() => editor.dispatchEvent(new Event("input", { bubbles: true })));
      host.querySelector<HTMLButtonElement>(".message-edit-submit")!.click();
      await painted();
      await painted();
      const request = sent.at(-1);
      assert(request?.content === revised && request.truncateFromMessageId === full.id,
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
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Row /></I18nextProvider>));
  };
  /** Enter from the real Edit control; replace only the prompt API. */
  const editAndResend = async (revised: string) => {
    host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
    await painted();
    const editor = host.querySelector<HTMLTextAreaElement>(".message-edit-input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(editor, revised);
    flushSync(() => editor.dispatchEvent(new Event("input", { bubbles: true })));
    host.querySelector<HTMLButtonElement>(".message-edit-submit")!.click();
    await painted();
    await painted();
    return sent.at(-1)!;
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
    const revised = `Actually ${INLINE_MARKER} matters more than the log.`;
    const request = await editAndResend(revised);
    assert(request.content === revised, "the resend carries the edited text");
    assert(request.attachments?.length === 1, "the attached image travels with the edit");
    assert(request.attachments?.[0]?.path === INLINE_BLOB,
      `the stored blob keeps identifying the image: ${request.attachments?.[0]?.path}`);
    assert(request.attachments?.[0]?.inlinePath === INLINE_MARKER,
      `the recorded placement travels with the resend: ${request.attachments?.[0]?.inlinePath}`);
    assert(inlineChips().length === 1 && !trailingList(),
      `edit-resend: ${inlineChips().length} inline / ${trailingChips().length} trailing`);
    assert(prose() === "Actually inline-a.png matters more than the log.",
      `edit-resend kept one image at its new position: ${prose()}`);

    // An edit that removes the marker keeps the intentional attachment trailing.
    paintRow([inlineDurableRow()]);
    const removed = await editAndResend("compare the rest");
    assert(removed.attachments?.length === 1, "an edited prompt keeps its attached image");
    assert(inlineChips().length === 0 && trailingChips().length === 1,
      `marker removed: ${inlineChips().length} inline / ${trailingChips().length} trailing`);
    assert(!prose().includes(INLINE_PATH), `the removed marker leaves no path text: ${prose()}`);

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
    return { durablePlacement: true, editResend: true, markerRemoved: true, unplacedTrailing: true, assistantRetry: true };
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
