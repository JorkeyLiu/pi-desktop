import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { thinkingPreview } from "../src/lib/thinking-preview.ts";

/*
 * A collapsed reasoning row is a label plus one line. The line is the opening
 * the model itself wrote — a leading heading or standalone bold line, otherwise
 * the opening paragraph — with its Markdown presentation removed but its text
 * kept. These cases render the real `ThinkingRow` through Vite SSR, so the same
 * component, store, i18n catalogue and disclosure wiring the transcript mounts
 * are exercised, and the assertions read the rendered row rather than a copy of
 * the cleaning rules.
 */

let server;
let ThinkingRow;
let i18n;
let originalDocument;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  // Components read the theme off the document during render.
  originalDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: {} } };
  ({ ThinkingRow } = await server.ssrLoadModule(
    "/src/features/chat/transcript/shared.tsx",
  ));
  i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
  });
});

after(async () => {
  globalThis.document = originalDocument;
  await server.close();
});

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

function decode(html) {
  return html.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]);
}

function thinkingMessage(thinking, extra = {}) {
  return {
    id: "thinking-row-preview",
    role: "assistant",
    content: "",
    thinking,
    createdAt: "2026-10-21T00:00:00.000Z",
    ...extra,
  };
}

function renderRow(thinking, { open = false, streaming = false } = {}) {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ThinkingRow, {
        message: thinkingMessage(thinking, streaming ? { status: "streaming" } : {}),
        streaming,
        autoOpen: open,
      }),
    ),
  );
}

/** The one-line preview as rendered, or null when the row draws none. */
function previewText(markup) {
  const span = markup.match(
    /<span class="tool-row-summary thinking-preview[^"]*">([\s\S]*?)<\/span>/,
  );
  return span ? decode(span[1]) : null;
}

test("a headed reasoning message previews the heading alone", () => {
  const collapsed = renderRow(
    "## Reading the transcript\n\nThen the body continues here.",
  );
  assert.equal(previewText(collapsed), "Reading the transcript");
  assert.ok(!collapsed.includes("##"), "the collapsed row still shows the ATX marker");
  assert.ok(
    !collapsed.includes("Then the body continues here."),
    "the collapsed row repeated the paragraph behind the heading",
  );
});

test("a trailing closing hashes on a heading are presentation", () => {
  assert.equal(
    previewText(renderRow("### Anchor the row ###\n\nBody.")),
    "Anchor the row",
  );
});

test("a standalone bold opening line is the preview", () => {
  const collapsed = renderRow(
    "**Anchor the preview**\n\nThe paragraph after it.",
  );
  assert.equal(previewText(collapsed), "Anchor the preview");
  assert.ok(!collapsed.includes("**"), "the collapsed row still shows bold markers");
});

test("ordinary prose previews its cleaned opening paragraph only", () => {
  const collapsed = renderRow(
    "The first paragraph names `tool-row-summary` and [the rule](https://example.com/x) *why* it exists.\n\nThe second paragraph is a different block.",
  );
  const preview = previewText(collapsed);
  assert.equal(
    preview,
    "The first paragraph names tool-row-summary and the rule why it exists.",
  );
  assert.ok(!collapsed.includes("The second paragraph"));
  for (const marker of ["`", "](", "*", "https://example.com"]) {
    assert.ok(!preview.includes(marker), `the preview leaked ${marker}`);
  }
});

test("streaming later reasoning never moves the preview off its opening", () => {
  const opening = "## Anchor the preview\n\nThe first paragraph.";
  const settled = renderRow(opening);
  const streaming = renderRow(`${opening}\n\nThe newest line arrives last.`);
  assert.equal(previewText(streaming), previewText(settled));
  assert.equal(previewText(streaming), "Anchor the preview");
  assert.ok(!streaming.includes("The newest line arrives last."));
});

