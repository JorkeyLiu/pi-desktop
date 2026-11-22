/*
 * Curated presentation for the exact shipped Browser plugin tool
 * (`plugin_pi_browser_Browser`).
 *
 * Presentation only: it never changes what the tool does, what it returns,
 * or what is persisted. It owns the row's identity, collapsed summary and
 * expanded body for that one tool name only — any other tool whose name
 * merely ends in `Browser` keeps the generic presentation. Bodies never
 * echo the call's arguments: a failure states only its reason (never input,
 * state, result or raw blocks), and a success shows curated content with
 * one optional raw disclosure for the untouched payload.
 */
import type {
  ToolBlock,
  ToolPresentationMessage,
  ToolPresentationOptions,
} from "./tool-presentation";

/** The exact shipped plugin tool this module owns. Never a suffix match. */
export const BROWSER_PLUGIN_TOOL_NAME = "plugin_pi_browser_Browser";

export function isBrowserPluginTool(toolName?: string): boolean {
  return toolName === BROWSER_PLUGIN_TOOL_NAME;
}

export type BrowserPluginAction =
  | "navigate"
  | "snapshot"
  | "screenshot"
  | "click"
  | "fill"
  | "evaluate"
  | "console"
  | "cdp";

const BROWSER_PLUGIN_ACTIONS: ReadonlySet<string> = new Set([
  "navigate",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "evaluate",
  "console",
  "cdp",
]);

