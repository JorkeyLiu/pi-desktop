import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { subagentChainLatestDelegationId } = await import("../src/lib/subagent-chain.ts");

/*
  One card per dispatch, not per continuation.

  A user continuation typed in a delegation's own tab is recorded as a `Task`
  row marked `source: "user"` with a `resume` target. The runtime keeps that
  row for the chain, the child transcript and persistence — and out of the
  parent's model context — so the main chat must project it away as well: the
  card the work was dispatched from stays the one card of that work, with its
  own history, and a continuation never adds a card, an activity group or an
  assistant turn of its own.

  The row is still a `Task`, though, so this is not "no Task rows with a
  resume": a `Task(resume …)` the parent model issued itself is a parent call
  and keeps its card.
*/

const at = (minute) => `2026-05-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

function taskRow({ id, args, result, minute = 2, extra = {} }) {
  return {
    id,
    role: "tool",
    content: JSON.stringify({ content: [{ type: "text", text: "delegation" }] }),
    createdAt: at(minute),
    toolCallId: id,
    toolName: "Task",
    toolArgs: args,
    toolStatus: "success",
    toolResult: { content: [{ type: "text", text: "delegation" }], details: result },
    toolCompletedAt: at(minute),
    toolDurationMs: 1000,
    status: "complete",
    isError: false,
    ...extra,
  };
}

const originalTask = taskRow({
  id: "call-task-1",
  args: { agent: "explorer", task: "Investigate the cache layer." },
  result: { delegationId: "d1", agent: "explorer", status: "stopped" },
  minute: 2,
});

const continuation = (index, { delegationId, resume, minute }) =>
  taskRow({
    id: `call-continue-${index}`,
    args: { agent: "explorer", task: `Follow-up ${index}.`, resume, source: "user" },
    result: { delegationId, agent: "explorer", status: "completed", resumedFrom: resume },
    minute,
  });

const parentResume = taskRow({
  id: "call-resume-parent",
  args: { agent: "explorer", task: "Continue the review yourself.", resume: "d3" },
  result: { delegationId: "d4", agent: "explorer", status: "completed" },
  minute: 12,
});

/**
 * The persisted session after one dispatch, a stop, and two direct
 * continuations typed in that delegation's tab. The delegate's own rows also
 * persist; they carry `parentToolCallId` and never were main-chat rows.
 */
function continuationSession() {
  return [
    { id: "u1", role: "user", content: "Investigate the cache layer.", createdAt: at(0) },
    { id: "a1", role: "assistant", content: "Delegating this now.", createdAt: at(1), status: "complete" },
    originalTask,
    {
      id: "child-a1", role: "assistant", content: "Reading the cache module.",
      createdAt: at(3), status: "complete", parentToolCallId: "call-task-1", agentName: "explorer",
    },
    { id: "a2", role: "assistant", content: "The delegate was stopped.", createdAt: at(4), status: "complete" },
    continuation(1, { delegationId: "d2", resume: "d1", minute: 5 }),
    {
      id: "child-u1", role: "user", content: "Follow-up 1.", createdAt: at(5),
      status: "complete", steering: true, parentToolCallId: "call-continue-1", agentName: "explorer",
    },
    continuation(2, { delegationId: "d3", resume: "d2", minute: 6 }),
    {
      id: "child-u2", role: "user", content: "Follow-up 2.", createdAt: at(6),
      status: "complete", steering: true, parentToolCallId: "call-continue-2", agentName: "explorer",
    },
  ];
}

function activityItems(entries) {
  return entries.flatMap((entry) =>
    entry.kind === "assistant-turn"
      ? entry.parts.flatMap((part) => (part.kind === "activity" ? part.items : []))
      : [],
  );
}

test("a stopped dispatch plus two direct continuations keeps one main-chat card", () => {
  const messages = continuationSession();
  const { entries, visible } = buildTranscriptEntries(messages);
  const cards = activityItems(entries).filter(
    (item) => item.kind === "tool" && item.message.toolName === "Task",
  );

  assert.deepEqual(
    cards.map((item) => item.message.id),
    ["call-task-1"],
    "the continuation markers must not add cards to the main chat",
  );
  // The card is the original dispatch and reads its own history, not the
  // chain's current state.
  assert.equal(cards[0].message.toolResult.details.status, "stopped");
  assert.equal(visible.filter((message) => message.role === "tool").length, 1);
});

test("a direct continuation adds no activity group or assistant turn of its own", () => {
  const { entries } = buildTranscriptEntries(continuationSession());
  const turns = entries.filter((entry) => entry.kind === "assistant-turn");

  // One turn: the dispatch prose, the card, and the reply that reported the
  // stop. Neither continuation opened a segment of its own.
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].parts.map((part) =>
      part.kind === "message"
        ? part.message.id
        : part.items.map((item) => item.message.id),
    ),
    ["a1", ["call-task-1"], "a2"],
  );
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind !== "activity") continue;
      assert.ok(part.items.length > 0, "an activity group must not be empty");
    }
  }
});
test("a continuation row alone leaves no empty turn to summarize", () => {
  const marker = continuation(9, { delegationId: "d9", resume: "d1", minute: 9 });
  const { entries, visible } = buildTranscriptEntries([
    { id: "u1", role: "user", content: "Stop here.", createdAt: at(0) },
    marker,
  ]);

  assert.deepEqual(entries.map((entry) => entry.kind), ["message"]);
  assert.deepEqual(visible.map((message) => message.id), ["u1"]);
});

test("an explicit parent Task(resume) keeps its own card", () => {
  const messages = [...continuationSession(), parentResume];
  const { entries } = buildTranscriptEntries(messages);
  const cards = activityItems(entries)
    .filter((item) => item.kind === "tool" && item.message.toolName === "Task")
    .map((item) => item.message.id);

  assert.deepEqual(cards, ["call-task-1", "call-resume-parent"]);
});

test("a provider Task row without a user source stays visible", () => {
  const explicit = taskRow({
    id: "call-explicit",
    args: { agent: "explorer", task: "Look at the write path." },
    result: { delegationId: "d5", agent: "explorer", status: "completed" },
    minute: 13,
  });
  const { visible } = buildTranscriptEntries([explicit]);
  assert.deepEqual(visible.map((message) => message.id), ["call-explicit"]);
});

test("hiding the markers changes neither the raw messages nor the chain", () => {
  const messages = continuationSession();
  const before = messages.map((message) => message.id);
  const { entries } = buildTranscriptEntries(messages);

  assert.deepEqual(messages.map((message) => message.id), before);
  assert.equal(messages.length, 9);
  const markers = messages.filter(
    (message) => message.role === "tool" && message.toolArgs?.source === "user",
  );
  assert.equal(markers.length, 2, "the ledger rows must stay in the session messages");
  // The persisted rows still name the newest run of the chain, which is what
  // the original card's tab opens.
  assert.equal(subagentChainLatestDelegationId(messages, "d1"), "d3");
  assert.ok(entries.length > 0);
});

test("a child transcript keeps every marker-derived row", () => {
  // The tab reads the session messages directly; the projection filter is a
  // main-chat concern and must not remove the delegate's own rows.
  const messages = continuationSession();
  const childRows = messages.filter((message) => message.parentToolCallId);
  assert.deepEqual(
    childRows.map((message) => message.id),
    ["child-a1", "child-u1", "child-u2"],
  );
  buildTranscriptEntries(messages);
  assert.equal(messages.filter((message) => message.parentToolCallId).length, 3);
});
