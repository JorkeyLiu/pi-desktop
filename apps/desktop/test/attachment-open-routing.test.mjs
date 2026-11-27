import assert from "node:assert/strict";
import test from "node:test";
import { openRoutedAttachment } from "../src/features/chat/transcript/attachment-open-routing.ts";

const png = {
  kind: "image",
  name: "photo.png",
  ref: "attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  mimeType: "image/png",
};
const svg = {
  kind: "file",
  name: "diagram.svg",
  ref: "attachments/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  mimeType: "image/svg+xml",
};
const pdf = {
  kind: "file",
  name: "report.pdf",
  ref: "docs/report.pdf",
  mimeType: "application/pdf",
};

function stubs() {
  const viewer = [];
  const filesTab = [];
  return {
    viewer,
    filesTab,
    openViewer: (attachments, index) => {
      viewer.push({ attachments, index });
    },
    openInFilesTab: (path, baseDir, mimeType) => {
      filesTab.push({ path, baseDir, mimeType });
    },
  };
}

const viewable = [png, svg];

test("a listed viewable image opens in the shared dialog at its position", () => {
  const s = stubs();
  openRoutedAttachment({ viewable, path: png.ref, ...s });
  assert.equal(s.viewer.length, 1);
  assert.equal(s.viewer[0].index, 0);
  assert.equal(s.viewer[0].attachments, viewable);
  assert.equal(s.filesTab.length, 0);
});

test("the second viewable image opens at index 1, not the first", () => {
  const s = stubs();
  openRoutedAttachment({ viewable, path: svg.ref, ...s });
  assert.equal(s.viewer.length, 1);
  assert.equal(s.viewer[0].index, 1);
  assert.equal(s.filesTab.length, 0);
});

test("a non-viewable attachment keeps the files-tab path with its context", () => {
  const s = stubs();
  openRoutedAttachment({
    viewable,
    path: pdf.ref,
    baseDir: "docs",
    mimeType: pdf.mimeType,
    position: { line: 3 },
    ...s,
  });
  assert.equal(s.viewer.length, 0);
  assert.deepEqual(s.filesTab, [{ path: pdf.ref, baseDir: "docs", mimeType: "application/pdf" }]);
});

test("an unknown ref never opens the viewer", () => {
  const s = stubs();
  openRoutedAttachment({ viewable, path: "docs/missing.png", ...s });
  assert.equal(s.viewer.length, 0);
  assert.equal(s.filesTab.length, 1);
  assert.equal(s.filesTab[0].path, "docs/missing.png");
});
