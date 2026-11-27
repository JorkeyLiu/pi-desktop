import { stat } from "node:fs/promises";

export type SaveCopyDeps = {
  isLocalStoredFile: (ref: string) => Promise<boolean>;
  remoteFileWorkspace: (sessionId?: string) => Promise<unknown>;
  optionalWorkspaceRoot: (sessionId?: string) => Promise<string | null>;
  fsExtraRoots: (workspaceRoot: string | null) => Promise<string[]>;
  resolveRealOpenablePath: (
    path: string,
    workspaceRoot: string | null | undefined,
    extraRoots: readonly string[],
  ) => Promise<string | null>;
};

export type SaveCopyTarget = { ok: true; target: string } | { ok: false; reason: string };

/**
 * Containment gate for "save a copy" of a file the panel already previews.
 * Same address rule as open/reveal (workspace, session scratch,
 * attachments), plus a regular-file check. The caller shows a save dialog
 * and copies bytes; this gate never executes the file. Remote sessions may
 * only save locally stored files, never remote workspace paths.
 */
export async function resolveSaveCopyTarget(
  ref: string,
  sessionId: string | undefined,
  deps: SaveCopyDeps,
): Promise<SaveCopyTarget> {
  const requested = String(ref ?? "").trim();
  if (!requested) return { ok: false, reason: "missing path" };
  const remote = await deps.remoteFileWorkspace(sessionId);
  if (remote && !(await deps.isLocalStoredFile(requested))) {
    return { ok: false, reason: "remote paths cannot be saved on this computer" };
  }
  const workspaceRoot = await deps.optionalWorkspaceRoot(sessionId);
  const target = await deps.resolveRealOpenablePath(
    requested,
    workspaceRoot,
    await deps.fsExtraRoots(workspaceRoot),
  );
  if (!target) return { ok: false, reason: "path outside allowed roots" };
  try {
    if (!(await stat(target)).isFile()) return { ok: false, reason: "not a file" };
  } catch {
    return { ok: false, reason: "not a file" };
  }
  return { ok: true, target };
}
