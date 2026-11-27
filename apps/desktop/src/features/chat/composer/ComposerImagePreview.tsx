import type { ComposerImagePreviewController } from "./hooks/useComposerImagePreview";
import { ImageViewer } from "../../../components/ImageViewer";

export function ComposerImagePreview({ controller }: { controller: ComposerImagePreviewController }) {
  return controller.preview ? <ImagePreviewDialog controller={controller} preview={controller.preview} /> : null;
}

function ImagePreviewDialog({ controller, preview }: {
  controller: ComposerImagePreviewController;
  preview: NonNullable<ComposerImagePreviewController["preview"]>;
}) {
  const index = preview.images.findIndex((image) => image.id === preview.id);
  return (
    <ImageViewer
      items={preview.images}
      index={index}
      source={preview.source}
      onSelect={(next) => {
        const image = preview.images[next];
        if (image) controller.select(image.id);
      }}
      onClose={controller.close}
      onRetry={controller.retry}
      restoreFocus={preview.restoreFocus}
    />
  );
}
