import type { ComposerFileReference } from "./model";
import { isEditableTextReference, isPluginMark } from "./reference-model";

/**
 * The inline element one draft reference paints. It is ordinary text inside the
 * contenteditable — no icon, capsule, or remove button — so the visible `@name`
 * is selectable, wraps like prose, and is one atomic token to editing.
 */
export const REFERENCE_CLASS = "composer-reference";
export const REFERENCE_SELECTOR = `.${REFERENCE_CLASS}`;
export const IMAGE_REFERENCE_SELECTOR = `${REFERENCE_SELECTOR}[data-image]`;

/** What activating a reference does; each action already exists per kind. */
export type ComposerReferenceAction =
  | "expand-text-reference"
  | "open-image-preview"
  | "open-session-reference";

/**
 * The visible label of one draft reference. A file reference reads exactly
 * `@name`; a plugin mark is text the plugin sends in its place, so it keeps the
 * label it was given, with no path prefix.
 */
export function referenceLabel(reference: ComposerFileReference): string {
  return isPluginMark(reference) ? reference.name : `@${reference.name}`;
}

/** A reference whose visible label is an image thumbnail entry. */
export function isImageReferenceLabel(reference: ComposerFileReference): boolean {
  return (
    !isPluginMark(reference) &&
    (reference.kind === "image" ||
      (reference.mimeType ?? "").toLowerCase().startsWith("image/"))
  );
}

/**
 * The one existing activation a reference kind already owns: a text file
 * expands into editable text, an image opens its preview, and a conversation
 * reference opens that conversation. Everything else stays plain draft text.
 */
export function referenceAction(
  reference: ComposerFileReference,
): ComposerReferenceAction | undefined {
  if (isPluginMark(reference)) return undefined;
  if (reference.kind === "session") return "open-session-reference";
  if (isImageReferenceLabel(reference)) return "open-image-preview";
  return isEditableTextReference(reference) ? "expand-text-reference" : undefined;
}

/** The full reference a token stands for: its path, or the plugin that placed it. */
function referenceOrigin(reference: ComposerFileReference): string {
  return isPluginMark(reference) ? (reference.plugin?.pluginId ?? "") : reference.path;
}

/**
 * Build the inline token for one reference. `title` carries the full path the
 * visible label leaves out; the element text is that label and nothing else, so
 * the browser can select, wrap and copy it as text.
 */
export function buildReferenceElement(
  reference: ComposerFileReference,
  token: string,
): HTMLElement {
  const element = document.createElement("span");
  element.className = REFERENCE_CLASS;
  element.dataset.token = token;
  if (isPluginMark(reference)) element.dataset.pluginMark = reference.plugin?.kind;
  if (isImageReferenceLabel(reference)) element.dataset.image = "";
  if (reference.kind === "session") element.dataset.sessionId = reference.path;
  const action = referenceAction(reference);
  if (action) element.dataset.action = action;
  element.title = referenceOrigin(reference);
  element.textContent = referenceLabel(reference);
  return element;
}

/** Whether one node is a painted reference token (a plain boolean, not a narrowing). */
export function isReferenceElement(node: Node | null | undefined): boolean {
  return (
    node?.nodeType === Node.ELEMENT_NODE &&
    (node as HTMLElement).classList.contains(REFERENCE_CLASS)
  );
}

/** The reference token around (or at) one node, if any. */
export function referenceElementFor(node: Node | null | undefined): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(REFERENCE_SELECTOR) ?? null;
}
