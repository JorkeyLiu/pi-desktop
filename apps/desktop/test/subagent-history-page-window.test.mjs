/**
 * The page budget keeps whole pages and states them exactly.
 *
 * A bounded history read answers with one contiguous physical page. When a
 * reader accumulates those pages under a row budget, the rows it asks for must
 * survive the merge, and the cursors it publishes must describe the pages it
 * still holds — not a range it read once and then dropped. The arithmetic is
 * pure, so the directional trim, the sparse physical bounds, and the single
 * oversized page are asserted directly here.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  emptyPageWindow,
  mergePageWindow,
  pageWindowRowCount,
  withoutPageWindowRows,
} = await import("../src/lib/page-window.ts");

/** One page of `count` rows starting at physical index `start`. */
function page(start, count, extra = {}) {
  return {
    start,
    end: start + count,
    ids: Array.from({ length: count }, (_, offset) => `c${start + offset}`),
    ...extra,
  };
}

/** Physical index of the first and last retained row in a merge. */
function span(merged) {
  const rows = merged.pages.flatMap((held) => held.ids);
  const first = merged.pages[0];
  const last = merged.pages[merged.pages.length - 1];
  return {
    rows,
    contiguous: first.start === merged.messageStart && last.end === merged.messageEnd,
  };
}

test("an older read at the budget drops the newest page, not the page it asked for", () => {
  const limit = 400;
  let window = emptyPageWindow();
  window = mergePageWindow({ window, page: page(600, 100), direction: "after", limit });
  for (const start of [500, 400, 300, 200]) {
    window = mergePageWindow({
      window,
      page: page(start, 100, { hasMoreBefore: start > 0 }),
      direction: "before",
      limit,
    });
  }
  assert.deepEqual(
    window.pages.map((held) => held.start),
    [200, 300, 400, 500],
  );
  assert.equal(pageWindowRowCount(window.pages), limit);
  assert.equal(window.messageStart, 200);
  assert.equal(window.messageEnd, 600);
  assert.equal(window.hasMoreBefore, true);
  assert.equal(window.hasMoreAfter, true);
  assert.equal(window.droppedPagesAfter, 1);
  assert.deepEqual(
    window.droppedIds,
    page(600, 100).ids,
  );
  // What the window holds is exactly what the cursors say it holds.
  assert.equal(window.messageEnd - window.messageStart, pageWindowRowCount(window.pages));
  assert.ok(span(window).contiguous);
});

test("a forward read at the budget drops the oldest page and keeps the newest one", () => {
  const limit = 400;
  let window = emptyPageWindow();
  for (const start of [200, 300, 400, 500]) {
    window = mergePageWindow({
      window,
      page: page(start, 100, { hasMoreBefore: true }),
      direction: "before",
      limit,
    });
  }
  window = mergePageWindow({
    window,
    page: page(600, 100, { hasMoreAfter: false }),
    direction: "after",
    limit,
  });
  assert.deepEqual(
    window.pages.map((held) => held.start),
    [300, 400, 500, 600],
  );
  assert.equal(window.messageStart, 300);
  assert.equal(window.messageEnd, 700);
  // A dropped older page still has rows behind it, so the side is continuing.
  assert.equal(window.hasMoreBefore, true);
  assert.equal(window.hasMoreAfter, false);
  assert.equal(window.droppedPagesBefore, 1);
  assert.deepEqual(window.droppedIds, page(200, 100).ids);
});

test("sparse physical bounds stay the page's own bounds, never row arithmetic", () => {
  const first = page(0, 2, { hasMoreBefore: false, hasMoreAfter: true });
  const later = page(50, 2, { hasMoreBefore: true, hasMoreAfter: false });
  const merged = mergePageWindow({
    window: { pages: [later], hasMoreBefore: true, hasMoreAfter: false },
    page: first,
    direction: "before",
  });
  assert.deepEqual(merged.pages.map((held) => held.start), [0, 50]);
  assert.equal(merged.messageStart, 0);
  assert.equal(merged.messageEnd, 52);
  assert.equal(merged.messageEnd - merged.messageStart, 52);
  assert.notEqual(merged.messageEnd - merged.messageStart, pageWindowRowCount(merged.pages));
  assert.equal(merged.hasMoreBefore, false);
  assert.equal(merged.hasMoreAfter, false);
});

test("without a budget the merge is the plain union of the pages, in physical order", () => {
  const merged = mergePageWindow({
    window: { pages: [page(100, 10), page(300, 10)], hasMoreBefore: true, hasMoreAfter: true },
    page: page(0, 10),
    direction: "before",
  });
  assert.deepEqual(merged.pages.map((held) => held.start), [0, 100, 300]);
  assert.equal(merged.messageStart, 0);
  assert.equal(merged.messageEnd, 310);
  assert.equal(merged.hasMoreBefore, true);
  assert.equal(merged.hasMoreAfter, true);
  assert.deepEqual(merged.droppedIds, []);
  assert.equal(merged.droppedPagesBefore, 0);
  assert.equal(merged.droppedPagesAfter, 0);
});

test("the same physical range read twice replaces the page instead of doubling it", () => {
  const merged = mergePageWindow({
    window: { pages: [page(500, 100)], hasMoreBefore: true, hasMoreAfter: true },
    page: page(500, 100),
    direction: "before",
  });
  assert.equal(merged.pages.length, 1);
  assert.equal(pageWindowRowCount(merged.pages), 100);
  assert.deepEqual(merged.droppedIds, []);
});

test("a single page wider than the budget is kept whole, with its own bounds as the cursor", () => {
  const merged = mergePageWindow({
    window: emptyPageWindow(),
    page: page(500, 150, { hasMoreBefore: true, hasMoreAfter: false }),
    direction: "before",
    limit: 400,
  });
  assert.equal(merged.pages.length, 1);
  assert.equal(pageWindowRowCount(merged.pages), 150);
  assert.equal(merged.messageStart, 500);
  assert.equal(merged.messageEnd, 650);
  // Nothing above or below was dropped, so nothing is invented about the sides.
  assert.equal(merged.droppedIds.length, 0);
  assert.equal(merged.hasMoreBefore, true);
  assert.equal(merged.hasMoreAfter, false);
});

test("row dropping states the omission, and the keep row survives its page", () => {
  const rows = page(600, 3).ids.map((id) => ({ id }));
  const dropped = page(600, 3).ids;
  const kept = rows.map((row) => row.id).concat("focus");
  assert.deepEqual(
    withoutPageWindowRows(rows, dropped),
    [],
  );
  assert.deepEqual(
    withoutPageWindowRows([...rows, { id: "focus" }], dropped, "focus").map((row) => row.id),
    ["focus"],
  );
  assert.equal(kept.length, 4);
  assert.deepEqual(withoutPageWindowRows(rows, []).map((row) => row.id), rows.map((row) => row.id));
});

test("an empty window has no pages and claims nothing about the sides", () => {
  const window = emptyPageWindow();
  assert.deepEqual(window.pages, []);
  assert.equal(window.hasMoreBefore, false);
  assert.equal(window.hasMoreAfter, false);
  assert.equal(pageWindowRowCount(window.pages), 0);
});
