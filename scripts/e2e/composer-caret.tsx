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
 * rendered line of the caret and of the last text run, chips, and the text a
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
}

type CursorStep = {
  op: string;
  text?: string;
  key?: string;
  label?: string;
  caret?: number;
  /** Element a real pointer click is aimed at. */
  target?: "chip-name" | "chip-remove";
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

/**
 * Ask the driver for one real pointer click at the element's centre. The
 * browser, not the fixture, decides where clicking a non-editable chip puts
 * the selection — which is the reported case.
 */
const clickPointer = (element: Element) => {
  const rect = element.getBoundingClientRect();
  const done = new Promise<void>((resolve) => {
    (globalThis as unknown as { composerCaretPointerDone: () => void }).composerCaretPointerDone = resolve;
  });
  console.log(
    "PI_CARET_POINTER:" +
      JSON.stringify({
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      }),
  );
  return done;
};

/** Where the browser put the selection, for the chip-boundary assertions. */
const selectionPoint = () => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const describe = (node: Node | null, offset: number) => {
    if (!node) return null;
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
    const chip = element?.closest(".composer-chip");
    return {
      kind: node.nodeType === Node.TEXT_NODE ? "text" : (node as HTMLElement).nodeName,
      parentClass:
        node.nodeType === Node.TEXT_NODE ? (node.parentElement?.className ?? "") : "",
      insideChip: Boolean(chip),
      chipPart: element?.className ?? "",
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
    lastChild: el.lastChild?.nodeName ?? null,
    chips: Array.from(el.querySelectorAll<HTMLElement>(".composer-chip")).map(
      (chip) => chip.dataset.token ?? "",
    ),
    tokens: controller.fileReferences.map((reference) => reference.token ?? ""),
    submission: controller.draftSnapshot(draftValue).text,
    selection: window.getSelection()?.toString() ?? "",
    point: selectionPoint(),
    events: nativeEvents.splice(0, nativeEvents.length),
  };
};

const chipReference = (name: string) =>
  createFileReference(`/caret-workspace/${name}`, name, "caret-session");

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
    if (step.op === "chip") {
      const reference = chipReference(step.text ?? "notes.txt");
      const token = "\uE010";
      const withToken = { ...reference, token };
      const text = `见 ${token}\n`;
      flushSync(() =>
        controller.applyEditorDraft(text, [withToken], text.length),
      );
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
    if (step.op === "pointer") {
      // A real click on the chip's label or its remove button: the browser
      // chooses the selection point inside the non-editable chip.
      const selector =
        step.target === "chip-remove" ? ".composer-chip-remove" : ".composer-chip-name";
      const target = editor().querySelector(selector);
      if (!target) throw new Error("pointer target missing: " + selector);
      await clickPointer(target);
      await settle();
      continue;
    }
    if (step.op === "chipMid") {
      // A chip that is not the last thing in the draft, so a point mapped past
      // it is distinguishable from the end of the draft.
      const reference = { ...chipReference(step.text ?? "notes.txt"), token: "\uE010" };
      const text = `见 ${reference.token}后面`;
      flushSync(() => controller.applyEditorDraft(text, [reference], text.length));
      await settle();
      continue;
    }
    if (step.op === "innerSelection") {
      // A collapsed selection inside the chip's own label text: markup the
      // draft model cannot address, which a click or an assistive caret can.
      const label = editor().querySelector(".composer-chip-name")?.firstChild;
      if (!label) throw new Error("chip label missing");
      const range = document.createRange();
      range.setStart(label, step.caret ?? 2);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await settle();
      continue;
    }
    if (step.op === "innerSelectionDrag") {
      // A drag whose anchor is the label text and whose focus is the remove
      // button: both ends live inside the non-editable chip.
      const label = editor().querySelector(".composer-chip-name")?.firstChild;
      const remove = editor().querySelector(".composer-chip-remove");
      if (!label || !remove) throw new Error("chip markup missing");
      const range = document.createRange();
      range.setStart(label, step.caret ?? 2);
      range.setEnd(remove, 0);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await settle();
      continue;
    }
    if (step.op === "recallCaret") {
      // Re-enter the draft at the caret index the app stored — the same index a
      // completion splice uses — so a chip-interior misread becomes visible.
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
