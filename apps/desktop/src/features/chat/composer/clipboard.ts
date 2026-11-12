/**
 * Composer clipboard: a draft selection that holds attachment chips.
 *
 * The draft stores every chip as one private-use sentinel character, so the
 * browser's own copy would either drop the chip (`user-select: none`) or leak a
 * renderer sentinel into a clipboard another application reads. Copy and cut
 * therefore describe the selection themselves: `text/plain` gets the readable
 * `@path` text the send path already produces, and a versioned JSON payload
 * carries the ordered text/attachment parts for a paste inside this application.
 *
 * The payload is application-internal and arrives from an untrusted clipboard.
 * It describes references only — nothing here reads a file, resolves a path,
 * or grants plugin, session, or host authority. Path resolution, permissions,
 * and plugin ownership stay with the existing host and send paths, which refuse
 * anything outside their own roots.
 */
import { formatFileInsert, formatSessionLink } from "@pi-desktop/shared";
import {
  CHIP_TOKEN_COUNT,
  createFileReference,
  isChipTokenChar,
  isPersistedScratchReference,
  nextChipToken,
  type ComposerFileReference,
} from "./editor";

export const COMPOSER_CLIPBOARD_MIME = "application/x-pi-desktop-composer+json";
export const COMPOSER_CLIPBOARD_VERSION = 1;
/** Total draft text one payload may carry, in characters. */
export const MAX_CLIPBOARD_TEXT_CHARS = 65_536;
export const MAX_CLIPBOARD_REFERENCES = 128;
export const MAX_CLIPBOARD_PARTS = 512;
export const MAX_CLIPBOARD_PATH_CHARS = 4_096;
export const MAX_CLIPBOARD_NAME_CHARS = 256;
export const MAX_CLIPBOARD_SESSION_ID_CHARS = 128;
const MAX_CLIPBOARD_MIME_CHARS = 128;
/** The largest payload this codec writes, so an oversized one is refused early. */
const MAX_CLIPBOARD_PAYLOAD_CHARS =
  MAX_CLIPBOARD_TEXT_CHARS +
  MAX_CLIPBOARD_REFERENCES * (MAX_CLIPBOARD_PATH_CHARS + MAX_CLIPBOARD_NAME_CHARS + MAX_CLIPBOARD_MIME_CHARS + 128) +
  2_048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&+.^_*-]*\/[A-Za-z0-9!#$&+.^_*-]*$/;

/** One reference the clipboard describes; never a plugin part or a renderer id. */
export type ComposerClipboardReference = {
  readonly kind: "file" | "image" | "session";
  readonly path: string;
  readonly name: string;
  readonly mimeType?: string;
};

export type ComposerClipboardPart =
  | { readonly text: string }
  | { readonly ref: ComposerClipboardReference };

export type ComposerClipboardPayload = {
  readonly v: typeof COMPOSER_CLIPBOARD_VERSION;
  /** The draft session the copy came from: a portability hint, not an identity. */
  readonly s: string;
  readonly parts: readonly ComposerClipboardPart[];
};

/** What one copy or cut takes out of a draft selection. */
export type ComposerClipboardSlice = {
  readonly start: number;
  readonly end: number;
  /** The draft text the selection covers, chips as their sentinels. */
  readonly text: string;
  /** The readable text a clipboard consumer outside this application sees. */
  readonly plainText: string;
  /** The ordered text/reference parts of the selection, for this build only. */
  readonly parts: readonly ComposerClipboardPart[];
  /** Absent when the selection cannot be pasted back as chips. */
  readonly payload?: ComposerClipboardPayload;
  /** The chips the selection covers, in draft order. */
  readonly references: ComposerFileReference[];
};

/** The text one chip stands for where only plain text can travel. */
function readableInsert(reference: ComposerFileReference): string {
  const plugin = reference.plugin;
  const send = plugin?.kind === "mark" || plugin?.kind === "fold" ? plugin.send : undefined;
  if (typeof send === "string" && send.trim()) return send;
  if (reference.kind === "session") return formatSessionLink(reference.path);
  if (reference.path) return formatFileInsert(reference.path, "file").trim();
  return reference.name;
}

/**
 * The readable text of one draft slice: every chip becomes the text the send
 * path would put there, and two adjacent chips keep the separating space the
 * send serializer gives them so they never fuse into one path.
 */
function readableSlice(
  characters: readonly string[],
  byToken: ReadonlyMap<string, ComposerFileReference>,
): string {
  let text = "";
  for (const [index, character] of characters.entries()) {
    const reference = byToken.get(character);
    if (!reference) {
      text += character;
      continue;
    }
    const next = characters[index + 1];
    text += readableInsert(reference);
    if (next && !/\s/.test(next)) text += " ";
  }
  return text;
}

function boundedName(name: string, fallback: string): string {
  const cleaned = name.replace(CONTROL_CHARACTERS, " ").trim();
  const value = cleaned || fallback;
  return Array.from(value).slice(0, MAX_CLIPBOARD_NAME_CHARS).join("");
}

function boundedSessionId(value: string): string | undefined {
  const id = value.trim();
  if (!id || id.length > MAX_CLIPBOARD_SESSION_ID_CHARS) return undefined;
  return SESSION_ID.test(id) ? id : undefined;
}

function boundedPath(value: string, kind: "session" | "file" | "image"): string | undefined {
  const path = value.trim();
  if (!path) return undefined;
  if (kind === "session") return boundedSessionId(path);
  if (path.length > MAX_CLIPBOARD_PATH_CHARS || CONTROL_CHARACTERS.test(path)) return undefined;
  return path;
}

function boundedMimeType(value: string | undefined): string | undefined {
  const mime = value?.trim() ?? "";
  if (!mime || mime.length > MAX_CLIPBOARD_MIME_CHARS) return undefined;
  return MIME_TYPE.test(mime) ? mime : undefined;
}

/**
 * The minimal reference a payload may describe, or nothing when this clipboard
 * must not restore it as a chip. A plugin chip never travels: its mark, fold,
 * or staged attachment is plugin-owned authority this payload cannot carry.
 */
function portableReference(
  reference: ComposerFileReference,
): ComposerClipboardReference | undefined {
  if (reference.plugin || !reference.token) return undefined;
  const path = boundedPath(reference.path, reference.kind);
  if (!path) return undefined;
  const mimeType = reference.kind === "image" ? boundedMimeType(reference.mimeType) : undefined;
  return {
    kind: reference.kind,
    path,
    name: boundedName(reference.name, path.split(/[\\/]/).at(-1) ?? path),
    ...(mimeType ? { mimeType } : {}),
  };
}

/**
 * Describe a selection of the draft for the clipboard.
 *
 * Reference order is the selection's own order; text stays exact. The plain
 * text is always written, so an application without this format receives
 * readable `@path` text instead of a renderer sentinel.
 */
export function composerClipboardSlice(
  draft: string,
  references: readonly ComposerFileReference[],
  range: { start: number; end: number },
  sessionId: string,
): ComposerClipboardSlice {
  const start = Math.max(0, Math.min(range.start, draft.length));
  const end = Math.max(start, Math.min(range.end, draft.length));
  const text = draft.slice(start, end);
  const byToken = new Map<string, ComposerFileReference>();
  for (const reference of references) {
    if (reference.token) byToken.set(reference.token, reference);
  }
  if (!text) {
    return { start, end, text: "", plainText: "", parts: [], references: [] };
  }
  const characters = Array.from(text);
  const plainText = readableSlice(characters, byToken);
  const segments: ComposerClipboardPart[] = [];
  const placed: ComposerFileReference[] = [];
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    segments.push({ text: buffer });
    buffer = "";
  };
  for (const [index, character] of characters.entries()) {
    const reference = byToken.get(character);
    if (!reference) {
      buffer += character;
      continue;
    }
    const portable = portableReference(reference);
    if (!portable) {
      // A chip this format cannot restore keeps its readable text in place.
      buffer += readableInsert(reference);
      const next = characters[index + 1];
      if (next && !/\s/.test(next)) buffer += " ";
      continue;
    }
    flush();
    segments.push({ ref: portable });
    placed.push(reference);
  }
  flush();
  const payloadable =
    placed.length > 0 &&
    placed.length <= MAX_CLIPBOARD_REFERENCES &&
    segments.length <= MAX_CLIPBOARD_PARTS &&
    Array.from(text).length <= MAX_CLIPBOARD_TEXT_CHARS;
  return {
    start,
    end,
    text,
    plainText,
    parts: segments,
    ...(payloadable
      ? { payload: { v: COMPOSER_CLIPBOARD_VERSION, s: sessionId, parts: segments } }
      : {}),
    references: placed,
  };
}

