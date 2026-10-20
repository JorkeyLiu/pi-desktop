import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ReviewTab } from "../../apps/desktop/src/components/workpanel/ReviewTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var reviewFilesProbe: () => Promise<unknown>;
}

/*
 * The Review panel in a real Chromium renderer with the application's own
 * stylesheet: the production ReviewTab, the production store, and only the IPC
 * transport replaced at that boundary. The probe never re-implements a row; it
 * drives what the app renders and measures the result.
 */

const createdAt = "2026-10-18T00:00:00.000Z";

function editMessage(
  id: string,
  path: string,
  snapshotId: string,
  additions: number,
  deletions: number,
): UiMessage {
  return {
    id,
    role: "tool",
    content: "",
    createdAt,
    toolName: "Edit",
    toolCallId: `call-${id}`,
    toolStatus: "success",
    toolArgs: { path },
    toolResult: {
      details: {
        root: "workspace",
        review: {
          version: 1,
          snapshotId,
          messageId: id,
          path,
          operation: "edit",
          status: "modified",
          state: "active",
          additions,
          deletions,
          hunks: [],
          reversible: true,
        },
      },
    },
  };
}

// The transcript only holds the newest page: the early edit below is outside it.
const tailMessages: UiMessage[] = [
  editMessage("tool-98", "src/a.ts", "snapshot-98", 1, 0),
  editMessage("tool-99", "src/a.ts", "snapshot-99", 1, 0),
];

const ROOT_A = "/projects/app";
const ROOT_B = "/projects/app-docs";

const sessionOneFiles = [
  {
    version: 1,
    root: ROOT_A,
    path: "src/a.ts",
    status: "modified",
    additions: 3,
    deletions: 1,
    hunks: [
      {
        header: "@@ -1,3 +1,4 @@",
        lines: [
          { type: "context", text: "export const one = 1;" },
          { type: "del", text: "export const two = 2;" },
          { type: "add", text: "export const two = 2 + 0;" },
          { type: "context", text: "export const three = 3;" },
        ],
      },
    ],
    reversible: true,
    rolledBack: false,
    snapshotIds: ["snapshot-1", "snapshot-98", "snapshot-99"],
  },
  {
    version: 1,
    root: ROOT_B,
    path: "src/a.ts",
    status: "added",
    additions: 1,
    deletions: 0,
    hunks: [],
    reversible: true,
    rolledBack: false,
    snapshotIds: ["snapshot-2"],
  },
  {
    version: 1,
    root: ROOT_A,
    path: "docs/spec/08-component-spec.md",
    status: "modified",
    truncated: true,
    reason: "fileTooLarge",
    hunks: [],
    reversible: false,
    rolledBack: false,
    snapshotIds: ["snapshot-3"],
  },
];

const sessionTwoFiles = [
  {
    version: 1,
    root: ROOT_A,
    path: "other.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    hunks: [
      {
        header: "@@ -1,1 +1,1 @@",
        lines: [
          { type: "del", text: "old" },
          { type: "add", text: "new" },
        ],
      },
    ],
    reversible: false,
    rolledBack: false,
    snapshotIds: ["snapshot-20"],
  },
];

type Probe = { failures: string[]; observed: Record<string, unknown> };

