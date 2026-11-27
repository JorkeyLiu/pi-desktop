import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronLeft, IconChevronRight, IconClose, IconDownload, IconMinus, IconPlus } from "./icons";
import { useBlockingOverlay } from "../lib/blocking-overlay";
import { portalToBody } from "../lib/portal-visibility";
import { useImagePreviewPan } from "./useImagePreviewPan";
import "../styles/composer-image-preview.css";

export type ImageViewerItem = {
  id: string;
  name: string;
};

export type ImageViewerSource =
  | { status: "ready"; src: string }
  | { status: "loading" }
  | { status: "error" };

/**
 * The one image dialog: the composer and sent-message attachments open
 * through this contract. Callers resolve bytes (draft data URLs or contained
 * `fsReadImageDataUrl` reads) and hand the current source in; the dialog
 * owns natural size, fit, zoom/pan, multi-image navigation, download,
 * Escape, and focus restoration.
 */
export function ImageViewer({
  items,
  index,
  source,
  onSelect,
  onClose,
  onRetry,
  restoreFocus,
}: {
  items: readonly ImageViewerItem[];
  index: number;
  source: ImageViewerSource;
  onSelect: (index: number) => void;
  onClose: () => void;
  onRetry?: () => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState<{ src: string; width: number; height: number } | null>(null);
  const [manualZoom, setManualZoom] = useState<{ src: string; value: number } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const item = items[index];
  const src = source.status === "ready" ? source.src : undefined;
  const natural = size?.src === src ? size : null;
  const fit = natural && viewport.width > 0 && viewport.height > 0
    ? Math.min(1, viewport.width / natural.width, viewport.height / natural.height) : 1;
  const zoom = manualZoom && manualZoom.src === src ? manualZoom.value : fit;
  const failed = source.status === "error" || (src != null && failedSrc === src);
  const pan = useImagePreviewPan(item?.id ?? "", src, {
    x: natural ? Math.max(0, (viewport.width + natural.width * zoom) / 2 - Math.min(32, natural.width * zoom / 2)) : 0,
    y: natural ? Math.max(0, (viewport.height + natural.height * zoom) / 2 - Math.min(32, natural.height * zoom / 2)) : 0,
  });
  useBlockingOverlay();

  useEffect(() => {
    const image = imageRef.current;
    if (!src || !image) return;
    let current = true;
    // A thumbnail may already have decoded the same data URL before this
    // element mounts. Decode also covers cached images without a new load event.
    void image.decode().then(() => {
      if (current && image.naturalWidth > 0) setSize({ src, width: image.naturalWidth, height: image.naturalHeight });
    }, () => { if (current) setFailedSrc(src); });
    return () => { current = false; };
  }, [src]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => { dialog.close(); restoreFocus(); };
  }, [restoreFocus]);

  useLayoutEffect(() => {
    const element = viewportRef.current!;
    const resize = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    setManualZoom(null);
  }, [item?.id, src]);

  const changeZoom = (value: number) => {
    if (src) setManualZoom({ src, value: Math.min(8, Math.max(Math.min(0.1, fit), value)) });
  };
  useEffect(() => {
    const element = viewportRef.current!;
    const wheel = (event: WheelEvent) => {
      if (!src || !natural) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      if (event.ctrlKey) changeZoom(zoom * Math.exp(-delta / 300));
      else pan.moveBy(-event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1), -delta);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [src, natural, zoom, fit, pan.offset.x, pan.offset.y]);

  const move = (direction: number) => {
    const next = index + direction;
    if (next >= 0 && next < items.length) onSelect(next);
  };
  const dismissBackground = (event: React.MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) onClose();
  };
  return portalToBody(
    <dialog
      ref={dialogRef}
      className="composer-image-preview"
      aria-label={t("chat.imagePreview.title")}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={dismissBackground}
      onKeyDown={(event) => {
        // Keep dialog navigation local; Escape must not abort an agent run.
        event.stopPropagation();
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <header className="composer-image-preview-header">
        <span className="composer-image-preview-name">{item?.name}</span>
        {src && !failed ? <a href={src} download={item?.name} aria-label={t("chat.imagePreview.download")} title={t("chat.imagePreview.download")}><IconDownload size={18} /></a> : null}
        <button type="button" autoFocus onClick={onClose} aria-label={t("common.close")} title={t("common.close")}><IconClose size={20} /></button>
      </header>
      <div className="composer-image-preview-viewport" ref={viewportRef} onClick={dismissBackground} onClickCapture={pan.onClickCapture} onPointerDownCapture={pan.onPointerDownCapture}>
        {failed ? <div className="composer-image-preview-status" role="status">
          <p>{t("chat.imagePreview.error")}</p>
          {onRetry ? <button type="button" onClick={() => { setFailedSrc(null); setSize(null); onRetry(); }}>{t("chat.imagePreview.retry")}</button> : null}
        </div> : src ? <img
          ref={imageRef}
          key={src}
          src={src}
          alt={item?.name}
          draggable={false}
          {...pan.imageHandlers}
          data-dragging={pan.dragging || undefined}
          style={{
            ...(natural ? { width: natural.width * zoom, height: natural.height * zoom } : {}),
            transform: `translate(-50%, -50%) translate(${pan.offset.x}px, ${pan.offset.y}px)`,
          }}
          onLoad={(event) => setSize({ src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setFailedSrc(src)}
        /> : <div className="composer-image-preview-status" role="status">{t("common.loading")}</div>}
      </div>
      <footer className="composer-image-preview-controls">
        {items.length > 1 ? <>
          <button type="button" disabled={index === 0} onClick={() => move(-1)} aria-label={t("chat.imagePreview.previous")}><IconChevronLeft size={18} /></button>
          <span role="status">{t("chat.imagePreview.position", { current: index + 1, total: items.length })}</span>
          <button type="button" disabled={index === items.length - 1} onClick={() => move(1)} aria-label={t("chat.imagePreview.next")}><IconChevronRight size={18} /></button>
        </> : null}
        <button type="button" disabled={!natural || failed || zoom <= Math.min(0.1, fit)} onClick={() => changeZoom(zoom / 1.25)} aria-label={t("menu.zoomOut")}><IconMinus size={18} /></button>
        <output>{Math.round(zoom * 100)}%</output>
        <button type="button" disabled={!natural || failed || zoom >= 8} onClick={() => changeZoom(zoom * 1.25)} aria-label={t("menu.zoomIn")}><IconPlus size={18} /></button>
        <button type="button" disabled={!natural || failed} onClick={() => { setManualZoom(null); pan.reset(); }}>{t("chat.imagePreview.fit")}</button>
      </footer>
    </dialog>,
  );
}
