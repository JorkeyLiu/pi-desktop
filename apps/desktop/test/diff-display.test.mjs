import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import {
  createDiffDisplayBudget,
  MAX_ESCAPED_DIFF_CHARS,
  takeDiffDisplayLine,
  takeDiffDisplayText,
} from "../src/lib/diff-display.ts";
import { fileMutationPreviewFromMessage } from "../src/lib/workspace-review.ts";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const renderedText = (segments) => segments.map((segment) => segment.text).join("");
const controls = [
  ...Array.from({ length: 0x20 }, (_, code) => code)
    .filter((code) => code !== 0x09 && code !== 0x0a)
    .map((code) => String.fromCodePoint(code)),
  ...Array.from({ length: 0x21 }, (_, code) => String.fromCodePoint(0x7f + code)),
];

test("the display tokenizer escapes C0, DEL, and C1 but preserves text layout", () => {
  const source = `${controls.join("")}\t\n汉字😀`;
  const before = source;
  const result = renderedText(takeDiffDisplayText(source, createDiffDisplayBudget()));
  for (const control of controls) {
    const code = control.codePointAt(0).toString(16).padStart(4, "0");
    assert(result.includes(`\\u${code}`), `missing escape for U+${code}`);
  }
  assert(result.endsWith("\t\n汉字😀"));
  assert.equal(source, before, "tokenization never mutates raw wire text");
});

test("generated escapes are distinct from literal backslash-u source text", () => {
  const result = takeDiffDisplayText("\\u0000\0", createDiffDisplayBudget());
  assert.deepEqual(result, [
    { text: "\\u0000", escaped: false },
    { text: "\\u0000", escaped: true },
  ]);
});

test("one line boundary spends its prefix exactly and never emits a partial escape", () => {
  const exact = createDiffDisplayBudget(7);
  const line = takeDiffDisplayLine(" ", "\0", exact);
  assert.deepEqual(line, {
    prefix: { text: " ", escaped: false },
    text: [{ text: "\\u0000", escaped: true }],
  });
  assert.equal(exact.remaining, 0);
  assert.equal(exact.truncated, false);

  const textOnly = createDiffDisplayBudget(6);
  assert.deepEqual(takeDiffDisplayLine("", "\0", textOnly), {
    prefix: null,
    text: [{ text: "\\u0000", escaped: true }],
  });
  assert.equal(textOnly.remaining, 0);

  const noPrefixRoom = createDiffDisplayBudget(0);
  assert.equal(takeDiffDisplayLine(" ", "\0", noPrefixRoom), null);
  assert.equal(noPrefixRoom.remaining, 0);
  assert.equal(noPrefixRoom.truncated, true);

  const escapeShort = createDiffDisplayBudget(6);
  assert.deepEqual(takeDiffDisplayLine(" ", "\0", escapeShort), {
    prefix: { text: " ", escaped: false },
    text: [],
  });
  assert.equal(escapeShort.remaining, 0);
  assert.equal(escapeShort.truncated, true);

  const across = createDiffDisplayBudget(4);
  takeDiffDisplayText("abc", across);
  assert.equal(across.remaining, 1);
  assert.deepEqual(takeDiffDisplayLine(" ", "d", across), {
    prefix: { text: " ", escaped: false },
    text: [],
  });
  assert.equal(across.truncated, true);
});

test("raw NUL remains in parsed per-call wire evidence", () => {
  const preview = {
    version: 1,
    path: "nul.txt",
    root: "workspace",
    operation: "edit",
    status: "modified",
    additions: 1,
    deletions: 1,
    hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: "a\0b" }] }],
  };
  const message = {
    id: "tool-1",
    role: "tool",
    content: "",
    createdAt: "2026-10-18T00:00:00.000Z",
    status: "complete",
    toolName: "Edit",
    toolCallId: "call-tool-1",
    toolStatus: "success",
    toolArgs: { path: "nul.txt" },
    toolResult: { details: { root: "workspace", editDiff: preview } },
  };
  assert.equal(fileMutationPreviewFromMessage(message)?.hunks[0].lines[0].text, "a\0b");
});

const hunks = [
  {
    header: "@@ -1 +1 @@",
    lines: [
      { type: "del", text: "before\0" },
      { type: "add", text: "after\0\u0085\u007f" },
    ],
  },
];

test("all three diff renderers produce escaped accessible DOM, not raw controls", async (t) => {
  const ssr = await slotSsr(t);
  const { ReviewDiffView } = await ssr.load("/src/components/ReviewChangeCard.tsx");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const { RemoteDiffHunks } = await ssr.load(
    "/src/components/remote/RemoteWorkspace.tsx",
  );
  const markup = [
    ssr.render(createElement(ReviewDiffView, { hunks })),
    ssr.render(
      createElement(ToolDetailBlocks, {
        blocks: [
          {
            kind: "diff",
            role: "diff",
            lines: hunks[0].lines,
            hidden: 0,
            copy: "",
          },
        ],
      }),
    ),
    ssr.render(createElement(RemoteDiffHunks, { hunks })),
  ];
  for (const html of markup) {
    assert.match(html, /\\u0000/);
    assert.match(html, /\\u007f/);
    assert.match(html, /\\u0085/);
    assert.match(html, /class="diff-control-escape"/);
    assert.match(html, /title="U\+0000"/);
    assert.match(html, /aria-label="U\+0000"/);
    assert(!html.includes("\0"), "no raw NUL reaches markup");
    assert(!html.includes("\u007f"), "no raw DEL reaches markup");
    assert(!html.includes("\u0085"), "no raw C1 reaches markup");
  }
  assert.match(markup[2], /\+after/, "remote hunks keep their diff signs");
});

