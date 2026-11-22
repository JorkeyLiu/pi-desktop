import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The module imports its sibling the bundler way (`./tool-presentation`).
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  BROWSER_PLUGIN_TOOL_NAME,
  browserActionLabelKey,
  browserActionOf,
  browserFailed,
  browserFailureBlock,
  browserSuccessBlocks,
  browserSummarySpec,
  isBrowserPluginTool,
} = await import("../src/lib/browser-tool-presentation.ts");

/** A host tool result as pi-ai delivers it: structured details plus text echo. */
function envelope(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function message(overrides = {}) {
  return {
    toolName: BROWSER_PLUGIN_TOOL_NAME,
    toolArgs: { action: "navigate", url: "https://example.com" },
    toolStatus: "success",
    ...overrides,
  };
}

test("matches only the exact shipped browser plugin tool", () => {
  assert.equal(isBrowserPluginTool(BROWSER_PLUGIN_TOOL_NAME), true);
  assert.equal(isBrowserPluginTool("plugin_other_Browser"), false);
  assert.equal(isBrowserPluginTool("mcp__x__Browser"), false);
  assert.equal(isBrowserPluginTool("Browser"), false);
  assert.equal(isBrowserPluginTool(undefined), false);
});

test("the exact plugin tool takes the catalog identity, others do not", async () => {
  const { getToolIdentityKey } = await import("../src/lib/tool-display.ts");
  assert.equal(getToolIdentityKey(BROWSER_PLUGIN_TOOL_NAME), "chat.toolBrowser");
  assert.equal(getToolIdentityKey("plugin_other_Browser"), null);
  assert.equal(getToolIdentityKey("mcp__x__Browser"), null);
});

test("every locale names the browser tool and all eight actions", () => {
  const locales = ["de", "en", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
  const keys = [
    "toolBrowser",
    "toolBrowserNavigate",
    "toolBrowserSnapshot",
    "toolBrowserScreenshot",
    "toolBrowserClick",
    "toolBrowserFill",
    "toolBrowserEvaluate",
    "toolBrowserConsole",
    "toolBrowserCdp",
  ];
  for (const locale of locales) {
    const source = readFileSync(
      join(here, "../../../packages/i18n/src/locales", locale, "index.ts"),
      "utf8",
    );
    for (const key of keys) {
      assert.ok(source.includes(key), `${locale} lacks chat.${key}`);
    }
  }
});

test("reads all eight plugin actions and rejects anything else", () => {
  for (const action of [
    "navigate",
    "snapshot",
    "screenshot",
    "click",
    "fill",
    "evaluate",
    "console",
    "cdp",
  ]) {
    assert.equal(browserActionOf({ action }), action);
  }
  assert.equal(browserActionOf({ action: "fetch" }), null);
  assert.equal(browserActionOf({}), null);
  assert.equal(browserActionOf(null), null);
});

test("names every action in the session language, unknown stays bare", () => {
  assert.equal(browserActionLabelKey("navigate"), "chat.toolBrowserNavigate");
  assert.equal(browserActionLabelKey("snapshot"), "chat.toolBrowserSnapshot");
  assert.equal(browserActionLabelKey("screenshot"), "chat.toolBrowserScreenshot");
  assert.equal(browserActionLabelKey("click"), "chat.toolBrowserClick");
  assert.equal(browserActionLabelKey("fill"), "chat.toolBrowserFill");
  assert.equal(browserActionLabelKey("evaluate"), "chat.toolBrowserEvaluate");
  assert.equal(browserActionLabelKey("console"), "chat.toolBrowserConsole");
  assert.equal(browserActionLabelKey("cdp"), "chat.toolBrowserCdp");
  assert.equal(browserActionLabelKey(null), null);
});

test("detects failure from the row, the envelope, or the payload itself", () => {
  assert.equal(browserFailed(message({ toolStatus: "error" })), true);
  assert.equal(browserFailed(message({ toolStatus: "denied" })), true);
  assert.equal(browserFailed(message({ isError: true })), true);
  assert.equal(
    browserFailed(message({ toolResult: { isError: true, content: [], details: {} } })),
    true,
  );
  assert.equal(
    browserFailed(message({ toolResult: envelope({ ok: false, error: "nope" }) })),
    true,
  );
  assert.equal(
    browserFailed(message({ toolResult: envelope({ error: "nope" }) })),
    true,
  );
  assert.equal(
    browserFailed(message({ toolResult: envelope({ errorCode: "E_X" }) })),
    true,
  );
  assert.equal(
    browserFailed(
      message({
        toolResult: envelope({ ok: true, state: { url: "https://example.com" } }),
      }),
    ),
    false,
  );
});

test("a failed call states exactly one reason, never input, state, or raw", () => {
  const blocks = browserFailureBlock(
    message({
      toolStatus: "error",
      toolArgs: { action: "evaluate", expression: "document.title" },
      toolResult: envelope({
        ok: false,
        error: "frame detached",
        errorCode: "E_FRAME",
        state: { sessionId: "s1", tabId: "t2" },
      }),
    }),
    { failureNote: () => "failed" },
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "note");
  assert.equal(blocks[0].role, "error");
  assert.equal(blocks[0].text, "frame detached");
  assert.equal(blocks[0].code, "E_FRAME");
  for (const block of blocks) {
    assert.notEqual(block.kind, "raw");
    assert.notEqual(block.role, "input");
    assert.notEqual(block.kind, "image");
  }
});

test("a failed call without a structured error falls back to the envelope sentence", () => {
  const blocks = browserFailureBlock(
    message({
      toolStatus: "error",
      toolResult: {
        content: [{ type: "text", text: "visibility timeout exceeded" }],
        details: { ok: false },
      },
    }),
    { failureNote: () => "failed" },
  );
  assert.deepEqual(blocks, [
    { kind: "note", role: "error", text: "visibility timeout exceeded" },
  ]);
});

test("collapsed navigate reads the finished page, the running call its URL", () => {
  const done = browserSummarySpec(
    { action: "navigate", url: "https://example.com" },
    { state: { title: "Example", url: "https://example.com" } },
    "success",
  );
  assert.equal(done.text, "Example · https://example.com");
  const running = browserSummarySpec(
    { action: "navigate", url: "https://example.com/go" },
    undefined,
    "running",
  );
  assert.equal(running.text, "https://example.com/go");
  assert.ok(!running.text.includes("sessionId"));
});

test("collapsed summaries never leak scripts, typed text, or session ids", () => {
  const evaluate = browserSummarySpec(
    { action: "evaluate", expression: "a".repeat(500) },
    { result: "ok-value" },
    "success",
  );
  assert.equal(evaluate.text, "ok-value");
  const fill = browserSummarySpec(
    { action: "fill", uid: "e7", text: "secret typed text" },
    { uid: "e7" },
    "success",
  );
  assert.equal(fill.text, "e7");
  assert.ok(!fill.text.includes("secret typed text"));
  const click = browserSummarySpec({ action: "click", uid: "e3" }, { uid: "e3" }, "success");
  assert.equal(click.text, "e3");
  const shot = browserSummarySpec(
    { action: "screenshot" },
    { path: "/tmp/shot.png" },
    "success",
  );
  assert.deepEqual(shot, { key: null, text: "/tmp/shot.png", path: true });
  const snap = browserSummarySpec(
    { action: "snapshot" },
    { title: "T", url: "https://example.com" },
    "success",
  );
  assert.equal(snap.text, "T · https://example.com");
  const consoleSpec = browserSummarySpec(
    { action: "console" },
    { messages: [{ type: "error", text: "boom" }] },
    "success",
  );
  assert.equal(consoleSpec.text, "1 · error");
  const cdp = browserSummarySpec(
    { action: "cdp", method: "Page.captureScreenshot" },
    { result: null },
    "success",
  );
  assert.equal(cdp.text, "Page.captureScreenshot");
  assert.deepEqual(browserSummarySpec({ action: "fetch" }, {}, "success"), {
    key: null,
    text: "",
    path: false,
  });
});

test("a navigate body names the page and keeps the payload one disclosure away", () => {
  const blocks = browserSuccessBlocks(
    message({
      toolResult: envelope({
        ok: true,
        state: {
          url: "https://example.com",
          title: "Example",
          isLoading: false,
          sessionId: "s1",
          tabId: "t2",
        },
      }),
    }),
  );
  assert.ok(blocks);
  assert.deepEqual(blocks[0], {
    kind: "fields",
    role: "output",
    rows: [
      { label: "title", value: "Example" },
      { label: "address", value: "https://example.com" },
    ],
  });
  const raw = blocks[blocks.length - 1];
  assert.equal(raw.kind, "raw");
  assert.ok(!JSON.stringify(blocks.slice(0, -1)).includes("s1"));
});

test("a snapshot body renders the page tree as plain output", () => {
  const blocks = browserSuccessBlocks(
    message({
      toolArgs: { action: "snapshot" },
      toolResult: envelope({ ok: true, tree: "- e1 WebArea\n- e2 button", url: "https://example.com" }),
    }),
  );
  assert.ok(blocks);
  assert.equal(blocks[0].kind, "code");
  assert.equal(blocks[0].text, "- e1 WebArea\n- e2 button");
});

test("a screenshot body shows the actual image, not the base64 payload", () => {
  const blocks = browserSuccessBlocks(
    message({
      toolArgs: { action: "screenshot" },
      toolResult: {
        details: {
          ok: true,
          path: "/tmp/shot.png",
          mimeType: "image/png",
          images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
        },
      },
    }),
  );
  assert.ok(blocks);
  assert.equal(blocks[0].kind, "image");
  assert.equal(blocks[0].src, "data:image/png;base64,aGVsbG8=");
});

test("click and fill name only the target they acted on", () => {
  const click = browserSuccessBlocks(
    message({
      toolArgs: { action: "click", uid: "e3" },
      toolResult: envelope({ ok: true, uid: "e3" }),
    }),
  );
  assert.deepEqual(click?.[0], {
    kind: "fields",
    role: "output",
    rows: [{ label: "target", value: "e3" }],
  });
  const fill = browserSuccessBlocks(
    message({
      toolArgs: { action: "fill", uid: "e7", text: "secret typed text" },
      toolResult: envelope({ ok: true, uid: "e7" }),
    }),
  );
  assert.ok(fill);
  assert.ok(!JSON.stringify(fill.slice(0, -1)).includes("secret typed text"));
});

test("evaluate and cdp preserve falsy answers instead of misreading absence", () => {
  for (const result of [null, false, 0, "", { items: [1] }]) {
    const blocks = browserSuccessBlocks(
      message({
        toolArgs: { action: "evaluate" },
        toolResult: envelope({ ok: true, result }),
      }),
    );
    assert.ok(blocks, `result ${JSON.stringify(result)} renders a block`);
    assert.ok(!blocks.some((block) => block.kind === "raw" && blocks.indexOf(block) === 0));
  }
  const missing = browserSuccessBlocks(
    message({
      toolArgs: { action: "evaluate" },
      toolResult: envelope({ ok: true }),
    }),
  );
  assert.equal(missing, null);
  const cdp = browserSuccessBlocks(
    message({
      toolArgs: { action: "cdp", method: "Runtime.evaluate" },
      toolResult: envelope({ ok: true, result: 42 }),
    }),
  );
  assert.deepEqual(cdp?.[0], {
    kind: "fields",
    role: "output",
    rows: [{ label: "result", value: "42" }],
  });
});

test("console renders entries and a running call renders nothing yet", () => {
  const blocks = browserSuccessBlocks(
    message({
      toolArgs: { action: "console" },
      toolResult: envelope({
        ok: true,
        messages: [
          { type: "log", text: "hello" },
          { type: "error", text: "boom" },
        ],
      }),
    }),
  );
  assert.ok(blocks);
  assert.equal(blocks[0].kind, "code");
  assert.ok(blocks[0].text.includes("[log] hello"));
  assert.ok(blocks[0].text.includes("[error] boom"));
  const running = browserSuccessBlocks(
    message({ toolStatus: "running", toolResult: undefined, content: undefined }),
  );
  assert.deepEqual(running, []);
});
