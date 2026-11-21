import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createInteractionSlice } = await import("../src/stores/slices/interaction-slice.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const launcherSource = await read("../../../scripts/e2e-secondary-windows.mjs");
 const [
  appShell,
  layerSource,
  plateSource,
  skippedSource,
  runtimeSource,
  contextMenuSource,
  pageLoadersSource,
  openDialogSource,
  pluginsPageSource,
  scheduledPage,
  sessionSlice,
  windowStyles,
] = await Promise.all([
  read("../src/features/app/AppShell.tsx"),
  read("../src/features/app/SecondaryWindows.tsx"),
  read("../src/components/SecondaryWindow.tsx"),
  read("../src/lib/secondary-window-context.tsx"),
  read("../src/features/app/useAppShellRuntime.tsx"),
  read("../src/components/ContextMenu.tsx"),
  read("../src/lib/secondary-window-pages.ts"),
  read("../src/components/settings/ProviderSetupDialog.tsx"),
  read("../src/features/plugins/usePluginsPage.ts"),
  read("../src/pages/ScheduledPage.tsx"),
  read("../src/stores/slices/session-slice.ts"),
  read("../src/styles/secondary-windows.css"),
]);

function harness(patch = {}) {
  let state = {
    page: "chat",
    activeSessionId: "session-a",
    settingsTab: "general",
    settingsTabNonce: 0,
    settingsAnchor: null,
    navStack: [{ page: "chat", sessionId: "session-a" }],
    navIndex: 0,
    selectSession: async () => undefined,
    ...patch,
  };
  const intents = [];
  const actions = createInteractionSlice({
    get: () => state,
    set: (update) => {
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
    },
    runtime: { beginNavigationIntent: () => intents.push(state.page) },
    interactionRuntime: {},
  });
  state = { ...state, ...actions };
  return {
    get: () => state,
    intents,
    set: (next) => {
      state = { ...state, ...next };
    },
  };
}

test("a destination opens the one window and is never a history entry", () => {
  const h = harness();
  h.get().setPage("settings");
  assert.equal(h.get().page, "settings");
  assert.equal(h.get().navStack.length, 1, "no destination entry was appended");
  assert.equal(h.get().navIndex, 0);

  // Switching destinations replaces the presented content instead of opening a
  // second root window, so the slot still addresses exactly one surface.
  h.get().setPage("plugins");
  assert.equal(h.get().page, "plugins");
  assert.equal(h.get().navStack.length, 1);
  // `chat` means "no window" and reaches it with the same call.
  h.get().setPage("chat");
  assert.equal(h.get().page, "chat");
  h.get().setPage("chat");
  assert.equal(h.get().page, "chat");
  assert.equal(h.get().navStack.length, 1);
});

test("deep links into a settings tab open the window on that tab", () => {
  const h = harness({ page: "chat" });
  h.get().setSettingsTab("skills");
  assert.equal(h.get().page, "settings");
  assert.equal(h.get().settingsTab, "skills");
  assert.equal(h.get().settingsTabNonce, 1, "a same-tab deep link stays observable");

  // An anchor-only deep link from the search dialog keeps working.
  h.get().setSettingsAnchor("settings.rowKey");
  h.get().setSettingsAnchor(null);
  assert.equal(h.get().settingsAnchor, null);
  // Nothing behind the window was recorded while it opened.
  assert.equal(h.get().navStack.length, 1);
});

test("conversation history is unreachable while a window covers chat", () => {
  const h = harness({
    navStack: [
      { page: "chat", sessionId: "session-a" },
      { page: "chat", sessionId: "session-b" },
    ],
    navIndex: 1,
  });
  h.get().setPage("settings");
  h.get().navBack();
  assert.equal(h.get().page, "settings");
  assert.equal(h.get().navIndex, 1);
  assert.deepEqual(h.intents, ["chat"], "Back never starts a navigation intent while covered");
  h.get().setPage("chat");
  h.get().navBack();
  assert.equal(h.get().navIndex, 0, "history resumes on chat");
});

test("opening a scheduled run's conversation closes the window", () => {
  // `selectSession` puts the shell back on chat, and the page's own call is a
  // no-op afterwards, so a run opened from the window lands on its transcript.
  assert.match(sessionSlice, /set\(\{ selectingSessionId: id, page: "chat" \}\)/);
  assert.match(scheduledPage, /await selectSession\(sessionId\);[\s\S]{0,40}setPage\("chat"\);/);
  const h = harness({ page: "scheduled" });
  h.get().setPage("chat");
  assert.equal(h.get().page, "chat");
});

test("only one plate is presented and opened plates stay mounted", () => {
  assert.match(layerSource, /const requested: SecondaryWindowKind \| null = page === "chat" \? null : page/);
  assert.match(
    layerSource,
    /setMountedKinds\(\(current\) =>\s*current\.includes\(requested\) \? current : \[\.\.\.current, requested\],?\s*\)/,
  );
  assert.match(layerSource, /const active = requested === kind;/);
  assert.match(layerSource, /className={`secondary-window-layer\$\{open \? " is-open" : ""\}`}/);
  // Retained plates keep their scroll offsets and drafts: the body is never
  // rebuilt and a hidden plate paints nothing instead of unmounting.
  assert.doesNotMatch(layerSource, /unmount|removeMountedKind/);
  assert.match(windowStyles, /\.secondary-window\.is-inactive \{\s*visibility: hidden;\s*content-visibility: hidden;\s*pointer-events: none;/);
});

test("header close, scrim, and Escape share one dismissal path", () => {
  assert.match(layerSource, /const requestClose = useCallback\(\(\) => \{\s*explicitCloseRef\.current = true;\s*onClose\(\);/);
  assert.match(plateSource, /onClick=\{onRequestClose\}/);
  assert.match(layerSource, /className="secondary-window-scrim"\s*onClick=\{\(\) => requestClose\(\)\}/);
  assert.match(layerSource, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*requestClose\(\);/);
  assert.match(appShell, /const closeSecondaryWindow = useCallback\(\(\) => \{\s*setPage\("chat"\);/, "closeSecondaryWindow closes the slot");
  // The sidebar destinations toggle: the presented one closes instead of
  // adding a return entry.
  assert.match(plateSource, /data-nav="close-secondary"/);
});

test("a nested surface owns Escape before the window", () => {
  assert.match(layerSource, /if \(escapeClaimed\(\) \|\| visibleNestedDialog\(\)\) return;/);
  assert.match(layerSource, /if \(dialog\.hasAttribute\("data-secondary-window-root"\)\) continue;/);
  assert.match(layerSource, /if \(dialog\.closest\('\[aria-hidden="true"\]'\)\) continue;/);
  // Owners declare themselves while open; the plate's own close control is not
  // one of them.
  assert.match(skippedSource, /export function claimEscape\(\): \(\) => void/);
  assert.match(skippedSource, /export function useEscapeOwner\(active: boolean\): void/);
  assert.match(openDialogSource, /useEscapeOwner\(secondaryWindowActive\)/);
});

test("the background is inert, not hidden, and focus is trapped then restored", () => {
  assert.match(appShell, /inert=\{page === "chat" \? undefined : true\}/);
  assert.doesNotMatch(appShell, /className="app-chat-shell"[\s\S]{0,120}hidden=/);
  assert.match(plateSource, /inert=\{active \? undefined : true\}/);
  assert.match(plateSource, /aria-hidden=\{active \? undefined : true\}/);
  assert.match(layerSource, /const trapTab = \(event: ReactKeyboardEvent<HTMLDivElement>\) => \{/);
  assert.match(layerSource, /if \(event\.key !== "Tab" \|\| !requested\) return;/);
  assert.match(layerSource, /previousFocusRef\.current = active/);
  assert.match(layerSource, /previous\.focus\(\{ preventScroll: true \}\)/);
  assert.match(layerSource, /requestAnimationFrame\(focusComposer\)/);
});

test("the plate is content-sized, centered, and near-fullscreen at small widths", () => {
  assert.match(windowStyles, /\.secondary-window-settings \{\s*--sw-width: 1120px;\s*--sw-height: 820px;/);
  assert.match(windowStyles, /\.secondary-window-plugins \{\s*--sw-width: 900px;\s*--sw-height: 700px;/);
  assert.match(windowStyles, /\.secondary-window-scheduled \{\s*--sw-width: 1200px;\s*--sw-height: 760px;/);
  assert.match(windowStyles, /width: min\(var\(--sw-width\), calc\(100vw - 48px\)\)/);
  assert.match(windowStyles, /height: min\(var\(--sw-height\), calc\(100vh - 48px\)\)/);
  assert.match(
    windowStyles,
    /@media \(max-width: 860px\), \(max-height: 640px\) \{[\s\S]*width: calc\(100vw - 16px\);[\s\S]*height: calc\(100vh - 16px\);/,
  );
  // The layer centers the plate and never becomes a draggable native window.
  assert.match(windowStyles, /\.secondary-window-layer \{[\s\S]*position: fixed;[\s\S]*place-items: center;/);
  assert.doesNotMatch(windowStyles, /app-region:\s*drag|resize:\s*both|window-controls/);
});

test("window content keeps its capability hooks", () => {
  // Runtime work-panel and native plugin surfaces stay sane under the modal.
  assert.match(layerSource, /function NativeSurfaceBlocker\(\) \{/);
  assert.match(layerSource, /useBlockingOverlay\(\)/);
  assert.match(runtimeSource, /const shouldPresent = ready && workPanelOpen/);
  // Every window slot follows the portal-visibility contract so a hidden
  // window's dialogs cannot paint over the presented one.
  assert.match(layerSource, /<PortalVisibilityProvider visible=\{active\}>/);
  assert.match(layerSource, /<SecondaryWindowActiveContext\.Provider key=\{kind\} value=\{active\}>/);
  // Scheduled selection is restored from the remembered origin when the window
  // reopens, so returning never depends on history.
  assert.match(layerSource, /<ScheduledPage \/>/);
});

test("a retained hidden plugin surface owns no Escape", () => {
  // The detail sheet, the pending-install review, and the install dialog all
  // claim Escape and listen for it only while their window is presented: a
  // hidden plate keeps its React state, so an ungated claim would swallow the
  // presented window's Escape or mutate the hidden selection.
  assert.match(pluginsPageSource, /const secondaryWindowActive = useSecondaryWindowActive\(\);/);
  assert.match(
    pluginsPageSource,
    /useEscapeOwner\(\s*secondaryWindowActive && \(Boolean\(selectedId\) \|\| Boolean\(pendingInstall\) \|\| installDialogOpen\),?\s*\);/,
  );
  assert.match(
    pluginsPageSource,
    /if \(!secondaryWindowActive\) return;\s*if \(!selectedId \|\| pendingInstall \|\| installDialogOpen\) return;/,
  );
  assert.match(pluginsPageSource, /if \(!secondaryWindowActive\) return;\s*if \(!pendingInstall\) return;/);
  assert.match(pluginsPageSource, /\}, \[selectedId, pendingInstall, installDialogOpen, secondaryWindowActive\]\);/);
  assert.match(pluginsPageSource, /\}, \[pendingInstall, secondaryWindowActive\]\);/);
});

test("a body-portaled menu owns the Tab press that started inside it", () => {
  // Anchored menus and pickers portal to document.body, outside the plate's
  // DOM subtree. The trap yields only for the surface containing the event
  // target — never a blanket exemption — and ignores in-plate surfaces (still
  // in scope) and aria-hidden subtrees (retained hidden plates).
  assert.match(layerSource, /function nestedMenuOf\(target: EventTarget \| null\): HTMLElement \| null \{/);
  assert.match(layerSource, /target\.closest\('\[role="menu"\], \[role="listbox"\]'\)/);
  assert.match(layerSource, /if \(menu\.closest\("\[data-secondary-window-root\]"\)\) return null;/);
  assert.match(layerSource, /if \(menu\.closest\('\[aria-hidden="true"\]'\)\) return null;/);
  assert.match(layerSource, /if \(visibleNestedDialog\(\)\) return;/);
  assert.match(layerSource, /if \(nestedMenuOf\(event\.target\)\) return;/);
});

test("the isolated E2E launcher stays hidden by default", () => {
  // DOM focus assertions in the probe never need OS-level window focus, so a
  // hidden run stays the default and visible mode stays opt-in.
  assert.doesNotMatch(launcherSource, /show: true/);
  assert.match(launcherSource, /process\.env\.PI_E2E_SHOW === "1"/);
  assert.match(launcherSource, /show: E2E_VISIBLE/);
  assert.doesNotMatch(launcherSource, /win\.show\(\)|bringToFront|maximize\(\)/);
});

 test("initial focus lands on the plate container, not the close control", () => {
   // The close control carries a hover/focus tooltip that paints 300ms after
   // focus: focusing it on open would flash the tooltip with the pointer
   // elsewhere. The container is the programmatic target (never a Tab stop)
   // and the close control stays the first Tab stop through trap order.
   assert.match(plateSource, /tabIndex=\{-1\}/);
   assert.match(layerSource, /const root = windowRefs\.current\.get\(kind\);/);
   assert.match(layerSource, /root\.focus\(\{ preventScroll: true \}\)/);
   assert.doesNotMatch(layerSource, /closeRefs\.current\.get\(kind\)\?\.focus/);
   assert.match(plateSource, /data-nav="close-secondary"/);
 });

 test("a retained closed chat menu owns no Escape", () => {
   // Chat hosts stay mounted while closed, and an unconditional claim would pin
   // the owner set forever: the window's bubble listener would always yield.
   // Only an actually open menu (state non-null) in a presented window claims.
   assert.match(contextMenuSource, /useEscapeOwner\(secondaryWindowActive && state !== null\)/);
   assert.match(contextMenuSource, /if \(!state \|\| !secondaryWindowActive\) return;/);
   assert.match(contextMenuSource, /window\.addEventListener\("keydown", onKeyDown, true\);/);
 });

 test("page modules warm idly from one loader table", () => {
   // The layer's lazy() wrappers and the idle warmup share one loader table,
   // so a first open never pays for a second fetch system and the warmup
   // imports without mounting anything or reading any API.
   assert.match(pageLoadersSource, /export const secondaryWindowPageLoaders = \{/);
   assert.match(pageLoadersSource, /export function scheduleSecondaryWindowWarmup\(\)/);
   assert.match(layerSource, /secondaryWindowPageLoaders\.settings\(\)/);
   assert.match(layerSource, /secondaryWindowPageLoaders\.scheduled\(\)/);
   assert.match(layerSource, /secondaryWindowPageLoaders\.plugins\(\)/);
   assert.match(runtimeSource, /scheduleSecondaryWindowWarmup/);
   assert.match(runtimeSource, /return scheduleSecondaryWindowWarmup\(\);/);
 });
