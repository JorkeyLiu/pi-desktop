import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  MAX_CLIPBOARD_REFERENCES,
  MAX_CLIPBOARD_TEXT_CHARS,
  allocateChipTokens,
  composerClipboardSlice,
  parseComposerClipboard,
  placeComposerPaste,
  planComposerPaste,
} = await import("../src/features/chat/composer/clipboard.ts");
const {
  clipboardFiles,
  createFileReference,
  isChipTokenChar,
  normalizeClipboardLineEndings,
  preferClipboardText,
} = await import("../src/features/chat/composer/editor.ts");

const image = (path, token) =>
  createFileReference(path, path.split("/").at(-1), "draft-a", {
    kind: "image",
    mimeType: "image/png",
    token,
  });
const file = (path, token) =>
  createFileReference(path, path.split("/").at(-1), "draft-a", {
    kind: "file",
    token,
  });
const session = (id, token) =>
  createFileReference(id, `Session · ${id.slice(0, 8)}`, "draft-a", {
    kind: "session",
    token,
  });
const mark = (token, send) =>
  createFileReference("", "mark", "draft-a", {
    kind: "file",
    token,
    plugin: { kind: "mark", pluginId: "demo", send },
  });
const pluginAttachment = (path, token) =>
  createFileReference(path, path.split("/").at(-1), "draft-a", {
    kind: "file",
    token,
    plugin: { kind: "attachment", pluginId: "demo", id: "a1", size: 4 },
  });

/** No renderer sentinel may reach a clipboard a plain-text consumer reads. */
const sentinels = (text) => Array.from(text).filter((char) => isChipTokenChar(char));

test("a mixed selection keeps text, chips, and their order", () => {
  const first = image("/scratch/draft-a/a.png", "\uE010");
  const second = file("src/main.ts", "\uE011");
  const text = `look \uE010 and \uE011 twice`;
  const slice = composerClipboardSlice(text, [first, second], { start: 5, end: 12 }, "draft-a");
  assert.deepEqual(
    slice.parts.map((part) => ("ref" in part ? part.ref.path : part.text)),
    ["/scratch/draft-a/a.png", " and ", "src/main.ts"],
  );
  assert.deepEqual(slice.references.map((reference) => reference.path), [
    "/scratch/draft-a/a.png",
    "src/main.ts",
  ]);
  assert.equal(slice.plainText, "@/scratch/draft-a/a.png and @src/main.ts");
  assert.deepEqual(sentinels(slice.plainText), []);
  assert.equal(JSON.stringify(slice.payload).includes("\uE010"), false,
    "the clipboard payload must not carry a sentinel");
});

test("adjacent chips keep their order and stay readable", () => {
  const first = image("/scratch/draft-a/a.png", "\uE001");
  const second = image("/scratch/draft-a/b.png", "\uE002");
  const slice = composerClipboardSlice("\uE001\uE002", [first, second], { start: 0, end: 2 }, "draft-a");
  assert.equal(slice.references.length, 2);
  assert.deepEqual(slice.parts, [
    { ref: { kind: "image", path: "/scratch/draft-a/a.png", name: "a.png", mimeType: "image/png" } },
    { ref: { kind: "image", path: "/scratch/draft-a/b.png", name: "b.png", mimeType: "image/png" } },
  ]);
  assert.equal(slice.plainText, "@/scratch/draft-a/a.png @/scratch/draft-a/b.png");
});

test("partial text and newlines survive the copy exactly", () => {
  const only = file("src/index.ts", "\uE020");
  const text = "one\ntwo\uE020three\nfour";
  const slice = composerClipboardSlice(text, [only], { start: 4, end: 13 }, "draft-a");
  assert.equal(slice.text, "two\uE020three");
  assert.deepEqual(slice.parts, [
    { text: "two" },
    { ref: { kind: "file", path: "src/index.ts", name: "index.ts" } },
    { text: "three" },
  ]);
  assert.equal(slice.plainText, "two@src/index.ts three");
});

