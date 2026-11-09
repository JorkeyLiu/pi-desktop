// Native-wheel probe for tool-card scroll containment inside the transcript.
//
// The transcript itself, its scroll ownership, and every tool card rendered here
// are production code; the message history and the host shell are fixtures. The
// probe only mounts the transcript and reports geometry. Wheel input is
// delivered by the Electron main process as real `mouseWheel` input, so native
// scroll chaining and `overscroll-behavior` decide what moves.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";

type CardName = "short" | "long" | "values" | "document" | "fields";
type Point = { x: number; y: number };

type Snapshot = {
  outer: { scrollTop: number; scrollHeight: number; clientHeight: number };
  cards: Record<string, { scrollTop: number; scrollHeight: number; clientHeight: number }>;
  jump: boolean;
  olderReads: number;
};

declare global {
  interface Window {
    transcriptToolWheelProbe: {
      mount(): Promise<unknown>;
      place(which: CardName, alignPx: number, inner?: "top" | "bottom"): Promise<unknown>;
      points(which: CardName): Record<string, Point>;
      read(): Promise<Snapshot>;
      resetOlderReads(): number;
    };
  }
}

const createdAt = "2026-09-01T00:00:00Z";
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function frames(count = 2) {
  for (let index = 0; index < count; index++) await frame();
}

const rendererErrors: string[] = [];
addEventListener("error", (event) => rendererErrors.push(String(event.message)));

function prose(index: number): UiMessage {
  return {
    id: `prose-${index}`,
    role: "assistant",
    createdAt,
    status: "complete",
    content:
      `Reading row ${index}. ` +
      "Prose that wraps across the transcript column and makes the scroller overflow. ".repeat(4),
  };
}

type Item = { content: string; status: string; priority?: string };

