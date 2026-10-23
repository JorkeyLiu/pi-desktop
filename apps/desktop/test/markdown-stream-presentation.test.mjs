import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { presentStreamingMarkdown } from "../src/lib/markdown-stream-presentation.ts";

test("presents incomplete inline syntax safely while streaming", () => {
  for (const [source, expected] of [
    ["A **bold", "A **bold**"],
    ["A *soft", "A *soft*"],
    ["A ~~removed", "A ~~removed~~"],
    ["A ***strong emphasis", "A ***strong emphasis***"],
    ["Use file_name and 2 * 3", "Use file_name and 2 * 3"],
    ["A `code", "A `code"],
    ["Read [the label", "Read the label"],
    ["Read [label](https://secret.invalid/partial", "Read label"],
    ["A ![pending image](image.png", "A "],
    ["A ![alt](image.png)", "A ![alt](image.png)"],
  ]) {
    assert.equal(presentStreamingMarkdown(source).markdown, expected);
  }
});

test("preserves protected syntax and block grammar while streaming", () => {
  for (const source of [
    "```md\n**literal ./src/**/*",
    "~~~md\n**literal",
    "`**literal",
    String.raw`escaped \\* marker`,
    "$$\n**math",
    "\\[\n**math",
    "./src/**/*",
    "file_name and 2 * 3",
    "Read `./src/**/*",
  ]) {
    assert.equal(presentStreamingMarkdown(source).markdown, source);
  }
  for (const source of ["**done**", "$$x$$", "- list item", "| A | B |\n| --- |", "Title\n---"]) {
    assert.equal(presentStreamingMarkdown(source).markdown, source);
  }
  assert.equal(presentStreamingMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n").markdown,
    "| A | B |\n| --- | --- |\n| 1 | 2 |\n");
});

test("maps transformed presentation offsets to their original source", () => {
  const source = "prefix [label](https://secret.invalid/partial";
  const result = presentStreamingMarkdown(source);
  assert.equal(result.markdown, "prefix label");
  assert.equal(source.slice(result.sourceOffsets[7], result.sourceOffsets[12]), "label");
  assert.ok(result.sourceOffsets.every((offset) => offset >= 0 && offset <= source.length));
  assert.equal(result.sourceOffsets[result.markdown.length], 13);
});

test("incomplete inline code stays literal", () => {
  const source = "A `code";
  assert.equal(presentStreamingMarkdown(source).markdown, source);
});

test("presentation offsets never run past the retained label or dropped image", () => {
  const source = "prefix [label](https://label.example/partial";
  const link = presentStreamingMarkdown(source);
  assert.equal(link.markdown, "prefix label");
  assert.equal(link.sourceOffsets[link.markdown.length], source.indexOf("]("));
  assert.ok(link.sourceOffsets.every((offset) => offset >= 0 && offset <= source.length));

  const imageSource = "Settled. ![pending](image.png";
  const image = presentStreamingMarkdown(imageSource);
  assert.equal(image.markdown, "Settled. ");
  assert.equal(image.sourceOffsets[image.markdown.length], imageSource.indexOf("!["));

  const emphasis = presentStreamingMarkdown("A **bold");
  assert.equal(emphasis.markdown, "A **bold**");
  assert.equal(emphasis.sourceOffsets[emphasis.markdown.length], "A **bold".length);
});

test("repairs the tail without collapsing spans over completed markup", () => {
  for (const [source, emphasis] of [
    ["A ![alt](image.png) then **bold", "**bold"],
    ["Use `[a](b` now **bold", "**bold"],
    ["A ![one](one.png) ![two](two.png) then **bold", "**bold"],
    ["A ![alt](image.png) then ~~gone", "~~gone"],
    ["a!a!a!a **bold", "**bold"],
    ["日本語 **太字", "**太字"],
    ["é!é!é **bold", "**bold"],
  ]) {
    const result = presentStreamingMarkdown(source);
    assert.equal(result.markdown, `${source}${emphasis.startsWith("~~") ? "~~" : "**"}`);
    // Nothing before the closers changed, so every presented byte keeps its own
    // source index; only the added closers clamp.
    assert.deepEqual(
      result.sourceOffsets.slice(0, source.length + 1),
      Array.from({ length: source.length + 1 }, (_, index) => index),
    );
    assert.equal(result.sourceOffsets[source.indexOf(emphasis)], source.indexOf(emphasis));
    assert.equal(result.sourceOffsets[result.markdown.length], source.length);
    assert.ok(result.sourceOffsets.every((offset) => offset >= 0 && offset <= source.length));
  }
});

