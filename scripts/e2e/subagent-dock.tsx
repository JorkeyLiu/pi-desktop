import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC, type UiMessage } from "@pi-desktop/shared";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var subagentDockProbePhase: (phase: string) => Promise<{
    ok: boolean;
    failures: string[];
    facts: Record<string, unknown>;
  }>;
}

/*
 * The composer's running-subagent dock, mounted in a real Chromium renderer
 * with the application's own stylesheet: the production `Composer` (so the
 * dock sits in its real slot above the input), the production store, the
 * production stop control and the production work-panel action. Only the
 * preload bridge is a stub — it records the stop requests Stop makes and
 * answers like the host would.
 *
 * The keyboard phases are driven with real key events from the harness, so
 * Enter and Space prove the row's native activation instead of a synthetic
 * click.
 */

const SESSION = "s1";
const OTHER_SESSION = "s2";
const createdAt = "2026-10-18T00:00:00.000Z";

const calls: Array<{ channel: string; args: unknown[] }> = [];
(globalThis as unknown as { subagentDockCalls: typeof calls }).subagentDockCalls = calls;

window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    if (channel === IPC.invoke.agentStopSubagents) {
      const request = args[0] as { delegationIds?: string[] };
      return { ok: true, data: { pending: request.delegationIds ?? [] } };
    }
    return { ok: true, data: undefined };
  },
  on: () => () => undefined,
} as unknown as typeof window.piDesktop;

function message(
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role, content, createdAt, ...extra };
}

function task(
  id: string,
  delegationId: string,
  status: "running" | "completed",
  agent: string,
  description: string,
  startedAt: number,
  metrics?: {
    turns: number;
    toolCalls: number;
    contextTokens: number;
    usage: { totalTokens: number };
  },
): UiMessage {
  return message(id, "tool", "", {
    toolName: "Task",
    toolCallId: `call-${id}`,
    toolStatus: "success",
    toolArgs: { agent, description, task: "a long brief that is never a title" },
    toolResult: {
      details: {
        delegationId,
        agent,
        status,
        startedAt,
        ...(status === "completed" ? { completedAt: startedAt + 42_000 } : {}),
        // Executive counters exactly as the runtime reports them.
        ...(metrics ?? {}),
      },
    },
  });
}

/** Two live dispatch turns: one child that reports progress, one that has not. */
function liveMessages(): UiMessage[] {
  const now = Date.now();
  return [
    message("u1", "user", "please review the auth flow"),
    message("a1", "assistant", "Reviewing the auth flow."),
    task("t1", "d1", "running", "explorer", "Review auth flow", now - 65_000, {
      turns: 3,
      toolCalls: 5,
      contextTokens: 41_200,
      usage: { totalTokens: 8_400 },
    }),
    message("a2", "assistant", "Also auditing dependencies in parallel."),
    task("t2", "d2", "running", "auditor", "Audit dependencies", now - 18_000),
  ];
}

/** The same turn after the first child settled. */
function oneSettled(): UiMessage[] {
  const messages = liveMessages();
  return messages.map((entry) =>
    entry.id === "t1"
      ? task("t1", "d1", "completed", "explorer", "Review auth flow", Date.now() - 65_000)
      : entry,
  );
}

/** A different, already-settled session. */
function settledMessages(): UiMessage[] {
  return [
    message("o1", "user", "old request", { createdAt: "2026-10-17T00:00:00.000Z" }),
    message("o2", "assistant", "Done.", { createdAt: "2026-10-17T00:01:00.000Z" }),
    task("o3", "d9", "completed", "explorer", "Earlier work", 1_000),
  ];
}

const i18n = createInstance();
// The renderer's translations are local resources; `init` resolves on a
// microtask, so `init` is started before the mount and the probe reads only
// after the first frames.
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
        title: "Dock fixture",
        source: "local",
        mode: "agent",
        createdAt,
        updatedAt: createdAt,
      } as never,
      {
        id: OTHER_SESSION,
        title: "Settled fixture",
        source: "local",
        mode: "agent",
        createdAt,
        updatedAt: createdAt,
      } as never,
    ],
    messages: liveMessages(),
    isRunning: true,
    settings: { enterToSend: true },
    providers: [],
    providerModels: {},
    plugins: [],
    recentModels: [],
    sessionCompactions: {},
    // A live checklist in the session proves the composer's dock slot is the
    // subagent dock now, not the todo dock.
    sessionTodos: {
      [SESSION]: {
        sessionId: SESSION,
        revision: 1,
        updatedAt: 1,
        todos: [{ content: "review the auth flow", status: "in_progress", priority: "high" }],
      },
    },
    pendingPermissions: {},
    pendingAsks: {},
    queuedPrompts: {},
    planCheckpoints: {},
    agentStatuses: {},
    workPanelOpen: false,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelContexts: {},
  } as never);
});

