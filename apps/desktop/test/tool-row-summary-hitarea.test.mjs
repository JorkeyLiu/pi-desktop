import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The collapsed tool-row head states counts, never the directory — and only
 * the rendered file name preview-opens.
 *
 * A collapsed file row names its file: the layout span keeps the row's
 * alignment and ellipsis, the file name inside it carries the full-path hover
 * text, the preview click and the file menu, and the blank flex area toggles
 * the row like every other header cell. The scratch/external roots stay in
 * the result payload, the preview target and the file menu; the head drops
 * only their badges, and every other chip stays.
 */

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const createdAt = "2026-10-18T00:00:00.000Z";

const readMessage = (details, args) => ({
  id: "read-1",
  role: "tool",
  content: "",
  createdAt,
  status: "complete",
  toolName: "Read",
  toolCallId: "call-read-1",
  toolStatus: "success",
  toolArgs: { path: "src/dir/a.ts", offset: 3, lineCount: 7, ...args },
  toolResult: { content: [{ type: "text", text: "{}" }], details },
});

const editMessage = (details, args = {}) => ({
  id: "edit-1",
  role: "tool",
  content: "",
  createdAt,
  status: "complete",
  toolName: "Edit",
  toolCallId: "call-edit-1",
  toolStatus: "success",
  toolArgs: { path: "source.txt", tag: "abcd", ops: "PUT 2.=2:\n+TWO\n", ...args },
  toolResult: { content: [{ type: "text", text: "{}" }], details },
});

const previewDiff = (overrides = {}) => ({
  version: 1,
  path: "source.txt",
  root: "scratch",
  operation: "edit",
  status: "modified",
  additions: 1,
  deletions: 1,
  hunks: [
    {
      header: "@@ -1,2 +1,2 @@",
      lines: [
        { type: "context", text: "one" },
        { type: "del", text: "two" },
        { type: "add", text: "TWO" },
      ],
    },
  ],
  ...overrides,
});

/** The header's chip labels, in render order. */
function chipTexts(host) {
  return [...host.matchAll(/<span class="tool-chip"[^>]*>([^<]*)<\/span>/g)].map(
    (match) => match[1],
  );
}

test("the header drops the scratch root but keeps the Read range", async (t) => {
  const ssr = await slotSsr(t);
  const { headerToolChips, toolResultChips } = await ssr.load(
    "/src/lib/tool-presentation.ts",
  );
  const message = readMessage({
    path: "src/dir/a.ts",
    root: "scratch",
    offset: 3,
    lineCount: 7,
  });
  // The producer still carries the root for the preview target and file menu.
  assert.deepEqual(toolResultChips(message), [
    { role: "lines", text: "7,L4-L10" },
    { role: "scratch" },
  ]);
  // The collapsed head prints the range, never the directory.
  assert.deepEqual(headerToolChips(message), [{ role: "lines", text: "7,L4-L10" }]);
});

test("the header drops the external root from an edit preview", async (t) => {
  const ssr = await slotSsr(t);
  const { headerToolChips, toolResultChips } = await ssr.load(
    "/src/lib/tool-presentation.ts",
  );
  const message = editMessage({
    path: "source.txt",
    root: "external",
    editDiff: previewDiff({ root: "external", path: "source.txt" }),
  });
  assert.ok(
    toolResultChips(message).some((chip) => chip.role === "external"),
    "the producer keeps the external root",
  );
  assert.ok(
    headerToolChips(message).every((chip) => chip.role !== "external"),
    "the head shows no external badge",
  );
  assert.ok(
    headerToolChips(message).every((chip) => chip.role !== "scratch"),
    "the head shows no scratch badge either",
  );
});

test("the header keeps every non-directory chip", async (t) => {
  const ssr = await slotSsr(t);
  const { headerToolChips } = await ssr.load("/src/lib/tool-presentation.ts");
  assert.deepEqual(
    headerToolChips({
      toolName: "Bash",
      toolResult: {
        content: [{ type: "text", text: "{}" }],
        details: { exitCode: 2, truncated: true, bytes: 512 },
      },
    }),
    [{ role: "exit", count: 2 }, { role: "size", text: "512 B" }, { role: "truncated" }],
  );
  assert.deepEqual(
    headerToolChips({
      toolName: "Grep",
      toolResult: {
        content: [{ type: "text", text: "{}" }],
        details: { count: 3, matches: [{ path: "a.ts" }] },
      },
    }),
    [{ role: "matches", count: 3 }],
  );
});

