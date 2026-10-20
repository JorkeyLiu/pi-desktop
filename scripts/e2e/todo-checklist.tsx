// The external preload transport and the deterministic model stream are
// fixtures; the host, the agent runtime, the transcript row and its card are
// production code.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { SessionTodo, UiMessage } from "@pi-desktop/shared";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/*
 * The `TodoWrite` checklist as the product renders it: the production tool row
 * fed by a real host commit, driven in a real Chromium renderer with the app's
 * own stylesheet. Nothing here re-implements the card — the probe mounts the
 * transcript's own component and reads what it produced.
 */

declare global {
  interface Window {
    todoFixture: { action(name: string, input?: unknown): Promise<unknown> };
    todoChecklistProbe(): Promise<unknown>;
  }
}

type Written = {
  snapshot: { revision: number; todos: SessionTodo[] };
  toolArgs: unknown;
  toolResult: unknown;
  isError: boolean;
};

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } }, interpolation: { escapeValue: false } });

const action = (name: string, input?: unknown) => window.todoFixture.action(name, input) as Promise<unknown>;
const write = (sessionId: string, todos: SessionTodo[]) => action("write", { sessionId, todos }) as Promise<Written>;
const snapshot = (sessionId: string) => action("snapshot", sessionId) as Promise<{ revision: number; todos: SessionTodo[] }>;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await frame();
  }
  await frame();
}

/** A tool row exactly as `tool_end` persistence records one. */
function toolMessage(id: string, written: Omit<Written, "snapshot">): UiMessage {
  return {
    id,
    role: "tool",
    content: "",
    createdAt: new Date().toISOString(),
    status: "complete",
    toolName: "TodoWrite",
    toolCallId: id,
    toolArgs: written.toolArgs,
    toolStatus: written.isError ? "error" : "success",
    toolResult: written.toolResult,
    isError: written.isError,
  };
}

let root: ReturnType<typeof createRoot> | null = null;
let setMessage: ((message: UiMessage) => void) | null = null;
function Live({ initial }: { initial: UiMessage }) {
  const [current, setCurrent] = useState(initial);
  setMessage = setCurrent;
  return <ToolRow message={current} />;
}
function mount(message: UiMessage) {
  flushSync(() =>
    root!.render(
      <I18nextProvider i18n={i18n}>
        <TranscriptDisclosureProvider>
          <Live key={message.id} initial={message} />
        </TranscriptDisclosureProvider>
      </I18nextProvider>,
    ),
  );
}
/** Re-mount as a second card while the first still stands above it. */
function append(message: UiMessage) {
  const container = document.createElement("div");
  container.dataset.card = message.id;
  document.getElementById("transcript")!.append(container);
  const cardRoot = createRoot(container);
  flushSync(() =>
    cardRoot.render(
      <I18nextProvider i18n={i18n}>
        <TranscriptDisclosureProvider>
          <ToolRow message={message} />
        </TranscriptDisclosureProvider>
      </I18nextProvider>,
    ),
  );
  return container;
}
const mountRoot = () => {
  const host = document.createElement("div");
  host.id = "transcript";
  document.body.append(host);
  const container = document.createElement("div");
  container.dataset.card = "primary";
  host.append(container);
  root = createRoot(container);
  return container;
};

/** The card container under test; the primary one unless a card is passed. */
const card = (container?: HTMLElement) =>
  container ?? document.querySelector<HTMLElement>('[data-card="primary"]') ?? document;
const header = (container?: HTMLElement) =>
  card(container).querySelector<HTMLElement>(".tool-row-header");
const body = (container?: HTMLElement) => card(container).querySelector<HTMLElement>(".tool-row-body");
const rows = (container?: HTMLElement) => [...card(container).querySelectorAll<HTMLElement>(".tool-todo-row")];
const progress = (container?: HTMLElement) =>
  card(container).querySelector<HTMLElement>(".tool-todo-progress-text")?.textContent ?? "";

/** The body a row's disclosure names must be the body it renders. */
function assertDisclosureResolves(container: HTMLElement, where: string) {
  const controls = header(container)?.getAttribute("aria-controls");
  assert(controls, `${where}: the expanded row names no controlled element`);
  const target = document.getElementById(controls);
  assert(target, `${where}: aria-controls="${controls}" names no rendered element`);
  assert(target.classList.contains("tool-row-body"), `${where}: aria-controls does not name the body`);
}

