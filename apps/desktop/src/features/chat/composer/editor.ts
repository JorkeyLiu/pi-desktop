import {
  fileReferenceLabel,
  formatFileInsert,
} from "@pi-desktop/shared";
import type { ComposerPluginPart } from "../../../lib/composer-smart-stop";
import type { ComposerFileReference } from "./model";
import {
  CHIP_TOKEN_COUNT,
  isChipTokenChar,
  isImageFilePath,
  isPluginMark,
  nextChipToken,
} from "./reference-model";
import {
  CARET_MARK,
  caretHostConsumed,
  caretHostDraftLength,
  caretHostDraftText,
  caretHostTextOffset,
  caretIndexForPoint,
  isCaretHostLead,
  selectionEndForPoint,
  selectionRangeFromPoints,
  selectionStartForPoint,
} from "./reference-selection";
import {
  buildCaretHost,
  buildReferenceElement,
  isCaretHost,
  isReferenceElement,
} from "./reference-tokens";

export type { ComposerFileReference } from "./model";
export {
  CHIP_TOKEN_COUNT,
  isChipTokenChar,
  isEditableTextReference,
  isImageFilePath,
  isPluginMark,
  nextChipToken,
} from "./reference-model";

let composerFileReferenceSequence = 0;

/** Paste/scratch files keep absolute paths; `@` entries are workspace-relative. */
export function isPersistedScratchReference(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function formatDroppedDirectoryPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const formatted = formatFileInsert(normalized, "dir");
  // `formatFileInsert` leaves a spaced directory quote open for interactive
  // @ completion. A completed native drop needs a closed token so mixed drops
  // can separate the directory from the following file token.
  return /\s/.test(normalized) ? `${formatted}"` : formatted;
}

export function createFileReference(
  path: string,
  preferredName?: string,
  sessionId = "",
  metadata?: {
    kind?: "image" | "file" | "session";
    mimeType?: string;
    token?: string;
    plugin?: ComposerPluginPart;
  },
): ComposerFileReference {
  composerFileReferenceSequence += 1;
  return {
    id: `composer-file-${composerFileReferenceSequence}`,
    sessionId,
    path,
    // A plugin mark's label is shown as given, and a session reference is
    // named by its conversation; neither is a path.
    name:
      isPluginMark(metadata) || metadata?.kind === "session"
        ? (preferredName ?? "")
        : fileReferenceLabel(path, preferredName),
    kind: metadata?.kind ?? (isImageFilePath(path) ? "image" : "file"),
    ...(metadata?.mimeType ? { mimeType: metadata.mimeType } : {}),
    ...(metadata?.token ? { token: metadata.token } : {}),
    ...(metadata?.plugin ? { plugin: metadata.plugin } : {}),
  };
}

/** Rendered length of a node in draft-string characters (a reference = 1 char). */
/** The draft characters one text node contributes (a caret host hides its mark). */
function editorTextValue(node: Node): string {
  const text = node.nodeValue ?? "";
  return isCaretHost(node) ? caretHostDraftText(text) : text;
}

/** Rendered length of a node in draft-string characters (a reference = 1 char). */
function editorNodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return editorTextValue(node).length;
  if (isReferenceElement(node)) return 1;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as HTMLElement;
    if (element.tagName === "BR") return 1;
    let total = 0;
    for (const child of Array.from(node.childNodes)) total += editorNodeLength(child);
    return total;
  }
  return 0;
}

/**
 * The editable's final BR is Chromium's caret-only slot for the empty last
 * line: it renders no line of its own and takes no draft character. A draft
 * newline therefore always keeps a companion BR after it (`paintEditorValue`,
 * `insertNewlineAtCaret`, `insertClipboardText`), which is what makes the
 * empty line real and the caret stay on it. Reading, indexing and painting all
 * agree on this node, so DOM serialization and draft offsets cannot drift.
 */
function isTrailingPlaceholderBreak(editor: HTMLElement, node: Node): boolean {
  return node.nodeName === "BR" && node.parentNode === editor && editor.lastChild === node;
}

type EditorPoint = { node: Node; offset: number };

