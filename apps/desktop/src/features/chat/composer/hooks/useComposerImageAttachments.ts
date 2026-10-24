import { useCallback, useMemo, useRef, useState } from "react";
import type { AgentPromptAttachment, ComposerPastedFile } from "@pi-desktop/shared";
import { api } from "../../../../lib/api";
import type { ComposerFileReference } from "../model";

/**
 * Images staged on a surface that sends them as structured attachments.
 *
 * The main composer's attachment controller is bound to its persisted draft
 * store, its chip editor, and its queue; this one owns only the staged image
 * list so a surface with its own submission path (a subagent's steer or
 * continuation) can offer pick/paste/preview/remove without copying that
 * workflow. Paths and MIME types are the host's own: every image travels
 * through the same `composerPasteFiles`/`composerImportFiles` staging as the
 * main composer, so nothing here reads image bytes.
 *
 * The list is bound to one session. A pick or paste that resolves after the
 * user moved to another session is dropped rather than staged into the new
 * conversation, and the surface's own reset clears the list on a tab switch.
 */
export type ComposerImageAttachmentError =
  /** The host staged no image (a non-image file was picked or pasted). */
  | "not-an-image"
  /** The surface cannot attach right now: read-only, blocked, or no session. */
  | "unavailable"
  /** The host refused the staging call; `detail` carries its reason. */
  | "failed";

export type ComposerImageAttachmentFailure = {
  code: ComposerImageAttachmentError;
  detail?: string;
};

export type ComposerImageAttachments = {
  /** Staged images in the order the user added them. */
  references: ComposerFileReference[];
  /** The same list as the request field a send carries. */
  attachments: AgentPromptAttachment[];
  busy: boolean;
  error: ComposerImageAttachmentFailure | null;
  pick: () => Promise<string[]>;
  /**
   * Stage clipboard files. Returns false when the paste carries no file at
   * all, so the caller can let text paste through unchanged.
   */
  paste: (files: readonly File[]) => Promise<boolean>;
  remove: (id: string) => void;
  /** Drop the ids a successful send consumed; later additions stay. */
  discard: (ids: readonly string[]) => void;
  /** Drop everything (tab or session switch). */
  reset: () => void;
  dismissError: () => void;
};

const IMAGE_KIND = "image" as const;

function isImageFile(file: { kind?: string; mimeType?: string; name?: string }): boolean {
  if (file.kind === "image") return true;
  if (file.mimeType?.toLowerCase().startsWith("image/")) return true;
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(file.name ?? "");
}

export function useComposerImageAttachments({
  sessionId,
  blocked,
}: {
  /** The session this surface writes to; `null` disables attaching. */
  sessionId: string | null;
  /** Read-only session, missing permission, or a send already in flight. */
  blocked: boolean;
}): ComposerImageAttachments {
  const [references, setReferences] = useState<ComposerFileReference[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ComposerImageAttachmentFailure | null>(null);
  const inFlight = useRef(false);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  /** Stage what the host returned, but only for the session that asked. */
  const stage = useCallback((files: readonly ComposerPastedFile[], owner: string): string[] => {
    if (sessionRef.current !== owner) return [];
    const images = files.filter((file) => isImageFile(file));
    if (!images.length) {
      setError({ code: "not-an-image" });
      return [];
    }
    const staged = images.map((file) => ({
      id: crypto.randomUUID(),
      sessionId: owner,
      path: file.path,
      name: file.name,
      kind: IMAGE_KIND,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    }));
    setReferences((current) => [...current, ...staged]);
    return staged.map((reference) => reference.id);
  }, []);

  const run = useCallback(
    async (owner: string, call: () => Promise<ComposerPastedFile[]>): Promise<string[]> => {
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        return stage(await call(), owner);
      } catch (failure) {
        if (sessionRef.current === owner) {
          setError({
            code: "failed",
            detail: failure instanceof Error ? failure.message : String(failure),
          });
        }
        return [];
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [stage],
  );

  const pick = useCallback(async (): Promise<string[]> => {
    if (inFlight.current) return [];
    const owner = sessionRef.current;
    if (blocked || !owner) {
      setError({ code: "unavailable" });
      return [];
    }
    // The picker itself is image-only: this surface can send nothing else, so
    // the native dialog states the restriction before a file is chosen.
    const picked = await api.pickPhotos();
    if (picked.canceled || !picked.token) return [];
    return run(owner, async () => (await api.importFiles(owner, picked.token as string)).files);
  }, [blocked, run]);

  const paste = useCallback(
    async (files: readonly File[]): Promise<boolean> => {
      if (!files.length) return false;
      if (inFlight.current) return true;
      const owner = sessionRef.current;
      if (blocked || !owner) {
        setError({ code: "unavailable" });
        return true;
      }
      const payload = await Promise.all(
        files.map(async (file) => ({
          name: file.name || undefined,
          mimeType: file.type || undefined,
          data: await file.arrayBuffer(),
        })),
      );
      await run(owner, async () => (await api.pasteFiles(owner, payload)).files);
      return true;
    },
    [blocked, run],
  );

  const remove = useCallback((id: string) => {
    setReferences((current) => current.filter((reference) => reference.id !== id));
  }, []);

  const discard = useCallback((ids: readonly string[]) => {
    if (!ids.length) return;
    const sent = new Set(ids);
    setReferences((current) => current.filter((reference) => !sent.has(reference.id)));
  }, []);

  const reset = useCallback(() => {
    setReferences([]);
    setError(null);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  const attachments = useMemo(
    () =>
      references.map((reference) => ({
        path: reference.path,
        name: reference.name,
        kind: IMAGE_KIND,
        ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
      })),
    [references],
  );

  return { references, attachments, busy, error, pick, paste, remove, discard, reset, dismissError };
}
