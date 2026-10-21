import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState, type ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { ActivityItems } from "../../apps/desktop/src/features/chat/transcript/ActivityItems";
import { SubagentTitleProvider } from "../../apps/desktop/src/lib/subagent-title-provider";
import { SubagentChainMetricsProvider } from "../../apps/desktop/src/lib/subagent-metrics-provider";
import { aggregateChainMetricsFromMessages } from "../../apps/desktop/src/lib/subagent-metrics";
import { subagentMetricsLine } from "../../apps/desktop/src/lib/subagent-ui-metrics";

declare global {
  var toolCardsProbe: () => Promise<unknown>;
  /** Scroll the narrow path rows into the frame the probe screenshots. */
  var toolCardsPathFocus: (() => void) | undefined;
}

/*
 * The unified tool cards in a real Chromium renderer with the application's own
 * stylesheet: the same components the transcript mounts, the same one-column
 * terminal at every width, the same copy controls and the same disclosure
 * state. Nothing here re-implements a card; the probe only drives and measures
 * what the app renders.
 */

const createdAt = "2026-10-18T00:00:00.000Z";

function message(
  id: string,
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role: "tool", content, createdAt, ...extra };
}

const COMMAND = "pnpm test --filter desktop --reporter=dot";
const STDOUT = [
  "\u001b[32m✓\u001b[0m tool-presentation.test.mjs",
  "\u001b[1m3 passing\u001b[0m",
  "",
].join("\n");
const STDERR = "\u001b[31m✗\u001b[0m 1 failing assertion\n";
const LONG_PATH =
  "/Users/me/workspace/repos/pi-desktop/apps/desktop/src/components/transcript/nested/tool/ToolTerminal.tsx";

const bash = (id: string, running = false): UiMessage =>
  message(id, "", {
    toolName: "Bash",
    toolCallId: `call-${id}`,
    toolStatus: running ? "running" : "success",
    toolArgs: { command: COMMAND, description: "Run the desktop tests" },
    toolResult: {
      details: running
        ? {
            output: Array.from({ length: 80 }, (_v, i) => `step ${i}`).join("\n"),
          }
        : { exitCode: 0, stdout: STDOUT, stderr: STDERR },
    },
  });


/** A command still writing: the shell appends one line per update. */
const bashWithLines = (id: string, lines: number): UiMessage =>
  message(id, "", {
    toolName: "Bash",
    toolCallId: `call-${id}`,
    toolStatus: "running",
    toolArgs: { command: COMMAND, description: "Run the desktop tests" },
    toolResult: {
      details: {
        output: Array.from({ length: lines }, (_v, i) => `step ${i}`).join("\n"),
      },
    },
  });
const todos = (id: string, status: "running" | "success"): UiMessage =>
  message(id, "", {
    toolName: "TodoWrite",
    toolCallId: `call-${id}`,
    toolStatus: status,
    toolArgs: {
      todos: [
        { content: "Read the current tool row", status: "completed" },
        { content: "Unify every tool card", status: "in_progress", priority: "high" },
        { content: "Write the rendered check", status: "pending" },
      ],
    },
    toolResult: {
      details: {
        text: "Checklist updated: 1/3 completed",
        summary: { completed: 1, total: 3, inProgress: 1, cancelled: 0 },
      },
    },
  });

const editWithReview = (id: string): UiMessage =>
  message(id, "", {
    toolName: "Edit",
    toolCallId: `call-${id}`,
    toolStatus: "success",
    toolArgs: { path: LONG_PATH, tag: "A1B2" },
    toolResult: {
      details: {
        path: LONG_PATH,
        root: "workspace",
        review: {
          version: 1,
          snapshotId: "snap-1",
          messageId: id,
          path: LONG_PATH,
          status: "modified",
          operation: "edit",
          state: "active",
          additions: 3,
          deletions: 2,
          hunks: [
            {
              header: "@@ -1,2 +1,3 @@",
              lines: [
                { type: "context", text: "const a = 1;" },
                { type: "del", text: "const b = 2;" },
                { type: "add", text: "const b = 3;" },
              ],
            },
          ],
          reversible: true,
        },
      },
    },
  });

const SKILL_TEXT = [
  "# Skill: Release notes (release-notes)",
  "Location: /skills/release-notes/SKILL.md",
  "References are relative to /skills/release-notes.",
  "",
  "# Release notes",
  "Write the entry from the diff.",
].join("\n");

const skillDoc = (id: string): UiMessage =>
  message(id, "", {
    toolName: "Skill",
    toolCallId: `call-${id}`,
    toolStatus: "success",
    toolArgs: { id: "release-notes" },
    toolResult: SKILL_TEXT,
  });

const skillError = (id: string): UiMessage =>
  message(id, "", {
    toolName: "Skill",
    toolCallId: `call-${id}`,
    toolStatus: "error",
    toolArgs: { id: "missing" },
    toolResult: 'Skill "missing" was not found',
  });

/** A search that matched nothing: the empty answer is the result. */
const emptySearch = (id: string): UiMessage =>
  message(id, "", {
    toolName: "Grep",
    toolCallId: `call-${id}`,
    toolStatus: "success",
    toolArgs: { pattern: "nothing-matches" },
    toolResult: {
      content: [{ type: "text", text: '{"matches":[]}' }],
      details: { matches: [], count: 0, truncated: false },
    },
  });

/** A stop request with one worker stopped and one that never confirmed. */
const stopRoster = (id: string): UiMessage =>
  message(id, "", {
    toolName: "TaskStop",
    toolCallId: `call-${id}`,
    toolStatus: "success",
    toolArgs: { delegationIds: ["a", "b"] },
    toolResult: {
      content: [
        {
          type: "text",
          text: "Cancellation requested for 2 subagents; 1 have not confirmed termination and remain running.",
        },
      ],
      details: {
        stopped: [{ delegationId: "a", agent: "fixer", status: "stopped" }],
        stopPending: [{ delegationId: "b", agent: "runner", status: "running" }],
      },
    },
  });

const unknownPayload = (id: string): UiMessage =>
  message(id, "", {
    toolName: "plugin_issue_tracker_create",
    toolCallId: `call-${id}`,
    toolStatus: "success",
    toolArgs: { title: "Bug 41" },
    toolResult: {
      content: [{ type: "text", text: '{"id":41}' }],
      details: { id: 41, url: "https://example.test/41", labels: ["bug", "ui"] },
    },
  });

const DELEGATE_MODEL = "claude-sonnet-4-5";

/**
 * One `Task` call as the runtime stores it: the title the model wrote in
 * `description`, the brief in `task`, the delegation identity in the result,
 * and the resolved model/reasoning pair the card must no longer print.
 */
const taskCall = (
  id: string,
  {
    description,
    delegationId,
    agent = "manifestor",
    resume,
    status = "completed",
    thinkingLevel = "high",
    metrics,
  }: {
    description?: string;
    delegationId: string;
    agent?: string;
    resume?: string;
    status?: "running" | "completed";
    thinkingLevel?: string;
    /** The counters this run reported; the default is one run's own figures. */
    metrics?: Record<string, unknown>;
  },
): UiMessage =>
  message(id, "", {
    toolName: "Task",
    toolCallId: `call-${id}`,
    toolStatus: status === "running" ? "running" : "success",
    toolArgs: {
      agent,
      task: "Investigate the cache invalidation path and report back in one paragraph.",
      ...(description === undefined ? {} : { description }),
      ...(resume === undefined ? {} : { resume }),
    },
    toolResult: {
      details: {
        delegationId,
        agent,
        status,
        startedAt: Date.parse(createdAt),
        modelId: DELEGATE_MODEL,
        thinkingLevel,
        ...(metrics ?? {
          toolCalls: 2,
          turns: 1,
          // The child's own occupancy and its own cumulative spend, so the card
          // and the dock state the same four figures for the same report.
          contextTokens: 12_000,
          usage: { totalTokens: 3_400 },
        }),
      },
    },
  });

