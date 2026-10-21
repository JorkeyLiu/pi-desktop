/**
 * Work panel tab-strip UX probe.
 *
 * Renders the production `WorkPanel` at a narrow dock width against the real
 * application store, so tab reveal, overflow fades, strip geometry, middle
 * click, the shared context menu, and keyboard focus are exercised against
 * the shipped component instead of a test double.
 */
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/base.css";
import "../../apps/desktop/src/styles/ui-kit.css";
import "../../apps/desktop/src/styles/work-panel.css";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import {
  type WorkPanelTab,
  browserPluginTab,
  fileWorkPanelTab,
  subagentWorkPanelTab,
  toolWorkPanelTab,
} from "../../apps/desktop/src/lib/work-panel-tabs";

declare global {
  var workPanelTabsProbe: () => Promise<{ ok: true; checks: string[] }>;
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

const SUBAGENT_ID = "delegation-7";
const LONG_FILE = "packages/agent-runtime/src/providers/a-very-long-file-name-for-ellipsis.ts";
const IMAGE_FILE = "attachments/9f2c1d7e5b3a4c6d8e0f1a2b3c4d5e6f-screenshot-of-the-work-panel.png";
const SUBAGENT_TITLE = "Investigate the streaming transcript layout regression in the work panel";

function seededTabs(): WorkPanelTab[] {
  return [
    fileWorkPanelTab(LONG_FILE),
    { ...fileWorkPanelTab(IMAGE_FILE), mimeType: "image/png" },
    subagentWorkPanelTab(SUBAGENT_ID, SUBAGENT_TITLE),
    browserPluginTab("https://example.com/docs/very/long/reference/path"),
    toolWorkPanelTab("review"),
    { id: "new:1", kind: "new" },
  ];
}

const invokes: Array<{ channel: string; payload: unknown }> = [];
/** New Task creations this probe's bridge has answered. */
let createdSessions = 0;

function installBridge() {
  (window as unknown as Record<string, unknown>).piDesktop = {
    platform: "darwin",
    invoke: async (channel: string, payload: unknown) => {
      invokes.push({ channel, payload });
      // A topic switch reads the durable session it selects, and New Task
      // creates one. Answering those two keeps both a real store action instead
      // of a state poke.
      if (/\/session\/get$/.test(channel)) {
        const id = (payload as { id?: string } | undefined)?.id;
        const summary = useAppStore.getState().sessions.find((session) => session.id === id);
        // A topic that holds history answers with one durable message, so the
        // read is a real transcript rather than the "empty window" fallback.
        return {
          ok: true,
          data: {
            session: {
              ...summary,
              messages: [
                { id: `${id}-m1`, role: "assistant", content: `${summary?.title} reply`, status: "complete" },
              ],
            },
          },
        };
      }
      if (/\/session\/create$/.test(channel)) {
        createdSessions += 1;
        return {
          ok: true,
          data: {
            session: {
              id: `session-created-${createdSessions}`,
              title: "New topic",
              mode: "agent",
              providerId: "fixture-provider",
              modelId: "fixture-model",
              messageCount: 0,
            },
          },
        };
      }
      return { ok: true, data: [] };
    },
    on: () => () => undefined,
  };
}

function stopChannels() {
  return invokes.filter((entry) =>
    /agent\/stop|agentStop|stop-subagents|stopSubagent|abortSession/i.test(entry.channel),
  );
}

function seed(activeTabId = "new:1") {
  useAppStore.setState({
    activeSessionId: "session-a",
    sessions: [],
    workPanelOpen: true,
    workPanelTabs: seededTabs(),
    activeWorkPanelTabId: activeTabId,
    workPanelFileRequest: null,
    workPanelWidth: 340,
    pluginViews: [
      {
        ref: "pi.browser/browser",
        pluginId: "pi.browser",
        viewId: "browser",
        title: "Browser",
        pluginName: "Browser",
      },
    ],
  } as never);
}

globalThis.workPanelTabsProbe = async () => {
  const checks: string[] = [];
  const check = (name: string) => checks.push(name);
  installBridge();

  const host = document.createElement("div");
  host.style.cssText = "position: fixed; inset: 0; display: flex; align-items: stretch;";
  document.body.append(host);
  // The dock's mount width animation is compositor/timer driven; this probe
  // runs in a window whose paint frames are not guaranteed, so it measures the
  // settled dock instead of a half-open one. All tab geometry below is real.
  const styles = document.createElement("style");
  styles.textContent = ".work-panel { animation: none !important; }";
  document.head.append(styles);
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });
  const root = createRoot(host);
  seed();
  flushSync(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <WorkPanel containerWidth={1800} sidebarCollapsed />
      </I18nextProvider>,
    ),
  );
  // The dock's mount animation is disabled above; one frame settles layout.
  await sleep(150);
  await frame();

  const panel = host.querySelector<HTMLElement>('[data-testid="work-panel"]');
  assert(panel, "work panel did not render");
  const strip = panel.querySelector<HTMLElement>(".work-panel-tab-strip");
  const wrap = panel.querySelector<HTMLElement>(".work-panel-tab-strip-wrap");
  const actions = panel.querySelector<HTMLElement>(".work-panel-actions");
  const header = panel.querySelector<HTMLElement>(".work-panel-header");
  assert(strip && wrap && actions && header, "tab strip regions missing");

  const tabElement = (tabId: string) => {
    const element = panel.querySelector<HTMLElement>(
      `[data-work-panel-tab-id="${tabId}"]`,
    );
    assert(element, `tab element missing: ${tabId}`);
    return element;
  };
  const tabButton = (tabId: string) => {
    const button = tabElement(tabId).querySelector<HTMLButtonElement>('[role="tab"]');
    assert(button, `tab button missing: ${tabId}`);
    return button;
  };
  const closeButton = (tabId: string) =>
    tabElement(tabId).querySelector<HTMLButtonElement>(".work-panel-tab-close");
  const activeTabId = () => useAppStore.getState().activeWorkPanelTabId;
  const tabIds = () => useAppStore.getState().workPanelTabs.map((tab) => tab.id);
  const settle = async () => {
    await frame();
    await sleep(200);
  };

  // 1. Initial reveal: the selected tab is the last one and starts offscreen.
  assert(activeTabId() === "new:1", "seed did not select the last tab");
  assert(strip.scrollWidth > strip.clientWidth, "seeded strip does not overflow");
  assert(strip.scrollLeft > 0, "initial selected tab was not revealed");
  const stripRect = strip.getBoundingClientRect();
  const activeRect = tabElement("new:1").getBoundingClientRect();
  assert(
    activeRect.left >= stripRect.left - 0.5 && activeRect.right <= stripRect.right + 0.5,
    `initial selected tab is clipped: ${JSON.stringify(activeRect)} vs ${JSON.stringify(stripRect)}`,
  );
  check("initial reveal of the selected last tab");

  // 2. Fixed right actions own their lane; no tab is painted underneath them.
  const actionsRect = actions.getBoundingClientRect();
  assert(
    actionsRect.left >= stripRect.right - 0.5,
    `action toolbar overlaps the strip viewport: ${JSON.stringify(actionsRect)} vs ${JSON.stringify(stripRect)}`,
  );
  assert(
    actionsRect.right <= header.getBoundingClientRect().right + 0.5,
    "action toolbar escapes the header",
  );
  for (const element of panel.querySelectorAll<HTMLElement>("[data-work-panel-tab-id]")) {
    const rect = element.getBoundingClientRect();
    const visible = rect.right > stripRect.left && rect.left < stripRect.right;
    if (!visible) continue;
    assert(
      rect.right <= stripRect.right + 0.5,
      `visible tab is drawn beneath the action toolbar: ${element.dataset.workPanelTabId}`,
    );
    assert(
      rect.right <= actionsRect.left + 0.5,
      `tab hit area crosses the action lane: ${element.dataset.workPanelTabId}`,
    );
  }
  check("no tab under the fixed right action toolbar");

  // 3. Close affordance: selected always visible, others only on hover/focus.
  const activeClose = closeButton("new:1");
  const inactiveClose = closeButton(`file:${LONG_FILE}`);
  assert(activeClose && inactiveClose, "close buttons missing");
  assert(
    getComputedStyle(activeClose).opacity === "1",
    "selected tab close is not visible",
  );
  assert(
    getComputedStyle(inactiveClose).opacity === "0",
    "unselected tab close should stay hidden until hover or focus",
  );
  inactiveClose.focus();
  await sleep(150);
  assert(document.activeElement === inactiveClose, "close button is not keyboard focusable");
  assert(inactiveClose.tabIndex === 0 && !inactiveClose.disabled, "close button is not in the tab order");
  // The OS-focused window cannot be guaranteed under automation, so `:focus`
  // may not match here; the reveal contract is asserted on the parsed rules
  // and the selected tab's computed opacity above.
  const closeRevealRules = [...document.styleSheets].flatMap((sheet) => {
    try {
      return [...sheet.cssRules].map((rule) => rule.cssText);
    } catch {
      return [];
    }
  });
  assert(
    closeRevealRules.some(
      (text) =>
        text.includes(".work-panel-tab:hover .work-panel-tab-close") &&
        /opacity:\s*1/.test(text),
    ),
    "hover does not reveal the tab close affordance",
  );
  assert(
    closeRevealRules.some(
      (text) =>
        text.includes(".work-panel-tab-close:focus") &&
        /opacity:\s*1/.test(text),
    ),
    "keyboard focus does not reveal the tab close affordance",
  );
  assert(
    (inactiveClose.getAttribute("aria-label") ?? "").includes("a-very-long-file-name-for-ellipsis.ts"),
    "close button lacks a localized name for its tab",
  );
  (document.activeElement as HTMLElement | null)?.blur();
  check("selected close visible, hover/focus reveal, accessible name");

  // 4. Long labels ellipsize in place and keep the full value on hover.
  const fileButton = tabButton(`file:${LONG_FILE}`);
  const fileLabel = fileButton.querySelector<HTMLElement>(".work-panel-tab-label");
  assert(fileLabel, "tab label missing");
  assert(
    fileLabel.scrollWidth > fileLabel.clientWidth ||
      tabElement(`file:${LONG_FILE}`).getBoundingClientRect().width >= 179,
    "long title is not ellipsized",
  );
  assert(
    fileButton.getAttribute("title") === LONG_FILE,
    "file tab hover title lost the full path",
  );
  const subagentButton = tabButton(`subagent:${SUBAGENT_ID}`);
  assert(
    subagentButton.querySelector(".work-panel-tab-label")?.textContent === SUBAGENT_TITLE,
    "subagent tab does not show the task title",
  );
  assert(
    subagentButton.getAttribute("title") === SUBAGENT_TITLE,
    "subagent tab hover title lost the task title",
  );
  check("long titles ellipsize, full title on hover, task title preserved");

  // 5. Edge fades follow real overflow. Revealed to the end: left only.
  assert(wrap.dataset.overflowLeft === "true", "left fade missing at the end of the row");
  assert(
    wrap.dataset.overflowRight === undefined,
    `right fade shown at the end of the row (scrollLeft=${strip.scrollLeft}, scrollWidth=${strip.scrollWidth}, clientWidth=${strip.clientWidth}, tabRight=${tabElement("new:1").getBoundingClientRect().right}, stripRight=${strip.getBoundingClientRect().right})`,
  );
  assert(
    getComputedStyle(wrap, "::before").opacity === "1",
    "left fade is not painted",
  );
  // A real wheel gesture owns the row: it moves the strip and tells the
  // component not to re-reveal on later layout changes.
  strip.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -10_000, bubbles: true, cancelable: true }),
  );
  await settle();
  assert(
    wrap.dataset.overflowLeft === undefined,
    `left fade did not clear at the start (scrollLeft=${strip.scrollLeft}, left=${wrap.dataset.overflowLeft}, right=${wrap.dataset.overflowRight})`,
  );
  assert(wrap.dataset.overflowRight === "true", "right fade missing at the start");
  assert(
    getComputedStyle(wrap, "::after").opacity === "1",
    "right fade is not painted",
  );
  check("edge fades follow scroll position");

  // 6. A manual scroll survives unrelated store ticks and stream redraws.
  const manualScrollLeft = strip.scrollLeft;
  assert(manualScrollLeft === 0, "manual scroll did not apply");
  useAppStore.setState({ workPanelFileRequest: null } as never);
  await sleep(120);
  useAppStore.setState({ workPanelWidth: 340 } as never);
  await sleep(120);
  assert(
    strip.scrollLeft === manualScrollLeft,
    "a store tick fought the user's manual tab-strip scroll",
  );
  assert(activeTabId() === "new:1", "a store tick changed tab selection");
  check("manual scroll survives unrelated ticks");

  // 7. Switching to an offscreen tab reveals it fully.
  tabButton("review").click();
  await settle();
  assert(activeTabId() === "review", "tab activation did not stick");
  assert(strip.scrollLeft > manualScrollLeft, "switched tab was not scrolled into view");
  const reviewRect = tabElement("review").getBoundingClientRect();
  const afterSwitchRect = strip.getBoundingClientRect();
  assert(
    reviewRect.left >= afterSwitchRect.left - 0.5 &&
      reviewRect.right <= afterSwitchRect.right + 0.5,
    "switched tab is still partially clipped",
  );
  check("switch reveals the selected offscreen tab");

  // 8. Keyboard: arrow navigation and Shift+F10 context menu.
  tabButton("review").dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  await settle();
  assert(activeTabId() === "new:1", "arrow key did not move selection");
  tabButton("new:1").dispatchEvent(
    new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
  );
  const menusImmediately = document.querySelectorAll('[role="menu"]').length;
  await settle();
  const menusSettled = document.querySelectorAll('[role="menu"]').length;
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  assert(
    menu,
    `Shift+F10 did not open the tab menu (immediately=${menusImmediately}, settled=${menusSettled}, activeElement=${document.activeElement?.getAttribute("role") ?? document.activeElement?.tagName})`,
  );
  assert(menu.getAttribute("aria-label") === "Tab actions", "tab menu lacks its name");
  const menuItem = (id: string) =>
    menu.querySelector<HTMLButtonElement>(`[data-context-menu-item="${id}"]`);
  for (const id of ["close", "close-others", "close-right", "close-all"]) {
    assert(menuItem(id), `tab menu item missing: ${id}`);
  }
  assert(menuItem("close-right")?.disabled === true, "close-right should be disabled on the last tab");
  assert(menuItem("close-others")?.disabled === false, "close-others should be enabled");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  assert(!document.querySelector('[role="menu"]'), "Escape did not close the tab menu");
  assert(
    document.activeElement === tabButton("new:1"),
    "menu close did not restore focus to the tab",
  );
  check("keyboard tab navigation and keyboard-opened menu");

  // 9. Middle click closes the tab under the pointer, selection unchanged.
  tabElement(`file:${IMAGE_FILE}`).querySelector('[role="tab"]')?.dispatchEvent(
    new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
  );
  await settle();
  assert(!tabIds().includes(`file:${IMAGE_FILE}`), "middle click did not close the tab");
  assert(activeTabId() === "new:1", "middle click moved selection");
  assert(stopChannels().length === 0, "closing a tab called a runtime stop API");
  check("middle click closes without stopping a runtime");

  // 10. Close tabs to the right: sibling views cleaned up per tab.
  seed("review");
  await settle();
  invokes.length = 0;
  tabElement(`subagent:${SUBAGENT_ID}`).dispatchEvent(
    new MouseEvent("contextmenu", {
      button: 2,
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 40,
    }),
  );
  await settle();
  const pointerMenu = document.querySelector<HTMLElement>('[role="menu"]');
  assert(pointerMenu, "right click did not open the tab menu");
  pointerMenu
    .querySelector<HTMLButtonElement>('[data-context-menu-item="close-right"]')
    ?.click();
  await settle();
  assert(
    JSON.stringify(tabIds()) ===
      JSON.stringify([
        `file:${LONG_FILE}`,
        `file:${IMAGE_FILE}`,
        `subagent:${SUBAGENT_ID}`,
      ]),
    `close tabs to the right changed the wrong tabs: ${JSON.stringify(tabIds())}`,
  );
  assert(
    activeTabId() === `subagent:${SUBAGENT_ID}`,
    "removed selection did not move to the nearest survivor",
  );
  assert(
    invokes.some(
      (entry) =>
        /plugin\/view\/close/i.test(entry.channel) &&
        JSON.stringify(entry.payload).includes('"pi.browser"') &&
        JSON.stringify(entry.payload).includes('"browser"'),
    ),
    `closing a browser tab did not release its native view (invokes=${JSON.stringify(invokes)})`,
  );
  assert(stopChannels().length === 0, "batch close called a runtime stop API");
  check("close tabs to the right keeps order, selection, and view cleanup");

  // 11. Disabled states follow the anchor position.
  tabElement(`subagent:${SUBAGENT_ID}`).dispatchEvent(
    new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true }),
  );
  await settle();
  assert(
    document.querySelector<HTMLButtonElement>('[data-context-menu-item="close-right"]')
      ?.disabled === true,
    "close-right should be disabled on the last tab",
  );
  document
    .querySelector<HTMLButtonElement>('[data-context-menu-item="close-others"]')
    ?.click();
  await settle();
  assert(
    JSON.stringify(tabIds()) === JSON.stringify([`subagent:${SUBAGENT_ID}`]),
    `close others kept the wrong tabs: ${JSON.stringify(tabIds())}`,
  );
  tabElement(`subagent:${SUBAGENT_ID}`).dispatchEvent(
    new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true }),
  );
  await settle();
  assert(
    document.querySelector<HTMLButtonElement>('[data-context-menu-item="close-others"]')
      ?.disabled === true,
    "close-others should be disabled with a single tab",
  );
  assert(
    document.querySelector<HTMLButtonElement>('[data-context-menu-item="close-right"]')
      ?.disabled === true,
    "close-right should be disabled with a single tab",
  );
  check("context menu enablement matches the anchor position");

  // 12. Close all: empty strip, panel stays open on its launcher, no stops.
  document
    .querySelector<HTMLButtonElement>('[data-context-menu-item="close-all"]')
    ?.click();
  await settle();
  assert(tabIds().length === 0, "close all did not close every tab");
  assert(activeTabId() === null, "close all left a stale selection");
  assert(useAppStore.getState().workPanelOpen === true, "close all collapsed the panel");
  assert(
    host.querySelector('[data-testid="work-panel-empty"]'),
    "close all did not leave the launcher visible",
  );
  assert(stopChannels().length === 0, "close all called a runtime stop API");
  check("close all closes views only and keeps the panel");

  // 13. Fades update on panel resize, not just on scroll.
  seed("review");
  await settle();
  assert(wrap.dataset.overflowRight === "true", "fade missing at narrow width");
  useAppStore.getState().setWorkPanelWidth(1200);
  await sleep(180);
  await frame();
  assert(
    strip.scrollWidth <= strip.clientWidth + 1,
    `strip should fit at 1200px: ${strip.scrollWidth} > ${strip.clientWidth}`,
  );
  assert(
    wrap.dataset.overflowLeft === undefined && wrap.dataset.overflowRight === undefined,
    "fades remained after the row no longer overflows",
  );
  useAppStore.getState().setWorkPanelWidth(340);
  await sleep(180);
  await frame();
  assert(wrap.dataset.overflowRight === "true", "right fade did not return on resize");
  check("fades update on resize");

  // 14. A left press on the panel's own drag band dismisses the menu.
  //
  // `ContextMenu` dismisses on a capture-phase window `pointerdown`, so no
  // renderer listener can keep a menu standing through an outside press: the
  // only way that press can go missing is the native layer withholding it.
  // The blank band above the tab strip is the header's `-webkit-app-region:
  // drag` rectangle, which Electron resolves before the renderer is reached.
  // While a menu is up the band must stand down from dragging so the press
  // arrives and dismisses, and take dragging back once the menu is gone.
  const appRegionAt = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    let region = "none";
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const value = getComputedStyle(node).getPropertyValue("-webkit-app-region").trim();
      if (value && value !== "none") {
        region = value;
        break;
      }
    }
    return { element, region };
  };
  const openMenuOn = (tabId: string, at?: { x: number; y: number }) => {
    const rect = tabElement(tabId).getBoundingClientRect();
    tabElement(tabId).dispatchEvent(
      new MouseEvent("contextmenu", {
        button: 2,
        bubbles: true,
        cancelable: true,
        clientX: Math.round(at?.x ?? rect.left + rect.width / 2),
        clientY: Math.round(at?.y ?? rect.top + rect.height / 2),
      }),
    );
  };
  // Open below the header so a menu never sits under the probes below it.
  const menuSpot = () => {
    const rect = header.getBoundingClientRect();
    return { x: Math.round(rect.left + 60), y: Math.round(rect.bottom + 160) };
  };
  const openMenu = () => document.querySelector<HTMLElement>('[role="menu"]');
  const headerBandPoint = () => {
    const rect = header.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 2) };
  };
  // Native mouse input: the runner's preload hands this the window's real
  // `sendInputEvent` path, so nothing here fabricates a DOM event.
  const pressAt = async (x: number, y: number) => {
    const native = (globalThis as unknown as {
      probeClickAt?: (x: number, y: number) => Promise<void>;
    }).probeClickAt;
    assert(native, "runner did not inject native mouse input");
    await native(Math.round(x), Math.round(y));
    await settle();
  };
  const menuCovers = (x: number, y: number) => {
    const rect = openMenu()?.getBoundingClientRect();
    if (!rect) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };

  seed("review");
  await settle();
  const band = headerBandPoint();
  assert(
    appRegionAt(band.x, band.y).region === "drag",
    `the blank header band should be the panel's own native drag rectangle (got ${appRegionAt(band.x, band.y).region} on ${appRegionAt(band.x, band.y).element?.className})`,
  );
  openMenuOn("review", menuSpot());
  await settle();
  assert(openMenu(), "right click did not open the tab menu");
  assert(!menuCovers(band.x, band.y), "the tab menu covers the band probe point");
  assert(
    appRegionAt(band.x, band.y).region === "no-drag",
    `the blank header band still belongs to the native drag rectangle while a menu is open (region=${appRegionAt(band.x, band.y).region} on ${appRegionAt(band.x, band.y).element?.className}); a real left press there never reaches the renderer`,
  );
  await pressAt(band.x, band.y);
  assert(!openMenu(), "a left press on the blank header band left the tab menu open");
  assert(
    appRegionAt(band.x, band.y).region === "drag",
    "header dragging did not come back after the menu closed",
  );
  check("blank header band dismisses the menu and stays draggable");

  // 15. The other outside presses dismiss too, and the fixed action toolbar
  // still runs its own action exactly once on the way.
  seed("review");
  await settle();
  // Header pixels just left of the tab strip's own no-drag viewport: the band
  // beside the strip in the report.
  const besideStrip = (() => {
    const stripNow = strip.getBoundingClientRect();
    const headerNow = header.getBoundingClientRect();
    return {
      x: Math.round(Math.max(stripNow.left, headerNow.left) - 4),
      y: Math.round(headerNow.top + 2),
    };
  })();
  openMenuOn("review", menuSpot());
  await settle();
  assert(!menuCovers(besideStrip.x, besideStrip.y), "the tab menu covers the band beside the strip");
  assert(
    appRegionAt(besideStrip.x, besideStrip.y).region === "no-drag",
    `the band beside the tab strip is not reachable while a menu is open (region=${appRegionAt(besideStrip.x, besideStrip.y).region} on ${appRegionAt(besideStrip.x, besideStrip.y).element?.className})`,
  );
  await pressAt(besideStrip.x, besideStrip.y);
  assert(!openMenu(), "a left press beside the tab strip left the tab menu open");

  openMenuOn("review", menuSpot());
  await settle();
  const outside = { x: 700, y: 700 };
  assert(!menuCovers(outside.x, outside.y), "the tab menu covers the outside probe point");
  await pressAt(outside.x, outside.y);
  assert(!openMenu(), "a left press outside the panel left the tab menu open");

  const tabsBeforeAction = tabIds();
  openMenuOn("review", menuSpot());
  await settle();
  const newTabRect = panel
    .querySelector<HTMLElement>(".work-panel-new-tab")
    ?.getBoundingClientRect();
  assert(newTabRect, "new-tab action missing from the header");
  await pressAt(newTabRect.left + newTabRect.width / 2, newTabRect.top + newTabRect.height / 2);
  assert(!openMenu(), "a left press on the header action toolbar left the tab menu open");
  // The press that dismisses and the click that acts are one gesture, so the
  // action must have run exactly once: one tab added and selected.
  const tabsAfterAction = tabIds();
  assert(
    tabsAfterAction.length === tabsBeforeAction.length + 1 &&
      activeTabId() === tabsAfterAction[tabsAfterAction.length - 1],
    `the header action did not run exactly once (before=${tabsBeforeAction.length}, after=${tabsAfterAction.length}, active=${activeTabId()})`,
  );
  check("band beside the strip, outside press, and action toolbar all dismiss");
  root.unmount();

  // 16. Visibility is shell state. The dock below is gated exactly like the
  // AppShell route (`presentedWorkPanelOpen && <WorkPanel/>`), so a topic
  // switch, a New Task creation, a user close, and a return to a topic whose
  // panel was open are observed through real store actions and real renders.
  host.remove();
  const gatedHost = document.createElement("div");
  gatedHost.style.cssText = "position: fixed; inset: 0; display: flex; align-items: stretch;";
  document.body.append(gatedHost);
  const gatedRoot = createRoot(gatedHost);
  const session = (id: string, title: string) => ({
    id,
    title,
    mode: "agent",
    providerId: "fixture-provider",
    modelId: "fixture-model",
    // Two recorded messages: New Task must create a topic, never hand back one
    // of these merely because its live pane is empty.
    messageCount: 2,
  });
  useAppStore.setState({
    sessions: [session("session-a", "First topic"), session("session-b", "Second topic")],
    activeSessionId: "session-a",
    messages: [],
    sessionHistory: {},
    retainedSessionIds: [],
    retainedTranscripts: {},
    sessionMeta: {},
    notifications: [],
    sessionOutcomes: {},
    runningSessions: {},
    selectingSessionId: undefined,
    navStack: [{ page: "chat", sessionId: "session-a" }],
    navIndex: 0,
    workspace: null,
    activeProjectPath: undefined,
    draftConfiguration: null,
    workPanelOpen: true,
    workPanelTabs: [toolWorkPanelTab("review")],
    activeWorkPanelTabId: "review",
    workPanelFileRequest: null,
    workPanelContexts: {},
    // The cards a selection or creation hydrates beside the panel are not this
    // claim.
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
  } as never);
  const GatedShell = () => {
    const open = useAppStore((state) => state.workPanelOpen);
    return open
      ? (
          <I18nextProvider i18n={i18n}>
            <WorkPanel containerWidth={1800} sidebarCollapsed />
          </I18nextProvider>
        )
      : null;
  };
  flushSync(() => gatedRoot.render(<GatedShell />));
  await settle();
  const gatedPanel = () => gatedHost.querySelector<HTMLElement>('[data-testid="work-panel"]');
  const activeSession = () => useAppStore.getState().activeSessionId;
  assert(gatedPanel(), "the seeded open panel did not render");

  // Switching to a topic that never opened the panel keeps the dock on screen
  // and shows that topic's own (empty) resource set.
  await useAppStore.getState().selectSession("session-b");
  await settle();
  assert(activeSession() === "session-b", "the topic switch did not commit");
  assert(gatedPanel(), "switching topic closed an open panel");
  assert(tabIds().length === 0, `the new topic inherited the previous topic's tabs: ${tabIds()}`);

  // New Task creates a further topic through the same action the user's New
  // Task command runs; the dock stays on screen and takes the new topic's set.
  await useAppStore.getState().newSession();
  await settle();
  assert(activeSession() === "session-created-1", `New Task did not create a topic: ${activeSession()}`);
  assert(gatedPanel(), "New Task closed an open panel");
  assert(tabIds().length === 0, `the created topic inherited tabs: ${tabIds()}`);

  // The user closes it. Returning to the topic whose panel was open restores
  // that topic's resources without putting the dock back on screen.
  useAppStore.getState().collapseWorkPanel();
  await settle();
  assert(!gatedPanel(), "the user's close left the panel rendered");
  await useAppStore.getState().selectSession("session-a");
  await settle();
  assert(activeSession() === "session-a", "returning to the first topic failed");
  assert(!gatedPanel(), "returning to a topic whose panel was open re-opened a closed panel");
  assert(
    tabIds().join(",") === "review",
    `the retained topic resources did not follow the selection: ${tabIds()}`,
  );

  // A New Task from the closed panel stays closed too. The created topic from
  // above now holds a message, so this is a second, real creation.
  useAppStore.setState((state) => ({
    sessions: state.sessions.map((item) =>
      item.id === "session-created-1" ? { ...item, messageCount: 1 } : item,
    ),
  }));
  await useAppStore.getState().newSession();
  await settle();
  assert(activeSession() === "session-created-2", `New Task did not create a second topic: ${activeSession()}`);
  assert(!gatedPanel(), "New Task opened a closed panel");
  assert(tabIds().length === 0, `the second created topic inherited tabs: ${tabIds()}`);

  // An explicit reveal shows the visible topic's resources only.
  await useAppStore.getState().selectSession("session-a");
  await settle();
  useAppStore.getState().openWorkPanel();
  await settle();
  assert(gatedPanel(), "revealing the panel did not render it");
  assert(
    gatedHost.querySelector('[data-work-panel-tab-id="review"]'),
    "the retained topic resource is missing from the revealed panel",
  );
  assert(
    tabIds().join(",") === "review",
    `revealing merged another topic's tabs: ${tabIds()}`,
  );
  check("visibility survives topic switches, New Task, and an explicit close");
  gatedRoot.unmount();
  return { ok: true, checks };
};
