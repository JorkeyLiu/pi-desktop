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
  resolveTaskSteerTarget,
  taskSteerFailed,
  taskSteerFailureBlock,
  taskSteerReceiptBlocks,
  taskSteerSummarySpec,
} = await import("../src/lib/task-steer-presentation.ts");
const { isTaskSteerTool } = await import("../src/lib/tool-display.ts");

/** A host steer result as pi-ai delivers it: structured receipt plus text echo. */
function queued(details = {}) {
  return {
    content: [
      {
        type: "text",
        text: "Steering queued for delegation.",
      },
    ],
    details: {
      delegationId: "dlg-1",
      messageId: "msg-1",
      status: "queued",
      delivery: "next_turn",
      source: "model",
      ...details,
    },
  };
}

function message(overrides = {}) {
  return {
    toolName: "TaskSteer",
    toolArgs: {
      delegationId: "dlg-1",
      description: "Nudge the runner",
      message: "Please also cover edge cases.",
    },
    toolStatus: "success",
    ...overrides,
  };
}

test("matches the built-in steer tool, minus any provider namespace", () => {
  assert.equal(isTaskSteerTool("TaskSteer"), true);
  assert.equal(isTaskSteerTool("functions.TaskSteer"), true);
  assert.equal(isTaskSteerTool("TaskWait"), false);
  assert.equal(isTaskSteerTool("TaskList"), false);
  assert.equal(isTaskSteerTool(undefined), false);
});

test("collapsed text prefers the description, else a bounded message excerpt", () => {
  assert.equal(
    taskSteerSummarySpec({
      description: "Nudge the runner",
      message: "Please also cover edge cases.",
    }).text,
    "Nudge the runner",
  );
  assert.equal(
    taskSteerSummarySpec({ message: "Please also cover edge cases." }).text,
    "Please also cover edge cases.",
  );
  const long = taskSteerSummarySpec({ message: `${"word ".repeat(60)}end` });
  assert.ok(long.text.length <= 161);
  assert.ok(long.text.endsWith("…"));
  assert.equal(taskSteerSummarySpec({}).text, "");
  assert.equal(taskSteerSummarySpec(null).text, "");
});

test("an accepted steer shows only the sent guidance as one output block", () => {
  const blocks = taskSteerReceiptBlocks(message({ toolResult: queued() }), {});
  assert.ok(blocks);
  assert.deepEqual(blocks, [
    {
      kind: "code",
      role: "output",
      text: "Please also cover edge cases.",
      lang: "",
      highlight: false,
    },
  ]);
  const serialized = JSON.stringify(blocks);
  assert.ok(!serialized.includes("dlg-1"));
  assert.ok(!serialized.includes("msg-1"));
  assert.ok(!serialized.includes("next_turn"));
  assert.ok(blocks.every((block) => block.kind !== "raw"));
});

test("without a resolved target the guidance still shows, never the raw id", () => {
  const blocks = taskSteerReceiptBlocks(message({ toolResult: queued() }), {});
  assert.ok(blocks);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "code");
  assert.equal(blocks[0].text, "Please also cover edge cases.");
});

test("the target resolves from delegation titles, never an id or a role", () => {
  const titles = new Map([["dlg-1", "修复分页窗口合并"]]);
  assert.equal(resolveTaskSteerTarget(message(), titles), "修复分页窗口合并");
  assert.equal(resolveTaskSteerTarget(message({ toolArgs: { delegationId: "dlg-9" } }), titles), "");
  assert.equal(
    resolveTaskSteerTarget(message({ toolArgs: { delegationId: "dlg-9", agent: "runner" } }), titles),
    "",
  );
  assert.equal(resolveTaskSteerTarget(message({ toolArgs: {} }), null), "");
  assert.equal(resolveTaskSteerTarget(message(), null), "");
});

test("the guidance block is a plain output block with no special heading", () => {
  const blocks = taskSteerReceiptBlocks(message({ toolResult: queued() }), {});
  assert.equal(blocks?.length, 1);
  assert.equal(blocks?.[0].role, "output");
  assert.equal(blocks?.[0].labelKey, undefined);
});

test("a steer row carries no agent of its own: the target record names it", () => {
  const row = message();
  assert.ok(!("agent" in row.toolArgs), "steer args are delegationId/message only");
  assert.ok(!("agentName" in row), "steer rows carry no run-lineage name");
  assert.equal(resolveTaskSteerTarget(row, null), "");
});

test("every locale names the sent status", () => {
  const locales = ["de", "en", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
  for (const locale of locales) {
    const source = readFileSync(
      join(here, "../../../packages/i18n/src/locales", locale, "index.ts"),
      "utf8",
    );
    assert.ok(source.includes("toolSent"), `${locale} lacks chat.toolSent`);
  }
});

test("a non-queue outcome keeps the accurate generic mapping, not an invented body", () => {
  assert.equal(
    taskSteerReceiptBlocks(message({ toolResult: queued({ status: "delivered" }) }), {}),
    null,
  );
  assert.equal(
    taskSteerReceiptBlocks(message({ toolResult: queued({ status: "unknown" }) }), {}),
    null,
  );
  assert.equal(
    taskSteerReceiptBlocks(
      message({ toolResult: { content: [{ type: "text", text: "odd" }] } }),
      {},
    ),
    null,
  );
});

test("a running steer renders nothing yet", () => {
  assert.deepEqual(
    taskSteerReceiptBlocks(message({ toolStatus: "running", toolResult: undefined })),
    [],
  );
});

test("a failed steer states exactly one reason, never input or raw", () => {
  const blocks = taskSteerFailureBlock(
    message({
      toolStatus: "error",
      toolResult: queued({ error: "delegation ended", errorCode: "E_GONE" }),
    }),
    { failureNote: () => "failed" },
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "note");
  assert.equal(blocks[0].role, "error");
  assert.equal(blocks[0].text, "delegation ended");
  assert.equal(blocks[0].code, "E_GONE");
  assert.ok(blocks.every((block) => block.kind !== "raw"));
  assert.ok(!JSON.stringify(blocks).includes("dlg-1"));
});

test("failure detection reads the row, the envelope, or the receipt itself", () => {
  assert.equal(taskSteerFailed(message({ toolStatus: "error" })), true);
  assert.equal(taskSteerFailed(message({ toolStatus: "denied" })), true);
  assert.equal(taskSteerFailed(message({ isError: true })), true);
  assert.equal(
    taskSteerFailed(message({ toolResult: { isError: true, content: [], details: {} } })),
    true,
  );
  assert.equal(
    taskSteerFailed(message({ toolResult: queued({ error: "gone" }) })),
    true,
  );
  assert.equal(taskSteerFailed(message({ toolResult: queued() })), false);
});
