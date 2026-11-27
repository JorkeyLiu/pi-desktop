/** SVG can be previewed locally, but must not be sent as a raw model image. */
export const SVG_MIME_TYPE = "image/svg+xml";

/** MIME parameters and legacy filename metadata must not bypass the SVG fallback. */
export function isSvgAttachment(
  mimeType: string | undefined,
  ...names: (string | undefined)[]
): boolean {
  return (
    mimeType?.split(";", 1)[0]?.trim().toLowerCase() === SVG_MIME_TYPE ||
    names.some((name) => typeof name === "string" && /\.svg$/i.test(name.trim()))
  );
}

/**
 * Viewable image formats: the single extension/MIME table for "can this be
 * shown as an image". The host Files-tab preview (`imageMimeFor`) and the
 * chat transcript route through this table so the two surfaces cannot drift.
 * Viewable is deliberately wider than model-sendable: SVG previews locally
 * but is never sent as inline model bytes (see `isSvgAttachment`).
 */
export const VIEWABLE_IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: SVG_MIME_TYPE,
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
};

const VIEWABLE_IMAGE_MIME_SET = new Set(Object.values(VIEWABLE_IMAGE_MIME));

/**
 * Whether a named attachment can be shown as an image. A known image
 * extension always wins so a client cannot reclassify `notes.md` as
 * `image/png`; extensionless content blobs use an allowlisted stored MIME.
 */
export function isViewableImageAttachment(
  mimeType: string | undefined,
  ...names: (string | undefined)[]
): boolean {
  for (const name of names) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (!trimmed) continue;
    const base = trimmed.replace(/\\/g, "/").split("/").pop() ?? "";
    const dot = base.lastIndexOf(".");
    if (dot <= 0) continue;
    const ext = base.slice(dot + 1).toLowerCase();
    if (!ext) continue;
    // A named non-image extension rejects even an image MIME: the name is
    // the stable signal and MIME metadata must not reclassify it.
    return ext in VIEWABLE_IMAGE_MIME;
  }
  const declared = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return VIEWABLE_IMAGE_MIME_SET.has(declared);
}
