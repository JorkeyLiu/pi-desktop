/**
 * Composer caret/newline regression fixture.
 *
 * Mounts the real `useComposerDraft` + `ComposerInput` pair and lets the driver
 * press real keys through Chromium (`webContents.sendInputEvent`), so a failing
 * step is the actual editing host refusing to keep the caret on an empty line,
 * not a stub standing in for it.
 *
 * Only the assertions live in the driver; this fixture reports what the browser
 * did: the draft the app holds, the DOM serialization, the caret offset, the
 * rendered line of the caret and of the last text run, reference tokens, and the
 * text a
 * submission would send.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance, type TFunction } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import {
  useComposerDraft,
  type ComposerDraftController,
} from "../../apps/desktop/src/features/chat/composer/hooks/useComposerDraft";
import { ComposerInput } from "../../apps/desktop/src/features/chat/composer/ComposerInput";
import {
  createFileReference,
  editorSelectionRange,
  insertClipboardText,
  readEditorValue,
  setEditorCaret,
} from "../../apps/desktop/src/features/chat/composer/editor";
declare global {
  var composerCaretProbe: (steps: CursorStep[]) => Promise<unknown>;
  var composerCaretPointerDone: () => void;
  var composerCaretCdpDone: () => void;
}

type CursorStep = {
  op: string;
  text?: string;
  key?: string;
  label?: string;
  caret?: number;
  /** Element a real pointer click is aimed at. */
  target?: "token" | "tail";
  /** Text an emulated composition commits after its preedit. */
  commit?: string;
};

const noop = () => {};
const t = ((key: string) => key) as unknown as TFunction;
const i18n = createInstance();

let controller: ComposerDraftController;
let draftValue = "";

function Fixture() {
  const draft = useComposerDraft({
    variant: "docked",
    activeSessionId: "caret-session",
    workspacePath: "/caret-workspace",
    sessions: [{ id: "caret-session" }],
    composerPrefill: null,
    clearComposerPrefill: noop,
    t,
    invalidateComposerTransforms: noop,
    inputBlocked: false,
  });
  controller = draft;
  draftValue = draft.value;
  return (
    <I18nextProvider i18n={i18n}>
      <ComposerInput
        inputRef={draft.ref}
        value={draft.value}
        placeholderText=""
        placeholderKey="caret"
        inputBlocked={false}
        pasting={false}
        enterToSend={false}
        runActive={false}
        onPaste={noop}
        onSubmit={noop}
        onInsertNewline={() => draft.insertNewlineInEditor()}
        onHistoryNavigate={() => false}
        onInput={(source, caret) => {
          draft.handleInput(source, caret);
        }}
        onActivateReference={(token) => activations.push(token)}
        onCompositionStart={() => draft.setComposing(true)}
        onCompositionEnd={() => draft.setComposing(false)}
        onSettledInput={() => draft.setComposing(false)}
        onFocus={noop}
        onBlur={noop}
      />
    </I18nextProvider>
  );
}

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

const settle = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};

const editor = () => document.querySelector<HTMLElement>(".composer-input")!;

/** Native editing events, so a prevented default is visible to the driver. */
const nativeEvents: Array<Record<string, unknown>> = [];
document.addEventListener(
  "beforeinput",
  (event) => {
    const input = event as InputEvent;
    queueMicrotask(() =>
      nativeEvents.push({
        type: "beforeinput",
        inputType: input.inputType,
        prevented: input.defaultPrevented,
      }),
    );
  },
  true,
);

const pendingKeys: Array<() => void> = [];
document.addEventListener("keyup", () => {
  pendingKeys.shift()?.();
});

/** Ask the driver to press one real key, and wait for the resulting keyup. */
const pressKey = (key: string) => {
  const done = new Promise<void>((resolve) => pendingKeys.push(resolve));
  console.log("PI_CARET_KEY:" + key);
  return done;
};