/** A DOM point inside one reference: the token it belongs to and how far in. */
export type ReferenceInside = {
  /** Draft index of the token this label belongs to. */
  readonly start: number;
  /** Draft index just after the token. */
  readonly end: number;
  /** How far the DOM point sits into the visible label. */
  readonly offset: number;
  /** Visible label length in DOM characters. */
  readonly length: number;
};

/** A DOM point mapped into the draft, plus the label it sits inside if any. */
export type EditorPointInfo = {
  readonly index: number;
  readonly inside: ReferenceInside | null;
};

/**
 * Give the editable exactly the caret slot an empty last line needs, measured
 * against the value the caller intends: the final break of a trailing run is
 * Chromium's caret-only slot, so the run reads as (trailing newlines) breaks
 * plus that slot. Completing against the intended value keeps arbitrarily many
 * meaningful trailing newlines, adds none, and never turns an existing caret
 * slot into content — a paste in the middle of a newline-terminated draft ends
 * on a break run that is already correct and is left alone.
 */
function completeTrailingBreaks(editor: HTMLElement, expected: string): void {
  // Chromium leaves an empty text node after insertHTML; it carries no draft
  // character and would hide the caret slot from this count, so it never
  // survives a completion.
  let tail = editor.lastChild;
  while (tail && tail.nodeType === Node.TEXT_NODE && (tail.nodeValue ?? "") === "") {
    const previous = tail.previousSibling;
    tail.remove();
    tail = previous;
  }
  const trailingNewlines = /\n*$/.exec(expected)?.[0].length ?? 0;
  let run = 0;
  for (let node = editor.lastChild; node?.nodeName === "BR"; node = node.previousSibling) {
    run += 1;
  }
  const desired = trailingNewlines + 1;
  if (run > desired) {
    // Only breaks beyond the intended run are scaffolding the draft rejects.
    for (let extra = run - desired; extra > 0; extra -= 1) editor.lastChild?.remove();
    return;
  }
  // A value with no trailing newline needs no slot of its own.
  if (trailingNewlines === 0) return;
  for (; run < desired; run += 1) editor.appendChild(document.createElement("br"));
}

function referenceLabelLength(element: HTMLElement): number {
  return (element.textContent ?? "").length;
}

/**
 * How far a DOM point inside one reference sits into its visible label. Paint
 * gives every reference one text node, so a point in the element is a label
 * offset; the element's own child boundary is its start or end.
 */
function referenceOffsetAt(element: HTMLElement, node: Node, offset: number): number {
  const length = referenceLabelLength(element);
  if (node === element) return offset === 0 ? 0 : length;
  return Math.max(0, Math.min(offset, length));
}

/**
 * Walk the editable's DOM into the plain draft string, optionally stopping at a
 * DOM point. `editorIndexAt` is the length of that prefix, so one algorithm
 * owns both directions instead of two walks that can disagree about
 * references, breaks, or block wrappers reintroduced by native undo. A point
 * inside a reference's label reports the token it belongs to: the label is
 * variable-length DOM text for one draft character, so the walk — not a
 * character count — owns that translation.
 */
