import { IconClose, IconImage } from "../../../components/icons";
import type { ComposerImageSource } from "./hooks/useComposerImagePreview";
import type { ComposerFileReference } from "./model";

/**
 * Staged images as a compact tile row inside the composer box.
 *
 * A tile is the image itself (the host-resolved preview source the composer's
 * own preview dialog uses), so picking or pasting an image shows what will be
 * sent, not a file name. Clicking opens that dialog; the corner button removes
 * the image from the draft. The row is presentational — staging, submission,
 * and clearing belong to the surface's attachment controller.
 */
export function ComposerImageStrip({
  references,
  sources,
  onOpen,
  onRemove,
  onPreview,
  onRemoveLabel,
  failedLabel,
}: {
  references: readonly ComposerFileReference[];
  sources: ReadonlyMap<string, ComposerImageSource> | undefined;
  onOpen: (reference: ComposerFileReference) => void;
  onRemove: (id: string) => void;
  onPreview: string;
  onRemoveLabel: (name: string) => string;
  failedLabel: string;
}) {
  if (!references.length) return null;
  return (
    <div className="composer-attachment-strip" role="list">
      {references.map((reference) => {
        const source = sources?.get(reference.id);
        return (
          <span key={reference.id} className="composer-attachment-tile" role="listitem">
            <button
              type="button"
              className="composer-attachment-open"
              title={`${reference.name} — ${onPreview}`}
              aria-label={`${reference.name} — ${onPreview}`}
              onClick={() => onOpen(reference)}
            >
              {source?.status === "ready" ? (
                <img className="composer-attachment-image" src={source.src} alt="" />
              ) : source?.status === "error" ? (
                <span className="composer-attachment-fallback" title={failedLabel}>
                  <IconImage size={14} aria-hidden="true" />
                </span>
              ) : (
                <span className="composer-attachment-fallback" aria-hidden="true">
                  <IconImage size={14} />
                </span>
              )}
            </button>
            <button
              type="button"
              className="composer-attachment-remove"
              title={onRemoveLabel(reference.name)}
              aria-label={onRemoveLabel(reference.name)}
              onClick={() => onRemove(reference.id)}
            >
              <IconClose size={10} aria-hidden="true" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