/** Ask the driver for one real pointer click at the element's centre. */
const clickPointer = (target: Element | Node, at: "start" | "center" = "center") => {
  const rect = pointerRect(target);
  const done = new Promise<void>((resolve) => {
    (globalThis as unknown as { composerCaretPointerDone: () => void }).composerCaretPointerDone = resolve;
  });
  console.log(
    "PI_CARET_POINTER:" +
      JSON.stringify({
        x: Math.round(at === "start" ? rect.left + 1 : rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      }),
  );
  return done;
};
/**
 * Ask the driver to run one real Chromium input command, so an emulated IME
 * composition and an `Input.insertText` reach the editing host exactly as an
 * OS input method would.
 */
const requestCdp = (spec: Record<string, string>) => {
  const done = new Promise<void>((resolve) => {
    (globalThis as unknown as { composerCaretCdpDone: () => void }).composerCaretCdpDone =
      resolve;
  });
  console.log("PI_CARET_CDP:" + JSON.stringify(spec));
  return done;
};

/**
 * Where the browser put the selection: whether an endpoint landed inside a
 * reference token's label, which is a point the draft cannot address as its
 * own character.
 */
const selectionPoint = () => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const describe = (node: Node | null, offset: number) => {
    if (!node) return null;
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
    const reference = element?.closest(".composer-reference");
    return {
      kind: node.nodeType === Node.TEXT_NODE ? "text" : (node as HTMLElement).nodeName,
      parentClass:
        node.nodeType === Node.TEXT_NODE ? (node.parentElement?.className ?? "") : "",
      insideReference: Boolean(reference),
      partClass: element?.className ?? "",
      offset,
    };
  };
  return {
    anchor: describe(selection.anchorNode, selection.anchorOffset),
    focus: describe(selection.focusNode, selection.focusOffset),
    collapsed: selection.isCollapsed,
  };
};

const textTop = (el: HTMLElement) => {
  const style = getComputedStyle(el);
  return el.getBoundingClientRect().top + parseFloat(style.borderTopWidth || "0") +
    parseFloat(style.paddingTop || "0");
};
const lineHeight = (el: HTMLElement) => parseFloat(getComputedStyle(el).lineHeight);
const lineOf = (el: HTMLElement, top: number) =>
  Math.round((top - textTop(el)) / lineHeight(el));

/** Rendered line of the last text run, the outcome a real keystroke produced. */
const lastTextLine = (el: HTMLElement) => {
  let node: Node | null = null;
  const walk = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && (child.nodeValue ?? "").length > 0) node = child;
      else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
    }
  };
  walk(el);
  if (!node) return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  return rect.height > 0 ? lineOf(el, rect.top) : null;
};

/** Rendered line of the caret; Chromium reports no rect for element offsets. */
const caretLine = (el: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return rect && rect.height > 0 && (rect.top !== 0 || rect.left !== 0) ? lineOf(el, rect.top) : null;
};

/** The draft line the caret sits on, 0-based, counted from the draft newlines. */
const caretDraftLine = (el: HTMLElement) => {
  const value = readEditorValue(el);
  const caret = editorSelectionRange(el).start;
  return value.slice(0, caret).split("\n").length - 1;
};

/** The caret's own client box; a point the browser cannot render has none. */
const caretBox = (el: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return { top: rect.top, bottom: rect.bottom };
};

/**
 * Whether the caret's line sits inside the editor's visible box. The editor
 * clips at its CSS ceiling, so a line below it is only visible when the editor
 * is scrolled far enough. A caret on a line break has no client box of its
 * own, so the line comes from the draft's newlines and is placed with the
 * line height the browser renders.
 */
const caretInView = (el: HTMLElement) => {
  const height = lineHeight(el);
  const top = textTop(el) + caretDraftLine(el) * height - el.scrollTop;
  const style = getComputedStyle(el);
  const viewTop = el.getBoundingClientRect().top + parseFloat(style.borderTopWidth || "0");
  const viewBottom = viewTop + el.clientHeight;
  return top >= viewTop - 1 && top + height <= viewBottom + 1;
};
/** Which element currently owns DOM focus, and whether it is one draft token. */
const describeNode = (node: Element | null) => {
  if (!node) return null;
  const element = node as HTMLElement;
  return {
    tag: element.tagName,
    className: element.className,
    role: element.getAttribute("role"),
    token: element.dataset.token ?? null,
    insideEditor: Boolean(element.closest(".composer-input")),
  };
};


/** Bounding box of one element or text run, for a real pointer click. */
const pointerRect = (target: Element | Node) => {
  if (target.nodeType === Node.ELEMENT_NODE) return (target as Element).getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(target);
  return range.getBoundingClientRect();
};

