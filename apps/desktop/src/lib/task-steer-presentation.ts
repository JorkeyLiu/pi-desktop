 /*
  * Curated presentation for the exact `TaskSteer` built-in (model guidance
  * sent to a live delegation).
  *
  * Presentation only: it never changes routing, queueing or execution. It
  * owns the row's collapsed summary and expanded body for that one tool name
  * only. An accepted steer reads as its human target task plus the guidance
  * text actually sent — no receipt sentence, no status/result section, no
  * raw payload. Any other outcome (delivered, unknown, malformed) keeps the
  * accurate generic mapping rather than an invented body, and a failure
  * states only its reason.
  */
import type {
  ToolBlock,
  ToolPresentationMessage,
  ToolPresentationOptions,
} from "./tool-presentation";

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


function compact(value: string, limit = 160): string {
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
 * `details` holds the structured receipt; the content blocks repeat it as
 * text for the model, so showing both would duplicate every byte.
 */
function steerPayload(message: ToolPresentationMessage): unknown {
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
 * Whether the steer failed, whichever half recorded it: the runtime's own
 * `toolStatus`/`isError` flags, or an explicit error the receipt carries.
 */
export function taskSteerFailed(message: ToolPresentationMessage): boolean {
  if (message.toolStatus === "error" || message.toolStatus === "denied") {
    return true;
  }
  if (message.isError === true) return true;
  const envelope = asRecord(message.toolResult);
  if (envelope?.isError === true) return true;
  const details = asRecord(steerPayload(message));
  if (!details) return false;
  if (typeof details.error === "string") return true;
  if (typeof details.errorCode === "string") return true;
  return false;
}

/**
 * A failed steer row's body: exactly one failure sentence. Internal ids,
 * the dropped draft and any other record never render as fields or raw.
 */
export function taskSteerFailureBlock(
  message: ToolPresentationMessage,
  options: ToolPresentationOptions = {},
): ToolBlock[] {
  const details = asRecord(steerPayload(message));
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
 * The human target task a steer row names, resolved without ever printing a
 * routing id. The conversation-wide delegation titles name it (the `Task`
 * call that started the delegation named the work). Empty means no label
 * resolved, and the body shows only the guidance it sent — a steer call
 * carries no title of its own.
 */
export function resolveTaskSteerTarget(
  message: ToolPresentationMessage,
  titles: ReadonlyMap<string, string> | null,
): string {
  const args = asRecord(message.toolArgs);
  const delegationId = stringAt(args, "delegationId");
  if (delegationId && titles) {
    const titled = titles.get(delegationId)?.trim();
    if (titled) return titled;
  }
  return "";
}

/**
 * What one steer call says when it is collapsed: the description it carries,
 * else the guidance text it sends, bounded to a single line. Internal routing
 * ids never reach the head; without either the row keeps its identity and
 * states no hint. The target task name, when resolvable, names the expanded
 * body through the delegation titles, never the row's agent slot.
 */
export function taskSteerSummarySpec(args: unknown): {
  key: string | null;
  text: string;
  path: boolean;
} {
  const record = asRecord(args);
  const hint = stringAt(record, "description") ?? stringAt(record, "message");
  if (!hint) return { key: null, text: "", path: false };
  const text = compact(hint);
  return text ? { key: null, text, path: false } : { key: null, text: "", path: false };
}

 /**
  * An accepted steer's curated body: exactly one `Output` block holding the
  * guidance text the call actually sent. No target field (the head already
  * names it), no receipt sentence, no status/result section, no raw payload:
  * routing ids, provenance and queue-delivery internals never render.
  * Returns `null` when the receipt is not the queueing shape the host
  * answers an accepted steer with, keeping the accurate generic mapping
  * rather than an invented body. A call still running (or with no payload
  * yet) renders no blocks: there is nothing to curate.
  */
 export function taskSteerReceiptBlocks(
   message: ToolPresentationMessage,
   options: ToolPresentationOptions = {},
 ): ToolBlock[] | null {
   const payload = steerPayload(message);
   if (payload === undefined) return [];
   const details = asRecord(payload);
   if (!details || details.status !== "queued") return null;
   void options;
   const sent = stringAt(asRecord(message.toolArgs), "message");
   if (!sent) return null;
   return [{ kind: "code", role: "output", text: sent, lang: "", highlight: false }];
 }
