/**
 * Agent BrowserPreview must not stack a duplicate tab when the same page is
 * already open in the originating session.
 *
 * Repeat previews of the same current page reuse and activate the existing
 * tab (same id, metadata untouched — live reload already covers edits);
 * distinct pages stay separate; sessions stay isolated; a background open
 * never touches the visible strip; and the generic manual tab factory keeps
 * its independent-tab semantics.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  browserPluginTab,
  findBrowserPreviewTab,
  normalizeBrowserPreviewLocation,
  openBrowserPreviewTabState,
} = await import("../src/lib/work-panel-tabs.ts");
const { api } = await import("../src/lib/api.ts");
const { useAppStore } = await import("../src/stores/app-store.ts");
const { readAppSource } = await import("./helpers/source-contracts.mjs");
const { readFile } = await import("node:fs/promises");

const BROWSER_RESOURCE = "pi.browser/browser";
const previewTab = (location) => ({ ...browserPluginTab(location), location });

function browserStateFor(sessionId, tabId, url) {
  return {
    sessionId,
    tabId,
    url,
    title: url,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

function seedStore(activeSessionId) {
  const session = (id, title) => ({ id, title, mode: "agent", providerId: "p", modelId: "m" });
  useAppStore.setState({
    sessions: [session("session-a", "First topic"), session("session-b", "Second topic")],
    activeSessionId,
    messages: [],
    sessionHistory: {},
    retainedSessionIds: [],
    retainedTranscripts: {},
    sessionMeta: {},
    sessionCompactions: {},
    planningStates: {},
    pendingPlans: {},
    notifications: [],
    sessionOutcomes: {},
    runningSessions: {},
    selectingSessionId: undefined,
    isRunning: false,
    page: "chat",
    workspace: null,
    activeProjectPath: undefined,
    draftConfiguration: null,
    navStack: [{ page: "chat", sessionId: activeSessionId }],
    navIndex: 0,
    workPanelOpen: false,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelFileRequest: null,
    workPanelContexts: {},
    providers: [{ id: "p", enabled: true, authKind: "none", models: [{ id: "m" }] }],
    settings: { defaultProviderId: "p", defaultModelId: "m", defaultMode: "agent" },
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
  });
}

test("repeat preview of the same page reuses the tab instead of duplicating", () => {
  const first = openBrowserPreviewTabState({ tabs: [], activeTabId: null }, "/w/site/index.html");
  assert.equal(first.tabs.length, 1);
  const tabId = first.tabs[0].id;
  // The host reports the committed URL after load; matching uses it, not the
  // title or the originally requested location.
  const loaded = {
    tabs: [{ ...first.tabs[0], location: "file:///w/site/index.html", label: "My Page" }],
    activeTabId: null,
  };
  const repeat = openBrowserPreviewTabState(loaded, "/w/site/index.html");
  assert.equal(repeat.tabs.length, 1, "repeat preview opened a duplicate tab");
  assert.equal(repeat.tabs[0].id, tabId, "repeat preview replaced the tab identity");
  assert.deepEqual(repeat.tabs[0].location, "file:///w/site/index.html");
  assert.equal(repeat.tabs[0].label, "My Page", "repeat preview must not retitle the tab");
  assert.equal(repeat.activeTabId, tabId, "repeat preview did not activate the tab");
});

test("preview normalizes local paths but keeps distinct pages and URLs apart", () => {
  const base = openBrowserPreviewTabState({ tabs: [], activeTabId: null }, "/w/site/index.html");
  const loaded = {
    tabs: [{ ...base.tabs[0], location: "file:///w/site/index.html" }],
    activeTabId: base.tabs[0].id,
  };
  // Equivalent spellings of the same file reuse the tab.
  for (const spelling of ["file:///w/site/index.html", "/w/site/sub/../index.html"]) {
    const next = openBrowserPreviewTabState(loaded, spelling);
    assert.equal(next.tabs.length, 1, `${spelling} opened a duplicate tab`);
    assert.equal(next.tabs[0].id, base.tabs[0].id);
  }
  // A different file is a different page.
  const other = openBrowserPreviewTabState(loaded, "/w/site/other.html");
  assert.equal(other.tabs.length, 2, "distinct page did not open its own tab");
  // Distinct query and hash are distinct pages, never collapsed.
  const web = openBrowserPreviewTabState({ tabs: [], activeTabId: null }, "https://example.com/x?y=1");
  assert.equal(
    openBrowserPreviewTabState(web, "https://example.com/x?y=2").tabs.length,
    2,
    "distinct query was collapsed",
  );
  assert.equal(
    openBrowserPreviewTabState(web, "https://example.com/x?y=1#late").tabs.length,
    2,
    "distinct hash was collapsed",
  );
  // A tab that navigated elsewhere no longer matches the old page.
  const navigated = {
    tabs: [{ ...base.tabs[0], location: "https://example.com/elsewhere" }],
    activeTabId: base.tabs[0].id,
  };
  const afterNav = openBrowserPreviewTabState(navigated, "/w/site/index.html");
  assert.equal(afterNav.tabs.length, 2, "preview reused a tab that navigated away");
  // ...but the page it navigated to is itself reusable.
  const followNav = openBrowserPreviewTabState(navigated, "https://example.com/elsewhere");
  assert.equal(followNav.tabs.length, 1);
  assert.equal(followNav.tabs[0].id, base.tabs[0].id);
});
test("preview equates Windows paths with their committed file URLs", () => {
  // The committed tab location is a `file:` URL while the preview event
  // carries the raw path; both spellings must meet on one key.
  const pairs = [
    ["C:/site/index.html", "file:///C:/site/index.html"],
    ["C:\\site\\index.html", "file:///C:/site/index.html"],
    ["c:/site/index.html", "file:///C:/site/index.html"],
    ["C:\\my site\\index.html", "file:///C:/my%20site/index.html"],
    ["file:///c:/site/index.html", "file:///C:/site/index.html"],
  ];
  for (const [pathInput, fileUrl] of pairs) {
    assert.equal(
      normalizeBrowserPreviewLocation(pathInput),
      normalizeBrowserPreviewLocation(fileUrl),
      `${pathInput} did not match ${fileUrl}`,
    );
  }
  // Only the drive letter folds case; the remainder keeps its case.
  assert.notEqual(
    normalizeBrowserPreviewLocation("C:/Site/Index.html"),
    normalizeBrowserPreviewLocation("c:/site/index.html"),
    "path remainder case was folded",
  );
  // Repeat preview across the spellings reuses one tab, with query/hash kept
  // distinct even on file URLs.
  const loaded = {
    tabs: [{ ...browserPluginTab("C:/site/index.html"), location: "file:///C:/site/index.html" }],
    activeTabId: null,
  };
  const tabId = loaded.tabs[0].id;
  for (const spelling of ["C:/site/index.html", "C:\\site\\index.html", "file:///c:/site/index.html"]) {
    const next = openBrowserPreviewTabState(loaded, spelling);
    assert.equal(next.tabs.length, 1, `${spelling} opened a duplicate tab`);
    assert.equal(next.tabs[0].id, tabId);
  }
  assert.equal(
    openBrowserPreviewTabState(loaded, "file:///C:/site/index.html?x=1").tabs.length,
    2,
    "distinct file URL query was collapsed",
  );
  assert.equal(
    openBrowserPreviewTabState(loaded, "file:///C:/site/index.html#late").tabs.length,
    2,
    "distinct file URL hash was collapsed",
  );
});

test("preview keeps UNC authority separate from local paths", () => {
  const unc = normalizeBrowserPreviewLocation("file://server/share/f.html");
  // Same authority, different spelling: one page.
  assert.equal(unc, normalizeBrowserPreviewLocation("\\\\SERVER\\share\\f.html"));
  // A remote authority is never the local path with the same remainder.
  assert.notEqual(unc, normalizeBrowserPreviewLocation("/share/f.html"));
  assert.notEqual(unc, normalizeBrowserPreviewLocation("file:///share/f.html"));
  assert.notEqual(
    unc,
    normalizeBrowserPreviewLocation("file://other-host/share/f.html"),
    "different file hosts were merged",
  );
  const local = openBrowserPreviewTabState({ tabs: [], activeTabId: null }, "/share/f.html");
  assert.equal(local.tabs.length, 1);
  assert.equal(
    openBrowserPreviewTabState(local, "file://server/share/f.html").tabs.length,
    2,
    "remote host preview reused a local tab",
  );
});

test("preview matching only considers browser tabs", () => {
 const state = {
   tabs: [{ id: "file:/w/site/index.html", kind: "file", resource: "/w/site/index.html" }],
   activeTabId: "file:/w/site/index.html",
 };
 assert.equal(findBrowserPreviewTab(state.tabs, "/w/site/index.html"), undefined);
 const next = openBrowserPreviewTabState(state, "/w/site/index.html");
  assert.equal(next.tabs.length, 2, "preview must not retarget a non-browser tab");
});

test("manual browser tabs keep independent-tab semantics", () => {
  const first = browserPluginTab("/w/site/index.html");
  const second = browserPluginTab("/w/site/index.html");
  assert.notEqual(first.id, second.id, "manual factory lost its unique-tab semantics");
  const state = openBrowserPreviewTabState({ tabs: [], activeTabId: null }, "/w/site/index.html");
  void state;
});

test("store: repeat preview in the same session reuses its tab", () => {
  seedStore("session-a");
  const store = () => useAppStore.getState();
  store().openBrowserPreviewTabForSession("session-a", "/w/site/index.html");
  assert.equal(store().workPanelTabs.length, 1);
  const tabId = store().workPanelTabs[0].id;
  store().updateBrowserWorkPanelTab(browserStateFor("session-a", tabId, "file:///w/site/index.html"));
  store().openBrowserPreviewTabForSession("session-a", "/w/site/index.html");
  assert.equal(store().workPanelTabs.length, 1, "repeat preview duplicated the tab");
  assert.equal(store().workPanelTabs[0].id, tabId);
  assert.equal(store().activeWorkPanelTabId, tabId);
  store().openBrowserPreviewTabForSession("session-a", "/w/site/other.html");
  assert.equal(store().workPanelTabs.length, 2, "distinct page did not open its own tab");
});

test("store: preview stays inside its originating session", () => {
  seedStore("session-a");
  const store = () => useAppStore.getState();
  store().openBrowserPreviewTabForSession("session-a", "/w/site/index.html");
  const visibleId = store().workPanelTabs[0].id;
  // A background session's preview lands in its own retained context and never
  // touches the visible strip, selection, or panel visibility.
  store().openBrowserPreviewTabForSession("session-b", "/w/site/index.html");
  assert.equal(store().workPanelTabs.length, 1, "background open touched the visible strip");
  assert.equal(store().workPanelTabs[0].id, visibleId);
  assert.equal(store().activeWorkPanelTabId, visibleId, "background open moved selection");
  assert.equal(store().activeSessionId, "session-a", "background open switched sessions");
  const retained = store().workPanelContexts["session-b"];
  assert.ok(retained, "background open left no retained context");
  assert.equal(retained.tabs.length, 1);
  assert.notEqual(retained.tabs[0].id, visibleId, "sessions shared one tab identity");
});

test("store: navigated-away, closed, and manual tabs behave", () => {
  seedStore("session-a");
  const store = () => useAppStore.getState();
  store().openBrowserPreviewTabForSession("session-a", "/w/site/index.html");
  const tabId = store().workPanelTabs[0].id;
  // The tab navigated elsewhere: previewing the old page opens a new tab.
  store().updateBrowserWorkPanelTab(browserStateFor("session-a", tabId, "https://example.com/"));
  store().openBrowserPreviewTabForSession("session-a", "/w/site/index.html");
  assert.equal(store().workPanelTabs.length, 2, "preview reused a navigated-away tab");
  // Closing the tab showing the page and previewing again opens a fresh tab,
  // not a resurrection of the closed id.
  const indexTab = store().workPanelTabs.find((tab) => tab.id !== tabId);
  assert.ok(indexTab, "expected a second tab showing the previewed page");
  store().closeWorkPanelTab(indexTab.id);
  assert.equal(store().workPanelTabs.length, 1);
  store().openBrowserPreviewTabForSession("session-a", "/w/site/index.html");
  assert.equal(store().workPanelTabs.length, 2);
  assert.ok(
    !store().workPanelTabs.some((tab) => tab.id === indexTab.id),
    "closed tab id was resurrected",
  );
  // The generic session open keeps stacking manual tabs (no factory change).
  store().openWorkPanelTabForSession("session-a", browserPluginTab("/w/site/index.html"));
  store().openWorkPanelTabForSession("session-a", browserPluginTab("/w/site/index.html"));
  assert.equal(store().workPanelTabs.length, 4, "generic manual opens changed semantics");
});

test("store: preview during session selection lands in retained context, then restores", async (t) => {
  seedStore("session-a");
  const store = () => useAppStore.getState();
  // Give session-b history so the selection skips the revalidation fast
  // path and stays pending on the gated detail load below.
  useAppStore.setState((state) => ({
    sessions: state.sessions.map((session) => ({ ...session, messageCount: 1 })),
  }));
  const detail = (id) => {
    const summary = store().sessions.find((item) => item.id === id);
    return {
      session: {
        ...summary,
        messages: id === "session-b"
          ? [{ id: "m-b1", role: "user", content: "hello" }]
          : [],
      },
    };
  };
  let releaseDetail;
  const gate = new Promise((resolve) => { releaseDetail = resolve; });
  t.mock.method(api, "getSession", (id) => (
    id === "session-b" ? gate.then(() => detail(id)) : Promise.resolve(detail(id))
  ));
  t.mock.method(api, "createSession", async (input) => ({ session: { ...input } }));
  t.mock.method(api, "configureSession", async () => ({}));
  store().openBrowserPreviewTabForSession("session-a", "/w/site/a.html");
  const visibleId = store().workPanelTabs[0].id;
  // Start the real public selection flow and hold its detail load, so the
  // selection of session-b is still pending when the preview event lands.
  const selecting = store().selectSession("session-b");
  await Promise.resolve();
  assert.equal(store().selectingSessionId, "session-b", "selection is not pending");
  const visibleIds = store().workPanelTabs.map((tab) => tab.id);
  const activeBefore = store().activeWorkPanelTabId;
  store().openBrowserPreviewTabForSession("session-b", "/w/site/b.html");
  // The pending destination owns only retained state: the visible strip and
  // selection do not move, and the other session is untouched.
  assert.deepEqual(store().workPanelTabs.map((tab) => tab.id), visibleIds);
  assert.equal(store().activeWorkPanelTabId, activeBefore);
  assert.deepEqual(store().workPanelContexts["session-a"].tabs.map((tab) => tab.id), [visibleId]);
  const retained = store().workPanelContexts["session-b"];
  assert.ok(retained, "pending preview left no retained context");
  assert.equal(retained.tabs.length, 1);
  releaseDetail();
  await selecting;
  // The existing selection flow restores the retained tab on commit.
  assert.equal(store().selectingSessionId, undefined);
  assert.equal(store().activeSessionId, "session-b");
  assert.deepEqual(store().workPanelTabs.map((tab) => tab.id), retained.tabs.map((tab) => tab.id));
  assert.equal(store().activeWorkPanelTabId, retained.tabs[0].id);
});

test("renderer preview wiring guard: single atomic originating-session open", async () => {
  // Wiring guard only: it pins the call shape at the event boundary. Any
  // event-to-render interleaving is covered by the store tests above, which
  // drive the real public actions.
  const appSource = await readAppSource();
  const handler = appSource.match(/api\.onBrowserPreview\([\s\S]*?\n\s*\}\);/)?.[0] ?? "";
  assert.ok(handler, "browser preview renderer handler exists");
  assert.match(
    handler,
    /openBrowserPreviewTabForSession\(\s*event\.sessionId,\s*event\.path \?\? event\.url\s*\)/,
    "wiring guard: preview must open through the atomic store action",
  );
  const revealEnd = handler.indexOf("return;", handler.indexOf("event.revealOnly"));
  assert.ok(revealEnd >= 0, "reveal-only branch exists");
  const previewBranch = handler.slice(revealEnd);
  assert.doesNotMatch(
    previewBranch,
    /state\.workPanelTabs|context\?\.tabs|getState\(\)\.workPanelContexts/,
    "preview branch must not snapshot tabs in the renderer",
  );
});

test("preview success wording no longer promises a new tab", async () => {
  const { readMainSource } = await import("./helpers/source-contracts.mjs");
  const mainSource = await readMainSource();
  const handler = mainSource.slice(
    mainSource.indexOf('s.setLocalTool("BrowserPreview"'),
    mainSource.indexOf("sidecar = s;"),
  );
  assert.ok(handler, "BrowserPreview local tool exists");
  assert.doesNotMatch(handler, /new Browser tab/i, "success text still promises a new tab");
});