test("bounds an unfinished link or image to the bytes it retained", () => {
  const linkSource = "Settled text [label](https://secret.invalid/partial";
  const link = presentStreamingMarkdown(linkSource);
  assert.equal(link.markdown, "Settled text label");
  assert.equal(link.sourceOffsets[link.markdown.length], linkSource.indexOf("]("));
  assert.equal(linkSource.slice(link.sourceOffsets[13], link.sourceOffsets[18]), "label");

  const imageSource = "A ![x](y) ![z](w) ![pending](image.png";
  const image = presentStreamingMarkdown(imageSource);
  assert.equal(image.markdown, "A ![x](y) ![z](w) ");
  assert.equal(image.sourceOffsets[image.markdown.length], imageSource.lastIndexOf("!["));
  assert.deepEqual(
    image.sourceOffsets,
    Array.from({ length: image.markdown.length + 1 }, (_, index) => index),
  );

  const labelWithEmphasis = "Read [the label **bold";
  const mixed = presentStreamingMarkdown(labelWithEmphasis);
  assert.equal(mixed.markdown, "Read the label **bold**");
  assert.equal(mixed.sourceOffsets[5], 6);
  assert.equal(mixed.sourceOffsets[mixed.markdown.length], labelWithEmphasis.length);
});

test("leaves indented code and raw pre bodies literal while streaming", () => {
  for (const source of [
    "Settled paragraph.\n\n    **not bold",
    "Settled paragraph.\n\n\t**not bold",
    "Settled paragraph.\n\n<pre>**not bold",
    "Settled paragraph.\n\n<pre class=\"diff\">~~old",
  ]) {
    const result = presentStreamingMarkdown(source);
    assert.equal(result.markdown, source);
    assert.deepEqual(
      result.sourceOffsets,
      Array.from({ length: source.length + 1 }, (_, index) => index),
    );
  }
  // Paragraph indentation is not code, and a closed `<pre>` ends the literal
  // context, so both still repair.
  for (const source of [
    "Settled paragraph.\n\nA **bold",
    "Settled paragraph.\n\n  shallow **bold",
    "Settled paragraph.\n\n<pre>closed</pre> then **bold",
  ]) {
    assert.notEqual(presentStreamingMarkdown(source).markdown, source);
  }
});

test("protects code nested in a list or quote at any depth", () => {
  // Nested indentation is only code relative to its container's content column,
  // and a nested fence does not start its line with its marker, so the block
  // grammar decides. A repair here would show closers the finished message
  // never renders, and copying the block would carry them.
  for (const source of [
    ">     **not bold",
    "> >     **not bold",
    "- item\n\n      **not bold",
    "1. step\n\n       **not bold",
    "> ~~~\n> **bold",
    "- item\n\n  ~~~\n  **bold",
  ]) {
    const result = presentStreamingMarkdown(source);
    assert.equal(result.markdown, source);
    assert.deepEqual(
      result.sourceOffsets,
      Array.from({ length: source.length + 1 }, (_, index) => index),
    );
  }
  // A loose list item's own paragraph is prose, not code: four columns there sit
  // at the item's content column, so the emphasis inside it still closes early.
  // A closed nested fence is finished text, and text after it repairs as usual.
  for (const [source, expected] of [
    ["- item\n\n    continued **bold", "- item\n\n    continued **bold**"],
    ["> ```\n> x\n> ```\n>\n> A **bold", "> ```\n> x\n> ```\n>\n> A **bold**"],
    ["```\ncode\n```\n\nA **bold", "```\ncode\n```\n\nA **bold**"],
  ]) {
    const result = presentStreamingMarkdown(source);
    assert.equal(result.markdown, expected);
    assert.equal(result.sourceOffsets[result.markdown.length], source.length);
  }
});

test("counts math delimiters in prose, not inside finished code spans", () => {
  for (const source of [
    "Use `$$` as delimiter and **bold",
    "Use `\\[` as opener and **bold",
    "Use `<pre>` tag and **bold",
  ]) {
    const result = presentStreamingMarkdown(source);
    assert.equal(result.markdown, `${source}**`);
    assert.equal(result.sourceOffsets[result.markdown.length], source.length);
  }
  for (const source of ["$$\n**math", "\\[\n**math"]) {
    assert.equal(presentStreamingMarkdown(source).markdown, source);
  }
});