/** The plain text run after the last token, the point a click past it reaches. */
const tailText = (): Node | null => {
  let found: Node | null = null;
  const walk = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!(child.nodeValue ?? "").startsWith("\u200B") && (child.nodeValue ?? "").length > 0) {
          found = child;
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if ((child as Element).classList.contains("composer-reference")) continue;
      walk(child);
    }
  };
  walk(editor());
  return found;
};
const snapshot = (label: string) => {
  const el = editor();
  return {
    label,
    draft: draftValue,
    live: readEditorValue(el),
    html: el.innerHTML,
    caret: editorSelectionRange(el).start,
    caretEnd: editorSelectionRange(el).end,
    cursor: controller.cursor,
    valueLength: draftValue.length,
    caretLine: caretLine(el),
    lastTextLine: lastTextLine(el),
    // Autosize and overflow: the editor grows to its CSS ceiling and then
    // clips, so a caret past the ceiling is only reachable by scrolling.
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    lineHeight: lineHeight(el),
    caretBox: caretBox(el),
    caretInView: caretInView(el),
    caretLineIndex: caretDraftLine(el),
    lastChild: el.lastChild?.nodeName ?? null,
    references: Array.from(el.querySelectorAll<HTMLElement>(".composer-reference")).map(
      (reference) => reference.dataset.token ?? "",
    ),
    labels: Array.from(el.querySelectorAll<HTMLElement>(".composer-reference")).map(
      (reference) => reference.textContent ?? "",
    ),
    activations: activations.splice(0, activations.length),
    // The accessible contract of each inline reference: its link role, its
    // reachable tab stop, and the name and full path it carries.
    referenceAria: Array.from(el.querySelectorAll<HTMLElement>(".composer-reference")).map(
      (reference) => ({
        role: reference.getAttribute("role"),
        label: reference.getAttribute("aria-label"),
        tabIndex: reference.tabIndex,
        title: reference.title,
      }),
    ),
    focused: describeNode(document.activeElement),
    tokens: controller.fileReferences.map((reference) => reference.token ?? ""),
    submission: controller.draftSnapshot(draftValue).text,
    selection: window.getSelection()?.toString() ?? "",
    point: selectionPoint(),
    events: nativeEvents.splice(0, nativeEvents.length),
  };
};

const tokenReference = (name: string) =>
  createFileReference(`/caret-workspace/${name}`, name, "caret-session");

/** Tokens activated by a real pointer click, in order. */
const activations: string[] = [];

