import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { editSeedContent, hydrateUserMessageEdit, serializeUserMessageEdit, tagStagedEditReferences } =
  await import("../src/features/chat/composer/edit-draft.ts");
const { classifyClipboardIntake, clipboardFilePayload, insertStagedReferences, largeTextPayload } =
  await import("../src/features/chat/composer/attachment-intake.ts");
const { createFileReference, nextChipToken } =
  await import("../src/features/chat/composer/editor.ts");
const {
  draftFileReference,
  readComposerDraft,
  resetComposerDraftCache,
  writeComposerDraft,
} = await import("../src/lib/composer-draft-cache.ts");
const { formatPromptPathText } = await import("@pi-desktop/shared");

const SESSION = "edit-fixture";
const BLOB = `attachments/${"a".repeat(64)}`;

function durable(overrides = {}) {
  return {
    ref: BLOB,
    name: "inline-a.png",
    kind: "image",
    mimeType: "image/png",
    size: 70,
    inlinePath: "@/fixture/inline-a.png",
    ...overrides,
  };
}

test("hydrate turns a placed marker into a chip and appends unplaced chips", () => {
  const trailing = (() => { const attachment = durable({ ref: `attachments/${"b".repeat(64)}`, name: "b.png" }); delete attachment.inlinePath; return attachment; })();
  const { text, references, carried } = hydrateUserMessageEdit(
    "compare @/fixture/inline-a.png with the rest",
    [durable(), trailing],
    SESSION,
  );
  assert.equal(carried.length, 0);
  assert.equal(references.length, 2);
  const [placed, appended] = references;
  assert.equal(placed.placed, true);
  assert.equal(placed.marker, "@/fixture/inline-a.png");
  assert.equal(appended.placed, false);
  assert.ok(text.includes(placed.token));
  assert.ok(text.includes(appended.token));
  assert.ok(!text.includes("@/fixture/inline-a.png"));
  assert.ok(text.indexOf(placed.token) < text.indexOf(appended.token));
});

test("serialize round-trips placed markers and preserves durable fields", () => {
  const attachment = durable();
  const hydrated = hydrateUserMessageEdit(
    "compare @/fixture/inline-a.png with the rest",
    [attachment],
    SESSION,
  );
  const { content, attachments } = serializeUserMessageEdit(
    hydrated.text,
    hydrated.references,
    hydrated.carried,
  );
  assert.equal(content, "compare @/fixture/inline-a.png with the rest");
  assert.deepEqual(attachments, [attachment]);
});

test("deleting a chip removes its attachment while survivors stay trailing", () => {
  const trailing = (() => { const attachment = durable({ ref: `attachments/${"b".repeat(64)}`, name: "b.png" }); delete attachment.inlinePath; return attachment; })();
  const hydrated = hydrateUserMessageEdit("look at this", [durable(), trailing], SESSION);
  // The user deletes the first chip; the trailing one stays.
  const removed = hydrated.text.replace(hydrated.references[0].token, "");
  const { content, attachments } = serializeUserMessageEdit(
    removed,
    hydrated.references,
    hydrated.carried,
  );
  assert.equal(content, "look at this");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].ref, trailing.ref);
  assert.ok(!("inlinePath" in attachments[0]));
});

test("empty text with attachments still resends the attachments", () => {
  const hydrated = hydrateUserMessageEdit("", [durable()], SESSION);
  const { content, attachments } = serializeUserMessageEdit(
    hydrated.text,
    hydrated.references,
    hydrated.carried,
  );
  assert.equal(content, "");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].inlinePath, "@/fixture/inline-a.png");
});

test("staged chips serialize to @path markers with recorded placement", () => {
  const hydrated = hydrateUserMessageEdit("see this ", [], SESSION);
  const staged = [{ path: "/scratch/pasted-x.png", name: "pasted-x.png", kind: "image", mimeType: "image/png", size: 12 }];
  const placed = insertStagedReferences({
    text: hydrated.text,
    references: hydrated.references,
    start: hydrated.text.length,
    end: hydrated.text.length,
    staged,
    sessionId: SESSION,
  });
  tagStagedEditReferences(placed.references, staged.length);
  const { content, attachments } = serializeUserMessageEdit(
    placed.text,
    placed.references,
    hydrated.carried,
  );
  assert.equal(content, `see this @/scratch/pasted-x.png`);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].ref, "/scratch/pasted-x.png");
  assert.equal(attachments[0].inlinePath, "@/scratch/pasted-x.png");
});

test("non-renderable attachments ride through untouched", () => {
  const sessionRef = { ref: "session-1", name: "Conversation", kind: "session" };
  const hydrated = hydrateUserMessageEdit("hello", [durable(), sessionRef], SESSION);
  assert.equal(hydrated.references.length, 1);
  assert.deepEqual(hydrated.carried, [sessionRef]);
  const { attachments } = serializeUserMessageEdit(
    hydrated.text,
    hydrated.references,
    hydrated.carried,
  );
  assert.deepEqual(attachments[0], sessionRef);
});

