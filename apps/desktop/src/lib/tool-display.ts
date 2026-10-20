export type ToolAction =
  | "read"
  | "list"
  | "search"
  | "write"
  | "edit"
  | "run"
  | "fetch"
  | "fork"
  | "delegate"
  | "todo"
  | "use"
  /* Built-in on-demand tools with their own presentation (D192 follow-up). */
  | "skill"
  | "toolSearch"
  | "mode"
  | "context"
  | "browser"
  | "image"
  | "schedule";

const SUMMARY_KEYS: Record<ToolAction, string[]> = {
  read: ["path", "file_path", "filePath"],
  list: ["path", "pattern", "glob"],
  search: ["query", "pattern", "path"],
  write: ["path", "file_path", "filePath"],
  edit: ["path", "file_path", "filePath"],
  run: ["command", "cmd"],
  fetch: ["url", "query"],
  fork: ["prompt", "task", "description", "name"],
  // `description` is the short label the model writes for the delegation; the
  // `task` brief is a paragraph and belongs in the expanded detail. A lifecycle
  // tool (ADR 0089) carries only delegation ids, which read as bare UUIDs, so
  // it summarizes from the agent names in its own result roster instead (D268).
  delegate: ["description", "agent"],
  // The checklist title carries the state; the list itself belongs to the
  // expanded body, never to the collapsed row as a serialized array.
  todo: [],
  // `Skill` is called with the exact skill id; its document is the body.
  skill: ["id", "name"],
  toolSearch: ["query"],
  // The mode comes from the tool name (`EnterPlanMode`), not from an argument.
  mode: [],
  context: [],
  // `BrowserPreview` takes the file it previews.
  browser: ["path", "url"],
  // The prompt lives inside `items[0]`, so it is read explicitly below.
  image: [],
  schedule: ["title", "id", "name"],
  use: [
    "command",
    "cmd",
    "path",
    "file_path",
    "filePath",
    "url",
    "query",
    "pattern",
    "prompt",
  ],
};

/** Argument keys that hold a filesystem path rather than free text. */
const PATH_ARG_KEYS = new Set(["path", "file_path", "filePath"]);

/**
 * Scalar labels a plugin/MCP tool is likely to summarize with. Reading one of
 * these beats printing the argument object, which is what an unrecognized tool
 * used to get (a serialized blob in the collapsed row).
 */
const GENERIC_SUMMARY_KEYS = [
  "description",
  "title",
  "name",
  "label",
  "task",
  "prompt",
  "query",
  "pattern",
  "url",
  "path",
  "id",
  "text",
  "message",
  "reason",
  "command",
];