test("a corrected opening updates the preview instead of reusing a stale one", () => {
  assert.equal(previewText(renderRow("## First idea\n\nBody.")), "First idea");
  assert.equal(previewText(renderRow("## Second idea\n\nBody.")), "Second idea");
  assert.equal(
    previewText(renderRow("**First idea**\n\nBody.")),
    "First idea",
  );
  assert.equal(
    previewText(renderRow("**Second idea**\n\nBody.")),
    "Second idea",
  );
});

test("reasoning with no visible text draws the label only", () => {
  for (const thinking of ["", "   \n\n  "]) {
    const collapsed = renderRow(thinking);
    assert.equal(previewText(collapsed), null);
    assert.ok(collapsed.includes(">Thinking<"), "the localized label is missing");
    assert.ok(!collapsed.includes("tool-row-body"));
  }
});

test("the open row drops the preview and keeps the full Markdown body", () => {
  const source = "## Reading the transcript\n\nThen *the* body continues here.";
  const open = renderRow(source, { open: true });
  assert.equal(previewText(open), null);
  assert.ok(open.includes('aria-expanded="true"'));
  assert.ok(open.includes("thinking-prose"));
  assert.ok(open.includes("<h2"), "the body lost its heading");
  assert.ok(/<em[^>]*>the<\/em>/.test(open), "the body lost its emphasis");
  assert.ok(/Then <em[^>]*>the<\/em> body continues here\./.test(open));
  assert.ok(open.includes("Reading the transcript"));
});

test("the collapsed row keeps its disclosure contract", () => {
  const collapsed = renderRow("## Reading the transcript");
  assert.equal(previewText(collapsed), "Reading the transcript");
  assert.ok(collapsed.includes('aria-expanded="false"'));
  assert.ok(collapsed.includes('aria-label="Show thinking"'));
  const controls = collapsed.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controls, "the header lost its aria-controls target");
  assert.ok(!collapsed.includes(`id="${controls}"`), "a closed row rendered its body");
});

// Compact mode renders the active indicator from the store's *initial* state in
// SSR, so it is asserted in the rendered Electron probe instead.

/*
 * Presentation the row must drop while keeping the words inside it. These read
 * the preview directly, where a case is only about the one-line reading and not
 * about anything the row around it draws.
 */
test("inline presentation is unwrapped, not displayed", () => {
  const preview = thinkingPreview(
    "![diagram of the row](asset://row.png) and `code` plus [label](https://example.com) " +
      "with ~~old~~ **strong** _soft_ text",
  );
  assert.deepEqual(preview, {
    heading: null,
    body:
      "diagram of the row and code plus label with old strong soft text",
  });
});

test("a keyword with underscores stays readable", () => {
  assert.equal(
    thinkingPreview("Check tool_row_summary before the rename.")?.body,
    "Check tool_row_summary before the rename.",
  );
});

test("escaped markers stay literal text", () => {
  assert.equal(
    thinkingPreview("The glob \\*\\* matches everything.")?.body,
    "The glob ** matches everything.",
  );
});

test("list, quote, table and heading furniture never leaks into the line", () => {
  assert.equal(thinkingPreview("- First idea\n- Second idea")?.body, "First idea Second idea");
  assert.equal(thinkingPreview("> Quoted opening")?.body, "Quoted opening");
  assert.equal(thinkingPreview("| a | b |")?.body, "a b");
  assert.equal(thinkingPreview("1. Ordered opening")?.body, "Ordered opening");
  assert.equal(thinkingPreview("---\n\nReal opening")?.body, "Real opening");
  assert.equal(thinkingPreview("```ts\nconst a = 1;\n```")?.body, "const a = 1;");
});

test("a heading line with no words falls through to readable text", () => {
  assert.equal(thinkingPreview("##\n\nReal opening")?.body, "Real opening");
  assert.deepEqual(thinkingPreview("<!-- generated -->"), null);
  assert.deepEqual(thinkingPreview("   \n\n"), null);
});

test("a long opening is bounded but keeps its first words", () => {
  const opening = Array.from({ length: 4000 }, () => "word").join(" ");
  const preview = thinkingPreview(opening);
  assert.ok(preview.body.startsWith("word word word"));
  assert.ok(preview.body.length <= 2000);
});