const settle = async (ticks = 4) => {
  for (let tick = 0; tick < ticks; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};

globalThis.reviewFilesProbe = async () => {
  const probe: Probe = { failures: [], observed: {} };
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) probe.observed[name] = detail ?? true;
    else probe.failures.push(`${name}: ${JSON.stringify(detail ?? null)}`);
  };

  const renderErrors: unknown[] = [];
  const calls: Array<{ channel: string; input: unknown }> = [];
  let rolledBack = false;
  // A session switch's answer is held open so the probe can inspect the panel
  // while the previous rows would still be on screen.
  let releaseSessionTwo: (() => void) | null = null;
  let sessionTwoPending = false;

  Object.defineProperty(window, "piDesktop", {
    configurable: true,
    value: {
      platform: "darwin",
      invoke: async (channel: string, input: unknown) => {
        calls.push({ channel, input });
        if (channel === "pi-desktop/workspace/review/files") {
          const sessionId = (input as { sessionId?: string })?.sessionId;
          if (sessionId === "session-2") {
            sessionTwoPending = true;
            await new Promise<void>((resolve) => {
              releaseSessionTwo = resolve;
            });
            return {
              ok: true,
              data: { files: sessionTwoFiles },
            };
          }
          return {
            ok: true,
            data: {
              files: rolledBack ? sessionOneFiles.slice(1) : sessionOneFiles,
              truncated: true,
            },
          };
        }
        if (channel === "pi-desktop/workspace/review/rollbackFile") {
          rolledBack = true;
          return {
            ok: true,
            data: {
              status: "rolledBack",
              root: ROOT_A,
              path: "src/a.ts",
              rolledBack: [
                { snapshotId: "snapshot-1", messageId: "tool-1" },
                { snapshotId: "snapshot-98", messageId: "tool-98" },
                { snapshotId: "snapshot-99", messageId: "tool-99" },
              ],
            },
          };
        }
        return {
          ok: false,
          error: { code: "INVALID_PARAMS", message: `unexpected channel ${channel}` },
        };
      },
    },
  });

  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });

  useAppStore.setState({
    messages: tailMessages,
    activeSessionId: "session-1",
    sessions: [],
  });

  const stage = document.createElement("div");
  stage.style.cssText = "width: 560px; padding: 12px;";
  document.body.append(stage);
  const root = createRoot(stage);
  const mount = async () => {
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <ReviewTab />
        </I18nextProvider>,
      ),
    );
    await settle();
  };

  const rows = () =>
    Array.from(stage.querySelectorAll<HTMLElement>('[data-scope="file"]'));
  const rowFor = (display: string) =>
    rows().find(
      (row) => row.querySelector(".review-change-card-path")?.textContent === display,
    );

  try {
    window.addEventListener("error", (event) =>
      renderErrors.push(event.error ?? event.message),
    );
    await mount();

    // 1. The host owns the file set, so an edit outside the transcript window is
    // still a row, and the request carries only the session identity.
    const listCalls = calls.filter(
      (call) => call.channel === "pi-desktop/workspace/review/files",
    );
    check(
      "the panel asks only for the session's files",
      JSON.stringify(listCalls[0]?.input) ===
        JSON.stringify({ sessionId: "session-1" }),
      listCalls[0]?.input,
    );
    check("one row per root and path", rows().length === 3, rows().length);
    check(
      "rows from two roots are told apart",
      Boolean(rowFor("app/src/a.ts")) && Boolean(rowFor("app-docs/src/a.ts")),
      rows().map((row) => row.textContent),
    );
    check(
      "the summary counts files, not tool calls",
      stage.querySelector(".review-summary")?.textContent === "3 files changed",
      stage.querySelector(".review-summary")?.textContent,
    );
    // 2. Net totals, and a lower-bound marker when the answer is bounded.
    const totals = stage.querySelector(".review-toolbar-counts");
    check(
      "the summary sums the net change",
      totals?.textContent?.includes("+4") === true &&
        totals?.textContent?.includes("−1") === true,
      totals?.textContent,
    );
    check(
      "a bounded answer says its totals are partial",
      totals?.getAttribute("title") ===
        "Totals only include files whose diff could be compared",
      totals?.getAttribute("title"),
    );
    // 3. A row states the real limit instead of a zero count.
    const specRow = rowFor("app/docs/spec/08-component-spec.md");
    check(
      "an uncounted row shows a marker, not +0/−0",
      Boolean(specRow?.querySelector(".diff-count-unknown")),
    );
    const specHeader = specRow?.querySelector<HTMLElement>(
      ".review-change-card-header",
    );
    check(
      "the uncounted row names the reason in its accessible name",
      specHeader?.getAttribute("aria-label")?.includes(
        "Line counts unavailable",
      ) === true,
      specHeader?.getAttribute("aria-label"),
    );
    check(
      "the row starts collapsed",
      specHeader?.getAttribute("aria-expanded") === "false",
    );
    specHeader?.click();
    await settle();
    check(
      "the oversized file names its own reason",
      specRow?.textContent?.includes("This file is too large to compare here") ===
        true,
      specRow?.textContent?.slice(0, 120),
    );
    // 4. Expanding shows the net hunk.
    const aRow = rowFor("app/src/a.ts");
    aRow?.querySelector<HTMLElement>(".review-change-card-header")?.click();
    await settle();
    check(
      "expanding a file shows its net hunk",
      aRow?.querySelectorAll(".review-change-diff .diff-line.add").length === 1 &&
        aRow?.querySelectorAll(".review-change-diff .diff-line.del").length === 1,
      aRow?.querySelectorAll(".review-change-diff .diff-line").length,
    );
    // 5. The file rollback names the session, root, and path behind the row.
    const rollback = aRow?.querySelector<HTMLElement>(".review-change-rollback");
    check("the file row offers rollback", Boolean(rollback));
    rollback?.click();
    await settle(6);
    const rollbackCall = calls.find(
      (call) => call.channel === "pi-desktop/workspace/review/rollbackFile",
    );
    check(
      "the rollback sends the row's session, root, and path",
      JSON.stringify(rollbackCall?.input) ===
        JSON.stringify({
          sessionId: "session-1",
          root: ROOT_A,
          path: "src/a.ts",
        }),
      rollbackCall?.input,
    );
    check(
      "the panel refetches after a rolled-back file",
      calls.filter((call) => call.channel === "pi-desktop/workspace/review/files")
        .length >= 2,
      calls.length,
    );
    check(
      "the rolled-back row leaves the list",
      rows().length === 2,
      rows().length,
    );

    // 6. Switching sessions clears the previous rows immediately, and the new
    // answer is the only thing that can repaint them.
    flushSync(() => useAppStore.setState({ activeSessionId: "session-2" }));
    await settle(1);
    check(
      "the previous session's rows are gone before the new answer lands",
      rows().length === 0 && sessionTwoPending,
      { rows: rows().length, sessionTwoPending },
    );
    check(
      "the loading panel offers no rollback for another session",
      stage.querySelector(".review-change-rollback") === null,
    );
    // A row's action is bound to the session it came from, so a late click can
    // never write into the session that replaced it.
    const stale = await useAppStore
      .getState()
      .rollbackReviewFile("session-1", ROOT_A, "src/a.ts");
    check(
      "a rollback for a session that is no longer active does nothing",
      stale === null &&
        !calls.some(
          (call) =>
            call.channel === "pi-desktop/workspace/review/rollbackFile" &&
            (call.input as { sessionId?: string })?.sessionId === "session-1" &&
            calls.indexOf(call) > 2,
        ),
      stale,
    );
    releaseSessionTwo?.();
    await settle(6);
    check(
      "the new session's own rows arrive",
      rows().length === 1 && Boolean(rowFor("other.ts")),
      rows().map((row) => row.textContent),
    );
    check(
      "no render error escaped",
      renderErrors.length === 0,
      renderErrors.map(String),
    );
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
