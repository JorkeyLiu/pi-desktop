import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC, type UiMessage } from "@pi-desktop/shared";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/*
 * A path-heavy child transcript in the work panel, in a real Chromium renderer
 * with the application's own built stylesheet.
 *
 * The claim is the row's hint: a file row prints the file's own name and nothing
 * else, so the whole path is offered on hover and to a screen reader, and no
 * element in the row exists to measure path candidates. The same tab is opened,
 * closed and switched between sessions — the shape of opening a subagent tab
 * whose delegate read a lot of files — and the hint is checked in every state.
 */

declare global {
  var toolPathNameRun: (options: {
    rowCount: number;
    widths: number[];
  }) => Promise<{
    ok: boolean;
    failures: string[];
    facts: Record<string, unknown>;
  }>;
}

const CALL = "call-task";
const createdAt = "2026-10-18T00:00:00.000Z";
const SESSIONS = ["names-a", "names-b"];

window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async () => ({ ok: true, data: undefined }),
  on: () => () => undefined,
} as unknown as typeof window.piDesktop;

/** Paths of every shape the row meets: deep, relative, Windows, long. */
const PATHS = [
  "/Users/jorkeyliu/workspace/repos/pi-desktop-mw/apps/desktop/src/features/chat/transcript/hooks/use-transcript-scroll.ts",
  "src/features/chat/transcript/hooks/use-transcript-window.ts",
  "C:\\Users\\jorkeyliu\\workspace\\repos\\pi-desktop-mw\\apps\\desktop\\src\\features\\hooks\\use-transcript-scroll.ts",
  "/Users/jorkeyliu/workspace/repos/pi-desktop/apps/desktop/src/features/chat/transcript/a-considerably-longer-name-for-one-row-of-the-transcript.spec.mjs",
  "/Users/jorkeyliu/workspace/repos/pi-desktop/apps/desktop/electron/ipc/sessions.ts",
  "/Users/jorkeyliu/workspace/repos/pi-desktop/crates/host-core/src/db.rs",
  "packages/plugin-sdk/src/index.ts",
  "/Users/jorkeyliu/workspace/repos/pi-desktop/docs/spec/04-ux/08-component-spec.md",
];

const pathAt = (index: number) => PATHS[index % PATHS.length];
/** The name the hint must print for `path`, spelled the way the fixture knows
 * it — independent of the module under test. */
const nameOf = (path: string) => path.split(/[/\\]/).pop() ?? path;

function message(
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role, content, createdAt, status: "complete", ...extra };
}

