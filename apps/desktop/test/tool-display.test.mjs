import assert from "node:assert/strict";
import test from "node:test";
import {
  formatToolValue,
  formatToolDuration,
  getToolAction,
  getToolDisplayName,
  getToolSummary,
  getToolSummaryKey,
  getToolSummaryValue,
  isDelegationStartTool,
  isToolPathSummary,
  toolSummarySpec,
} from "../src/lib/tool-display.ts";
import { toolPathName } from "../src/lib/tool-path-display.ts";

test("maps built-in tools to concise Codex-style actions", () => {
  assert.equal(getToolAction("Read"), "read");
  assert.equal(getToolAction("list_files"), "list");
  assert.equal(getToolAction("Grep"), "search");
  assert.equal(getToolAction("apply_patch"), "edit");
  assert.equal(getToolAction("exec_command"), "run");
  assert.equal(getToolAction("functions.exec_command"), "run");
  assert.equal(getToolAction("web_search"), "fetch");
  assert.equal(getToolAction("fork"), "fork");
  assert.equal(getToolAction("functions.fork_agent"), "fork");
});

test("delegation is its own action, matched exactly", () => {
  assert.equal(getToolAction("Task"), "delegate");
  assert.equal(getToolAction("functions.subagent"), "delegate");
  // The lifecycle tools of ADR 0087 share the delegation presentation...
  assert.equal(getToolAction("TaskWait"), "delegate");
  assert.equal(getToolAction("TaskList"), "delegate");
  assert.equal(getToolAction("TaskStop"), "delegate");
  // ...but only the start tool is a delegation activity item.
  assert.equal(isDelegationStartTool("Task"), true);
  assert.equal(isDelegationStartTool("functions.subagent"), true);
  assert.equal(isDelegationStartTool("TaskWait"), false);
  assert.equal(isDelegationStartTool("TaskStop"), false);
  // A plugin tool that merely mentions tasks keeps its generic presentation.
  assert.equal(getToolAction("CreateTask"), "use");
  assert.equal(getToolAction("plugin_tasks_list"), "list");
});

test("a delegation row shows its label, and the agent beside it", () => {
  assert.equal(
    getToolSummary("Task", {
      agent: "code-reviewer",
      description: "Review the store",
      task: "Read app-store.ts and report dead branches.",
    }),
    "Review the store",
  );
  assert.equal(
    getToolSummaryKey("Task", { agent: "code-reviewer", task: "..." }),
    "agent",
  );
});

test("builds a single-line bounded hint from the most useful argument", () => {
  assert.equal(
    getToolSummary("Bash", { command: "pnpm test\n  --filter desktop" }),
    "pnpm test --filter desktop",
  );
  assert.equal(
    getToolSummary("Read", { filePath: "/work/src/App.tsx", query: "ignored" }),
    "/work/src/App.tsx",
  );
  assert.ok(
    getToolSummary("custom", { prompt: "x".repeat(300) }).length <= 220,
  );
});

test("reports which argument the row summary already shows", () => {
  assert.equal(getToolSummaryKey("Bash", { command: "ls", timeout: 5 }), "command");
  assert.equal(getToolSummaryKey("Read", { filePath: "/a/b.ts" }), "filePath");
  assert.equal(getToolSummaryKey("Read", { limit: 20 }), null);
  assert.equal(getToolSummaryKey("Read", "not-a-record"), null);
});

test("hands back that argument whole, for copying out of the head", () => {
  // The summary squeezes a command onto one line to fit the row; copying it
  // has to give back the command as written (D226).
  const command = "pnpm test \\\n  --filter desktop";
  assert.equal(getToolSummaryValue("Bash", { command, timeout: 5 }), command);
  assert.equal(getToolSummaryValue("Bash", { timeout: 5 }), "");
  assert.equal(getToolSummaryValue("Bash", undefined), "");
});

test("formats cyclic values without throwing and humanizes plugin names", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(formatToolValue(cyclic), "[object Object]");
  assert.equal(getToolDisplayName("plugin_issue_tracker_create"), "Issue Tracker Create");
});

