import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readComposerModule, readComposerSource } from "./helpers/composer-source.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [composer, editor, hoverCard, hoverHook, card, cardStyles, styles, submitHook] = await Promise.all([
  readComposerSource(),
  readComposerModule("editor.ts"),
  readComposerModule("ComposerImageHoverPreview.tsx"),
  readComposerModule("hooks/useComposerImageHover.ts"),
  read("../src/components/ImageHoverCard.tsx"),
  read("../src/styles/image-hover-card.css"),
  read("../src/styles/composer-image-preview.css"),
  readComposerModule("hooks/useComposerSubmit.ts"),
]);

test("pasted images become inline reference tokens like every other attachment", () => {
  assert.match(composer, /export function isImageReferenceLabel\(reference: ComposerFileReference\): boolean/);
  assert.match(composer, /if \(isImageReferenceLabel\(reference\)\) element\.dataset\.image = ""/);
  // Activating an image reference opens the preview; it never expands draft text.
  assert.match(composer, /if \(isImageReferenceLabel\(reference\)\) return "open-image-preview"/);
  assert.match(editor, /el\.appendChild\(buildReferenceElement\(reference, char\)\)/);
  assert.match(
    composer,
    /if \(isImageReference\(reference\)\) \{\n      imagePreview\.open\(reference\);\n      return;/,
  );
  // The detached attachment row above the input shell is gone.
  assert.doesNotMatch(composer, /ComposerImageAttachments/);
  assert.doesNotMatch(styles, /\.composer-image-attachments/);
  assert.doesNotMatch(styles, /\.composer-image-attachment\b/);
});

test("hovering an image chip reveals a read-only preview card", () => {
  assert.match(composer, /<ComposerImageHover controller=\{imagePreview\} editorRef=\{inputRef\} \/>/);
  assert.match(
    hoverHook,
    /closest<HTMLElement>\(IMAGE_REFERENCE_SELECTOR\)/,
  );
  assert.match(composer, /const IMAGE_REFERENCE_SELECTOR = `\$\{REFERENCE_SELECTOR\}\[data-image\]`/);
  assert.match(hoverHook, /getBoundingClientRect\(\)/);
  // A chip that moves under the pointer must not leave a stale card behind.
  assert.match(hoverHook, /editor\.addEventListener\("input", hide\)/);
  // One shared card serves the draft and the transcript.
  assert.match(hoverCard, /<ImageHoverCard/);
  assert.match(hoverCard, /anchor=\{target\?\.anchor \?\? null\}/);
  assert.match(card, /className="image-hover-card"/);
  assert.match(card, /data-placement=\{placement\}/);
  assert.match(cardStyles, /\.image-hover-card img \{[\s\S]*?max-width: min\(240px, 40vw\)/);
  assert.match(cardStyles, /\.image-hover-card \{[\s\S]*?pointer-events: none/);
  // The modal owns the open image; the card would only be noise behind it.
  assert.match(hoverCard, /const target = controller\.preview \? null : hover;/);
});

test("image tokens stay in the prompt so the image keeps its place", () => {
  // The chip's `@path` reaches main inline, which records it on the attachment
  // and sends the image block at that position; only the bytes travel detached.
  assert.match(
    submitHook,
    /const inlineContent = serializeInlineComposerFileReferences\(rawText, activeFileReferences\);/,
  );
  assert.match(submitHook, /const serializedContent = serializeComposerFileReferences\(rawText, activeFileReferences\);/);
  assert.doesNotMatch(submitHook, /detachImageTokens/);
  assert.match(submitHook, /const submittedDraft = draft\.draftSnapshot\(rawText\);/);
  assert.match(composer, /attachImageTokens\(/);
});
