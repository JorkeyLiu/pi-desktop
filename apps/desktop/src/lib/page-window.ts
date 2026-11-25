/**
 * Page-window arithmetic shared by the two physical readers.
 *
 * A bounded history read answers with one *page*: a contiguous run of selected
 * rows with an exclusive physical end, plus the answer's own statement about
 * what lies before and after it. A reader that accumulates pages must decide
 * which pages the window still holds when a budget applies, and the cursors and
 * flags it publishes must describe exactly those pages — never a range it read
 * once and then dropped.
 *
 * This module owns that one decision. It is pure: callers keep their own row
 * merging (the main transcript prefers the row it already shows, the delegation
 * scope prefers the durable page), and hand the result a page built from their
 * answer. Why the decision is not row arithmetic:
 *
 * - A delegation page is a sparse physical selection, so a retained row has no
 *   index the caller can derive; only a page states its physical bounds. A
 *   cursor computed from rows therefore cannot be honest, while a cursor taken
 *   from a retained page always is.
 * - Under a row budget the page at the opposite side is what has to go: reading
 *   older rows must not evict the page the reader just asked for, and a forward
 *   read must not evict the newest page it just joined.
 * - Dropped pages are reported by identity, so the caller can drop their rows
 *   and state the omission without re-deriving which rows belonged to them.
 *
 * An unbounded reader (the main transcript window) passes no budget: the same
 * arithmetic then reproduces the plain union of its pages, so both readers
 * share one contract without changing the main window's behavior.
 */

/** One physical page: its exclusive bounds and the rows it contributed. */
export type PageWindowPage = {
  /** Inclusive physical index of the page's first selected row. */
  start: number;
  /** Exclusive physical end of the page's last selected row. */
  end: number;
  /** Row identities the page put in the window, in display order. */
  ids: readonly string[];
  /** The answer's own statement about rows older than this page. */
  hasMoreBefore?: boolean;
  /** The answer's own statement about rows newer than this page. */
  hasMoreAfter?: boolean;
};

/** The pages a window holds and what lies outside it. */
export type PageWindow = {
  /** Retained pages, oldest first. */
  pages: readonly PageWindowPage[];
  /** Selected rows exist before the window. */
  hasMoreBefore: boolean;
  /** Selected rows exist after the window. */
  hasMoreAfter: boolean;
};

/** Which side of the window the incoming page belongs to. */
export type PageWindowDirection = "before" | "after";

export type PageWindowMerge = {
  /** Pages the window holds after the merge, oldest first. */
  pages: PageWindowPage[];
  /** Physical start of the oldest retained page. */
  messageStart: number;
  /** Exclusive physical end of the newest retained page. */
  messageEnd: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** Rows of the pages the budget dropped, so the caller can drop them too. */
  droppedIds: string[];
  /** Pages the budget dropped on the older side. */
  droppedPagesBefore: number;
  /** Pages the budget dropped on the newer side. */
  droppedPagesAfter: number;
};

/** A window with no pages: nothing read yet. */
export function emptyPageWindow(): PageWindow {
  return { pages: [], hasMoreBefore: false, hasMoreAfter: false };
}

/** Rows the window's pages contribute. */
export function pageWindowRowCount(pages: readonly PageWindowPage[]): number {
  return pages.reduce((total, page) => total + page.ids.length, 0);
}

/**
 * Merge one page into the window and keep the side the read asked for.
 *
 * `direction` names where the page belongs (`before` for an older read,
 * `after` for a forward or tail read). A budget keeps whole pages and drops
 * them from the *other* side, so the rows the caller asked for are retained:
 * an older read at the budget drops the newest page, a forward read drops the
 * oldest one. One page is always kept — a single answer wider than the budget
 * is still a range the reader asked to see, and its own bounds stay exact.
 *
 * Cursors come from the retained pages only, and `droppedIds` names the rows
 * that left the window. The caller must drop those rows, because the window no
 * longer speaks for them: keeping them would leave rows whose physical range
 * is not in the window, which is the gap this policy exists to prevent.
 */
export function mergePageWindow(input: {
  window: PageWindow;
  page: PageWindowPage;
  direction: PageWindowDirection;
  limit?: number;
}): PageWindowMerge {
  const { window, page, direction, limit } = input;
  // Same physical range read again (a retry, or a page that overlaps itself
  // after a resume): the newest answer replaces the older copy instead of
  // doubling its rows. Ranges are exclusive and inclusive in the same way the
  // backend states them, so equality is the only safe overlap to collapse.
  const sameRange = (left: PageWindowPage, right: PageWindowPage) =>
    left.start === right.start && left.end === right.end;
  let pages: PageWindowPage[] = [
    page,
    ...window.pages.filter((held) => !sameRange(held, page)),
  ].sort((left, right) => left.start - right.start);

  let droppedPagesBefore = 0;
  let droppedPagesAfter = 0;
  const droppedIds: string[] = [];
  if (limit !== undefined && limit > 0) {
    let rows = pageWindowRowCount(pages);
    while (rows > limit && pages.length > 1) {
      if (direction === "before") {
        // The reader asked for older rows: the newest page is the one to drop.
        const dropped = pages[pages.length - 1];
        pages = pages.slice(0, -1);
        rows -= dropped.ids.length;
        droppedIds.push(...dropped.ids);
        droppedPagesAfter += 1;
      } else {
        const dropped = pages[0];
        pages = pages.slice(1);
        rows -= dropped.ids.length;
        droppedIds.push(...dropped.ids);
        droppedPagesBefore += 1;
      }
    }
  }

  const oldest = pages[0];
  const newest = pages[pages.length - 1];
  const messageStart = oldest?.start ?? page.start;
  const messageEnd = newest?.end ?? page.end;
  // The page that landed on a side speaks for that side: it is the newest
  // answer about what lies beyond it. A side whose page was dropped by the
  // budget still has rows beyond it, so it is stated as continuing.
  const hasMoreBefore =
    direction === "before"
      ? page.hasMoreBefore ?? window.hasMoreBefore
      : window.hasMoreBefore || droppedPagesBefore > 0;
  const hasMoreAfter =
    direction === "after"
      ? page.hasMoreAfter ?? window.hasMoreAfter
      : window.hasMoreAfter || droppedPagesAfter > 0;

  return {
    pages,
    messageStart,
    messageEnd,
    hasMoreBefore,
    hasMoreAfter,
    droppedIds,
    droppedPagesBefore,
    droppedPagesAfter,
  };
}

/**
 * Drop the rows a merge reported as no longer in the window.
 *
 * `keepId` is retained even when its page was dropped: a search target is a
 * row the reader asked to keep in view, and the caller states the omission
 * around it instead of letting the budget take it away.
 */
export function withoutPageWindowRows<T extends { id: string }>(
  rows: readonly T[],
  droppedIds: readonly string[],
  keepId?: string,
): T[] {
  if (!droppedIds.length) return [...rows];
  const dropped = new Set(droppedIds);
  return rows.filter((row) => row.id === keepId || !dropped.has(row.id));
}