function messagesFor(rows: number): UiMessage[] {
  return [
    message("task", "tool", "", {
      toolName: "Task",
      toolCallId: CALL,
      toolStatus: "success",
      toolArgs: {
        agent: "explorer",
        description: "Scan the transcript rows",
        task: "Read every candidate file and report what each one does.",
      },
      toolResult: {
        details: {
          delegationId: CALL,
          agent: "explorer",
          status: "completed",
          startedAt: 1_000,
          completedAt: 42_000,
        },
      },
    }),
    ...Array.from({ length: rows }, (_, index) =>
      message(`r${index}`, "tool", "", {
        toolName: "Read",
        toolCallId: `r${index}`,
        toolStatus: "success",
        parentToolCallId: CALL,
        agentName: "explorer",
        toolArgs: { path: pathAt(index) },
        toolResult: { details: { content: `// ${pathAt(index)}` } },
      }),
    ),
    message("answer", "assistant", "Every file was read.", {
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

function seed(session: string, rows: number) {
  useAppStore.setState({
    activeSessionId: session,
    sessions: [
      {
        id: session,
        title: `Names ${session}`,
        source: "local",
        mode: "agent",
        createdAt,
        updatedAt: createdAt,
      } as never,
    ],
    messages: messagesFor(rows),
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
}

flushSync(() => seed(SESSIONS[0], 1));

const host = document.createElement("div");
host.style.cssText =
  "position:fixed;inset:0;display:flex;align-items:stretch;background:var(--ds-bg-primary)";
(document.body ?? document.documentElement).append(host);

const stage = document.createElement("div");
stage.id = "stage";
stage.style.cssText = "display:flex;height:720px;width:100%";
host.append(stage);

let apply: ((input: { session: string; rows: number; width: number; open: boolean }) => void) | undefined;

function Fixture() {
  const [state, setState] = useState({
    session: SESSIONS[0],
    rows: 1,
    width: 340,
    open: true,
  });
  apply = setState;
  return (
    <div id="pane" style={{ display: "flex", height: "100%", width: state.width }}>
      {state.open ? (
        <SubagentTranscriptTab key={state.session} delegationId={CALL} />
      ) : null}
    </div>
  );
}

const root = createRoot(stage);
flushSync(() => {
  root.render(
    <I18nextProvider i18n={i18n}>
      <Fixture />
    </I18nextProvider>,
  );
});

const frames = (count = 3) =>
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

const summaries = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".tool-row-summary.is-path"));

const scroller = () => document.querySelector<HTMLElement>(".subagent-transcript-scroll");

const hiddenPath = (host: Element) => {
  const header = host.querySelector<HTMLElement>(".tool-row-header");
  const id = header?.getAttribute("aria-describedby") ?? "";
  if (!id) return null;
  const target = document.getElementById(id);
  return { text: target?.textContent ?? null, hidden: target?.classList.contains("sr-only") === true };
};

/** What one mounted, settled tab shows for its `rows` file rows. */
function readPane(rows: number, width: number) {
  const failures: string[] = [];
  const painted = summaries();
  if (painted.length !== rows) {
    return { failures: [`${width}px: ${painted.length} path rows painted, ${rows} expected`] };
  }
  const panel = scroller();
  if (!panel) return { failures: [`${width}px: the tab has no scrollport`] };
  if (panel.scrollWidth > panel.clientWidth + 1) {
    failures.push(
      `${width}px: the transcript scrolls sideways (${panel.scrollWidth}/${panel.clientWidth})`,
    );
  }
  if (document.querySelector(".tool-path-measure") !== null) {
    failures.push(`${width}px: a path row still carries a measuring span`);
  }
  let shortened = 0;
  let longNameClipped = false;
  for (let index = 0; index < painted.length; index += 1) {
    const summary = painted[index];
    const path = pathAt(index);
    const name = nameOf(path);
    if (summary.textContent !== name) {
      failures.push(
        `${width}px row ${index}: the hint prints ${JSON.stringify(summary.textContent)} instead of the name`,
      );
    }
    if (summary.textContent?.includes("/") || summary.textContent?.includes("\\")) {
      failures.push(`${width}px row ${index}: the hint still prints a directory`);
    }
    if (summary.title !== path) {
      failures.push(`${width}px row ${index}: the hover text is not the whole path`);
    }
    const row = summary.closest<HTMLElement>(".tool-row, [data-message-id]");
    const described = row ? hiddenPath(row) : null;
    if (described?.text !== path || described.hidden !== true) {
      failures.push(`${width}px row ${index}: the row does not describe the whole path`);
    }
    const box = summary.getBoundingClientRect();
    const rowBox = (row ?? summary).getBoundingClientRect();
    if (box.right > rowBox.right + 0.5) {
      failures.push(`${width}px row ${index}: the name is drawn past its row`);
    }
    if (summary.scrollWidth > summary.clientWidth + 1) {
      shortened += 1;
      if (getComputedStyle(summary).textOverflow !== "ellipsis") {
        failures.push(`${width}px row ${index}: a clipped name has no ellipsis`);
      }
      if (name.length > 40) longNameClipped = true;
    }
  }
  return { failures, pathRows: painted.length, shortened, longNameClipped };
}

async function settle(input: { session: string; rows: number; width: number; open: boolean }) {
  if (input.open) seed(input.session, input.rows);
  flushSync(() => apply?.(input));
  await frames(4);
}

globalThis.toolPathNameRun = async ({ rowCount, widths }) => {
  const failures: string[] = [];
  const facts: Record<string, unknown> = {};

  // A tab opened on a delegate that read many files.
  await settle({ session: SESSIONS[0], rows: rowCount, width: widths[1], open: true });
  const opened = readPane(rowCount, widths[1]);
  failures.push(...opened.failures);
  facts.opened = { pathRows: opened.pathRows, shortened: opened.shortened };

  // The same tab narrowed to the panel's small width.
  await settle({ session: SESSIONS[0], rows: rowCount, width: widths[0], open: true });
  const narrow = readPane(rowCount, widths[0]);
  failures.push(...narrow.failures);
  facts.narrow = { pathRows: narrow.pathRows, shortened: narrow.shortened };

  // The long name is the one that has to ellipsize inside the row.
  if (!narrow.longNameClipped) {
    failures.push(`the long file name was not clipped at ${widths[0]}px`);
  }

  // Switching to another session, whose own tab is open on the same shape.
  await settle({ session: SESSIONS[1], rows: rowCount, width: widths[0], open: true });
  const switched = readPane(rowCount, widths[0]);
  failures.push(...switched.failures.map((failure) => `switched: ${failure}`));
  facts.switched = { pathRows: switched.pathRows, shortened: switched.shortened };

  // Closing the tab, then opening it again: only the open tab does this work.
  await settle({ session: SESSIONS[1], rows: rowCount, width: widths[0], open: false });
  const closedRows = summaries().length;
  if (closedRows !== 0) failures.push(`a closed tab still paints ${closedRows} path rows`);
  await settle({ session: SESSIONS[1], rows: rowCount, width: widths[0], open: true });
  const reopened = readPane(rowCount, widths[0]);
  failures.push(...reopened.failures.map((failure) => `reopened: ${failure}`));
  facts.reopened = { pathRows: reopened.pathRows, shortened: reopened.shortened };

  return { ok: failures.length === 0, failures, facts };
};

(globalThis as unknown as { toolPathNameReady: true }).toolPathNameReady = true;
