/**
 * Renderer-side availability mirror for the main-process save-a-copy gate
 * (`electron/main/save-copy-target.ts`). Remote sessions may only save
 * locally stored files, and the only locally stored refs the renderer can
 * name without main are content-addressed `attachments/<sha256>` blobs —
 * the same blob rule main applies first. Anything else on a remote session
 * shows the unavailable explanation instead of a button that would fail.
 */

const ATTACHMENT_BLOB_RE = /^attachments\/[0-9a-f]{64}$/i;

/** Content-addressed paste/upload blobs: `attachments/<sha256>`. */
export function isLocallyStoredAttachmentRef(path: string): boolean {
  return ATTACHMENT_BLOB_RE.test(String(path ?? "").trim().replace(/\\/g, "/"));
}

/**
 * Whether the files tab may offer "save a copy" for a selected path.
 * Local sessions resolve through main containment; remote sessions are
 * limited to locally stored attachment blobs.
 */
export function canSaveCopySelected(
  remote: unknown,
  path: string | null | undefined,
): boolean {
  if (!path) return false;
  return !remote || isLocallyStoredAttachmentRef(path);
}
