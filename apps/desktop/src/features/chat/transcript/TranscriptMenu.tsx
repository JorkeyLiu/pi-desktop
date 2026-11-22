/**
 * The transcript's right-click menu: one surface per conversation, fed by
 * whichever row the pointer asked from.
 *
 * The menu lives at the transcript level because a row cannot own a floating
 * layer that has to outlive it — deleting a message removes its row, and the
 * transcript scroller measures every row for the minimap. Rows therefore
 * publish a request through context (the same shape `TranscriptSearchContext`
 * and `DisclosureAnchorContext` use) and the provider renders exactly one
 * `<ContextMenu>`.
 *
 * The transcript offers exactly one menu, over selected text only: Copy the
 * exact selection, or Quote it into the composer as a blockquote. A collapsed
 * caret, a selection outside the right-clicked surface, or a right-click on a
 * button or empty background opens nothing — the toolbar rows already own
 * every other action, and they are never duplicated here.
 */
import {
  createContext,
  useCallback,
  useContext,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  clearChatSelection,
  ContextMenu,
  contextMenuClickHitsSelection,
  readContextMenuSelection,
  useContextMenu,
  type ContextMenuClickPoint,
} from "../../../components/ContextMenu";
import { useAppStore } from "../../../stores/app-store";
import { appendQuoteToDraft, buildQuoteText } from "../../../lib/chat-quotes";
import {
  draftKeyForSession,
  readComposerDraft,
} from "../../../lib/composer-draft-cache";
import { selectedTextMenuItems } from "./menu-items";

/**
 * Opens the selected-text menu, or nothing when no text is selected in the
 * right-clicked surface. Never prevent-defaults on the way out: with no
 * selection there is no custom menu, and the platform keeps its behavior.
 */
export type OpenTranscriptMenu = (event: ReactMouseEvent<HTMLElement>) => void;

/**
 * A row rendered outside the provider (tests, a focused single-row view) keeps
 * a working handler that opens nothing rather than throwing mid-render.
 */
export const TranscriptMenuContext = createContext<OpenTranscriptMenu>(() => {});

export function useTranscriptMenu(): OpenTranscriptMenu {
  return useContext(TranscriptMenuContext);
}

export function TranscriptMenuProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  const { copyText, quoteText } = useChatTextActions();
  const openSelectedTextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      // Gate before the open, on the same reading the menu snapshot takes:
      // without a selection there is no custom menu at all.
      if (!readContextMenuSelection(event.currentTarget)) return;
      // The pointer must land on the selected words themselves: Chromium keeps
      // the old selection when right-clicking elsewhere in the same paragraph,
      // so containment alone would offer Copy for text the pointer never
      // touched. A click outside the selection cancels it, browser-like, and
      // opens nothing. A keyboard menu carries no coordinates and keeps the
      // existing behavior.
      const point: ContextMenuClickPoint =
        event.clientX === 0 && event.clientY === 0
          ? null
          : { x: event.clientX, y: event.clientY };
      if (!contextMenuClickHitsSelection(event.currentTarget, point)) {
        if (point) clearChatSelection(event.currentTarget);
        return;
      }
      openContextMenu(event, {
        label: t("chat.messageMenu"),
        items: selectedTextMenuItems({ t, actions: { copyText, quoteText } }),
      });
    },
    [copyText, openContextMenu, quoteText, t],
  );
  return (
    <TranscriptMenuContext.Provider value={openSelectedTextMenu}>
      {children}
      <ContextMenu state={contextMenu} onClose={closeContextMenu} />
    </TranscriptMenuContext.Provider>
  );
}

/**
 * The clipboard and composer half of the selected-text menu.
 *
 * A menu disappears the moment an item runs, so an item cannot report its
 * outcome through its own state the way the hover copy chips do (see `useCopy`);
 * the toast host carries the copy outcome instead. A quote lands in the
 * composer through the same prefill the smart-Stop restore path uses, so the
 * composer applies it, keeps the existing draft around it, and takes focus —
 * this action only addresses it.
 */
export function useChatTextActions() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const activeSessionId = useAppStore((state) => state.activeSessionId);

  const copyText = useCallback(
    async (selection: string) => {
      if (!selection) return;
      try {
        await navigator.clipboard.writeText(selection);
        showToast(t("chat.copied"), { variant: "success" });
      } catch {
        showToast(t("chat.copyFailed"), { variant: "error" });
      }
    },
    [showToast, t],
  );

  const quoteText = useCallback(
    (selection: string) => {
      if (!selection || !activeSessionId) return;
      const quote = buildQuoteText(selection);
      if (!quote) return;
      // Read the live draft so a quote adds to what the user already typed.
      // The composer applies this prefill for its own session and then clears
      // it, focusing the composer as part of applying.
      const draft = readComposerDraft(draftKeyForSession(activeSessionId));
      useAppStore.setState({
        composerPrefill: {
          sessionId: activeSessionId,
          text: appendQuoteToDraft(draft?.text ?? "", quote),
          fileReferences: draft?.fileReferences ?? [],
        },
      });
    },
    [activeSessionId],
  );

  return { copyText, quoteText };
}