test("a rendered escape is marked apart from literal backslash-u source text", async (t) => {
  const ssr = await slotSsr(t);
  const { ReviewDiffView } = await ssr.load("/src/components/ReviewChangeCard.tsx");
  const header = { header: "@@ -1 +1 @@", lines: [] };
  const literal = ssr.render(
    createElement(ReviewDiffView, {
      hunks: [{ ...header, lines: [{ type: "context", text: "\\u0000" }] }],
    }),
  );
  assert(literal.includes("\\u0000"), "literal source keeps its own characters");
  assert(!literal.includes("diff-control-escape"), "literal text is not marked as generated");

  const generated = ssr.render(
    createElement(ReviewDiffView, {
      hunks: [{ ...header, lines: [{ type: "context", text: "\0" }] }],
    }),
  );
  assert.equal((generated.match(/class="diff-control-escape"/g) ?? []).length, 1);
  assert.match(generated, /class="diff-control-escape" title="U\+0000" aria-label="U\+0000"/);
  assert(!generated.includes("\0"), "the generated escape replaces the raw control");
});

test("every NUL-heavy renderer stops creating lines at the post-escape cap", async (t) => {
  const ssr = await slotSsr(t);
  const { ReviewDiffView } = await ssr.load("/src/components/ReviewChangeCard.tsx");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const { RemoteDiffHunks } = await ssr.load(
    "/src/components/remote/RemoteWorkspace.tsx",
  );
  const raw = "\0".repeat(11_000);
  const trailingLines = Array.from({ length: 100 }, () => ({
    type: "context",
    text: "",
  }));
  const cappedHunks = [
    {
      header: "@@ -0,0 +1 @@",
      lines: [{ type: "add", text: raw }, ...trailingLines],
    },
  ];
  const markup = [
    ssr.render(createElement(ReviewDiffView, { hunks: cappedHunks })),
    ssr.render(
      createElement(ToolDetailBlocks, {
        blocks: [
          {
            kind: "diff",
            role: "diff",
            lines: cappedHunks[0].lines,
            hidden: 0,
            copy: "",
          },
        ],
      }),
    ),
    ssr.render(createElement(RemoteDiffHunks, { hunks: cappedHunks })),
  ];
  for (const html of markup) {
    const escapes = (html.match(/class="diff-control-escape"/g) ?? []).length;
    assert(escapes * 6 <= MAX_ESCAPED_DIFF_CHARS);
    assert(escapes > 10_000, "the raw 11 KiB NUL line was not escape-amplified");
    assert.match(html, /Diff is too large to show here/);
    assert(!html.includes("\0"), "rendering leaves no raw NUL in markup");
  }
  // Only the line the ceiling actually reaches may become DOM; the rest of the
  // hunk must stop being created instead of turning into empty rows.
  const reviewRows = (markup[0].match(/class="diff-line /g) ?? []).length;
  const toolRows = (markup[1].match(/class="diff-line /g) ?? []).length;
  assert(reviewRows <= 20, `review kept ${reviewRows} rows`);
  assert(toolRows <= 20, `tool detail kept ${toolRows} rows`);
  const remoteNewlines = (markup[2].match(/\n/g) ?? []).length;
  assert(remoteNewlines <= 2, `remote kept ${remoteNewlines} line breaks`);
  assert(reviewRows + toolRows + remoteNewlines < trailingLines.length);
  assert.equal(raw.length, 11_000, "rendering leaves the source payload unchanged");
});

test("all diff consumers share the one display tokenizer", async () => {
  const { readFile } = await import("node:fs/promises");
  const base = new URL("../src/components/", import.meta.url);
  for (const path of [
    "ReviewChangeCard.tsx",
    "ToolDetails.tsx",
    "remote/RemoteWorkspace.tsx",
  ]) {
    const source = await readFile(new URL(path, base), "utf8");
    assert.match(source, /from "\.\.(?:\/\.\.)?\/lib\/diff-display"/, path);
    assert.match(source, /renderDiffLine\(/, path);
    assert.doesNotMatch(source, /<span className="diff-line-text">\{line\.text\}<\/span>/, path);
  }
});

test("the generated escape chip is styled from theme tokens", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(
    new URL("../src/styles/work-panel.css", import.meta.url),
    "utf8",
  );
  const rule = css.match(/\.diff-control-escape\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /background:\s*var\(--ds-bg-chip\)/);
  assert.match(rule, /color:\s*var\(--ds-text-muted\)/);
  assert.match(rule, /border-radius:\s*var\(--radius-3xs\)/);
});
