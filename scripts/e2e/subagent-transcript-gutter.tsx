import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC, type UiMessage } from "@pi-desktop/shared";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var subagentTranscriptGutterProbe: (width: number) => Promise<{
    ok: boolean;
    failures: string[];
    facts: Record<string, unknown>;
  }>;
}

/*
 * The child's transcript tab, mounted in a real Chromium renderer with the
 * application's own stylesheet: the production `SubagentTranscriptTab`, its
 * production `ToolRow` cards, the production store and i18n. Only the preload
 * bridge is a stub, and the tab never calls it while idle.
 *
 * The pane is measured at two sidebar widths. Expanding one long command detail
 * makes the child transcript overflow; the probe proves that overflow changes
 * no content width and no row position. The same measurements are repeated with
 * the shipped `scrollbar-gutter: stable` overridden to `auto` on the scrollport,
 * which records what the pane did before the rule existed — in this same
 * renderer, with the same content and the same app scrollbar styling.
 */

const SESSION = "s1";
const DELEGATION = "d1";
const CALL = "call-task";
const createdAt = "2026-10-18T00:00:00.000Z";

window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async () => ({ ok: true, data: undefined }),
  on: () => () => undefined,
} as unknown as typeof window.piDesktop;

function message(
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role, content, createdAt, status: "complete", ...extra };
}

/** A command long enough to wrap into many lines inside the narrow pane. */
const COMMAND = [
  "git ls-files -z | xargs -0 npx eslint --max-warnings 0",
  "--report-unused-disable-directives --format stylish",
  "src/components/workpanel/SubagentTranscriptTab.tsx",
  "src/features/chat/transcript/ToolRow.tsx",
].join(" ");

/** Enough output that opening the detail alone overflows the pane. */
const STDOUT = Array.from(
  { length: 160 },
  (_, index) =>
    `line ${index}: synthetic command output long enough to wrap inside the terminal pane`,
).join("\n");

function childMessages(): UiMessage[] {
  return [
    message("t1", "tool", "", {
      toolName: "Task",
      toolCallId: CALL,
      toolStatus: "success",
      toolArgs: {
        agent: "explorer",
        description: "Review auth flow",
        task: "Review the auth flow end to end and report what you find.",
      },
      toolResult: {
        details: {
          delegationId: DELEGATION,
          agent: "explorer",
          status: "completed",
          startedAt: 1_000,
          completedAt: 42_000,
        },
      },
    }),
    message("c1", "tool", "", {
      toolName: "Read",
      toolCallId: "c1",
      toolStatus: "success",
      parentToolCallId: CALL,
      agentName: "explorer",
      toolArgs: { path: "src/auth/session.ts" },
      toolResult: { details: { content: "export const session = createSession();" } },
    }),
    message("c2", "tool", "", {
      toolName: "Bash",
      toolCallId: "c2",
      toolStatus: "success",
      parentToolCallId: CALL,
      agentName: "explorer",
      toolArgs: { command: COMMAND },
      toolResult: { details: { stdout: STDOUT, exitCode: 0 } },
    }),
    message("c3", "assistant", "The auth flow is consistent; no defect found.", {
      parentToolCallId: CALL,
      agentName: "explorer",
    }),
  ];
}

const i18n = createInstance();
void i18n.init({
  lng: "en",
  resources: { en: { translation: catalogs.en } },
  interpolation: { escapeValue: false },
});

flushSync(() => {
  useAppStore.setState({
    activeSessionId: SESSION,
    sessions: [
      {
        id: SESSION,
        title: "Gutter fixture",
        source: "local",
        mode: "agent",
        createdAt,
        updatedAt: createdAt,
      } as never,
    ],
    messages: childMessages(),
    isRunning: false,
    settings: { enterToSend: true },
    providers: [],
    providerModels: {},
    plugins: [],
    recentModels: [],
    retainedTranscripts: {},
    retainedSessionIds: [],
    sessionHistory: {},
    transcriptViews: {},
    sessionCompactions: {},
    sessionTodos: {},
    pendingPermissions: {},
    pendingAsks: {},
    queuedPrompts: {},
    planCheckpoints: {},
    agentStatuses: {},
    runningSessions: {},
  } as never);
});

const host = document.createElement("div");
host.style.cssText =
  "position:fixed;inset:0;display:flex;align-items:stretch;background:var(--ds-bg-primary)";
