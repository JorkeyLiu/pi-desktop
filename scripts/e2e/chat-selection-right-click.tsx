import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "../../packages/i18n/src/index";
import { MessageRow } from "../../apps/desktop/src/features/chat/transcript/MessageRow";
import { TranscriptMenuProvider } from "../../apps/desktop/src/features/chat/transcript/TranscriptMenu";

type SelectionSnapshot = { text: string; collapsed: boolean; count: number };
type EventEntry = {
  type: string;
  button: number;
  text: string;
  collapsed: boolean;
};

const CONTENT =
  "Right-click probe English words, 快速的棕色狐狸跳过懒狗。";

const eventLog: EventEntry[] = [];
const selectionOf = (): SelectionSnapshot => {
  const live = window.getSelection();
  if (!live || live.rangeCount === 0)
    return { text: "", collapsed: true, count: 0 };
  return {
    text: live.toString(),
    collapsed: live.isCollapsed,
    count: live.rangeCount,
  };
};
for (const type of ["pointerdown", "mousedown", "contextmenu"] as const) {
  document.addEventListener(
    type,
    (event) => {
      const selection = selectionOf();
      eventLog.push({
        type,
        button: (event as MouseEvent).button ?? -1,
        text: selection.text,
        collapsed: selection.collapsed,
      });
    },
    true,
  );
}

const find = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const bubbleTextNodes = () => {
  const bubble = find(".message-bubble");
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let next: Node | null = null;
  while ((next = walker.nextNode())) nodes.push(next as Text);
  if (!nodes.length) throw new Error("Missing bubble text");
  return nodes;
};
const fullText = () => bubbleTextNodes().map((node) => node.data).join("");
// Viewport center of the line box holding the given character offset.
const pointForChar = (index: number) => {
  const nodes = bubbleTextNodes();
  let acc = 0;
  for (const node of nodes) {
    const stop = acc + node.data.length;
    if (acc <= index && index < stop) {
      const range = document.createRange();
      range.setStart(node, index - acc);
      range.setEnd(node, index - acc + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) throw new Error("Missing char rect");
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    acc = stop;
  }
  throw new Error(`Char ${index} out of range`);
};
const selectionPoint = () => {
  const rect = window.getSelection()?.getRangeAt(0).getClientRects()[0];
  if (!rect) throw new Error("Missing selection rect");
  return { x: rect.left + Math.min(2, rect.width / 2), y: rect.top + rect.height / 2 };
};
const selectRange = (start: number, end: number) => {
  const nodes = bubbleTextNodes();
  let startNode = nodes[0];
  let endNode = nodes[nodes.length - 1];
  let startOffset = 0;
  let endOffset = endNode.data.length;
  let acc = 0;
  for (const text of nodes) {
    const stop = acc + text.data.length;
    if (acc <= start && start <= stop) {
      startNode = text;
      startOffset = start - acc;
    }
    if (acc <= end && end <= stop) {
      endNode = text;
      endOffset = end - acc;
    }
    acc = stop;
  }
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

Object.assign(globalThis, {
  chatRightClickProbe: {
    ready: async () => {
      await i18n.init({ lng: "en", resources: { en: { translation: en } } });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      flushSync(() =>
        root.render(
          <I18nextProvider i18n={i18n}>
            <TranscriptMenuProvider>
              <MessageRow
                message={{
                  id: "message",
                  role: "user",
                  content: CONTENT,
                  createdAt: "2026-09-21T00:00:00Z",
                }}
                isRunning={false}
              />
            </TranscriptMenuProvider>
          </I18nextProvider>,
        ),
      );
      return fullText();
    },
    englishPoint: () => pointForChar(fullText().indexOf("probe") + 2),
    chinesePoint: () => pointForChar(fullText().indexOf("棕色") + 1),
    selection: selectionOf,
    selectionPoint,
    menu: () => !!document.querySelector('[role="menu"]'),
    menuItems: () =>
      [...document.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent,
      ),
    select: selectRange,
    clearSelection: () => window.getSelection()?.removeAllRanges(),
    clearLog: () => {
      eventLog.length = 0;
    },
    log: (): EventEntry[] => [...eventLog],
  },
});
