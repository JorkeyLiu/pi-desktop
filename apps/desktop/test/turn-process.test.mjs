import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const {
  projectTurnProcess,
  visibleProcessSteps,
  resolveThinkingDisplayMode,
  shouldGroupTurnProcess,
  turnProcessTiming,
} = await import("../src/lib/turn-process.ts");

const message = (id, role, content, extra = {}) => ({
  id,
  role,
  content,
  createdAt: "2026-09-17T00:00:00.000Z",
  ...extra,
});
const turn = (messages) =>
  buildTranscriptEntries(messages).entries.find(
    (entry) => entry.kind === "assistant-turn",
  );

test("one turn groups thinking, tools and progress while retaining only the trailing answer", () => {
  const entry = turn([
    message("user", "user", "Inspect"),
    message("intro", "assistant", "I will inspect", { thinking: "Plan" }),
    message("read", "tool", "result", { toolName: "Read" }),
    message("progress", "assistant", "I found the cause"),
    message("edit", "tool", "updated", { toolName: "Edit" }),
    message("final", "assistant", "Fixed"),
  ]);
  const projected = projectTurnProcess(entry);
  assert.deepEqual(
    projected.responses.map((part) => part.message.id),
    ["final"],
  );
  assert.equal(visibleProcessSteps(projected.process, "detailed", false), 5);
  assert.equal(visibleProcessSteps(projected.process, "compact", false), 4);
});

test("streamed text stays readable until later work establishes it as progress", () => {
  const text = message("text", "assistant", "Inspecting", { status: "streaming" });
  assert.equal(projectTurnProcess(turn([text])).responses[0].message, text);
  const projected = projectTurnProcess(
    turn([text, message("tool", "tool", "", { toolName: "Read" })]),
  );
  assert.equal(projected.responses.length, 0);
  assert.equal(projected.process[0].message, text);
});

test("plain answers need no empty process disclosure", () => {
  const projected = projectTurnProcess(turn([message("final", "assistant", "Answer")]));
  assert.equal(projected.process.length, 0);
  assert.equal(projected.responses.length, 1);
});

test("errors and aborted partial replies remain outside the process", () => {
  const error = message("error", "assistant", "", {
    status: "error",
    error: { code: "INTERNAL", message: "failed" },
  });
  const partial = message("partial", "assistant", "Partial answer", {
    status: "aborted",
  });
  const projected = projectTurnProcess(
    turn([error, message("tool", "tool", "result"), partial]),
  );
  assert.deepEqual(
    projected.responses.map((part) => part.message.id),
    ["error", "partial"],
  );
});

test("compact thinking disappears after reasoning ends without removing stored data", () => {
  const thinking = message("think", "assistant", "", {
    thinking: "Private reasoning",
    status: "streaming",
  });
  const entry = turn([thinking]);
  assert.equal(visibleProcessSteps(entry.parts, "compact", true), 1);
  assert.equal(visibleProcessSteps(entry.parts, "compact", false), 0);
  const withAnswer = turn([{ ...thinking, content: "Answer" }]);
  assert.equal(
    visibleProcessSteps(projectTurnProcess(withAnswer).process, "compact", true),
    0,
  );
  assert.equal(thinking.thinking, "Private reasoning");
});

test("missing and unknown display settings retain detailed mode", () => {
  for (const value of [undefined, null, "hidden", false, "detailed"]) {
    assert.equal(resolveThinkingDisplayMode(value), "detailed");
  }
  assert.equal(resolveThinkingDisplayMode("compact"), "compact");
});

test("both display modes group each turn into one process", () => {
  assert.equal(shouldGroupTurnProcess("detailed"), true);
  assert.equal(shouldGroupTurnProcess("compact"), true);
});

test("history timing uses recorded ends and rejects invalid timestamps and durations", () => {
  const entry = turn([
    message("read", "tool", "", { toolCompletedAt: "2026-09-17T00:00:02.000Z" }),
    message("answer", "assistant", "Done", {
      createdAt: "2026-09-17T00:00:03.000Z",
      responseDurationMs: 1000,
    }),
  ]);
  const timing = turnProcessTiming(entry.parts);
  assert.equal(timing.endedAt - timing.startedAt, 4000);
  assert.deepEqual(
    turnProcessTiming(
      turn([message("bad", "assistant", "x", { createdAt: "bad" })]).parts,
    ),
    {
      startedAt: undefined,
      endedAt: undefined,
    },
  );
});

