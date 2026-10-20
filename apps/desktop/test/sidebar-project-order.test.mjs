import assert from "node:assert/strict";
import test from "node:test";
import {
  compareProjectGroups,
  projectVisitRanks,
  sortProjectGroups,
} from "../src/lib/sidebar-project-order.ts";

function entry(overrides = {}) {
  return {
    key: "/work/app",
    name: "app",
    meta: {},
    sessions: [{ createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z" }],
    ...overrides,
  };
}

function keys(entries) {
  return entries.map((item) => item.key);
}

test("project visits rank the most recently opened project first", () => {
  assert.deepEqual(projectVisitRanks(["/work/old", "/work/new/"]), {
    "/work/old": 0,
    "/work/new": 1,
  });
  assert.deepEqual(projectVisitRanks([]), {});
});

test("the default project order follows user visits, never session activity", () => {
  const ranks = projectVisitRanks(["/work/a", "/work/b"]);
  const entries = [
    entry({
      key: "/work/a",
      name: "a",
      // The busiest project must not jump above the project the user just opened.
      sessions: [{ createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z" }],
    }),
    entry({
      key: "/work/b",
      name: "b",
      sessions: [{ createdAt: "2026-09-02T10:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z" }],
    }),
  ];
  assert.deepEqual(keys(sortProjectGroups(entries, "recent", ranks)), ["/work/b", "/work/a"]);

  // Bulk activity across both projects keeps every group where it was.
  const busy = entries.map((item, index) => ({
    ...item,
    sessions: item.sessions.map((session) => ({
      ...session,
      updatedAt: `2026-09-2${index}T10:00:00.000Z`,
    })),
  }));
  assert.deepEqual(keys(sortProjectGroups(busy, "recent", ranks)), ["/work/b", "/work/a"]);
  assert.deepEqual(keys(sortProjectGroups([...busy].reverse(), "recent", ranks)), [
    "/work/b",
    "/work/a",
  ]);
});

test("a project without an open tab falls back to its newest created session", () => {
  const ranks = projectVisitRanks(["/work/open"]);
  const entries = [
    entry({ key: "/work/closed-old", sessions: [{ createdAt: "2026-08-01T10:00:00.000Z" }] }),
    entry({ key: "/work/open", sessions: [{ createdAt: "2026-07-01T10:00:00.000Z" }] }),
    entry({ key: "/work/closed-new", sessions: [{ createdAt: "2026-09-05T10:00:00.000Z" }] }),
    entry({ key: "/work/closed-empty", sessions: [] }),
  ];
  assert.deepEqual(keys(sortProjectGroups(entries, "recent", ranks)), [
    "/work/open",
    "/work/closed-new",
    "/work/closed-old",
    "/work/closed-empty",
  ]);
});

test("pinned and archived project buckets stay ahead of the project order", () => {
  const ranks = projectVisitRanks(["/work/plain", "/work/pinned", "/work/archived"]);
  const entries = [
    entry({ key: "/work/archived", meta: { archived: true } }),
    entry({ key: "/work/plain" }),
    entry({ key: "/work/pinned", meta: { pinned: true } }),
  ];
  assert.deepEqual(keys(sortProjectGroups(entries, "recent", ranks)), [
    "/work/pinned",
    "/work/plain",
    "/work/archived",
  ]);
});

test("explicit manual project order is preserved", () => {
  const ranks = projectVisitRanks(["/work/plain", "/work/third"]);
  const entries = [
    entry({ key: "/work/plain" }),
    entry({ key: "/work/third", meta: { order: 2 } }),
    entry({ key: "/work/first", meta: { order: 0 } }),
  ];
  assert.deepEqual(keys(sortProjectGroups(entries, "manual", ranks)), [
    "/work/first",
    "/work/third",
    "/work/plain",
  ]);
});

test("the explicit name, created, and oldest project modes still work", () => {
  const ranks = projectVisitRanks(["/work/zeta"]);
  const entries = [
    entry({
      key: "/work/zeta",
      name: "Zeta",
      sessions: [{ createdAt: "2026-09-01T10:00:00.000Z" }],
    }),
    entry({
      key: "/work/alpha",
      name: "Alpha",
      sessions: [
        { createdAt: "2026-09-20T10:00:00.000Z" },
        { createdAt: "2026-09-10T10:00:00.000Z" },
      ],
    }),
  ];
  assert.deepEqual(keys(sortProjectGroups(entries, "name", ranks)), ["/work/alpha", "/work/zeta"]);
  assert.deepEqual(keys(sortProjectGroups(entries, "created", ranks)), [
    "/work/alpha",
    "/work/zeta",
  ]);
  assert.deepEqual(keys(sortProjectGroups(entries, "oldest", ranks)), ["/work/zeta", "/work/alpha"]);
});

test("compareProjectGroups is a total order", () => {
  const ranks = projectVisitRanks(["/work/a", "/work/b"]);
  const a = entry({ key: "/work/a", name: "a" });
  const b = entry({ key: "/work/b", name: "b" });
  for (const sort of ["recent", "manual", "name", "created", "oldest"]) {
    assert.equal(Math.sign(compareProjectGroups(a, b, sort, ranks)), -Math.sign(
      compareProjectGroups(b, a, sort, ranks),
    ));
    assert.equal(compareProjectGroups(a, a, sort, ranks), 0);
  }
});