// The bundle runs before `<body>` exists, so the host hangs off the document
// element; it is positioned fixed, so its parent does not matter.
(document.body ?? document.documentElement).append(host);
/** One fixed-height column, the shape the work panel gives this tab. */
const stage = document.createElement("div");
stage.id = "stage";
stage.style.cssText = "display:flex;height:600px;width:340px";
host.append(stage);

const root = createRoot(stage);
flushSync(() => {
  root.render(
    <I18nextProvider i18n={i18n}>
      <SubagentTranscriptTab delegationId={DELEGATION} />
    </I18nextProvider>,
  );
});

const frames = (count = 2) =>
  new Promise<void>((resolve) => {
    const tick = (left: number) => {
      if (left <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => tick(left - 1));
    };
    tick(count);
  });

const scroller = () => document.querySelector<HTMLElement>(".subagent-transcript-scroll");
const list = () => document.querySelector<HTMLElement>(".subagent-transcript-list");
const composer = () =>
  document.querySelector<HTMLElement>(".subagent-transcript-composer");
const tab = () => document.querySelector<HTMLElement>(".subagent-transcript-tab");
/** The first child row: the reference card every measurement compares. */
const reference = () =>
  document.querySelector<HTMLElement>('[data-message-id="c1"]');
const bashRow = () => document.querySelector<HTMLElement>('[data-message-id="c2"]');

function measure() {
  const box = (node: Element | null) => node?.getBoundingClientRect();
  const contentBox = box(list());
  const referenceBox = box(reference());
  const composerBox = box(composer());
  const tabBox = box(tab());
  return {
    scrollerClientWidth: scroller()?.clientWidth ?? 0,
    scrollerOffsetWidth: scroller()?.offsetWidth ?? 0,
    scrollerScrollWidth: scroller()?.scrollWidth ?? 0,
    scrollHeight: scroller()?.scrollHeight ?? 0,
    clientHeight: scroller()?.clientHeight ?? 0,
    contentWidth: contentBox?.width ?? 0,
    contentLeft: contentBox?.left ?? 0,
    contentRight: contentBox?.right ?? 0,
    referenceWidth: referenceBox?.width ?? 0,
    referenceLeft: referenceBox?.left ?? 0,
    referenceRight: referenceBox?.right ?? 0,
    composerWidth: composerBox?.width ?? 0,
    composerBottom: composerBox?.bottom ?? 0,
    tabWidth: tabBox?.width ?? 0,
    tabBottom: tabBox?.bottom ?? 0,
  };
}

function setWidth(width: number) {
  stage.style.width = `${width}px`;
}

function expandDetail() {
  const header = bashRow()?.querySelector<HTMLButtonElement>(".tool-row-header");
  if (header?.getAttribute("aria-expanded") !== "true") header?.click();
}

function collapseDetail() {
  const header = bashRow()?.querySelector<HTMLButtonElement>(".tool-row-header");
  if (header?.getAttribute("aria-expanded") === "true") header?.click();
}

function run(checks: Array<[boolean, string]>) {
  return checks.filter(([pass]) => !pass).map(([, label]) => label);
}

const near = (a: number, b: number, tolerance = 0.5) => Math.abs(a - b) <= tolerance;