test("user boundaries retain independent processes and delegation details stay attached", () => {
  const entries = buildTranscriptEntries([
    message("u1", "user", "one"),
    message("task", "tool", "started", { toolName: "Task", toolCallId: "call" }),
    message("nested", "assistant", "Delegate answer", { parentToolCallId: "call" }),
    message("a1", "assistant", "one done"),
    message("u2", "user", "two"),
    message("a2", "assistant", "two done"),
  ]).entries.filter((entry) => entry.kind === "assistant-turn");
  assert.equal(entries.length, 2);
  const first = projectTurnProcess(entries[0]);
  assert.equal(first.process[0].items[0].delegate.items[0].message.id, "nested");
  assert.equal(projectTurnProcess(entries[1]).process.length, 0);
});

test("settings writes validate the mode without changing other preferences", async () => {
  const { validateSettingsWrite } = await import("../src/lib/api.ts");
  const settings = {
    defaultMode: "agent",
    theme: "dark",
    enterToSend: true,
    onboardingDismissed: false,
  };
  assert.equal(validateSettingsWrite(settings), settings);
  const infiniteSettings = { ...settings, infiniteProviderRetry: true };
  assert.equal(validateSettingsWrite(infiniteSettings), infiniteSettings);
  assert.throws(
    () => validateSettingsWrite({ ...settings, infiniteProviderRetry: "yes" }),
    /infiniteProviderRetry is invalid/,
  );
  for (const thinkingDisplayMode of ["detailed", "compact"]) {
    const next = { ...settings, thinkingDisplayMode };
    assert.equal(validateSettingsWrite(next), next);
  }
  assert.throws(
    () => validateSettingsWrite({ ...settings, thinkingDisplayMode: "unknown" }),
    /thinkingDisplayMode is invalid/,
  );
});

const { isThinkingActive, isTurnThinking } = await import("../src/lib/turn-process.ts");

// Authoritative phase contract: the block-level thinkingStatus the runtime
// emits decides the indicator. The assistant message stays streaming through
// thinking, tools, and text alike, so neither the message status nor later
// transcript activity may stand in for the thinking phase.

test("an explicit streaming phase breathes with no text and no later activity", () => {
  const thinking = message("t1", "assistant", "", {
    thinking: "Reasoning",
    status: "streaming",
    thinkingStatus: "streaming",
  });
  assert.equal(isThinkingActive(thinking, true), true);
  assert.equal(isThinkingActive(thinking, false), false);
  const entry = turn([message("u", "user", "Go"), thinking]);
  assert.equal(isTurnThinking(entry.parts, true), true);
});

test("an explicit complete stops the indicator while the message still streams", () => {
  const done = message("t1", "assistant", "", {
    thinking: "Reasoning",
    status: "streaming",
    thinkingStatus: "complete",
  });
  assert.equal(isThinkingActive(done, true), false);
  // Complete beats position: earlier, later, or tool-adjacent, the dot stays still.
  const tool = message("call-1", "tool", "", {
    toolName: "Bash",
    toolCallId: "call-1",
    toolStatus: "running",
    status: "streaming",
  });
  const entry = turn([message("u", "user", "Go"), done, tool]);
  const tail = entry.parts.at(-1);
  assert.equal(tail.kind, "activity");
  assert.deepEqual(
    tail.items.map((item) => item.kind),
    ["thinking", "tool"],
  );
  assert.equal(isThinkingActive(tail.items[0].message, true), false);
  assert.equal(isTurnThinking(entry.parts, true), false);
});

test("a newer streaming phase breathes again after an earlier complete", () => {
  const first = message("t1", "assistant", "", {
    thinking: "First thought",
    status: "streaming",
    thinkingStatus: "complete",
  });
  const second = message("t2", "assistant", "", {
    thinking: "Second thought",
    status: "streaming",
    thinkingStatus: "streaming",
  });
  assert.equal(isThinkingActive(first, true), false);
  assert.equal(isThinkingActive(second, true), true);
  const entry = turn([message("u", "user", "Go"), first, second]);
  assert.equal(isTurnThinking(entry.parts, true), true);
});

test("legacy rows without a phase keep the documented status fallback", () => {
  // Rows written before the phase field existed (or restored history) carry
  // no thinkingStatus: a streaming, content-free row still breathes, and
  // anything settled or answered stays still.
  const live = message("t1", "assistant", "", {
    thinking: "Reasoning",
    status: "streaming",
  });
  assert.equal(isThinkingActive(live, true), true);
  assert.equal(isThinkingActive(live, false), false);
  const answered = message("t2", "assistant", "Partial answer", {
    thinking: "Reasoning",
    status: "streaming",
  });
  assert.equal(isThinkingActive(answered, true), false);
  const settled = message("t3", "assistant", "", {
    thinking: "Reasoning",
    status: "complete",
  });
  assert.equal(isThinkingActive(settled, true), false);
});