function compact(value: string, limit = 220) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > limit
    ? `${singleLine.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
    : singleLine;
}

export function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function bareToolName(toolName?: string): string {
  return (toolName || "")
    .split(".")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function isAskToolName(toolName?: string): boolean {
  return toolName?.toLowerCase() === "asktool";
}

/** The tool that STARTS a subagent (ADR 0062). The lifecycle tools of ADR 0089
 * (TaskWait/TaskList/TaskStop) drive an existing delegation and are not
 * delegation activity items themselves. */
export function isDelegationStartTool(toolName?: string): boolean {
  const bare = bareToolName(toolName);
  return bare === "task" || bare === "subagent";
}

/**
 * Which lifecycle tool this row is (ADR 0089), or `null` for the `Task` start
 * call and every non-delegation tool. The three lifecycle rows report on
 * subagents rather than doing workspace work, so the transcript presents them
 * as subagent rows rather than as generic tool calls (D268).
 */
export type DelegationLifecycleKind = "wait" | "list" | "stop";

export function delegationLifecycleKind(
  toolName?: string,
): DelegationLifecycleKind | null {
  switch (bareToolName(toolName)) {
    case "taskwait":
      return "wait";
    case "tasklist":
      return "list";
    case "taskstop":
      return "stop";
    default:
      return null;
  }
}

/**
 * The exact names of the built-in tools that carry their own card. They are
 * matched exactly, minus any provider namespace, so a plugin tool that merely
 * sounds similar keeps the generic presentation.
 */
const EXACT_TOOL_ACTIONS: Record<string, ToolAction> = {
  skill: "skill",
  toolsearch: "toolSearch",
  enterplanmode: "mode",
  entergoalmode: "mode",
  submitplan: "mode",
  submitgoal: "mode",
  newcontext: "context",
  browserpreview: "browser",
  generateimages: "image",
  scheduledtasklist: "schedule",
  scheduledtaskcreate: "schedule",
  scheduledtaskupdate: "schedule",
  scheduledtaskdelete: "schedule",
};

export function getToolAction(toolName?: string): ToolAction {
  const normalized = (toolName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const matches = (aliases: string[]) =>
    aliases.some(
      (alias) => normalized === alias || normalized.endsWith(alias),
    );
  // Delegation (ADR 0062, ADR 0089) is matched on the exact name, minus any
  // provider namespace: a plugin tool called "CreateTask" is not a subagent
  // call and keeps its generic presentation.
  if (isDelegationStartTool(toolName) || delegationLifecycleKind(toolName)) {
    return "delegate";
  }
  const exact = EXACT_TOOL_ACTIONS[bareToolName(toolName)];
  if (exact) return exact;
  if (bareToolName(toolName) === "todowrite") return "todo";
  if (matches(["websearch", "searchquery", "fetch", "http", "browser"])) {
    return "fetch";
  }
  if (matches(["read", "readfile", "fileread"])) return "read";
  if (matches(["glob", "list", "listfiles", "findfiles"])) return "list";
  if (matches(["grep", "rg", "search", "searchfiles"])) return "search";
  if (matches(["write", "writefile", "createfile"])) return "write";
  if (matches(["edit", "editfile", "applypatch", "patch"])) return "edit";
  if (matches(["fork", "forkagent", "forktask", "forksession"])) return "fork";
  if (matches(["bash", "shell", "exec", "execcommand", "runcommand", "terminal"])) {
    return "run";
  }
  return "use";
}

export function getToolDisplayName(toolName?: string) {
  const raw = (toolName || "").replace(/^plugin[_-]/i, "");
  const spaced = raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return "";
  return spaced.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Renders a summarizable argument. A plain string is itself; a list of strings
 * is joined, because `TaskWait`/`TaskStop` summarize by their `delegationIds`
 * list (ADR 0089) and everything else summarizes by a scalar.
 */
function summaryText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join(", ");
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstKeyValue(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): { key: string; text: string } | null {
  if (!record) return null;
  for (const key of keys) {
    const text = summaryText(record[key]).trim();
    if (text) return { key, text: summaryText(record[key]) };
  }
  return null;
}

/**
 * Which mode a mode tool changed, read from its own name (`EnterPlanMode`,
 * `SubmitGoal`): the arguments carry nothing that says it. A name that names
 * neither mode says nothing, and the row falls back to its action label.
 */
export function toolModeName(toolName?: string): string {
  const bare = bareToolName(toolName);
  if (bare.includes("goal")) return "Goal";
  if (bare.includes("plan")) return "Plan";
  return "";
}

/** `GenerateImages` carries its prompts inside `items[]`. */
function imageSummary(record: Record<string, unknown> | null): string {
  const items = Array.isArray(record?.items) ? record.items : [];
  const prompts = items
    .map((item) => asRecord(item)?.prompt)
    .filter((prompt): prompt is string => typeof prompt === "string" && !!prompt.trim());
  if (prompts.length === 0) return "";
  const first = compact(prompts[0], 160);
  return prompts.length > 1 ? `${first} (+${prompts.length - 1})` : first;
}

/**
 * The one honest scalar an unrecognized tool's arguments offer, so a plugin or
 * MCP call reads as a label instead of a serialized object. A bare number is
 * reported with its own key, because "3" alone explains nothing.
 */
function genericScalar(
  record: Record<string, unknown> | null,
): { key: string; text: string } | null {
  if (!record) return null;
  const preferred = firstKeyValue(record, GENERIC_SUMMARY_KEYS);
  if (preferred) return preferred;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim()) {
      return { key, text: value };
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" || typeof value === "boolean") {
      return { key, text: `${key}: ${String(value)}` };
    }
  }
  return null;
}

export type ToolSummarySpec = {
  /** The argument the collapsed row already shows, or `null`. */
  key: string | null;
  /** Single-line text for the collapsed row. A path stays whole. */
  text: string;
  /** The value is a filesystem path, so its middle may be omitted visually. */
  path: boolean;
};

/**
 * What one tool call says when it is collapsed. Every branch reads the tool's
 * own argument names; none of them falls back to stringifying the arguments,
 * because a serialized object is not a summary.
 */
export function toolSummarySpec(
  toolName: string | undefined,
  args: unknown,
): ToolSummarySpec {
  const action = getToolAction(toolName);
  const record = asRecord(args);
  const none: ToolSummarySpec = { key: null, text: "", path: false };

  // AskTool asks its first question; the rest is the card's own business.
  if (isAskToolName(toolName) && Array.isArray(record?.questions)) {
    const first = asRecord(record.questions[0]);
    const question = typeof first?.question === "string" ? first.question : "";
    if (question.trim()) return { key: null, text: compact(question), path: false };
  }

  if (action === "todo" || action === "context") return none;
  if (action === "mode") return { key: null, text: toolModeName(toolName), path: false };
  if (action === "image") {
    return { key: null, text: imageSummary(record), path: false };
  }

  const found =
    action === "run" && record && summaryText(record.description).trim()
      ? { key: "description", text: summaryText(record.description) }
      : firstKeyValue(record, SUMMARY_KEYS[action]);
  if (found) {
    return {
      key: found.key,
      text: PATH_ARG_KEYS.has(found.key)
        ? summaryText(found.text).replace(/\s+/g, " ").trim()
        : compact(found.text),
      path: PATH_ARG_KEYS.has(found.key),
    };
  }

  if (action === "use") {
    const scalar = genericScalar(record);
    if (scalar) {
      return {
        key: scalar.key,
        text: PATH_ARG_KEYS.has(scalar.key) ? scalar.text.trim() : compact(scalar.text),
        path: PATH_ARG_KEYS.has(scalar.key),
      };
    }
    return { key: null, text: getToolDisplayName(toolName), path: false };
  }
  return none;
}

/**
 * Which argument the collapsed row summary is showing, so expanded detail
 * blocks can skip repeating it.
 */
export function getToolSummaryKey(
  toolName: string | undefined,
  args: unknown,
): string | null {
  return toolSummarySpec(toolName, args).key;
}

/** Whether the collapsed row is showing a filesystem path. */
export function isToolPathSummary(
  toolName: string | undefined,
  args: unknown,
): boolean {
  return toolSummarySpec(toolName, args).path;
}

/**
 * The whole argument the collapsed row summarizes, unwrapped and untrimmed.
 * The summary is squeezed onto one line to fit the row; a reader copying a
 * multi-line command out of the head needs it the way it was written (D226).
 * A run row always hands back its command, even when the row summarizes the
 * model's own `description` of it.
 */
export function getToolSummaryValue(
  toolName: string | undefined,
  args: unknown,
): string {
  const record = asRecord(args);
  if (!record) return "";
  if (getToolAction(toolName) === "run") {
    for (const key of ["command", "cmd"]) {
      const text = summaryText(record[key]);
      if (text.trim()) return text;
    }
    return "";
  }
  const key = getToolSummaryKey(toolName, args);
  return key ? summaryText(record[key]) : "";
}

export function getToolSummary(toolName: string | undefined, args: unknown) {
  return toolSummarySpec(toolName, args).text;
}

/**
 * Middle omission for display only: the start of a path and its last segments
 * are what a reader recognizes, and the middle is the least informative part.
 * The untruncated value stays available through the element's title, copy
 * affordance and preview target.
 */
export function middleEllipsis(value: string, limit = 88): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const segments = text.split(/[/\\]/).filter((segment) => segment.length > 0);
  const isAbsolute = /^[/\\]/.test(text);
  const tailLength = Math.min(
    Math.max(14, Math.floor(limit / 2)),
    segments.slice(-2).join("/").length + (isAbsolute ? 1 : 0),
  );
  const tail = text.slice(-tailLength);
  const headLength = Math.max(6, limit - tail.length - 1);
  return `${text.slice(0, headLength).trimEnd()}…${tail}`;
}

export function formatToolDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (remainingSeconds > 0) parts.push(`${remainingSeconds}s`);
  if (parts.length === 0) parts.push("0s");

  return parts.join(" ");
}
