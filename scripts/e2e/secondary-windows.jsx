// Production SecondaryWindows layer over a minimal chat shell; only the preload
// boundary uses fixture data. The probe reports rendered geometry, dismissal,
// focus, retention, and Escape-ownership measurements.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
 import { ContextMenu } from "../../apps/desktop/src/components/ContextMenu";
 import { SecondaryWindows } from "../../apps/desktop/src/features/app/SecondaryWindows";
 import { warmSecondaryWindowPages } from "../../apps/desktop/src/lib/secondary-window-pages";
 import { useEscapeOwner } from "../../apps/desktop/src/lib/secondary-window-context";
 import { useAppStore } from "../../apps/desktop/src/stores/app-store";
 import { initLanguageSync } from "../../apps/desktop/src/lib/app-language";

let settings = {
  defaultMode: "agent",
  theme: "light",
  language: "en",
  enterToSend: true,
  developerMode: false,
  networkProxy: { mode: "custom", url: "socks5://10.0.0.8:1080" },
};
const fixtureMarketPlugin = {
  id: "fixture.notes",
  name: "Fixture Notes",
  description: "Fixture marketplace entry",
  author: "Fixture",
  latestVersion: "1.0.0",
  updatedAt: "2026-01-01T00:00:00.000Z",
  permissionSummary: [],
};
const fixtureTask = {
  id: "task-1",
  title: "Nightly notes",
  prompt: "Summarize",
  cadence: "daily",
  mode: "agent",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const fixtureRun = {
  id: "run-1",
  taskId: "task-1",
  sessionId: "run-session-1",
  status: "completed",
  errorCode: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
};
const FIXTURES = {
  [IPC.invoke.settingsGet]: () => settings,
  [IPC.invoke.settingsSet]: (input) => {
    settings = input;
    return settings;
  },
  [IPC.invoke.providersList]: () => ({ providers: [] }),
  [IPC.invoke.sessionList]: () => ({ sessions: [] }),
  [IPC.invoke.appGetOnboarding]: () => ({}),
  [IPC.invoke.updatesGetState]: () => ({
    mode: "in-app",
    preference: "automatic",
    defaultPreference: "automatic",
    automaticSupported: true,
    status: "idle",
    currentVersion: "0.20.1",
  }),
  [IPC.invoke.configSyncGetState]: () => ({
    configured: false,
    enabled: false,
    paused: false,
    locked: false,
    status: "notConfigured",
    remoteMode: "strict",
    categories: {},
    includeSecrets: false,
    includeMemory: false,
    automaticSync: false,
    pendingApprovals: [],
    mappings: [],
  }),
  [IPC.invoke.commandShellList]: () => ({ choices: [], effective: null }),
  [IPC.invoke.systemFontsList]: () => ([]),
  [IPC.invoke.pluginScenicThemesDestinations]: () => ([]),
  [IPC.invoke.pluginList]: () => ({ plugins: [] }),
  [IPC.invoke.marketSearch]: () => ({ plugins: [fixtureMarketPlugin], providerId: "fixture", sourceUrl: "" }),
  [IPC.invoke.marketGetDetail]: () => ({
    plugin: { ...fixtureMarketPlugin, readmeMarkdown: "Fixture", versions: [], permissions: [] },
  }),
  [IPC.invoke.marketCheckUpdates]: () => ({ updates: [], plugins: [] }),
  [IPC.invoke.scheduledList]: () => ({ tasks: [fixtureTask] }),
  [IPC.invoke.scheduledListRuns]: () => ({ runs: [fixtureRun] }),
  [IPC.invoke.sessionGet]: () => ({
    session: {
      id: "run-session-1",
      messages: [{ id: "m1", role: "user", content: "hello" }],
      messageStart: 0,
      hasMoreBefore: false,
      messageCount: 1,
    },
  }),
  [IPC.invoke.projectList]: () => ({ projects: [] }),
};
const unknownChannels = [];
const listeners = new Map();
window.piDesktop = {
  platform: "darwin",
  version: "0.20.1",
  on(channel, listener) {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener);
    listeners.set(channel, set);
    return () => set.delete(listener);
  },
  async invoke(channel, input) {
    const fixture = FIXTURES[channel];
    if (!fixture) {
      unknownChannels.push(channel);
      throw new Error("missing e2e fixture for channel: " + channel);
    }
    return { ok: true, data: fixture(input) };
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});

