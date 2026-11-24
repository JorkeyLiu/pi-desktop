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
  var taskHeaderProbe: (mode?: string) => Promise<unknown>;
}

/*
 * The unified task header: a targeted `TaskSteer` reuses the delivered
 * `TaskWait` compact header — left tool identity plus the plain recorded
 * agent, right target title tile plus the row state — instead of the generic
 * agent pill plus text summary.
 *
 * Rendered in a real Chromium renderer with the application's own built
 * stylesheet: the production ToolRow through the real SubagentTitleProvider,
 * driven through its real disclosure. No real provider or network is touched:
 * every result is a canned host payload shaped exactly as pi-ai delivers it
 * (`{ content, details }`). The probe only drives and measures what the app
 * renders: slots, classes, geometry, ellipsis, and independent expand and
 * collapse of the two heads.
 */

const createdAt = "2026-10-18T00:00:00.000Z";

function message(id: string, extra: Partial<UiMessage> = {}): UiMessage {
  return { id, role: "tool", content: "", createdAt, ...extra };
}

/** A host tool result as pi-ai delivers it: structured details plus text echo. */
function envelope(details: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

const TITLE = "修复分页窗口合并";
const LONG_TITLE =
  "修复分页窗口合并——保留向前与向后加载行为并补充边界测试，长标题必须省略号截断对齐验证";
const AGENT = "manifestor";
const GUIDANCE = "请复用现有分页窗口模型，保留向前与向后加载行为，并补充边界测试。";

function taskSeed(callId: string, delegationId: string, agent: string, description?: string) {
  return message(`task-${callId}`, {
    toolName: "Task",
    toolCallId: `call-${callId}`,
    toolStatus: "success",
    toolArgs: { agent, ...(description ? { description } : {}) },
    toolResult: envelope({ delegationId, status: "completed" }),
  });
}

function deliveredWait(key: string, delegationId: string, agent: string) {
  return message(key, {
    toolName: "TaskWait",
    toolCallId: `call-${key}`,
    toolStatus: "success",
    toolArgs: { delegationIds: [delegationId] },
    toolResult: {
      content: [{ type: "text", text: `## ${agent} (${delegationId}) — completed\ndone` }],
      details: {
        status: "completed",
        completion: "all",
        includedDelegationIds: [delegationId],
        delegations: [{ delegationId, agent, status: "completed" }],
      },
    },
  });
}

function steerRow(key: string, delegationId: string, text: string, extra: Partial<UiMessage> = {}) {
  return message(key, {
    toolName: "TaskSteer",
    toolCallId: `call-${key}`,
    toolStatus: "success",
    toolArgs: { delegationId, message: text },
    toolResult: envelope({
      delegationId,
      messageId: `msg-${key}`,
      status: "queued",
      delivery: "next_turn",
      source: "model",
    }),
    ...extra,
  });
}

const seedA = taskSeed("seed-a", "dlg-a", AGENT, TITLE);
const seedLong = taskSeed("seed-long", "dlg-long", AGENT, LONG_TITLE);

const rows: Array<{ key: string; row: UiMessage; titles: UiMessage[] }> = [
  { key: "wait", row: deliveredWait("wait", "dlg-a", AGENT), titles: [seedA] },
  { key: "steer", row: steerRow("steer", "dlg-a", GUIDANCE), titles: [seedA] },
  { key: "steerLong", row: steerRow("steer-long", "dlg-long", GUIDANCE), titles: [seedLong] },
  {
    key: "steerRunning",
    row: steerRow("steer-running", "dlg-a", GUIDANCE, {
      toolStatus: "running",
      toolResult: undefined,
    }),
    titles: [seedA],
  },
  {
    key: "steerFailed",
    row: steerRow("steer-failed", "dlg-a", GUIDANCE, {
      toolStatus: "error",
      toolResult: envelope({
        delegationId: "dlg-a",
        messageId: "msg-steer-failed",
        status: "queued",
        error: "delegation ended",
        errorCode: "E_GONE",
      }),
    }),
    titles: [seedA],
  },
  {
    key: "steerUnknown",
    row: steerRow("steer-unknown", "dlg-missing", "nudge the runner"),
    titles: [],
  },
  {
    key: "waitProgress",
    row: message("wait-progress", {
      toolName: "TaskWait",
      toolCallId: "call-wait-progress",
      toolStatus: "success",
      toolArgs: { delegationIds: ["dlg-a"] },
      toolResult: {
        content: [{ type: "text", text: "still running" }],
        details: {
          status: "wakeup",
          wakeReason: "time",
          delegations: [{ delegationId: "dlg-a", agent: AGENT, status: "running" }],
        },
      },
    }),
    titles: [seedA],
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

let mounted: Array<{ unmount: () => void }> = [];

globalThis.taskHeaderProbe = async (mode = "wide") => {
  const probe: Probe = { failures: [], observed: {} };
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) probe.observed[`${mode}:${name}`] = detail ?? true;
    else probe.failures.push(`${mode}:${name}: ${JSON.stringify(detail ?? null)?.slice(0, 500)}`);
  };

  // Unmount through the root object: a destructured `unmount` loses its
  // receiver and React 19 reads the root off `this` (`_internalRoot`).
  for (const root of mounted) root.unmount();
  mounted = [];
  document.body.replaceChildren();

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
  const hosts = new Map<string, HTMLElement>();
  for (const { key, row, titles } of rows) {
    const host = document.createElement("div");
    host.dataset.row = key;
    stage.append(host);
    const root = createRoot(host);
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptDisclosureProvider>
            <SubagentTitleProvider messages={[...titles, row]}>
              <ToolRow message={row} />
            </SubagentTitleProvider>
          </TranscriptDisclosureProvider>
        </I18nextProvider>,
      ),
    );
    mounted.push(root);
    hosts.set(key, host);
  }
  await settle();

  const header = (key: string) => hosts.get(key)?.querySelector<HTMLElement>(".tool-row-header");
  const headHtml = (key: string) => header(key)?.outerHTML ?? "";
  const tile = (key: string) =>
    hosts.get(key)?.querySelector<HTMLElement>(".tool-row-lifecycle > .tool-row-agent.is-delivered");
  const summary = (key: string) =>
    hosts.get(key)?.querySelector<HTMLElement>(".tool-row-header > .tool-row-summary")
      ?.textContent ?? null;
  const box = (el: Element | null | undefined) => el?.getBoundingClientRect();

  // Slot 1: the shared right cluster. Both heads tile the same task title in
  // the same classes; the steer head carries no generic agent pill.
  check("wait head tiles the delivered task", headHtml("wait").includes(TITLE));
  check(
    "steer head has no generic agent pill",
    !/<span class="tool-row-agent"(?! is-)/.test(headHtml("steer")),
    headHtml("steer").slice(0, 600),
  );
  check("steer agent reads as plain summary text", summary("steer") === AGENT, summary("steer"));
  const steerTile = tile("steer");
  check("steer head tiles the target task", steerTile?.textContent === TITLE, steerTile?.textContent);
  check(
    "steer head states Sent",
    header("steer")?.textContent?.includes("Sent") === true,
    header("steer")?.textContent,
  );
  check("steer head keeps its caret", header("steer")?.querySelector(".tool-row-caret") !== null);
  check(
    "steer tile shares the wait tile shape",
    tile("wait")?.className === steerTile?.className,
    `${tile("wait")?.className} vs ${steerTile?.className}`,
  );

  // Geometry: the two right clusters share a right edge (same lifecycle
  // slot — compared at the state badges, whose widths legitimately differ by
  // wording), the left agent texts share a left edge and height, and nothing
  // leaks the routing id.
  const badge = (key: string) =>
    hosts.get(key)?.querySelector<HTMLElement>(".tool-row-header .tool-row-state");
  const waitTileBox = box(tile("wait"));
  const steerTileBox = box(steerTile);
  const waitBadgeBox = box(badge("wait"));
  const steerBadgeBox = box(badge("steer"));
  if (waitBadgeBox && steerBadgeBox) {
    check(
      "wait and steer clusters share a right edge",
      Math.abs(waitBadgeBox.right - steerBadgeBox.right) <= 1,
      { waitRight: waitBadgeBox.right, steerRight: steerBadgeBox.right },
    );
  } else {
    check("wait and steer clusters share a right edge", false, "a state badge did not render");
  }
  if (waitTileBox && steerTileBox) {
    check(
      "wait and steer tiles share a height",
      Math.abs(waitTileBox.height - steerTileBox.height) <= 1,
      { waitHeight: waitTileBox.height, steerHeight: steerTileBox.height },
    );
  } else {
    check("wait and steer tiles share a height", false, "a tile did not render");
  }
  const waitSummaryBox = box(hosts.get("wait")?.querySelector(".tool-row-header > .tool-row-summary"));
  const steerSummaryBox = box(hosts.get("steer")?.querySelector(".tool-row-header > .tool-row-summary"));
  const waitNameBox = box(hosts.get("wait")?.querySelector(".tool-row-header > .tool-row-name"));
  const steerNameBox = box(hosts.get("steer")?.querySelector(".tool-row-header > .tool-row-name"));
  if (waitSummaryBox && steerSummaryBox && waitNameBox && steerNameBox) {
    check(
      "agent texts share the identity gap and height",
      Math.abs(waitSummaryBox.height - steerSummaryBox.height) <= 1 &&
        Math.abs(
          waitSummaryBox.left - waitNameBox.right - (steerSummaryBox.left - steerNameBox.right),
        ) <= 1,
      {
        waitGap: waitSummaryBox.left - waitNameBox.right,
        steerGap: steerSummaryBox.left - steerNameBox.right,
      },
    );
  } else {
    check("agent texts share the identity gap and height", false, "a head cell did not render");
  }
  check("no routing id in either head", !headHtml("steer").includes("dlg-a") && !headHtml("wait").includes("dlg-a"));

  // Long titles ellipsize inside the shared tile instead of pushing the state out.
  const longTile = tile("steerLong");
  if (longTile) {
    const overflow = getComputedStyle(longTile).textOverflow;
    check("long title ellipsizes in the tile", overflow === "ellipsis" && longTile.scrollWidth > longTile.clientWidth, {
      textOverflow: overflow,
      scrollWidth: longTile.scrollWidth,
      clientWidth: longTile.clientWidth,
    });
    // Compared against the same-target steer tile: both rows state `Sent`,
    // so equal badge widths keep the comparison honest; the wait row's
    // `Results arrived` badge is legitimately wider.
    check(
      "long-title tile keeps the shared right edge",
      steerTileBox ? Math.abs(longTile.getBoundingClientRect().right - steerTileBox.right) <= 1 : false,
      { longRight: longTile.getBoundingClientRect().right, steerRight: steerTileBox?.right },
    );
  } else {
    check("long title ellipsizes in the tile", false, "long-title tile did not render");
  }

  // The two heads expand and collapse independently of each other.
  const open = async (key: string) => {
    header(key)?.click();
    await settle();
  };
  const bodyBlocks = (key: string) =>
    hosts.get(key)?.querySelectorAll(".tool-row-body .tool-block") ?? [];
  await open("steer");
  check(
    "steer expands on exactly the sent guidance",
    bodyBlocks("steer").length === 1 &&
      (hosts.get("steer")?.querySelector(".tool-row-body")?.textContent?.includes(GUIDANCE) ?? false) &&
      !(hosts.get("steer")?.querySelector(".tool-row-body")?.textContent?.includes(TITLE) ?? true) &&
      !(hosts.get("steer")?.querySelector(".tool-row-body")?.textContent?.includes("dlg-a") ?? true),
    hosts.get("steer")?.querySelector(".tool-row-body")?.textContent?.slice(0, 300),
  );
  check(
    "opening steer leaves the wait collapsed",
    hosts.get("wait")?.querySelector(".tool-row-body") === null,
  );
  await open("wait");
  check("wait expands independently", hosts.get("wait")?.querySelector(".tool-row-body") !== null);
  check(
    "closing steer leaves the wait open",
    (await open("steer"), hosts.get("wait")?.querySelector(".tool-row-body") !== null),
  );

  // Running, failed, unknown-target, and progress rows keep their own states.
  check(
    "running steer names the tile but never claims Sent",
    tile("steerRunning")?.textContent === TITLE &&
      !(header("steerRunning")?.textContent?.includes("Sent") ?? true),
    header("steerRunning")?.textContent,
  );
  check(
    "failed steer keeps the tile and reads Failed",
    tile("steerFailed")?.textContent === TITLE &&
      (header("steerFailed")?.textContent?.includes("Failed") ?? false),
    header("steerFailed")?.textContent,
  );
  await open("steerFailed");
  check(
    "failed steer body states only its cause",
    (hosts.get("steerFailed")?.querySelector(".tool-row-body")?.textContent?.includes("delegation ended") ??
      false) &&
      !(hosts.get("steerFailed")?.querySelector(".tool-row-body")?.textContent?.includes(GUIDANCE) ??
        true),
    hosts.get("steerFailed")?.querySelector(".tool-row-body")?.textContent?.slice(0, 300),
  );
  check(
    "unknown target keeps the guidance fallback, never the id",
    summary("steerUnknown") === "nudge the runner" &&
      hosts.get("steerUnknown")?.querySelector(".tool-row-lifecycle") === null &&
      !headHtml("steerUnknown").includes("dlg-missing"),
    headHtml("steerUnknown").slice(0, 400),
  );
  check(
    "progress wait keeps its roster count",
    hosts.get("waitProgress")?.querySelector(".tool-row-agent.is-count") !== null &&
      (header("waitProgress")?.textContent?.includes("1 subagent") ?? false),
    header("waitProgress")?.textContent,
  );

  return { ok: probe.failures.length === 0, failures: probe.failures, observed: probe.observed };
};
