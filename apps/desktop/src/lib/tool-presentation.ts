import type { UiMessage } from "@pi-desktop/shared";
import {
  delegationLifecycleKind,
  getToolAction,
  getToolSummaryKey,
  isAskToolName,
  type ToolAction,
} from "./tool-display";
import { reviewChangeFromMessage } from "./workspace-review";
import { isWithinHighlightLimits } from "./render-content-limits";

/*
 * Structured presentation of one tool call (D192).
 *
 * Tool payloads are well-shaped — Read returns file content, Bash returns
 * stdout/stderr/exitCode, Grep returns path/line hits — so the transcript
 * renders them as content, terminal output, diffs and match lists instead of
 * dumping `JSON.stringify` into a <pre>. Everything here is pure and
 * label-free: blocks carry a semantic `role` and the React layer maps roles to
 * translated headings.
 *
 * Only genuinely unknown nested values (plugin tools returning objects) still
 * fall back to pretty-printed JSON.
 */

/** Beyond this, syntax highlighting costs more than it is worth on expand. */
/** Rendered list caps; the remainder is reported, never silently dropped. */
const MAX_LIST_ITEMS = 200;
const DIFF_CONTEXT_LINES = 2;
/** Longer single-line strings become their own block instead of a field row. */
const MAX_FIELD_VALUE = 120;
/** Internal review snapshots are rendered by ReviewChangeCard, not as fields. */
const HIDDEN_KEYS = new Set(["review"]);

export type ToolPresentationMessage = {
  role?: string;
  content?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  toolStatus?: string;
  /** pi-ai's own error flag on the result envelope. */
  isError?: boolean;
};

export type ToolChip =
  | { role: "exit" | "matches" | "files" | "replacements"; count: number }
  | { role: "truncated" | "scratch" }
  | { role: "lines"; text: string }
  | { role: "size"; text: string };

export type ToolBlockRole =
  | "content"
  | "written"
  | "command"
  | "stdout"
  | "stderr"
  | "diff"
  | "files"
  | "matches"
  | "details"
  | "output"
  | "input"
  | "notice"
  | "error";

export type ToolDiffLine = { type: "add" | "del" | "context"; text: string };
export type ToolMatchGroup = {
  path: string;
  lines: { line: number; text: string }[];
};
export type ToolFieldRow = { label: string; value: string };

type BlockBase = {
  role: ToolBlockRole;
  /** Raw key for generic payload entries; overrides the role heading. */
  label?: string;
  /**
   * An i18n key that names a semantic group (a roster outcome, task counters)
   * where the payload itself is not the label; the React layer translates it.
   */
  labelKey?: string;
};

export type ToolTodoItem = {
  content: string;
  status: string;
  priority?: string;
};

/**
 * The fields of a loaded skill document. Read from the tool's own text — the
 * `Skill` tool answers with the document, not with a result object.
 */
export type ToolSkillDocument = {
  name: string;
  id: string;
  location: string | null;
  references: string | null;
  body: string;
};

export type ToolBlock =
  | (BlockBase & {
      kind: "asktool";
      questions: { question: string; answers: string[] | null }[];
    })
  | (BlockBase & {
      kind: "code";
      text: string;
      lang: string;
      highlight: boolean;
      tone?: "error";
    })
  | (BlockBase & {
      kind: "diff";
      lines: ToolDiffLine[];
      hidden: number;
      copy: string;
    })
  | (BlockBase & { kind: "files"; paths: string[]; hidden: number })
  | (BlockBase & { kind: "matches"; groups: ToolMatchGroup[]; hidden: number })
  | (BlockBase & { kind: "fields"; rows: ToolFieldRow[] })
  | (BlockBase & {
      kind: "values";
      label: string;
      items: string[];
      hidden: number;
    })
  | (BlockBase & {
      kind: "terminal";
      command: string | null;
      stdout: string | null;
      stderr: string | null;
    })
  | (BlockBase & {
      kind: "todos";
      items: ToolTodoItem[];
      completed: number;
      total: number;
      cancelled: number;
      hidden: number;
    })
  | (BlockBase & {
      kind: "document";
      title: string;
      id: string;
      fields: ToolFieldRow[];
      body: string;
    })
  | (BlockBase & { kind: "raw"; text: string })
  | (BlockBase & { kind: "empty"; scope: "files" | "matches" })
  | (BlockBase & { kind: "note"; text: string; code?: string });