useAppStore.setState({
  settings,
  plugins: [],
  providers: [],
  sessions: [],
  page: "chat",
});
initLanguageSync();
 /** A real `useEscapeOwner` claim, plus a real nested modal dialog element. */
 let setNested = () => undefined;
 function NestedEscapeSurface() {
   const [active, setActive] = useState(false);
   setNested = setActive;
   useEscapeOwner(active);
   return active ? (
     <div role="dialog" aria-modal="true" className="probe-nested-dialog">
       <button type="button">nested</button>
     </div>
   ) : null;
 }

 // Probe control for the chat-hosted menu: real TranscriptMenu/ToolRow hosts
 // stay mounted while closed, so the probe keeps one closed ContextMenu
 // behind the window exactly like production chat does.
 let setChatMenuState = () => undefined;
 const chatMenuRequest = () => ({
   items: [{ id: "copy", label: "Copy", onSelect: () => undefined }],
   point: { x: 120, y: 120 },
   selection: "",
 });

 function Harness() {
   const page = useAppStore((state) => state.page);
   const setPage = useAppStore((state) => state.setPage);
   const covered = page !== "chat";
   const [chatMenu, setChatMenu] = useState(null);
   setChatMenuState = setChatMenu;
  return (
    <>
      <div
        id="chat-shell"
        aria-hidden={covered ? true : undefined}
        inert={covered ? true : undefined}
      >
        <div id="chat-scroll" style={{ height: "420px", overflow: "auto" }}>
          <div style={{ height: "2400px" }}>transcript</div>
        </div>
        <textarea id="composer" className="composer-input" defaultValue="unsent draft" />
        <button id="opener" type="button" onClick={() => setPage("settings")}>
          Open settings
        </button>
        <button id="chat-menu-opener" type="button" onClick={() => setChatMenu(chatMenuRequest())}>
          Chat menu
        </button>
        <ContextMenu state={chatMenu} onClose={() => setChatMenu(null)} />
      </div>
      <p id="page-indicator">{page}</p>
      <NestedEscapeSurface />
      <SecondaryWindows page={page} onClose={() => setPage("chat")} />
    </>
  );
}

const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<Harness />));

const frame = () => new Promise(requestAnimationFrame);
async function settle() {
  await frame();
  await frame();
  await frame();
}

// Wait for a plate's entrance animation to finish, then let two frames pass, so
// a measured box describes the settled window rather than a mid-flight frame.
async function settled(node) {
  if (node) {
    await Promise.all(
      node.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    );
  }
  await settle();
  await settle();
}
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await frame();
  }
  throw new Error(message ?? "Timed out waiting for condition");
}
const failures = [];
function assert(value, message) {
  if (!value) failures.push(message);
}
const plate = (kind) => document.querySelector(`[data-secondary-window-root="${kind}"]`);
const isVisible = (node) =>
  node?.checkVisibility
    ? node.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
    : Boolean(node?.getClientRects().length);
const currentPage = () => useAppStore.getState().page;
const pressEscape = () =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
// A real Escape starts at the focused control and bubbles through document to
// window; page-level document listeners (the plugin detail sheet) never see a
// key dispatched directly on window.
const pressEscapeFromFocus = () => {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
};
const closeButton = (kind) => plate(kind)?.querySelector('[data-nav="close-secondary"]');
const activeKind = () => {
  const active = document.activeElement;
  return active?.closest?.("[data-secondary-window-root]")?.getAttribute("data-secondary-window-root") ?? null;
};
const rectOf = (node) => {
  const rect = node.getBoundingClientRect();
  return {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    top: Math.round(rect.top),
    left: Math.round(rect.left),
  };
};
const ensureChat = async () => {
  if (currentPage() !== "chat") useAppStore.getState().setPage("chat");
  await settle();
};