globalThis.composerCaretProbe = async (steps: CursorStep[]) => {
  if (!i18n.isInitialized) {
    await i18n.init({
      lng: "en",
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  }
  flushSync(() => root.render(<Fixture />));
  await settle();
  editor().focus();
  await settle();

  const trace: ReturnType<typeof snapshot>[] = [];
  const record = (label: string) => {
    const state = snapshot(label);
    trace.push(state);
    return state;
  };

  record("mounted");
  for (const step of steps) {
    if (step.op === "set") {
      const text = step.text ?? "";
      const caret = step.caret ?? text.length;
      flushSync(() => controller.applyEditorDraft(text, [], caret));
      await settle();
      continue;
    }
    if (step.op === "token") {
      const reference = { ...tokenReference(step.text ?? "notes.txt"), token: "\uE010" };
      const text = `见 ${reference.token}\n`;
      flushSync(() => controller.applyEditorDraft(text, [reference], text.length));
      await settle();
      continue;
    }
    if (step.op === "type") {
      for (const char of step.text ?? "") {
        await pressKey(char);
        await settle();
      }
      continue;
    }
    if (step.op === "key") {
      await pressKey(step.key ?? "");
      await settle();
      continue;
    }
    if (step.op === "undo") {
      document.execCommand("undo");
      await settle();
      continue;
    }
    if (step.op === "redo") {
      document.execCommand("redo");
      await settle();
      continue;
    }
    if (step.op === "caret") {
      setEditorCaret(editor(), step.caret ?? 0);
      controller.updateCursor(editorSelectionRange(editor()).start);
      await settle();
      continue;
    }
    if (step.op === "scrollToBottom") {
      // Put the editor where a user who has typed to the last line leaves it:
      // scrolled to its own content end, the way native caret reveal does.
      const el = editor();
      el.scrollTop = el.scrollHeight - el.clientHeight;
      await settle();
      continue;
    }
    if (step.op === "pointer") {
      // A real click on a token's own label: the browser chooses the selection
      // point, and only a click — never a selection drag — activates.
      const target =
        step.target === "tail" ? tailText() : editor().querySelector(".composer-reference");
      if (!target) throw new Error("pointer target missing: " + (step.target ?? "token"));
      await clickPointer(target, step.target === "tail" ? "start" : "center");
      await settle();
      continue;
    }
    if (step.op === "tokenLast") {
      // The token is the whole draft, so the caret sits on the boundary right
      // after its label — the point a real insertion reaches first.
      const reference = { ...tokenReference(step.text ?? "a.png"), token: "\uE010" };
      const token = reference.token ?? "";
      flushSync(() => controller.applyEditorDraft(token, [reference], token.length));
      await settle();
      continue;
    }
    if (step.op === "cdpInsert" || step.op === "cdpCompose") {
      // A real Chromium insertion or emulated IME composition at the caret.
      await requestCdp(
        step.op === "cdpInsert"
          ? { op: "insertText", text: step.text ?? "" }
          : { op: "compose", text: step.text ?? "", commit: step.commit ?? "" },
      );
      await settle();
      continue;
    }
    if (step.op === "tokenImage") {
      // An image reference is the kind whose click opens a preview, so the
      // keyboard path is checked on it as well.
      const name = step.text ?? "photo.png";
      const reference = {
        ...createFileReference(`/caret-workspace/${name}`, name, "caret-session", {
          kind: "image",
          mimeType: "image/png",
        }),
        token: "\uE011",
      };
      const text = `见 ${reference.token}后面`;
      flushSync(() => controller.applyEditorDraft(text, [reference], text.length));
      await settle();
      continue;
    }
    if (step.op === "tokenMid") {
      // A token that is not the last thing in the draft, so a point mapped past
      // it is distinguishable from the end of the draft.
      const reference = { ...tokenReference(step.text ?? "notes.txt"), token: "\uE010" };
      const text = `见 ${reference.token}后面`;
      flushSync(() => controller.applyEditorDraft(text, [reference], text.length));
      await settle();
      continue;
    }
    if (step.op === "insideToken") {
      // A collapsed selection inside a token's own label text: a point the draft
      // model cannot address, which an assistive caret can produce.
      const label = editor().querySelector(".composer-reference")?.firstChild;
      if (!label) throw new Error("token label missing");
      const range = document.createRange();
      range.setStart(label, step.caret ?? 2);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await settle();
      continue;
    }
    if (step.op === "insideTokenDrag") {
      // A selection that starts inside the label and ends in the text after the
      // token: part of the token is touched, so the whole token must be taken.
      const label = editor().querySelector(".composer-reference")?.firstChild;
      const tail = Array.from(editor().childNodes).find(
        (node) => node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? "").includes("后"),
      );
      if (!label || !tail) throw new Error("token markup missing");
      const range = document.createRange();
      range.setStart(label, step.caret ?? 2);
      range.setEnd(tail, 1);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await settle();
      continue;
    }
    if (step.op === "recallCaret") {
      // Re-enter the draft at the caret index the app stored — the same index a
      // completion splice uses — so a token-interior misread becomes visible.
      const value = readEditorValue(editor());
      flushSync(() => controller.applyEditorDraft(value, controller.fileReferences, controller.cursor));
      await settle();
      continue;
    }
    if (step.op === "step") {
      record(step.label ?? "step");
      continue;
    }
    if (step.op === "paste") {
      // The shared paste helper, run inside the real editing host.
      if (insertClipboardText(editor(), step.text ?? "")) controller.commitEditorDom();
      await settle();
      continue;
    }
    if (step.op === "ime") {
      // An OS IME cannot be driven here; the commit is modelled at the caret
      // with the browser's own text insertion inside a composition, so the
      // caret, the DOM, and the draft all take part.
      const text = step.text ?? "";
      const el = editor();
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
      await settle();
      continue;
    }
    if (step.op === "selectAll") {
      const el = editor();
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await settle();
      continue;
    }
    throw new Error("unknown step " + step.op);
  }

  return { ok: true, trace };
};

console.log("CARET_FIXTURE_READY");