export type ToolPresentationOptions = {
  /** Drop the argument the collapsed row already shows as its summary. */
  hideSummaryArg?: boolean;
  /**
   * Drop a delegate's report from a `Task` body. The transcript nests the
   * delegate's own rows under the call, and its last answer row already is the
   * report, so showing both would print it twice (ADR 0062).
   */
  hideDelegateReport?: boolean;
  /**
   * A locale-aware name for a weekday index (`Monday = 0`, matching the host's
   * schedule schema). A bare number is not a schedule a reader can picture, so
   * the React layer supplies the name in the session language; without it the
   * schedule keeps the clock alone rather than printing a number.
   */
  weekdayName?: (weekday: number) => string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function numberAt(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Text blocks of a pi-ai tool result envelope, joined. */
function envelopeText(envelope: Record<string, unknown>): string | null {
  if (!Array.isArray(envelope.content)) return null;
  const parts = envelope.content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "text" && typeof record.text === "string"
      ? [record.text]
      : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Unwrap `{ content, details }` down to the single payload worth showing.
 * `details` holds the structured host result; the content blocks repeat it as
 * text for the model, so showing both would duplicate every byte.
 */
export function toolResultPayload(message: ToolPresentationMessage): unknown {
  const raw = message.toolResult;
  if (raw === undefined || raw === null || raw === "") {
    return message.content ? message.content : undefined;
  }
  if (typeof raw === "string") return raw;
  const envelope = asRecord(raw);
  if (!envelope) return raw;
  if (envelope.details !== undefined && envelope.details !== null) {
    return envelope.details;
  }
  return envelopeText(envelope) ?? envelope;
}

/**
 * A delegate's report. `toolResultPayload` prefers the `details` object, which
 * for `Task` holds only counters, so the report has to be read from the text
 * blocks of the raw envelope.
 */
function delegateReport(message: ToolPresentationMessage): string | null {
  const raw = message.toolResult;
  if (typeof raw === "string") return raw.trim() ? raw : null;
  const envelope = asRecord(raw);
  const text = envelope ? envelopeText(envelope) : null;
  return text && text.trim() ? text : null;
}

/** The envelope's own text, used for a lifecycle row's one-line summary. */
function envelopeTextOf(message: ToolPresentationMessage): string | null {
  const raw = message.toolResult;
  if (typeof raw === "string") return raw.trim() ? raw.trim() : null;
  const envelope = asRecord(raw);
  const text = envelope ? envelopeText(envelope) : null;
  return text && text.trim() ? text.trim() : null;
}

/**
 * A lifecycle row's roster as field rows: one line per subagent, named, with
 * its status and runtime. Without this the row falls back to a JSON dump of
 * `delegations[]`, which is the least readable part of a delegation (D268).
 *
 * `TaskStop` answers with three distinct outcomes — `stopped`, `stopPending`
 * (cancellation was requested but the worker never confirmed termination) and
 * `settled` (it had already finished) — and each keeps its own group. Merging
 * them would give a still-running worker the same roster as a stopped one,
 * which is a state the runtime never reports (D268).
 */
const ROSTER_GROUPS = [
  { key: "delegations", labelKey: "chat.toolBlockSubagents" },
  { key: "stopped", labelKey: "chat.subagentRosterStopped" },
  { key: "stopPending", labelKey: "chat.subagentRosterStopPending" },
  { key: "settled", labelKey: "chat.subagentRosterSettled" },
] as const;

function rosterRows(entries: unknown[]): ToolFieldRow[] {
  const rows: ToolFieldRow[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const agent = typeof record.agent === "string" ? record.agent : "";
    const id = typeof record.delegationId === "string" ? record.delegationId : "";
    // An entry that names neither an agent nor a delegation would render as a
    // blank table row, which reads as a rendering fault rather than as data.
    if (!agent && !id) continue;
    const status = typeof record.status === "string" ? record.status : "";
    const startedAt = numberAt(record, "startedAt");
    const completedAt = numberAt(record, "completedAt");
    const seconds =
      startedAt !== null && completedAt !== null
        ? Math.max(0, Math.round((completedAt - startedAt) / 1000))
        : null;
    const turns = numberAt(record, "turns");
    const parts = [
      status,
      seconds !== null ? `${seconds}s` : null,
      turns !== null ? `${turns} turns` : null,
    ].filter((part): part is string => Boolean(part));
    rows.push({ label: agent || id, value: parts.join(" · ") });
  }
  return rows;
}

/** One readable table per roster group the result actually carries. */
function rosterBlocks(details: Record<string, unknown> | null): ToolBlock[] {
  if (!details) return [];
  const blocks: ToolBlock[] = [];
  for (const group of ROSTER_GROUPS) {
    const entries = details[group.key];
    if (!Array.isArray(entries)) continue;
    const rows = rosterRows(entries);
    if (rows.length === 0) continue;
    blocks.push({
      kind: "fields",
      role: "details",
      rows,
      labelKey: group.labelKey,
    });
  }
  return blocks;
}

/** Extension-derived Shiki tag; `resolveLang` normalizes it at render time. */
export function langForPath(path: string | null): string {
  if (!path) return "";
  const base = path.split(/[/\\]/).pop() ?? "";
  if (/^dockerfile/i.test(base)) return "dockerfile";
  if (/^makefile$/i.test(base)) return "makefile";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = base.slice(dot + 1).toLowerCase();
  return ext.length <= 10 ? ext : "";
}

function codeBlock(
  role: ToolBlockRole,
  text: string,
  lang = "",
  extra?: { tone?: "error"; label?: string },
): ToolBlock {
  return {
    kind: "code",
    role,
    text,
    lang,
    highlight:
      lang !== "" &&
      isWithinHighlightLimits(text),
    ...(extra?.tone ? { tone: extra.tone } : {}),
    ...(extra?.label ? { label: extra.label } : {}),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatReadLineRange(details: Record<string, unknown>): string | null {
  const offset = numberAt(details, "offset");
  const lineCount = numberAt(details, "lineCount");
  if (
    offset === null ||
    lineCount === null ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(lineCount) ||
    offset < 0 ||
    lineCount <= 0
  ) {
    return null;
  }
  const end = offset + lineCount;
  return Number.isSafeInteger(end)
    ? `${lineCount},L${offset + 1}-L${end}`
    : null;
}

/**
 * Minimal line diff used by review hunks and tests. Both sides are localized
 * snippets, so trimming the shared head/tail to a little context is enough to
 * make the actual replacement obvious.
 */
export function buildDiffLines(
  oldText: string,
  newText: string,
): ToolDiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const lines: ToolDiffLine[] = [];
  for (let i = Math.max(0, head - DIFF_CONTEXT_LINES); i < head; i += 1) {
    lines.push({ type: "context", text: oldLines[i] });
  }
  for (let i = head; i < oldLines.length - tail; i += 1) {
    lines.push({ type: "del", text: oldLines[i] });
  }
  for (let i = head; i < newLines.length - tail; i += 1) {
    lines.push({ type: "add", text: newLines[i] });
  }
  const tailStart = oldLines.length - tail;
  const tailEnd = Math.min(oldLines.length, tailStart + DIFF_CONTEXT_LINES);
  for (let i = tailStart; i < tailEnd; i += 1) {
    lines.push({ type: "context", text: oldLines[i] });
  }
  return lines;
}

function filesBlock(paths: string[], label?: string): ToolBlock | null {
  if (paths.length === 0) return null;
  return {
    kind: "files",
    role: "files",
    paths: paths.slice(0, MAX_LIST_ITEMS),
    hidden: Math.max(0, paths.length - MAX_LIST_ITEMS),
    ...(label ? { label } : {}),
  };
}

/**
 * An empty result is a result. The block carries no text of its own — the React
 * layer names the scope in the session language — so the payload's `count` and
 * `truncated` metadata never have to stand in for a body.
 */
function emptyBlock(scope: "files" | "matches"): ToolBlock {
  return { kind: "empty", role: "notice", scope };
}

/** Group Grep hits by file so repeated paths collapse into one heading. */
function matchesBlock(hits: unknown[]): ToolBlock | null {
  const groups: ToolMatchGroup[] = [];
  let total = 0;
  let hidden = 0;
  for (const hit of hits) {
    const record = asRecord(hit);
    const path = stringAt(record, "path", "file");
    const line = numberAt(record, "line");
    if (!path || line === null) continue;
    if (total >= MAX_LIST_ITEMS) {
      hidden += 1;
      continue;
    }
    total += 1;
    const text = typeof record?.text === "string" ? record.text : "";
    const last = groups[groups.length - 1];
    if (last && last.path === path) last.lines.push({ line, text });
    else groups.push({ path, lines: [{ line, text }] });
  }
  return groups.length > 0
    ? { kind: "matches", role: "matches", groups, hidden }
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

/** Grep's `count` output mode: one row per file, `path` → number of hits. */
function countsBlock(value: unknown): ToolBlock | null {
  if (!Array.isArray(value)) return null;
  const rows: ToolFieldRow[] = [];
  for (const entry of value.slice(0, MAX_LIST_ITEMS)) {
    const record = asRecord(entry);
    const path = stringAt(record, "path", "file");
    const count = numberAt(record, "count");
    if (!path || count === null) continue;
    rows.push({ label: path, value: String(count) });
  }
  return rows.length > 0 ? { kind: "fields", role: "matches", rows } : null;
}

/** A labeled list of scalar names (activated tools, scheduled task ids). */
function valuesBlock(
  label: string,
  items: unknown,
  role: ToolBlockRole = "details",
): ToolBlock | null {
  const names = stringArray(items);
  if (!names) return null;
  const visible = names.filter((item) => item.trim() !== "");
  if (visible.length === 0) return null;
  return {
    kind: "values",
    role,
    label,
    items: visible.slice(0, MAX_LIST_ITEMS),
    hidden: Math.max(0, visible.length - MAX_LIST_ITEMS),
  };
}

const TODO_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
/** The TodoWrite schema caps the list at 50 items. */
const MAX_TODO_ITEMS = 50;

/**
 * The checklist a `TodoWrite` call committed.
 *
 * A successful host result carries the normalized list it stored as `todos`, so
 * the rows show what the session holds — after trimming, truncation and the
 * single-active-item demotion — and not a list the call asked for that the host
 * then changed. An empty committed list is a real state (the session's checklist
 * was cleared), so it still produces a body the row's disclosure can point at.
 *
 * A row persisted before the result carried that field falls back to its own
 * `todos` argument; the session's current snapshot is never consulted, because a
 * later write must not rewrite an earlier card.
 */
function todosBlock(
  args: Record<string, unknown> | null,
  details: Record<string, unknown> | null,
): Extract<ToolBlock, { kind: "todos" }> | null {
  const committed = Array.isArray(details?.todos) ? details.todos : null;
  const raw = committed ?? (Array.isArray(args?.todos) ? args.todos : null);
  if (!raw) return null;
  const items: ToolTodoItem[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const content =
      typeof record?.content === "string" ? record.content.trim() : "";
    const status = typeof record?.status === "string" ? record.status : "";
    if (!content || !TODO_STATUSES.has(status)) continue;
    const priority =
      typeof record?.priority === "string" ? record.priority : undefined;
    items.push({ content, status, ...(priority ? { priority } : {}) });
  }
  // An argument the schema cannot describe is left to the generic fallback; a
  // committed empty list is not that case, it is the checklist being cleared.
  if (items.length === 0 && raw.length > 0) return null;
  const summary = asRecord(details?.summary);
  const countOf = (status: string) =>
    items.filter((item) => item.status === status).length;
  const cancelled = numberAt(summary, "cancelled") ?? countOf("cancelled");
  return {
    kind: "todos",
    role: "details",
    // The checklist names itself through its progress row, so this key never
    // heads a card: it stays the block's translated name for whatever reads the
    // block data, not the label of a copy control.
    labelKey: "chat.toolBlockChecklist",
    items: items.slice(0, MAX_TODO_ITEMS),
    completed: numberAt(summary, "completed") ?? countOf("completed"),
    // A cancelled item is neither completed nor outstanding, which is how the
    // host counts the total too.
    total: numberAt(summary, "total") ?? items.length - cancelled,
    cancelled,
    hidden: Math.max(0, items.length - MAX_TODO_ITEMS),
  };
}

const SKILL_TITLE_LINE = /^#\s*Skill:\s*(.*?)\s*\(([^()]+)\)\s*$/;
const SKILL_LOCATION_LINE = /^Location:\s*(.+?)\s*$/;
const SKILL_REFERENCES_LINE = /^References are relative to\s+(.+?)\.?\s*$/;

/**
 * The document a `Skill` call loaded. The tool answers with the skill's own
 * Markdown — a heading naming it, where it was loaded from, and the body — so
 * the card reads those fields instead of printing the text as one raw blob.
 */
export function parseSkillDocument(text: string): ToolSkillDocument | null {
  const lines = text.split("\n");
  const title = lines[0]?.match(SKILL_TITLE_LINE);
  if (!title) return null;
  let location: string | null = null;
  let references: string | null = null;
  let bodyStart = 1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const foundLocation = line.match(SKILL_LOCATION_LINE);
    if (foundLocation) {
      location = foundLocation[1];
      bodyStart = index + 1;
      continue;
    }
    const foundReferences = line.match(SKILL_REFERENCES_LINE);
    if (foundReferences) {
      references = foundReferences[1];
      bodyStart = index + 1;
      continue;
    }
    bodyStart = line.trim() === "" ? index + 1 : index;
    break;
  }
  return {
    name: title[1],
    id: title[2],
    location,
    references,
    body: lines.slice(bodyStart).join("\n").trim(),
  };
}

/** The schedule's own numeric day list; the host schema stores integers. */
function numberArray(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? (value as number[])
    : null;
}

/**
 * One automation's schedule as a single readable line. A weekly day is named
 * through `weekdayName`, never printed as its index: the host schema numbers
 * days from Monday = 0, so `09:00 · 1` would tell a reader nothing. Without a
 * formatter the line keeps the clock alone rather than falling back to a
 * number, and a non-weekly cadence has no day to name.
 */
function scheduleText(
  value: unknown,
  cadence: string | null,
  weekdayName?: (weekday: number) => string,
): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const interval = numberAt(record, "intervalMinutes");
  if (interval !== null) return `every ${interval}m`;
  const hour = numberAt(record, "hour");
  const minute = numberAt(record, "minute");
  if (hour === null || minute === null) return null;
  const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (cadence !== "weekly" || !weekdayName) return clock;
  const legacy = numberAt(record, "weekday");
  const days = numberArray(record.weekdays) ?? (legacy === null ? [] : [legacy]);
  const names = days
    .map((day) => weekdayName(day))
    .filter((name) => name.trim() !== "");
  return names.length > 0 ? `${clock} · ${names.join(", ")}` : clock;
}

/**
 * `ScheduledTaskList` answers with a list of automations and `Create`/`Update`
 * with one; each row names the automation and its cadence instead of
 * stringifying the task objects.
 */
function scheduledTaskRows(
  label: string,
  value: unknown,
  weekdayName?: (weekday: number) => string,
): ToolBlock | null {
  const entries = Array.isArray(value) ? value : [value];
  const rows: ToolFieldRow[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const title = stringAt(record, "title");
    const id = stringAt(record, "id");
    if (!title && !id) continue;
    const cadence = stringAt(record, "cadence");
    const parts = [
      cadence,
      scheduleText(record.schedule, cadence, weekdayName),
      typeof record.enabled === "boolean"
        ? record.enabled
          ? "enabled"
          : "paused"
        : null,
    ].filter((part): part is string => Boolean(part));
    rows.push({
      label: title ?? id ?? label,
      value: parts.join(" · ") || id || "",
    });
  }
  return rows.length > 0
    ? { kind: "fields", role: "details", rows, labelKey: "chat.toolScheduledTask" }
    : null;
}

/** The untouched payload is offered, not printed: bound what that can cost. */
const MAX_RAW_CHARS = 20_000;

/** A string list is a path list only when its entries look like paths. */
function looksLikePath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    /\.[a-z0-9]{1,10}$/i.test(value)
  );
}

/** Attach the raw payload as its own explicit disclosure, when it fits. */
function withRawBlock(blocks: ToolBlock[], payload: unknown): ToolBlock[] {
  const text = safeJson(payload);
  if (!text || text === "{}" || text.length > MAX_RAW_CHARS) return blocks;
  return [...blocks, { kind: "raw", role: "details", text }];
}

/**
 * Readable rendering for payloads with no per-tool mapping (plugin tools, MCP
 * results): scalars become field rows, long or multi-line strings become their
 * own labeled block, and only nested objects keep a JSON body.
 */
function recordBlocks(
  record: Record<string, unknown>,
  role: ToolBlockRole,
  options: { labelKey?: string } = {},
): ToolBlock[] {
  const rows: ToolFieldRow[] = [];
  const extra: ToolBlock[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || HIDDEN_KEYS.has(key)) continue;
    if (typeof value === "string") {
      if (value === "") continue;
      if (value.includes("\n") || value.length > MAX_FIELD_VALUE) {
        extra.push(codeBlock(role, value, langForPath(key), { label: key }));
      } else {
        rows.push({ label: key, value });
      }
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      rows.push({ label: key, value: String(value) });
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const strings = stringArray(value);
      if (strings) {
        // A list of names is not a list of files: only entries that look like
        // paths earn the previewable file list, so a plugin's `["deploy",
        // "rollback"]` reads as values instead of as two unopenable files.
        const block = strings.every(looksLikePath)
          ? filesBlock(strings, key)
          : valuesBlock(key, strings, role);
        if (block) extra.push(block);
        continue;
      }
      const grouped = matchesBlock(value);
      if (grouped) {
        extra.push(grouped);
        continue;
      }
    }
    extra.push(codeBlock(role, safeJson(value), "json", { label: key }));
  }
  return rows.length > 0
    ? [
        {
          kind: "fields",
          role,
          rows,
          ...(options.labelKey ? { labelKey: options.labelKey } : {}),
        },
        ...extra,
      ]
    : extra;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function askToolResultBlock(
  message: ToolPresentationMessage,
): ToolBlock | null {
  const details = asRecord(toolResultPayload(message));
  const rawQuestions = details?.questions;
  const rawAnswers = details?.answers;
  if (
    !Array.isArray(rawQuestions) ||
    rawQuestions.length === 0 ||
    !Array.isArray(rawAnswers) ||
    rawQuestions.length !== rawAnswers.length
  ) {
    return null;
  }

  const questions: Array<{ question: string; answers: string[] | null }> = [];
  for (let index = 0; index < rawQuestions.length; index += 1) {
    const question = stringAt(asRecord(rawQuestions[index]), "question");
    const answer = rawAnswers[index];
    if (
      question === null ||
      !(answer === null ||
        (Array.isArray(answer) && answer.every((value) => typeof value === "string")))
    ) {
      return null;
    }
    questions.push({
      question,
      answers: answer === null || answer.length === 0 ? null : [...answer],
    });
  }

  return { kind: "asktool", role: "details", questions };
}

/**
 * Whether the call failed, whichever half recorded it. The live runtime writes
 * `toolStatus` and `isError` together, but an imported transcript may carry
 * only the envelope's own `isError` flag, and a denied call reports through
 * `toolStatus` alone. Both mean the same thing to a reader: this is an error,
 * not the payload it was supposed to deliver.
 */
function resultFailed(message: ToolPresentationMessage): boolean {
  if (message.toolStatus === "error" || message.toolStatus === "denied") {
    return true;
  }
  if (message.isError === true) return true;
  return asRecord(message.toolResult)?.isError === true;
}

/**
 * The Run row describes the tool invocation lifecycle. A numeric shell exit
 * code means Bash returned normally, even when the command itself failed; the
 * exit chip carries that command outcome. Explicit error envelopes and results
 * without an exit code still describe an invocation failure.
 */
export function runOutcome(
  message: ToolPresentationMessage,
): "running" | "denied" | "failed" | "ok" | "unknown" {
  // Preparing and running are both in flight: the call has not returned, so it
  // is never "ok" or "unknown" before it actually runs.
  if (message.toolStatus === "preparing") return "running";
  if (message.toolStatus === "running") return "running";
  if (message.toolStatus === "denied") return "denied";
  const details = asRecord(toolResultPayload(message));
  if (
    details?.isError === true ||
    typeof details?.error === "string" ||
    typeof details?.errorCode === "string"
  ) {
    return "failed";
  }
  if (details && numberAt(details, "exitCode") !== null) return "ok";
  if (message.isError === true) return "failed";
  if (message.toolStatus === "error") return "failed";
  if (message.toolStatus === "success") return "ok";
  return "unknown";
}

/** Cheap outcome badges for the collapsed row: no stringify, property reads. */
export function toolResultChips(message: ToolPresentationMessage): ToolChip[] {
  const details = asRecord(toolResultPayload(message));
  if (!details) return [];
  const action = getToolAction(message.toolName);
  const chips: ToolChip[] = [];
  const exitCode = numberAt(details, "exitCode");
  // A successful exit is already implied by the row status; only failures earn
  // a badge.
  if (exitCode !== null && exitCode !== 0) {
    chips.push({ role: "exit", count: exitCode });
  }
  const count = numberAt(details, "count");
  const counted =
    Array.isArray(details.matches) ||
    Array.isArray(details.files) ||
    Array.isArray(details.counts);
  if (count !== null && counted) {
    chips.push({ role: action === "list" ? "files" : "matches", count });
  }
  const replacements = numberAt(details, "replacements");
  if (replacements !== null && replacements > 0) {
    chips.push({ role: "replacements", count: replacements });
  }
  if (action === "read") {
    const lineRange = formatReadLineRange(details);
    if (lineRange !== null) chips.push({ role: "lines", text: lineRange });
  } else {
    const bytes = numberAt(details, "bytes") ?? numberAt(details, "fileBytes");
    if (bytes !== null) chips.push({ role: "size", text: formatBytes(bytes) });
  }
  if (details.truncated === true) chips.push({ role: "truncated" });
  if (details.root === "scratch") chips.push({ role: "scratch" });
  return chips;
}

/**
 * Whether the row has anything to expand. Kept property-read cheap: streaming
 * replaces the message object on every tick, and collapsed rows only need to
 * know whether the caret should show.
 */
export function hasToolDetails(message: ToolPresentationMessage): boolean {
  const payload = toolResultPayload(message);
  if (typeof payload === "string") {
    if (payload !== "") return true;
  } else if (payload !== undefined) {
    const record = asRecord(payload);
    if (!record || Object.keys(record).length > 0) return true;
  }
  const args = asRecord(message.toolArgs);
  if (args) return Object.keys(args).length > 0;
  return message.toolArgs !== undefined;
}

function resultBlocks(
  action: ToolAction,
  message: ToolPresentationMessage,
  args: Record<string, unknown> | null,
  payload: unknown,
  options: ToolPresentationOptions = {},
): ToolBlock[] {
  const details = asRecord(payload);
  const blocks: ToolBlock[] = [];
  /**
   * Set once a mapping has said everything there is to say about the result, so
   * an empty body is read as "it printed nothing" rather than as a payload the
   * generic fallback still has to render (D226).
   */
  let mapped = false;
  const error = stringAt(details, "error");
  if (error) {
    const code = stringAt(details, "code");
    blocks.push({
      kind: "note",
      role: "error",
      text: error,
      ...(code ? { code } : {}),
    });
  }

  switch (action) {
    case "read": {
      // A present-but-empty `content` is an empty file, not a missing body.
      const content =
        details && typeof details.content === "string" ? details.content : null;
      if (content !== null) {
        const path = stringAt(details, "path") ?? stringAt(args, "path");
        blocks.push(codeBlock("content", content, langForPath(path)));
        mapped = true;
      } else if (resultFailed(message)) {
        mapped = true;
      }
      break;
    }
    case "write": {
      const content = typeof args?.content === "string" ? args.content : null;
      if (content !== null) {
        const path = stringAt(args, "path") ?? stringAt(details, "path");
        blocks.push(codeBlock("written", content, langForPath(path)));
        mapped = true;
      } else if (resultFailed(message)) {
        mapped = true;
      }
      break;
    }
    case "edit": {
      const ops = stringAt(args, "ops");
      // Workspace edits already own a ReviewChangeCard with the real diff;
      // only scratch edits and imported sessions need the model's stated ops.
      const reviewed =
        reviewChangeFromMessage(message as unknown as UiMessage) !== null;
      if (ops !== null && !reviewed) {
        blocks.push(codeBlock("input", ops));
      }
      const warnings = stringArray(details?.warnings);
      if (warnings) {
        for (const warning of warnings) {
          blocks.push({ kind: "note", role: "notice", text: warning });
        }
      }
      // The mutation mapping has said its whole say: a reviewed change is the
      // diff the row hosts, a scratch edit is its ops. The record's own
      // `path`/`root`/`tag`/`deleted`/`ops` fields restate that at lower
      // fidelity, so an empty body here is an answer rather than a payload the
      // generic fallback still has to render (D226).
      mapped = reviewed || ops !== null || resultFailed(message);
      break;
    }
    case "run": {
      const command = stringAt(args, "command", "cmd");
      // Bash progress updates use `details.output`; the completed result uses
      // `details.stdout`. A present-but-empty stdout still means the command
      // printed nothing, so it suppresses a stale progress snapshot rather than
      // falling back to `output`; an empty channel is then omitted from the
      // terminal, because an empty pane says less than no pane at all.
      const stdout =
        typeof details?.stdout === "string"
          ? details.stdout
          : stringAt(details, "output");
      // A run row's body is a terminal (D226 follow-up): the command it ran,
      // then what the command printed. The head still copies the whole command
      // and states the outcome; these panes are what the reader expanded for.
      blocks.push({
        kind: "terminal",
        role: "command",
        command,
        stdout: stdout ? stdout : null,
        stderr: stringAt(details, "stderr"),
      });
      mapped = true;
      break;
    }
    case "list": {
      const paths = stringArray(details?.matches) ?? stringArray(details?.files);
      if (paths) {
        // An empty list is the answer to the pattern, so it has to be stated:
        // the payload's `count`/`truncated` fields are not a body.
        blocks.push(filesBlock(paths) ?? emptyBlock("files"));
        mapped = true;
      } else if (resultFailed(message)) {
        mapped = true;
      }
      break;
    }
    case "search": {
      const hits = details?.matches;
      // `outputMode` decides the shape: content → path/line hits,
      // filesWithMatches → a path list, count → hits per file.
      const block = Array.isArray(hits) ? matchesBlock(hits) : null;
      const paths = block ? null : stringArray(details?.files);
      const grouped = block ?? (paths ? filesBlock(paths) : null);
      const resolved = grouped ?? countsBlock(details?.counts);
      if (resolved) {
        blocks.push(resolved);
        mapped = true;
      } else if (
        Array.isArray(hits) ||
        paths !== null ||
        Array.isArray(details?.counts) ||
        resultFailed(message)
      ) {
        // The mode's own array came back empty: nothing matched, which the
        // reader is entitled to read as a result.
        blocks.push(emptyBlock(paths ? "files" : "matches"));
        mapped = true;
      }
      break;
    }
    case "todo": {
      // A checklist is a list of items, not an argument dump: the host result
      // carries the committed list, its counts and its warnings, so the body
      // shows what the session holds rather than the argument that was sent.
      // A refused write committed nothing, so its own list must not appear as
      // if it had; the `error` note above is the whole body then.
      const checklist = resultFailed(message)
        ? null
        : todosBlock(args, details);
      if (checklist) blocks.push(checklist);
      const warnings = stringArray(details?.warnings);
      if (warnings) {
        for (const warning of warnings) {
          blocks.push({ kind: "note", role: "notice", text: warning });
        }
      }
      // The host's success line ("Checklist updated: 2/3 completed; current:
      // …") restates what the checklist above already shows — the counts, the
      // in-progress item and the warnings it embeds — so a routine write adds
      // no second section. Warnings still reach the reader above, and a
      // refused write reports through `error`, which renders as its own note.
      mapped = true;
      break;
    }
    case "delegate": {
      // A lifecycle row (ADR 0089) has no brief and no report of its own: it
      // reports on subagents. Its body is the roster the runtime returned, as
      // a named table rather than the raw `delegations[]` JSON (D268).
      if (delegationLifecycleKind(message.toolName)) {
        // The joined reports are bounded at 50k chars by the runtime, which is
        // far too much for a `note`: an output block scrolls within a fixed
        // height and carries a copy button (D271).
        const text = envelopeTextOf(message);
        if (text) blocks.push(codeBlock("output", text, "markdown"));
        const roster = rosterBlocks(details);
        blocks.push(...roster);
        // A stop request that found nothing running still has its sentence.
        mapped = text !== null || roster.length > 0 || resultFailed(message);
        break;
      }
      // A delegation reads as brief in, report out. The counters that pi hands
      // back (`turns`, `toolCalls`, `usage`) are a footer, and `agent` already
      // labels the row, so neither repeats here.
      const brief = stringAt(args, "task");
      if (brief !== null) {
        blocks.push(codeBlock("input", brief, "markdown", { label: "task" }));
      }
      const report = options.hideDelegateReport
        ? null
        : delegateReport(message);
      if (report !== null) blocks.push(codeBlock("output", report, "markdown"));
      const counters = details
        ? Object.fromEntries(
            Object.entries(details).filter(
              ([key]) =>
                key !== "agent" &&
                key !== "error" &&
                key !== "modelId" &&
                key !== "thinkingLevel",
            ),
          )
        : {};
      if (Object.keys(counters).length > 0) {
        blocks.push(
          ...recordBlocks(counters, "details", {
            labelKey: "chat.toolBlockStats",
          }),
        );
      }
      break;
    }
    case "skill": {
      // The Skill tool answers with the loaded document as text; its card names
      // the document and renders the body (Markdown), instead of printing the
      // whole answer as one raw block.
      const text = typeof payload === "string" ? payload : envelopeTextOf(message);
      if (text !== null) {
        if (resultFailed(message)) {
          blocks.push({ kind: "note", role: "error", text });
        } else {
          const document = parseSkillDocument(text);
          const id = stringAt(args, "id") ?? (document?.id || "");
          // An answer the tool did not shape as a document still gets a name:
          // its own first line describes it better than the id the row summary
          // already shows.
          const heading = text.split("\n")[0].trim().slice(0, 120);
          const fields: ToolFieldRow[] = [];
          if (document?.location) {
            fields.push({ label: "location", value: document.location });
          }
          if (document?.references) {
            fields.push({ label: "references", value: document.references });
          }
          blocks.push({
            kind: "document",
            role: "output",
            title: document?.name || heading || id,
            id,
            fields,
            body: document?.body ?? text,
          });
        }
        mapped = true;
      }
      break;
    }
    case "toolSearch": {
      // The result names the tools it found and activated; the definitions
      // themselves stay in the catalog, so the card lists names only.
      const activated = valuesBlock("activated", details?.activated);
      const matches = valuesBlock("matches", details?.matches);
      // A successful activation records the same names again as
      // `addedToolNames`; that legacy carrier only speaks when the row reports
      // no `activated` list of its own, so one set of names is listed once.
      const added = activated
        ? null
        : valuesBlock("added", details?.addedToolNames);
      const groups = [activated, matches, added].filter(
        (block): block is ToolBlock => block !== null,
      );
      blocks.push(...groups);
      // The envelope sentence ("Activated on-demand tools: X. They are
      // available on the next model turn.") is the model-facing wrapper of the
      // lists above, so it is shown only where it is the whole answer — a
      // search that listed nothing — or where the call failed, and then as the
      // error it is.
      const text = envelopeTextOf(message);
      if (text && (groups.length === 0 || resultFailed(message))) {
        blocks.push({
          kind: "note",
          role: resultFailed(message) ? "error" : "notice",
          text,
        });
      }
      // What a tool search answers with is the names it found and that
      // sentence; its query and legacy carriers are not a second body.
      mapped = true;
      break;
    }
    case "schedule": {
      const acknowledged = stringAt(details, "id");
      const rows = scheduledTaskRows(
        "task",
        details?.task ?? details?.tasks ?? acknowledged,
        options.weekdayName,
      );
      if (rows) blocks.push(rows);
      const text = envelopeTextOf(message);
      if (text) blocks.push({ kind: "note", role: "notice", text });
      mapped = rows !== null || text !== null;
      break;
    }
    case "browser":
    case "mode":
    case "context": {
      // Each of these answers with one sentence saying what it did; the state
      // it changed is in that text, and the arguments carry the target.
      const text = envelopeTextOf(message);
      if (text) blocks.push({ kind: "note", role: "notice", text });
      mapped = text !== null;
      break;
    }
    case "image": {
      // Results embed the image bytes, so the card reads the prompt and the
      // written files rather than falling back to a payload dump.
      const items = Array.isArray(args?.items) ? args.items : [];
      const prompts = valuesBlock(
        "prompt",
        items
          .map((item) => asRecord(item)?.prompt)
          .filter((prompt): prompt is string => typeof prompt === "string"),
      );
      if (prompts) blocks.push(prompts);
      const results = Array.isArray(details?.results) ? details.results : [];
      const written: string[] = [];
      for (const entry of results) {
        const record = asRecord(entry);
        if (record?.status === "succeeded" && typeof record.path === "string") {
          written.push(record.path);
        } else if (typeof record?.error === "string") {
          blocks.push({ kind: "note", role: "error", text: record.error });
        }
      }
      const files = filesBlock(written);
      if (files) blocks.push(files);
      mapped = true;
      break;
    }
    default:
      break;
  }

  // Host-side scoping notes ("results are truncated…", "N long lines were cut")
  // explain a short result, so they ride along with the blocks they qualify.
  const notice = stringAt(details, "notice");
  if (notice && (blocks.length > 0 || mapped)) {
    blocks.push({ kind: "note", role: "notice", text: notice });
  }

  if (blocks.length > 0 || mapped) return blocks;
  // No per-tool mapping matched: render the payload itself readably, and keep
  // the untouched payload one explicit disclosure away (never in the summary
  // and never as the body a reader has to wade through).
  if (typeof payload === "string" && payload.trim()) {
    return [codeBlock("output", payload)];
  }
  if (details) return withRawBlock(recordBlocks(details, "details"), details);
  if (payload !== undefined && payload !== null) {
    return [codeBlock("output", safeJson(payload), "json")];
  }
  return [];
}

/**
 * Build the expanded body of a tool row. Called only while the row is open —
 * the work here is proportional to the payload, not to the render frequency.
 */
export function buildToolPresentation(
  message: ToolPresentationMessage,
  options: ToolPresentationOptions = {},
): ToolBlock[] {
  if (isAskToolName(message.toolName)) {
    const askToolBlock = askToolResultBlock(message);
    if (askToolBlock) return [askToolBlock];
  }

  const action = getToolAction(message.toolName);
  const args = asRecord(message.toolArgs);
  const payload = toolResultPayload(message);
  const blocks = resultBlocks(action, message, args, payload, options);
  if (!args) return blocks;

  // Arguments are worth showing when the result blocks did not already carry
  // them (Read content, Bash command) and for opaque tools whose arguments are
  // the interesting part. A delegation places its own brief, so it opts out.
  // A run row's command was withheld above because the head shows it, so the
  // body must not print it back as an argument the moment a command prints
  // nothing (D226). A refused checklist is the same case in another shape: it
  // committed nothing, so its argument must not appear as an input list the
  // reader could mistake for the session's checklist.
  const headHasCommand =
    action === "run" &&
    options.hideSummaryArg === true &&
    getToolSummaryKey(message.toolName, args) !== null;
  // A workspace mutation's record already states the file, the operation and
  // the change; `path`/`tag`/`ops` are how the change was requested, not what
  // it did, so the body must not print them beside the diff.
  const reviewedEdit =
    action === "edit" &&
    reviewChangeFromMessage(message as unknown as UiMessage) !== null;
  const wantArgs =
    action !== "delegate" &&
    !reviewedEdit &&
    !(action === "todo" && resultFailed(message)) &&
    !headHasCommand &&
    (blocks.length === 0 ||
      // An empty result is the answer, not a preamble the arguments explain.
      (blocks.every(
        (block) => block.role === "error" || block.role === "notice",
      ) &&
        !blocks.some((block) => block.kind === "empty")) ||
      action === "use" ||
      action === "fork" ||
      action === "fetch");
  if (!wantArgs) return blocks;
  const summaryKey = options.hideSummaryArg
    ? getToolSummaryKey(message.toolName, args)
    : null;
  const remaining = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== summaryKey),
  );
  if (Object.keys(remaining).length === 0) return blocks;
  return [...blocks, ...recordBlocks(remaining, "input")];
}