function walkEditorValue(
  el: HTMLElement,
  stop?: EditorPoint,
): { value: string; reached: boolean; inside: ReferenceInside | null } {
  let out = "";
  let reached = stop === undefined;
  let inside: ReferenceInside | null = null;
  const visitChildren = (parent: Node, blockStart: boolean): boolean => {
    const children = Array.from(parent.childNodes);
    for (let index = 0; index < children.length; index += 1) {
      if (stop && stop.node === parent && stop.offset === index) {
        reached = true;
        return false;
      }
      const child = children[index];
      const element = child.nodeType === Node.ELEMENT_NODE ? (child as HTMLElement) : null;
      if (isTrailingPlaceholderBreak(el, child)) continue;
      if (child.nodeType === Node.TEXT_NODE) {
        const text = editorTextValue(child);
        if (stop && stop.node === child) {
          // A caret host's mark is not a draft character, so a DOM offset inside
          // it counts only the characters after the mark.
          const consumed = isCaretHost(child)
            ? caretHostConsumed(child.nodeValue ?? "", stop.offset)
            : stop.offset;
          out += text.slice(0, consumed);
          reached = true;
          return false;
        }
        out += text;
        continue;
      }
      if (!element) continue;
      if (isReferenceElement(element)) {
        // A point inside the rendered label is not a draft position of its
        // own: report the token's span and how far into the label it sits, so
        // the caller can snap a caret or expand a selection to the whole token.
        if (stop && element.contains(stop.node)) {
          inside = {
            start: out.length,
            end: out.length + 1,
            offset: referenceOffsetAt(element, stop.node, stop.offset),
            length: referenceLabelLength(element),
          };
          reached = true;
          return false;
        }
        const token = element.dataset.token ?? "";
        // A reference without a draft sentinel is corrupt DOM: read its label
        // as the text it visibly is instead of dropping it.
        out += isChipTokenChar(token) ? token : (element.textContent ?? "");
        continue;
      }
      if (element.tagName === "BR") {
        out += "\n";
        continue;
      }
      if (element.tagName === "DIV" || element.tagName === "P") {
        // Native undo can reintroduce block wrappers; normalize them back
        // to newline-separated text so the value round-trips.
        if (!blockStart && out.length > 0 && !out.endsWith("\n")) out += "\n";
        if (!visitChildren(element, out.length === 0)) return false;
        continue;
      }
      if (!visitChildren(element, blockStart && out.length === 0)) return false;
    }
    if (stop && stop.node === parent && stop.offset === children.length) {
      reached = true;
      return false;
    }
    return true;
  };
  visitChildren(el, true);
  return { value: out, reached, inside };
}

/** Read the editable's DOM back into the plain draft string. */
export function readEditorValue(el: HTMLElement): string {
  return walkEditorValue(el).value;
}

/** Map a DOM point inside the editable to a draft position and its label. */
export function editorPointAt(el: HTMLElement, node: Node, offset: number): EditorPointInfo {
  try {
    const { value, reached, inside } = walkEditorValue(el, { node, offset });
    // A point the draft model cannot address counts as the end of the value,
    // never as a partial reference.
    const index = reached ? value.length : readEditorValue(el).length;
    return { index, inside };
  } catch {
    return { index: 0, inside: null };
  }
}

/** Map a DOM point to the draft caret it stands for: never inside a label. */
export function editorIndexAt(el: HTMLElement, node: Node, offset: number): number {
  return caretIndexForPoint(editorPointAt(el, node, offset));
}

/**
 * Ordered [start, end] draft indices covered by the selection. A selection that
 * touches part of a reference covers that whole token, so a cut or a paste over
 * it can never split an atomic reference.
 */
export function editorSelectionRange(el: HTMLElement): { start: number; end: number } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const end = readEditorValue(el).length;
    return { start: end, end };
  }
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
    const end = readEditorValue(el).length;
    return { start: end, end };
  }
  return selectionRangeFromPoints(
    editorPointAt(el, range.startContainer, range.startOffset),
    editorPointAt(el, range.endContainer, range.endOffset),
  );
}


/** A caret point inside a caret host, after `consumed` of its draft characters. */
function caretHostPoint(host: Node, consumed: number): EditorPoint {
  return { node: host, offset: caretHostTextOffset(host.nodeValue ?? "", consumed) };
}

/**
 * The DOM point of a draft position after one reference. The browser would
 * canonicalize the element boundary itself into the label, so the point moves
 * into the host text node that follows the token.
 */
function afterReferencePoint(parent: Node, index: number): EditorPoint {
  const next = parent.childNodes[index + 1];
  if (isCaretHost(next)) return caretHostPoint(next, 0);
  return { node: parent, offset: index + 1 };
}