test("production Markdown renders the active tail and restores raw final syntax", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  try {
    globalThis.document = { documentElement: { dataset: {} } };
    const { Markdown } = await server.ssrLoadModule("/src/components/Markdown.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (source, streaming) => renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(Markdown, { source, streaming })),
    );

    const streamed = render("Settled paragraph.\n\nA **bold", true);
    assert.match(streamed, /<strong[^>]*>bold<\/strong>/);
    assert.match(streamed, /data-source-start="20"/);
    assert.match(streamed, /data-source-end="28"/);

    const partialLink = render("Settled.\n\nRead [label](https://secret.invalid/partial", true);
    assert.match(partialLink, /Read label/);
    assert.doesNotMatch(partialLink, /<a\b|secret\.invalid/);

    const partialImage = render("Settled.\n\n![pending](image.png", true);
    assert.doesNotMatch(partialImage, /<img\b/);

    for (const partialMath of ["Settled.\n\n$$\n**math", "Settled.\n\n\\[\n**math"]) {
      const literalMath = render(partialMath, true);
      assert.doesNotMatch(literalMath, /katex|math-display/);
      assert.match(literalMath, /\\*\\*math/);
    }

    const literalCode = render("Settled.\n\nA `code", true);
    assert.doesNotMatch(literalCode, /<code\b/);
    assert.match(literalCode, /A `code/);

    // A completed image or an earlier code span must not swallow the anchors
    // of emphasis that remend repaired after it.
    const afterImage = render("A ![alt](image.png) then **bold", true);
    assert.match(afterImage, /<strong data-source-start="25" data-source-end="31">bold<\/strong>/);
    assert.match(afterImage, /<p data-source-start="0" data-source-end="31">/);

    const quotedMath = render("Use `$$` as delimiter and **bold", true);
    assert.match(quotedMath, /<strong data-source-start="26" data-source-end="32">bold<\/strong>/);

    // Code text and copied text come from the presented markdown, so it has to
    // match the finished render exactly.
    const codeText = (html) =>
      [...html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)].map(([, text]) => text);
    const preText = (html) =>
      [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g)].map(([, text]) => text);
    for (const literalSource of [
      "Settled paragraph.\n\n    **not bold",
      "Settled paragraph.\n\n\t**not bold",
    ]) {
      const streamedCode = render(literalSource, true);
      assert.deepEqual(codeText(streamedCode), ["**not bold"]);
      assert.deepEqual(codeText(streamedCode), codeText(render(literalSource, false)));
      assert.doesNotMatch(streamedCode, /<strong\b/);
    }
    const rawPre = render("Settled paragraph.\n\n<pre>**not bold", true);
    assert.deepEqual(preText(rawPre), ["**not bold"]);
    assert.deepEqual(preText(rawPre), preText(render("Settled paragraph.\n\n<pre>**not bold", false)));

    // Nested code is what a copy would carry as characters: its text has to be
    // the finished text, with no closer the message never contained.
    for (const [nestedSource, expectedCode] of [
      [">     **not bold", "**not bold"],
      ["> >     **not bold", "**not bold"],
      ["- item\n\n      **not bold", "**not bold"],
      ["1. step\n\n       **not bold", "**not bold"],
      ["> ~~~\n> **bold", "**bold"],
      ["- item\n\n  ~~~\n  **bold", "**bold"],
    ]) {
      const streamedNested = render(nestedSource, true);
      assert.deepEqual(codeText(streamedNested), [expectedCode], nestedSource);
      assert.deepEqual(codeText(streamedNested), codeText(render(nestedSource, false)), nestedSource);
      assert.doesNotMatch(streamedNested, /<strong\b|<del\b/, nestedSource);
    }
    const looseList = render("- item\n\n    continued **bold", true);
    assert.match(looseList, /<strong[^>]*>bold<\/strong>/);
    assert.doesNotMatch(looseList, /<code\b/);

    const completed = render("Settled paragraph.\n\nA **bold", false);
    assert.doesNotMatch(completed, /<strong[^>]*>bold<\/strong>/);
    assert.match(completed, /A \*\*bold/);
  } finally {
    globalThis.document = originalDocument;
    await server.close();
  }
});