function isBrowserPluginAction(value: string): value is BrowserPluginAction {
  return BROWSER_PLUGIN_ACTIONS.has(value);
}

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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function compact(value: string, limit = 220): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > limit
    ? `${singleLine.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
    : singleLine;
}

/** Join the text blocks of a pi-ai result envelope. */
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
 * `details` holds the structured host result; the content blocks repeat it
 * as text for the model, so showing both would duplicate every byte.
 */
function browserPayload(message: ToolPresentationMessage): unknown {
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
 * The failure sentence an error envelope states in its text blocks.
 * A text block that merely re-serializes `details` is that payload again,
 * not an explanation, so it is not a reason either.
 */
function envelopeFailureText(
  message: ToolPresentationMessage,
  details: Record<string, unknown> | null,
): string | null {
  const envelope = asRecord(message.toolResult);
  if (!envelope) return null;
  const text = envelopeText(envelope)?.trim() ?? "";
  if (text === "") return null;
  if (details && (text.startsWith("{") || text.startsWith("["))) {
    try {
      if (JSON.stringify(JSON.parse(text)) === JSON.stringify(details)) {
        return null;
      }
    } catch {
      // Prose that merely starts with a bracket is still an explanation.
    }
  }
  return text;
}

/**
 * Whether the browser call failed, whichever half recorded it. Beyond the
 * runtime's own `toolStatus`/`isError` flags, the shipped plugin reports
 * failures inside its payload (`ok: false`, an `error`/`errorCode` string),
 * even when the row's status did not flip — the row must read as failed
 * then, because the call delivered no page, tree, shot or value.
 */
export function browserFailed(message: ToolPresentationMessage): boolean {
  if (message.toolStatus === "error" || message.toolStatus === "denied") {
    return true;
  }
  if (message.isError === true) return true;
  const envelope = asRecord(message.toolResult);
  if (envelope?.isError === true) return true;
  const details = asRecord(browserPayload(message));
  if (!details) return false;
  if (details.ok === false) return true;
  if (typeof details.error === "string") return true;
  if (typeof details.errorCode === "string") return true;
  return false;
}

/**
 * A failed browser row's body: exactly one failure sentence. A failure
 * explains itself with the structured `error` first, then the envelope's
 * own sentence, then the row's recorded error, then the renderer's
 * localized sentence — never input, state, result or raw blocks, even when
 * the payload echoes the arguments. The payload itself is left untouched
 * for persistence; only its rendering is suppressed.
 */
export function browserFailureBlock(
  message: ToolPresentationMessage,
  options: ToolPresentationOptions = {},
): ToolBlock[] {
  const details = asRecord(browserPayload(message));
  const structured = stringAt(details, "error");
  if (structured) {
    const code = stringAt(details, "errorCode") ?? stringAt(details, "code");
    return [
      {
        kind: "note",
        role: "error",
        text: structured,
        ...(code ? { code } : {}),
      },
    ];
  }
  const sentence = envelopeFailureText(message, details);
  if (sentence) return [{ kind: "note", role: "error", text: sentence }];
  const recorded = asRecord(message.error);
  const recordedText = stringAt(recorded, "message");
  const recordedCode = stringAt(recorded, "code");
  const text =
    recordedText ??
    options.failureNote?.(message.toolStatus === "denied" ? "denied" : "failed");
  if (!text) return [];
  return [
    {
      kind: "note",
      role: "error",
      text,
      ...(recordedCode ? { code: recordedCode } : {}),
    },
  ];
}

/**
 * Which browser action the call ran, read from its own arguments. Anything
 * else (missing, blank, or a name the plugin does not implement) is not a
 * known action: the row keeps its bare identity and the body falls back to
 * the generic mapping rather than a misleading label.
 */
export function browserActionOf(args: unknown): BrowserPluginAction | null {
  const record = asRecord(args);
  const raw = record ? record.action : undefined;
  const action = typeof raw === "string" ? raw.trim() : "";
  return isBrowserPluginAction(action) ? action : null;
}

/**
 * The i18n key naming a browser action in the session language. The React
 * layer translates it; without a known action there is no key and the row
 * keeps its bare identity.
 */
export function browserActionLabelKey(
  action: BrowserPluginAction | null,
): string | null {
  switch (action) {
    case "navigate":
      return "chat.toolBrowserNavigate";
    case "snapshot":
      return "chat.toolBrowserSnapshot";
    case "screenshot":
      return "chat.toolBrowserScreenshot";
     case "click":
       return "chat.toolBrowserClick";
     case "fill":
       return "chat.toolBrowserFill";
     case "evaluate":
       return "chat.toolBrowserEvaluate";
     case "console":
       return "chat.toolBrowserConsole";
     case "cdp":
       return "chat.toolBrowserCdp";
     default:
       return null;
   }
 }

export type BrowserSummarySpec = {
  /** The browser body never echoes arguments, so no summary arg is withheld. */
  key: string | null;
  /** Single-line text for the collapsed row. A path stays whole. */
  text: string;
  /** The value is a filesystem path, so its middle may be omitted visually. */
  path: boolean;
};

const NO_SUMMARY: BrowserSummarySpec = { key: null, text: "", path: false };

/**
 * What one browser call says when it is collapsed. A finished call reads
 * its result (page title/address, shot path, target, value); a call still
 * running reads the arguments it was issued with — never session ids, never
 * the script it runs, never the text it types. Every branch is bounded to a
 * single line.
 */
export function browserSummarySpec(
  args: unknown,
  payload: unknown,
  toolStatus?: string,
): BrowserSummarySpec {
  const record = asRecord(args);
  const action = browserActionOf(record ?? args);
  if (!action) return NO_SUMMARY;
  const finished = toolStatus !== "running" && toolStatus !== "preparing";
  const details = asRecord(payload);

  switch (action) {
    case "navigate": {
      const state = asRecord(details?.state);
      const title = stringAt(state, "title");
      const url = stringAt(state, "url");
      if (finished && (title || url)) {
        return {
          key: null,
          text: compact([title, url].filter((part) => part !== null).join(" · ")),
          path: false,
        };
      }
      const argUrl = stringAt(record, "url");
      if (argUrl) return { key: null, text: compact(argUrl), path: false };
      const argPath = stringAt(record, "path");
      if (argPath) {
        return {
          key: null,
          text: argPath.replace(/\s+/g, " ").trim(),
          path: false,
        };
      }
      return NO_SUMMARY;
    }
    case "snapshot": {
      if (!finished) return NO_SUMMARY;
      const title = stringAt(details, "title");
      const url = stringAt(details, "url");
      if (!title && !url) return NO_SUMMARY;
      return {
        key: null,
        text: compact([title, url].filter((part) => part !== null).join(" · ")),
        path: false,
      };
    }
    case "screenshot": {
      if (!finished) return NO_SUMMARY;
      const path = stringAt(details, "path");
      if (!path) return NO_SUMMARY;
      return { key: null, text: path.replace(/\s+/g, " ").trim(), path: true };
    }
    case "click":
    case "fill": {
      const uid =
        (finished ? stringAt(details, "uid") : null) ?? stringAt(record, "uid");
      if (!uid) return NO_SUMMARY;
      return { key: null, text: compact(uid), path: false };
    }
    case "evaluate": {
      // The script it runs is never the summary; a finished call names its
      // bounded value instead.
      if (!finished) return NO_SUMMARY;
      if (!details || !Object.hasOwn(details, "result")) return NO_SUMMARY;
      const result = details.result;
      if (result === undefined) return NO_SUMMARY;
      if (result === null) return { key: null, text: "null", path: false };
      if (
        typeof result === "string" ||
        typeof result === "number" ||
        typeof result === "boolean" ||
        typeof result === "bigint"
      ) {
        const text = compact(String(result), 160);
        return text ? { key: null, text, path: false } : NO_SUMMARY;
      }
      if (typeof result === "object") {
        const text = compact(safeJson(result), 160);
        return text ? { key: null, text, path: false } : NO_SUMMARY;
      }
      return NO_SUMMARY;
    }
    case "console": {
      if (!finished) return NO_SUMMARY;
      const messages = details?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return NO_SUMMARY;
      const last = asRecord(messages[messages.length - 1]);
      const level = stringAt(last, "type") ?? "log";
      return {
        key: null,
        text: `${messages.length} · ${level}`,
        path: false,
      };
    }
    case "cdp": {
      const method = stringAt(record, "method");
      if (!method) return NO_SUMMARY;
      return { key: null, text: compact(method), path: false };
    }
    default:
      return NO_SUMMARY;
  }
}

/** Attach the untouched payload as its own explicit disclosure, when it fits. */
function browserRawBlock(payload: unknown): ToolBlock | null {
  const text = safeJson(payload);
  if (!text || text === "{}") return null;
  // Screenshots embed base64 bytes: the disclosure stays bounded, and a
  // payload that does not fit is dropped rather than printed inline.
  if (text.length > 20_000) return null;
  return { kind: "raw", role: "details", text };
}

function withBrowserRaw(blocks: ToolBlock[], payload: unknown): ToolBlock[] {
  const raw = browserRawBlock(payload);
  return raw ? [...blocks, raw] : blocks;
}

 /** A result value that keeps its own shape: text as output, other scalars
  * as fields, objects as JSON. A missing key never reaches here; only a
  * falsy answer must not be misread as absent. */
 function resultValueBlock(result: unknown): ToolBlock {
   if (typeof result === "string") {
     return { kind: "code", role: "output", text: result, lang: "", highlight: false };
   }
   if (result === null) {
     return { kind: "fields", role: "output", rows: [{ label: "result", value: "null" }] };
   }
   if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") {
     return { kind: "fields", role: "output", rows: [{ label: "result", value: String(result) }] };
   }
   return { kind: "code", role: "output", text: safeJson(result), lang: "json", highlight: false };
 }

type BrowserImage = { mimeType: string; data: string };

function screenshotImages(details: Record<string, unknown>): BrowserImage[] | null {
  const raw = details.images;
  if (!Array.isArray(raw)) return null;
  const images: BrowserImage[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const mimeType = stringAt(record, "mimeType");
    const data = stringAt(record, "data");
    if (mimeType && data) images.push({ mimeType, data });
  }
  return images.length > 0 ? images : null;
}

/**
 * A successful browser call's curated body, or `null` when the payload is
 * not the shape the known action answers with. `null` falls back to the
 * existing generic mapping rather than losing data. A call still running
 * (or with no payload yet) renders no blocks: there is nothing to curate.
 */
export function browserSuccessBlocks(
  message: ToolPresentationMessage,
): ToolBlock[] | null {
  const action = browserActionOf(message.toolArgs);
  if (!action) return null;
  const payload = browserPayload(message);
  if (payload === undefined) return [];
  const details = asRecord(payload);
  if (!details) return null;

  switch (action) {
    case "navigate": {
      const state = asRecord(details.state);
      if (!state) return null;
      const rows: { label: string; value: string }[] = [];
      const title = stringAt(state, "title");
      const url = stringAt(state, "url");
      if (title) rows.push({ label: "title", value: title });
      if (url) rows.push({ label: "address", value: url });
      if (rows.length === 0) return null;
      return withBrowserRaw(
        [{ kind: "fields", role: "output", rows }],
        payload,
      );
    }
    case "snapshot": {
      // The tree is the page's accessible text (e.g. "- e1 WebArea …"), so
      // it renders as plain output, never as JSON and never as fields.
      if (typeof details.tree !== "string") return null;
      return withBrowserRaw(
        [{ kind: "code", role: "output", text: details.tree, lang: "", highlight: false }],
        payload,
      );
    }
    case "screenshot": {
      const images = screenshotImages(details);
      if (!images) return null;
      const path = stringAt(details, "path");
      const blocks: ToolBlock[] = images.map((image, index) => ({
        kind: "image" as const,
        role: "output" as const,
        src: `data:${image.mimeType};base64,${image.data}`,
        alt: path ?? `${image.mimeType} screenshot ${index + 1}`,
        copy: path ?? `${image.mimeType} screenshot ${index + 1}`,
      }));
      const text = stringAt(details, "text");
      if (text) blocks.push({ kind: "note", role: "notice", text });
      return withBrowserRaw(blocks, payload);
    }
    case "click":
    case "fill": {
      // The target it acted on; a fill never prints the text it typed.
      const uid = stringAt(details, "uid");
      if (!uid) return null;
      return withBrowserRaw(
        [{ kind: "fields", role: "output", rows: [{ label: "target", value: uid }] }],
        payload,
      );
    }
    case "evaluate":
    case "cdp": {
      // The value it answered with, preserving null/false/0/"" — only a
      // missing key falls back, never a falsy answer misread as absent.
      if (!Object.hasOwn(details, "result")) return null;
      const result = details.result;
      if (result === undefined) return null;
      return withBrowserRaw([resultValueBlock(result)], payload);
    }
    case "console": {
      if (!Array.isArray(details.messages)) return null;
      const lines = details.messages.map((entry) => {
        const record = asRecord(entry);
        const type = stringAt(record, "type") ?? "log";
        const text =
          typeof record?.text === "string" ? record.text : safeJson(record?.text);
        return `[${type}] ${text}`;
      });
      return withBrowserRaw(
        [{ kind: "code", role: "output", text: lines.join("\n"), lang: "", highlight: false }],
        payload,
      );
    }
    default:
      return null;
  }
}