/** The DOM point of a draft position before one reference, after its host. */
function beforeReferencePoint(parent: Node, index: number): EditorPoint {
  const previous = parent.childNodes[index - 1];
  if (isCaretHost(previous)) {
    return caretHostPoint(previous, caretHostDraftLength(previous.nodeValue ?? ""));
  }
  return { node: parent, offset: index };
}
/** Draft-string index → DOM caret point. */
function editorCaretPoint(el: HTMLElement, target: number): EditorPoint {
  let remaining = target;
  let point: EditorPoint | null = null;
  const descend = (parent: Node): boolean => {
    const children = Array.from(parent.childNodes);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (isTrailingPlaceholderBreak(el, child)) {
        // Zero-width: the end of the value caret sits before this node.
        if (point === null && remaining === 0) {
          point = { node: parent, offset: index };
          return true;
        }
        continue;
      }
      const length = editorNodeLength(child);
      if (child.nodeType === Node.TEXT_NODE) {
        if (point === null && remaining <= length) {
          // Inside a caret host the point must stay after the host's invisible
          // mark: a caret on the mark's leading edge is the boundary the
          // browser would canonicalize into the neighbouring label.
          point = {
            node: child,
            offset: isCaretHost(child)
              ? caretHostTextOffset(child.nodeValue ?? "", remaining)
              : remaining,
          };
          return true;
        }
        remaining -= length;
      } else if (isReferenceElement(child)) {
        if (point === null && remaining <= 1) {
          point =
            remaining === 0
              ? beforeReferencePoint(parent, index)
              : afterReferencePoint(parent, index);
          return true;
        }
        remaining -= 1;
      } else if ((child as HTMLElement).tagName === "BR") {
        if (point === null && remaining <= 1) {
          point = { node: parent, offset: remaining === 0 ? index : index + 1 };
          return true;
        }
        remaining -= 1;
      } else if (child.nodeType === Node.ELEMENT_NODE && descend(child)) {
        return true;
      }
    }
    return false;
  };
  descend(el);
  return point ?? { node: el, offset: el.childNodes.length };
}

function clampPoint(point: EditorPoint): EditorPoint {
  const maxOffset =
    point.node.nodeType === Node.TEXT_NODE
      ? (point.node.nodeValue ?? "").length
      : point.node.childNodes.length;
  return { node: point.node, offset: Math.max(0, Math.min(point.offset, maxOffset)) };
}

