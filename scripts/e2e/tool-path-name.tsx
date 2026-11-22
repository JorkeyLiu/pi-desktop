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
  * else, so the whole path is the file name's own hover and screen-reader
  * description, and no element in the row exists to measure path candidates.
  * The click is split too: only the rendered file name preview-opens, while
  * the blank summary area, the tool name and the disclosure keep the toggle.
  * The same tab is opened, closed and switched between sessions — the shape of
  * opening a subagent tab whose delegate read a lot of files — and the hint is
  * checked in every state.
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
    workspace: {
      path: "/Users/jorkeyliu/workspace/repos/pi-desktop-mw",
      name: "pi-desktop-mw",
    },
    // The delegate tab reads the scoped history entry, never the live window
    // alone: a previous phase's entry would otherwise survive a reseed and the
    // probe would measure stale rows instead of the rows it just seeded.
    subagentHistory: {},
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
  // The scrollport keeps its offset across the open/narrow/switch/close
  // sequence, so start every measurement from the top.
  scroller()?.scrollTo(0, 0);
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
    // The tooltip moved with the click: only the rendered file name carries
    // the whole path now, never the stretching layout span around it.
    const names = summary.querySelectorAll<HTMLElement>(".tool-row-file-name");
    if (names.length !== 1) {
      failures.push(`${width}px row ${index}: the hint holds ${names.length} file names, 1 expected`);
      continue;
    }
    const file = names[0];
    if (file.textContent !== name) {
      failures.push(`${width}px row ${index}: the file name prints ${JSON.stringify(file.textContent)}`);
    }
    if (file.title !== path) {
      failures.push(`${width}px row ${index}: the file name hover is not the whole path`);
    }
    if (summary.title) {
      failures.push(`${width}px row ${index}: the layout span keeps its own hover text`);
    }
    if (summary.classList.contains("linked")) {
      failures.push(`${width}px row ${index}: the blank layout area still links`);
    }
    const row = summary.closest<HTMLElement>(".tool-row, [data-message-id]");
    const described = row ? hiddenPath(row) : null;
    if (described?.text !== path || described.hidden !== true) {
      failures.push(`${width}px row ${index}: the row does not describe the whole path`);
    }
    const box = summary.getBoundingClientRect();
    const fileBox = file.getBoundingClientRect();
    const rowBox = (row ?? summary).getBoundingClientRect();
    if (fileBox.width > box.width + 0.5) {
      failures.push(`${width}px row ${index}: the name is drawn past its hint`);
    }
    if (box.right > rowBox.right + 0.5) {
      failures.push(`${width}px row ${index}: the name is drawn past its row`);
    }
    // Only the rendered file name may clip: it carries its own ellipsis
    // clamped to the summary, while the stretching layout span never does.
    const fileClipped = file.scrollWidth > file.clientWidth + 1;
    if (summary.scrollWidth > summary.clientWidth + 1 && !fileClipped) {
      failures.push(`${width}px row ${index}: the layout span clips past the name`);
    }
    if (fileClipped) {
      shortened += 1;
      if (getComputedStyle(file).textOverflow !== "ellipsis") {
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
/**
 * The split click contract on one linked file row, through real hit-testing:
 * the rendered file name preview-opens exactly once per click and never
 * toggles, while the blank summary area, the tool name and the disclosure
 * keep the toggle and never preview. Preview attempts are the file-reference
 * resolutions the click actually requests.
 */
async function readHitbox(width: number) {
  const failures: string[] = [];
  const resolveChannel = String(IPC.invoke.fsResolveRef);
  const invokeRecord: Array<{ channel: string }> = [];
  const desktop = window.piDesktop as unknown as {
    invoke: (...args: never[]) => Promise<unknown>;
  };
  const innerInvoke = desktop.invoke;
  desktop.invoke = (async (...args: never[]) => {
    invokeRecord.push({ channel: String(args[0]) });
    return innerInvoke(...args);
  }) as never;
  try {
    await settle({ session: SESSIONS[0], rows: 3, width, open: true });
    const row = document.querySelector<HTMLElement>(
      '.tool-row[data-message-id="r0"]',
    );
    const summary = row?.querySelector<HTMLElement>(".tool-row-summary.is-path");
    const file = summary?.querySelector<HTMLElement>(".tool-row-file-name");
    const header = row?.querySelector<HTMLElement>(".tool-row-header");
    if (!row || !summary || !file || !header) {
      return { failures: ["no linked file row mounted for the hitbox probe"], facts: {} };
    }
    if (!file.classList.contains("linked")) {
      return { failures: ["row r0 is not previewable; the hitbox probe needs a linked row"], facts: {} };
    }
    // The probe clicks through the same hit-testing a pointer uses, so the
    // target row itself must be laid out in view: centering it (not just the
    // scrollport top) keeps every measured point inside the viewport, where
    // elementFromPoint can resolve it instead of returning null.
    scroller()?.scrollTo(0, 0);
    row.scrollIntoView({ block: "center" });
    await frames(4);
    const resolves = () =>
      invokeRecord.filter((entry) => entry.channel === resolveChannel).length;
    const expanded = () =>
      header.getAttribute("aria-expanded") === "true" &&
      row.querySelector(".tool-row-body") !== null;
    const describe = (element: Element | null) => {
      if (element === null) return "null";
      const classes =
        typeof element.className === "string" ? element.className : "";
      return `${element.tagName.toLowerCase()}.${classes.split(/\s+/).slice(0, 3).join(".")}`;
    };
    const clickAt = async (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      hits.push(describe(hit));
      hit?.click();
      syncResolves.push(resolves());
      await frames(3);
    };
    const hits: string[] = [];
    const syncResolves: number[] = [];
    // Geometry: the name shrinks to its text while the layout span stretches.
    const box = summary.getBoundingClientRect();
    const fileBox = file.getBoundingClientRect();
    const renderedName = file.textContent ?? "";
    facts_check_geometry: {
      if (fileBox.width > box.width - 8) {
        failures.push(
          `the ${renderedName} row leaves no blank summary area (${fileBox.width.toFixed(1)}/${box.width.toFixed(1)})`,
        );
        break facts_check_geometry;
      }
      if (Math.abs(fileBox.left - box.left) > 6) {
        failures.push("the file name does not start where its hint starts");
      }
    }
    // A click on the rendered name only: one preview, no toggle.
    const before = resolves();
    await clickAt(fileBox.left + fileBox.width / 2, fileBox.top + fileBox.height / 2);
    if (expanded()) failures.push("clicking the file name toggled the row");
    if (resolves() !== before + 1) {
      failures.push(`clicking the file name requested ${resolves() - before} previews, 1 expected`);
    }
    // A second click on the name: one more preview, still no toggle.
    await clickAt(fileBox.left + fileBox.width / 2, fileBox.top + fileBox.height / 2);
    if (expanded()) failures.push("clicking the file name twice toggled the row");
    if (resolves() !== before + 2) {
      failures.push(`two file name clicks requested ${resolves() - before} previews, 2 expected`);
    }
    // A click on the blank summary area: toggle, never a preview.
    const blankX = box.right - 4;
    if (blankX <= fileBox.right + 2) {
      failures.push("no clickable blank area left beside the file name");
    } else {
      await clickAt(blankX, box.top + box.height / 2);
      if (!expanded()) failures.push("clicking the blank summary area did not toggle the row");
      if (resolves() !== before + 2) {
        failures.push("clicking the blank summary area requested a preview");
      }
      // The tool name keeps the same toggle, still without a preview.
      const nameCell = row.querySelector<HTMLElement>(".tool-row-name");
      const nameBox = nameCell?.getBoundingClientRect();
      if (!nameCell || !nameBox) {
        failures.push("the tool name cell is missing");
      } else {
        await clickAt(nameBox.left + nameBox.width / 2, nameBox.top + nameBox.height / 2);
        if (expanded()) failures.push("clicking the tool name did not collapse the row");
        if (resolves() !== before + 2) {
          failures.push("clicking the tool name requested a preview");
        }
      }
    }
    return {
      failures,
      facts: {
        fileWidth: Math.round(fileBox.width),
        summaryWidth: Math.round(box.width),
        previews: resolves() - before,
        hits,
        syncResolves,
        channels: invokeRecord.map((entry) => entry.channel).slice(-8),
        ariaAfterBlank: header.getAttribute("aria-expanded"),
        bodyAfterBlank: row.querySelector(".tool-row-body") !== null,
      },
    };
  } finally {
    desktop.invoke = innerInvoke;
  }
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

  // The split click through real hit-testing, at the wide width: the name
  // preview-opens exactly once per click without toggling, while the blank
  // summary area and the tool name toggle without previewing.
  const hitbox = await readHitbox(widths[1]);
  failures.push(...hitbox.failures.map((failure) => `hitbox: ${failure}`));
  facts.hitbox = hitbox.facts;

  return { ok: failures.length === 0, failures, facts };
};

(globalThis as unknown as { toolPathNameReady: true }).toolPathNameReady = true;
