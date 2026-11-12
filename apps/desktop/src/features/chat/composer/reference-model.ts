import type { ComposerPluginPart } from "../../../lib/composer-smart-stop";
import type { ComposerFileReference } from "./model";

/** A draft reference that names a file family rather than a path. */
export function isImageFilePath(path: string): boolean {
  return /\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(path);
}

/** A reference a plugin put in the draft that is text, not a file: a mark or the fold. */
export function isPluginMark(
  reference: { plugin?: ComposerPluginPart } | undefined,
): boolean {
  const kind = reference?.plugin?.kind;
  return kind === "mark" || kind === "fold";
}

/** Only a plain text file expands into editable draft text when activated. */
export function isEditableTextReference(reference: ComposerFileReference): boolean {
  if (isPluginMark(reference)) return false;
  return reference.mimeType?.toLowerCase() === "text/plain" || /\.txt$/i.test(reference.name);
}

/**
 * The draft stores one private-use sentinel per reference, so a reference is one
 * editable character regardless of how long its visible label is. Every
 * sentinel lives in the Unicode private-use area, which no filename or prompt
 * character claims, and a fresh one is handed out per placed reference.
 */
export const CHIP_TOKEN_BASE = 0xe000;
export const CHIP_TOKEN_END = 0xf8ff;
/** How many distinct chip sentinels exist; a draft may hold at most this many. */
export const CHIP_TOKEN_COUNT = CHIP_TOKEN_END - CHIP_TOKEN_BASE + 1;
let chipTokenSequence = 0;

export function nextChipToken(): string {
  chipTokenSequence = (chipTokenSequence + 1) % CHIP_TOKEN_COUNT;
  return String.fromCodePoint(CHIP_TOKEN_BASE + chipTokenSequence);
}

export function isChipTokenChar(char: string): boolean {
  if (char.length !== 1) return false;
  const code = char.codePointAt(0) ?? 0;
  return code >= CHIP_TOKEN_BASE && code <= CHIP_TOKEN_END;
}
