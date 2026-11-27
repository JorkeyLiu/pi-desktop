import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageAttachment } from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import type { ImageViewerItem, ImageViewerSource } from "../../../components/ImageViewer";

export type MessageImageViewerItem = ImageViewerItem & {
  ref: string;
  mimeType?: string;
};

export type MessageImageViewerDialog = {
  items: MessageImageViewerItem[];
  index: number;
  source: ImageViewerSource;
};

/**
 * Open a sent message's viewable attachments in the shared image dialog.
 * Bytes travel through the same contained `fsReadImageDataUrl` bridge the
 * hover thumbnail uses; only the dialog's current image is read.
 */
export function useMessageImageViewer() {
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((s) => paneSessionId || s.activeSessionId);
  const [selection, setSelection] = useState<{ items: MessageImageViewerItem[]; index: number } | null>(null);
  const [generation, setGeneration] = useState(0);
  const restoreFocusRef = useRef<() => void>(() => {});
  const restoreFocus = useCallback(() => restoreFocusRef.current(), []);

  const open = useCallback((attachments: MessageAttachment[], index: number) => {
    const focused = document.activeElement;
    restoreFocusRef.current = () => {
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
    setSelection({
      items: attachments.map((attachment) => ({
        id: `${attachment.ref}::${attachment.name}`,
        name: attachment.name,
        ref: attachment.ref,
        mimeType: attachment.mimeType,
      })),
      index,
    });
  }, []);
  const close = useCallback(() => setSelection(null), []);
  const select = useCallback((index: number) => {
    setSelection((current) => (current ? { items: current.items, index } : current));
  }, []);
  const retry = useCallback(() => setGeneration((current) => current + 1), []);

  const current = selection ? selection.items[selection.index] : undefined;
  const [source, setSource] = useState<ImageViewerSource>({ status: "loading" });
  useEffect(() => {
    if (!current) return;
    let alive = true;
    setSource({ status: "loading" });
    const request = api.fsReadImageDataUrl(current.ref, current.mimeType, sessionId ?? undefined);
    void request
      .then(
        (result) => {
          if (!alive) return;
          setSource(
            result.kind === "image" && result.dataUrl
              ? { status: "ready", src: result.dataUrl }
              : { status: "error" },
          );
        },
        () => {
          if (alive) setSource({ status: "error" });
        },
      );
    return () => {
      alive = false;
    };
  }, [current?.ref, current?.mimeType, sessionId, generation, selection?.index]);

  const dialog: MessageImageViewerDialog | null = selection
    ? { items: selection.items, index: selection.index, source }
    : null;
  return { dialog, open, select, close, retry, restoreFocus };
}