globalThis.subagentTranscriptGutterProbe = async (width: number) => {
  await frames(3);
  const failures: string[] = [];
  const facts: Record<string, unknown> = { width };
  setWidth(width);
  await frames(3);

  failures.push(
    ...run([
      [tab() !== null, `${width}px: the tab mounts`],
      [scroller() !== null && list() !== null, `${width}px: the tab has its scrollport and list`],
      [bashRow() !== null, `${width}px: the child's Bash row renders`],
      [
        scroller() !== null && scroller()!.scrollHeight <= scroller()!.clientHeight + 1,
        `${width}px: the closed detail does not overflow the pane`,
      ],
    ]),
  );

  const element = scroller();
  if (!element) return { ok: false, failures, facts };

  // BEFORE: the same scrollport with the shipped gutter rule overridden to
  // `auto`, which is the pane as it behaved before this fix.
  element.style.scrollbarGutter = "auto";
  await frames(2);
  const beforeClosed = measure();
  expandDetail();
  await frames(4);
  const beforeExpanded = measure();
  collapseDetail();
  await frames(4);
  element.style.scrollbarGutter = "";
  await frames(3);

  // AFTER: the shipped `scrollbar-gutter: stable` on the same scrollport.
  const closed = measure();
  expandDetail();
  await frames(4);
  const open = measure();
  collapseDetail();
  await frames(4);
  const closedAgain = measure();

  const gutter = Math.round(closed.scrollerOffsetWidth - closed.scrollerClientWidth);
  facts.gutter = gutter;
  facts.before = {
    contentWidthClosed: Math.round(beforeClosed.contentWidth * 100) / 100,
    contentWidthOpen: Math.round(beforeExpanded.contentWidth * 100) / 100,
    shift: Math.round((beforeExpanded.contentWidth - beforeClosed.contentWidth) * 100) / 100,
    scrollerClientWidth: beforeClosed.scrollerClientWidth,
    scrollerClientWidthOpen: beforeExpanded.scrollerClientWidth,
    overflowed: beforeExpanded.scrollHeight > beforeExpanded.clientHeight + 40,
  };
  facts.after = {
    contentWidthClosed: Math.round(closed.contentWidth * 100) / 100,
    contentWidthOpen: Math.round(open.contentWidth * 100) / 100,
    contentWidthClosedAgain: Math.round(closedAgain.contentWidth * 100) / 100,
    scrollerClientWidth: closed.scrollerClientWidth,
    scrollerClientWidthOpen: open.scrollerClientWidth,
    scrollHeightOpen: open.scrollHeight,
    clientHeightOpen: open.clientHeight,
  };

  failures.push(
    ...run([
      [
        open.scrollHeight > open.clientHeight + 40,
        `${width}px: opening the long command detail overflows the child transcript (${open.scrollHeight}/${open.clientHeight})`,
      ],
      [
        gutter >= 5,
        `${width}px: the scrollport reserves its gutter before any overflow (${gutter}px)`,
      ],
      [
        near(open.contentWidth, closed.contentWidth) &&
          near(open.contentLeft, closed.contentLeft) &&
          near(open.contentRight, closed.contentRight),
        `${width}px: the content box keeps its width and position while the detail is open (${closed.contentWidth}/${open.contentWidth}, ${closed.contentLeft}/${open.contentLeft})`,
      ],
      [
        // The same pane without the rule shifts, so this renderer really
        // measures a space-consuming scrollbar rather than an overlay one.
        beforeClosed.contentWidth > beforeExpanded.contentWidth + 3,
        `${width}px: without the rule the same pane narrowed by ${Math.round(
          (beforeClosed.contentWidth - beforeExpanded.contentWidth) * 100,
        ) / 100}px when the detail opened`,
      ],
      [
        near(closedAgain.contentWidth, closed.contentWidth) &&
          near(closedAgain.contentLeft, closed.contentLeft),
        `${width}px: closing the detail leaves the content where it was (${closed.contentWidth}/${closedAgain.contentWidth})`,
      ],
      [
        near(open.referenceWidth, closed.referenceWidth) &&
          near(open.referenceLeft, closed.referenceLeft) &&
          near(open.referenceRight, closed.referenceRight),
        `${width}px: the first child card never shifts sideways (${closed.referenceLeft}/${open.referenceLeft})`,
      ],
      [
        open.scrollerClientWidth === closed.scrollerClientWidth &&
          closedAgain.scrollerClientWidth === closed.scrollerClientWidth,
        `${width}px: the scrollport width is the same in every state (${closed.scrollerClientWidth}/${open.scrollerClientWidth})`,
      ],
      [
        open.scrollerScrollWidth <= open.scrollerClientWidth + 1,
        `${width}px: the transcript never scrolls sideways (${open.scrollerScrollWidth}/${open.scrollerClientWidth})`,
      ],
      [
        near(open.composerWidth, closed.composerWidth) &&
          near(open.composerWidth, closed.tabWidth) &&
          near(open.composerBottom, open.tabBottom) &&
          near(closed.composerBottom, closed.tabBottom),
        `${width}px: the composer keeps its width and its seat at the pane's bottom (${closed.composerWidth}/${open.composerWidth})`,
      ],
    ]),
  );

  return { ok: failures.length === 0, failures, facts };
};

(globalThis as unknown as { subagentTranscriptGutterReady: true }).subagentTranscriptGutterReady =
  true;
