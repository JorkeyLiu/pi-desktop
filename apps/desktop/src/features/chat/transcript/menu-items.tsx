/**
 * The transcript's context-menu vocabulary, as a pure function of the selected
 * text the menu opened over.
 *
 * The transcript offers exactly one menu: the selected-text menu. Copy and
 * Quote act on the live selection captured when the menu opened; a collapsed
 * caret, or a selection outside the right-clicked surface, opens no menu at
 * all, so these builders never see an empty excerpt and never fall back to a
 * whole turn. Everything else a row can do — Edit, Delete, Regenerate,
 * Branch, revision paging — stays on its hover toolbar, never duplicated here.
 * The conversation background offers no menu of its own: a selection dragged
 * across rows is still a selection, and it opens this same menu.
 *
 * Keeping the item set a plain value means a test can assert it while the
 * components stay wiring.
 */
import type { TFunction } from "i18next";
import { IconCopy, IconQuote } from "../../../components/icons";
import type { ContextMenuItem } from "../../../components/ContextMenu";

/** Actions the builders call; the components own their real implementations. */
export type MenuItemActions = {
  copyText: (selection: string) => void;
  quoteText: (selection: string) => void;
};

/**
 * The only menu the transcript opens: Copy the exact selected text, or carry
 * it into the composer as a blockquote. No separators — one group, two items.
 */
export function selectedTextMenuItems({
  t,
  actions,
}: {
  t: TFunction;
  actions: MenuItemActions;
}): ContextMenuItem[] {
  return [
    {
      id: "copy",
      label: t("chat.copy"),
      icon: copyIcon(),
      onSelect: (selection) => actions.copyText(selection),
    },
    {
      id: "quote",
      label: t("chat.quote"),
      icon: quoteIcon(),
      onSelect: (selection) => actions.quoteText(selection),
    },
  ];
}

/*
  Icons arrive as elements rather than components so a builder stays a plain
  function of data. They are created per call, which React reconciles by
  position inside the menu — the same shape the hover toolbar already uses.
*/
function copyIcon() {
  return <IconCopy size={14} />;
}

function quoteIcon() {
  return <IconQuote size={14} />;
}
