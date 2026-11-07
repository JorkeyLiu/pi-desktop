/** Session-root-confined attachment hydration for restored user messages. */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  AUTO_PASTED_TEXT_DIR,
  findPromptPathMarkers,
  formatFileInsert,
  isSvgAttachment,
  MAX_AUTO_PASTED_TEXT_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINED_IMAGE_HISTORY_BYTES,
  replacePromptPathMarkers,
  SVG_MIME_TYPE,
  type MessageAttachment,
  type UiMessage,
} from "@pi-desktop/shared";

type ResolvedAttachment = {
  attachment: MessageAttachment;
  canonicalPath?: string;
  size?: number;
  fallbackPath?: string;
  inlined?: boolean;
};

export type AttachmentHistoryContext = {
  scratchDir?: string;
  projectPath?: string;
  attachmentsDir?: string;
  supportsVision: boolean;
  /**
   * Maximum aggregate raw image bytes inlined during history restoration
   * (default: 30 MB, hard-capped by MAX_INLINED_IMAGE_HISTORY_BYTES).
   * The newest attachments are considered first; older ones use the safe path fallback.
   */
  maxInlinedImageBytes?: number;
};

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function replayedAttachmentPath(
  params: AttachmentHistoryContext,
  attachment: NonNullable<UiMessage["attachments"]>[number],
  source: string,
): Promise<string> {
  if (!params.scratchDir || !attachment.ref.startsWith("attachments/")) {
    return source;
  }
  const root = resolve(params.scratchDir, "replayed");
  await mkdir(root, { recursive: true });
  const safeName =
    attachment.name.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "attachment";
  const suffix = createHash("sha256")
    .update(attachment.ref)
    .digest("hex")
    .slice(0, 12);
  const target = resolve(root, `${safeName}-${suffix}`);
  try {
    await copyFile(source, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  return target;
}

/** Read only the size already admitted by the history budget. */
async function readFileAtRecordedSize(
  path: string,
  expectedSize: number,
): Promise<Buffer | undefined> {
  const file = await open(path, "r");
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size !== expectedSize) return undefined;
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        expectedSize - offset,
        offset,
      );
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

/**
 * The compact text a restored message was saved with names the file one
 * automatic long paste was written to. Put that file's text back so a resumed
 * conversation carries the user's own words, exactly as the turn that sent them
 * did.
 *
 * The owned `pasted/text/` directory is the provenance, not the file name: a
 * picked, dropped, or pasted file keeps its own name under `pasted/`, so it is
 * never read back here even when it is named like a paste. Restore stays
 * best-effort like the rest of history hydration — a swept session scratch
 * directory, a deleted file, an oversized file, or a failed read leaves the
 * compact text the transcript already holds. The send path is where a paste
 * that cannot be carried fails visibly.
 */
async function restoreAutoPastedText(
  params: AttachmentHistoryContext,
  content: string,
): Promise<string> {
  if (!params.scratchDir) return content;
  const root = resolve(params.scratchDir, AUTO_PASTED_TEXT_DIR);
  const markers = findPromptPathMarkers(content).filter((marker) => {
    if (!isAbsolute(marker.path)) return false;
    // Ownership is decided by the unresolved path: a typed `@path` or a manual
    // attachment outside the owned directory stays the reference it was.
    return pathInside(root, resolve(marker.path));
  });
  if (!markers.length) return content;
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return content;
  }
  const restored = new Map<string, string>();
  for (const marker of markers) {
    if (restored.has(marker.path)) continue;
    try {
      const canonical = await realpath(resolve(marker.path));
      if (!pathInside(canonicalRoot, canonical)) continue;
      const size = (await stat(canonical)).size;
      if (size > MAX_AUTO_PASTED_TEXT_BYTES) continue;
      const bytes = await readFileAtRecordedSize(canonical, size);
      if (!bytes) continue;
      restored.set(marker.path, bytes.toString("utf8"));
    } catch {
      // The compact text stays when the paste file cannot be read back.
    }
  }
  return replacePromptPathMarkers(content, markers, (marker) =>
    restored.get(marker.path),
  );
}