export type ComposerClipboardParse =
  | { readonly ok: true; readonly payload: ComposerClipboardPayload }
  | {
      readonly ok: false;
      readonly reason: "absent" | "malformed" | "unsupported-version" | "too-large";
    };

/** Exact own keys, so an injected extra field is a refusal rather than a surprise. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function parseReference(value: unknown): ComposerClipboardReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  const kind = ref.kind;
  if (kind !== "file" && kind !== "image" && kind !== "session") return undefined;
  if (typeof ref.path !== "string" || typeof ref.name !== "string") return undefined;
  if (ref.mimeType !== undefined && typeof ref.mimeType !== "string") return undefined;
  if (!hasExactKeys(ref, ref.mimeType === undefined ? ["kind", "path", "name"] : ["kind", "path", "name", "mimeType"])) {
    return undefined;
  }
  const path = boundedPath(ref.path, kind);
  if (!path || CONTROL_CHARACTERS.test(ref.name) || !ref.name.trim()) return undefined;
  const mimeType = boundedMimeType(ref.mimeType);
  if (ref.mimeType !== undefined && !mimeType) return undefined;
  return {
    kind,
    path,
    name: Array.from(ref.name).slice(0, MAX_CLIPBOARD_NAME_CHARS).join(""),
    ...(mimeType ? { mimeType } : {}),
  };
}

/**
 * Read one clipboard payload. Anything this build does not recognize — another
 * version, an unknown field, an unknown reference kind, a path this clipboard
 * cannot safely describe, or a payload past the bounds below — is refused so
 * the caller falls back to the plain text the clipboard also carries.
 */
