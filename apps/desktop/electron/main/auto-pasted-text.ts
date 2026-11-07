/**
 * Long pastes the Composer converted into a text file, restored into a prompt.
 *
 * A clipboard paste longer than the Composer's inline threshold is saved as a
 * `.txt` under the session's dedicated `scratch/<sessionId>/pasted/text/`
 * directory and shown as one compact chip: the draft, the transcript, and the
 * persisted message keep `@<path>` and the chip stays readable. The file is the
 * user's own words, though, not a document the model is asked to open, so the
 * turn that sends it carries the text instead of the path — no Read step, no
 * dependency on what the runtime may open.
 *
 * The owned directory is the provenance: only the Composer's automatic-text
 * branch writes there, and a picked, dropped, or clipboard file always keeps its
 * own name under `pasted/` instead. A marker outside that directory — a typed
 * `@path`, a manual attachment, a same-named workspace file — is therefore never
 * read, and a marker inside it that cannot be read fails the send with a coded
 * error instead of putting a path where the user's words belong.
 */
import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AUTO_PASTED_TEXT_DIR,
  ErrorCodes,
  findPromptPathMarkers,
  MAX_AUTO_PASTED_TEXT_BYTES,
  replacePromptPathMarkers,
  type PromptPathMarker,
} from "@pi-desktop/shared";

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function pastedTextError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/** The directory that owns this session's automatic long-paste text. */
function autoPastedTextRoot(dataRoot: string, sessionId: string): string {
  return join(dataRoot, "scratch", sessionId, AUTO_PASTED_TEXT_DIR);
}

/** `NAME`, `ENOENT`, or `undefined`, without turning a real failure into a no-op. */
function errorCodeOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function missingPaste(ref: string, detail: string): Error {
  return pastedTextError(
    ErrorCodes.NOT_FOUND,
    `The pasted text ${ref} is no longer available (${detail}); the message was not sent.`,
  );
}

/**
 * The bytes a paste file held when it was measured. `undefined` means the file
 * changed size while this turn was reading it: a prompt that carries half a
 * paste would answer a request the user never made.
 */
async function readExactText(
  path: string,
  size: number,
): Promise<string | undefined> {
  const file = await open(path, fsConstants.O_RDONLY);
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size !== size) return undefined;
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    // The paste was written from the clipboard as UTF-8; decoding it back with
    // the same encoding keeps every character, including the Unicode the draft
    // never showed.
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
}

/**
 * The exact text of one auto-pasted file. A file this turn must carry but cannot
 * read is never skipped: the caller would otherwise send a path in place of the
 * words. Every failure below exits through a coded error.
 */
async function readAutoPastedText(
  canonicalRoot: string,
  ref: string,
): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(ref);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw missingPaste(ref, "the file is gone");
    }
    throw pastedTextError(
      ErrorCodes.NOT_FOUND,
      `The pasted text ${ref} could not be resolved (${code ?? "unknown error"}); the message was not sent.`,
    );
  }
  // A marker inside the owned directory may still be a symlink that leaves it.
  if (!pathInside(canonicalRoot, canonical)) {
    throw pastedTextError(
      ErrorCodes.PATH_OUTSIDE_WORKSPACE,
      `The pasted text ${ref} resolves outside this session's paste directory; the message was not sent.`,
    );
  }
  let size: number;
  try {
    const info = await stat(canonical);
    if (!info.isFile()) throw missingPaste(ref, "it is not a file");
    size = info.size;
  } catch (error) {
    if ((error as { errorCode?: string })?.errorCode) throw error;
    throw missingPaste(ref, errorCodeOf(error) ?? "it could not be read");
  }
  if (size > MAX_AUTO_PASTED_TEXT_BYTES) {
    throw pastedTextError(
      ErrorCodes.PAYLOAD_TOO_LARGE,
      `The pasted text ${ref} is ${size} bytes; a pasted text sent as prompt content is limited to ${MAX_AUTO_PASTED_TEXT_BYTES} bytes.`,
    );
  }
  let text: string | undefined;
  try {
    text = await readExactText(canonical, size);
  } catch (error) {
    throw missingPaste(ref, errorCodeOf(error) ?? "it could not be read");
  }
  if (text === undefined) {
    throw pastedTextError(
      ErrorCodes.NOT_FOUND,
      `The pasted text ${ref} changed while the message was prepared; the message was not sent.`,
    );
  }
  return text;
}

/**
 * Prompt content with every auto-pasted text file it names replaced by that
 * file's exact text. A prompt without such a marker is returned unchanged, and
 * the compact `@path` text the message keeps is never touched: only the copy
 * this turn hands the model is rewritten.
 *
 * A marker inside the owned directory is a promise this prompt carries that
 * paste, so nothing about it degrades quietly — a swept session scratch
 * directory, a deleted file, an oversized file, and an I/O failure all throw a
 * coded error. Markers outside the directory stay untouched references.
 */
export async function hydrateAutoPastedText(
  dataRoot: string,
  sessionId: string,
  content: string,
): Promise<string> {
  const root = autoPastedTextRoot(dataRoot, sessionId);
  const markers: PromptPathMarker[] = [];
  for (const marker of findPromptPathMarkers(content)) {
    if (!isAbsolute(marker.path)) continue;
    // Ownership is decided by the unresolved path: a manual attachment or a
    // same-named workspace file outside the owned directory stays a reference,
    // and a symlink placed inside it is rejected after resolution below.
    if (!pathInside(root, resolve(marker.path))) continue;
    markers.push(marker);
  }
  if (!markers.length) return content;
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    const code = errorCodeOf(error);
    throw missingPaste(
      root,
      code === "ENOENT"
        ? "this session's paste directory is gone"
        : `the paste directory could not be resolved (${code ?? "unknown error"})`,
    );
  }
  const restored = new Map<string, string>();
  for (const marker of markers) {
    if (restored.has(marker.path)) continue;
    restored.set(marker.path, await readAutoPastedText(canonicalRoot, marker.path));
  }
  return replacePromptPathMarkers(content, markers, (marker) =>
    restored.get(marker.path),
  );
}
