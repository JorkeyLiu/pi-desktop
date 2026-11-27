 import { copyFile, stat } from "node:fs/promises";
import { ErrorCodes } from "@pi-desktop/shared";
import {
  readUserLinkFile,
  resolveUserLinkTarget,
} from "@pi-desktop/host-runtime";

export type UserLinkDeps = {
  remoteFileWorkspace: (sessionId?: string) => Promise<unknown>;
};

/**
 * Session gate for the user-link file channels (ADR 0342). A remote-owned
 * session rejects before any filesystem access and never falls back to
 * reading the local disk: remote paths name files on the remote host, so
 * there is no local path with the same name to read.
 */
export async function assertLocalUserLinkSession(
  sessionId: string | undefined,
  deps: UserLinkDeps,
): Promise<void> {
  const remote = await deps.remoteFileWorkspace(sessionId);
  if (remote) {
    throw Object.assign(
      new Error("remote sessions cannot open local user-link files on this computer"),
      { errorCode: ErrorCodes.INVALID_ARGUMENT },
    );
  }
}

/**
 * Read one user-clicked absolute file for in-app preview. The source path is
 * validated by the same realpath-plus-regular-file gate the save-a-copy
 * flow uses below — the renderer never supplies bytes.
 */
export async function readUserLink(
  ref: string,
  sessionId: string | undefined,
  deps: UserLinkDeps,
  mimeType?: string,
) {
  await assertLocalUserLinkSession(sessionId, deps);
  return readUserLinkFile(ref, mimeType);
}

export type UserLinkCopyTarget =
  | { ok: true; target: string }
  | { ok: false; reason: string };

/**
 * Resolve the save-a-copy source for a user-clicked absolute file. The
 * caller shows the OS save dialog and copies bytes; this gate re-validates
 * the source through the same regular-file check as the read path and never
 * trusts renderer-supplied bytes.
 */
export async function resolveUserLinkCopyTarget(
  ref: string,
  sessionId: string | undefined,
  deps: UserLinkDeps,
): Promise<UserLinkCopyTarget> {
  const requested = String(ref ?? "").trim();
  if (!requested) return { ok: false, reason: "missing path" };
  const remote = await deps.remoteFileWorkspace(sessionId);
  if (remote) {
    return { ok: false, reason: "remote sessions cannot save local user-link files on this computer" };
  }
  let target: string;
  try {
    target = await resolveUserLinkTarget(requested);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "not a file" };
  }
  // `resolveUserLinkTarget` canonicalizes through `realpath` but does not
  // itself take the open-fd `fstat` verdict the read path takes, so re-check
  // here: a copy must never follow a path the read gate would refuse.
  try {
    if (!(await stat(target)).isFile()) return { ok: false, reason: "not a file" };
  } catch {
    return { ok: false, reason: "not a file" };
  }
  return { ok: true, target };
}

/** Copy a validated user-link target to the user's picked destination. */
export async function copyUserLinkTarget(target: string, destination: string): Promise<void> {
  await copyFile(target, destination);
}