export function parseComposerClipboard(raw: string | undefined | null): ComposerClipboardParse {
  if (!raw) return { ok: false, reason: "absent" };
  if (raw.length > MAX_CLIPBOARD_PAYLOAD_CHARS) return { ok: false, reason: "too-large" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "malformed" };
  }
  const payload = value as Record<string, unknown>;
  if (payload.v !== COMPOSER_CLIPBOARD_VERSION) {
    return {
      ok: false,
      reason: typeof payload.v === "number" ? "unsupported-version" : "malformed",
    };
  }
  if (
    !hasExactKeys(payload, ["v", "s", "parts"]) ||
    typeof payload.s !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  // An empty owner is the home draft; any other value must name a session.
  const session = payload.s.trim();
  if (session && !boundedSessionId(session)) return { ok: false, reason: "malformed" };
  if (!Array.isArray(payload.parts) || payload.parts.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.parts.length > MAX_CLIPBOARD_PARTS) {
    return { ok: false, reason: "too-large" };
  }
  const parts: ComposerClipboardPart[] = [];
  let textLength = 0;
  let references = 0;
  for (const part of payload.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return { ok: false, reason: "malformed" };
    }
    const entry = part as Record<string, unknown>;
    if (hasExactKeys(entry, ["text"])) {
      if (typeof entry.text !== "string") return { ok: false, reason: "malformed" };
      textLength += Array.from(entry.text).length;
      if (textLength > MAX_CLIPBOARD_TEXT_CHARS) return { ok: false, reason: "too-large" };
      parts.push({ text: entry.text });
      continue;
    }
    if (!hasExactKeys(entry, ["ref"])) return { ok: false, reason: "malformed" };
    const ref = parseReference(entry.ref);
    if (!ref) return { ok: false, reason: "malformed" };
    references += 1;
    if (references > MAX_CLIPBOARD_REFERENCES) return { ok: false, reason: "too-large" };
    parts.push({ ref });
  }
  if (!references) return { ok: false, reason: "malformed" };
  return { ok: true, payload: { v: COMPOSER_CLIPBOARD_VERSION, s: session, parts } };
}