test("a text-only selection carries no structured payload", () => {
  const ref = image("/scratch/draft-a/a.png", "\uE001");
  const slice = composerClipboardSlice("plain words", [ref], { start: 0, end: 5 }, "draft-a");
  assert.deepEqual(slice.parts, [{ text: "plain" }]);
  assert.equal(slice.payload, undefined);
  assert.equal(slice.plainText, "plain");
});

test("plugin chips and other unsupported references degrade to readable text", () => {
  const folded = mark("\uE030", "«folded mark»");
  const staged = pluginAttachment("/scratch/draft-a/plugin.bin", "\uE031");
  const linked = session("session-abc", "\uE032");
  const text = "a\uE030b\uE031c\uE032d";
  const slice = composerClipboardSlice(text, [folded, staged, linked], { start: 0, end: text.length }, "draft-a");
  assert.deepEqual(slice.references.map((reference) => reference.kind), ["session"],
    "only portable references travel as chips");
  assert.equal(
    slice.plainText,
    "a«folded mark» b@/scratch/draft-a/plugin.bin cpi-desktop://session/session-abc d",
  );
  assert.deepEqual(sentinels(slice.plainText), []);
});

test("the payload is versioned, bounded, and carries no draft state", () => {
  const ref = image("/scratch/draft-a/a.png", "\uE001");
  const slice = composerClipboardSlice("x\uE001y", [ref], { start: 0, end: 3 }, "draft-a");
  assert.equal(slice.payload.v, 1);
  assert.equal(slice.payload.s, "draft-a");
  const json = JSON.stringify(slice.payload);
  assert.equal(json.includes("composer-file"), false, "renderer ids stay out of the clipboard");
  assert.equal(json.includes("plugin"), false, "plugin authority never travels");
  assert.ok(json.length < 512);
});

test("a valid payload parses and anything else is refused", () => {
  const good = {
    v: 1,
    s: "draft-a",
    parts: [
      { text: "see " },
      { ref: { kind: "image", path: "/scratch/draft-a/a.png", name: "a.png", mimeType: "image/png" } },
    ],
  };
  assert.deepEqual(parseComposerClipboard(JSON.stringify(good)), { ok: true, payload: good });
  for (const [raw, reason] of [
    [undefined, "absent"],
    [null, "absent"],
    ["", "absent"],
    ["not json", "malformed"],
    ["[]", "malformed"],
    [JSON.stringify({ v: 2, s: "draft-a", parts: [] }), "unsupported-version"],
    [JSON.stringify({ v: 1 }), "malformed"],
    [JSON.stringify({ v: 1, s: "draft-a", parts: [{ ref: { kind: "image", path: "x", name: "x", url: "https://evil" } }] }), "malformed"],
    [JSON.stringify({ v: 1, s: "draft-a", parts: [{ ref: { kind: "plugin", path: "x", name: "x" } }] }), "malformed"],
    [JSON.stringify({ v: 1, s: "draft-a", parts: [{ ref: { kind: "file", path: "a\nb", name: "x" } }] }), "malformed"],
    [JSON.stringify({ v: 1, s: "draft-a", parts: [{ text: 5 }] }), "malformed"],
    [JSON.stringify({ v: 1, s: "draft-a", parts: [{ ref: { kind: "session", path: "has space", name: "x" } }] }), "malformed"],
    [JSON.stringify({ v: 1, s: "draft-a", parts: [{ ref: { kind: "file", path: "", name: "x" } }] }), "malformed"],
    [JSON.stringify({ v: 1, s: "draft-a", parts: [{ text: "x".repeat(MAX_CLIPBOARD_TEXT_CHARS + 1) }] }), "too-large"],
    [JSON.stringify({ v: 1, s: "draft-a", parts: Array.from({ length: 600 }, () => ({ text: "x" })) }), "too-large"],
    [JSON.stringify({ v: 1, s: "draft-a", parts: Array.from({ length: 200 }, () => ({
      ref: { kind: "file", path: "x", name: "y" },
    })) }), "too-large"],
    [JSON.stringify({ v: 1, s: "draft-a\\n", parts: [] }), "malformed"],
    // The owner session is part of the format: without it a scratch reference
    // could claim an owner it does not have and be restored in the wrong draft.
    [JSON.stringify({ v: 1, parts: [{ ref: { kind: "file", path: "x", name: "y" } }] }), "malformed"],
  ]) {
    assert.deepEqual(parseComposerClipboard(raw), { ok: false, reason },
      `payload ${String(raw).slice(0, 40)}`);
  }
  assert.deepEqual(
    parseComposerClipboard(JSON.stringify({
      v: 1,
      s: "",
      parts: [{ ref: { kind: "file", path: "src/home.ts", name: "home.ts" } }],
    })),
    {
      ok: true,
      payload: {
        v: 1,
        s: "",
        parts: [{ ref: { kind: "file", path: "src/home.ts", name: "home.ts" } }],
      },
    },
    "an empty owner is the home draft, which still accepts portable references",
  );
  assert.ok(MAX_CLIPBOARD_REFERENCES < 200);
});

