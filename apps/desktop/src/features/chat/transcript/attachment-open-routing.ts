import type { MessageAttachment } from "@pi-desktop/shared";

export type AttachmentOpenPosition = { line?: number; column?: number };

/**
 * Route a transcript attachment click: a ref the message lists as a viewable
 * image opens in the shared image dialog at its position; everything else
 * keeps the files-tab path. Both transcript surfaces share this so the split
 * cannot drift between the main row and the subagent rows.
 */
export function openRoutedAttachment(args: {
  viewable: MessageAttachment[];
  path: string;
  baseDir?: string;
  mimeType?: string;
  position?: AttachmentOpenPosition;
  openViewer: (attachments: MessageAttachment[], index: number) => void;
  openInFilesTab: (
    path: string,
    baseDir?: string,
    mimeType?: string,
    position?: AttachmentOpenPosition,
  ) => void;
}): void {
  const index = args.viewable.findIndex((attachment) => attachment.ref === args.path);
  if (index >= 0) args.openViewer(args.viewable, index);
  else args.openInFilesTab(args.path, args.baseDir, args.mimeType, args.position);
}
