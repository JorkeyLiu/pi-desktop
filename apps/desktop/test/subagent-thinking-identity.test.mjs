import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { buildSubagentTranscript } = await import(
  "../src/lib/subagent-transcript.ts"
);

function message(id, content, extra = {}) {
  return { id, content, ...extra };
}

function taskCall(id, task, extra = {}) {
  return message(id, "", {
    role: "tool",
    toolName: "Task",
    toolCallId: id,
    toolArgs: { task },
    ...extra,
  });
}

function childMessage(id, callId, content, extra = {}) {
  return message(id, content, {
    role: "assistant",
    parentToolCallId: callId,
    agentName: "explorer",
    ...extra,
  });
}

function seed() {
  return [
    taskCall("call-1", "Review the auth flow.", {
      toolResult: { delegationId: "del-1" },
    }),
    childMessage("hist-1", "call-1", "Historical answer: the rotation is sound.", {
      thinking: "Historical reasoning trace: check the rotation first.",
    }),
    childMessage("live-1", "call-1", "", {
      thinking: "Live reasoning trace.",
      status: "streaming",
    }),
  ];
}

test("one assistant message with reasoning and text yields two rows on one id", () => {
  const transcript = buildSubagentTranscript(seed(), "del-1");
  assert.ok(transcript);
  const kinds = transcript.turns[0].rows.map((row) => row.kind);
  assert.deepEqual(kinds, ["thinking", "answer", "thinking"]);
  const pair = transcript.turns[0].rows.filter((row) => row.message.id === "hist-1");
  assert.deepEqual(
    pair.map((row) => row.kind),
    ["thinking", "answer"],
  );
});

test("every row of a turn is unique by kind and message id", () => {
  // The subagent pane keys its row fragments by kind and message id, so the
  // transcript rows must never repeat that pair inside one turn: a repeated
  // pair is the duplicate-sibling-key collision this guards.
  const transcript = buildSubagentTranscript(seed(), "del-1");
  assert.ok(transcript);
  for (const turn of transcript.turns) {
    const keys = turn.rows.map((row) => `${row.kind}:${row.message.id}`);
    assert.equal(new Set(keys).size, keys.length, `duplicate row identity in turn: ${keys}`);
  }
});

