import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The module imports its siblings the bundler way (`./tool-display`).
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  buildDiffLines,
  buildToolPresentation,
  hasToolDetails,
  langForPath,
  parseSkillDocument,
  runOutcome,
  toolResultChips,
  toolResultPayload,
} = await import("../src/lib/tool-presentation.ts");
const {
  getToolAction,
  getToolSummary,
  getToolSummaryKey,
  getToolSummaryValue,
  isToolPathSummary,
} = await import("../src/lib/tool-display.ts");
const { reviewChangeFromMessage } = await import("../src/lib/workspace-review.ts");

/** A host tool result as pi-ai delivers it: structured details plus text echo. */
function envelope(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

const roles = (blocks) => blocks.map((block) => block.role);
const byRole = (blocks, role) => blocks.find((block) => block.role === role);

test("unwraps the pi-ai envelope exactly once", () => {
  const details = { path: "a.ts", content: "line\n", root: "workspace" };
  assert.deepEqual(toolResultPayload({ toolResult: envelope(details) }), details);
  // No details: the joined content text is the payload, not the wrapper.
  assert.equal(
    toolResultPayload({
      toolResult: { content: [{ type: "text", text: "plain" }] },
    }),
    "plain",
  );
  // Imported sessions store the result as a plain string.
  assert.equal(toolResultPayload({ toolResult: "raw output" }), "raw output");
  // Nothing but the plain-text mirror.
  assert.equal(toolResultPayload({ content: "mirror" }), "mirror");
  assert.equal(toolResultPayload({}), undefined);
});

test("Read renders file content as code with a path-derived language", () => {
  const blocks = buildToolPresentation(
    {
      toolName: "Read",
      toolArgs: { path: "src/App.tsx" },
      toolResult: envelope({
        path: "src/App.tsx",
        root: "workspace",
        content: "export const App = () => null;\n",
        truncated: false,
      }),
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(blocks), ["content"]);
  const content = blocks[0];
  assert.equal(content.kind, "code");
  assert.equal(content.lang, "tsx");
  assert.equal(content.highlight, true);
  assert.equal(content.text, "export const App = () => null;\n");
});

test("Read keeps oversized or exceptionally long-line content as plain text", () => {
  for (const content of ["x".repeat(100_001), "x".repeat(2_001)]) {
    const blocks = buildToolPresentation(
      {
        toolName: "Read",
        toolArgs: { path: "src/App.tsx" },
        toolResult: envelope({ path: "src/App.tsx", content, truncated: false }),
      },
      { hideSummaryArg: true },
    );
    assert.equal(blocks[0].kind, "code");
    assert.equal(blocks[0].text, content);
    assert.equal(blocks[0].highlight, false);
  }
});

test("Write shows the written content and a size chip", () => {
  const message = {
    toolName: "Write",
    toolArgs: { path: "notes.md", content: "# Title\n" },
    toolResult: envelope({ path: "notes.md", root: "workspace", bytes: 2048 }),
  };
  const blocks = buildToolPresentation(message, { hideSummaryArg: true });
  assert.deepEqual(roles(blocks), ["written"]);
  assert.equal(blocks[0].lang, "md");
  assert.deepEqual(toolResultChips(message), [
    { role: "size", text: "2.0 KB" },
  ]);
});

test("Edit shows the stated ops when no review card owns the diff", () => {
  const args = {
    path: "src/main.ts",
    tag: "A1B2",
    ops: "PUT 2.=2:\n+const b = 3;\n",
  };
  const scratch = buildToolPresentation({
    toolName: "Edit",
    toolArgs: args,
    toolResult: envelope({ path: "src/main.ts", root: "scratch", tag: "C3D4" }),
  });
  const input = byRole(scratch, "input");
  assert.ok(input, "scratch edits render the ops");
  assert.equal(input.text, args.ops);

  // A workspace edit with a review snapshot: ReviewChangeCard owns the diff.
  const reviewed = buildToolPresentation({
    role: "tool",
    toolName: "Edit",
    toolStatus: "success",
    toolArgs: args,
    toolResult: envelope({
      path: "src/main.ts",
      root: "workspace",
      tag: "C3D4",
      review: {
        version: 1,
        snapshotId: "snap-1",
        messageId: "msg-1",
        path: "src/main.ts",
        status: "modified",
        operation: "edit",
        state: "active",
        additions: 1,
        deletions: 1,
        hunks: [],
      },
    }),
  });
  assert.equal(byRole(reviewed, "diff"), undefined);
});

test("Bash keeps its channels apart and leaves the command to the head", () => {
  const message = {
    toolName: "Bash",
    toolArgs: { command: "pnpm test" },
    toolResult: envelope({
      exitCode: 1,
      stdout: "3 passing\n",
      stderr: "1 failing\n",
      truncated: true,
    }),
  };
  // The row's head prints the command and copies it, and the body is the
  // terminal: the command pane plus the two output channels (D226).
  const blocks = buildToolPresentation(message, { hideSummaryArg: true });
  assert.deepEqual(roles(blocks), ["command"]);
  const terminal = blocks[0];
  assert.equal(terminal.kind, "terminal");
  assert.equal(terminal.command, "pnpm test");
  assert.equal(terminal.stdout, "3 passing\n");
  assert.equal(terminal.stderr, "1 failing\n");
  assert.deepEqual(toolResultChips(message), [
    { role: "exit", count: 1 },
    { role: "truncated" },
  ]);
  // A permission card has no head of its own, so the pane is the only place the
  // command appears; it is the same terminal either way.
  const asked = buildToolPresentation(message);
  assert.deepEqual(roles(asked), ["command"]);
  assert.equal(asked[0].kind, "terminal");
  assert.equal(asked[0].command, "pnpm test");
});

test("Bash progress output renders in the stdout channel before completion", () => {
  const progress = buildToolPresentation(
    {
      toolName: "Bash",
      toolStatus: "running",
      toolArgs: { command: "for i in 1 2 3; do echo $i; done" },
      toolResult: envelope({ output: "1\n2\n" }),
    },
    { hideSummaryArg: true },
  );
  // The body is the terminal (D226 follow-up): a progress snapshot lands in its
  // stdout pane while the command still runs, and the command it ran stays
  // visible beside the output.
  assert.deepEqual(roles(progress), ["command"]);
  assert.equal(progress[0].kind, "terminal");
  assert.equal(progress[0].command, "for i in 1 2 3; do echo $i; done");
  assert.equal(progress[0].stdout, "1\n2\n");
  assert.equal(progress[0].stderr, null);

  // The completed shape remains authoritative when both fields are present;
  // this prevents a stale progress snapshot from winning after tool_end.
  const completed = buildToolPresentation(
    {
      toolName: "Bash",
      toolStatus: "success",
      toolArgs: { command: "echo done" },
      toolResult: envelope({ output: "stale\n", stdout: "done\n" }),
    },
    { hideSummaryArg: true },
  );
  assert.equal(completed[0].stdout, "done\n");

  // An explicit empty stdout is a value, not a fallback: the stale snapshot
  // must not come back, and the channel reads as empty rather than missing.
  const completedEmpty = buildToolPresentation(
    {
      toolName: "Bash",
      toolStatus: "success",
      toolArgs: { command: ":" },
      toolResult: envelope({ output: "stale\n", stdout: "" }),
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(completedEmpty), ["command"]);
  assert.equal(completedEmpty[0].stdout, null);
  assert.equal(completedEmpty[0].stderr, null);
});

test("the run outcome comes from the exit code, not from the call's status", () => {
  const run = (details, toolStatus) =>
    runOutcome({
      toolName: "Bash",
      toolArgs: { command: "pnpm test" },
      ...(details === null ? {} : { toolResult: envelope(details) }),
      ...(toolStatus ? { toolStatus } : {}),
    });
  // The row must not read as done just because the call carrying it came back.
  assert.equal(run({ exitCode: 1, stdout: "", stderr: "boom" }, "success"), "failed");
  assert.equal(run({ exitCode: 0, stdout: "ok\n" }, "success"), "ok");
  // A killed shell reports no code at all; the host counts that as a failure.
  assert.equal(run({ exitCode: null, stdout: "" }, "success"), "failed");
  assert.equal(run({ exitCode: 0 }, "running"), "running");
  assert.equal(run({ exitCode: 0 }, "denied"), "denied");
  // Tools that report no exit code fall back to the call's own status.
  assert.equal(run({ ok: true }, "success"), "ok");
  assert.equal(run({ ok: false }, "error"), "failed");
  // Nothing known: the row says nothing rather than claiming success.
  assert.equal(run(null), "unknown");
});

test("a command that prints nothing does not fall back to its arguments", () => {
  const message = {
    toolName: "Bash",
    toolArgs: { command: "true", description: "check the exit code" },
    toolResult: envelope({ exitCode: 0, stdout: "", stderr: "" }),
  };
  // The terminal stays — a command that printed nothing still shows what ran —
  // but the command must not come back a second time as an `input` argument
  // row, whether or not the head already shows it.
  const withheld = buildToolPresentation(message, { hideSummaryArg: true });
  assert.deepEqual(roles(withheld), ["command"]);
  assert.equal(withheld[0].kind, "terminal");
  assert.equal(withheld[0].command, "true");
  assert.equal(withheld[0].stdout, null);
  // An empty channel is omitted, not rendered as an empty pane.
  assert.equal(withheld[0].stderr, null);
  // A permission card has no head of its own, so it gets the same terminal and
  // still no argument dump.
  const asked = buildToolPresentation(message);
  assert.deepEqual(roles(asked), ["command"]);
  assert.equal(asked[0].command, "true");
});

test("a clean run omits empty channels and the exit chip", () => {
  const message = {
    toolName: "Bash",
    toolArgs: { command: "true" },
    toolResult: envelope({ exitCode: 0, stdout: "", stderr: "" }),
  };
  assert.deepEqual(roles(buildToolPresentation(message)), ["command"]);
  assert.deepEqual(toolResultChips(message), []);
});

test("Glob lists files and Grep groups hits by path", () => {
  const glob = {
    toolName: "Glob",
    toolArgs: { pattern: "src/**/*.ts" },
    toolResult: envelope({ matches: ["src/a.ts", "src/b.ts"], count: 2 }),
  };
  const globBlocks = buildToolPresentation(glob, { hideSummaryArg: true });
  assert.deepEqual(roles(globBlocks), ["files"]);
  assert.deepEqual(globBlocks[0].paths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(toolResultChips(glob), [{ role: "files", count: 2 }]);

  const grep = {
    toolName: "Grep",
    toolArgs: { pattern: "TODO" },
    toolResult: envelope({
      matches: [
        { path: "src/a.ts", line: 4, text: "// TODO one" },
        { path: "src/a.ts", line: 9, text: "// TODO two" },
        { path: "src/b.ts", line: 1, text: "// TODO three" },
      ],
      count: 3,
    }),
  };
  const grepBlocks = buildToolPresentation(grep, { hideSummaryArg: true });
  assert.deepEqual(roles(grepBlocks), ["matches"]);
  assert.deepEqual(
    grepBlocks[0].groups.map((group) => [group.path, group.lines.length]),
    [
      ["src/a.ts", 2],
      ["src/b.ts", 1],
    ],
  );
  assert.deepEqual(toolResultChips(grep), [{ role: "matches", count: 3 }]);
});

test("Grep's other output modes and host notices stay readable", () => {
  // outputMode: "filesWithMatches" answers with paths, not hits.
  const paths = {
    toolName: "Grep",
    toolArgs: { pattern: "TODO", outputMode: "filesWithMatches" },
    toolResult: envelope({
      files: ["src/a.ts", "src/b.ts"],
      count: 7,
      truncated: false,
    }),
  };
  const pathBlocks = buildToolPresentation(paths, { hideSummaryArg: true });
  assert.deepEqual(roles(pathBlocks), ["files"]);
  assert.deepEqual(pathBlocks[0].paths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(toolResultChips(paths), [{ role: "matches", count: 7 }]);

  // outputMode: "count" answers with per-file totals.
  const counted = {
    toolName: "Grep",
    toolArgs: { pattern: "TODO", outputMode: "count" },
    toolResult: envelope({
      counts: [
        { path: "src/a.ts", count: 2 },
        { path: "src/b.ts", count: 5 },
      ],
      count: 7,
      truncated: false,
    }),
  };
  const countBlocks = buildToolPresentation(counted, { hideSummaryArg: true });
  assert.deepEqual(roles(countBlocks), ["matches"]);
  assert.deepEqual(countBlocks[0].rows, [
    { label: "src/a.ts", value: "2" },
    { label: "src/b.ts", value: "5" },
  ]);

  // A scoping notice qualifies the block it follows and is not error-hued.
  const noticed = buildToolPresentation(
    {
      toolName: "Glob",
      toolArgs: { pattern: "src/**" },
      toolResult: envelope({
        matches: ["src/a.ts"],
        count: 1,
        truncated: true,
        notice: "more files match; raise limit or narrow pattern/path",
      }),
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(noticed), ["files", "notice"]);
  assert.equal(noticed[1].kind, "note");
  assert.match(noticed[1].text, /raise limit/);
});

test("a paginated Read window shows its line range and notice", () => {
  const message = {
    toolName: "Read",
    toolArgs: { path: "big.txt", offset: 200, limit: 2 },
    toolResult: envelope({
      path: "big.txt",
      root: "workspace",
      content: "line 201\nline 202",
      truncated: true,
      offset: 200,
      lineCount: 2,
      fileBytes: 2048,
      totalLines: 900,
      notice: "showing lines 201-202 of 900",
    }),
  };
  const blocks = buildToolPresentation(message, { hideSummaryArg: true });
  assert.deepEqual(roles(blocks), ["content", "notice"]);
  assert.equal(blocks[0].text, "line 201\nline 202");
  assert.deepEqual(toolResultChips(message), [
    { role: "lines", text: "2,L201-L202" },
    { role: "truncated" },
  ]);
});

test("a complete Read window uses its returned line count, not file size", () => {
  const message = {
    toolName: "Read",
    toolArgs: { path: "small.txt" },
    toolResult: envelope({
      path: "small.txt",
      root: "workspace",
      content: "line 1\nline 2\nline 3",
      offset: 0,
      lineCount: 3,
      totalLines: 3,
      fileBytes: 169_600,
      truncated: false,
    }),
  };

  assert.deepEqual(toolResultChips(message), [
    { role: "lines", text: "3,L1-L3" },
  ]);
});

test("a historical Read without line metadata does not fake a size chip", () => {
  assert.deepEqual(
    toolResultChips({
      toolName: "Read",
      toolResult: envelope({
        path: "legacy.txt",
        content: "1: legacy line",
        fileBytes: 2048,
      }),
    }),
    [],
  );
});

test("a failed tool leads with the error note and keeps the arguments", () => {
  const blocks = buildToolPresentation(
    {
      toolName: "Read",
      toolStatus: "error",
      toolArgs: { path: "missing.ts", limit: 20 },
      toolResult: envelope({ error: "no such file", code: "ENOENT" }),
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(blocks), ["error", "input"]);
  assert.deepEqual(blocks[0], {
    kind: "note",
    role: "error",
    text: "no such file",
    code: "ENOENT",
  });
  // The path is already the row summary; only the rest is repeated.
  assert.deepEqual(blocks[1].rows, [{ label: "limit", value: "20" }]);
});

test("unknown plugin payloads degrade to fields and labeled blocks, not a blob", () => {
  const blocks = buildToolPresentation({
    toolName: "plugin_issue_tracker_create",
    toolArgs: { title: "Bug" },
    toolResult: envelope({
      id: 41,
      url: "https://example.test/41",
      ok: true,
      body: "line one\nline two",
      nested: { retries: 2 },
    }),
  });
  const fields = byRole(blocks, "details");
  assert.equal(fields.kind, "fields");
  assert.deepEqual(fields.rows, [
    { label: "id", value: "41" },
    { label: "url", value: "https://example.test/41" },
    { label: "ok", value: "true" },
  ]);
  const labeled = blocks.filter((block) => block.label);
  assert.deepEqual(
    labeled.map((block) => [block.label, block.kind, block.lang]),
    [
      ["body", "code", ""],
      ["nested", "code", "json"],
    ],
  );
  // Opaque tools still show what they were called with.
  assert.deepEqual(byRole(blocks, "input").rows, [
    { label: "title", value: "Bug" },
  ]);
});

test("a string result from an unmapped tool becomes a single output block", () => {
  const blocks = buildToolPresentation({
    toolName: "plugin_echo",
    toolArgs: { message: "loaded review skill" },
    toolResult: "loaded review skill",
  });
  const output = byRole(blocks, "output");
  assert.equal(output.kind, "code");
  assert.equal(output.text, "loaded review skill");
  assert.equal(output.highlight, false);
});

test("a Skill answer becomes the document it loaded, not a raw blob", () => {
  const text = [
    "# Skill: Release notes (release-notes)",
    "Location: /plugins/skills/release-notes/SKILL.md",
    "References are relative to /plugins/skills/release-notes.",
    "",
    "# Release notes",
    "Write the entry from the diff.",
  ].join("\n");
  assert.deepEqual(parseSkillDocument(text), {
    name: "Release notes",
    id: "release-notes",
    location: "/plugins/skills/release-notes/SKILL.md",
    references: "/plugins/skills/release-notes",
    body: "# Release notes\nWrite the entry from the diff.",
  });

  const blocks = buildToolPresentation(
    {
      toolName: "functions.Skill",
      toolArgs: { id: "release-notes" },
      toolResult: text,
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(blocks), ["output"]);
  const document = blocks[0];
  assert.equal(document.kind, "document");
  assert.equal(document.title, "Release notes");
  assert.equal(document.id, "release-notes");
  assert.deepEqual(document.fields, [
    { label: "location", value: "/plugins/skills/release-notes/SKILL.md" },
    { label: "references", value: "/plugins/skills/release-notes" },
  ]);
  assert.equal(document.body, "# Release notes\nWrite the entry from the diff.");

  // Text that is not a skill document still reaches the reader as the body,
  // named after its own first line instead of being thrown away.
  const plain = buildToolPresentation({
    toolName: "Skill",
    toolArgs: { id: "notes" },
    toolResult: "Just an answer\nsecond line",
  });
  assert.equal(plain[0].kind, "document");
  assert.equal(plain[0].title, "Just an answer");
  assert.equal(plain[0].id, "notes");
  assert.equal(plain[0].body, "Just an answer\nsecond line");
});

test("a failed Skill call reads as an error, never as a document", () => {
  const failed = buildToolPresentation({
    toolName: "Skill",
    toolStatus: "error",
    toolArgs: { id: "missing" },
    toolResult: 'Skill "missing" was not found',
  });
  // The error note leads; the arguments it was called with stay visible, and
  // no document card is built from the failure text.
  assert.deepEqual(roles(failed), ["error", "input"]);
  assert.equal(failed[0].kind, "note");
  assert.equal(failed[0].role, "error");
  assert.match(failed[0].text, /not found/);
  assert.deepEqual(failed[1].rows, [{ label: "id", value: "missing" }]);

  // An envelope that flags itself as an error is one too, even when an imported
  // transcript never updated the call's own status.
  const imported = buildToolPresentation({
    toolName: "Skill",
    toolArgs: { id: "missing" },
    toolResult: {
      isError: true,
      content: [{ type: "text", text: 'Skill "missing" was not found' }],
    },
  });
  assert.deepEqual(roles(imported), ["error", "input"]);
  assert.equal(imported[0].role, "error");
  assert.match(imported[0].text, /not found/);
});

test("no known-tool block ever contains pretty-printed JSON of its payload", () => {
  const messages = [
    {
      toolName: "Read",
      toolArgs: { path: "a.ts" },
      toolResult: envelope({ path: "a.ts", content: "x\n", root: "workspace" }),
    },
    {
      toolName: "Bash",
      toolArgs: { command: "ls" },
      toolResult: envelope({ exitCode: 0, stdout: "a\nb\n", stderr: "" }),
    },
    {
      toolName: "Grep",
      toolArgs: { pattern: "x" },
      toolResult: envelope({ matches: [{ path: "a.ts", line: 1, text: "x" }], count: 1 }),
    },
  ];
  for (const message of messages) {
    for (const block of buildToolPresentation(message, { hideSummaryArg: true })) {
      if (block.kind !== "code") continue;
      assert.notEqual(block.lang, "json", `${message.toolName} fell back to JSON`);
      assert.ok(
        !block.text.includes('"content"') && !block.text.includes('"exitCode"'),
        `${message.toolName} leaked the raw payload into a block`,
      );
    }
  }
});

test("lists and diffs report what they hid instead of dropping it", () => {
  const paths = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts`);
  const blocks = buildToolPresentation({
    toolName: "Glob",
    toolArgs: { pattern: "src/**" },
    toolResult: envelope({ matches: paths, count: paths.length }),
  });
  assert.equal(blocks[0].paths.length, 200);
  assert.equal(blocks[0].hidden, 50);

  const oldLines = Array.from({ length: 250 }, (_, i) => `old ${i}`).join("\n");
  const newLines = Array.from({ length: 250 }, (_, i) => `new ${i}`).join("\n");
  const diff = {
    kind: "diff",
    lines: buildDiffLines(oldLines, newLines),
  };
  assert.equal(diff.lines.length, 500);
  const hidden = Math.max(0, diff.lines.length - 400);
  assert.equal(hidden, 100);
});

test("huge payloads skip syntax highlighting", () => {
  const blocks = buildToolPresentation({
    toolName: "Read",
    toolArgs: { path: "huge.ts" },
    toolResult: envelope({
      path: "huge.ts",
      root: "workspace",
      content: "a".repeat(100_001),
    }),
  });
  assert.equal(blocks[0].highlight, false);
});

test("scratch root is badged so the sandboxed target is visible", () => {
  assert.deepEqual(
    toolResultChips({
      toolName: "Edit",
      toolResult: envelope({ path: "t.txt", root: "scratch", tag: "A1B2" }),
    }),
    [{ role: "scratch" }],
  );
});

test("hasToolDetails only reports rows that can actually expand", () => {
  assert.equal(hasToolDetails({}), false);
  assert.equal(hasToolDetails({ toolArgs: {} }), false);
  assert.equal(hasToolDetails({ toolResult: envelope({}) }), false);
  assert.equal(hasToolDetails({ toolArgs: { path: "a.ts" } }), true);
  assert.equal(hasToolDetails({ toolResult: "text" }), true);
  assert.equal(hasToolDetails({ content: "mirror" }), true);
});

test("language tags come from the file name, not the payload", () => {
  assert.equal(langForPath("src/App.tsx"), "tsx");
  assert.equal(langForPath("crates/host/src/main.rs"), "rs");
  assert.equal(langForPath("Dockerfile"), "dockerfile");
  assert.equal(langForPath("Makefile"), "makefile");
  assert.equal(langForPath("LICENSE"), "");
  assert.equal(langForPath(null), "");
});

test("diff trims shared context down to the replacement", () => {
  // Identical text carries no add/del line, so the row renders no diff at all.
  assert.ok(
    buildDiffLines("same", "same").every((line) => line.type === "context"),
  );
  assert.deepEqual(
    buildDiffLines("a\nb\nc\nd\ne", "a\nb\nX\nd\ne").map((l) => l.type),
    ["context", "context", "del", "add", "context", "context"],
  );
  assert.equal(
    buildToolPresentation({
      toolName: "Edit",
      toolArgs: { path: "a.ts", tag: "AAAA", ops: "PUT 1.=1:\n+same\n" },
      toolResult: envelope({ path: "a.ts", root: "scratch", replacements: 0 }),
    }).some((block) => block.kind === "diff"),
    false,
  );
});

test("a delegation reads as brief in, report out, counters last", () => {
  const blocks = buildToolPresentation(
    {
      toolName: "Task",
      toolArgs: {
        agent: "code-reviewer",
        description: "Review the store",
        task: "Read app-store.ts and report dead branches.",
      },
      toolResult: envelope({
        agent: "code-reviewer",
        status: "completed",
        turns: 3,
        toolCalls: 5,
      }),
    },
    { hideSummaryArg: true },
  );

  assert.deepEqual(roles(blocks), ["input", "output", "details"]);
  const brief = byRole(blocks, "input");
  assert.equal(brief.label, "task");
  assert.equal(brief.text, "Read app-store.ts and report dead branches.");
  // The report is the envelope text, not the JSON mirror of the counters.
  assert.equal(
    byRole(blocks, "output").text,
    JSON.stringify({
      agent: "code-reviewer",
      status: "completed",
      turns: 3,
      toolCalls: 5,
    }),
  );
  // `agent` already labels the row, so the footer only carries the counters.
  assert.deepEqual(byRole(blocks, "details").rows, [
    { label: "status", value: "completed" },
    { label: "turns", value: "3" },
    { label: "toolCalls", value: "5" },
  ]);
});

test("a delegation whose rows are nested does not print the report twice", () => {
  const message = {
    toolName: "Task",
    toolArgs: { agent: "code-reviewer", task: "Review the store" },
    toolResult: {
      content: [{ type: "text", text: "Two dead branches." }],
      details: { agent: "code-reviewer", status: "completed", turns: 2 },
    },
  };

  assert.equal(
    byRole(buildToolPresentation(message), "output").text,
    "Two dead branches.",
  );
  // The delegate's own answer row already shows that text one level in.
  assert.equal(
    byRole(buildToolPresentation(message, { hideDelegateReport: true }), "output"),
    undefined,
  );
});

test("a failed delegation shows the error, not an empty report", () => {
  const blocks = buildToolPresentation({
    toolName: "Task",
    toolArgs: { agent: "ghost", task: "Do the thing" },
    toolStatus: "error",
    toolResult: {
      content: [{ type: "text", text: "unknown agent: ghost" }],
      details: { error: "unknown agent: ghost" },
    },
  });

  assert.equal(byRole(blocks, "output").text, "unknown agent: ghost");
  // `error` is not a counter: the report above already says it.
  assert.equal(byRole(blocks, "details"), undefined);
});

test("a lifecycle row's body is a named roster, not raw JSON (D268)", () => {
  const blocks = buildToolPresentation({
    toolName: "TaskWait",
    toolArgs: { delegationIds: ["d1", "d2"] },
    toolResult: {
      content: [{ type: "text", text: "## explorer (d1) — completed\nFound it." }],
      details: {
        delegations: [
          {
            delegationId: "d1",
            agent: "explorer",
            status: "completed",
            startedAt: 1000,
            completedAt: 4000,
            turns: 6,
          },
          { delegationId: "d2", agent: "fixer", status: "running" },
        ],
      },
    },
  });

  // The joined reports lead, then one readable line per subagent. The reports
  // are an output block, so they scroll inside a bounded height (D271).
  assert.deepEqual(roles(blocks), ["output", "details"]);
  assert.deepEqual(byRole(blocks, "details").rows, [
    { label: "explorer", value: "completed · 3s · 6 turns" },
    { label: "fixer", value: "running" },
  ]);
  // A lifecycle row has no brief of its own, so the ids it was called with do
  // not come back as an argument block.
  assert.equal(
    blocks.some((block) => block.role === "input"),
    false,
  );
});

test("TaskStop renders its `stopped` roster the same way", () => {
  const blocks = buildToolPresentation({
    toolName: "TaskStop",
    toolArgs: {},
    toolResult: {
      content: [{ type: "text", text: "Stopped 1 subagent." }],
      details: {
        stopped: [
          { delegationId: "s1", agent: "test-runner", status: "stopped" },
        ],
      },
    },
  });
  assert.deepEqual(byRole(blocks, "details").rows, [
    { label: "test-runner", value: "stopped" },
  ]);
});

test("a malformed roster degrades instead of rendering blank rows", () => {
  // A partial or hand-written payload must not crash the row or print a table
  // row with no label and no value, which reads as a rendering fault.
  const blocks = buildToolPresentation({
    toolName: "TaskWait",
    toolArgs: { delegationIds: ["x"] },
    toolResult: {
      details: {
        delegations: [null, 5, "x", {}, { delegationId: "d", status: "running" }],
      },
    },
  });
  assert.deepEqual(byRole(blocks, "details").rows, [
    { label: "d", value: "running" },
  ]);
  // A lifecycle row whose result has not arrived yet has nothing to expand,
  // and must not fall back to printing the ids it was called with.
  assert.deepEqual(
    buildToolPresentation({
      toolName: "TaskWait",
      toolArgs: { delegationIds: ["x"] },
    }),
    [],
  );
});

test("TodoWrite renders the checklist it wrote, not a serialized argument", () => {
  assert.equal(getToolAction("TodoWrite"), "todo");
  const message = {
    toolName: "TodoWrite",
    toolArgs: {
      todos: [
        { content: "Inspect", status: "pending", priority: "high" },
        { content: "Patch", status: "in_progress" },
        { content: "Obsolete", status: "cancelled" },
        { content: "", status: "pending" },
        { content: "Invented status", status: "sideways" },
      ],
    },
    toolResult: envelope({
      text: "Checklist updated: 0/3 completed",
      revision: 1,
      summary: { completed: 0, total: 3, inProgress: 1, cancelled: 1 },
      warnings: [],
    }),
  };
  const blocks = buildToolPresentation(message);
  assert.deepEqual(roles(blocks), ["details"]);
  const checklist = blocks[0];
  assert.equal(checklist.kind, "todos");
  // Rows come from the call's own list, with the schema's four states; an
  // entry the schema cannot describe is left out rather than rendered blank.
  assert.deepEqual(
    checklist.items.map((item) => [item.content, item.status, item.priority ?? null]),
    [
      ["Inspect", "pending", "high"],
      ["Patch", "in_progress", null],
      ["Obsolete", "cancelled", null],
    ],
  );
  assert.deepEqual(
    [checklist.completed, checklist.total, checklist.cancelled, checklist.hidden],
    [0, 3, 1, 0],
  );
  // Nothing in the card is a JSON dump of the argument, and the host's own
  // success line ("Checklist updated: …") is not repeated as a second
  // section: it only restates the progress the checklist already shows.
  assert.ok(!JSON.stringify(blocks).includes('"todos":'));
  assert.ok(!JSON.stringify(blocks).includes("Checklist updated"));
});

test("a routine TodoWrite writes no generic success section", () => {
  const text = "Checklist updated: 0/1 completed; current: Inspect";
  const blocks = buildToolPresentation({
    toolName: "TodoWrite",
    toolStatus: "success",
    toolArgs: { todos: [{ content: "Inspect", status: "in_progress" }] },
    toolResult: {
      content: [{ type: "text", text }],
      details: {
        text,
        revision: 1,
        summary: { completed: 0, total: 1, inProgress: 1, cancelled: 0 },
        warnings: [],
      },
    },
  });
  // The checklist is the whole body: its own progress line already carries the
  // counts and the in-progress item the host sentence spells out.
  assert.deepEqual(roles(blocks), ["details"]);
  assert.equal(blocks[0].kind, "todos");
  assert.ok(!JSON.stringify(blocks).includes("Checklist updated"));

  // A refused write is not routine: the host reports it through `error`, and
  // that note is the body a reader gets.
  const refused = buildToolPresentation({
    toolName: "TodoWrite",
    toolStatus: "error",
    toolArgs: { todos: [{ content: "Inspect", status: "pending" }] },
    toolResult: {
      content: [{ type: "text", text: "TodoWrite is unavailable here" }],
      details: {
        error: "TodoWrite is unavailable in Plan mode",
        code: "MODE_REFUSED",
      },
      isError: true,
    },
  });
  assert.deepEqual(byRole(refused, "error"), {
    kind: "note",
    role: "error",
    text: "TodoWrite is unavailable in Plan mode",
    code: "MODE_REFUSED",
  });
});

test("a ToolSearch lists each group once and drops the wrapper sentence", () => {
  const names = ["Browser", "BrowserPreview"];
  const activatedText = `Activated on-demand tools: ${names.join(", ")}. They are available on the next model turn.`;
  const current = buildToolPresentation({
    toolName: "ToolSearch",
    toolStatus: "success",
    toolArgs: { query: "browser" },
    toolResult: {
      content: [{ type: "text", text: activatedText }],
      details: {
        query: "browser",
        matches: [...names],
        activated: [...names],
        addedToolNames: [...names],
      },
    },
  });
  // One section per group of names, and no "notice" restating them: the
  // sentence pi hands the model is a wrapper around these lists.
  assert.deepEqual(roles(current), ["details", "details"]);
  assert.deepEqual(
    current.map((block) => block.label),
    ["activated", "matches"],
  );
  assert.deepEqual(current[0].items, names);
  assert.ok(!JSON.stringify(current).includes("available on the next model turn"));

  // A legacy row that only carries the alias still names what it added.
  const legacy = buildToolPresentation({
    toolName: "ToolSearch",
    toolStatus: "success",
    toolArgs: { query: "glob" },
    toolResult: {
      content: [{ type: "text", text: "Activated on-demand tools: Glob." }],
      details: { query: "glob", addedToolNames: ["Glob"] },
    },
  });
  assert.deepEqual(
    legacy.map((block) => [block.role, block.label, block.items]),
    [["details", "added", ["Glob"]]],
  );

  // A search that lists nothing keeps the answer, because nothing else holds
  // it, and a failed search speaks as the error it is.
  const noMatchText = "No matching on-demand tool. Available names: Glob, Grep.";
  const noMatch = buildToolPresentation({
    toolName: "ToolSearch",
    toolStatus: "success",
    toolArgs: { query: "zebra" },
    toolResult: {
      content: [{ type: "text", text: noMatchText }],
      details: { query: "zebra", matches: [], activated: [] },
    },
  });
  assert.equal(byRole(noMatch, "notice").text, noMatchText);
  assert.equal(byRole(noMatch, "error"), undefined);
  const failed = buildToolPresentation({
    toolName: "ToolSearch",
    toolStatus: "error",
    toolArgs: { query: "zebra" },
    toolResult: {
      content: [{ type: "text", text: "ToolSearch is unavailable in Goal mode" }],
      details: { query: "zebra" },
      isError: true,
    },
  });
  assert.equal(byRole(failed, "error").text, "ToolSearch is unavailable in Goal mode");
});

test("a TodoWrite warning reaches the reader without a second checklist", () => {
  const blocks = buildToolPresentation({
    toolName: "TodoWrite",
    toolArgs: { todos: [{ content: "Inspect", status: "pending" }] },
    toolResult: envelope({
      summary: { completed: 0, total: 1, cancelled: 0 },
      warnings: ["Only one item is in progress at a time"],
    }),
  });
  assert.deepEqual(roles(blocks), ["details", "notice"]);
  assert.equal(blocks[0].kind, "todos");
  assert.deepEqual(blocks[1], {
    kind: "note",
    role: "notice",
    text: "Only one item is in progress at a time",
  });
});

test("a TodoWrite card reads the list the host committed, not the raw argument", () => {
  // The host trims, truncates and demotes before it stores anything, so the
  // argument a model wrote is not always the checklist a session holds. The
  // committed list the result now carries is what the card must show.
  const blocks = buildToolPresentation({
    toolName: "TodoWrite",
    toolStatus: "success",
    toolArgs: {
      todos: [
        { content: "x".repeat(600), status: "in_progress", priority: "high" },
        { content: "Second active item", status: "in_progress" },
      ],
    },
    toolResult: envelope({
      text: "Checklist updated: 0/2 completed [1 item(s) were truncated to 500 characters]",
      revision: 4,
      summary: { completed: 0, total: 2, inProgress: 1, cancelled: 0 },
      warnings: ["1 item(s) were truncated to 500 characters"],
      todos: [
        { content: "x".repeat(500), status: "in_progress", priority: "high" },
        { content: "Second active item", status: "pending", priority: "medium" },
      ],
    }),
  });
  const checklist = byRole(blocks, "details");
  assert.equal(checklist.kind, "todos");
  assert.deepEqual(
    checklist.items.map((item) => [item.content.length, item.status]),
    [[500, "in_progress"], ["Second active item".length, "pending"]],
  );
  assert.deepEqual(
    [checklist.completed, checklist.total, checklist.cancelled],
    [0, 2, 0],
  );
});

test("an older TodoWrite row without a committed list still reads its own argument", () => {
  // Rows persisted before the result carried `todos` stay readable: their own
  // argument is the only list they have, and the session's current snapshot is
  // never consulted for a historical card.
  const blocks = buildToolPresentation({
    toolName: "TodoWrite",
    toolStatus: "success",
    toolArgs: {
      todos: [
        { content: "Inspect", status: "completed" },
        { content: "Patch", status: "cancelled" },
      ],
    },
    toolResult: envelope({
      text: "Checklist updated: 1/1 completed",
      revision: 2,
      summary: { completed: 1, total: 1, inProgress: 0, cancelled: 1 },
      warnings: [],
    }),
  });
  const checklist = byRole(blocks, "details");
  assert.equal(checklist.kind, "todos");
  assert.deepEqual(
    checklist.items.map((item) => [item.content, item.status]),
    [["Inspect", "completed"], ["Patch", "cancelled"]],
  );
  assert.deepEqual([checklist.completed, checklist.total, checklist.cancelled], [1, 1, 1]);
});

test("clearing the checklist keeps a body the disclosure can point at", () => {
  // An empty write is a real state — the host advances the revision and the
  // session now holds nothing — so the row needs a body saying so. Without one
  // the row is expandable with `aria-controls` naming an element that is never
  // rendered.
  const message = {
    toolName: "TodoWrite",
    toolStatus: "success",
    toolArgs: { todos: [] },
    toolResult: envelope({
      text: "Checklist updated: 0/0 completed",
      revision: 5,
      summary: { completed: 0, total: 0, inProgress: 0, cancelled: 0 },
      warnings: [],
      todos: [],
    }),
  };
  const blocks = buildToolPresentation(message);
  assert.deepEqual(roles(blocks), ["details"]);
  const checklist = blocks[0];
  assert.equal(checklist.kind, "todos");
  assert.deepEqual(checklist.items, []);
  assert.deepEqual(
    [checklist.completed, checklist.total, checklist.cancelled],
    [0, 0, 0],
  );
  // The row is only expandable because that body exists.
  assert.equal(hasToolDetails(message), true);
});

test("a refused TodoWrite never shows its argument as a committed checklist", () => {
  // A refused write commits nothing, so the list in the call must not appear
  // as if the session held it; the error stays the body.
  const blocks = buildToolPresentation({
    toolName: "TodoWrite",
    toolStatus: "error",
    isError: true,
    toolArgs: { todos: [{ content: "Inspect", status: "in_progress" }] },
    toolResult: {
      content: [{ type: "text", text: "TodoWrite requires Agent mode" }],
      details: { error: "TodoWrite requires Agent mode", code: "TOOL_DISABLED_IN_PLAN" },
      isError: true,
    },
  });
  assert.deepEqual(blocks, [
    {
      kind: "note",
      role: "error",
      text: "TodoWrite requires Agent mode",
      code: "TOOL_DISABLED_IN_PLAN",
    },
  ]);
  assert.ok(!JSON.stringify(blocks).includes('"todos"'));
});
test("a running TodoWrite with an undescribable argument still has a body", () => {
  // Before any result arrives there is no committed list to show, and a list
  // the schema cannot describe leaves nothing for the card. The argument is
  // then the only evidence, and the row still needs a body for the disclosure
  // its header points at — without ever claiming the checklist was written.
  const blocks = buildToolPresentation({
    toolName: "TodoWrite",
    toolStatus: "running",
    toolArgs: { todos: "not-a-list" },
  });
  assert.ok(blocks.length > 0);
  assert.ok(blocks.every((block) => block.kind !== "todos"));
});

test("a run row summarizes the model's description and keeps its command whole", () => {
  const args = {
    command: "pnpm test \\\n  --filter desktop",
    description: "Run the desktop tests",
  };
  assert.equal(getToolSummary("Bash", args), "Run the desktop tests");
  assert.equal(getToolSummaryKey("Bash", args), "description");
  assert.equal(isToolPathSummary("Bash", args), false);
  // The head's copy control hands back the command, never the label.
  assert.equal(getToolSummaryValue("Bash", args), args.command);
  // A permission card has no head, so the terminal pane still names it.
  const blocks = buildToolPresentation(
    {
      toolName: "Bash",
      toolStatus: "success",
      toolArgs: args,
      toolResult: envelope({ exitCode: 0, stdout: "ok\n" }),
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(blocks), ["command"]);
  assert.equal(blocks[0].command, args.command);
  assert.equal(byRole(blocks, "input"), undefined);
});

test("a legacy run argument is still the command it ran", () => {
  const message = {
    toolName: "Bash",
    toolArgs: { cmd: "make -j4" },
    toolResult: envelope({ exitCode: 2, stderr: "boom\n" }),
  };
  const blocks = buildToolPresentation(message, { hideSummaryArg: true });
  assert.deepEqual(roles(blocks), ["command"]);
  assert.equal(blocks[0].command, "make -j4");
  assert.equal(blocks[0].stdout, null);
  assert.equal(blocks[0].stderr, "boom\n");
  assert.equal(runOutcome(message), "failed");
  assert.deepEqual(toolResultChips(message), [{ role: "exit", count: 2 }]);
});

test("a failed run keeps its error note beside the terminal", () => {
  const blocks = buildToolPresentation(
    {
      toolName: "Bash",
      toolStatus: "error",
      toolArgs: { command: "definitely-not-a-command" },
      toolResult: envelope({
        error: "command not found",
        code: "ENOENT",
        exitCode: 127,
        stderr: "definitely-not-a-command: not found\n",
      }),
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(blocks), ["error", "command"]);
  assert.deepEqual(blocks[0], {
    kind: "note",
    role: "error",
    text: "command not found",
    code: "ENOENT",
  });
  assert.equal(blocks[1].command, "definitely-not-a-command");
  assert.match(blocks[1].stderr, /not found/);
});

test("a scheduled automation names its weekly days instead of numbering them", () => {
  const message = {
    toolName: "ScheduledTaskList",
    toolArgs: {},
    toolResult: {
      content: [{ type: "text", text: "2 scheduled automations" }],
      details: {
        tasks: [
          {
            id: "t1",
            title: "Nightly",
            cadence: "weekly",
            enabled: true,
            schedule: { hour: 9, minute: 5, weekday: 0, weekdays: [0, 2] },
          },
          {
            id: "t2",
            title: "Hourly",
            cadence: "hourly",
            enabled: false,
            schedule: { hour: 0, minute: 0, weekday: 0 },
          },
        ],
      },
    },
  };
  // `weekday`/`weekdays` count from Monday = 0 in the host schema, so the row
  // gets names in the session language from the React layer.
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const blocks = buildToolPresentation(message, {
    weekdayName: (weekday) => names[weekday] ?? "",
  });
  assert.deepEqual(roles(blocks), ["details", "notice"]);
  assert.equal(blocks[0].kind, "fields");
  assert.deepEqual(
    blocks[0].rows.map((row) => [row.label, row.value]),
    [
      ["Nightly", "weekly · 09:05 · Mon, Wed · enabled"],
      ["Hourly", "hourly · 00:00 · paused"],
    ],
  );
  // Without a formatter the day is dropped: a bare index would tell a reader
  // nothing about when the automation runs.
  const unnamed = buildToolPresentation(message);
  assert.deepEqual(
    unnamed[0].rows.map((row) => row.value),
    ["weekly · 09:05 · enabled", "hourly · 00:00 · paused"],
  );
});

test("a workspace edit leaves its diff to the row's own review body", () => {
  const hunks = [
    { header: "@@ -1,1 +1,1 @@", lines: [{ type: "del", text: "a" }, { type: "add", text: "b" }] },
  ];
  const message = {
    id: "msg-1",
    role: "tool",
    toolName: "Edit",
    toolStatus: "success",
    toolArgs: { path: "src/main.ts", tag: "A1B2" },
    toolResult: envelope({
      path: "src/main.ts",
      root: "workspace",
      tag: "C3D4",
      review: {
        version: 1,
        snapshotId: "snap-1",
        messageId: "msg-1",
        path: "src/main.ts",
        status: "modified",
        operation: "edit",
        state: "active",
        additions: 1,
        deletions: 1,
        hunks,
        reversible: true,
      },
    }),
  };
  // The row hosts the change itself: no second diff block, and no ops block.
  const blocks = buildToolPresentation(message, { hideSummaryArg: true });
  assert.equal(byRole(blocks, "diff"), undefined);
  assert.equal(byRole(blocks, "written"), undefined);
  // The durable record the row's counts and rollback action read is intact.
  const change = reviewChangeFromMessage(message);
  assert.equal(change.path, "src/main.ts");
  assert.equal(change.state, "active");
  assert.equal(change.reversible, true);
  assert.deepEqual([change.additions, change.deletions], [1, 1]);
  assert.deepEqual(change.hunks, hunks);
  // A rolled-back change keeps its record and reports the state.
  const rolledBack = reviewChangeFromMessage({
    ...message,
    toolResult: envelope({
      root: "workspace",
      review: { ...message.toolResult.details.review, state: "rolledBack" },
    }),
  });
  assert.equal(rolledBack.state, "rolledBack");
});

test("an unknown payload degrades to readable fields plus its own disclosure", () => {
  const cyclic = { id: 7, label: "deploy", detail: {} };
  cyclic.detail.self = cyclic;
  const blocks = buildToolPresentation({
    toolName: "plugin_deployer",
    toolArgs: { mode: "fast" },
    // The text half of a real envelope carries the payload for the model; here
    // it is a placeholder, because a cyclic payload has no JSON text.
    toolResult: {
      content: [{ type: "text", text: "[cyclic payload]" }],
      details: cyclic,
    },
  });
  const fields = byRole(blocks, "details");
  assert.equal(fields.kind, "fields");
  assert.deepEqual(fields.rows.slice(0, 2), [
    { label: "id", value: "7" },
    { label: "label", value: "deploy" },
  ]);
  assert.ok(blocks.some((block) => block.label === "detail"));
  const raw = blocks.find((block) => block.kind === "raw");
  assert.ok(raw, "the untouched payload is one disclosure away");
  assert.equal(typeof raw.text, "string");
  assert.ok(raw.text.length > 0);

  // A payload too large to offer keeps its readable fields and simply omits the
  // disclosure, rather than printing twenty thousand characters again.
  const huge = buildToolPresentation({
    toolName: "plugin_deployer",
    toolArgs: {},
    toolResult: envelope({ id: "x", note: "y".repeat(20_001) }),
  });
  assert.equal(huge.find((block) => block.kind === "raw"), undefined);
  assert.ok(huge.some((block) => block.label === "note"));
});

/*
 * A workspace mutation owns its review record: the row hosts the real diff, so
 * the body must state that change and nothing else. The record's own `path`,
 * `root`, `tag`, `ops` and `deleted` are how the change was requested, not what
 * it did, and printing them beside the diff was a second, coarser account of
 * the same file.
 */
const reviewedEditMessage = (details, args = {}) => ({
  id: "msg-review",
  role: "tool",
  toolName: "Edit",
  toolStatus: "success",
  toolArgs: { path: "src/main.ts", tag: "A1B2", ops: "PUT 2.=2:\n+TWO\n", ...args },
  toolResult: envelope({
    review: {
      version: 1,
      snapshotId: "snap-1",
      messageId: "msg-review",
      path: String(details.path ?? "src/main.ts"),
      status: "modified",
      operation: "edit",
      state: "active",
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [
            { type: "del", text: "one" },
            { type: "add", text: "TWO" },
          ],
        },
      ],
      reversible: true,
    },
    ...details,
  }),
});

test("a reviewed workspace edit body is its diff and nothing else", () => {
  const variants = {
    modify: { path: "src/main.ts", root: "workspace", tag: "C3D4", warnings: [] },
    delete: { path: "src/main.ts", root: "workspace", deleted: true, warnings: [] },
    move: {
      path: "src/renamed.ts",
      root: "workspace",
      tag: "C3D4",
      movedFrom: "src/main.ts",
      warnings: [],
    },
  };
  for (const [name, details] of Object.entries(variants)) {
    const blocks = buildToolPresentation(reviewedEditMessage(details), {
      hideSummaryArg: true,
    });
    assert.deepEqual(blocks, [], `${name}: the row's own review body is the whole body`);
  }
});

test("a reviewed edit still reports its warnings, and only those", () => {
  const warning = "stale tag A1B2 applied at file head/tail; live tag is C3D4";
  const blocks = buildToolPresentation(
    reviewedEditMessage({
      path: "src/main.ts",
      root: "workspace",
      tag: "C3D4",
      warnings: [warning],
    }),
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(blocks), ["notice"]);
  assert.equal(blocks[0].text, warning);
  assert.equal(blocks.some((block) => block.kind === "raw"), false);
  assert.equal(blocks.some((block) => block.kind === "fields"), false);
});

test("a scratch edit keeps its ops, and a failed one keeps its diagnosis", () => {
  const scratch = buildToolPresentation({
    toolName: "Edit",
    toolArgs: { path: "tmp/notes.txt", tag: "A1B2", ops: "PUT 1.=1:\n+x\n" },
    toolResult: envelope({ path: "tmp/notes.txt", root: "scratch", tag: "C3D4" }),
  });
  assert.deepEqual(roles(scratch), ["input"]);

  // A refused workspace edit has no review record; its error and the ops the
  // model sent are the only account of the attempt.
  const failed = buildToolPresentation({
    toolName: "Edit",
    toolStatus: "error",
    toolArgs: { path: "src/main.ts", tag: "A1B2", ops: "PUT 9.=9:\n+x\n" },
    toolResult: envelope({ error: "tag mismatch", code: "EDIT_TAG_MISMATCH" }),
  }, { hideSummaryArg: true });
  assert.deepEqual(roles(failed), ["error", "input"]);
  assert.equal(failed[0].text, "tag mismatch");
  assert.match(failed[1].text, /PUT 9\.=9/);
});

test("an empty Glob or Grep states the empty result in every output mode", () => {
  const empty = (scope) => ({ kind: "empty", role: "notice", scope });
  const glob = {
    toolName: "Glob",
    toolArgs: { pattern: "src/**/*.nope" },
    toolResult: envelope({ matches: [], count: 0, truncated: false }),
  };
  assert.deepEqual(buildToolPresentation(glob, { hideSummaryArg: true }), [
    empty("files"),
  ]);

  const modes = {
    content: { matches: [], count: 0, files: 0, truncated: false },
    filesWithMatches: { files: [], count: 0, truncated: false },
    count: { counts: [], count: 0, truncated: false },
  };
  for (const [mode, details] of Object.entries(modes)) {
    const blocks = buildToolPresentation(
      {
        toolName: "Grep",
        toolArgs: { pattern: "nothing-matches", outputMode: mode },
        toolResult: envelope(details),
      },
      { hideSummaryArg: true },
    );
    assert.equal(blocks.length, 1, `${mode}: one answering block`);
    assert.equal(blocks[0].kind, "empty", mode);
    assert.equal(blocks[0].scope, mode === "filesWithMatches" ? "files" : "matches", mode);
  }

  // An empty result the host qualified keeps that qualification.
  const qualified = buildToolPresentation(
    {
      toolName: "Grep",
      toolArgs: { pattern: "TODO" },
      toolResult: envelope({
        matches: [],
        count: 0,
        truncated: true,
        notice: "results truncated; narrow the pattern or scan a path",
      }),
    },
    { hideSummaryArg: true },
  );
  assert.deepEqual(roles(qualified), ["notice", "notice"]);
  assert.equal(qualified[0].kind, "empty");
  assert.match(qualified[1].text, /narrow the pattern/);
  // The metadata is not a body: no field row restates `count` or `truncated`.
  assert.equal(qualified.some((block) => block.kind === "fields"), false);
});

test("TaskStop keeps stopped, stop-pending and settled apart", () => {
  const payload = {
    content: [
      {
        type: "text",
        text: "Cancellation requested for 3 subagents; 1 have not confirmed termination and remain running.",
      },
    ],
    details: {
      stopped: [{ delegationId: "a", agent: "fixer", status: "stopped" }],
      stopPending: [{ delegationId: "b", agent: "runner", status: "running" }],
      settled: [{ delegationId: "c", agent: "planner", status: "completed" }],
    },
  };
  const blocks = buildToolPresentation({
    toolName: "TaskStop",
    toolArgs: { delegationIds: ["a", "b", "c"] },
    toolResult: payload,
  });
  assert.deepEqual(
    blocks.map((block) => block.labelKey ?? block.kind),
    [
      "code",
      "chat.subagentRosterStopped",
      "chat.subagentRosterStopPending",
      "chat.subagentRosterSettled",
    ],
  );
  assert.deepEqual(blocks[1].rows, [{ label: "fixer", value: "stopped" }]);
  // A worker that never confirmed termination is still running: the roster
  // says so instead of borrowing the stopped group.
  assert.deepEqual(blocks[2].rows, [{ label: "runner", value: "running" }]);
  assert.deepEqual(blocks[3].rows, [{ label: "planner", value: "completed" }]);
  assert.equal(blocks.some((block) => block.kind === "raw"), false);

  // Only pending: the row must not read as a completed stop.
  const pendingOnly = buildToolPresentation({
    toolName: "TaskStop",
    toolArgs: {},
    toolResult: {
      content: [{ type: "text", text: "Cancellation requested for 1 subagent; 1 have not confirmed termination and remain running." }],
      details: { stopped: [], stopPending: [{ delegationId: "b", agent: "runner", status: "running" }] },
    },
  });
  assert.deepEqual(
    pendingOnly.slice(1).map((block) => block.labelKey),
    ["chat.subagentRosterStopPending"],
  );

  // A stop that found nothing to stop still answers with its sentence.
  const none = buildToolPresentation({
    toolName: "TaskStop",
    toolArgs: {},
    toolResult: {
      content: [{ type: "text", text: "No matching running subagents to stop." }],
      details: { stopped: [] },
    },
  });
  assert.deepEqual(roles(none), ["output"]);
  assert.equal(none.some((block) => block.kind === "raw"), false);
});

test("known tools whose result is empty do not fall back to a payload dump", () => {
  // A Read of an empty file, a TaskWait with no roster, and a scheduled-task
  // list mutation all keep their own answer rather than a JSON body.
  const emptyFile = buildToolPresentation({
    toolName: "Read",
    toolArgs: { path: "empty.txt" },
    toolResult: envelope({ path: "empty.txt", root: "workspace", content: "", truncated: false }),
  }, { hideSummaryArg: true });
  assert.deepEqual(roles(emptyFile), ["content"]);
  assert.equal(emptyFile[0].text, "");

  const clearedList = buildToolPresentation({
    toolName: "ScheduledTaskList",
    toolArgs: {},
    toolResult: {
      content: [{ type: "text", text: "No scheduled automations in this project." }],
      details: { tasks: [] },
    },
  });
  assert.deepEqual(roles(clearedList), ["notice"]);
  assert.equal(clearedList.some((block) => block.kind === "raw"), false);
});

test("task counters and scheduled rows are named, not left as generic details", () => {
  const delegation = buildToolPresentation({
    toolName: "Task",
    toolArgs: { agent: "worker", task: "Do the thing" },
    toolResult: {
      content: [{ type: "text", text: "Done." }],
      details: { agent: "worker", turns: 4, toolCalls: 9 },
    },
  });
  const stats = delegation.find((block) => block.labelKey === "chat.toolBlockStats");
  assert.ok(stats, "the counter footer names itself");
  assert.deepEqual(stats.rows, [
    { label: "turns", value: "4" },
    { label: "toolCalls", value: "9" },
  ]);

  const scheduled = buildToolPresentation({
    toolName: "ScheduledTaskList",
    toolArgs: {},
    toolResult: {
      content: [{ type: "text", text: "1 automation" }],
      details: {
        tasks: [
          { id: "t1", title: "Daily sync", cadence: "daily", schedule: { hour: 9, minute: 0 }, enabled: true },
        ],
      },
    },
  });
  const rows = scheduled.find((block) => block.labelKey === "chat.toolScheduledTask");
  assert.ok(rows, "the automation list names itself");
  assert.deepEqual(rows.rows, [{ label: "Daily sync", value: "daily · 09:00 · enabled" }]);
});

test("an unknown payload keeps its fields and one clearly named raw entry", () => {
  const blocks = buildToolPresentation({
    toolName: "plugin_deployer",
    toolArgs: {},
    toolResult: envelope({ id: 7, label: "deploy" }),
  });
  const fields = byRole(blocks, "details");
  assert.equal(fields.kind, "fields");
  // The generic payload still earns the plain "details" heading; the raw entry
  // names itself through its own disclosure, never a second "details" head.
  assert.equal(fields.labelKey, undefined);
  const raw = blocks.find((block) => block.kind === "raw");
  assert.ok(raw);
  assert.equal(raw.labelKey, undefined);
  assert.equal(raw.label, undefined);
});
