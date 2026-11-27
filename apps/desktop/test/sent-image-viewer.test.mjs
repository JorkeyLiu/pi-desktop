import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  readTranscriptModule,
  readTranscriptSource,
} from "./helpers/source-contracts.mjs";
import { readComposerModule } from "./helpers/composer-source.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [transcript, messageRow, subagentRows, shared, viewer, viewerPan, viewerHook, composerPreview] =
  await Promise.all([
    readTranscriptSource(),
    readTranscriptModule("MessageRow.tsx"),
    readTranscriptModule("SubagentTranscriptRows.tsx"),
    readTranscriptModule("shared.tsx"),
    read("../src/components/ImageViewer.tsx"),
    read("../src/components/useImagePreviewPan.ts"),
    read("../src/features/chat/transcript/useMessageImageViewer.ts"),
    readComposerModule("ComposerImagePreview.tsx"),
  ]);

test("one shared dialog serves the composer and sent messages", () => {
  assert.match(viewer, /export function ImageViewer\(/);
  assert.match(viewer, /useImagePreviewPan\(/);
  assert.match(viewer, /showModal\(\)/);
  assert.match(viewer, /chat\.imagePreview\.title/);
  assert.match(viewer, /chat\.imagePreview\.download/);
  assert.match(viewerPan, /export function useImagePreviewPan\(/);
  // The composer preview is a thin adapter over the shared dialog.
  assert.match(composerPreview, /from \"\.\.\/\.\.\/\.\.\/components\/ImageViewer\"/);
  assert.match(composerPreview, /<ImageViewer/);
  assert.doesNotMatch(composerPreview, /showModal\(\)/);
});

test("clicking a sent local image opens the shared dialog through containment", () => {
  for (const source of [messageRow, subagentRows]) {
    assert.match(source, /isViewableImageAttachment/);
    assert.match(source, /useMessageImageViewer\(\)/);
    // Both surfaces delegate the viewer/files-tab split to the shared router,
    // whose behavior is covered by attachment-open-routing.test.mjs.
    assert.match(source, /openRoutedAttachment\(\{/);
  }
  assert.match(viewerHook, /export function useMessageImageViewer\(\)/);
  assert.match(viewerHook, /api\.fsReadImageDataUrl\(/);
  assert.match(viewerHook, /restoreFocus/);
  // The existing FilesTab path stays for everything the viewer does not take.
  assert.match(transcript, /attachment\.kind === "image" \|\| isViewableImageAttachment\(attachment\.mimeType, attachment\.name\) \?/);
  assert.match(shared, /onOpen=\{onOpenFile\}/);
  // Hover stays a lightweight thumbnail; the dialog owns the open image.
  assert.match(shared, /<ImageHoverCard src=\{dataUrl\} anchor=\{anchor\} onDismiss=\{dismiss\} \/>/);
});

test("SVG transcript attachments get the image chip, hover, and viewer", () => {
  assert.match(shared, /svg/);
  assert.match(
    shared,
    /kind === "image" \|\| \/\\\.\(avif\|bmp\|gif\|heic\|jpe\?g\|png\|svg\|tiff\?\|webp\)\$\/i\.test\(name\)/,
  );
  assert.match(messageRow, /isViewableImageAttachment\(attachment\.mimeType, attachment\.name\)/);
});
