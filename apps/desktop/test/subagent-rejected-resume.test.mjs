import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
  A rejected `Task(resume …)` must not rewrite the execution chain.

  Root cause: the resume edge was built from the request attempt alone —
  `subagentResumeLinks` linked orig → failed-resume regardless of outcome, so
  the index moved `latestDelegationId` to the failed call (which has no
  delegation payload and falls back to its own call id), the transcript built a
  second turn from the never-delivered brief, and the tab read the empty
  fallback as `aborted`/stopped while the original run was still live.

  A `Task` call that never started a run (no delegation handle, not spawning,
  no child rows) is a request attempt, not an executed segment: it joins no
  chain, seeds none, and renders no turn. The parent session keeps its failed
  tool row with the error; the failure never taints the original run.
*/

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { buildSubagentTranscript } = await import("../src/lib/subagent-transcript.ts");
const { subagentTranscriptIndex } = await import("../src/lib/subagent-index.ts");
const { subagentChainCallIds, subagentChainLatestDelegationId } = await import(
  "../src/lib/subagent-chain.ts"
);
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { collectDelegationStatuses, subagentOutcome } = await import(
  "../src/lib/subagent-topology.ts"
);
const { toolResultPayload } = await import("../src/lib/tool-presentation.ts");

const ORIG_TASK = "Map the cache invalidation path.";
const BRIEF = "Supplemental brief: re-check the figures against source B and report deltas.";

const usage = (op) => ({
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  operationId: op,
  aggregation: "operation",
});

function origCall() {
  return {
    id: "m-call-1",
    role: "tool",
    content: "",
    createdAt: "2026-10-13T00:00:00.000Z",
    toolName: "Task",
    toolCallId: "tc-orig-1",
    toolStatus: "success",
    toolArgs: { description: "Research X", task: ORIG_TASK },
    toolResult: {
      content: [{ type: "text", text: "Delegation d-orig: running." }],
      details: {
        delegationId: "d-orig",
        agent: "explorer",
        status: "running",
        startedAt: Date.parse("2026-10-13T00:00:00Z"),
        modelId: "test-model",
        thinkingLevel: "high",
        turns: 1,
        toolCalls: 1,
        usage: usage("op-orig"),
      },
    },
    status: "complete",
  };
}

function childAssistant(id, callId, content, op) {
  return {
    id,
    role: "assistant",
    content,
    createdAt: "2026-10-13T00:00:05.000Z",
    parentToolCallId: callId,
    agentName: "explorer",
    status: "complete",
    usage: usage(op),
  };
}

function lifecycleRow() {
  return {
    id: "m-list-1",
    role: "tool",
    content: "",
    createdAt: "2026-10-13T00:00:06.000Z",
    toolName: "TaskList",
    toolCallId: "tc-list-9",
    toolStatus: "success",
    toolResult: { details: { delegations: [{ delegationId: "d-orig", status: "running" }] } },
    status: "complete",
  };
}

function rejectedResume(resume) {
  return {
    id: "m-call-2",
    role: "tool",
    content: "",
    createdAt: "2026-10-13T00:00:07.000Z",
    toolName: "Task",
    toolCallId: "tc-resume-2",
    toolStatus: "error",
    toolArgs: { description: "Research X", task: BRIEF, resume },
    toolResult: {
      error: { code: "RESUME_REJECTED", message: "delegation d-orig is still running" },
    },
    error: { code: "RESUME_REJECTED", message: "delegation d-orig is still running" },
    status: "error",
  };
}

function laterProgress() {
  return [
    {
      id: "child-t1",
      role: "tool",
      content: "",
      createdAt: "2026-10-13T00:00:08.000Z",
      toolName: "Read",
      toolCallId: "child-tool-1",
      toolStatus: "success",
      parentToolCallId: "tc-orig-1",
      agentName: "explorer",
      status: "complete",
    },
    childAssistant("child-a2", "tc-orig-1", "Found the mismatch in source B.", "op-orig-2"),
  ];
}

