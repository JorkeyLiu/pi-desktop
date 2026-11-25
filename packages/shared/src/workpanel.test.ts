import { describe, expect, it } from "vitest";
import { knownDiffLineCounts } from "./types/workpanel.js";

describe("knownDiffLineCounts", () => {
  it("trusts numeric counts from a host written before countsKnown existed", () => {
    // Old hosts always computed counts for text, so a missing flag means known.
    expect(knownDiffLineCounts({ additions: 3, deletions: 1 })).toEqual({
      additions: 3,
      deletions: 1,
    });
  });

  it("reports exact zero counts as evidence", () => {
    expect(knownDiffLineCounts({ additions: 0, deletions: 0, countsKnown: true })).toEqual({
      additions: 0,
      deletions: 0,
    });
  });

  it("treats binary content as unknown even when a legacy host sent zeros", () => {
    expect(
      knownDiffLineCounts({ additions: 0, deletions: 0, binary: true }),
    ).toBeNull();
  });

  it("ignores compatibility placeholder numbers when countsKnown is false", () => {
    expect(
      knownDiffLineCounts({ additions: 4, deletions: 2, countsKnown: false }),
    ).toBeNull();
    expect(
      knownDiffLineCounts({ additions: 0, deletions: 0, countsKnown: false }),
    ).toBeNull();
  });

  it("rejects numbers that cannot be line evidence", () => {
    expect(knownDiffLineCounts({ additions: -1, deletions: 1 })).toBeNull();
    expect(knownDiffLineCounts({ additions: 1, deletions: -1 })).toBeNull();
    expect(knownDiffLineCounts({ additions: Number.NaN, deletions: 1 })).toBeNull();
    expect(knownDiffLineCounts({ additions: 1, deletions: 1.5 })).toBeNull();
  });
});
