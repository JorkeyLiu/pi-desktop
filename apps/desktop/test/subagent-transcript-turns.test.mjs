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
// The predicates and chain resolution the builder is stated in terms of: the
// reference below re-derives the aggregation, not these contracts.
const { isAcceptedSubagentCall, messageThinking } = await import(
  "../src/lib/assistant-turns.ts"
);
const { isUserOriginTaskMarker } = await import("../src/lib/subagent-actions.ts");
const { isDelegationStartTool } = await import("../src/lib/tool-display.ts");
const { subagentChainCallIds } = await import("../src/lib/subagent-chain.ts");
const { delegateTaskAgent } = await import("../src/lib/subagent-task-call.ts");

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

test("one Task call becomes one user turn followed by the delegate's rows", () => {
  const messages = [
    taskCall("call-1", "Find all call sites of resize()", {
      toolResult: { delegationId: "del-1" },
    }),
    message("step-1", "grep resize(", {
      role: "tool",
      parentToolCallId: "call-1",
      agentName: "explorer",
    }),
    message("note-1", "Found three call sites.", {
      role: "assistant",
      parentToolCallId: "call-1",
      thinking: "Check the header first.",
      agentName: "explorer",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.ok(transcript);
  assert.equal(transcript.agentName, "explorer");
  assert.equal(transcript.turns.length, 1);
  assert.equal(transcript.turns[0].task, "Find all call sites of resize()");
  assert.deepEqual(
    transcript.turns[0].rows.map((row) => row.kind),
    ["tool", "thinking", "answer"],
  );
});
test("each Task brief keeps the source message identity across older pages", () => {
  const root = message("task-row-1", "", {
    role: "tool",
    toolName: "Task",
    toolCallId: "call-1",
    toolArgs: { task: "Original prompt" },
    toolResult: { delegationId: "del-1" },
  });
  const resume = message("task-row-2", "", {
    role: "tool",
    toolName: "Task",
    toolCallId: "call-2",
    toolArgs: { task: "Follow-up prompt", resume: "call-1" },
    toolResult: { delegationId: "del-1" },
  });
  const transcript = buildSubagentTranscript([
    root,
    message("answer-1", "First answer.", { role: "assistant", parentToolCallId: "call-1" }),
    resume,
    message("answer-2", "Second answer.", { role: "assistant", parentToolCallId: "call-2" }),
  ], "del-1");

  assert.deepEqual(
    transcript.turns.map(({ callId, messageId }) => ({ callId, messageId })),
    [
      { callId: "call-1", messageId: "task-row-1" },
      { callId: "call-2", messageId: "task-row-2" },
    ],
    "turn keys and brief anchors come from the Task rows, not their positions",
  );
});

test("a hidden prompt keeps the run's rows but drops an empty run", () => {
  const messages = [
    taskCall("call-1", "First prompt", {
      toolResult: { delegationId: "del-1" },
    }),
    message("answer-1", "First answer.", {
      role: "assistant",
      parentToolCallId: "call-1",
    }),
    taskCall("call-2", "Follow-up prompt", {
      toolArgs: { task: "Follow-up prompt", resume: "call-1" },
      toolResult: { delegationId: "del-1" },
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1", {
    promptVisible: () => false,
  });
  assert.equal(transcript.turns.length, 1, "a run outside the window draws nothing at all");
  assert.equal(transcript.turns[0].messageId, "call-1");
  assert.equal(transcript.turns[0].showPrompt, false);
  assert.deepEqual(
    transcript.turns[0].rows.map((row) => row.message.id),
    ["answer-1"],
    "a hidden prompt keeps the children the window does hold",
  );
});

test("a resumed delegation renders follow-up prompts as further user turns", () => {
  const messages = [
    taskCall("call-1", "First prompt", {
      toolResult: { delegationId: "del-1" },
    }),
    message("answer-1", "First answer.", {
      role: "assistant",
      parentToolCallId: "call-1",
    }),
    taskCall("call-2", "Follow-up prompt", {
      toolArgs: { task: "Follow-up prompt", resume: "call-1" },
      toolResult: { delegationId: "del-1" },
    }),
    message("answer-2", "Second answer.", {
      role: "assistant",
      parentToolCallId: "call-2",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.equal(transcript.turns.length, 2);
  assert.equal(transcript.turns[0].task, "First prompt");
  assert.deepEqual(
    transcript.turns[0].rows.map((row) => row.message.id),
    ["answer-1"],
  );
  assert.equal(transcript.turns[1].task, "Follow-up prompt");
  assert.deepEqual(
    transcript.turns[1].rows.map((row) => row.message.id),
    ["answer-2"],
  );
});

test("a chain is recognized from either end of the resume links", () => {
  // Only the resumed call carries the result payload; the original call is
  // linked backward through the runtime's resume record.
  const messages = [
    taskCall("call-1", "Original prompt"),
    taskCall("call-2", "Follow-up prompt", {
      toolArgs: { task: "Follow-up prompt", resume: "call-1" },
      toolResult: { delegationId: "del-1" },
    }),
    message("answer-1", "Original answer.", {
      role: "assistant",
      parentToolCallId: "call-1",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.equal(transcript.turns.length, 2);
  assert.equal(transcript.turns[0].task, "Original prompt");
});

test("parallel delegates never mix into each other's turns", () => {
  const messages = [
    taskCall("call-a", "Task A", {
      toolResult: { delegationId: "del-a" },
    }),
    taskCall("call-b", "Task B", {
      toolResult: { delegationId: "del-b" },
    }),
    message("answer-a", "Answer A.", {
      role: "assistant",
      parentToolCallId: "call-a",
      agentName: "explorer",
    }),
    message("answer-b", "Answer B.", {
      role: "assistant",
      parentToolCallId: "call-b",
      agentName: "reviewer",
    }),
  ];
  const a = buildSubagentTranscript(messages, "del-a");
  const b = buildSubagentTranscript(messages, "del-b");
  assert.equal(a.agentName, "explorer");
  assert.deepEqual(
    a.turns.flatMap((turn) => turn.rows.map((row) => row.message.id)),
    ["answer-a"],
  );
  assert.equal(b.agentName, "reviewer");
  assert.deepEqual(
    b.turns.flatMap((turn) => turn.rows.map((row) => row.message.id)),
    ["answer-b"],
  );
});

test("nested tools stay with their owning delegate, not their tool parent", () => {
  const messages = [
    taskCall("task-1", "Inspect files", { toolResult: { delegationId: "delegate-1" } }),
    message("root-read", "root result", {
      role: "tool", toolName: "Read", nestedParentToolCallId: "root-code",
    }),
    message("code-1", "running", {
      role: "tool", toolName: "codemode", parentToolCallId: "task-1", agentName: "reader",
    }),
    message("nested-read", "delegate result", {
      role: "tool", toolName: "Read", parentToolCallId: "task-1",
      nestedParentToolCallId: "code-1", agentName: "reader",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "delegate-1");
  assert.equal(transcript.agentName, "reader");
  assert.deepEqual(transcript.turns[0].rows.map((row) => row.message.id), ["code-1", "nested-read"]);
  assert.equal(transcript.turns[0].rows[1].message.nestedParentToolCallId, "code-1");
  assert.equal(buildSubagentTranscript(messages, "root-code"), null);
});

test("an unknown delegation id yields no transcript", () => {
  const messages = [taskCall("call-1", "Task", {
    toolResult: { delegationId: "del-1" },
  })];
  assert.equal(buildSubagentTranscript(messages, "missing"), null);
  assert.equal(buildSubagentTranscript(messages, ""), null);
});

test("a call with no task argument degrades to an empty prompt", () => {
  const messages = [
    message("call-1", "", {
      role: "tool",
      toolName: "Task",
      toolCallId: "call-1",
      toolArgs: {},
      toolResult: { delegationId: "del-1" },
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.equal(transcript.turns[0].task, "");
});

/**
 * The builder as it was before the children index: the same rules, stated as
 * one full scan of the conversation per accepted `Task` call. It exists only
 * as this suite's differential reference, so the indexed builder's output can
 * be compared against the shape the panel already shipped.
 */
function referenceTranscript(messages, delegationId, options = {}) {
  const target = delegationId.trim();
  if (!target) return null;
  const calls = messages.filter(
    (message) =>
      message.role === "tool" &&
      isDelegationStartTool(message.toolName) &&
      Boolean(message.toolCallId),
  );
  const chain = subagentChainCallIds(messages, target);
  if (chain.size === 0) return null;
  const runAgentName = messages.find(
    (message) =>
      message.parentToolCallId &&
      chain.has(message.parentToolCallId) &&
      message.agentName,
  )?.agentName;
  const requestedName = calls
    .filter((call) => chain.has(call.toolCallId))
    .map((call) => delegateTaskAgent(call))
    .find(Boolean);
  const agentName = runAgentName || requestedName;
  const childParents = new Set();
  for (const message of messages) {
    if (message.parentToolCallId) childParents.add(message.parentToolCallId);
  }
  const turns = [];
  for (const call of calls) {
    const callId = call.toolCallId;
    if (!chain.has(callId)) continue;
    if (!isAcceptedSubagentCall(call, childParents.has(callId))) continue;
    const args = call.toolArgs;
    const task =
      args && typeof args === "object" && !Array.isArray(args) &&
      typeof args.task === "string"
        ? args.task.trim()
        : "";
    const userOrigin = isUserOriginTaskMarker({ toolArgs: call.toolArgs });
    let seedRendered = false;
    let turnAttachments;
    const rows = [];
    for (const message of messages) {
      if (message.parentToolCallId !== callId) continue;
      if (message.role === "tool") {
        rows.push({ kind: "tool", message });
        continue;
      }
      if (message.role === "user") {
        const text = (message.content || "").trim();
        const attachments = message.attachments ?? [];
        if (!text && !attachments.length && !message.error) continue;
        if (userOrigin && !seedRendered && text === task) {
          seedRendered = true;
          if (attachments.length) turnAttachments = attachments;
          continue;
        }
        rows.push({ kind: "steering-user", message });
        continue;
      }
      if (messageThinking(message)) rows.push({ kind: "thinking", message });
      if ((message.content || "").trim() || message.error) {
        rows.push({ kind: "answer", message });
      }
    }
    const identity = { callId, messageId: call.id };
    const showPrompt = options.promptVisible ? options.promptVisible(call) : true;
    const turn = turnAttachments
      ? { ...identity, task, attachments: turnAttachments, showPrompt, rows }
      : { ...identity, task, showPrompt, rows };
    if (!showPrompt && !rows.length) continue;
    turns.push(turn);
  }
  return { ...(agentName ? { agentName } : {}), turns };
}

/**
 * A chain of `count` `Task` calls, each resumed from the previous one, each
 * with real child rows: tool results, reasoning, answers, and one reasoning-only
 * turn. The rows around it are ordinary main rows the scope must never admit.
 */
function resumedChain(count, rowsPerCall = 3) {
  const rows = [
    message("main-user-1", "delegate the audits", { role: "user" }),
    message("main-answer-1", "working on it", { role: "assistant" }),
  ];
  for (let index = 0; index < count; index += 1) {
    const callId = `call-${index}`;
    rows.push(
      taskCall(callId, `Prompt ${index}`, {
        toolArgs: {
          agent: index % 4 === 0 ? "explorer" : "reviewer",
          task: `Prompt ${index}`,
          ...(index === 0 ? {} : { resume: index === 1 ? "del-0" : `call-${index - 1}` }),
        },
        toolResult: { details: { delegationId: `del-${index}` } },
      }),
    );
    for (let row = 0; row < rowsPerCall; row += 1) {
      const id = `child-${index}-${row}`;
      const step = row % 4;
      if (step === 0) {
        rows.push(
          message(id, `read ${index}-${row}`, {
            role: "tool",
            toolName: "Read",
            toolCallId: `read-${index}-${row}`,
            parentToolCallId: callId,
            agentName: "explorer",
          }),
        );
      } else if (step === 1) {
        rows.push(
          message(id, `answer ${index}-${row}`, {
            role: "assistant",
            parentToolCallId: callId,
            thinking: `why ${index}-${row}`,
            agentName: "explorer",
          }),
        );
      } else if (step === 2) {
        rows.push(
          message(id, "", {
            role: "assistant",
            parentToolCallId: callId,
            thinking: `only reasoning ${index}-${row}`,
            agentName: "explorer",
          }),
        );
      } else {
        rows.push(
          message(id, "", {
            role: "assistant",
            parentToolCallId: callId,
            error: `failure ${index}-${row}`,
            agentName: "explorer",
          }),
        );
      }
    }
  }
  return rows;
}

/** A read count over the message array: every indexed read is one row visit. */
function countedMessages(messages) {
  const stats = { reads: 0 };
  const proxy = new Proxy(messages, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) stats.reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { messages: proxy, stats };
}

/** The chain shapes the indexed builder must reproduce exactly. */
function chainShapes() {
  const userOrigin = [
    taskCall("call-1", "First prompt", {
      toolArgs: { agent: "explorer", task: "First prompt" },
      toolResult: { details: { delegationId: "del-1" } },
    }),
    message("answer-1", "done", {
      role: "assistant",
      parentToolCallId: "call-1",
      agentName: "explorer",
    }),
    taskCall("call-2", "Follow-up with images", {
      toolArgs: {
        agent: "explorer",
        task: "Follow-up with images",
        resume: "del-1",
        source: "user",
      },
      toolResult: { details: { delegationId: "del-1" } },
    }),
    // The continuation seeds the child with the marker's own text and the
    // images: the seed is not a second user row, the images belong to the turn.
    message("seed-2", "Follow-up with images", {
      role: "user",
      parentToolCallId: "call-2",
      agentName: "explorer",
      attachments: [{ id: "image-1", kind: "image", mimeType: "image/png" }],
    }),
    message("answer-2", "followed up", {
      role: "assistant",
      parentToolCallId: "call-2",
      agentName: "explorer",
    }),
    // An image-only steer is a real user turn with no text.
    message("steer-image", "", {
      role: "user",
      parentToolCallId: "call-2",
      attachments: [{ id: "image-2", kind: "image", mimeType: "image/png" }],
    }),
  ];
  const nested = [
    taskCall("task-1", "Inspect files", {
      toolArgs: { agent: "reader", task: "Inspect files" },
      toolResult: { delegationId: "delegate-1" },
    }),
    message("root-read", "root result", {
      role: "tool",
      toolName: "Read",
      nestedParentToolCallId: "root-code",
    }),
    message("code-1", "running", {
      role: "tool",
      toolName: "codemode",
      parentToolCallId: "task-1",
      agentName: "reader",
    }),
    message("nested-read", "delegate result", {
      role: "tool",
      toolName: "Read",
      parentToolCallId: "task-1",
      nestedParentToolCallId: "code-1",
      agentName: "reader",
    }),
  ];
  const cyclic = [
    taskCall("call-a", "Cycle A", {
      toolArgs: { agent: "explorer", task: "Cycle A", resume: "call-b" },
      toolResult: { delegationId: "del-a" },
    }),
    taskCall("call-b", "Cycle B", {
      toolArgs: { agent: "explorer", task: "Cycle B", resume: "call-a" },
      toolResult: { delegationId: "del-b" },
    }),
    // A dangling resume names nothing resolvable and must not strand the call.
    taskCall("call-c", "Dangling", {
      toolArgs: { agent: "explorer", task: "Dangling", resume: "no-such-call" },
      toolResult: { delegationId: "del-c" },
    }),
    message("answer-a", "a", {
      role: "assistant",
      parentToolCallId: "call-a",
      agentName: "explorer",
    }),
    message("answer-b", "b", {
      role: "assistant",
      parentToolCallId: "call-b",
      agentName: "explorer",
    }),
  ];
  return [
    { label: "root and resume runs", messages: resumedChain(3, 4), delegationId: "del-0" },
    { label: "the newest resume as the entry identity", messages: resumedChain(3, 2), delegationId: "call-2" },
    {
      label: "a partial window hides the prompts it does not reach",
      messages: resumedChain(4, 3),
      delegationId: "del-0",
      options: { promptVisible: (call) => call.toolCallId === "call-3" },
    },
    {
      label: "no prompt is visible",
      messages: resumedChain(3, 3),
      delegationId: "del-0",
      options: { promptVisible: () => false },
    },
    { label: "a user-origin continuation seed and image-only steer", messages: userOrigin, delegationId: "del-1" },
    { label: "nested tool ownership", messages: nested, delegationId: "delegate-1" },
    { label: "cyclic and dangling resume aliases", messages: cyclic, delegationId: "del-a" },
  ];
}

test("the indexed builder matches the per-call scan for every chain shape", () => {
  for (const shape of chainShapes()) {
    assert.deepEqual(
      buildSubagentTranscript(shape.messages, shape.delegationId, shape.options),
      referenceTranscript(shape.messages, shape.delegationId, shape.options),
      shape.label,
    );
  }
});

test("a high-call-count conversation builds the same transcript as the per-call scan", () => {
  const messages = resumedChain(40, 30);
  const indexed = buildSubagentTranscript(messages, "del-0");
  const reference = referenceTranscript(messages, "del-0");
  assert.equal(indexed.turns.length, 40);
  assert.deepEqual(indexed, reference, "the indexed build states the same turns, rows, and prompts");
});

test("the indexed builder reads each message a bounded number of times, independent of Task calls", () => {
  const measure = (calls) => {
    const fixture = resumedChain(calls, 30);
    const { messages, stats } = countedMessages(fixture);
    // Warm the conversation index the builder shares with the chain surface,
    // so the count below is the builder's own scan and not the shared analysis.
    subagentChainCallIds(messages, "del-0");
    stats.reads = 0;
    const transcript = buildSubagentTranscript(messages, "del-0");
    assert.ok(transcript, "the fixture builds a transcript");
    return { reads: stats.reads, rows: fixture.length, turns: transcript.turns.length };
  };
  const two = measure(2);
  const forty = measure(40);
  const perRow = forty.reads / forty.rows;
  assert.ok(
    perRow <= 4,
    `the builder read ${forty.reads} rows for ${forty.rows} messages ` +
      `(${perRow.toFixed(1)} per row): one conversation scan, not one per call`,
  );
  const growth = perRow / (two.reads / two.rows);
  assert.ok(
    growth <= 1.5,
    `per-row work grew ${growth.toFixed(2)}x from 2 to 40 Task calls ` +
      `(${two.reads}/${two.rows} then ${forty.reads}/${forty.rows})`,
  );
  console.log(
    `SUBAGENT_TRANSCRIPT_WORK calls2=${two.reads}/${two.rows} calls40=${forty.reads}/${forty.rows}`,
  );
});
