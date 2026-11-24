import assert from "node:assert/strict";
import test from "node:test";
import {
  appendQuoteToDraft,
  buildQuoteText,
  MAX_QUOTE_CHARS,
  quoteExcerpt,
} from "../src/lib/chat-quotes.ts";

test("a blank selection carries nothing and never falls back to surrounding text", () => {
  assert.equal(quoteExcerpt(""), "");
  assert.equal(quoteExcerpt("   "), "");
  assert.equal(quoteExcerpt("  \n\t "), "");
});

test("a selection is carried exactly, with surrounding whitespace trimmed", () => {
  assert.equal(quoteExcerpt("  only this phrase  "), "only this phrase");
  assert.equal(quoteExcerpt("first\r\nsecond"), "first\nsecond");
});

test("a long selection is cut and marked with an ellipsis", () => {
  const excerpt = quoteExcerpt("x".repeat(MAX_QUOTE_CHARS + 500));
  assert.equal(excerpt.length, MAX_QUOTE_CHARS + 1);
  assert.ok(excerpt.endsWith("…"));
});

test("a quote is a markdown blockquote of the excerpt", () => {
  assert.equal(
    buildQuoteText("only this phrase"),
    "> only this phrase",
  );
  assert.equal(
    buildQuoteText("first\n\nsecond"),
    "> first\n>\n> second",
  );
});

test("quoting adds to the existing draft instead of replacing it", () => {
  assert.equal(
    appendQuoteToDraft("keep me", "> quoted"),
    "keep me\n\n> quoted",
  );
  assert.equal(appendQuoteToDraft("", "> quoted"), "> quoted");
  assert.equal(appendQuoteToDraft("keep me   ", "> quoted"), "keep me\n\n> quoted");
});