function rejectedFixture(resume) {
  return [
    origCall(),
    childAssistant("child-a1", "tc-orig-1", "Working on the figures…", "op-orig-1"),
    lifecycleRow(),
    rejectedResume(resume),
    ...laterProgress(),
  ];
}

const toolItems = (messages) =>
  messages.filter((message) => message.role === "tool").map((message) => ({ kind: "tool", message }));

// The tab resolves the header from the same chain the transcript renders:
// the scoped rows of the chain-latest delegation decide the outcome.
function tabOutcomeFor(messages, entryId, turnLive = true) {
  const latest = subagentChainLatestDelegationId(messages, entryId);
  const statuses = collectDelegationStatuses(toolItems(messages), { turnLive });
  const scoped = messages.filter((message) => {
    if (message.role !== "tool") return false;
    const payload = toolResultPayload(message);
    return (
      payload && typeof payload === "object" && payload.delegationId === latest
    );
  });
  const last = scoped.at(-1);
  return { latest, outcome: last ? subagentOutcome(last, statuses) : (statuses.get(latest) ?? "aborted") };
}

for (const resume of ["d-orig", "tc-orig-1"]) {
  test(`a rejected resume (${resume}) never joins the execution chain`, () => {
    const messages = rejectedFixture(resume);
    const index = subagentTranscriptIndex(messages);

    assert.deepEqual([...index.chainCallIds("d-orig")].sort(), ["tc-orig-1"]);
    assert.equal(subagentChainCallIds(messages, "d-orig").has("tc-resume-2"), false);
    assert.equal(index.latestCallId("d-orig"), "tc-orig-1");
    assert.equal(index.latestDelegationId("d-orig"), "d-orig");
    assert.equal(subagentChainLatestDelegationId(messages, "d-orig"), "d-orig");

    const transcript = buildSubagentTranscript(messages, "d-orig");
    assert.ok(transcript);
    assert.equal(transcript.turns.length, 1);
    assert.equal(transcript.turns[0].task, ORIG_TASK);
    assert.deepEqual(
      transcript.turns[0].rows.map((row) => row.message.id),
      ["child-a1", "child-t1", "child-a2"],
      "later child progress keeps appending to the original turn",
    );

    // A rejected call seeds no chain of its own: the tab has no run to show.
    assert.equal(index.chainCallIds("tc-resume-2").size, 0);
    assert.equal(buildSubagentTranscript(messages, "tc-resume-2"), null);
  });

  test(`the original delegation stays running past a rejected resume (${resume})`, () => {
    const messages = rejectedFixture(resume);
    const { latest, outcome } = tabOutcomeFor(messages, "d-orig", true);
    assert.equal(latest, "d-orig");
    assert.equal(outcome, "running");
  });

  test(`the parent keeps the failed tool row while the original run keeps its rows (${resume})`, () => {
    const messages = rejectedFixture(resume);
    const failed = messages.find((message) => message.toolCallId === "tc-resume-2");
    assert.equal(failed.toolStatus, "error");
    const statuses = collectDelegationStatuses(toolItems(messages), { turnLive: true });
    assert.equal(subagentOutcome(failed, statuses), "failed");
    assert.equal(statuses.get("d-orig"), "running");

    const { entries } = buildTranscriptEntries(messages);
    const items = entries
      .flatMap((entry) => (entry.kind === "assistant-turn" ? entry.parts : []))
      .flatMap((part) => (part.kind === "activity" ? part.items : []))
      .filter((item) => item.kind === "tool" && item.message.toolName === "Task");
    const byCall = new Map(items.map((item) => [item.message.toolCallId, item]));
    assert.deepEqual(
      (byCall.get("tc-orig-1")?.delegate?.items ?? []).map((row) => row.message.id),
      ["child-a1", "child-t1", "child-a2"],
      "the failure must not steal the original run's rows",
    );
    assert.equal(byCall.get("tc-resume-2")?.delegate, undefined);
  });
}