test("a paste keeps portable chips and degrades the rest to readable text", () => {
  const payload = {
    v: 1,
    s: "draft-a",
    parts: [
      { text: "see " },
      { ref: { kind: "image", path: "/scratch/draft-a/a.png", name: "a.png", mimeType: "image/png" } },
      { ref: { kind: "file", path: "src/main.ts", name: "main.ts" } },
      { ref: { kind: "file", path: `attachments/${"b".repeat(64)}`, name: "blob.bin" } },
      { ref: { kind: "session", path: "session-abc", name: "Session · session" } },
    ],
  };
  const same = planComposerPaste(payload, "draft-a");
  assert.equal(same.referenceCount, 4, "a copy inside its own draft keeps every chip");
  assert.deepEqual(same.parts.map((part) => ("ref" in part ? part.ref.path : part.text)), [
    "see ",
    "/scratch/draft-a/a.png",
    "src/main.ts",
    `attachments/${"b".repeat(64)}`,
    "session-abc",
  ]);
  const other = planComposerPaste(payload, "draft-b");
  assert.equal(other.referenceCount, 3, "another draft cannot resolve this draft's scratch file");
  assert.deepEqual(other.parts.filter((part) => "text" in part).map((part) => part.text), [
    "see ",
    "@/scratch/draft-a/a.png ",
  ]);
});

test("fresh chip tokens never collide with the draft or with each other", () => {
  const used = "\uE001\uE002\uE003text";
  const tokens = allocateChipTokens(3, used, [{ token: "\uE004" }, { token: "\uE005" }]);
  assert.equal(new Set(tokens).size, 3);
  for (const token of tokens) {
    assert.equal(token.length, 1);
    assert.equal(isChipTokenChar(token), true);
    assert.equal(used.includes(token), false,
      `token ${token.codePointAt(0)?.toString(16)} was already in the draft`);
  }
  const again = allocateChipTokens(2, used + tokens.join(""), []);
  assert.equal(again.some((token) => tokens.includes(token)), false,
    "a repeated paste reuses a chip token");
});

test("a placement inserts the payload in order with fresh tokens", () => {
  const plan = planComposerPaste(
    {
      v: 1,
      s: "draft-a",
      parts: [
        { text: "see " },
        { ref: { kind: "image", path: "images/a.png", name: "a.png", mimeType: "image/png" } },
        { text: " and " },
        { ref: { kind: "session", path: "session-abc", name: "Session · abc" } },
      ],
    },
    "draft-b",
  );
  assert.equal(plan.referenceCount, 2);
  const placed = placeComposerPaste(plan, ["\uE042", "\uE043"], "draft-b");
  assert.equal(placed.inserted, "see \uE042 and \uE043");
  assert.deepEqual(
    placed.references.map((reference) => [reference.path, reference.kind, reference.token, reference.sessionId]),
    [
      ["images/a.png", "image", "\uE042", "draft-b"],
      ["session-abc", "session", "\uE043", "draft-b"],
    ],
  );
});

