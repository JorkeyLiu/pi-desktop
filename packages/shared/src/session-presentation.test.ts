import { describe, expect, it } from "vitest";
import {
  compareSessions,
  resolveSessionSort,
  sortSessions,
  type SessionPresentationMeta,
} from "./session-presentation.js";
import type { SessionSummary } from "./types/sessions.js";

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: overrides.id,
    messageCount: 1,
    mode: "agent",
    thinkingLevel: "off",
    permissionMode: "inherit",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

function ids(rows: SessionSummary[]): string[] {
  return rows.map((row) => row.id);
}

describe("resolveSessionSort", () => {
  it("keeps the created-date order for stored default and legacy values", () => {
    expect(resolveSessionSort(undefined)).toBe("created");
    expect(resolveSessionSort("recent")).toBe("created");
    expect(resolveSessionSort("created")).toBe("created");
    expect(resolveSessionSort("oldest")).toBe("oldest");
    expect(resolveSessionSort("name")).toBe("name");
    expect(resolveSessionSort("manual")).toBe("manual");
  });
});

describe("session order without an explicit sort", () => {
  it("orders newest created sessions first instead of following activity", () => {
    const rows = [
      session({ id: "older", createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z" }),
      session({ id: "newer", createdAt: "2026-09-10T10:00:00.000Z", updatedAt: "2026-09-11T10:00:00.000Z" }),
    ];
    expect(ids(sortSessions(rows, {}))).toEqual(["newer", "older"]);
    expect(ids(sortSessions(rows, {}, "recent"))).toEqual(["newer", "older"]);
  });

  it("keeps every row in place while several sessions gain activity", () => {
    const rows = [
      session({ id: "a", createdAt: "2026-09-10T10:00:00.000Z" }),
      session({ id: "b", createdAt: "2026-09-09T10:00:00.000Z" }),
      session({ id: "c", createdAt: "2026-09-08T10:00:00.000Z" }),
    ];
    expect(ids(sortSessions(rows, {}, "created"))).toEqual(["a", "b", "c"]);

    const busy = rows.map((row, index) => ({
      ...row,
      updatedAt: `2026-09-2${index}T10:00:00.000Z`,
    }));
    expect(ids(sortSessions(busy, {}, "created"))).toEqual(["a", "b", "c"]);
    expect(ids(sortSessions([...busy].reverse(), {}, "created"))).toEqual(["a", "b", "c"]);
  });

  it("breaks equal created timestamps by id so the order never churns", () => {
    const created = "2026-09-10T10:00:00.000Z";
    const rows = [
      session({ id: "gamma", createdAt: created }),
      session({ id: "alpha", createdAt: created }),
      session({ id: "beta", createdAt: created }),
    ];
    expect(ids(sortSessions(rows, {}, "created"))).toEqual(["alpha", "beta", "gamma"]);
    expect(ids(sortSessions([...rows].reverse(), {}, "created"))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("keeps pinned rows above the unpinned order and archived rows last", () => {
    const meta: Record<string, SessionPresentationMeta> = {
      pinned: { pinned: true },
      archived: { archived: true },
    };
    const rows = [
      session({ id: "archived", createdAt: "2026-09-12T10:00:00.000Z" }),
      session({ id: "plain", createdAt: "2026-09-01T10:00:00.000Z" }),
      session({ id: "pinned", createdAt: "2026-08-01T10:00:00.000Z" }),
    ];
    expect(ids(sortSessions(rows, meta, "created"))).toEqual(["pinned", "plain"]);
    expect(ids(sortSessions(rows, meta, "created", true))).toEqual([
      "pinned",
      "plain",
      "archived",
    ]);
  });

  it("keeps explicit name and oldest preferences", () => {
    const rows = [
      session({ id: "zeta", title: "Zeta", createdAt: "2026-09-01T10:00:00.000Z" }),
      session({ id: "alpha", title: "Alpha", createdAt: "2026-09-20T10:00:00.000Z" }),
    ];
    expect(ids(sortSessions(rows, {}, "name"))).toEqual(["alpha", "zeta"]);
    expect(ids(sortSessions(rows, {}, "oldest"))).toEqual(["zeta", "alpha"]);
    expect(
      ids(sortSessions(rows, {}, "name", false, { titleOf: (row) => row.title.toLowerCase() })),
    ).toEqual(["alpha", "zeta"]);
  });
});

describe("manual session order", () => {
  it("follows persisted ranks and puts unranked sessions on top", () => {
    const meta: Record<string, SessionPresentationMeta> = {
      second: { order: 1 },
      first: { order: 0 },
    };
    const rows = [
      session({ id: "second", createdAt: "2026-09-01T10:00:00.000Z" }),
      session({ id: "new", createdAt: "2026-09-12T10:00:00.000Z" }),
      session({ id: "first", createdAt: "2026-09-02T10:00:00.000Z" }),
    ];
    expect(ids(sortSessions(rows, meta, "manual"))).toEqual(["new", "first", "second"]);
  });

  it("lets ranked rows keep their relative order when a new session appears", () => {
    const meta: Record<string, SessionPresentationMeta> = {
      a: { order: 0 },
      b: { order: 1 },
      c: { order: 2 },
    };
    const created = [
      "2026-09-01T10:00:00.000Z",
      "2026-09-02T10:00:00.000Z",
      "2026-09-03T10:00:00.000Z",
    ];
    const before = ["a", "b", "c"].map((id, index) =>
      session({ id, createdAt: created[index] }),
    );
    expect(ids(sortSessions(before, meta, "manual"))).toEqual(["a", "b", "c"]);

    const withNew = [session({ id: "new", createdAt: "2026-09-30T10:00:00.000Z" }), ...before];
    expect(ids(sortSessions(withNew, meta, "manual"))).toEqual(["new", "a", "b", "c"]);
  });

  it("ignores invalid persisted ranks and falls back to the created order", () => {
    const rows = [
      session({ id: "older", createdAt: "2026-09-01T10:00:00.000Z" }),
      session({ id: "newer", createdAt: "2026-09-10T10:00:00.000Z" }),
    ];
    expect(
      ids(
        sortSessions(
          rows,
          { older: { order: -1 }, newer: { order: 1.5 } } as Record<
            string,
            SessionPresentationMeta
          >,
          "manual",
        ),
      ),
    ).toEqual(["newer", "older"]);
  });

  it("ignores activity for ranked rows", () => {
    const meta: Record<string, SessionPresentationMeta> = {
      old: { order: 0 },
      new: { order: 1 },
    };
    const rows = [
      session({ id: "old", createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z" }),
      session({ id: "new", createdAt: "2026-09-10T10:00:00.000Z", updatedAt: "2026-09-11T10:00:00.000Z" }),
    ];
    expect(ids(sortSessions(rows, meta, "manual"))).toEqual(["old", "new"]);
  });
});

describe("compareSessions", () => {
  it("is symmetric for every mode", () => {
    const a = session({ id: "a", createdAt: "2026-09-02T10:00:00.000Z" });
    const b = session({ id: "b", createdAt: "2026-09-01T10:00:00.000Z" });
    for (const sort of ["created", "oldest", "name", "manual", "recent"] as const) {
      expect(Math.sign(compareSessions(a, b, {}, sort))).toBe(
        -Math.sign(compareSessions(b, a, {}, sort)),
      );
      expect(compareSessions(a, a, {}, sort)).toBe(0);
    }
  });
});
