import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "../../packages/i18n/src/index";
import { MessageRow } from "../../apps/desktop/src/features/chat/transcript/MessageRow";
import { TranscriptMenuProvider } from "../../apps/desktop/src/features/chat/transcript/TranscriptMenu";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const check = (ok: boolean, label: string) => { if (!ok) throw new Error(label); };
const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const find = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const click = async (selector: string) => {
  flushSync(() => find(selector).click());
  await settle();
};
// Real Chromium selection, as the transcript gate reads it: a collapsed caret
// or a selection outside the row opens no menu at all. Offsets run over the
// bubble's concatenated text, whatever elements the renderer splits it into.
const selectBubbleText = (start: number, end: number) => {
  const bubble = find(".message-bubble");
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let next: Node | null = null;
  while ((next = walker.nextNode())) nodes.push(next as Text);
  if (!nodes.length) throw new Error("Missing bubble text");
  let startNode = nodes[0];
  let endNode = nodes[nodes.length - 1];
  let startOffset = 0;
  let endOffset = endNode.data.length;
  let acc = 0;
  for (const text of nodes) {
    const stop = acc + text.data.length;
    if (acc <= start && start <= stop) { startNode = text; startOffset = start - acc; }
    if (acc <= end && end <= stop) { endNode = text; endOffset = end - acc; }
    acc = stop;
  }
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};
const collapseSelection = () => window.getSelection()?.removeAllRanges();
const menu = async (node: HTMLElement) => {
  flushSync(() => node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
  await settle();
};
// Editing now reloads the saved message before the editor opens, so the probe
// has to wait for the editor instead of reading it in the same tick.
const waitForTextarea = async () => {
  for (let index = 0; index < 120; index++) {
    const node = document.querySelector<HTMLTextAreaElement>("textarea");
    if (node) return node;
    await settle();
  }
  throw new Error("Missing textarea");
};

Object.assign(globalThis, { messageEditCopyProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  let copied = "";
  // `prepareUserMessageEdit` reads the active session's stored message; this
  // row-level fixture has no session, so stub that round trip with the message
  // it renders and keep the probe offline. The quote path addresses the
  // composer prefill of the active session, so the probe owns one.
  useAppStore.setState({
    activeSessionId: "probe-session",
    prepareUserMessageEdit: async () => ({
      id: "message",
      role: "user",
      content: "Original saved message",
      createdAt: "2026-09-21T00:00:00Z",
    }),
  });
  // Mock only the external clipboard write, keeping native textarea selection.
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { copied = text; } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><TranscriptMenuProvider>
    <MessageRow message={{ id: "message", role: "user", content: "Original saved message", createdAt: "2026-09-21T00:00:00Z" }} isRunning={false} />
  </TranscriptMenuProvider></I18nextProvider>));
  const article = find('[role="article"]');
  // Without a selection no surface fabricates a menu — not the row, and not
  // the buttons or background around it.
  await menu(article);
  check(!document.querySelector('[role="menu"]'), "Row without selection opened a menu");
  // A real selection offers exactly Copy and Quote, nothing else.
  selectBubbleText(9, 22);
  await menu(article);
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
  check(items.join("|") === "Copy|Quote", `Selected-text menu offered ${JSON.stringify(items)}`);
  await click('[data-context-menu-item="copy"]');
  check(copied === "saved message", `Selected copy returned ${JSON.stringify(copied)}`);
  // Quote carries the exact excerpt into the active session's composer prefill.
  selectBubbleText(0, 8);
  await menu(article);
  await click('[data-context-menu-item="quote"]');
  check(useAppStore.getState().composerPrefill?.text === "> Original",
    `Quote prefill was ${JSON.stringify(useAppStore.getState().composerPrefill?.text)}`);
  check(useAppStore.getState().composerPrefill?.sessionId === "probe-session",
    "Quote prefill addressed the wrong session");
  // Collapsing the caret closes the menu path again.
  selectBubbleText(0, 8);
  collapseSelection();
  await menu(article);
  check(!document.querySelector('[role="menu"]'), "Collapsed caret opened a menu");
  // Toolbar editing still works: the excerpt selection inside the edit draft
  // copies exactly, and a collapsed draft caret opens nothing.
  await click('[aria-label="Edit and resend"]');
  const editor = await waitForTextarea();
  editor.focus();
  editor.setSelectionRange(0, 8);
  await menu(editor);
  await click('[data-context-menu-item="copy"]');
  check(copied === "Original", `Draft copy returned ${JSON.stringify(copied)}`);
  editor.focus();
  editor.setSelectionRange(0, 0);
  await menu(editor);
  check(!document.querySelector('[role="menu"]'), "Collapsed draft caret opened a menu");
  root.unmount();
  return "PASS: no menu without selection, copy exact excerpt, quote to composer prefill, collapsed caret, draft excerpt copy";
} });