// Fixture chrome only: this page has no application shell, so the stage owns
// the canvas colour and the body inset. Inline element styles, not a stylesheet:
// the rules under test are the built production CSS and nothing else.
document.documentElement.style.backgroundColor = "var(--ds-bg-canvas, #111)";
if (document.body) document.body.style.margin = "0";
const stage = document.createElement("div");
stage.id = "stage";
stage.style.cssText =
  "position:fixed;left:40px;right:40px;bottom:40px;display:flex;flex-direction:column";
// The bundle runs before `<body>` exists, so the stage hangs off the document
// element; it is positioned fixed, so its parent does not matter.
(document.body ?? document.documentElement).append(stage);

const root = createRoot(stage);
flushSync(() => {
  root.render(
    <I18nextProvider i18n={i18n}>
      <SlotSessionProvider sessionId={SESSION}>
        <Composer variant="docked" />
      </SlotSessionProvider>
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

const text = (node: Element | null) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

const dock = () => document.querySelector<HTMLElement>(".subagent-dock");
const header = () => document.querySelector<HTMLElement>(".subagent-dock-header");
const toggle = () => document.querySelector<HTMLButtonElement>(".subagent-dock-toggle");
/** Every stop control the dock's header offers: there are none, by design. */
const headerStops = () => header()?.querySelectorAll(".stop-btn").length ?? 0;
const rows = () => [...document.querySelectorAll<HTMLElement>(".subagent-dock-row")];
const rowMain = (index: number) =>
  rows()[index]?.querySelector<HTMLButtonElement>(".subagent-dock-row-main") ?? null;
const rowStop = (index: number) =>
  rows()[index]?.querySelector<HTMLButtonElement>("button.stop-btn") ?? null;
const rowPart = (index: number, selector: string) =>
  rows()[index]?.querySelector<HTMLElement>(selector) ?? null;

/** The computed paint of a node, as the compositor receives it. */
const paint = (node: Element | null) => (node ? getComputedStyle(node).backgroundColor : "");
const TRANSPARENT = "rgba(0, 0, 0, 0)";
/** Long enough for the row's own fill transition to land before it is read. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 260));
/** A layout box rounded to a tenth of a pixel, for state-to-state comparison. */
const boxOf = (node: Element | null) => {
  const rect = node?.getBoundingClientRect();
  return rect
    ? {
        x: +rect.x.toFixed(1),
        y: +rect.y.toFixed(1),
        w: +rect.width.toFixed(1),
        h: +rect.height.toFixed(1),
      }
    : null;
};
/**
 * The same layout box within half a pixel: no interaction state may move or
 * resize the open action, which is what keeps the row's hit area whole.
 */
const sameBox = (
  a: { x: number; y: number; w: number; h: number } | null,
  b: { x: number; y: number; w: number; h: number } | null,
) =>
  Boolean(a && b) &&
  [a, b].every(
    (box) =>
      Math.abs(box!.x - a!.x) <= 0.5 &&
      Math.abs(box!.y - a!.y) <= 0.5 &&
      Math.abs(box!.w - a!.w) <= 0.5 &&
      Math.abs(box!.h - a!.h) <= 0.5,
  );
const reservedHeight = () =>
  document.documentElement.style.getPropertyValue("--composer-dock-height");
const expanded = () => toggle()?.getAttribute("aria-expanded") === "true";
const stopCalls = () => calls.filter((call) => call.channel === IPC.invoke.agentStopSubagents);
const activeTab = () => useAppStore.getState().activeWorkPanelTabId;

// One explicit width for the composer's slot, so a narrow dock is measurable.
function setStageWidth(width: number) {
  const el = document.getElementById("stage");
  if (!el) return;
  el.style.right = "auto";
  el.style.width = `${width}px`;
}

function run(checks: Array<[boolean, string]>) {
  const failures = checks.filter(([pass]) => !pass).map(([, label]) => label);
  return failures;
}

const facts: Record<string, unknown> = {};

globalThis.subagentDockProbePhase = async (phase: string) => {
  // The mount and the translation init settle before the first measurement.
  await frames(3);
  const failures: string[] = [];
  if (phase === "collapsed") {
    const el = dock();
    failures.push(
      ...run([
        [Boolean(el), "the composer mounts a subagent dock above its input"],
        [document.querySelector(".todo-dock") === null, "the todo dock is not mounted any more"],
        [header()?.querySelector(".subagent-dock-toggle") !== null, "the header carries the disclosure"],
        [expanded() === false, "the dock starts collapsed"],
        [
          text(document.querySelector(".subagent-dock-header-text")) ===
            "2 subagents running · Review auth flow",
          `collapsed summary shows the active count and the current task title (got "${text(
            document.querySelector(".subagent-dock-header-text"),
          )}")`,
        ],
        [
          document.querySelector(".subagent-dock-content")?.getAttribute("aria-hidden") === "true",
          "the collapsed list is hidden from assistive technology",
        ],
        [reservedHeight() !== "", "the composer publishes its reserved dock height"],
        [
          headerStops() === 0,
          "the dock header carries no dock-wide stop",
        ],
        [
          header()?.querySelectorAll("button").length === 1 &&
            header()?.querySelector(".subagent-dock-toggle") !== null,
          "the header is the disclosure alone",
        ],
      ]),
    );
    {
      const dockBox = el?.getBoundingClientRect();
      const headerBox = header()?.getBoundingClientRect();
      const below = dockBox && headerBox ? dockBox.bottom - headerBox.bottom : 99;
      facts.collapsedHeaderGap = Math.round(below);
      // Only the dock's own bottom border may sit below the header: the list's
      // insets live inside the clip layer, so the closed dock never holds an
      // empty band open under its title.
      failures.push(
        ...run([
          [
            Math.abs(below) <= 2,
            `the collapsed dock is exactly its header height (band ${Math.round(below)}px)`,
          ],
        ]),
      );
    }
    facts.collapsedHeight = Math.round(el?.getBoundingClientRect().height ?? 0);
    facts.collapsedReserve = reservedHeight();
    facts.collapsedSummary = text(document.querySelector(".subagent-dock-header-text"));
  }

  if (phase === "expand") {
    const el = dock();
    toggle()?.click();
    await frames(3);
    const grown = el?.getBoundingClientRect().height ?? 0;
    const present = rows();
    const firstMetrics = text(present[0]?.querySelector(".subagent-dock-row-metrics") ?? null);
    const firstState = text(present[0]?.querySelector(".subagent-dock-row-state") ?? null);
    const firstRole = text(present[0]?.querySelector(".subagent-dock-row-role") ?? null);
    const box = (node: Element | null | undefined) => node?.getBoundingClientRect();
    const titleRowBox = box(
      present[0]?.querySelector(".subagent-dock-row-title-row"),
    );
    const roleBox = box(present[0]?.querySelector(".subagent-dock-row-role"));
    failures.push(
      ...run([
        [expanded(), "clicking the disclosure expands the dock"],
        [present.length === 2, `both running children are listed (got ${present.length})`],
        [
          text(present[0]?.querySelector(".subagent-dock-row-title") ?? null) ===
            "Review auth flow",
          "the first row keeps the original Task description as its title",
        ],
        [
          firstRole === "explorer",
          `the row shows the role that runs the child (got "${firstRole}")`,
        ],
        [
          /^Running · \d+[ms]/u.test(firstState),
          `the row shows running state and live duration (got "${firstState}")`,
        ],
        [
          firstMetrics === "Turns 3 · Tool calls 5 · Context 41.2K · Spent 8.4K",
          `the row shows the child's own turns, calls, context and spend (got "${firstMetrics}")`,
        ],
        [
          present[0]?.querySelector(".subagent-dock-row-title-row .subagent-dock-row-role") ===
            null,
          "the role is not on the title line",
        ],
        [
          Boolean(titleRowBox && roleBox) && roleBox!.top >= titleRowBox!.bottom - 1,
          "the role and its figures sit on the line below the title",
        ],
        [
          rowMain(0)?.querySelector(".subagent-dock-row-metrics") !== null,
          "the reported progress sits inside the row's own open action",
        ],
        [
          present[1]?.querySelector(".subagent-dock-row-metrics") === null,
          "a child that reported no counters shows no numbers",
        ],
        [
          text(present[1]?.querySelector(".subagent-dock-row-title") ?? null) ===
            "Audit dependencies",
          "the second running child is listed too",
        ],
        [grown > (facts.collapsedHeight as number), "expanding grows the dock"],
        [
          rowMain(0) !== null && rowStop(0) !== null,
          "each row carries one open action and one stop action",
        ],
        [
          rowMain(0)?.getAttribute("aria-disabled") === null &&
            rowMain(0)?.hasAttribute("disabled") === false,
          "the row's open action is enabled for a running child",
        ],
        [
          rows()[0]?.querySelector(".subagent-dock-row-open") === null,
          "the row has no separate open button any more",
        ],
        [headerStops() === 0, "expanding reveals no dock-wide stop"],
      ]),
    );
    // Rendered geometry: nothing overflows its row, and the row's stop control
    // keeps its own box beside the copy rather than over it.
    const noOverflow = present.every((row) => {
      const main = row.querySelector<HTMLElement>(".subagent-dock-row-main");
      return main ? main.scrollWidth <= main.clientWidth + 1 : false;
    });
    const metricsBox = box(present[0]?.querySelector(".subagent-dock-row-metrics"));
    const rowBox = box(present[0]);
    const stripBox = box(present[0]?.querySelector("button.stop-btn"));
    failures.push(
      ...run([
        [noOverflow, "a row's content fits its own box"],
        [
          Boolean(metricsBox && rowBox && stripBox) &&
            metricsBox!.width > 0 &&
            metricsBox!.right <= rowBox!.right + 1 &&
            stripBox!.left >= metricsBox!.right - 1,
          "the reported progress is visible inside the row, clear of its stop control",
        ],
      ]),
    );
    // The same row at the widths the dock actually lives in, from a wide window
    // down to a narrow one: no control escapes its row, and no figure the child
    // reported is cut off.
    const geometry: Array<Record<string, number>> = [];
    for (const width of [900, 340, 320]) {
      setStageWidth(width);
      await frames(2);
      const row = rows()[0] ?? null;
      const main = row?.querySelector<HTMLElement>(".subagent-dock-row-main");
      const copy = row?.querySelector<HTMLElement>(".subagent-dock-row-copy");
      const title = row?.querySelector<HTMLElement>(".subagent-dock-row-title");
      const metrics = row?.querySelector<HTMLElement>(".subagent-dock-row-metrics");
      const strip = row?.querySelector<HTMLElement>("button.stop-btn");
      const atRow = box(row);
      const atCopy = box(copy);
      const atMetrics = box(metrics);
      const atStrip = box(strip);
      geometry.push({
        width,
        row: Math.round(atRow?.width ?? 0),
        mainScroll: main?.scrollWidth ?? 0,
        mainClient: main?.clientWidth ?? 0,
        titleScroll: title?.scrollWidth ?? 0,
        titleClient: title?.clientWidth ?? 0,
      });
      failures.push(
        ...run([
          [
            Boolean(atRow && atStrip) && atStrip!.right <= atRow!.right + 1,
            `${width}px: the row's stop control stays inside the row`,
          ],
          [
            Boolean(atCopy && atStrip) && atCopy!.right <= atStrip!.left + 1,
            `${width}px: the row copy does not run under the stop control`,
          ],
          [
            Boolean(atCopy && atMetrics) && atMetrics!.right <= atCopy!.right + 1,
            `${width}px: the reported figures stay inside the copy column`,
          ],
          [
            title !== null && title.scrollWidth <= title.clientWidth + 1,
            `${width}px: the title is fully shown (${title?.scrollWidth}/${title?.clientWidth})`,
          ],
          [
            metrics !== null &&
              metrics.scrollWidth <= metrics.clientWidth + 1 &&
              metrics.scrollHeight <= metrics.clientHeight + 1,
            `${width}px: every figure is readable (${metrics?.scrollWidth}/${metrics?.clientWidth})`,
          ],
          [
            main !== null && main.scrollWidth <= main.clientWidth + 1,
            `${width}px: the row does not scroll sideways (${main?.scrollWidth}/${main?.clientWidth})`,
          ],
        ]),
      );
    }
    // The header is its own surface: the expanded rows start below a deliberate
    // gap, so the header's hover fill can never touch the first row's tile, and
    // the list keeps an even inset at its sides.
    {
      const headerBox = box(header());
      const toggleBox = box(toggle());
      const listEl = document.querySelector<HTMLElement>(".subagent-dock-list");
      const listBox = box(listEl);
      const firstBox = box(present[0]);
      const listStyle = listEl ? getComputedStyle(listEl) : null;
      const gap = headerBox && firstBox ? firstBox.top - headerBox.bottom : -1;
      const hoverGap = toggleBox && firstBox ? firstBox.top - toggleBox.bottom : -1;
      const padLeft = parseFloat(listStyle?.paddingLeft ?? "0");
      const padRight = parseFloat(listStyle?.paddingRight ?? "0");
      facts.dockGap = Math.round(gap);
      facts.dockHoverGap = Math.round(hoverGap);
      facts.dockListInset = { left: padLeft, right: padRight };
      failures.push(
        ...run([
          [
            Boolean(listBox && firstBox) && gap >= 6 && gap <= 10,
            `the expanded rows start below a deliberate gap under the header (got ${Math.round(gap)}px)`,
          ],
          [
            hoverGap >= 6,
            `the header's hover surface never touches the first row's tile (got ${Math.round(hoverGap)}px)`,
          ],
          [
            padLeft > 0 && Math.abs(padLeft - padRight) <= 1,
            `the list keeps an even side inset (${padLeft}/${padRight})`,
          ],
        ]),
      );
    }
    setStageWidth(900);
    await frames(1);
    facts.rowGeometry = geometry;
    facts.expandedHeight = Math.round(grown);
    facts.expandedReserve = reservedHeight();
    facts.rowTitles = present.map((row) => ({
      title: text(row.querySelector(".subagent-dock-row-title")),
      state: text(row.querySelector(".subagent-dock-row-state")),
      role: text(row.querySelector(".subagent-dock-row-role")),
      metrics: text(row.querySelector(".subagent-dock-row-metrics")),
    }));
  }

  if (phase === "hover-prepare") {
    await frames(1);
    const row = rows()[0] ?? null;
    const main = rowMain(0);
    const stop = rowStop(0);
    const box = main?.getBoundingClientRect();
    facts.hoverRest = { row: paint(row), main: paint(main), stop: paint(stop) };
    // The real pointer goes to the middle of the row's open action.
    facts.hoverPoint = box
      ? { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
      : null;
    const mainStyle = main ? getComputedStyle(main) : null;
    const rowStyle = row ? getComputedStyle(row) : null;
    const sibling = rows()[1] ?? null;
    // What the shared Button would paint for the same classes, measured on a
    // throwaway element: the dock's row action must win over `.btn`/`.btn-ghost`
    // because `ui-kit.css` is imported after `composer.css`.
    const probe = document.createElement("button");
    probe.type = "button";
    probe.className = "btn btn-ghost";
    probe.textContent = "probe";
    stage.append(probe);
    const probeStyle = getComputedStyle(probe);
    const sharedButton = {
      padding: `${probeStyle.paddingTop} ${probeStyle.paddingRight} ${probeStyle.paddingBottom} ${probeStyle.paddingLeft}`,
      fontSize: probeStyle.fontSize,
      gap: probeStyle.gap,
    };
    probe.remove();
    const geometry = {
      padding: `${mainStyle?.paddingTop} ${mainStyle?.paddingRight} ${mainStyle?.paddingBottom} ${mainStyle?.paddingLeft}`,
      fontSize: mainStyle?.fontSize,
      gap: mainStyle?.gap,
      radius: mainStyle?.borderRadius,
    };
    facts.sharedButton = sharedButton;
    facts.restGeometry = geometry;
    facts.restBox = boxOf(main);
    facts.restRowBox = boxOf(row);
    facts.restSibling = { row: paint(sibling), main: paint(rowMain(1)) };
    failures.push(
      ...run([
        [
          expanded() && row !== null && main !== null && stop !== null,
          "a row with both actions is mounted to point at",
        ],
        [
          paint(row) !== TRANSPARENT,
          "the resting row already paints its own surface",
        ],
        [
          geometry.padding === "3px 4px 3px 7px" &&
            geometry.padding !== sharedButton.padding,
          `the open action keeps the dock row's own padding, not the shared button's (${geometry.padding} vs ${sharedButton.padding})`,
        ],
        [
          geometry.fontSize === rowStyle?.fontSize &&
            geometry.fontSize !== sharedButton.fontSize,
          `the open action inherits the row's font size, not the shared button's (${geometry.fontSize} vs ${sharedButton.fontSize})`,
        ],
        [
          geometry.gap === "7px" && geometry.gap !== sharedButton.gap,
          `the open action keeps the dock row's gap (${geometry.gap} vs ${sharedButton.gap})`,
        ],
        [
          geometry.radius === rowStyle?.borderRadius,
          `the open action keeps the row's corner radius (${geometry.radius} vs ${rowStyle?.borderRadius})`,
        ],
        [
          paint(main) === TRANSPARENT,
          `the resting open action paints no surface of its own (${paint(main)})`,
        ],
      ]),
    );
  }

  if (phase === "hover-check") {
    await settle();
    const row = rows()[0] ?? null;
    const main = rowMain(0);
    const stop = rowStop(0);
    const rest = facts.hoverRest as Record<string, string>;
    const hovered = { row: paint(row), main: paint(main), stop: paint(stop) };
    const rowBox = row?.getBoundingClientRect();
    const mainBox = main?.getBoundingClientRect();
    const stopBox = stop?.getBoundingClientRect();
    const centerY = rowBox ? rowBox.top + rowBox.height / 2 : 0;
    const hit = (x: number) => document.elementFromPoint(x, centerY);
    const rightGap = rowBox ? hit(rowBox.right - 2) : null;
    const gutter = mainBox ? hit(mainBox.right + 1) : null;
    facts.hoverPaint = { rest, hovered };
    facts.hoverHit = {
      rightGap: rightGap?.className ?? null,
      gutter: gutter?.className ?? null,
      rowExtendsPastStop:
        rowBox && stopBox ? Math.round(rowBox.right - stopBox.right) : null,
    };
    const sibling = rows()[1] ?? null;
    const siblingPaint = { row: paint(sibling), main: paint(rowMain(1)) };
    const siblingRest = facts.restSibling as
      | { row: string; main: string }
      | undefined;
    failures.push(
      ...run([
        [main?.matches(":hover") === true, "the real pointer hovers the row's open action"],
        [
          hovered.row !== rest.row && hovered.row !== TRANSPARENT,
          `hovering the open action recolours the row (${rest.row} -> ${hovered.row})`,
        ],
        [
          hovered.main === TRANSPARENT && hovered.main === rest.main,
          `the button inside stays transparent while hovered (${hovered.main})`,
        ],
        [
          hovered.stop === rest.stop,
          `the stop control keeps its own surface (${rest.stop} -> ${hovered.stop})`,
        ],
        [
          rightGap === row,
          `the row's fill reaches its own right edge behind the stop gap (hit ${
            rightGap?.className ?? "none"
          })`,
        ],
        [
          gutter === row,
          `the gap between the open action and stop is the row's surface (hit ${
            gutter?.className ?? "none"
          })`,
        ],
        [
          sameBox(boxOf(main), facts.restBox),
          `hovering does not move or resize the open action (${JSON.stringify(
            boxOf(main),
          )} vs ${JSON.stringify(facts.restBox)})`,
        ],
        [
          siblingPaint.row === siblingRest?.row,
          `the unhovered sibling row keeps its resting surface (${siblingPaint.row})`,
        ],
        [
          siblingPaint.main === TRANSPARENT,
          `the unhovered sibling paints no surface inside its row (${siblingPaint.main})`,
        ],
      ]),
    );
  }

  if (phase === "pressed-check") {
    await settle();
    const row = rows()[0] ?? null;
    const main = rowMain(0);
    const stop = rowStop(0);
    const rest = facts.hoverRest as Record<string, string>;
    const hovered = (facts.hoverPaint as { hovered?: Record<string, string> } | undefined)
      ?.hovered;
    const style = main ? getComputedStyle(main) : null;
    facts.pressed = {
      row: paint(row),
      main: paint(main),
      stop: paint(stop),
      transform: style?.transform,
      box: boxOf(main),
    };
    failures.push(
      ...run([
        [main?.matches(":active") === true, "the real pointer holds the open action pressed"],
        [
          paint(main) === TRANSPARENT,
          `the pressed open action paints no surface of its own (${paint(main)})`,
        ],
        [
          paint(row) === hovered?.row,
          `the pressed row keeps the whole-row fill (${paint(row)} vs ${hovered?.row})`,
        ],
        [
          style?.transform === "none",
          `pressing does not scale the row action (${style?.transform})`,
        ],
        [
          sameBox(boxOf(main), facts.restBox),
          `pressing does not move or resize the open action (${JSON.stringify(
            boxOf(main),
          )} vs ${JSON.stringify(facts.restBox)})`,
        ],
        [
          paint(stop) === rest.stop,
          `the stop control keeps its own surface while the row action is pressed (${paint(
            stop,
          )})`,
        ],
      ]),
    );
  }

  if (phase === "hover-away") {
    await settle();
    const row = rows()[0] ?? null;
    const main = rowMain(0);
    const rest = facts.hoverRest as Record<string, string>;
    facts.hoverAway = { row: paint(row), hover: main?.matches(":hover") ?? null };
    failures.push(
      ...run([
        [main?.matches(":hover") === false, "the pointer no longer hovers the open action"],
        [
          paint(row) === rest.row,
          `the row returns to its resting surface (${paint(row)} vs ${rest.row})`,
        ],
      ]),
    );
  }

  if (phase === "focus-prepare") {
    await frames(1);
    toggle()?.focus();
    failures.push(
      ...run([
        [document.activeElement === toggle(), "the disclosure takes focus before the keyboard walk"],
        [expanded(), "the dock is open for the keyboard walk"],
      ]),
    );
  }

  if (phase === "active") {
    await frames(1);
    const el = document.activeElement as HTMLElement | null;
    facts.activeElement = el?.className ?? null;
  }

  if (phase === "focus-row") {
    await settle();
    const row = rows()[0] ?? null;
    const main = rowMain(0);
    const rest = facts.hoverRest as Record<string, string>;
    const hovered = (facts.hoverPaint as { hovered?: Record<string, string> } | undefined)?.hovered;
    const style = main ? getComputedStyle(main) : null;
    facts.focusRow = {
      active: (document.activeElement as HTMLElement | null)?.className ?? null,
      row: paint(row),
      main: paint(main),
      focusVisible: main?.matches(":focus-visible") ?? false,
      outline: `${style?.outlineWidth} ${style?.outlineStyle} ${style?.outlineColor}`,
    };
    failures.push(
      ...run([
        [document.activeElement === main, "Tab lands on the row's open action"],
        [
          main?.matches(":focus-visible") === true,
          "the focused open action matches :focus-visible",
        ],
        [
          paint(row) === hovered?.row,
          `keyboard focus paints the row exactly like hover (${paint(row)} vs ${hovered?.row})`,
        ],
        [
          paint(row) !== rest.row,
          `the focused row is not left at its resting surface (${paint(row)} vs ${rest.row})`,
        ],
        [
          paint(main) === TRANSPARENT,
          `the focused button itself stays transparent (${paint(main)})`,
        ],
        [
          style?.outlineStyle === "solid" && style?.outlineWidth === "2px",
          `the focused open action keeps a visible ring (${style?.outlineWidth} ${style?.outlineStyle})`,
        ],
        [
          sameBox(boxOf(main), facts.restBox),
          `keyboard focus does not move or resize the row action (${JSON.stringify(
            boxOf(main),
          )} vs ${JSON.stringify(facts.restBox)})`,
        ],
      ]),
    );
  }

  if (phase === "focus-stop") {
    await settle();
    const row = rows()[0] ?? null;
    const stop = rowStop(0);
    const rest = facts.hoverRest as Record<string, string>;
    const stopStyle = stop ? getComputedStyle(stop) : null;
    facts.focusStop = {
      active: (document.activeElement as HTMLElement | null)?.className ?? null,
      row: paint(row),
      stop: paint(stop),
      focusVisible: stop?.matches(":focus-visible") ?? false,
      outline: `${stopStyle?.outlineWidth} ${stopStyle?.outlineStyle}`,
    };
    failures.push(
      ...run([
        [document.activeElement === stop, "the next Tab reaches the stop control of the same row"],
        [
          stop?.matches(":focus-visible") === true,
          "the stop control keeps its own focus indicator",
        ],
        [
          paint(row) === rest.row,
          `focusing stop leaves the row at its resting surface (${paint(row)} vs ${rest.row})`,
        ],
      ]),
    );
  }

  if (phase === "actions") {
    await frames(1);
    // The whole row body opens that child's chain.
    rowMain(1)?.click();
    await frames(2);
    const afterRowClick = useAppStore.getState();
    facts.openedTab = {
      id: afterRowClick.activeWorkPanelTabId,
      tabs: afterRowClick.workPanelTabs.map((tab) => ({ id: tab.id, label: tab.label })),
      open: afterRowClick.workPanelOpen,
    };
    failures.push(
      ...run([
        [
          afterRowClick.activeWorkPanelTabId === "subagent:d2",
          `clicking the row opens its own chain tab (got ${String(afterRowClick.activeWorkPanelTabId)})`,
        ],
        [
          afterRowClick.workPanelTabs.some((tab) => tab.id === "subagent:d2" && tab.label === "Audit dependencies"),
          "the tab is labelled with the task title",
        ],
      ]),
    );

    // The row's own stop targets that child and nothing else, and stopping is
    // not opening: the active tab and the expansion stay put.
    const stopsBefore = stopCalls().length;
    const tabBeforeStop = activeTab();
    rowStop(1)?.click();
    await frames(3);
    const afterRowStop = stopCalls();
    facts.rowStopCalls = afterRowStop.slice(stopsBefore).map((call) => call.args[0]);
    failures.push(
      ...run([
        [
          afterRowStop.length === stopsBefore + 1,
          `the row stop sends one request (got ${afterRowStop.length - stopsBefore})`,
        ],
        [
          JSON.stringify(afterRowStop[stopsBefore]?.args[0]) ===
            JSON.stringify({ sessionId: SESSION, delegationIds: ["d2"] }),
          `the row stop targets only that child (got ${JSON.stringify(
            afterRowStop[stopsBefore]?.args[0],
          )})`,
        ],
        [activeTab() === tabBeforeStop, "stopping a child does not open its chain"],
        [expanded(), "stopping a child does not collapse the dock"],
      ]),
    );

    // The disclosure still works on its own, both ways.
    toggle()?.click();
    await frames(2);
    const collapsedAgain = expanded() === false;
    toggle()?.click();
    await frames(2);
    failures.push(
      ...run([
        [collapsedAgain, "the disclosure still collapses the dock"],
        [expanded(), "the disclosure still expands the dock"],
      ]),
    );
  }

  if (phase === "keys-enter-prepare") {
    await frames(1);
    facts.keyboardStopsBefore = stopCalls().length;
    rowMain(0)?.focus();
    failures.push(
      ...run([
        [
          document.activeElement === rowMain(0),
          "the row's open action takes keyboard focus",
        ],
      ]),
    );
  }

  if (phase === "keys-enter-check") {
    await frames(2);
    const state = useAppStore.getState();
    facts.keyboardEnterTab = state.activeWorkPanelTabId;
    failures.push(
      ...run([
        [
          state.activeWorkPanelTabId === "subagent:d1",
          `Enter on the focused row opens that child's chain (got ${String(state.activeWorkPanelTabId)})`,
        ],
        [
          stopCalls().length === (facts.keyboardStopsBefore as number),
          "Enter on the row does not stop the child",
        ],
      ]),
    );
  }

  if (phase === "keys-space-prepare") {
    await frames(1);
    facts.keyboardStopsBefore = stopCalls().length;
    rowMain(1)?.focus();
    failures.push(
      ...run([
        [document.activeElement === rowMain(1), "the second row's open action takes keyboard focus"],
      ]),
    );
  }

  if (phase === "keys-space-check") {
    await frames(2);
    const state = useAppStore.getState();
    facts.keyboardSpaceTab = state.activeWorkPanelTabId;
    failures.push(
      ...run([
        [
          state.activeWorkPanelTabId === "subagent:d2",
          `Space on the focused row opens that child's chain (got ${String(state.activeWorkPanelTabId)})`,
        ],
        [
          stopCalls().length === (facts.keyboardStopsBefore as number),
          "Space on the row does not stop the child",
        ],
        [expanded(), "keyboard activation leaves the expansion alone"],
      ]),
    );
  }

  if (phase === "drive") {
    // A live message update keeps the other task and the manual expansion.
    flushSync(() => {
      useAppStore.setState({
        messages: [...useAppStore.getState().messages, message("a3", "assistant", "Still working.")],
        isRunning: true,
      });
    });
    await frames(3);
    failures.push(
      ...run([
        [rows().length === 2, "a streamed message keeps both running rows"],
        [expanded(), "the manual expansion survives the update"],
        [
          text(rows()[0]?.querySelector(".subagent-dock-row-title") ?? null) === "Review auth flow",
          "the untouched task keeps its row",
        ],
        [
          text(rows()[0]?.querySelector(".subagent-dock-row-metrics") ?? null) ===
            "Turns 3 · Tool calls 5 · Context 41.2K · Spent 8.4K",
          "the reported progress survives a streamed message",
        ],
      ]),
    );

    // One child settles: only its row leaves.
    flushSync(() => {
      useAppStore.setState({ messages: oneSettled() });
    });
    await frames(3);
    facts.afterSettle = rows().map((row) => text(row.querySelector(".subagent-dock-row-title")));
    failures.push(
      ...run([
        [rows().length === 1, "a settled child leaves the dock"],
        [
          text(rows()[0]?.querySelector(".subagent-dock-row-title") ?? null) ===
            "Audit dependencies",
          "the still-running child stays listed",
        ],
        [expanded(), "the expansion is still the user's choice"],
      ]),
    );

    // Session switch: the other session's settled transcript has no dock, and
    // coming back keeps the expansion this session's user chose.
    flushSync(() => {
      useAppStore.setState({
        activeSessionId: OTHER_SESSION,
        messages: settledMessages(),
        isRunning: false,
      });
    });
    await frames(3);
    const absentElsewhere = dock() === null;
    flushSync(() => {
      useAppStore.setState({
        activeSessionId: SESSION,
        messages: liveMessages(),
        isRunning: true,
      });
    });
    await frames(3);
    failures.push(
      ...run([
        [absentElsewhere, "a settled session shows no dock"],
        [dock() !== null, "switching back shows this session's running agents again"],
        [expanded(), "the expansion choice is remembered per session"],
      ]),
    );

    // Nothing running: the dock leaves the slot entirely.
    flushSync(() => {
      useAppStore.setState({ isRunning: false });
    });
    await frames(3);
    failures.push(
      ...run([
        [dock() === null, "no running child means no dock"],
        [document.querySelector(".todo-dock") === null, "the todo dock is still not mounted"],
      ]),
    );
  }

  return { ok: failures.length === 0, failures, facts };
};

(globalThis as unknown as { subagentDockReady: true }).subagentDockReady = true;