// Existing clipboard-representation and editor-painting coverage, kept
// alongside the structured attachment-selection tests above.
const imageFile = () => new File(["image bytes"], "image.png", { type: "image/png" });
const noPath = () => null;

test("Word text wins over generated image representations", () => {
  assert.equal(
    preferClipboardText("  Word paragraph\n中文  ", [imageFile()], noPath),
    true,
  );
  assert.equal(preferClipboardText("text", [imageFile(), imageFile()], noPath), true);
});

test("image-only and blank-text clipboard payloads keep their images", () => {
  for (const text of ["", " \t\r\n"]) {
    assert.equal(preferClipboardText(text, [imageFile()], noPath), false);
  }
});

test("native image files and non-image files retain attachment semantics", () => {
  assert.equal(
    preferClipboardText("photo.png", [imageFile()], () => "/native/photo.png"),
    false,
  );
  assert.equal(
    preferClipboardText("photo.png", [imageFile()], () => "C:\\photos\\photo.png"),
    false,
  );
  assert.equal(
    preferClipboardText(
      "notes",
      [new File(["notes"], "notes.txt", { type: "text/plain" })],
      noPath,
    ),
    false,
  );
  assert.equal(
    preferClipboardText(
      "mixed files",
      [imageFile(), new File(["bytes"], "unknown.bin")],
      noPath,
    ),
    false,
  );
  const native = imageFile();
  assert.equal(
    preferClipboardText("images", [imageFile(), native], (file) =>
      file === native ? "/native.png" : null,
    ),
    false,
  );
});

test("clipboard FileList and item-only fallback both support text selection", () => {
  const file = imageFile();
  const items = [
    { kind: "string", getAsFile: () => null },
    { kind: "file", getAsFile: () => file },
  ];
  for (const data of [
    { files: [file], items },
    { files: [], items },
  ]) {
    const files = clipboardFiles(data);
    assert.deepEqual(files, [file]);
    assert.equal(preferClipboardText("Word", files, noPath), true);
  }
  assert.deepEqual(clipboardFiles({ files: [], items: [] }), []);
  assert.equal(preferClipboardText("plain text", [], noPath), false);
});

test("clipboard line endings normalize to the editor LF draft model", () => {
  assert.equal(normalizeClipboardLineEndings("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(normalizeClipboardLineEndings("no breaks"), "no breaks");
  assert.equal(normalizeClipboardLineEndings(""), "");
});

test("paintEditorValue preserves line breaks across DOM rendering", async () => {
  const { paintEditorValue, readEditorValue } = await import(
    "../src/features/chat/composer/editor.ts"
  );
  // Simple mock DOM container
  const container = {
    childNodes: [],
    replaceChildren() {
      this.childNodes = [];
    },
    appendChild(node) {
      this.childNodes.push(node);
      return node;
    },
  };
  globalThis.document = {
    createTextNode(text) {
      return { nodeType: 3, nodeValue: text };
    },
    createElement(tagName) {
      return {
        nodeType: 1,
        tagName: tagName.toUpperCase(),
        classList: { contains: () => false },
        childNodes: [],
      };
    },
  };
  globalThis.Node = {
    ELEMENT_NODE: 1,
    TEXT_NODE: 3,
  };

  paintEditorValue(
    container,
    "line 1\n\nline 2",
    new Map(),
    () => "",
    () => {},
    () => {},
  );

  assert.equal(container.childNodes.length, 4);
  assert.equal(container.childNodes[0].nodeValue, "line 1");
  assert.equal(container.childNodes[1].tagName, "BR");
  assert.equal(container.childNodes[2].tagName, "BR");
  assert.equal(container.childNodes[3].nodeValue, "line 2");
  assert.equal(readEditorValue(container), "line 1\n\nline 2");
});