window.secondaryWindowsProbe = async ({ width, height } = {}) => {
  const result = { viewport: { width, height }, steps: {}, unknownChannels: [] };
  const chatScroll = document.querySelector("#chat-scroll");
  const composer = document.querySelector("#composer");
  chatScroll.scrollTop = 320;

  // 1. Cold first open: no warmup has run in this bundle, so the plate's lazy
  //    import is still pending and this measures import + commit. Focus lands
  //    on the plate container itself — never the close control, whose hover
  //    tooltip would otherwise paint uninvited with the pointer elsewhere.
  const opener = document.querySelector("#opener");
  opener.focus();
  await settle();
  const openerTookFocus = document.activeElement === opener;
  const coldStart = performance.now();
  flushSync(() => opener.click());
  const settingsPlate = await waitFor(() => {
    const node = plate("settings");
    return node && isVisible(node) && node.querySelector(".settings-nav") ? node : null;
  }, "Settings plate did not present");
  await settle();
  // The close tooltip paints 300ms after hover or focus: with the pointer
  // elsewhere and focus on the plate container, no tooltip may appear.
  await new Promise((resolve) => setTimeout(resolve, 450));
  const plateFocusables = [...settingsPlate.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => isVisible(node));
  result.steps.firstOpen = {
    coldOpenMs: Math.round((performance.now() - coldStart) * 10) / 10,
    rect: rectOf(settingsPlate),
    chatInert: document.querySelector("#chat-shell").hasAttribute("inert"),
    chatScrollTop: chatScroll.scrollTop,
    activeIsPlate: document.activeElement === settingsPlate || document.hasFocus() === false,
    openerTookFocus,
    windowHasFocus: document.hasFocus(),
    activeTag: document.activeElement?.tagName ?? null,
    activeId: document.activeElement?.id ?? null,
    activeNav: document.activeElement?.getAttribute?.("data-nav") ?? null,
    ariaModal: settingsPlate.getAttribute("aria-modal"),
    ariaLabel: settingsPlate.getAttribute("aria-label"),
    plateChromeTitle: settingsPlate.querySelector(".secondary-window-title, .secondary-window-bar")?.textContent ?? null,
    tooltipPainted: document.querySelector('[role="tooltip"]') !== null,
    firstFocusableNav: plateFocusables[0]?.getAttribute("data-nav") ?? null,
    settingsTab: useAppStore.getState().settingsTab,
  };
  assert(result.steps.firstOpen.chatInert, "Chat shell was not inert while a window was presented");
  result.steps.firstOpen.closeControlConnected = closeButton("settings")?.isConnected ?? false;
  assert(
    result.steps.firstOpen.openerTookFocus || result.steps.firstOpen.activeIsPlate,
    "Neither the opener nor the presented plate container could take focus",
  );
  assert(result.steps.firstOpen.ariaModal === "true", "Presented plate is not aria-modal");
  assert(result.steps.firstOpen.ariaLabel === "Settings", "Settings plate lost its accessible name");
  assert(
    result.steps.firstOpen.plateChromeTitle === null,
    "Plate paints its own title band over the destination header: " + result.steps.firstOpen.plateChromeTitle,
  );
  assert(!result.steps.firstOpen.tooltipPainted, "Close tooltip painted without hover or focus");
  assert(
    result.steps.firstOpen.firstFocusableNav === "close-secondary",
    "The first Tab from the plate container must reach the close control",
  );
  // The invariant that removes the uninvited tooltip is focus ownership, and it
  // is observable even in a never-shown window: opening a destination lands on
  // the plate container and never on the close control, whose tooltip only
  // shows on hover or focus (`components/ui.tsx`). The painting itself is
  // measured separately as a capability report (see below), because a hidden
  // window does not paint tooltips.
  assert(
    result.steps.firstOpen.activeNav !== "close-secondary",
    "Opening a window focused the close control, which paints its tooltip",
  );
  assert(
    result.steps.firstOpen.activeTag === "SECTION" || result.steps.firstOpen.openerTookFocus,
    "Opening a window focused neither the plate container nor its opener",
  );
  // Capability probe, not an assertion: focus the close control and see whether
  // this environment paints a tooltip at all. With `show: false` the shared
  // tooltip guards never let one paint, so this records `false` and the
  // open-time `tooltipPainted: false` above stays a weaker signal.
  const closeForTooltip = closeButton("settings");
  assert(closeForTooltip, "Settings plate has no close control to focus");
  flushSync(() => closeForTooltip.focus());
  await new Promise((resolve) => setTimeout(resolve, 450));
  result.steps.tooltipCapability = {
    focusedCloseControl: document.activeElement === closeForTooltip,
    documentHidden: document.hidden,
    documentHasFocus: document.hasFocus(),
    tooltipPainted: document.querySelector('[role="tooltip"]') !== null,
  };
  assert(
    result.steps.tooltipCapability.focusedCloseControl,
    "The close control could not take focus, so its tooltip behavior is unmeasured",
  );
  flushSync(() => settingsPlate.focus());
  await new Promise((resolve) => setTimeout(resolve, 250));

  // 2. Deep link: a settings tab entry point opens the same window on that tab.
  await ensureChat();
  flushSync(() => useAppStore.getState().setSettingsTab("skills"));
  await waitFor(() => document.querySelector(".settings-nav-item.active"), "Skills tab did not activate");
  result.steps.deepLink = {
    page: currentPage(),
    tab: useAppStore.getState().settingsTab,
    nonce: useAppStore.getState().settingsTabNonce,
    activeLabel: document.querySelector(".settings-nav-item.active .settings-nav-label")?.textContent,
  };
  assert(result.steps.deepLink.page === "settings", "Deep link did not open the window");
  assert(result.steps.deepLink.activeLabel === "Skills", "Deep link did not select the Skills destination");

  // 3. Switching content: a second destination replaces the presented plate and
  //    the first one stays mounted but hidden and inert.
  flushSync(() => useAppStore.getState().setPage("plugins"));
  await waitFor(() => plate("plugins") && isVisible(plate("plugins")), "Extensions plate did not present");
  await settle();
  const plates = [...document.querySelectorAll("[data-secondary-window-root]")];
  const presented = plates.filter(isVisible);
  result.steps.switch = {
    mountedKinds: plates.map((node) => node.getAttribute("data-secondary-window-root")),
    presentedCount: presented.length,
    settingsVisible: isVisible(plate("settings")),
    settingsAriaHidden: plate("settings").getAttribute("aria-hidden"),
    pluginsAriaModal: plate("plugins").getAttribute("aria-modal"),
    pluginsRect: rectOf(plate("plugins")),
    activeKind: activeKind(),
    pluginsStillConnected: plate("plugins").isConnected,
  };
  assert(result.steps.switch.mountedKinds.includes("settings"), "Retained Settings plate was unmounted");
  assert(result.steps.switch.presentedCount === 1, "More than one plate was presented");
  assert(!result.steps.switch.settingsVisible, "Retained Settings plate stayed visible");
  assert(result.steps.switch.settingsAriaHidden === "true", "Retained plate is not aria-hidden");
  assert(result.steps.switch.activeKind === "plugins", "Switching did not focus the new plate");

  // 4. Escape ownership: an inner surface claims Escape first; the window closes
  //    only after that claim is released. Re-anchor the opener inside the
  //    presented plate (the chat opener is unreachable behind `inert` after the
  //    switch), then release it again for the scrim/close-button steps below.
  const escapeOpener = plate("plugins")?.querySelector('[data-nav="close-secondary"]');
  escapeOpener?.focus();
  await settle();
  result.steps.escapeOpenerActive = escapeOpener?.isConnected === true;
  flushSync(() => setNested(true));
  await settle();
  pressEscape();
  await settle();
  result.steps.nestedEscape = {
    pageAfterClaimedEscape: currentPage(),
    nestedVisible: isVisible(document.querySelector(".probe-nested-dialog")),
  };
  assert(result.steps.nestedEscape.pageAfterClaimedEscape === "plugins", "Escape closed the window over an open inner surface");
  flushSync(() => setNested(false));
  await settle();
  pressEscape();
  await settle();
  result.steps.escape = {
    page: currentPage(),
    focusId: document.activeElement?.id ?? null,
    chatInert: document.querySelector("#chat-shell").hasAttribute("inert"),
  };
  assert(result.steps.escape.page === "chat", "Escape did not dismiss the window");
  assert(
    result.steps.escape.focusId === "composer",
    "Escape over a plate-anchored opener did not fall through to the composer (got " + result.steps.escape.focusId + ")",
  );
  assert(!result.steps.escape.chatInert, "Chat shell stayed inert after dismissal");

  // 4b. A real chat-hosted ContextMenu owns Escape only while open. Closed in
  //     the retained background (exactly how production TranscriptMenu hosts
  //     stay mounted) it must own nothing: its claim pinned the owner set
  //     before the fix, so no window could ever close on Escape. Open over
  //     the plate, the first Escape closes the menu and keeps the window; the
  //     second Escape dismisses the window. Both presses travel the faithful
  //     path: from the focused element, capture through window, bubble back.
  await ensureChat();
  document.querySelector("#opener").focus();
  flushSync(() => document.querySelector("#opener").click());
  await waitFor(() => isVisible(plate("settings")), "Settings did not reopen for the closed-menu check");
  await settle();
  pressEscapeFromFocus();
  await waitFor(() => currentPage() === "chat", "Escape did not dismiss the window over a closed chat menu");
  result.steps.closedChatMenu = { page: currentPage() };
  assert(result.steps.closedChatMenu.page === "chat", "Closed chat menu owned Escape over the window");

  // Open the real menu on uncovered chat, then present the window over it:
  // the capture-phase menu listener still answers before the window's
  // bubble listener, exactly like production.
  flushSync(() => setChatMenuState(chatMenuRequest()));
  await waitFor(
    () => document.querySelector(".context-menu.is-open") !== null,
    "Chat menu did not open",
  );
  await settle();
  flushSync(() => useAppStore.getState().setPage("settings"));
  await waitFor(() => isVisible(plate("settings")), "Settings did not present over the open menu");
  await settle();
  pressEscapeFromFocus();
  await waitFor(() => document.querySelector(".context-menu") === null, "Menu Escape did not close the menu");
  await settle();
  result.steps.openChatMenu = {
    pageAfterMenuEscape: currentPage(),
    menuClosed: document.querySelector(".context-menu") === null,
  };
  assert(result.steps.openChatMenu.menuClosed, "First Escape left the chat menu open");
  assert(result.steps.openChatMenu.pageAfterMenuEscape === "settings", "Menu Escape closed the window too");
  pressEscapeFromFocus();
  await waitFor(() => currentPage() === "chat", "Second Escape did not dismiss the window");
  result.steps.openChatMenu.windowClosedOnSecondEscape = currentPage() === "chat";
  await ensureChat();

  // 4c. First-open cost in this bundle: the cold open in step 1 paid the lazy
  //     import before its first meaningful content; after the shared loaders
  //     settle, reopening only commits. A bundled dynamic import is not a
  //     stand-in for dev cold timing, which stays NOT MEASURED.
  await warmSecondaryWindowPages();
  document.querySelector("#opener").focus();
  const warmStart = performance.now();
  flushSync(() => document.querySelector("#opener").click());
  await waitFor(
    () => {
      const node = plate("settings");
      return node && isVisible(node) && node.querySelector(".settings-nav") ? node : null;
    },
    "Settings did not reopen for the timing check",
  );
  await settle();
  result.steps.warmOpen = { ms: Math.round((performance.now() - warmStart) * 10) / 10 };
  await ensureChat();

  // 5. Chat state survives the round trip, and the transcript node is the one
  //    that was there before the window opened.
  result.steps.retention = {
    sameNode: document.querySelector("#chat-scroll") === chatScroll,
    scrollTop: chatScroll.scrollTop,
    draft: composer.value,
  };
  assert(result.steps.retention.sameNode, "Chat transcript node was rebuilt");
  assert(result.steps.retention.scrollTop === 320, "Chat scroll position was lost");
  assert(result.steps.retention.draft === "unsent draft", "Composer draft was discarded");

  // 6. Header close control and scrim share the same dismissal path.
  document.querySelector("#opener").focus();
  flushSync(() => document.querySelector("#opener").click());
  await waitFor(() => isVisible(plate("settings")), "Settings did not reopen");
  await settle();
  flushSync(() => closeButton("settings").click());
  await settle();
  result.steps.closeControl = {
    page: currentPage(),
    focusId: document.activeElement?.id ?? null,
  };
  assert(result.steps.closeControl.page === "chat", "Header close control did not dismiss");
  assert(result.steps.closeControl.focusId === "opener", "Header close did not restore focus");

  document.querySelector("#opener").focus();
  flushSync(() => document.querySelector("#opener").click());
  await waitFor(() => isVisible(plate("settings")), "Settings did not reopen for the scrim check");
  await settle();
  const scrim = document.querySelector(".secondary-window-scrim");
  scrim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, isPrimary: true }));
  scrim.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, isPrimary: true }));
  flushSync(() => scrim.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
  result.steps.scrim = { page: currentPage(), focusId: document.activeElement?.id ?? null };
  assert(result.steps.scrim.page === "chat", "Scrim press did not dismiss the window");
  assert(result.steps.scrim.focusId === "opener", "Scrim dismissal did not restore focus");

  // 7. Tab is trapped inside the presented plate.
  document.querySelector("#opener").focus();
  flushSync(() => document.querySelector("#opener").click());
  await waitFor(() => isVisible(plate("settings")), "Settings did not reopen for the trap check");
  await settled(plate("settings"));
  const focusables = [...plate("settings").querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => isVisible(node));
  const last = focusables[focusables.length - 1];
  last.focus();
  last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  await settle();
  result.steps.trap = {
    focusableCount: focusables.length,
    wrapped: document.activeElement === focusables[0],
    firstDataNav: focusables[0].getAttribute("data-nav"),
  };
  assert(result.steps.trap.wrapped, "Tab did not wrap inside the presented plate");

  // 8. Wide and narrow sizing, one presented plate at a time, and the
  //    scheduled content slot.
  await settled(plate("settings"));
  result.steps.sizes = {
    settings: rectOf(plate("settings")),
    plugins: rectOf(plate("plugins")),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
  await ensureChat();
  flushSync(() => useAppStore.getState().setPage("scheduled"));
  await waitFor(() => plate("scheduled") && isVisible(plate("scheduled")), "Scheduled plate did not present");
  await settled(plate("scheduled"));
  result.steps.scheduled = {
    rect: rectOf(plate("scheduled")),
    presentedCount: [...document.querySelectorAll("[data-secondary-window-root]")].filter(isVisible).length,
    ariaLabel: plate("scheduled").getAttribute("aria-label"),
    plateChromeTitle: plate("scheduled").querySelector(".secondary-window-title, .secondary-window-bar")?.textContent ?? null,
    activeKind: activeKind(),
  };
  assert(result.steps.scheduled.presentedCount === 1, "Scheduled opened a second presented plate");
  assert(result.steps.scheduled.ariaLabel === "Scheduled", "Scheduled plate lost its accessible name");
  assert(result.steps.scheduled.plateChromeTitle === null, "Scheduled paints its own title band");

  // 9. Opening a scheduled run's conversation ends on chat through the page's
  //    own open-session path: clicking the run's Open-conversation control
  //    selects that session and clears the window slot.
  await waitFor(
    () => plate("scheduled")?.querySelector(".scheduled-run .scheduled-icon-btn"),
    "Scheduled run has no open-conversation control",
  );
  flushSync(() => plate("scheduled").querySelector(".scheduled-run .scheduled-icon-btn").click());
  await waitFor(() => currentPage() === "chat", "Open-conversation did not reach chat");
  await waitFor(
    () => useAppStore.getState().activeSessionId === "run-session-1",
    "Open-conversation did not select the run session",
  );
  result.steps.scheduledReturn = {
    page: currentPage(),
    activeSessionId: useAppStore.getState().activeSessionId,
    focusId: document.activeElement?.id ?? null,
  };
  assert(result.steps.scheduledReturn.page === "chat", "Open-conversation did not clear the window");
  assert(
    result.steps.scheduledReturn.activeSessionId === "run-session-1",
    "Open-conversation selected the wrong session",
  );
  await ensureChat();

  // 10. A retained hidden plugin detail owns no Escape: open a real detail,
  //     switch windows so it is retained but hidden, then Escape. The
  //     presented window closes; the hidden selection is untouched, so
  //     reopening shows the detail still open. A second Escape with the
  //     window presented closes the detail and keeps the window.
  flushSync(() => useAppStore.getState().setPage("plugins"));
  await waitFor(() => plate("plugins") && isVisible(plate("plugins")), "Extensions plate did not present");
  await waitFor(() => document.querySelector("#plugins-tab-market"), "Market tab did not render");
  flushSync(() => document.querySelector("#plugins-tab-market").click());
  await waitFor(() => document.querySelector(".plugins-card-hit"), "Market card did not render");
  flushSync(() => document.querySelector(".plugins-card-hit").click());
  await waitFor(() => document.querySelector(".plugins-sheet"), "Plugin detail did not open");
  await settle();
  flushSync(() => useAppStore.getState().setPage("settings"));
  await waitFor(() => isVisible(plate("settings")), "Settings did not present over the detail");
  await settle();
  assert(
    document.querySelector(".plugins-sheet") === null,
    "Hidden plate's detail portal stayed mounted over the presented window",
  );
  pressEscape();
  await waitFor(() => currentPage() === "chat", "Escape did not close the presented window over a hidden detail");
  flushSync(() => useAppStore.getState().setPage("plugins"));
  await waitFor(() => isVisible(plate("plugins")), "Extensions did not reopen");
  await waitFor(() => document.querySelector(".plugins-sheet"), "Hidden detail selection was mutated by Escape");
  result.steps.hiddenDetail = { retained: true };
  pressEscapeFromFocus();
  await waitFor(() => document.querySelector(".plugins-sheet") === null, "Presented detail did not close on Escape");
  await settle();
  result.steps.hiddenDetail.closedOnSecondEscape = currentPage() === "plugins";
  assert(result.steps.hiddenDetail.closedOnSecondEscape, "Detail Escape closed the window too");
  await ensureChat();

  // 11. A real body-portaled menu owns its keys: open the General-tab
  //     language menu, Tab from its search field stays put instead of being
  //     yanked to the plate, Escape closes the menu (not the window) and
  //     restores the trigger.
  flushSync(() => {
    useAppStore.getState().setPage("settings");
    useAppStore.getState().setSettingsTab("general");
  });
  await waitFor(() => isVisible(plate("settings")), "Settings did not present for the menu check");
  await waitFor(() => document.querySelector(".settings-language-trigger"), "Language trigger did not render");
  await settle();
  flushSync(() => document.querySelector(".settings-language-trigger").click());
  const languageMenu = await waitFor(
    () => document.querySelector(".settings-language-menu.is-open"),
    "Language menu did not open",
  );
  const languageSearch = await waitFor(
    () => languageMenu.querySelector("input"),
    "Language menu search did not render",
  );
  await waitFor(() => document.activeElement === languageSearch, "Menu did not take focus on open");
  languageSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  await settle();
  result.steps.nestedMenu = {
    focusStayedInMenu: document.activeElement === languageSearch,
    plate: plate("settings")?.contains(document.activeElement) ?? false,
  };
  assert(result.steps.nestedMenu.focusStayedInMenu, "Tab inside the portaled menu was yanked to the plate");
  pressEscapeFromFocus();
  await waitFor(() => document.querySelector(".settings-language-menu") === null, "Menu did not close on Escape");
  await settle();
  result.steps.nestedMenu.menuClosed = true;
  result.steps.nestedMenu.pageAfterMenuEscape = currentPage();
  result.steps.nestedMenu.focusRestored =
    document.activeElement === document.querySelector(".settings-language-trigger");
  assert(result.steps.nestedMenu.pageAfterMenuEscape === "settings", "Menu Escape closed the window");
  assert(result.steps.nestedMenu.focusRestored, "Menu Escape did not restore the trigger");
  await ensureChat();

 // Screenshot stage for the launcher: one plate presented, settled past its
 // lazy fallback, under the requested theme. Runs after the probe, so every
 // page module is already warm — the shot shows the presented surface, not
 // the loading state.
 window.secondaryWindowsShot = async (kind, theme) => {
   document.documentElement.dataset.theme = theme;
   flushSync(() => useAppStore.getState().setPage(kind));
   const node = await waitFor(() => {
     const candidate = plate(kind);
     return candidate && isVisible(candidate) ? candidate : null;
   }, `Shot plate ${kind} did not present`);
   await waitFor(
     () => node.querySelector(".route-pending") === null && (node.textContent ?? "").trim().length > 0,
     `Shot plate ${kind} did not settle`,
   );
   // Let the plate's own entrance animation finish so the captured surface and
   // the measured box describe the settled window, not a mid-flight frame.
   await Promise.all(
     node.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
   );
   await settle();
   await settle();
   // The plate shells must read as one surface: same computed background for
   // every destination, none of them repainting the shared tone inside, and one
   // visible heading apiece (the destination's own), never plate chrome on top.
   const body = node.querySelector(".secondary-window-body");
   const pageRoot = body?.firstElementChild ?? null;
   // Resolve the shared token through a throwaway element so the comparison is
   // between painted colours, not token strings.
   const toneProbe = document.createElement("div");
   toneProbe.style.background = "var(--ds-bg-primary)";
   document.body.append(toneProbe);
   const sharedTone = getComputedStyle(toneProbe).backgroundColor;
   toneProbe.remove();
   return {
     kind,
     theme,
     rect: rectOf(node),
     ariaLabel: node.getAttribute("aria-label"),
     background: getComputedStyle(node).backgroundColor,
     sharedTone,
     pageRootBackground: pageRoot ? getComputedStyle(pageRoot).backgroundColor : null,
     h1Count: node.querySelectorAll("h1").length,
   };
 };
  result.failures = failures;
  return result;
};