test("an accepted resume still continues the chain with a second turn", () => {
  const messages = [
    ...rejectedFixture("d-orig").slice(0, 3),
    {
      id: "m-call-3",
      role: "tool",
      content: "",
      createdAt: "2026-10-13T00:00:09.000Z",
      toolName: "Task",
      toolCallId: "tc-ok-3",
      toolStatus: "success",
      toolArgs: { description: "Research X", task: "Continue the review yourself.", resume: "d-orig" },
      toolResult: {
        content: [{ type: "text", text: "Delegation d-2: running." }],
        details: {
          delegationId: "d-2",
          agent: "explorer",
          status: "running",
          resumedFrom: "d-orig",
          startedAt: Date.parse("2026-10-13T00:00:09Z"),
          usage: usage("op-ok"),
        },
      },
      status: "complete",
    },
    childAssistant("child-a3", "tc-ok-3", "Continuing the cache work.", "op-ok-1"),
  ];
  const index = subagentTranscriptIndex(messages);
  assert.deepEqual([...index.chainCallIds("d-orig")].sort(), ["tc-ok-3", "tc-orig-1"]);
  assert.equal(index.latestDelegationId("d-orig"), "d-2");
  const transcript = buildSubagentTranscript(messages, "d-orig");
  assert.equal(transcript.turns.length, 2);
  assert.equal(transcript.turns[0].task, ORIG_TASK);
  assert.equal(transcript.turns[1].task, "Continue the review yourself.");
  assert.deepEqual(
    transcript.turns[1].rows.map((row) => row.message.id),
    ["child-a3"],
  );
});

test("a created run that later failed stays in the chain", () => {
  const withHandle = [
    ...rejectedFixture("d-orig").slice(0, 3),
    {
      id: "m-call-4",
      role: "tool",
      content: "",
      createdAt: "2026-10-13T00:00:09.000Z",
      toolName: "Task",
      toolCallId: "tc-f-4",
      toolStatus: "error",
      toolArgs: { description: "Research X", task: "Retry the slow query.", resume: "d-orig" },
      toolResult: {
        content: [{ type: "text", text: "Delegation d-3 failed." }],
        details: { delegationId: "d-3", agent: "explorer", status: "failed" },
      },
      error: { code: "RUN_FAILED", message: "the delegate failed" },
      status: "error",
    },
  ];
  assert.equal(subagentTranscriptIndex(withHandle).chainCallIds("d-orig").has("tc-f-4"), true);
  assert.equal(subagentTranscriptIndex(withHandle).latestDelegationId("d-orig"), "d-3");

  // A failed attempt with child rows executed a run even without a handle.
  const withRows = [
    ...rejectedFixture("d-orig").slice(0, 3),
    {
      id: "m-call-5",
      role: "tool",
      content: "",
      createdAt: "2026-10-13T00:00:09.000Z",
      toolName: "Task",
      toolCallId: "tc-f-5",
      toolStatus: "error",
      toolArgs: { description: "Research X", task: "Retry the slow query.", resume: "d-orig" },
      toolResult: { error: { code: "RUN_FAILED", message: "the delegate failed" } },
      error: { code: "RUN_FAILED", message: "the delegate failed" },
      status: "error",
    },
    childAssistant("child-a5", "tc-f-5", "Partial answer before failing.", "op-f-5"),
  ];
  assert.equal(subagentTranscriptIndex(withRows).chainCallIds("d-orig").has("tc-f-5"), true);
});

test("a denied never-started call seeds no chain", () => {
  const messages = [
    {
      id: "t1",
      role: "tool",
      content: "",
      createdAt: "2026-10-13T00:00:00.000Z",
      toolName: "Task",
      toolCallId: "call-9",
      toolStatus: "denied",
      toolArgs: { agent: "explorer", task: "Investigate the cache" },
      toolResult: { details: { denied: true } },
    },
  ];
  assert.equal(subagentTranscriptIndex(messages).chainCallIds("call-9").size, 0);
  assert.equal(buildSubagentTranscript(messages, "call-9"), null);
});
