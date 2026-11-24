import type {
  ComposerPasteFile,
  ComposerPastedFile,
} from "@pi-desktop/shared";
import { allocateChipTokens } from "./clipboard";
import { createFileReference } from "./editor";
import type { ComposerFileReference } from "./model";
import type { ComposerDraftFileReference } from "../../../lib/composer-smart-stop";

/**
 * Draft-independent attachment intake shared by the main composer and the
 * inline user-message editor.
 *
 * The async host staging rules (clipboard file bytes, oversized text filed as
 * `auto-text`, picked files) and the chip-insertion rules (fresh sentinel per
 * staged file, caret-anchored insert) live here exactly once. The two surfaces
 * keep their own lifecycles — the main composer's session-owned draft cache
 * and handoff guards, the editor's local state and owner-session guard — and
 * both reach the host through the same `api.pasteFiles` / `api.importFiles`
 * calls with payloads built below.
 */

/** Clipboard routing both surfaces apply before any host staging. */
export type ClipboardIntakeKind = "files" | "large-text" | "plain-text";

/**
 * Route clipboard content the same way on both surfaces: native files win,
 * except Word-style image-plus-text copies which stay editable text; an
 * oversized text-only paste is filed so the prompt keeps the bytes.
 */
export function classifyClipboardIntake({
  text,
  files,
  largePasteThreshold,
  resolveNativePath,
}: {
  text: string;
  files: readonly File[];
  largePasteThreshold: number;
  resolveNativePath: (file: File) => string | null;
}): ClipboardIntakeKind {
  const hasFiles = files.length > 0 && !preferIntakeText(text, files, resolveNativePath);
  if (hasFiles) return "files";
  return Array.from(text).length > largePasteThreshold ? "large-text" : "plain-text";
}

/**
 * Word copies text plus a synthesized image of the same selection: keep that
 * text editable, but preserve explicit native files and image-only pastes.
 * (Mirrors the composer editor's own rule so both surfaces agree.)
 */
function preferIntakeText(
  text: string,
  files: readonly File[],
  resolveNativePath: (file: File) => string | null,
): boolean {
  return (
    text.trim().length > 0 &&
    files.length > 0 &&
    files.every(
      (file) =>
        file.type.toLowerCase().startsWith("image/") && !resolveNativePath(file),
    )
  );
}

/** Renderer file bytes for one `api.pasteFiles` staging call. */
export async function clipboardFilePayload(
  files: readonly File[],
): Promise<ComposerPasteFile[]> {
  return Promise.all(
    files.map(async (file) => ({
      name: file.name || undefined,
      mimeType: file.type || undefined,
      data: await file.arrayBuffer(),
    })),
  );
}

/**
 * File one oversized clipboard text paste so the prompt keeps its bytes: the
 * paste is the user's own words, filed in the session's owned auto-text
 * directory, which is what lets the send and history paths carry its text
 * instead of a path.
 */
export function largeTextPayload(text: string): ComposerPasteFile[] {
  const bytes = new TextEncoder().encode(text);
  return [
    {
      name: `pasted-text-${crypto.randomUUID().slice(0, 8)}.txt`,
      mimeType: "text/plain",
      recordHistory: true,
      origin: "auto-text" as const,
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    },
  ];
}

/**
 * Place staged host files as chips in a draft: one fresh sentinel per file so
 * a repeated stage never collides with the draft it lands in, inserted where
 * the caret (or selection) sits. Pure draft math — the caller owns painting
 * and session guards.
 */
export function insertStagedReferences({
  text,
  references,
  start,
  end,
  staged,
  sessionId,
  rebindSessionId,
}: {
  text: string;
  references: readonly (ComposerFileReference | ComposerDraftFileReference)[];
  start: number;
  end: number;
  staged: readonly ComposerPastedFile[];
  sessionId: string;
  /**
   * Rebind every retained reference to a new owner (the main composer's
   * home→session materialization). Omit to keep retained references — and any
   * caller-owned fields on them — untouched by identity.
   */
  rebindSessionId?: string;
}): { text: string; references: ComposerFileReference[]; caret: number } {
  const tokens = allocateChipTokens(staged.length, text, references);
  const chips = staged.map((file, index) => {
    const token = tokens[index];
    if (!token) throw new Error("attachment staging ran out of chip tokens");
    return {
      token,
      reference: createFileReference(file.path, file.name, sessionId, {
        kind: file.kind,
        mimeType: file.mimeType,
        token,
      }),
    };
  });
  const inserted = chips.map((chip) => chip.token).join("");
  const nextText = text.slice(0, start) + inserted + text.slice(end);
  const retained = references.filter(
    (reference) => !reference.token || nextText.includes(reference.token),
  );
  const rebound = rebindSessionId
    ? retained.map((reference) =>
        createFileReference(reference.path, reference.name, rebindSessionId, reference),
      )
    : (retained as ComposerFileReference[]);
  const nextReferences = [...rebound, ...chips.map((chip) => chip.reference)];
  return { text: nextText, references: nextReferences, caret: start + inserted.length };
}