/** What the model wrote as the task title, and what a continuation sends. */
const TASK_TITLE = "Reconcile child card titles";
const CONTINUATION_TITLE = "Continue the reconciliation";
// Long enough to overrun two lines at the card's widest column, so the clamp
// is what keeps the card from stretching rather than the text being short.
const LONG_TASK_TITLE =
  "Reconcile every delegation card and work-panel tab title with the task description originally stored on the first Task call of its resume chain, so a card, the tab it opens and the strip that lists it all read the same work however narrow the sidebar or however wide the transcript happens to be";

type Probe = {
  failures: string[];
  observed: Record<string, unknown>;
};

const settle = async (ticks = 4) => {
  for (let tick = 0; tick < ticks; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};

const tracks = (value: string) => value.split(" ").filter(Boolean).length;


/**
 * Two cards of one chain whose messages can be replaced, exactly as a live
 * resume segment is replaced when its run reports again.
 */
let chainLiveSetter: ((messages: UiMessage[]) => void) | null = null;
function LiveChain({
  initial,
  render,
}: {
  initial: UiMessage[];
  render: (messages: UiMessage[]) => ReactNode;
}) {
  const [messages, setMessages] = useState(initial);
  chainLiveSetter = setMessages;
  return (
    <SubagentTitleProvider messages={messages}>
      <SubagentChainMetricsProvider messages={messages}>
        {render(messages)}
      </SubagentChainMetricsProvider>
    </SubagentTitleProvider>
  );
}
/** A row whose message can be replaced, exactly as streaming replaces it. */
function Live({ initial }: { initial: UiMessage }) {
  const [current, setCurrent] = useState(initial);
  liveSetter = setCurrent;
  return <ToolRow message={current} />;
}
let liveSetter: ((message: UiMessage) => void) | null = null;

globalThis.toolCardsProbe = async () => {
  const probe: Probe = { failures: [], observed: {} };
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) probe.observed[name] = detail ?? true;
    else probe.failures.push(`${name}: ${JSON.stringify(detail ?? null)}`);
  };

  const renderErrors: unknown[] = [];
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });

  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });

  const stage = document.createElement("div");
  stage.id = "stage";
  stage.style.cssText = "display:flex;gap:16px;align-items:flex-start;padding:12px";
  const narrow = document.createElement("div");
  narrow.style.width = "340px";
  const wide = document.createElement("div");
  wide.style.width = "900px";
  stage.append(narrow, wide);
  document.body.append(stage);

  const roots: Array<{ unmount: () => void }> = [];
  const mount = (container: HTMLElement, node: ReactNode) => {
    const host = document.createElement("div");
    container.append(host);
    const root = createRoot(host, {
      onUncaughtError: (error: unknown) => renderErrors.push(error),
    });
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptDisclosureProvider>{node}</TranscriptDisclosureProvider>
        </I18nextProvider>,
      ),
    );
    roots.push(root);
    return host;
  };

  const open = async (host: HTMLElement) => {
    const header = host.querySelector<HTMLElement>(".tool-row-header");
    if (!header) throw new Error("no tool row header rendered");
    header.click();
    await settle();
  };

  try {
    // ── 1. The terminal: one column at every width, output under the command ──
    const narrowBash = mount(narrow, <ToolRow message={bash("bash-narrow")} />);
    const wideBash = mount(wide, <ToolRow message={bash("bash-wide")} />);
    await open(narrowBash);
    await open(wideBash);

    const terminalOf = (host: HTMLElement) =>
      host.querySelector<HTMLElement>(".tool-terminal");
    const narrowTerminal = terminalOf(narrowBash);
    const wideTerminal = terminalOf(wideBash);
    check("terminal renders in both columns", Boolean(narrowTerminal && wideTerminal));
    const narrowTracks = tracks(
      getComputedStyle(narrowTerminal!).gridTemplateColumns,
    );
    const wideTracks = tracks(getComputedStyle(wideTerminal!).gridTemplateColumns);
    check(
      "the command owns a single column at every width",
      narrowTracks === 1 && wideTracks === 1,
      {
        narrowTracks,
        wideTracks,
        narrowWidth: Math.round(narrowTerminal!.getBoundingClientRect().width),
        wideWidth: Math.round(wideTerminal!.getBoundingClientRect().width),
      },
    );

    const paneBox = (host: HTMLElement, selector: string) =>
      host.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const wideCommand = paneBox(wideBash, ".tool-terminal-pane.is-command");
    const wideOutput = paneBox(wideBash, ".tool-terminal-pane.is-output");
    const narrowCommand = paneBox(narrowBash, ".tool-terminal-pane.is-command");
    const narrowOutput = paneBox(narrowBash, ".tool-terminal-pane.is-output");
    check(
      "wide: the output sits below the command on the same left edge",
      wideOutput.top > wideCommand.bottom - 2 &&
        Math.abs(wideOutput.left - wideCommand.left) < 2,
      {
        commandBottom: wideCommand.bottom,
        outputTop: wideOutput.top,
        commandLeft: wideCommand.left,
        outputLeft: wideOutput.left,
      },
    );
    check(
      "narrow: output stacks under the command",
      narrowOutput.top > narrowCommand.bottom - 2 &&
        Math.abs(narrowOutput.left - narrowCommand.left) < 2,
      {
        commandBottom: narrowCommand.bottom,
        outputTop: narrowOutput.top,
        commandLeft: narrowCommand.left,
        outputLeft: narrowOutput.left,
      },
    );
    // No terminal carries the retired split marker: whatever the width, the
    // command pane is never asked to share the row.
    check(
      "no terminal marks itself as split",
      !document.querySelector(".tool-terminal.is-split"),
      document.querySelector(".tool-terminal")?.className,
    );

    // ── 2. ANSI output is painted, never printed as escapes ──
    const output = wideBash.querySelector<HTMLElement>(
      ".tool-terminal-stream.is-stdout .tool-terminal-output",
    )!;
    const green = output.querySelector<HTMLElement>("span.is-green");
    const bold = output.querySelector<HTMLElement>("span.is-bold");
    const stderrPane = wideBash.querySelector<HTMLElement>(
      ".tool-terminal-stream.is-stderr .tool-terminal-output",
    );
    check(
      "stdout colour is painted as spans",
      Boolean(green) && green!.textContent === "✓",
      green?.className,
    );
    check("bold runs carry their weight", Boolean(bold) && bold!.textContent === "3 passing");
    check(
      "no escape byte reaches the rendered text",
      !output.textContent!.includes("\u001b") &&
        !stderrPane!.textContent!.includes("\u001b"),
      JSON.stringify(output.textContent),
    );
    check(
      "stderr keeps its own tint and channel",
      stderrPane!.classList.contains("is-error"),
      stderrPane!.className,
    );

    // ── 3. Copy controls hand back the bytes they label ──
    const clickCopy = async (host: HTMLElement, selector: string) => {
      const button = host.querySelector<HTMLElement>(selector);
      if (!button) throw new Error(`no copy control at ${selector}`);
      button.click();
      await settle(2);
      return copied.at(-1);
    };
    const copiedCommand = await clickCopy(
      wideBash,
      ".tool-terminal-pane.is-command .tool-row-copy",
    );
    const copiedStdout = await clickCopy(
      wideBash,
      ".tool-terminal-stream.is-stdout .tool-row-copy",
    );
    check("the command pane copies the command", copiedCommand === COMMAND, copiedCommand);
    check(
      "the output pane copies the raw output",
      copiedStdout === STDOUT && copiedStdout.includes("\u001b[32m"),
      JSON.stringify(copiedStdout?.slice(0, 24)),
    );

    // ── 4. Todo: open by default, collapsible, and the choice survives ──
    const todoHost = mount(wide, <Live initial={todos("todo-1", "running")} />);
    const todoHeader = () => todoHost.querySelector<HTMLElement>(".tool-row-header")!;
    const todoBody = () => todoHost.querySelector<HTMLElement>(".tool-row-body");
    await settle();
    check(
      "a checklist row opens itself",
      todoHeader().getAttribute("aria-expanded") === "true" && Boolean(todoBody()),
    );
    const rows = todoHost.querySelectorAll(".tool-todo-row");
    check("every checklist item renders with its own state", rows.length === 3, rows.length);
    check(
      "the checklist is not a serialized argument",
      !todoBody()!.textContent!.includes('"todos"') &&
        !todoBody()!.textContent!.includes('"status"'),
    );
    check(
      "the progress line reports what the host counted",
      /1\s*\/\s*3/.test(
        todoHost.querySelector<HTMLElement>(".tool-todo-progress-text")!.textContent!,
      ),
      todoHost.querySelector<HTMLElement>(".tool-todo-progress-text")!.textContent,
    );

    todoHeader().click();
    await settle();
    check(
      "collapsing a checklist hides its body",
      todoHeader().getAttribute("aria-expanded") === "false" && todoBody() === null,
    );
    // A streaming update replaces the message object; the reader's choice is
    // what survives, not the derived default.
    flushSync(() => liveSetter!(todos("todo-1", "success")));
    await settle();
    check(
      "a streaming update does not reopen a collapsed checklist",
      todoHeader().getAttribute("aria-expanded") === "false" &&
        todoBody() === null,
    );
    todoHeader().click();
    await settle();
    flushSync(() => liveSetter!(todos("todo-1", "running")));
    await settle();
    check(
      "reopening survives the next update",
      todoHeader().getAttribute("aria-expanded") === "true" && Boolean(todoBody()),
    );

    // ── 5. A path summary names its file and keeps the whole value ──
    const editHost = mount(wide, <ToolRow message={editWithReview("edit-1")} />);
    await settle();
    const summary = editHost.querySelector<HTMLElement>(".tool-row-summary")!;
    check(
      "a long path prints the file's own name",
      summary.textContent === "ToolTerminal.tsx",
      summary.textContent,
    );
    check(
      "the summary carries the whole value as its title",
      summary.title === LONG_PATH,
      summary.title,
    );
    check(
      "the name is painted without overflowing its row",
      summary.scrollWidth <= summary.clientWidth + 1,
      { scrollWidth: summary.scrollWidth, clientWidth: summary.clientWidth },
    );
    const counts = editHost.querySelector<HTMLElement>(
      ".tool-row-header > .review-change-card-counts",
    );
    const countsStyle = counts ? getComputedStyle(counts) : null;
    check(
      "a review row ends with its +additions/−deletions",
      Boolean(counts) &&
        counts!.textContent!.includes("+3") &&
        counts!.textContent!.includes("−2") &&
        countsStyle!.flexShrink === "0",
      counts?.textContent,
    );

    await open(editHost);
    const diffAdd = editHost.querySelectorAll(".review-change-diff .diff-line.add");
    const rollback = editHost.querySelector<HTMLElement>(".review-change-rollback");
    check(
      "expanding a review row shows its diff and its rollback",
      diffAdd.length === 1 && Boolean(rollback),
      diffAdd.length,
    );
    const rolledBack: Array<[string, string]> = [];
    useAppStore.setState({
      rollbackWorkspaceChange: async (messageId: string, snapshotId: string) => {
        rolledBack.push([messageId, snapshotId]);
      },
    });
    // The store notifies its subscribers synchronously, but React renders on
    // the next commit; click only once that render has landed.
    await settle();
    rollback!.click();
    await settle();
    check(
      "the rollback action names the message and snapshot",
      rolledBack.length === 1 &&
        rolledBack[0][0] === "edit-1" &&
        rolledBack[0][1] === "snap-1",
      rolledBack,
    );

    // The transcript composition itself: one row per change, never a second
    // collapsed row naming the same file (D192).
    const turnHost = mount(
      wide,
      <AssistantTurn
        entry={
          buildTranscriptEntries([editWithReview("edit-turn")]).entries.find(
            (entry) => entry.kind === "assistant-turn",
          ) as never
        }
        isActive={false}
      />,
    );
    await settle();
    const turnRows = turnHost.querySelectorAll(
      '.tool-row[data-message-id="edit-turn"]',
    );
    const turnCards = turnHost.querySelectorAll(".review-change-card");
    check(
      "one tool row hosts the change, with no second file-name row",
      turnRows.length === 1 &&
        turnCards.length === 0 &&
        turnHost.querySelectorAll(".review-change-card-counts").length === 1,
      { turnRows: turnRows.length, turnCards: turnCards.length },
    );

    // ── 6. The loaded document and its failure ──
    const skillHost = mount(wide, <ToolRow message={skillDoc("skill-1")} />);
    await open(skillHost);
    const documentCard = skillHost.querySelector<HTMLElement>(".tool-document");
    check(
      "a Skill answer renders as the document it loaded",
      Boolean(documentCard) &&
        documentCard!.querySelector(".tool-document-title")!.textContent ===
          "Release notes" &&
        documentCard!.querySelector(".tool-document-id")!.textContent ===
          "release-notes" &&
        documentCard!.querySelector(".tool-document-body")!.textContent!.includes(
          "Write the entry from the diff.",
        ),
      documentCard?.textContent?.slice(0, 60),
    );
    check(
      "the document keeps the metadata the tool reported",
      documentCard!.textContent!.includes("/skills/release-notes/SKILL.md"),
    );

    const skillErrorHost = mount(wide, <ToolRow message={skillError("skill-2")} />);
    await open(skillErrorHost);
    const errorNote = skillErrorHost.querySelector<HTMLElement>(".tool-note.is-error");
    check(
      "a failed Skill call reads as an error, not a document",
      Boolean(errorNote) &&
        errorNote!.textContent!.includes("was not found") &&
        !skillErrorHost.querySelector(".tool-document"),
      errorNote?.textContent,
    );

    // ── 7. An unknown payload: fields plus its own disclosure ──
    const unknownHost = mount(wide, <ToolRow message={unknownPayload("unknown-1")} />);
    await open(unknownHost);
    const raw = unknownHost.querySelector<HTMLElement>(".tool-raw");
    check(
      "an unknown payload offers its raw form behind a disclosure",
      Boolean(raw) &&
        raw!.querySelector("summary")!.textContent!.length > 0 &&
        Boolean(raw!.querySelector(".tool-raw-content")),
    );
    check(
      "the readable fields come first",
      unknownHost.textContent!.includes("https://example.test/41") &&
        !unknownHost.querySelector(".tool-row-body")!.textContent!.includes('"details"'),
    );
    // The raw entry names itself once: its own disclosure summary, with no
    // second "Details"/"Raw" heading above the same bytes.
    const unknownHeads = [
      ...unknownHost.querySelectorAll(".tool-row-section-head"),
    ].map((head) => head.textContent ?? "");
    check(
      "the raw entry is named once",
      unknownHeads.filter((text) => text.trim() !== "").join("|") ===
        "Details|labels" &&
        unknownHost.querySelector(".tool-raw-summary")!.textContent === "Raw",
      {
        heads: unknownHeads,
        summary: unknownHost.querySelector(".tool-raw-summary")?.textContent,
      },
    );

    // An empty search states its empty result, without a heading above the
    // sentence and without printing the payload's count/truncated metadata.
    const emptyHost = mount(wide, <ToolRow message={emptySearch("empty-1")} />);
    await open(emptyHost);
    const emptyBody = emptyHost.querySelector<HTMLElement>(".tool-row-body");
    check(
      "an empty search says it matched nothing",
      Boolean(emptyBody) &&
        emptyBody!.textContent!.includes("No matches") &&
        emptyHost.querySelector(".tool-row-section-head") === null &&
        !emptyBody!.textContent!.includes("truncated"),
      emptyBody?.textContent,
    );

    // A stop roster keeps each outcome its own heading, in the reader's words.
    const stopHost = mount(wide, <ToolRow message={stopRoster("stop-1")} />);
    await open(stopHost);
    const stopHeads = [...stopHost.querySelectorAll(".tool-row-section-head")].map(
      (head) => head.textContent,
    );
    check(
      "a stop roster heads each outcome",
      stopHeads.includes("Stopped") &&
        stopHeads.includes("Stop requested — still running"),
      stopHeads,
    );
    check(
      "a stop roster is not a payload dump",
      !stopHost.querySelector(".tool-row-body")!.textContent!.includes("stopPending") &&
        stopHost.querySelector(".tool-raw") === null,
    );
    const liveBash = mount(narrow, <Live initial={bashWithLines("bash-live", 2)} />);
    await open(liveBash);
    const containers = () => [
      ...liveBash.querySelectorAll<HTMLElement>(".tool-row-body .tool-row-content"),
    ];
    const distance = (element: HTMLElement) =>
      element.scrollHeight - element.scrollTop - element.clientHeight;
    let worstDistance = 0;
    let grew = false;
    // A command writes a line at a time; the row's own layout effect is what
    // keeps the newest line in view as the output passes the height cap.
    for (let lines = 3; lines <= 60; lines += 1) {
      flushSync(() => liveSetter!(bashWithLines("bash-live", lines)));
      await settle(1);
      const element = containers()[0];
      if (!element) continue;
      if (element.scrollHeight > element.clientHeight) grew = true;
      worstDistance = Math.max(worstDistance, distance(element));
    }
    const finalContainers = containers();
    check(
      "a running command's output follows its newest line",
      grew &&
        finalContainers.length > 0 &&
        finalContainers.every((element) => element.scrollTop > 0) &&
        worstDistance < 40,
      {
        worstDistance,
        final: finalContainers.map((element) => ({
          scrollTop: Math.round(element.scrollTop),
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        })),
      },
    );
    // ── 8. Every `Task` call is its own child card ──
    // The transcript's own mount renders these: `ActivityItems`, one per
    // activity part, under the conversation-wide title provider, with the
    // store's real tab machinery behind the card's click.
    useAppStore.setState({
      activeSessionId: "session-cards",
      sessions: [
        {
          id: "session-cards",
          source: "desktop",
          title: "fixture",
          messageCount: 0,
          mode: "agent",
          thinkingLevel: "medium",
          permissionMode: "inherit",
          createdAt: createdAt,
          updatedAt: createdAt,
        },
      ],
      workPanelTabs: [],
      activeWorkPanelTabId: null,
    });
    // One chain, two runs with their own counters: the resume segment did most
    // of the work, so a per-invocation figure on either card would disagree with
    // the child's own tab header, which states the chain's totals.
    const original = taskCall("task-original", {
      description: TASK_TITLE,
      delegationId: "del-original",
      agent: "manifestor",
      metrics: {
        turns: 1,
        toolCalls: 2,
        contextTokens: 12_000,
        usage: {
          inputTokens: 2_000,
          outputTokens: 1_400,
          totalTokens: 3_400,
          operationId: "op-original",
          aggregation: "operation",
        },
      },
    });
    const continuation = taskCall("task-resume", {
      description: CONTINUATION_TITLE,
      resume: "del-original",
      delegationId: "del-resume",
      agent: "inspector",
      status: "running",
      metrics: {
        turns: 3,
        toolCalls: 4,
        contextTokens: 22_000,
        usage: {
          inputTokens: 2_000,
          outputTokens: 1_000,
          totalTokens: 3_000,
          operationId: "op-resume",
          aggregation: "operation",
        },
      },
    });
    const longTitled = taskCall("task-long", {
      description: LONG_TASK_TITLE,
      delegationId: "del-long",
      agent: "inspector",
    });
    const untitled = taskCall("task-role-only", {
      delegationId: "del-role",
      agent: "verifier",
      thinkingLevel: "low",
    });
    // Two cards at the two ends of "reported nothing": a run whose counters are
    // real zeros, and a run that has reported no figure at all. Both keep the
    // same four slots, so a transcript of cards never changes the line's shape.
    const zeroReport = taskCall("task-zero", {
      description: "Audit the empty queue",
      delegationId: "del-zero",
      agent: "auditor",
      metrics: {
        turns: 0,
        toolCalls: 0,
        contextTokens: 0,
        usage: { totalTokens: 0 },
      },
    });
    const silentReport = taskCall("task-silent", {
      description: "Watch the queue",
      delegationId: "del-silent",
      agent: "watcher",
      metrics: {},
    });
    // A run that reported its occupancy and spend but no counters: the two
    // counters it never sent are dashes, and the two figures it did send stay.
    const metricOnlyReport = taskCall("task-metric-only", {
      description: "Measure the empty queue",
      delegationId: "del-metric",
      agent: "surveyor",
      metrics: { contextTokens: 9_000, usage: { totalTokens: 1_200 } },
    });
    // A lifecycle row is not a delegation: it keeps its ordinary tool row and
    // its roster, and must never become a second card for the same child.
    const wait = message("task-wait", "", {
      toolName: "TaskWait",
      toolCallId: "call-task-wait",
      toolStatus: "success",
      toolArgs: { delegationIds: ["del-original"] },
      toolResult: {
        details: {
          status: "completed",
          delegations: [{ delegationId: "del-original", agent: "manifestor", status: "completed" }],
        },
      },
    });
    const sessionCalls = [
      original,
      continuation,
      longTitled,
      untitled,
      zeroReport,
      silentReport,
      metricOnlyReport,
      wait,
    ];
    const chainStart = Date.parse(createdAt);
    const timings = new Map([
      ["del-original", { startedAt: chainStart - 32_000, completedAt: chainStart }],
      ["del-resume", { startedAt: chainStart - 3_000 }],
    ]);
    // One chain, two activity parts: the `Task(resume …)` continuation lands in
    // a later part than the call whose description named the work, so the card
    // must read the chain's title from the conversation, not from its own part.
    const part = (calls: UiMessage[]) => (
      <ActivityItems
        items={calls.map((call) => ({ kind: "tool" as const, message: call }))}
        isActive={false}
        live={false}
        delegationStatuses={new Map()}
        delegationTimings={timings}
        onUserInteraction={() => {}}
      />
    );
    const cardsHost = mount(
      wide,
      <SubagentTitleProvider messages={sessionCalls}>
        <SubagentChainMetricsProvider messages={sessionCalls}>
          <div data-part="first">
            {part([
              original,
              longTitled,
              untitled,
              zeroReport,
              silentReport,
              metricOnlyReport,
            ])}
          </div>
          <div data-part="second">{part([continuation, wait])}</div>
        </SubagentChainMetricsProvider>
      </SubagentTitleProvider>,
    );
    await settle();

    const cardOf = (id: string) =>
      cardsHost.querySelector<HTMLElement>(`.subagent-task[data-message-id="${id}"]`)!;
    const buttonOf = (id: string) =>
      cardOf(id).querySelector<HTMLElement>(".subagent-task-card")!;
    const titleOf = (id: string) =>
      cardOf(id).querySelector<HTMLElement>(".subagent-task-title")!;
    const roleOf = (id: string) =>
      cardOf(id).querySelector<HTMLElement>(".subagent-task-role");
    const stateOf = (id: string) =>
      cardOf(id).querySelector<HTMLElement>(".subagent-task-state")!;

    check(
      "one card per Task call, and the lifecycle row stays a tool row",
      cardsHost.querySelectorAll(".subagent-task").length === 7 &&
        [
          "task-original",
          "task-resume",
          "task-long",
          "task-role-only",
          "task-zero",
          "task-silent",
          "task-metric-only",
        ].every((id) => Boolean(cardOf(id))),
      cardsHost.querySelectorAll(".subagent-task").length,
    );
    check(
      "the lifecycle row keeps its own row, roster and header",
      !cardsHost
        .querySelector('[data-message-id="task-wait"]')!
        .classList.contains("subagent-task") &&
        Boolean(
          cardsHost
            .querySelector('[data-message-id="task-wait"]')!
            .querySelector(".tool-row-header"),
        ) &&
        cardsHost
          .querySelector('[data-message-id="task-wait"]')!
          .textContent!.includes("manifestor"),
      cardsHost.querySelector('[data-message-id="task-wait"]')?.textContent?.slice(0, 80),
    );
    check(
      "a Task card is not a disclosure",
      !cardsHost.querySelector(".subagent-task [aria-expanded]") &&
        !cardsHost.querySelector(".subagent-task .tool-row-body") &&
        !cardsHost.querySelector(".subagent-task .tool-row-caret") &&
        !cardsHost.querySelector(".subagent-task-open") &&
        !cardOf("task-original").classList.contains("open"),
      cardOf("task-original").className,
    );
    check(
      "the buttons on a card are never nested",
      cardsHost.querySelectorAll("button button").length === 0,
      cardsHost.querySelectorAll("button button").length,
    );
    check(
      "a card's headline is the task title, not the role",
      titleOf("task-original").textContent === TASK_TITLE &&
        titleOf("task-resume").textContent === TASK_TITLE,
      {
        original: titleOf("task-original").textContent,
        resume: titleOf("task-resume").textContent,
      },
    );
    check(
      "a resumed card keeps the original title, never the continuation text",
      !cardsHost.textContent!.includes(CONTINUATION_TITLE),
      CONTINUATION_TITLE,
    );
    check(
      "the continuation card reads a chain that starts in the other part",
      cardOf("task-resume").closest('[data-part="second"]') !== null &&
        cardOf("task-original").closest('[data-part="first"]') !== null &&
        titleOf("task-resume").title === TASK_TITLE,
      titleOf("task-resume").title,
    );
    check(
      "the description is stated once per card",
      cardOf("task-original").textContent!.split(TASK_TITLE).length - 1 === 1,
      cardOf("task-original").textContent,
    );

    // The role reads on its own line under the title — the line the child's
    // step count used to hold — and the state keeps its inline slot beside the
    // title, with the running mark inside it.
    const originalCard = cardOf("task-original");
    const roleBox = roleOf("task-original")!.getBoundingClientRect();
    const titleBox = titleOf("task-original").getBoundingClientRect();
    const titleRow = originalCard.querySelector<HTMLElement>(".subagent-task-title-row")!;
    const titleRowBox = titleRow.getBoundingClientRect();
    const stateBox = stateOf("task-original").getBoundingClientRect();
    const metricsBox = originalCard
      .querySelector<HTMLElement>(".subagent-task-metrics")!
      .getBoundingClientRect();
    const cardRight = originalCard.getBoundingClientRect().right;
    check(
      "the role and its figures sit on their own lines under the title",
      roleOf("task-original")!.textContent === "manifestor" &&
        roleOf("task-resume")!.textContent === "inspector" &&
        roleBox.top >= titleRowBox.bottom - 1 &&
        roleBox.left <= titleBox.left + 1 &&
        roleBox.right <= cardRight + 1 &&
        metricsBox.top >= roleBox.bottom - 1,
      {
        titleLeft: Math.round(titleBox.left),
        roleLeft: Math.round(roleBox.left),
        roleTop: Math.round(roleBox.top),
        titleRowBottom: Math.round(titleRowBox.bottom),
        metricsTop: Math.round(metricsBox.top),
      },
    );
    check(
      "the state stays inline in the title row",
      titleRow.contains(stateOf("task-original")) &&
        stateBox.left >= titleBox.right - 1 &&
        stateBox.top < titleRowBox.bottom,
      {
        titleRight: Math.round(titleBox.right),
        stateLeft: Math.round(stateBox.left),
      },
    );
    check(
      "the running mark keeps its slot inside the state, in every outcome",
      originalCard
        .querySelector(".subagent-task-state .subagent-task-spinner")
        ?.getAttribute("data-active") === "false" &&
        cardOf("task-resume")
          .querySelector(".subagent-task-state .subagent-task-spinner")
          ?.getAttribute("data-active") === "true",
      originalCard.querySelector(".subagent-task-spinner")?.outerHTML,
    );
    check(
      "a card carries no step count and no loose spinner",
      !originalCard.querySelector(".steps") &&
        !cardsHost.querySelector(".subagent-task .tool-spinner") &&
        !/\bsteps?\b/.test(originalCard.textContent ?? ""),
      originalCard.textContent,
    );
    check(
      "neither the model nor the reasoning level reaches the card",
      !cardsHost.textContent!.includes(DELEGATE_MODEL) &&
        !cardsHost.querySelector(".subagent-task-model") &&
        !cardsHost.querySelector(".subagent-task-thinking"),
      cardsHost.textContent?.slice(0, 120),
    );
    check(
      "the task brief never becomes a title",
      !cardsHost.textContent!.includes("Investigate the cache invalidation path"),
    );
    // An older log without a description is named by the role that ran it.
    check(
      "a card without a description falls back to its role",
      titleOf("task-role-only").textContent === "verifier" &&
        roleOf("task-role-only") === null,
      titleOf("task-role-only").textContent,
    );
    check(
      "a settled card states its own outcome and runtime",
      stateOf("task-original").textContent!.includes("Completed") &&
        stateOf("task-original").textContent!.includes("32s") &&
        stateOf("task-resume").textContent!.includes("Running"),
      stateOf("task-original").textContent,
    );
    // The child session's totals, exactly as its own tab header states them:
    // both segments of the chain read one canonical fold, and the neighbouring
    // single-run cards keep their own figures.
    const chainLine = subagentMetricsLine(
      aggregateChainMetricsFromMessages(sessionCalls, "del-original"),
      i18n.t.bind(i18n),
      "en",
    );
    const metricsOf = (host: HTMLElement, id: string) =>
      host
        .querySelector<HTMLElement>(`.subagent-task[data-message-id="${id}"] .subagent-task-metrics`)
        ?.textContent ?? "";
    check(
      "a card states the child session's totals, as its tab header does",
      chainLine === "Turns 4 · Tool calls 6 · Context 22K · Spent 6.4K" &&
        metricsOf(cardsHost, "task-original") === chainLine &&
        metricsOf(cardsHost, "task-resume") === chainLine &&
        cardOf("task-original")
          .querySelector(".subagent-task-metrics")
          ?.getAttribute("title") === chainLine,
      {
        header: chainLine,
        original: metricsOf(cardsHost, "task-original"),
        resume: metricsOf(cardsHost, "task-resume"),
      },
    );
    check(
      "a single-run card keeps its own figures, untouched by the chain beside it",
      metricsOf(cardsHost, "task-long") === "Turns 1 · Tool calls 2 · Context 12K · Spent 3.4K" &&
        metricsOf(cardsHost, "task-role-only") === "Turns 1 · Tool calls 2 · Context 12K · Spent 3.4K",
      {
        long: metricsOf(cardsHost, "task-long"),
        roleOnly: metricsOf(cardsHost, "task-role-only"),
      },
    );
    // The four figures are never conditional: a run that reported real zeros
    // states those zeros, and a run that reported nothing keeps the four
    // labelled placeholders. Both cards hold the same line the reported cards
    // hold, so a transcript of cards keeps one line height.
    check(
      "a card states reported zeros as zeros",
      metricsOf(cardsHost, "task-zero") === "Turns 0 · Tool calls 0 · Context 0 · Spent 0",
      metricsOf(cardsHost, "task-zero"),
    );
    check(
      "a card whose run reported nothing keeps all four labelled placeholders",
      metricsOf(cardsHost, "task-silent") ===
        "Turns — · Tool calls — · Context — · Spent —" &&
        cardOf("task-silent")
          .querySelector(".subagent-task-metrics")
          ?.getAttribute("title") === "Turns — · Tool calls — · Context — · Spent —",
      {
        line: metricsOf(cardsHost, "task-silent"),
        title: cardOf("task-silent")
          .querySelector(".subagent-task-metrics")
          ?.getAttribute("title"),
      },
    );
    check(
      "a card whose run reported only context and spend states no counters",
      metricsOf(cardsHost, "task-metric-only") ===
        "Turns — · Tool calls — · Context 9K · Spent 1.2K",
      metricsOf(cardsHost, "task-metric-only"),
    );
    check(
      "the figures line never disappears from a card",
      cardsHost.querySelectorAll(".subagent-task .subagent-task-metrics").length ===
        cardsHost.querySelectorAll(".subagent-task").length,
      {
        cards: cardsHost.querySelectorAll(".subagent-task").length,
        lines: cardsHost.querySelectorAll(".subagent-task .subagent-task-metrics").length,
      },
    );

    // A long title clamps instead of stretching the card, and its hover keeps
    // the whole value.
    const longTitle = titleOf("task-long");
    const longBox = longTitle.getBoundingClientRect();
    check(
      "a long title clamps to its two lines and keeps the whole hover",
      longTitle.title === LONG_TASK_TITLE &&
        longTitle.scrollHeight > longTitle.clientHeight &&
        longBox.width <= cardOf("task-long").getBoundingClientRect().width,
      {
        hover: longTitle.title.length,
        scrollHeight: longTitle.scrollHeight,
        clientHeight: longTitle.clientHeight,
        width: Math.round(longBox.width),
      },
    );
    check(
      "a long title does not overflow its card",
      cardOf("task-long").scrollWidth <= cardOf("task-long").clientWidth + 1,
      {
        scrollWidth: cardOf("task-long").scrollWidth,
        clientWidth: cardOf("task-long").clientWidth,
      },
    );

    // Only the running delegation offers a stop handle, and it is the card's
    // sibling: stopping one child can never reach the card's own click.
    const stops = [...cardsHost.querySelectorAll<HTMLElement>(".subagent-stop-button")];
    check(
      "only the running card carries a stop handle, as a sibling of its button",
      stops.length === 1 &&
        stops[0].parentElement === cardOf("task-resume") &&
        !buttonOf("task-resume").contains(stops[0]) &&
        stops[0].getAttribute("aria-label")!.includes("inspector"),
      {
        stops: stops.length,
        label: stops[0]?.getAttribute("aria-label"),
        nested: stops[0] ? buttonOf("task-resume").contains(stops[0]) : null,
      },
    );

    // The handle rides the card's trailing corner instead of taking a line of
    // its own under the card: the title and the figures already reserve its
    // width, so it never covers the child's name or its report.
    const resumeCardBox = buttonOf("task-resume").getBoundingClientRect();
    const resumeStopBox = stops[0]?.getBoundingClientRect();
    check(
      "the card's stop handle sits over its trailing corner",
      Boolean(resumeStopBox) &&
        resumeStopBox!.top >= resumeCardBox.top - 1 &&
        resumeStopBox!.bottom <= resumeCardBox.bottom + 1 &&
        resumeCardBox.right - resumeStopBox!.right <= 14,
      {
        cardRight: Math.round(resumeCardBox.right),
        cardBottom: Math.round(resumeCardBox.bottom),
        stopRight: Math.round(resumeStopBox?.right ?? 0),
        stopBottom: Math.round(resumeStopBox?.bottom ?? 0),
      },
    );

    // Clicking the card opens the real tab, labelled with the same title.
    const titleBeforeClick = titleOf("task-resume").textContent;
    buttonOf("task-resume").click();
    await settle();
    const state = useAppStore.getState();
    const openedTab = state.workPanelTabs.find(
      (tab) => tab.id === "subagent:del-resume",
    );
    check(
      "clicking the card opens its tab labelled with the same task title",
      openedTab?.label === titleBeforeClick &&
        state.activeWorkPanelTabId === "subagent:del-resume",
      { label: openedTab?.label, active: state.activeWorkPanelTabId },
    );
    check(
      "only the clicked card reports the open tab",
      cardOf("task-resume").classList.contains("is-panel-open") &&
        !cardOf("task-original").classList.contains("is-panel-open"),
      {
        resume: cardOf("task-resume").className,
        original: cardOf("task-original").className,
      },
    );

    // A live resume segment reports again: every card of its chain states the
    // new totals, including the earlier card whose own message never changed.
    // The chain fold the transcript owns is the only source, so a memoized card
    // cannot be left stating its own segment's older figures.
    const liveChain = mount(
      wide,
      <LiveChain initial={[original, continuation]} render={part} />,
    );
    await settle();
    check(
      "a resumed chain renders the same totals on both cards",
      metricsOf(liveChain, "task-original") === chainLine &&
        metricsOf(liveChain, "task-resume") === chainLine,
      {
        original: metricsOf(liveChain, "task-original"),
        resume: metricsOf(liveChain, "task-resume"),
      },
    );
    const laterReport = taskCall("task-resume", {
      description: CONTINUATION_TITLE,
      resume: "del-original",
      delegationId: "del-resume",
      agent: "inspector",
      status: "running",
      metrics: {
        turns: 6,
        toolCalls: 8,
        contextTokens: 31_000,
        usage: {
          inputTokens: 3_000,
          outputTokens: 2_000,
          totalTokens: 5_000,
          operationId: "op-resume",
          aggregation: "operation",
        },
      },
    });
    flushSync(() => chainLiveSetter!([original, laterReport]));
    await settle();
    const laterLine = subagentMetricsLine(
      aggregateChainMetricsFromMessages([original, laterReport], "del-original"),
      i18n.t.bind(i18n),
      "en",
    );
    check(
      "a later segment's report moves the earlier card with it",
      laterLine === "Turns 7 · Tool calls 10 · Context 31K · Spent 8.4K" &&
        metricsOf(liveChain, "task-original") === laterLine &&
        metricsOf(liveChain, "task-resume") === laterLine,
      {
        header: laterLine,
        original: metricsOf(liveChain, "task-original"),
        resume: metricsOf(liveChain, "task-resume"),
      },
    );


    // ── 9. The turn's process is the only fold over its work ──
    // The regression this guards: the assistant row offered an outer
    // "Processed for … · N tools" disclosure and, inside it, a second pill
    // ("N tool actions · Includes thinking") that had to be opened before any
    // tool became visible. The segment pill is gone — the process header is the
    // only disclosure above a row — and a thought that follows the last tool
    // result sits beside the prose it produced instead of inside the segment
    // above it. Every row keeps its own disclosure, exactly as before.
    const fixEntry = buildTranscriptEntries([
      message("fix-user", "Speed up the transcript.", { role: "user" }),
      message("fix-think-1", "", {
        role: "assistant",
        status: "complete",
        thinking: "Start at the tool row.",
      }),
      bash("fix-bash-1"),
      todos("fix-todo", "running"),
      message("fix-think-2", "", {
        role: "assistant",
        status: "complete",
        thinking: "The rule re-measures every tick.",
      }),
      message("fix-progress", "The rule re-measured on every stream tick.", {
        role: "assistant",
        status: "complete",
      }),
      message("fix-think-3", "", {
        role: "assistant",
        status: "complete",
        thinking: "Measure the layout effect instead.",
      }),
      bashWithLines("fix-bash-2", 4),
      message("fix-think-4", "", {
        role: "assistant",
        status: "complete",
        thinking: "One measurement is enough.",
      }),
      message("fix-answer", "The layout effect is measured once now.", {
        role: "assistant",
        status: "complete",
      }),
    ]).entries.find((entry) => entry.kind === "assistant-turn")!;
    const fixHost = mount(wide, <AssistantTurn entry={fixEntry as never} isActive={false} />);
    await settle();
    const shown = (element: Element | null | undefined) =>
      Boolean(element instanceof HTMLElement && element.checkVisibility());
    const process = fixHost.querySelector<HTMLElement>(".turn-process")!;
    const processHeader =
      process.querySelector<HTMLElement>(":scope > .tool-activity-header")!;
    const rowHeaders = () => [
      ...fixHost.querySelectorAll<HTMLElement>(".process-activity-group .tool-row-header"),
    ];
    const segments = () => [
      ...fixHost.querySelectorAll<HTMLElement>(
        ".turn-process-body > .process-activity-group",
      ),
    ];
    const segmentShape = () =>
      segments().map((segment) =>
        [...segment.children].map((child) =>
          child.classList.contains("thinking")
            ? child.querySelector(".tool-row-summary")?.textContent
            : child.getAttribute("data-message-id"),
        ),
      );

    check(
      "the process header is the only level above a row",
      fixHost.querySelectorAll(".tool-activity-header").length === 1 &&
        fixHost.querySelectorAll(".process-activity-group .tool-activity-header")
          .length === 0 &&
        processHeader.textContent!.includes("3 tools"),
      {
        headers: fixHost.querySelectorAll(".tool-activity-header").length,
        label: processHeader.textContent,
      },
    );
    check(
      "a settled process starts expanded",
      processHeader.getAttribute("aria-expanded") === "true" &&
        shown(fixHost.querySelector(".tool-todo-list")),
    );

    const toolRows = ["fix-bash-1", "fix-todo", "fix-bash-2"];
    check(
      "the settled process shows its work without a click",
      toolRows.every((id) => shown(fixHost.querySelector(`[data-message-id="${id}"]`))),
      { rows: toolRows.map((id) => shown(fixHost.querySelector(`[data-message-id="${id}"]`))) },
    );
    check(
      "a checklist still opens itself",
      shown(fixHost.querySelector(".tool-todo-list")) &&
        fixHost.querySelectorAll(".tool-todo-row").length === 3,
      fixHost.querySelectorAll(".tool-todo-row").length,
    );
    const opened = rowHeaders().filter(
      (header) => header.getAttribute("aria-expanded") === "true",
    );
    check(
      "an expanded process expands no tool detail",
      opened.length === 1 &&
        opened[0].closest(".tool-row")?.getAttribute("data-message-id") === "fix-todo",
      {
        open: opened.map(
          (header) => header.closest(".tool-row")?.getAttribute("data-message-id") ?? "thinking",
        ),
        headers: rowHeaders().length,
      },
    );
    check(
      "the thoughts and tools keep their transcript order, grouped by what they belong to",
      JSON.stringify(segmentShape()) ===
        JSON.stringify([
          ["Start at the tool row.", "fix-bash-1", "fix-todo"],
          ["The rule re-measures every tick."],
          ["Measure the layout effect instead.", "fix-bash-2"],
          ["One measurement is enough."],
        ]),
      segmentShape(),
    );
    const progress = fixHost.querySelector<HTMLElement>(
      ".turn-process-body > .assistant-turn-fragment",
    )!;
    const answer = fixHost.querySelector<HTMLElement>(
      ".message-col > .assistant-turn-fragment",
    )!;
    check(
      "a thought that produced prose is its own sibling directly above it",
      segments()[1].nextElementSibling === progress &&
        progress.textContent!.includes("re-measured on every stream tick") &&
        segments()[1].querySelector("[data-message-id]") === null &&
        segments()[3].nextElementSibling === null &&
        segments()[3].querySelector("[data-message-id]") === null &&
        answer.textContent!.includes("measured once now") &&
        Boolean(
          segments()[3].compareDocumentPosition(answer) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      {
        beforeProgress: segments()[1].nextElementSibling?.className,
        afterLast: segments()[3].nextElementSibling?.className ?? null,
      },
    );

    const thoughtHeader = segments()[3].querySelector<HTMLElement>(".tool-row-header")!;
    check(
      "a thought is still folded by its own row",
      thoughtHeader.getAttribute("aria-expanded") === "false" &&
        segments()[3].querySelector(".thinking-prose") === null,
    );
    thoughtHeader.click();
    await settle();
    check(
      "opening a thought reveals its prose once, in its own row",
      thoughtHeader.getAttribute("aria-expanded") === "true" &&
        segments()[3].querySelectorAll(".thinking-prose").length === 1 &&
        segments()[3]
          .querySelector<HTMLElement>(".thinking-prose")!
          .textContent!.includes("One measurement is enough."),
    );
    const bashHeader = fixHost.querySelector<HTMLElement>(
      '[data-message-id="fix-bash-1"] .tool-row-header',
    )!;
    bashHeader.click();
    await settle();
    check(
      "a tool row keeps its own disclosure",
      bashHeader.getAttribute("aria-expanded") === "true" &&
        shown(fixHost.querySelector('[data-message-id="fix-bash-1"] .tool-terminal')),
    );

    // ── 7. A file row names the file and offers the whole path on hover ──
    // The collapsed hint is scanned, not read, so it prints the last segment
    // and nothing else: the directory never takes the line and no omission is
    // composed. The whole raw value is still one hover (and one screen-reader
    // description) away, and a name too long for the row ellipsizes at the
    // row's own edge instead of overflowing it. Nothing here is measured: the
    // hint is the same text at every width.
    const EXTERNAL_ROOT = "/Users/jorkeyliu/workspace/repos/pi-desktop-mw/apps/desktop";
    const EXTERNAL_NAME = "use-transcript-scroll.ts";
    const EXTERNAL_PATH = `${EXTERNAL_ROOT}/src/features/chat/transcript/hooks/${EXTERNAL_NAME}`;
    const SIBLING_PATH = `${EXTERNAL_ROOT}/src/features/chat/transcript/hooks/use-transcript-window.ts`;
    const LONG_NAME = "a-considerably-longer-name-for-one-row-of-the-transcript.spec.mjs";
    const LONG_NAME_PATH = `${EXTERNAL_ROOT}/src/features/chat/transcript/hooks/${LONG_NAME}`;
    const WINDOWS_PATH = `C:\\Users\\jorkeyliu\\workspace\\repos\\pi-desktop-mw\\apps\\desktop\\src\\features\\hooks\\${EXTERNAL_NAME}`;
    const RELATIVE_PATH = `src/features/chat/transcript/hooks/${EXTERNAL_NAME}`;
    const DIRECTORY_PATH = `${EXTERNAL_ROOT}/src/features/chat/`;
    const pathCases = [
      { key: "absolute-external", path: EXTERNAL_PATH, name: EXTERNAL_NAME },
      { key: "same-prefix-sibling", path: SIBLING_PATH, name: "use-transcript-window.ts" },
      { key: "long-name", path: LONG_NAME_PATH, name: LONG_NAME },
      { key: "windows-separators", path: WINDOWS_PATH, name: EXTERNAL_NAME },
      { key: "relative", path: RELATIVE_PATH, name: EXTERNAL_NAME },
    ];
    const readPathRow = (id: string, path: string) =>
      message(id, "", {
        toolName: "Read",
        toolCallId: `call-${id}`,
        toolStatus: "success",
        // `file_path` is the alias the runtime sends; the row must read it the
        // same way it reads `path`.
        toolArgs: { file_path: path, limit: 40 },
        toolResult: { details: { path } },
      });

    const pathStage = document.createElement("div");
    pathStage.id = "path-stage";
    pathStage.style.cssText =
      "display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;padding:12px;width:1340px";
    document.body.prepend(pathStage);
    globalThis.toolCardsPathFocus = () => {
      pathStage.scrollIntoView({ block: "start" });
    };

    /** Where the hint's own text is painted, against the box that clips it. */
    const namePaint = (summary: HTMLElement, name: string) => {
      const box = summary.getBoundingClientRect();
      const walker = document.createTreeWalker(summary, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const data = (node as Text).data;
        const at = data.indexOf(name);
        if (at < 0) continue;
        const range = document.createRange();
        // The hint starts at the row's own left edge; what the row does with a
        // name too long for it is the stylesheet's ellipsis, not a shortened
        // string.
        range.setStart(node, at);
        range.setEnd(node, at + Math.min(name.length, 8));
        const rect = range.getBoundingClientRect();
        return {
          painted: rect.width > 0 && rect.left >= box.left - 0.5 && rect.left <= box.right,
          startBox: [Math.round(rect.left), Math.round(rect.right)],
          rowBox: [Math.round(box.left), Math.round(box.right)],
          text: summary.textContent,
          title: summary.title,
        };
      }
      return { painted: false, missing: name, text: summary.textContent, title: summary.title };
    };
    /** The whole path the row gives a screen reader, from its description. */
    const describedPath = (host: HTMLElement) => {
      const header = host.querySelector<HTMLElement>(".tool-row-header");
      const id = header?.getAttribute("aria-describedby") ?? "";
      if (!id) return null;
      const target = document.getElementById(id);
      return {
        id,
        text: target?.textContent ?? null,
        hidden: target?.classList.contains("sr-only") === true,
      };
    };

    for (const width of [280, 340, 700]) {
      const column = document.createElement("div");
      column.style.cssText = `width:${width}px;min-width:0`;
      pathStage.append(column);
      const summaries: HTMLElement[] = [];
      for (const item of pathCases) {
        const host = mount(column, <ToolRow message={readPathRow(`${item.key}-${width}`, item.path)} />);
        await settle(2);
        const summary = host.querySelector<HTMLElement>(".tool-row-summary")!;
        summaries.push(summary);
        const paint = namePaint(summary, item.name);
        check(
          `${width}px: the hint is the file name alone (${item.key})`,
          summary.textContent === item.name,
          { shown: summary.textContent, name: item.name },
        );
        check(
          `${width}px: the file name is painted inside the row (${item.key})`,
          paint.painted,
          paint,
        );
        // The name either fits the row whole or is clipped by the row's own
        // ellipsis: the hint never leaves its box, and nothing shortened it.
        const whole = document.createRange();
        const text = summary.firstChild;
        if (text) {
          whole.selectNodeContents(text);
        }
        const nameWidth = text ? whole.getBoundingClientRect().width : 0;
        check(
          `${width}px: the name fits whole or ellipsizes inside the row (${item.key})`,
          nameWidth <= summary.clientWidth
            ? summary.scrollWidth <= summary.clientWidth + 1
            : getComputedStyle(summary).textOverflow === "ellipsis",
          {
            nameWidth: Math.round(nameWidth * 100) / 100,
            scrollWidth: summary.scrollWidth,
            clientWidth: summary.clientWidth,
            textOverflow: getComputedStyle(summary).textOverflow,
          },
        );
        const rowHeader = host.querySelector<HTMLElement>(".tool-row-header");
        check(
          `${width}px: the whole raw path stays available on hover (${item.key})`,
          summary.title === item.path && rowHeader?.title === item.path,
          { hintTitle: summary.title, headerTitle: rowHeader?.title, raw: item.path },
        );
        const described = describedPath(host);
        check(
          `${width}px: the row describes itself with the whole path (${item.key})`,
          described?.text === item.path && described.hidden === true,
          described ?? { described: null },
        );
      }
      const [first, sibling] = summaries;
      check(
        `${width}px: two files under one prefix stay distinguishable`,
        first.textContent !== sibling.textContent &&
          first.textContent === EXTERNAL_NAME &&
          sibling.textContent === "use-transcript-window.ts",
        { first: first.textContent, sibling: sibling.textContent },
      );

      // The chips and the diff counts keep their own space; the name yields
      // before them, never the other way round.
      const countsHost = mount(column, <ToolRow message={editWithReview(`counts-${width}`)} />);
      await settle(2);
      const counts = countsHost.querySelector<HTMLElement>(
        ".tool-row-header > .review-change-card-counts",
      );
      const rowBox = countsHost.querySelector<HTMLElement>(".tool-row-header")!.getBoundingClientRect();
      const countsBox = counts?.getBoundingClientRect();
      const countsPaint = countsHost.querySelector<HTMLElement>(".tool-row-summary")!;
      check(
        `${width}px: the +a/−d pair keeps its place on the row`,
        Boolean(countsBox) &&
          countsBox!.width > 0 &&
          countsBox!.right <= rowBox.right + 0.5 &&
          counts!.textContent!.includes("+3") &&
          counts!.textContent!.includes("−2"),
        { countsBox: countsBox && [Math.round(countsBox.left), Math.round(countsBox.right)], rowBox: [Math.round(rowBox.left), Math.round(rowBox.right)], text: counts?.textContent },
      );
      check(
        `${width}px: the mutation row still paints its file name`,
        countsPaint.textContent === "ToolTerminal.tsx" &&
          namePaint(countsPaint, "ToolTerminal.tsx").painted,
        { text: countsPaint.textContent, paint: namePaint(countsPaint, "ToolTerminal.tsx") },
      );
    }

    // An unusually long name ellipsizes where the row ends, and the whole name
    // is still what the row holds — the clipping is the stylesheet's, not a
    // shortened string. A wider row then fits it whole, unchanged.
    {
      const column = document.createElement("div");
      column.style.cssText = "width:280px;min-width:0";
      pathStage.append(column);
      const host = mount(column, <ToolRow message={readPathRow("long-narrow", LONG_NAME_PATH)} />);
      await settle(2);
      const summary = host.querySelector<HTMLElement>(".tool-row-summary")!;
      const header = host.querySelector<HTMLElement>(".tool-row-header")!;
      const style = getComputedStyle(summary);
      check(
        "a name too long for the row ellipsizes inside it",
        summary.textContent === LONG_NAME &&
          style.textOverflow === "ellipsis" &&
          style.whiteSpace === "nowrap" &&
          summary.scrollWidth - summary.clientWidth > 100 &&
          summary.getBoundingClientRect().right <= header.getBoundingClientRect().right + 0.5,
        {
          text: summary.textContent,
          textOverflow: style.textOverflow,
          scrollWidth: summary.scrollWidth,
          clientWidth: summary.clientWidth,
          title: summary.title,
        },
      );
      check(
        "the long name is still the whole path's name on hover",
        summary.title === LONG_NAME_PATH,
        summary.title,
      );
      column.style.width = "900px";
      await settle(2);
      check(
        "the same name fits whole once the row is wide enough",
        summary.textContent === LONG_NAME &&
          summary.scrollWidth <= summary.clientWidth + 1,
        {
          text: summary.textContent,
          scrollWidth: summary.scrollWidth,
          clientWidth: summary.clientWidth,
        },
      );
      // A value that names a directory prints its last segment, so a Grep row
      // never reads as a file that does not exist.
      const dirHost = mount(column, <ToolRow message={readPathRow("directory", DIRECTORY_PATH)} />);
      await settle(2);
      check(
        "a directory path prints its last segment and keeps the separator",
        dirHost.querySelector<HTMLElement>(".tool-row-summary")?.textContent === "chat/",
        dirHost.querySelector<HTMLElement>(".tool-row-summary")?.textContent,
      );
    }

    // A pane drag changes nothing about the hint: there is no fit to redo.
    const dragColumn = document.createElement("div");
    dragColumn.style.cssText = "width:700px;min-width:0";
    pathStage.append(dragColumn);
    const dragHost = mount(
      dragColumn,
      <ToolRow message={readPathRow("resize", EXTERNAL_PATH)} />,
    );
    await settle(2);
    const dragSummary = dragHost.querySelector<HTMLElement>(".tool-row-summary")!;
    const dragWide = {
      text: dragSummary.textContent,
      overhang: dragSummary.scrollWidth - dragSummary.clientWidth,
    };
    dragColumn.style.width = "280px";
    await settle(2);
    const dragNarrow = {
      text: dragSummary.textContent,
      overhang: dragSummary.scrollWidth - dragSummary.clientWidth,
      title: dragSummary.title,
    };
    check(
      "a pane drag leaves the name and the full-path hover unchanged",
      dragNarrow.text === EXTERNAL_NAME &&
        dragNarrow.text === dragWide.text &&
        dragWide.overhang <= 1 &&
        dragNarrow.overhang <= 1 &&
        dragNarrow.title === EXTERNAL_PATH,
      { wide: dragWide, narrow: dragNarrow },
    );

    cardsHost.scrollIntoView({ block: "start" });
    await settle(2);
    check("no render error escaped", renderErrors.length === 0, renderErrors.length);

  } catch (error) {
    probe.failures.push(
      `probe threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
  }

  return {
    ok: probe.failures.length === 0,
    failures: probe.failures,
    observed: probe.observed,
  };
};
