import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { SubagentTitleProvider } from "../../apps/desktop/src/lib/subagent-title-provider";

declare global {
  var toolBrowserProbe: () => Promise<unknown>;
}

/*
 * The shipped Browser plugin tool and the TaskSteer built-in, rendered in a
 * real Chromium renderer with the application's own built stylesheet: the same
 * ToolRow the transcript mounts, driven through its real disclosure. Nothing
 * here re-implements a row; the probe only drives and measures what the app
 * renders. No real page or network is touched: every result is a canned host
 * payload shaped exactly as pi-ai delivers it (`{ content, details }`).
 */

const createdAt = "2026-10-18T00:00:00.000Z";

function message(
  id: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role: "tool", content: "", createdAt, ...extra };
}

/** A host tool result as pi-ai delivers it: structured details plus text echo. */
function envelope(details: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

const BROWSER = "plugin_pi_browser_Browser";
const EXPRESSION = "document.querySelector('main').innerText /* __SECRET_EXPR__ */";
const TYPED = "s3cr3t typed text";

const LONG_PATH =
  "/Users/me/workspace/repos/pi-desktop/apps/desktop/src/components/transcript/nested/tool/ToolTerminal.tsx";

const rows: Array<{ key: string; row: UiMessage; titles?: UiMessage[] }> = [
  {
    key: "navigate",
    row: message("browser-navigate", {
      toolName: BROWSER,
      toolCallId: "call-browser-navigate",
      toolStatus: "success",
      toolArgs: { action: "navigate", url: "https://example.com/docs" },
      toolResult: envelope({
        ok: true,
        action: "navigate",
        state: {
          url: "https://example.com/docs",
          title: "Example Docs",
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          sessionId: "sess-nav-1",
          tabId: "tab-nav-1",
        },
      }),
    }),
  },
  {
    key: "evaluate",
    row: message("browser-evaluate", {
      toolName: BROWSER,
      toolCallId: "call-browser-evaluate",
      toolStatus: "success",
      toolArgs: { action: "evaluate", expression: EXPRESSION },
      toolResult: envelope({ ok: true, action: "evaluate", result: "Example Domain" }),
    }),
  },
  {
    key: "screenshot",
    row: message("browser-screenshot", {
      toolName: BROWSER,
      toolCallId: "call-browser-screenshot",
      toolStatus: "success",
      toolArgs: { action: "screenshot" },
      toolResult: {
        details: {
          ok: true,
          action: "screenshot",
          path: "/tmp/shot.png",
          text: "Saved",
          mimeType: "image/png",
          images: [
            {
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            },
          ],
        },
      },
    }),
  },
  {
    key: "failed",
    row: message("browser-failed", {
      toolName: BROWSER,
      toolCallId: "call-browser-failed",
      toolStatus: "error",
      toolArgs: { action: "evaluate", expression: EXPRESSION },
      toolResult: envelope({
        ok: false,
        action: "evaluate",
        error: "frame detached",
        errorCode: "E_FRAME",
        state: { sessionId: "sess-fail-1", tabId: "tab-fail-1" },
      }),
    }),
  },
  {
    key: "thirdParty",
    row: message("browser-third-party", {
      toolName: "plugin_other_Browser",
      toolCallId: "call-browser-third-party",
      toolStatus: "success",
      toolArgs: { action: "navigate", url: "https://third.example/" },
      toolResult: envelope({
        ok: true,
        state: { url: "https://third.example/", title: "Third" },
      }),
    }),
  },
  {
    key: "steer",
    row: message("task-steer", {
      toolName: "TaskSteer",
      toolCallId: "call-task-steer",
      toolStatus: "success",
      toolArgs: {
        delegationId: "dlg-steer-1",
        description: "Nudge the runner",
        message: "Please also cover edge cases.",
      },
      toolResult: envelope({
        delegationId: "dlg-steer-1",
        messageId: "msg-steer-1",
        status: "queued",
        delivery: "next_turn",
        source: "model",
      }),
    }),
  },
  {
    key: "steerFailed",
    row: message("task-steer-failed", {
      toolName: "TaskSteer",
      toolCallId: "call-task-steer-failed",
      toolStatus: "error",
      toolArgs: {
        delegationId: "dlg-steer-2",
        description: "Nudge the runner",
        message: "Please also cover edge cases.",
      },
      toolResult: envelope({
        delegationId: "dlg-steer-2",
        messageId: "msg-steer-2",
        status: "queued",
        error: "delegation ended",
        errorCode: "E_GONE",
      }),
    }),
  },
  {
    key: "steerTarget",
    titles: [
      message("task-seed-target", {
        toolName: "Task",
        toolCallId: "call-task-seed-target",
        toolStatus: "success",
        toolArgs: { description: "修复分页窗口合并", agent: "manifestor" },
        toolResult: envelope({ delegationId: "dlg-steer-target", status: "running" }),
      }),
    ],
    row: message("task-steer-target", {
      toolName: "TaskSteer",
      toolCallId: "call-task-steer-target",
      toolStatus: "success",
      toolArgs: {
        delegationId: "dlg-steer-target",
        message: "请复用现有分页窗口模型，保留向前与向后加载行为，并补充边界测试。",
      },
      toolResult: envelope({
        delegationId: "dlg-steer-target",
        messageId: "msg-steer-target",
        status: "queued",
        delivery: "next_turn",
        source: "model",
      }),
    }),
  },
  {
    key: "readLong",
    row: message("read-long", {
      toolName: "Read",
      toolCallId: "call-read-long",
      toolStatus: "success",
      toolArgs: { path: LONG_PATH },
      toolResult: {
        details: { path: LONG_PATH, root: "workspace", lineCount: 42 },
      },
    }),
  },
  {
    key: "readScratch",
    row: message("read-scratch", {
      toolName: "Read",
      toolCallId: "call-read-scratch",
      toolStatus: "success",
      toolArgs: { path: "/tmp/scratch-note.md" },
      toolResult: {
        details: {
          path: "/tmp/scratch-note.md",
          root: "scratch",
          content: "scratch notes",
        },
      },
    }),
  },
];

type Probe = {
  failures: string[];
  observed: Record<string, unknown>;
};

const settle = async (ticks = 4) => {
  for (let tick = 0; tick < ticks; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};

globalThis.toolBrowserProbe = async () => {
  const probe: Probe = { failures: [], observed: {} };
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) probe.observed[name] = detail ?? true;
    else probe.failures.push(`${name}: ${JSON.stringify(detail ?? null)}`);
  };

  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });

  const stage = document.createElement("div");
  stage.id = "stage";
  stage.style.cssText = "padding:12px;max-width:900px";
  document.body.append(stage);

  const roots: Array<{ unmount: () => void }> = [];
  const hosts = new Map<string, HTMLElement>();
  for (const { key, row, titles } of rows) {
    const host = document.createElement("div");
    host.dataset.row = key;
    stage.append(host);
    const root = createRoot(host);
    const node = (
      <I18nextProvider i18n={i18n}>
        <TranscriptDisclosureProvider>
          {titles ? (
            <SubagentTitleProvider messages={[...titles, row]}>
              <ToolRow message={row} />
            </SubagentTitleProvider>
          ) : (
            <ToolRow message={row} />
          )}
        </TranscriptDisclosureProvider>
      </I18nextProvider>
    );
    flushSync(() => root.render(node));
    roots.push(root);
    hosts.set(key, host);
  }
  await settle();

  const headerText = (key: string) =>
    hosts.get(key)?.querySelector(".tool-row-header")?.textContent ?? "";
  const bodyText = (key: string) =>
    hosts.get(key)?.querySelector(".tool-row-body")?.textContent ?? "";
  const open = async (key: string) => {
    const header = hosts
      .get(key)
      ?.querySelector<HTMLElement>(".tool-row-header");
    if (!header) throw new Error(`no tool row header rendered for ${key}`);
    header.click();
    await settle();
  };

  // Collapsed heads: localized browser identity plus the per-action title, a
  // bounded result summary, and no raw ids, scripts, or typed text.
  check(
    "navigate head names the page",
    headerText("navigate").includes("Browser · Open page") &&
      headerText("navigate").includes("Example Docs · https://example.com/docs"),
    headerText("navigate"),
  );
  check(
    "evaluate head shows the bounded value, never the script",
    headerText("evaluate").includes("Browser · Run script") &&
      headerText("evaluate").includes("Example Domain") &&
      !headerText("evaluate").includes("__SECRET_EXPR__"),
    headerText("evaluate"),
  );
  check(
    "failed evaluate head keeps the action summary",
    headerText("failed").includes("Browser · Run script") &&
      !headerText("failed").includes("__SECRET_EXPR__"),
    headerText("failed"),
  );
  check(
    "third-party Browser keeps its generic name",
    !headerText("thirdParty").includes("Browser · Open page"),
    headerText("thirdParty"),
  );
  check(
    "steer head names the guidance it carries",
    headerText("steer").includes("Task steer") &&
      headerText("steer").includes("Nudge the runner") &&
      headerText("steer").includes("Sent") &&
      !headerText("steer").includes("dlg-steer-1"),
    headerText("steer"),
  );

  // Expanded successes: curated content with the untouched payload one closed
  // disclosure away — never args or state as first-level content.
  await open("navigate");
  const navigateHost = hosts.get("navigate");
  const navigateCurated =
    [...(navigateHost?.querySelectorAll(".tool-row-body > *:not(.is-raw)") ?? [])]
      .map((node) => node.textContent ?? "")
      .join(" ");
  check(
    "navigate body names the page title and address",
    navigateCurated.includes("Example Docs") &&
      navigateCurated.includes("https://example.com/docs") &&
      !navigateCurated.includes("sess-nav-1"),
    navigateCurated.slice(0, 400),
  );
  check(
    "navigate raw payload stays a closed disclosure",
    hosts.get("navigate")?.querySelector(".tool-block.is-raw") !== null &&
      hosts.get("navigate")?.querySelector(".tool-block.is-raw details[open]") ===
        null,
  );

  await open("evaluate");
  check(
    "evaluate body shows the value, not the expression as input",
    bodyText("evaluate").includes("Example Domain") &&
      !bodyText("evaluate").includes("__SECRET_EXPR__"),
    bodyText("evaluate").slice(0, 400),
  );

  await open("screenshot");
  const shot = hosts
    .get("screenshot")
    ?.querySelector<HTMLImageElement>("img.tool-screenshot-image");
  check(
    "screenshot body shows the actual image",
    shot !== null &&
      (shot?.src ?? "").startsWith("data:image/png;base64,"),
    shot?.src?.slice(0, 60),
  );

  // Failures: exactly the reason, even though the payload echoes arguments.
  await open("failed");
  const failedBody = bodyText("failed");
  check(
    "failed evaluate states only its reason",
    failedBody.includes("frame detached") &&
      !failedBody.includes("__SECRET_EXPR__") &&
      !failedBody.includes("sess-fail-1") &&
      hosts.get("failed")?.querySelector("img.tool-screenshot-image") === null &&
      hosts.get("failed")?.querySelector(".tool-block.is-raw") === null,
    failedBody.slice(0, 400),
  );

  // TaskSteer: the target row shows the guidance actually sent, never routing
  // ids or the receipt's internals; a failure states only its cause.
  await open("steer");
  const steerBody = bodyText("steer");
  check(
    "steer body shows the guidance, never ids or receipt internals",
    steerBody.includes("Please also cover edge cases.") &&
      !steerBody.includes("dlg-steer-1") &&
      !steerBody.includes("msg-steer-1") &&
      !steerBody.includes("next_turn") &&
      hosts.get("steer")?.querySelector(".tool-block.is-raw") === null,
    steerBody.slice(0, 400),
  );
  await open("steerTarget");
  const steerTargetHead = headerText("steerTarget");
  const steerTargetBody = bodyText("steerTarget");
  check(
    "steer with a seeded task names agent, target and sent status",
    steerTargetHead.includes("Task steer") &&
      steerTargetHead.includes("manifestor") &&
      steerTargetHead.includes("修复分页窗口合并") &&
      steerTargetHead.includes("Sent") &&
      !steerTargetHead.includes("收敛分页窗口合并逻辑"),
    steerTargetHead,
  );
  check(
    "steer with a seeded task shows only the sent guidance as output",
    steerTargetBody.includes("Output") &&
      steerTargetBody.includes("请复用现有分页窗口模型，保留向前与向后加载行为，并补充边界测试。") &&
      !steerTargetBody.includes("修复分页窗口合并") &&
      !steerTargetBody.includes("dlg-steer-target") &&
      !steerTargetBody.includes("msg-steer-target") &&
      !steerTargetBody.includes("next_turn") &&
      hosts.get("steerTarget")?.querySelectorAll(".tool-block").length === 1,
    steerTargetBody.slice(0, 400),
  );
  await open("steerFailed");
  const steerFailedBody = bodyText("steerFailed");
  check(
    "failed steer states only its cause",
    steerFailedBody.includes("delegation ended") &&
      !steerFailedBody.includes("Please also cover edge cases.") &&
      !steerFailedBody.includes("dlg-steer-2"),
    steerFailedBody.slice(0, 400),
  );

  // Coexistence with the filename + directory work: the file name still owns
  // the preview, and a scratch root never reaches the collapsed chips.
  const fileName =
    hosts.get("readLong")?.querySelector(".tool-row-file-name")?.textContent ?? "";
  check("long path still renders its file name", fileName === "ToolTerminal.tsx", fileName);
  const scratchChips =
    hosts.get("readScratch")?.querySelector(".tool-row-chips")?.textContent ?? "";
  check(
    "scratch root stays out of the collapsed chips",
    !/scratch/i.test(scratchChips),
    scratchChips,
  );

  return { ok: probe.failures.length === 0, failures: probe.failures, observed: probe.observed };
};