export type ComposerPastePart =
  | { readonly text: string }
  | { readonly ref: ComposerClipboardReference };

export type ComposerPastePlan = {
  readonly parts: ComposerPastePart[];
  readonly referenceCount: number;
};

/**
 * What this draft may restore from a parsed payload. A chip whose own path lives
 * in some session's scratch directory only resolves in the session that owns
 * it, so pasting it into another chat keeps its readable `@path` text instead of
 * a chip the host would refuse to resolve.
 */
export function planComposerPaste(
  payload: ComposerClipboardPayload,
  targetSessionId: string,
): ComposerPastePlan {
  const parts: ComposerPastePart[] = [];
  let referenceCount = 0;
  for (const [index, part] of payload.parts.entries()) {
    if ("text" in part) {
      parts.push({ text: part.text });
      continue;
    }
    const ref = part.ref;
    const resolvesHere =
      ref.kind === "session" ||
      !isPersistedScratchReference(ref.path) ||
      payload.s === targetSessionId;
    if (!resolvesHere) {
      const next = payload.parts[index + 1];
      const nextChar = next ? ("text" in next ? next.text[0] ?? "" : "") : "";
      const inserted = formatFileInsert(ref.path, "file").trim();
      // Two readable paths must not fuse into one, and text keeps its own
      // leading whitespace. A reference follows the word-character rule.
      const needsSpace = next ? ("text" in next ? !/^\s/.test(nextChar) : true) : false;
      parts.push({ text: needsSpace ? `${inserted} ` : inserted });
      continue;
    }
    parts.push({ ref });
    referenceCount += 1;
  }
  return { parts, referenceCount };
}

/**
 * Fresh chip sentinels for one paste: never one the draft already holds and
 * never one this paste placed, so a repeated paste cannot collide.
 */
export function allocateChipTokens(
  count: number,
  usedText: string,
  usedReferences: ReadonlyArray<{ token?: string }>,
): string[] {
  const used = new Set<string>();
  for (const character of Array.from(usedText)) {
    if (isChipTokenChar(character)) used.add(character);
  }
  for (const reference of usedReferences) {
    if (reference.token && isChipTokenChar(reference.token)) used.add(reference.token);
  }
  const tokens: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let token = nextChipToken();
    for (let attempt = 0; used.has(token) && attempt < CHIP_TOKEN_COUNT; attempt += 1) {
      token = nextChipToken();
    }
    if (used.has(token)) throw new Error("the draft already holds every chip token");
    used.add(token);
    tokens.push(token);
  }
  return tokens;
}

/** The draft text and references one plan places with the tokens it was given. */
export function placeComposerPaste(
  plan: ComposerPastePlan,
  tokens: readonly string[],
  targetSessionId: string,
): { inserted: string; references: ComposerFileReference[] } {
  const references: ComposerFileReference[] = [];
  let inserted = "";
  let index = 0;
  for (const part of plan.parts) {
    if ("text" in part) {
      inserted += part.text;
      continue;
    }
    const token = tokens[index];
    index += 1;
    if (!token) throw new Error("composer clipboard placement ran out of chip tokens");
    inserted += token;
    references.push(
      createFileReference(part.ref.path, part.ref.name, targetSessionId, {
        kind: part.ref.kind,
        ...(part.ref.mimeType ? { mimeType: part.ref.mimeType } : {}),
        token,
      }),
    );
  }
  return { inserted, references };
}
