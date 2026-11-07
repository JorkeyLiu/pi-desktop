/**
 * Automatic long-paste text: the one prompt reference that travels as text.
 *
 * A clipboard paste longer than the Composer's inline threshold is written as
 * one `.txt` file and shown as a compact chip, so the draft stays readable. The
 * file is the user's own words, not a document the model is asked to open, so
 * the turn that sends it carries the text itself while the draft, the
 * transcript, and the persisted message keep the compact `@<path>`.
 *
 * The reliable provenance is the storage location, not the file name: only the
 * Composer's automatic-text branch writes into a session's dedicated
 * `scratch/<sessionId>/pasted/text/` directory, and a picker, drop, or clipboard
 * file always lands in `scratch/<sessionId>/pasted/` under whatever name it
 * already had. This module holds the parts both Electron main and the agent
 * runtime need without touching the filesystem: the owned directory name, the
 * byte bound, and the marker parsing/rewriting done on prompt text.

/** Directory under a session scratch root that holds every stored paste file. */
export const PASTED_FILES_DIR = "pasted";

/**
 * Subdirectory of `PASTED_FILES_DIR` that only automatic long-text pastes are
 * written to. A picked, dropped, or pasted file keeps its own name one level up.
 */
export const AUTO_PASTED_TEXT_SUBDIR = "text";

/** Directory, relative to a session's scratch root, that owns auto-pasted text. */
export const AUTO_PASTED_TEXT_DIR = `${PASTED_FILES_DIR}/${AUTO_PASTED_TEXT_SUBDIR}`;

/**
 * Largest auto-pasted text one prompt may carry. It matches the clipboard
 * store's per-file bound, so every paste the store accepted can be sent; a
 * larger file is reported rather than truncated.
 */
export const MAX_AUTO_PASTED_TEXT_BYTES = 64 * 1024 * 1024;

/** One `@path` marker in prompt text, covering the marker text itself. */
export type PromptPathMarker = { path: string; start: number; end: number };

/**
 * Every `@path` marker a prompt carries, in order, including the quoted form
 * the Composer uses for a path with spaces. `@` is an ordinary path character:
 * the serializer quotes only on whitespace, so a data root such as
 * `user@example.com` stays one marker instead of ending at the `@`.
 *
 * The marker text is the reference, not a promise about the file: callers
 * decide which paths they own.
 */
export function findPromptPathMarkers(content: string): PromptPathMarker[] {
  const markers: PromptPathMarker[] = [];
  for (const match of content.matchAll(/@(?:"([^"\n]+)"|([^\s"]+))/g)) {
    const path = (match[1] ?? match[2] ?? "").trim();
    if (!path) continue;
    markers.push({ path, start: match.index, end: match.index + match[0].length });
  }
  return markers;
}

/**
 * Replace the markers a caller resolved with their text, keeping the text
 * around them and every unresolved marker exactly as it was. Replacement runs
 * from the end so earlier offsets stay valid, and a marker's own text is never
 * rescanned — the pasted text may itself contain an `@path`.
 */
export function replacePromptPathMarkers(
  content: string,
  markers: ReadonlyArray<PromptPathMarker>,
  textFor: (marker: PromptPathMarker) => string | undefined,
): string {
  let result = content;
  for (const marker of [...markers].reverse()) {
    const text = textFor(marker);
    if (text === undefined) continue;
    result = result.slice(0, marker.start) + text + result.slice(marker.end);
  }
  return result;
}
