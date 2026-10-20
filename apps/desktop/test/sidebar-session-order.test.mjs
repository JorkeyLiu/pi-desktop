import assert from "node:assert/strict";
import test from "node:test";
import {
  canReorderSidebarSessions,
  moveSessionWithinOrder,
  sessionOrderBucket,
  sessionOrderRanks,
  withoutSessionOrder,
} from "../src/lib/sidebar-session-order.ts";

function session(overrides = {}) {
  return {
    id: "session",
    title: "Session",
    mode: "agent",
    createdAt: "2026-09-10T10:00:00.000Z",
    updatedAt: "2026-09-11T10:00:00.000Z",
    ...overrides,
  };
}

test("rows reorder only inside the container that renders them", () => {
  const meta = {};
  assert.equal(sessionOrderBucket(session({ projectPath: "/work/app" }), meta), "project:/work/app");
  assert.equal(sessionOrderBucket(session({ projectPath: "/work/app/" }), meta), "project:/work/app");
  assert.equal(sessionOrderBucket(session({}), meta), "temporary");
  assert.equal(
    sessionOrderBucket(session({ id: "pin", projectPath: "/work/app" }), { pinned: true }),
    "pinned",
  );

  const appRow = session({ id: "app", projectPath: "/work/app" });
  const otherRow = session({ id: "other", projectPath: "/work/other" });
  const temporary = session({ id: "temp" });
  assert.equal(canReorderSidebarSessions(appRow, otherRow, meta), false);
  assert.equal(canReorderSidebarSessions(appRow, temporary, meta), false);
  assert.equal(canReorderSidebarSessions(appRow, appRow, meta), false);
  assert.equal(
    canReorderSidebarSessions(appRow, session({ id: "app-2", projectPath: "/work/app" }), meta),
    true,
  );
  assert.equal(
    canReorderSidebarSessions(appRow, session({ id: "pin", projectPath: "/work/app" }), {
      pin: { pinned: true },
    }),
    false,
    "a pinned row lives in the global pin list, not the project group",
  );
});

test("a drop moves one row next to its target", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(moveSessionWithinOrder(ids, "d", "b", false), ["a", "d", "b", "c"]);
  assert.deepEqual(moveSessionWithinOrder(ids, "a", "c", false), ["b", "a", "c", "d"]);
  assert.deepEqual(moveSessionWithinOrder(ids, "a", "c", true), ["b", "c", "a", "d"]);
  assert.deepEqual(moveSessionWithinOrder(ids, "b", "a", true), ["a", "b", "c", "d"]);
  assert.deepEqual(ids, ["a", "b", "c", "d"], "the input order is never mutated");
});

test("a stale or self drop leaves the order alone", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(moveSessionWithinOrder(ids, "b", "b", true), ids);
  assert.deepEqual(moveSessionWithinOrder(ids, "missing", "b", true), ids);
  assert.deepEqual(moveSessionWithinOrder(ids, "a", "missing", true), ids);
  assert.deepEqual(moveSessionWithinOrder([], "a", "b", true), []);
});

test("ranks are contiguous, de-duplicated, and keep the drop order", () => {
  assert.deepEqual(sessionOrderRanks(["b", "a", "c"]), { b: 0, a: 1, c: 2 });
  assert.deepEqual(sessionOrderRanks(["b", "b", "a"]), { b: 0, a: 1 });
  assert.deepEqual(sessionOrderRanks([]), {});
});

test("leaving a container drops only that session's rank", () => {
  const meta = {
    moved: { order: 2, manualTitle: true },
    ranked: { order: 0 },
    pinned: { pinned: true, order: 5 },
  };
  const next = withoutSessionOrder(meta, "moved");
  assert.deepEqual(next.moved, { manualTitle: true });
  assert.equal(next.ranked.order, 0);
  assert.equal(next.pinned.order, 5);
  assert.equal(meta.moved.order, 2, "the previous record is not mutated");
  assert.equal(withoutSessionOrder(meta, "absent"), meta, "an unknown id keeps the record");
  assert.deepEqual(withoutSessionOrder({ only: { order: 1 } }, "only"), {});
});