function todoCard(id: string, items: Item[]): UiMessage {
  const completed = items.filter((item) => item.status === "completed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const inProgress = items.filter((item) => item.status === "in_progress").length;
  const total = items.length - cancelled;
  const text = `Checklist updated: ${completed}/${total} completed`;
  return {
    id,
    role: "tool",
    content: "",
    createdAt,
    status: "complete",
    toolName: "TodoWrite",
    toolCallId: id,
    toolArgs: { todos: items },
    toolStatus: "success",
    isError: false,
    toolResult: {
      content: [{ type: "text", text }],
      details: {
        text,
        revision: 1,
        summary: { completed, inProgress, total, cancelled },
        warnings: [],
        todos: items,
      },
    },
  } as UiMessage;
}

const SHORT_ITEMS: Item[] = [
  { content: "Read the row", status: "completed", priority: "medium" },
  { content: "Unify the card", status: "in_progress", priority: "high" },
  { content: "Write the check", status: "pending", priority: "medium" },
];

const LONG_ITEMS: Item[] = Array.from({ length: 25 }, (_, index) => ({
  content: `Checklist item ${index + 1}: keep the row readable while the list scrolls`,
  status: index < 4 ? "completed" : index === 4 ? "in_progress" : "pending",
  priority: "medium",
}));

/** A `ToolSearch` answer: the activated tools as a labelled scalar list. */
function valuesCard(id: string): UiMessage {
  return {
    id,
    role: "tool",
    content: "",
    createdAt,
    status: "complete",
    toolName: "ToolSearch",
    toolCallId: id,
    toolArgs: { query: "TodoWrite" },
    toolStatus: "success",
    isError: false,
    toolResult: {
      content: [{ type: "text", text: "Activated 2 tools" }],
      details: { activated: ["TodoWrite", "TaskCreate"] },
    },
  } as UiMessage;
}

/** A `Skill` answer: a short document body in the card. */
function documentCard(id: string): UiMessage {
  const body = "## Probe\n\nA short skill document body.\n\n- first line\n- second line\n";
  return {
    id,
    role: "tool",
    content: "",
    createdAt,
    status: "complete",
    toolName: "Skill",
    toolCallId: id,
    toolArgs: { id: "probe-skill" },
    toolStatus: "success",
    isError: false,
    toolResult: {
      content: [{ type: "text", text: body }],
      details: { text: body },
    },
  } as UiMessage;
}
/** A tool with no mapped presentation: its scalar details become field rows. */
function fieldsCard(id: string): UiMessage {
  return {
    id,
    role: "tool",
    content: "",
    createdAt,
    status: "complete",
    toolName: "ProbePluginTool",
    toolCallId: id,
    toolArgs: { alpha: "one" },
    toolStatus: "success",
    isError: false,
    toolResult: {
      content: [{ type: "text", text: "Probe tool finished" }],
      details: { alpha: "one", beta: "two" },
    },
  } as UiMessage;
}

/*
  Two checklists in one history: a long one near the top, so a gesture over its
  inner list starts with room to scroll while the transcript is still at its own
  top boundary, and a short one in the middle - the shape the reader reported
  (three rows, pointer inside the list's own padding).
*/
const messages: UiMessage[] = [
  { id: "start", role: "user", createdAt, status: "complete", content: "Start here." },
  todoCard("call-todo-long", LONG_ITEMS),
  ...Array.from({ length: 14 }, (_, index) => prose(index)),
  todoCard("call-todo-short", SHORT_ITEMS),
  ...Array.from({ length: 14 }, (_, index) => prose(100 + index)),
  valuesCard("call-values"),
  prose(200),
  documentCard("call-document"),
  prose(250),
  fieldsCard("call-fields"),
  ...Array.from({ length: 4 }, (_, index) => prose(300 + index)),
];

const i18n = createInstance();
const i18nReady = i18n.init({
  lng: "en",
  resources: { en: { translation: catalogs.en } },
  interpolation: { escapeValue: false },
});

let olderReads = 0;
let mounted = false;

const scroller = () => document.querySelector<HTMLElement>(".thread-scroll");
function requireScroller(): HTMLElement {
  const element = scroller();
  if (!element) throw new Error("the transcript scroller is not mounted");
  return element;
}

const CARD_SELECTOR: Record<CardName, string> = {
  short: '[data-probe-card="short"] .tool-todo-list',
  long: '[data-probe-card="long"] .tool-todo-list',
  values: '[data-probe-card="values"] .tool-values-list',
  document: '[data-probe-card="document"] .tool-document-body',
  fields: '[data-probe-card="fields"] .tool-fields:not(.tool-document-meta)',
};
/*

  The cards are production components with no identifying props, so the probe
  tags their rendered rows by their own committed content rather than by DOM
  order: the long checklist is the list with the most rows, the short one the
  other checklist.
*/
function tagCards() {
  for (const list of document.querySelectorAll<HTMLElement>(".tool-todo-list")) {
    const rows = list.querySelectorAll(".tool-todo-row").length;
    list
      .closest<HTMLElement>(".tool-row")
      ?.setAttribute("data-probe-card", rows > 10 ? "long" : "short");
  }
  for (const list of document.querySelectorAll<HTMLElement>(".tool-values-list")) {
    list.closest<HTMLElement>(".tool-row")?.setAttribute("data-probe-card", "values");
  }
  for (const body of document.querySelectorAll<HTMLElement>(".tool-document-body")) {
    body.closest<HTMLElement>(".tool-row")?.setAttribute("data-probe-card", "document");
  }
  for (const list of document.querySelectorAll<HTMLElement>(".tool-fields")) {
    if (list.classList.contains("tool-document-meta")) continue;
    list.closest<HTMLElement>(".tool-row")?.setAttribute("data-probe-card", "fields");
  }
}

function requireCard(which: CardName): HTMLElement {
  const element = document.querySelector<HTMLElement>(CARD_SELECTOR[which]);
  if (!element) throw new Error(`card ${which} is not rendered`);
  return element;
}

/** Wait until no scroll position changes for three consecutive frames. */
async function waitStable() {
  const readPositions = () => {
    const positions = [requireScroller().scrollTop];
    for (const element of document.querySelectorAll<HTMLElement>(
      ".tool-todo-list, .tool-values-list, .tool-document-body",
    )) {
      positions.push(element.scrollTop);
    }
    return positions.join(",");
  };
  let previous = readPositions();
  let stable = 0;
  const deadline = performance.now() + 3000;
  while (stable < 3) {
    if (performance.now() > deadline) return;
    await frame();
    const current = readPositions();
    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }
}

async function read(): Promise<Snapshot> {
  await waitStable();
  const element = requireScroller();
  const cards: Snapshot["cards"] = {};
  for (const which of Object.keys(CARD_SELECTOR) as CardName[]) {
    const card = document.querySelector<HTMLElement>(CARD_SELECTOR[which]);
    if (!card) continue;
    cards[which] = {
      scrollTop: card.scrollTop,
      scrollHeight: card.scrollHeight,
      clientHeight: card.clientHeight,
    };
  }
  return {
    outer: {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    },
    cards,
    jump: Boolean(document.querySelector(".jump-latest-btn")),
    olderReads,
  };
}

/*
  Point geometry is measured here, in the renderer, and handed to the main
  process, which delivers the real wheel input at that position.
*/
function points(which: CardName) {
  const element = requireCard(which);
  const rect = element.getBoundingClientRect();
  const centerX = Math.round(rect.left + rect.width / 2);
  const result: Record<string, Point> = {
    topPadding: { x: centerX, y: Math.round(rect.top + 3) },
    bottomPadding: { x: centerX, y: Math.round(rect.bottom - 3) },
    inner: { x: centerX, y: Math.round(rect.top + Math.min(rect.height - 10, 40)) },
  };
  const scrollerRect = requireScroller().getBoundingClientRect();
  result.gutter = {
    x: Math.round(scrollerRect.left + 6),
    y: Math.round(scrollerRect.top + 60),
  };
  const progress = document.querySelector<HTMLElement>(
    '[data-probe-card="short"] .tool-todo-progress',
  );
  if (which === "short" && progress) {
    const progressRect = progress.getBoundingClientRect();
    result.progress = {
      x: Math.round(progressRect.left + progressRect.width / 2),
      y: Math.round(progressRect.top + progressRect.height / 2),
    };
    result.gap = { x: centerX, y: Math.round((progressRect.bottom + rect.top) / 2) };
  }
  return result;
}

async function mountTranscript() {
  await i18nReady;
  const shell = document.createElement("div");
  shell.id = "probe-shell";
  shell.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(shell);
  const root = createRoot(shell);
  flushSync(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <ChatTranscript
          sessionId="wheel-fixture"
          messages={messages}
          isRunning={false}
          hasMoreBefore
          onLoadOlder={async () => {
            olderReads += 1;
          }}
        />
      </I18nextProvider>,
    ),
  );
  const firstFrameDeadline = performance.now() + 6000;
  while (!scroller() && performance.now() < firstFrameDeadline) await frame();
  if (!scroller()) {
    throw new Error(
      "the transcript scroller is not mounted; shell=" +
        shell.innerHTML.slice(0, 400) +
        "; errors=" +
        rendererErrors.join(" | "),
    );
  }
  // The transcript settles behind a veil before its first position means
  // anything; the probe waits for the same lift a reader sees.
  const deadline = performance.now() + 10000;
  while (document.querySelector('[data-transcript-settling="true"]')) {
    if (performance.now() > deadline) throw new Error("the transcript never settled");
    await frame();
  }
  await frames(4);
  // A reader expands the rows they want to read; the checks below measure the
  // cards' own scroll surfaces, which only exist while their row is open.
  for (let pass = 0; pass < 2; pass++) {
    const collapsed = [
      ...document.querySelectorAll<HTMLElement>('.tool-row-header[aria-expanded="false"]'),
    ];
    if (collapsed.length === 0) break;
    for (const header of collapsed) header.click();
    await frames(3);
  }
  tagCards();
  const element = requireScroller();
  return {
    mounted: true,
    outer: {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    },
    cards: [...document.querySelectorAll("[data-probe-card]")].map(
      (card) => (card as HTMLElement).dataset.probeCard,
    ),
    todoLists: document.querySelectorAll(".tool-todo-list").length,
    errors: rendererErrors,
  };
}

window.transcriptToolWheelProbe = {
  async mount() {
    if (mounted) return { mounted: true };
    const result = await mountTranscript();
    mounted = true;
    return result;
  },

  async place(which: CardName, alignPx: number, inner: "top" | "bottom" = "top") {
    const element = requireScroller();
    const card = requireCard(which);
    card.scrollTop = inner === "top" ? 0 : card.scrollHeight - card.clientHeight;
    const outerRect = element.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    element.scrollTop += rect.top - (outerRect.top + alignPx);
    await frames(3);
    return { outerScrollTop: element.scrollTop, innerScrollTop: card.scrollTop };
  },

  points,
  read,

  resetOlderReads() {
    olderReads = 0;
    return olderReads;
  },
};