export async function hydrateAttachmentHistory(
  history: UiMessage[],
  params: AttachmentHistoryContext,
): Promise<UiMessage[]> {
  const supportsVision = params.supportsVision;
  const requestedBudget = params.maxInlinedImageBytes;
  const maxInlinedImageBytes =
    requestedBudget === undefined || !Number.isFinite(requestedBudget)
      ? MAX_INLINED_IMAGE_HISTORY_BYTES
      : Math.min(
          MAX_INLINED_IMAGE_HISTORY_BYTES,
          Math.max(0, Math.floor(requestedBudget)),
        );
  const roots = [
    params.scratchDir,
    params.projectPath,
    params.attachmentsDir,
  ].filter((value): value is string => Boolean(value));
  const canonicalRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return undefined;
      }
    }),
  );

  const resolveAttachment = async (
    sourceAttachment: NonNullable<UiMessage["attachments"]>[number],
  ): Promise<ResolvedAttachment> => {
    // History from the host never contains transient data. Strip stale in-memory
    // payloads as well so a caller cannot bypass the aggregate hydration budget.
    const cleanAttachment: MessageAttachment = {
      ...sourceAttachment,
      data: undefined,
    };
    const attachment: MessageAttachment = isSvgAttachment(
      sourceAttachment.mimeType,
      sourceAttachment.name,
      sourceAttachment.ref,
    )
      ? { ...cleanAttachment, kind: "file", mimeType: SVG_MIME_TYPE }
      : cleanAttachment;
    const ref = attachment.ref.trim();
    if (!ref) return { attachment };
    const candidate =
      ref.startsWith("attachments/") && params.attachmentsDir
        ? resolve(params.attachmentsDir, ref.slice("attachments/".length))
        : isAbsolute(ref)
          ? resolve(ref)
          : params.projectPath
            ? resolve(params.projectPath, ref)
            : undefined;
    if (!candidate) return { attachment };
    try {
      const canonical = await realpath(candidate);
      if (!canonicalRoots.some((root) => root && pathInside(root, canonical))) {
        return { attachment };
      }
      const size = (await stat(canonical)).size;
      const canInline =
        supportsVision &&
        attachment.kind === "image" &&
        size <= MAX_INLINE_IMAGE_BYTES;
      if (canInline) return { attachment, canonicalPath: canonical, size };
      return {
        attachment,
        fallbackPath: await replayedAttachmentPath(
          params,
          attachment,
          canonical,
        ),
      };
    } catch {
      return { attachment };
    }
  };

  const resolvedHistory = await Promise.all(
    history.map(async (message) => {
      if (message.role !== "user" || !message.attachments?.length) return undefined;
      return Promise.all(message.attachments.map(resolveAttachment));
    }),
  );

  // Allocate the byte budget in reverse transcript order, then reverse attachment
  // order within a message. This preserves every image when the history fits while
  // keeping the most recent visual context when the aggregate exceeds the cap.
  let remainingBytes = maxInlinedImageBytes;
  const selectedForInlining: ResolvedAttachment[] = [];
  for (let messageIndex = resolvedHistory.length - 1; messageIndex >= 0; messageIndex--) {
    const resolved = resolvedHistory[messageIndex];
    if (!resolved) continue;
    for (let attachmentIndex = resolved.length - 1; attachmentIndex >= 0; attachmentIndex--) {
      const item = resolved[attachmentIndex];
      if (
        !item?.canonicalPath ||
        item.size === undefined ||
        item.size > remainingBytes
      ) {
        continue;
      }
      remainingBytes -= item.size;
      selectedForInlining.push(item);
    }
  }

  await Promise.all(
    selectedForInlining.map(async (item) => {
      try {
        const bytes = await readFileAtRecordedSize(item.canonicalPath!, item.size!);
        if (!bytes) return;
        item.attachment = {
          ...item.attachment,
          data: bytes.toString("base64"),
        };
        item.inlined = true;
      } catch {
        // A failed transient read should not prevent the remaining history restoring.
      }
    }),
  );

  const fallbackTasks: Promise<void>[] = [];
  for (const resolved of resolvedHistory) {
    if (!resolved) continue;
    for (const item of resolved) {
      if (!item.canonicalPath || item.inlined) continue;
      fallbackTasks.push(
        (async () => {
          try {
            item.fallbackPath = await replayedAttachmentPath(
              params,
              item.attachment,
              item.canonicalPath!,
            );
          } catch {
            // Path fallback is best-effort, matching the existing restore contract.
          }
        })(),
      );
    }
  }
  await Promise.all(fallbackTasks);

  return Promise.all(
    history.map(async (message, index) => {
      // A pasted text travels as prompt content, not as an attachment, so its
      // message restores its text whether or not it carried one.
      const restored =
        message.role === "user"
          ? {
              ...message,
              content: await restoreAutoPastedText(params, message.content),
            }
          : message;
      const resolved = resolvedHistory[index];
      if (!resolved) return restored;
      const fallbackPaths = resolved
        .filter(
          (item) =>
            Boolean(item.fallbackPath) &&
            // A path the message already names at the user's own position needs no
            // second copy at the end; a rewritten replay copy still travels.
            formatFileInsert(item.fallbackPath!, "file").trim() !== item.attachment.inlinePath,
        )
        .map((item) => formatFileInsert(item.fallbackPath!, "file"))
        .join("")
        .trim();
      const content = restored.content.trim()
        ? fallbackPaths
          ? `${restored.content}\n${fallbackPaths}`
          : restored.content
        : fallbackPaths;
      return {
        ...restored,
        content,
        attachments: resolved.map((item) => item.attachment),
      };
    }),
  );
}