test("classifyClipboardIntake routes files, Word text, and large text", () => {
  const image = new File([new Uint8Array([1, 2])], "a.png", { type: "image/png" });
  assert.equal(
    classifyClipboardIntake({ text: "", files: [image], largePasteThreshold: 600, resolveNativePath: () => null }),
    "files",
  );
  // Word copies text plus a synthesized image: the text stays editable.
  assert.equal(
    classifyClipboardIntake({ text: "hello", files: [image], largePasteThreshold: 600, resolveNativePath: () => null }),
    "plain-text",
  );
  // Explicit native files are never downgraded to text.
  assert.equal(
    classifyClipboardIntake({ text: "hello", files: [image], largePasteThreshold: 600, resolveNativePath: () => "/native/a.png" }),
    "files",
  );
  assert.equal(
    classifyClipboardIntake({ text: "x".repeat(601), files: [], largePasteThreshold: 600, resolveNativePath: () => null }),
    "large-text",
  );
  assert.equal(
    classifyClipboardIntake({ text: "short", files: [], largePasteThreshold: 600, resolveNativePath: () => null }),
    "plain-text",
  );
});

test("clipboard payloads keep bytes and provenance", async () => {
  const file = new File([new Uint8Array([9, 9])], "a.png", { type: "image/png" });
  const [payload] = await clipboardFilePayload([file]);
  assert.equal(payload.name, "a.png");
  assert.equal(payload.mimeType, "image/png");
  assert.equal(new Uint8Array(payload.data)[0], 9);
  const [large] = largeTextPayload("hello");
  assert.match(large.name, /^pasted-text-.*\.txt$/);
  assert.equal(large.origin, "auto-text");
  assert.equal(large.recordHistory, true);
});

test("insertStagedReferences splices chips at the caret and rebinds only on demand", () => {
  const staged = [{ path: "/s/p.png", name: "p.png", kind: "image", mimeType: "image/png", size: 3 }];
  const first = insertStagedReferences({
    text: "ab",
    references: [],
    start: 1,
    end: 1,
    staged,
    sessionId: SESSION,
  });
  assert.equal(first.caret, 2);
  assert.equal(first.text.length, 3);
  assert.equal(first.references.length, 1);
  assert.equal(first.references[0].sessionId, SESSION);

  const existing = [{ path: "/old", name: "old", sessionId: "old", token: first.text[1] }];
  const kept = insertStagedReferences({
    text: first.text,
    references: existing,
    start: 0,
    end: 0,
    staged,
    sessionId: SESSION,
  });
  assert.equal(kept.references[0], existing[0]);

  const rebound = insertStagedReferences({
    text: first.text,
    references: existing,
    start: 0,
    end: 0,
    staged,
    sessionId: SESSION,
    rebindSessionId: SESSION,
  });
  assert.notEqual(rebound.references[0], existing[0]);
  assert.equal(rebound.references[0].sessionId, SESSION);
  assert.equal(formatPromptPathText("/s/p.png"), "@/s/p.png");
});

test("editSeedContent seeds the typed command when present, else stored content", () => {
   // Baseline slash contract: the original typed invocation seeds the draft so
   // retrying re-expands the template; the stored expansion is not prepended.
   assert.equal(editSeedContent("/review logs", "Expanded template body for payment logs."), "/review logs");
   assert.equal(editSeedContent(undefined, "plain body"), "plain body");
   assert.equal(editSeedContent("", "plain body"), "plain body");
   assert.equal(editSeedContent("/review logs", ""), "/review logs");
});
test("a long non-command message keeps its canonical full content", () => {
   const content = `${"INFO normal request\n".repeat(4000)}FATAL payment timeout`;
   assert.equal(editSeedContent(undefined, content), content);
});

test("pick/paste staging persists each chip once across a draft restore", () => {
  // One existing attachment chip plus one staged file: `insertStagedReferences`
  // returns retained-plus-new, so the persisted rows must be exactly the
  // placed references. Prepending the previous list again writes three rows
  // and the next draft restore repaints a duplicated retained chip.
  const keptToken = nextChipToken();
  const kept = createFileReference("/kept.png", "kept.png", SESSION, {
    kind: "image",
    mimeType: "image/png",
    token: keptToken,
  });
  const before = `compare ${keptToken} now`;
  const placed = insertStagedReferences({
    text: before,
    references: [kept],
    start: before.length,
    end: before.length,
    staged: [{ path: "/new.png", name: "new.png", kind: "image", mimeType: "image/png", size: 4 }],
    sessionId: SESSION,
  });
  assert.equal(placed.references.length, 2);
  resetComposerDraftCache();
  try {
    writeComposerDraft(SESSION, {
      text: placed.text,
      fileReferences: placed.references.map((reference) => draftFileReference(reference)),
    });
    const restored = readComposerDraft(SESSION);
    assert.equal(restored?.fileReferences.length, 2);
    assert.deepEqual(
      restored?.fileReferences.map((row) => row.token),
      placed.references.map((reference) => reference.token),
    );
    assert.deepEqual(
      restored?.fileReferences.map((row) => row.path),
      ["/kept.png", "/new.png"],
    );
  } finally {
    resetComposerDraftCache();
  }
});

test("the composer pick/paste persist keeps each staged chip once", () => {
  // Guards the hook composition the test above covers: both the pick and the
  // file/large-text paste sites must persist exactly `placed.references`.
  const hook = readFileSync(
    new URL("../src/features/chat/composer/hooks/useComposerAttachments.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(hook, /\.\.\.previousReferences,\s*\n\s*\.\.\.placed\.references\.map/);
  const persists = hook.match(/fileReferences: placed\.references\.map\(/g) ?? [];
  assert.equal(persists.length, 2);
});