window.todoChecklistProbe = async () => {
  const checks: string[] = [];
  const host = mountRoot();
  const live = useAppStore.getState().applyTodosChanged;
  const unsubscribe = api.onTodosChanged(live);
  const first = (await action("create", "Todo first")) as string;
  const second = (await action("create", "Todo second")) as string;

  // ── The row the agent wrote: open by default, committed rows, no JSON ──
  const initial = await write(first, [
    { content: "Read the row", status: "completed", priority: "medium" },
    { content: "Unify the card", status: "in_progress", priority: "high" },
    { content: "Write the check", status: "pending", priority: "medium" },
  ]);
  assert(initial.snapshot.revision === 1, "the first write must commit revision 1");
  const firstCard = toolMessage("call-todo-1", initial);
  mount(firstCard);
  await until(() => header()?.getAttribute("aria-expanded") === "true", "a checklist row opens itself");
  await until(() => rows().length === 3, "every committed row renders");
  assertDisclosureResolves(host, "a committed checklist");
  assert(progress() === "1/3 completed", `the progress line reports the host's counts (${progress()})`);
  assert(!body()!.textContent!.includes('"todos"'), "the card is never the serialized argument");
  assert(
    rows().map((row) => row.className.replace(/.*is-/, "")).join(",") === "completed,in_progress,pending",
    "the rows keep the host's order and states",
  );
  checks.push("agent-turn-card-opens-with-the-committed-rows");

  // A collapse is the reader's choice; the next update to that row keeps it.
  flushSync(() => header()!.click());
  await until(() => header()?.getAttribute("aria-expanded") === "false", "the row collapses");
  assert(!body(), "a collapsed row renders no body");
  flushSync(() => setMessage!({ ...firstCard }));
  await frame();
  assert(header()?.getAttribute("aria-expanded") === "false", "a later update does not reopen the row");
  flushSync(() => header()!.click());
  await until(() => Boolean(body()), "the row reopens");
  checks.push("collapse-survives-a-later-update");

  // ── A second write is its own card; the first keeps its own list ──
  const replacement = await write(first, [
    { content: "Only this remains", status: "completed", priority: "medium" },
    { content: "And this one", status: "completed", priority: "medium" },
  ]);
  assert(replacement.snapshot.revision === 2, "the second write advances the revision");
  const secondCard = append(toolMessage("call-todo-2", replacement));
  await until(() => rows(secondCard).length === 2, "the second card renders its own list");
  assert(progress(secondCard) === "2/2 completed", `the second card counts its own list (${progress(secondCard)})`);
  // The earlier row is derived from its own committed result, so a newer write
  // in the same session cannot rewrite the history above it.
  assert(rows().length === 3, `the earlier card keeps its own rows (${rows().length})`);
  assert(progress() === "1/3 completed", `the earlier card keeps its own counts (${progress()})`);
  assert(
    rows().some((row) => row.textContent!.includes("Unify the card")),
    "the earlier card still shows the item the later write dropped",
  );
  checks.push("earlier-card-keeps-its-own-committed-list");

  // ── Cancellation: counted, never silently folded into the ratio ──
  const mixed = await write(first, [
    { content: "Verified item", status: "completed", priority: "medium" },
    { content: "Dropped item", status: "cancelled", priority: "medium" },
    { content: "Still open", status: "pending", priority: "medium" },
  ]);
  const mixedCard = append(toolMessage("call-todo-3", mixed));
  await until(() => rows(mixedCard).length === 3, "the cancelled item is still listed");
  assert(progress(mixedCard) === "1/2 completed", `cancelled items leave the denominator (${progress(mixedCard)})`);
  assert(
    mixedCard.textContent!.includes("1 cancelled"),
    "the cancelled count is named beside the ratio",
  );
  assert(
    mixedCard.querySelector('[role="progressbar"]')?.getAttribute("aria-valuemax") === "2",
    "the bar spans the outstanding items only",
  );
  checks.push("mixed-cancellation-names-the-cancelled-count");

  const allCancelled = await write(first, [
    { content: "First dropped item", status: "cancelled", priority: "medium" },
    { content: "Second dropped item", status: "cancelled", priority: "medium" },
  ]);
  const cancelledCard = append(toolMessage("call-todo-4", allCancelled));
  await until(() => rows(cancelledCard).length === 2, "an all-cancelled list still lists its rows");
  assert(
    cancelledCard.textContent!.includes("All 2 items cancelled"),
    `the all-cancelled list says so (${progress(cancelledCard)})`,
  );
  assert(
    !cancelledCard.querySelector('[role="progressbar"]'),
    "a list with no outstanding item shows no progress bar",
  );
  assert(!cancelledCard.textContent!.includes("0/0"), "an all-cancelled list never reads 0/0");
  checks.push("all-cancelled-is-named-not-0-of-0");

  // ── Clearing: a committed empty list still has a body to point at ──
  const cleared = await write(first, []);
  assert(cleared.snapshot.revision === 5, "a clear advances the revision");
  assert(cleared.snapshot.todos.length === 0, "the clear is committed as an empty list");
  const clearedCard = append(toolMessage("call-todo-5", cleared));
  await until(() => Boolean(header(clearedCard)), "the cleared row renders");
  assertDisclosureResolves(clearedCard, "a cleared checklist");
  assert(rows(clearedCard).length === 0, "the cleared card lists no rows");
  assert(
    progress(clearedCard) === "Checklist cleared — no items",
    `the cleared card states what happened (${progress(clearedCard)})`,
  );
  assert(
    !clearedCard.querySelector('[role="progressbar"]'),
    "a cleared list shows no progress bar",
  );
  checks.push("cleared-checklist-has-a-body-and-says-so");

  // ── The host's normalization is what the card shows ──
  const normalized = await write(first, [
    { content: "😀".repeat(501), status: "in_progress", priority: "high" },
    { content: "Second active item", status: "in_progress", priority: "medium" },
  ]);
  const normalizedCard = append(toolMessage("call-todo-6", normalized));
  await until(() => rows(normalizedCard).length === 2, "the normalized list renders");
  const stored = normalized.snapshot.todos;
  assert([...stored[0].content].length === 500, "the host truncated the content to 500 characters");
  assert(stored[1].status === "pending", "the host kept only the first active item");
  const rendered = rows(normalizedCard).map((row) => row.querySelector(".tool-todo-content")!.textContent);
  assert([...rendered[0]!].length === 500, `the card shows the committed content (${[...rendered[0]!].length})`);
  assert(
    rows(normalizedCard)[1]!.className.includes("is-pending"),
    "the card shows the demoted state, not the requested one",
  );
  assert(
    normalizedCard.textContent!.includes("truncated to 500 characters"),
    "the truncation warning stays visible",
  );
  checks.push("host-normalization-is-what-the-card-shows");

  // ── A refused write is an error, never a list ──
  const refused = (await action("refuse", {
    sessionId: second,
    todos: [{ content: "Never committed", status: "in_progress", priority: "medium" }],
  })) as Omit<Written, "snapshot">;
  const refusedCard = append(toolMessage("call-todo-7", refused));
  await until(() => Boolean(header(refusedCard)), "the refused row renders");
  assert(rows(refusedCard).length === 0, "a refused write shows no checklist rows");
  assert(
    body(refusedCard)!.textContent!.includes("no longer running"),
    `the refusal stays diagnosable (${body(refusedCard)!.textContent})`,
  );
  assert(!body(refusedCard)!.textContent!.includes('"todos"'), "a refusal never prints the raw argument");
  assert(
    !(await snapshot(second)).todos.some((todo) => todo.content === "Never committed"),
    "the refused write committed nothing",
  );
  checks.push("refusal-shows-the-error-and-no-uncommitted-list");

  // ── A row persisted before the result carried a list keeps its argument ──
  const legacy = append(
    toolMessage("call-todo-legacy", {
      toolArgs: {
        todos: [
          { content: "Inspect", status: "completed", priority: "medium" },
          { content: "Patch", status: "cancelled", priority: "medium" },
        ],
      },
      toolResult: {
        content: [{ type: "text", text: "Checklist updated: 1/1 completed" }],
        details: {
          text: "Checklist updated: 1/1 completed",
          revision: 2,
          summary: { completed: 1, total: 1, inProgress: 0, cancelled: 1 },
          warnings: [],
        },
      },
      isError: false,
    }),
  );
  await until(() => rows(legacy).length === 2, "an older row still reads its own argument");
  assert(progress(legacy) === "1/1 completed", `an older row keeps its own counts (${progress(legacy)})`);
  checks.push("a-row-without-a-committed-list-falls-back-to-its-argument");

  // ── The snapshot contract: revisions order the pushes, nothing else ──
  const latest = await write(second, [
    { content: "Second session item", status: "in_progress", priority: "medium" },
  ]);
  await until(
    () => useAppStore.getState().sessionTodos[second]?.revision === latest.snapshot.revision,
    "the committed snapshot reaches the production store",
  );
  await action("event", { ...latest.snapshot, revision: latest.snapshot.revision - 1, todos: [] });
  await frame();
  assert(
    useAppStore.getState().sessionTodos[second]?.revision === latest.snapshot.revision,
    "a stale todos.changed cannot replace a newer snapshot",
  );
  checks.push("a-stale-todos.changed-cannot-replace-a-newer-snapshot");

  await action("suppressEvents", true);
  const durable = await write(first, [{ content: "Durable item", status: "pending", priority: "medium" }]);
  await action("restart");
  await action("suppressEvents", false);
  const recovered = await snapshot(first);
  assert(recovered.revision === durable.snapshot.revision, "the revision survives a host restart");
  assert(recovered.todos[0]?.content === "Durable item", "the committed list survives a host restart");
  checks.push("the-committed-list-survives-a-host-restart");

  unsubscribe();
  return {
    ok: true,
    checks,
    normalization: {
      unicodeScalars: [...stored[0].content].length,
      activeItems: stored.filter((todo) => todo.status === "in_progress").length,
      truncationWarning: normalizedCard.textContent!.includes("truncated to 500 characters"),
    },
    host: "real-stdio-sqlite",
    agent: "production-runtime-tool-search-todo-write",
    provider: "deterministic-event-stream-only",
    renderer: "production-transcript-tool-row-and-checklist-card",
  };
};