export function setEditorCaret(el: HTMLElement, index: number): void {
  const point = clampPoint(editorCaretPoint(el, Math.max(0, index)));
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Select a draft range by its own offsets, keeping the anchor where the caller
 * says the user's drag started so Shift+Arrow behavior stays native.
 */
export function setEditorSelection(
  el: HTMLElement,
  anchorIndex: number,
  focusIndex: number,
): void {
  const anchor = clampPoint(editorCaretPoint(el, Math.max(0, anchorIndex)));
  const focus = clampPoint(editorCaretPoint(el, Math.max(0, focusIndex)));
  const selection = window.getSelection();
  if (!selection) return;
  selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

function isRangeStartPoint(range: Range, selection: Selection): boolean {
  return (
    range.startContainer === selection.anchorNode && range.startOffset === selection.anchorOffset
  );
}

/**
 * Snap the browser's selection onto reference boundaries. A caret is never left
 * inside a label, and a selection that reaches into one covers the whole token,
 * both in the draft model and in the visible highlight. Returns whether the DOM
 * selection changed, so callers can tell a repair from an untouched selection.
 */
export function normalizeEditorSelection(el: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return false;
  if (range.collapsed) {
    const point = editorPointAt(el, range.startContainer, range.startOffset);
    // A caret on a host's leading edge, or inside a label, is a point the
    // browser would edit as the neighbouring token: both are repaired onto the
    // nearest whole-token draft boundary.
    const hostLead =
      range.startContainer.nodeType === Node.TEXT_NODE &&
      isCaretHostLead(range.startContainer.nodeValue ?? "", range.startOffset);
    if (!point.inside && !hostLead) return false;
    setEditorCaret(el, caretIndexForPoint(point));
    return true;
  }
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  if (!anchorNode || !focusNode) return false;
  const anchorIsStart = isRangeStartPoint(range, selection);
  const anchorPoint = editorPointAt(el, anchorNode, selection.anchorOffset);
  const focusPoint = editorPointAt(el, focusNode, selection.focusOffset);
  const anchorIndex = anchorIsStart
    ? selectionStartForPoint(anchorPoint)
    : selectionEndForPoint(anchorPoint);
  const focusIndex = anchorIsStart
    ? selectionEndForPoint(focusPoint)
    : selectionStartForPoint(focusPoint);
  const anchorNeedsRepair = anchorPoint.inside
    ? anchorIsStart
      ? anchorPoint.inside.offset < anchorPoint.inside.length
      : anchorPoint.inside.offset > 0
    : false;
  const focusNeedsRepair = focusPoint.inside
    ? anchorIsStart
      ? focusPoint.inside.offset > 0
      : focusPoint.inside.offset < focusPoint.inside.length
    : false;
  if (!anchorNeedsRepair && !focusNeedsRepair) return false;
  setEditorSelection(el, anchorIndex, focusIndex);
  return true;
}

/** Paint the contenteditable from the draft string. */
export function paintEditorValue(
  el: HTMLElement,
  value: string,
  referenceByToken: Map<string, ComposerFileReference>,
): void {
  el.replaceChildren();
  let textBuffer = "";
  let lastKind: "text" | "reference" | "break" | "host" | null = null;
  const flush = () => {
    if (textBuffer) {
      el.appendChild(document.createTextNode(textBuffer));
      textBuffer = "";
      lastKind = "text";
    }
  };
  const appendHost = () => {
    el.appendChild(buildCaretHost());
    lastKind = "host";
  };
  const hostBeforeReference = () => {
    // A text node already holds a caret before the token, and a host placed
    // ahead of it already ends the same way; anything else leaves the boundary
    // to the browser, which would edit it as the label.
    return lastKind !== "text" && lastKind !== "host";
  };
  for (const char of Array.from(value)) {
    if (isChipTokenChar(char)) {
      const reference = referenceByToken.get(char);
      if (reference) {
        flush();
        // A caret of its own needs a real text position whenever the node
        // before the token cannot hold one: the start of the draft, another
        // token, or a line break.
        if (hostBeforeReference()) appendHost();
        el.appendChild(buildReferenceElement(reference, char));
        lastKind = "reference";
        // The caret after a token always needs one: the browser's nearest text
        // node is the token's label, and it would swallow the next insertion.
        appendHost();
        continue;
      }
      // A private-use code point with no reference behind it is user text (for
      // example a Nerd Font glyph pasted from a terminal); keep it verbatim.
    }
    if (char === "\n") {
      flush();
      el.appendChild(document.createElement("br"));
      lastKind = "break";
      continue;
    }
    textBuffer += char;
  }
  flush();
  completeTrailingBreaks(el, value);
  if (el.childNodes.length === 0) {
    // Chromium needs at least one node for reliable caret placement.
    el.appendChild(document.createTextNode(""));
  }
}

export function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  if (files.length === 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/** Word may copy text plus a synthesized image of the same selection. Keep
 * that text editable, but preserve explicit native files and image-only paste. */
export function preferClipboardText(
  text: string,
  files: readonly File[],
  resolveNativePath: (file: File) => string | null,
): boolean {
  return (
    text.trim().length > 0 &&
    files.length > 0 &&
    files.every((file) =>
      file.type.toLowerCase().startsWith("image/") && !resolveNativePath(file),
    )
  );
}

/** Clipboard text arrives with CRLF/CR; the draft model stores LF only. */
export function normalizeClipboardLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Keep native undo while inserting multiline text into the editor's Text/BR
 * model. insertText creates block wrappers whose offsets differ from the draft. */
export function insertClipboardText(editor: HTMLElement, text: string): boolean {
  // A caret beside a reference is repaired onto its caret host first, so the
  // native command below inserts outside the label and keeps the undo stack.
  normalizeEditorSelection(editor);
  if (!/[\r\n]/.test(text)) return document.execCommand("insertText", false, text);
  const before = readEditorValue(editor);
  const { start, end } = editorSelectionRange(editor);
  const normalized = normalizeClipboardLineEndings(text);
  const escaped = document.createElement("div");
  escaped.textContent = normalized;
  // Only escaped plain text and our own line breaks enter insertHTML; clipboard
  // HTML, attributes, links, and scripts are never accepted.
  const inserted = document.execCommand(
    "insertHTML",
    false,
    escaped.innerHTML.replace(/\n/g, "<br>"),
  );
  // A pasted trailing break is a draft newline and needs the caret slot after
  // it; completing against the value this paste means to produce leaves a
  // mid-draft paste's existing break run — and every trailing newline it
  // already had — untouched. Use the draft offsets for the caret, as reference
  // insertion does, without changing undo.
  if (inserted) {
    completeTrailingBreaks(editor, before.slice(0, start) + normalized + before.slice(end));
    setEditorCaret(editor, start + normalized.length);
  }
  return inserted;
}

/**
 * The rendered box of the line an insertion point sits on. Chromium reports no
 * client rect for a collapsed point at an element boundary, so the point is
 * resolved to a neighbouring line box instead: the node after the offset (the
 * line the point opens) first, then the node before it.
 */
function lineRectAtPoint(container: Node, offset: number): DOMRect | null {
  const range = document.createRange();
  for (const candidate of [container.childNodes[offset], container.childNodes[offset - 1]]) {
    if (!candidate) continue;
    if (candidate.nodeType === Node.TEXT_NODE) {
      // An empty half-node left by a split renders no line of its own.
      if ((candidate.nodeValue ?? "").length === 0) continue;
      range.setStart(candidate, 0);
      range.setEnd(candidate, 1);
    } else if (candidate.nodeType === Node.ELEMENT_NODE) {
      range.selectNode(candidate);
    } else {
      continue;
    }
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    if (rect.height > 0) return rect;
  }
  return null;
}

/**
 * Keep a freshly placed insertion point inside the editable's visible box.
 *
 * The composer clips itself once the draft passes the autosize ceiling
 * (`min-height`/`max-height` in `composer.css`): beyond that the content is
 * programmatically scrollable but no longer scrolls the caret into view, so an
 * inserted line break could leave the caret below the visible lines until the
 * next keystroke. Scrolling belongs to this editing boundary, next to the code
 * that moves the point, not to the component that calls it.
 */
function revealInsertionPoint(editor: HTMLElement, container: Node, offset: number): void {
  const maxScroll = editor.scrollHeight - editor.clientHeight;
  if (maxScroll <= 0) return;
  const rect = lineRectAtPoint(container, offset);
  if (!rect) return;
  const borderTop = Number.parseFloat(getComputedStyle(editor).borderTopWidth) || 0;
  const viewTop = editor.getBoundingClientRect().top + borderTop;
  const viewBottom = viewTop + editor.clientHeight;
  let target = editor.scrollTop;
  if (rect.bottom > viewBottom) target += rect.bottom - viewBottom;
  else if (rect.top < viewTop) target -= viewTop - rect.top;
  target = Math.min(Math.max(target, 0), maxScroll);
  if (target !== editor.scrollTop) editor.scrollTop = target;
}

/**
 * Insert one draft-model newline at the caret as a break pair: the inserted BR
 * opens the new line and, when it ends the editable, a companion BR keeps the
 * caret insertable on the empty line. No block wrapper and no literal "\n" text
 * node enters the DOM, so `readEditorValue` and the offsets a caller keeps stay
 * valid. Returns false when the caret is outside `editor`.
 */
export function insertNewlineAtCaret(editor: HTMLElement): boolean {
  normalizeEditorSelection(editor);
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
    return false;
  }
  const before = readEditorValue(editor);
  const { start, end } = editorSelectionRange(editor);
  range.deleteContents();
  const lineBreak = document.createElement("br");
  range.insertNode(lineBreak);
  // Splitting a text node at either end leaves an empty half beside the break;
  // it carries no draft character and would hide the break from the caret model
  // (a break with an empty text node after it is no longer the editable's last
  // child), so drop the halves the split just created.
  for (const sibling of [lineBreak.previousSibling, lineBreak.nextSibling]) {
    if (sibling?.nodeType === Node.TEXT_NODE && (sibling.nodeValue ?? "") === "") sibling.remove();
  }
  completeTrailingBreaks(editor, `${before.slice(0, start)}\n${before.slice(end)}`);
  const after = document.createRange();
  after.setStartAfter(lineBreak);
  after.collapse(true);
  selection.removeAllRanges();
  selection.addRange(after);
  revealInsertionPoint(editor, after.startContainer, after.startOffset);
  return true;
}

/** Paint a reference-less editor from plain draft text. */
export function paintEditorText(editor: HTMLElement, value: string): void {
  paintEditorValue(editor, value, new Map<string, ComposerFileReference>());
}
