import { describe, expect, it } from "vitest";
import {
  AUTO_PASTED_TEXT_DIR,
  findPromptPathMarkers,
  MAX_AUTO_PASTED_TEXT_BYTES,
  replacePromptPathMarkers,
} from "./auto-pasted-text.js";

const markerText = (content: string) =>
  findPromptPathMarkers(content).map((marker) => marker.path);

describe("prompt path markers", () => {
  it("keeps `@` inside a path, as the serializer's quoting rule implies", () => {
    // formatFileInsert quotes only on whitespace, so a data root with `@`
    // reaches the prompt as one unquoted marker.
    expect(markerText("summarize @/data/user@example.com/pasted/text/a.txt please")).toEqual([
      "/data/user@example.com/pasted/text/a.txt",
    ]);
    expect(markerText("@a@b.txt")).toEqual(["a@b.txt"]);
  });

  it("reads the quoted form for a path with spaces", () => {
    expect(findPromptPathMarkers('see @"/data/my root/a b.txt" done')).toEqual([
      { path: "/data/my root/a b.txt", start: 4, end: 28 },
    ]);
  });

  it("finds plain and quoted paths in order", () => {
    expect(findPromptPathMarkers('see @/a.txt then @"/a b.txt" done')).toEqual([
      { path: "/a.txt", start: 4, end: 11 },
      { path: "/a b.txt", start: 17, end: 28 },
    ]);
  });

  it("replaces only the markers the caller resolved", () => {
    const content = "before @/a.txt middle @/b.txt after";
    const markers = findPromptPathMarkers(content);
    expect(
      replacePromptPathMarkers(content, markers, (marker) =>
        marker.path === "/b.txt" ? "B" : undefined,
      ),
    ).toBe("before @/a.txt middle B after");
  });

  it("replaces every occurrence of a repeated marker", () => {
    const content = "@/a.txt and @/b.txt and @/a.txt";
    const markers = findPromptPathMarkers(content);
    expect(
      replacePromptPathMarkers(content, markers, (marker) =>
        marker.path === "/a.txt" ? "A" : undefined,
      ),
    ).toBe("A and @/b.txt and A");
  });

  it("does not rescan the text it inserts", () => {
    const content = "x @/a.txt y @/b.txt z";
    const markers = findPromptPathMarkers(content);
    expect(
      replacePromptPathMarkers(content, markers, (marker) =>
        marker.path === "/a.txt" ? "pasted @/b.txt and @/a.txt body" : "B",
      ),
    ).toBe("x pasted @/b.txt and @/a.txt body y B z");
  });
});

describe("auto-pasted text ownership", () => {
  it("names one dedicated directory and one byte bound", () => {
    expect(AUTO_PASTED_TEXT_DIR).toBe("pasted/text");
    expect(MAX_AUTO_PASTED_TEXT_BYTES).toBe(64 * 1024 * 1024);
  });
});