test("a collapsed scratch Read names its file, keeps its range, shows no root badge", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const path = "src/dir/a-very-long-file-name-that-keeps-going.ts";
  const host = ssr.render(
    createElement(ToolRow, {
      message: readMessage({ path, root: "scratch", offset: 3, lineCount: 7 }, { path }),
    }),
  );
  // The layout span keeps the row's shape and carries no link affordance.
  assert.match(host, /<span class="tool-row-summary is-path">/);
  assert.doesNotMatch(host, /<span class="tool-row-summary[^>]*linked/);
  // Only the rendered file name links, with the whole path as its hover text.
  assert.ok(
    host.includes(
      `<span class="tool-row-file-name linked" title="${path}">a-very-long-file-name-that-keeps-going.ts</span>`,
    ),
    "the file name element carries the basename and the full-path tooltip",
  );
  // The range chip stays, the scratch chip is gone, the row stays collapsed.
  assert.deepEqual(chipTexts(host), ["7,L4-L10"]);
  assert.match(host, /aria-expanded="false"/);
  assert.doesNotMatch(host, /tool-row-body/);
  // The whole path stays one header hover and one screen-reader description away.
  assert.ok(host.includes(`<button class="tool-row-header" aria-expanded="false" aria-controls=`) );
  assert.ok(host.includes(`title="${path}"`), "the header keeps the full-path hover");
  assert.ok(host.includes(`<span id=`) && host.includes(`class="sr-only">${path}</span>`));
});

test("a collapsed external Edit keeps its counts and diff home, shows no root badge", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const host = ssr.render(
    createElement(ToolRow, {
      message: editMessage(
        {
          path: "/outside/out.txt",
          root: "external",
          editDiff: previewDiff({ root: "external", path: "/outside/out.txt" }),
        },
        { path: "/outside/out.txt" },
      ),
    }),
  );
  const adds = host.includes('<span class="diff-count-add">+1</span>');
  const dels = host.includes('<span class="diff-count-del">−1</span>');
  assert.ok(adds && dels, `the header keeps +a/−d, adds=${adds} dels=${dels}`);
  assert.ok(!chipTexts(host).some((text) => text.includes("external")), "no external badge");
  assert.ok(!chipTexts(host).some((text) => text.includes("scratch")), "no scratch badge");
  assert.ok(host.includes(">out.txt</span>"), "the row still names the edited file");
  assert.ok(
    host.includes(`title="/outside/out.txt"`),
    "the file name keeps the whole external path as its hover text",
  );
});

test("a generic previewable summary keeps its whole-span link behavior", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const host = ssr.render(
    createElement(ToolRow, {
      message: {
        id: "fetch-1",
        role: "tool",
        content: "",
        createdAt,
        status: "complete",
        toolName: "Fetch",
        toolCallId: "call-fetch-1",
        toolStatus: "success",
        toolArgs: { url: "https://example.com/docs" },
        toolResult: { content: [{ type: "text", text: "{}" }], details: { ok: true } },
      },
    }),
  );
  // Non-path summaries are untouched by the filename hitbox split: the whole
  // summary span stays the link, and no filename element is introduced.
  assert.match(host, /<span class="tool-row-summary linked"[^>]*>/);
  assert.doesNotMatch(host, /tool-row-file-name/);
});

test("only the file name preview-opens; the layout span and header keep the toggle", async () => {
  const toolRow = await read("../src/features/chat/transcript/ToolRow.tsx");
  const summaryStart = toolRow.indexOf('<span className="tool-row-summary is-path">');
  assert.ok(summaryStart >= 0, "the path layout span renders without handlers");
  const fileStart = toolRow.indexOf("tool-row-file-name", summaryStart);
  assert.ok(fileStart > summaryStart, "the file name renders inside the layout span");
  const fileBlock = toolRow.slice(fileStart, fileStart + 900);
  assert.match(fileBlock, /onClick=\{/);
  assert.match(fileBlock, /e\.stopPropagation\(\);/);
  assert.equal(
    fileBlock.match(/openTarget\(previewTarget\)/g)?.length,
    1,
    "one click opens one preview, and the stop keeps the header toggle out",
  );
  assert.match(fileBlock, /onContextMenu=\{/);
  assert.match(fileBlock, /openFileMenu\(event, \{ path: previewTarget\.path \}\)/);
  assert.match(toolRow, /onClick=\{\(\) => hasDetails && toggleRow\(\)\}/);
});

test("the filename target stays a plain span inside the header button", async () => {
  const toolRow = await read("../src/features/chat/transcript/ToolRow.tsx");
  assert.doesNotMatch(toolRow, /<button[^>]*tool-row-file-name/);
  assert.doesNotMatch(toolRow, /<a[^>]*tool-row-file-name/);
  const styles = await read("../src/styles/chat-links.css");
  assert.match(styles, /\.tool-row-file-name\.linked \{\s*cursor: pointer;\s*\}/);
  assert.match(styles, /\.tool-row-file-name\.linked:hover \{[\s\S]*?color: var\(--ds-accent\);/);
  assert.doesNotMatch(
    styles.match(/\.tool-row-file-name[^{]*\{[^}]*\}/g)?.join("\n") ?? "",
    /flex:/,
    "the filename target shrinks to its text instead of stretching",
  );
  const messages = await read("../src/styles/messages.css");
  assert.match(messages, /\.tool-row-summary \{\s*flex: 1;/);
  assert.match(
    messages,
    /\.tool-row-summary\.is-path \{[\s\S]*?text-overflow: ellipsis;/,
    "the layout span keeps the row's ellipsis",
  );
});
