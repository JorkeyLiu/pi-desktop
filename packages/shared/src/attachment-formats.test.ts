import { describe, expect, it } from "vitest";
import {
  isSvgAttachment,
  isViewableImageAttachment,
} from "./attachment-formats.js";

describe("isViewableImageAttachment", () => {
  it("treats raster image extensions as viewable, like the host preview table", () => {
    for (const name of [
      "pixel.png",
      "photo.JPG",
      "photo.jpeg",
      "anim.gif",
      "modern.webp",
      "modern.avif",
      "icon.bmp",
      "favicon.ico",
    ]) {
      expect(isViewableImageAttachment(undefined, name)).toBe(true);
    }
  });

  it("lets a known image extension win so a client cannot reclassify by mime", () => {
    expect(isViewableImageAttachment("text/plain", "pixel.png")).toBe(true);
    expect(isViewableImageAttachment("image/png", "notes.md")).toBe(false);
    expect(isViewableImageAttachment("image/png", "archive.zip")).toBe(false);
  });

  it("treats SVG as a viewable image without making it a model image", () => {
    expect(isViewableImageAttachment("image/svg+xml", "diagram.svg")).toBe(true);
    expect(isViewableImageAttachment(undefined, "diagram.svg")).toBe(true);
    expect(isViewableImageAttachment(undefined, "diagram.SVG")).toBe(true);
    expect(isViewableImageAttachment("application/octet-stream", "diagram.svg")).toBe(true);
    // Viewable is not sendable: SVG stays a readable file, never inline model bytes.
    expect(isSvgAttachment("image/svg+xml", "diagram.svg")).toBe(true);
    expect(isSvgAttachment(undefined, "diagram.svg")).toBe(true);
  });

  it("uses the allowlisted mime for extensionless content blobs", () => {
    const blob = "a".repeat(64);
    expect(isViewableImageAttachment("image/png", blob)).toBe(true);
    expect(isViewableImageAttachment("image/svg+xml", blob)).toBe(true);
    expect(isViewableImageAttachment("text/html", blob)).toBe(false);
    expect(isViewableImageAttachment("image/*", blob)).toBe(false);
    expect(isViewableImageAttachment(undefined, blob)).toBe(false);
  });

  it("rejects non-image mime types and names", () => {
    for (const [mime, name] of [
      ["application/pdf", "report.pdf"],
      ["video/mp4", "clip.mp4"],
      ["audio/mpeg", "song.mp3"],
      ["application/zip", "archive.zip"],
      ["text/plain", "notes.txt"],
      ["text/html", "page.html"],
      [undefined, "notes.txt"],
      ["", "archive.zip"],
      ["image/tiff", "scan.tiff"],
    ] as Array<[string | undefined, string]>) {
      expect(isViewableImageAttachment(mime, name)).toBe(false);
    }
  });
});