test("formats processing time in the compact transcript style", () => {
  assert.equal(formatToolDuration(0), "0s");
  assert.equal(formatToolDuration(59.9), "59s");
  assert.equal(formatToolDuration(60), "1m");
  assert.equal(formatToolDuration(65), "1m 5s");
  assert.equal(formatToolDuration(3_599), "59m 59s");
  assert.equal(formatToolDuration(3_600), "1h");
  assert.equal(formatToolDuration(3_665), "1h 1m 5s");
  assert.equal(formatToolDuration(5_400), "1h 30m");
});

test("provider-namespaced aliases reach the same action and summary", () => {
  assert.equal(getToolAction("functions.exec_command"), "run");
  assert.equal(getToolSummary("functions.exec_command", { cmd: "ls -la" }), "ls -la");
  assert.equal(getToolAction("functions.Skill"), "skill");
  assert.equal(getToolAction("functions.Glob"), "list");
  // The on-demand built-ins carry their own card only on their exact names: a
  // plugin tool that merely sounds similar keeps the generic presentation.
  assert.equal(getToolAction("EnterPlanMode"), "mode");
  assert.equal(getToolAction("plugin_EnterPlanMode"), "use");
});

test("a path summary keeps the whole value while the row names the file", () => {
  const path =
    "/Users/me/workspace/repos/pi-desktop/apps/desktop/src/components/transcript/nested/tool/ToolTerminal.tsx";
  const spec = toolSummarySpec("Read", { path, limit: 20 });
  // The literal value is what `title`, the copy menu, the preview target and the
  // row's description need, so it is never shortened, however long it is.
  assert.equal(spec.text, path);
  assert.equal(spec.path, true);
  assert.equal(spec.key, "path");
  assert.equal(isToolPathSummary("Read", { path }), true);
  assert.equal(getToolSummaryValue("Read", { path }), path);

  // The row prints the file's own name out of that value; the directory is not
  // painted and no omission is composed, because the row ellipsizes the name.
  assert.equal(toolPathName(spec.text), "ToolTerminal.tsx");
  assert.equal(toolPathName(spec.text), toolPathName(path));

  // A free-text summary is not a path: it is neither reduced to a name nor given
  // a file title, and a long one is bounded like every other hint.
  const query = toolSummarySpec("Grep", { pattern: "a/b/c" });
  assert.equal(query.path, false);
  assert.equal(isToolPathSummary("Grep", { pattern: "a/b/c" }), false);
  assert.equal(getToolSummary("Grep", { pattern: "x".repeat(400) }).length, 220);
  // A relative value with no directory is already the name it prints.
  assert.equal(toolPathName("App.tsx"), "App.tsx");
});

test("an unrecognized tool summarizes with the one scalar it was called with", () => {
  // A label beats a serialized argument object, which is what an unknown tool
  // used to put in the collapsed row.
  assert.equal(getToolSummary("plugin_issue_tracker_create", { title: "Bug 41" }), "Bug 41");
  assert.equal(getToolSummaryKey("plugin_issue_tracker_create", { title: "Bug 41" }), "title");
  // A bare number is reported with its own key, because "3" alone explains
  // nothing.
  assert.equal(getToolSummary("plugin_retry", { attempts: 3 }), "attempts: 3");
  // Nothing scalar to say: the row falls back to the tool's own name rather
  // than printing an object.
  assert.equal(getToolSummary("plugin_weird", { nested: { a: 1 } }), "Weird");
  // Even with nothing to summarize, the row names the tool rather than showing
  // an empty hint.
  assert.equal(getToolSummary("plugin_weird", null), "Weird");
});

test("summaries that name no argument fall back to the action label", () => {
  // A checklist's state is its body, and a mode change is named by its tool.
  assert.deepEqual(toolSummarySpec("TodoWrite", { todos: [{ content: "x" }] }), {
    key: null,
    text: "",
    path: false,
  });
  assert.equal(getToolSummary("EnterPlanMode", {}), "Plan");
  assert.equal(getToolSummary("SubmitGoal", {}), "Goal");
  assert.equal(
    getToolSummary("GenerateImages", {
      items: [{ prompt: "a cat" }, { prompt: "a dog" }],
    }),
    "a cat (+1)",
  );
});
