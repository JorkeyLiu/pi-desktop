import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { Sidebar } from "../../apps/desktop/src/components/Sidebar";
import {
  loadSidebarPreferences,
  SIDEBAR_PREFERENCES_KEY,
  type SidebarPreferences,
} from "../../apps/desktop/src/lib/sidebar-preferences";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var sidebarSessionOrderProbe: () => Promise<unknown>;
}

const i18n = createInstance();
const ready = i18n.init({ lng: "en", resources: { en: { translation: en } }, initImmediate: false });

const PROJECT = "/fixture/session-order";
const PROJECT_B = "/fixture/session-order-b";
const PROJECT_C = "/fixture/session-order-c";
const MINUTE = 60_000;
const startedAt = Date.now();
const iso = (offsetMs: number) => new Date(startedAt - offsetMs).toISOString();

type FixtureSession = {
  id: string;
  title: string;
  projectPath?: string;
  createdAt: string;
  updatedAt: string;
};

function session(overrides: Partial<FixtureSession> & Pick<FixtureSession, "id">): FixtureSession {
  return {
    title: overrides.id,
    messageCount: 2,
    mode: "agent",
    thinkingLevel: "off",
    permissionMode: "inherit",
    projectPath: PROJECT,
    createdAt: iso(3 * MINUTE),
    updatedAt: iso(3 * MINUTE),
    ...overrides,
  } as FixtureSession;
}

const initialSessions: FixtureSession[] = [
  // Oldest session, but the most recent activity: it must not move.
  session({ id: "alpha", createdAt: iso(3 * MINUTE), updatedAt: iso(MINUTE) }),
  session({ id: "beta", createdAt: iso(2 * MINUTE), updatedAt: iso(2 * MINUTE) }),
  session({ id: "gamma", createdAt: iso(MINUTE), updatedAt: iso(3 * MINUTE) }),
  session({ id: "temporary", projectPath: undefined, createdAt: iso(4 * MINUTE) }),
  // A second project so group order can be observed independently.
  session({ id: "b-one", projectPath: PROJECT_B, createdAt: iso(6 * MINUTE) }),
  session({ id: "b-two", projectPath: PROJECT_B, createdAt: iso(5 * MINUTE) }),
];

/** The stored record a user upgrading from the activity-sorted build has. */
const storedRecord = {
  sessionMeta: {},
  projectMeta: {},
  projectSort: "recent",
  sessionView: { sort: "recent", archived: false },
  openProjectPaths: [PROJECT],
};


/**
 * Host-boundary stub. The probe drives the real Sidebar and the real store; only
 * the preload bridge is replaced, so a project activation reaches a real
 * `project/set` reply instead of a live host.
 */
const sessionProjectPath: Record<string, string> = {};

function workspaceFor(path: string) {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), branch: "main" };
}

function sessionDetailFor(id: string) {
  return {
    id,
    title: id,
    projectPath: sessionProjectPath[id] ?? PROJECT,
    messageCount: 1,
    mode: "agent",
    thinkingLevel: "off",
    permissionMode: "inherit",
    createdAt: iso(MINUTE),
    updatedAt: iso(MINUTE),
    messages: [
      {
        id: `${id}-m1`,
        role: "user",
        content: id,
        createdAt: iso(MINUTE),
        updatedAt: iso(MINUTE),
      },
    ],
  };
}

function rememberSessionProjects(items: readonly FixtureSession[]) {
  for (const item of items) {
    if (item.projectPath) sessionProjectPath[item.id] = item.projectPath;
  }
}

Object.defineProperty(window, "piDesktop", {
  configurable: true,
  value: {
    platform: "darwin",
    on() {
      return () => undefined;
    },
    invoke(channel: string, ...args: unknown[]) {
      switch (channel) {
        case "pi-desktop/project/set":
          return Promise.resolve({
            ok: true,
            data: { workspace: workspaceFor(String(args[0])) },
          });
        case "pi-desktop/session/get":
          return Promise.resolve({
            ok: true,
            data: {
              session: sessionDetailFor(
                String((args[0] as { id?: string } | undefined)?.id ?? ""),
              ),
            },
          });
        case "pi-desktop/plans/pending":
          return Promise.resolve({ ok: true, data: { plans: [] } });
        case "pi-desktop/agent/pendingInteractive":
          return Promise.resolve({
            ok: true,
            data: { asks: [], questions: [], permissions: [] },
          });
        default:
          return Promise.resolve({ ok: true, data: {} });
      }
    },
  },
});

rememberSessionProjects(initialSessions);
const elements: Root[] = [];
function mount(preferences: SidebarPreferences) {
  const host = document.getElementById("root");
  if (!host) throw new Error("missing #root");
  const root = createRoot(host);
  elements.push(root);
  root.render(
    <I18nextProvider i18n={i18n}>
      <div className="app-shell" style={{ display: "flex" }}>
        <Sidebar
          onToggleSidebar={() => undefined}
          sidebarToggleShortcut="Mod+B"
          sidebarWidth={275}
          onWidthChange={() => undefined}
          onWidthCommit={() => undefined}
          onResizeCollapse={() => undefined}
        />
      </div>
    </I18nextProvider>,
  );
}

function seed(preferences: SidebarPreferences, sessions: FixtureSession[], running: string[] = []) {
  useAppStore.setState({
    ready: true,
    page: "chat",
    // The retained-tab order the user built: project B was opened last.
    workspace: { path: PROJECT_B, name: "session-order-b" },
    openProjects: [
      { path: PROJECT, name: "session-order" },
      { path: PROJECT_B, name: "session-order-b" },
    ],
    openProjectPaths: [PROJECT, PROJECT_B],
    activeProjectPath: PROJECT_B,
    sessions: sessions as never,
    sessionMeta: preferences.sessionMeta,
    projectMeta: preferences.projectMeta,
    projectSort: preferences.projectSort,
    sessionView: preferences.sessionView,
    runningSessions: Object.fromEntries(running.map((id) => [id, true])),
  });
}

async function until<T>(read: () => T | null | false, label: string): Promise<T> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(`Timed out: ${label}`);
}

function frame() {
  return new Promise(requestAnimationFrame).then(() => new Promise(requestAnimationFrame));
}

function row(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-sidebar-session-row="${id}"]`);
  if (!element) throw new Error(`missing row ${id}`);
  return element;
}

function projectRows(): string[] {
  const group = document.querySelector(`[data-sidebar-project-group="${PROJECT}"]`);
  if (!group) return [];
  return [...group.querySelectorAll<HTMLElement>("[data-sidebar-session-row]")].map(
    (node) => node.getAttribute("data-sidebar-session-row") ?? "",
  );
}

function pinnedRows(): string[] {
  const section = document.querySelector('[data-sidebar-session-section="pinned"]');
  if (!section) return [];
  return [...section.querySelectorAll<HTMLElement>("[data-sidebar-session-row]")].map(
    (node) => node.getAttribute("data-sidebar-session-row") ?? "",
  );
}

function temporaryRows(): string[] {
  const section = document.querySelector('[data-sidebar-session-section="temporary"]');
  if (!section) return [];
  return [...section.querySelectorAll<HTMLElement>("[data-sidebar-session-row]")].map(
    (node) => node.getAttribute("data-sidebar-session-row") ?? "",
  );
}

function projectGroupKeys(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      ".sidebar-session-groups [data-sidebar-project-group]",
    ),
  ].map((node) => node.getAttribute("data-sidebar-project-group") ?? "");
}

/** Clicks a project title the way a user opens a project group. */
function projectTitleClick(path: string): void {
  const title = document.querySelector<HTMLElement>(
    `[data-sidebar-project-group="${path}"] [data-action="toggle-project-collapse"]`,
  );
  if (!title) throw new Error(`missing project title ${path}`);
  title.click();
}

function sortMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".sidebar-sort-menu");
}

async function openSortMenu() {
  const trigger = document.querySelector<HTMLElement>('[data-action="session-sort"]');
  if (!trigger) throw new Error("missing sort trigger");
  trigger.click();
  await until(() => sortMenu(), "sort menu opens");
  return sortMenu()!;
}

async function chooseSort(scope: "session" | "project", mode: string) {
  const menu = await openSortMenu();
  const item = menu.querySelector<HTMLElement>(
    `[data-sort-scope="${scope}"][data-sort="${mode}"]`,
  );
  if (!item) throw new Error(`missing ${scope} sort item ${mode}`);
  item.click();
  await until(() => !sortMenu(), `sort menu closes after choosing ${scope}:${mode}`);
  await frame();
}

/** Drives the real HTML5 drag handlers the sidebar installs on its rows. */
async function drag(
  sourceId: string,
  targetId: string,
  position: "before" | "after",
) {
  const source = row(sourceId);
  const target = row(targetId);
  const dataTransfer = new DataTransfer();
  source.dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }),
  );
  await frame();
  const rect = target.getBoundingClientRect();
  const clientY = position === "before" ? rect.top + 2 : rect.bottom - 2;
  target.dispatchEvent(
    new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, clientY }),
  );
  await frame();
  target.dispatchEvent(
    new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientY }),
  );
  await frame();
  source.dispatchEvent(
    new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }),
  );
  await frame();
}

async function probe() {
  await ready;
  const checks: { label: string; ok: boolean; detail?: unknown }[] = [];
  const check = (label: string, ok: boolean, detail?: unknown) => {
    checks.push({ label, ok, detail });
  };

  localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify(storedRecord));
  const stored = loadSidebarPreferences();
  check(
    "a stored legacy recent sort loads as the created order",
    stored.sessionView.sort === "created",
    stored.sessionView,
  );

  seed(stored, initialSessions, ["alpha"]);
  mount(stored);
  await until(() => projectRows().length === 3, "project rows render");

  check(
    "the default order is newest created first",
    projectRows().join(",") === "gamma,beta,alpha",
    projectRows(),
  );
  check("the default render has no date re-bucketing of a busy row", projectRows()[2] === "alpha", projectRows());

  // The running session gains the newest activity: nothing may move.
  useAppStore.setState({
    sessions: initialSessions.map((item) =>
      item.id === "alpha" ? { ...item, updatedAt: new Date().toISOString() } : item,
    ) as never,
  });
  await frame();
  check(
    "activity on a running session does not move its row",
    projectRows().join(",") === "gamma,beta,alpha",
    projectRows(),
  );

  // Several rows gain activity at once.
  useAppStore.setState({
    sessions: useAppStore.getState().sessions.map((item, index) => ({
      ...item,
      updatedAt: new Date(startedAt + index * 1000).toISOString(),
    })),
  });
  await frame();
  check(
    "activity across several sessions leaves every row in place",
    projectRows().join(",") === "gamma,beta,alpha",
    projectRows(),
  );

  // A new session appears on top of the default order.
  const withNew = [...initialSessions, session({ id: "delta", createdAt: new Date().toISOString() })];
  useAppStore.setState({ sessions: withNew as never });
  await frame();
  check(
    "a new session opens on top of the created order",
    projectRows().join(",") === "delta,gamma,beta,alpha",
    projectRows(),
  );

  // Drag the running session above the newest one.
  check(
    "a running session row stays draggable for local reordering",
    row("alpha").getAttribute("draggable") === "true" &&
      Boolean((useAppStore.getState().runningSessions as Record<string, boolean>).alpha),
    {
      draggable: row("alpha").getAttribute("draggable"),
      running: useAppStore.getState().runningSessions,
    },
  );
  await drag("alpha", "delta", "before");
  check(
    "dragging a running session reorders it locally",
    projectRows().join(",") === "alpha,delta,gamma,beta",
    projectRows(),
  );

  const persisted = loadSidebarPreferences();
  check(
    "the dragged order persists as the manual sort",
    persisted.sessionView.sort === "manual",
    persisted.sessionView,
  );
  check(
    "the dragged order persists one rank per row",
    persisted.sessionMeta.alpha?.order === 0 &&
      persisted.sessionMeta.delta?.order === 1 &&
      persisted.sessionMeta.gamma?.order === 2 &&
      persisted.sessionMeta.beta?.order === 3,
    persisted.sessionMeta,
  );

  // Restart: unmount and rehydrate the store from the stored record only.
  elements.pop()?.unmount();
  document.getElementById("root")!.innerHTML = "";
  seed(loadSidebarPreferences(), useAppStore.getState().sessions, ["alpha"]);
  mount(loadSidebarPreferences());
  await until(() => projectRows().length === 4, "project rows render after restart");
  check(
    "the dragged order survives a restart",
    projectRows().join(",") === "alpha,delta,gamma,beta",
    projectRows(),
  );

  // A session created later is unranked: it lands on top, ranked rows keep order.
  useAppStore.setState({
    sessions: [
      ...(useAppStore.getState().sessions as unknown as FixtureSession[]),
      session({ id: "epsilon", createdAt: new Date().toISOString() }),
    ] as never,
  });
  await frame();
  check(
    "an unranked session opens on top without disturbing ranked rows",
    projectRows().join(",") === "epsilon,alpha,delta,gamma,beta",
    projectRows(),
  );

  // A cross-container drag is not a reorder: the row leaves the event alone so
  // the project group can still take it as a move.
  const crossDrop = new DataTransfer();
  row("temporary").dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: crossDrop }),
  );
  await frame();
  const crossTarget = row("alpha");
  const crossRect = crossTarget.getBoundingClientRect();
  const crossAccepted = crossTarget.dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: crossDrop,
      clientY: crossRect.top + 2,
    }),
  );
  await frame();
  const crossGroup = document.querySelector(`[data-sidebar-project-group="${PROJECT}"]`);
  const crossGroupClass = crossGroup?.className ?? null;
  const crossMoveOffered = Boolean(crossGroup?.classList.contains("is-drop-target"));
  row("temporary").dispatchEvent(
    new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: crossDrop }),
  );
  await frame();
  check(
    "a row from another list still offers the project move target",
    crossAccepted === false && crossMoveOffered,
    { accepted: crossAccepted, groupClass: crossGroupClass },
  );
  await drag("temporary", "alpha", "before");
  check(
    "a drop from another list never rewrites the project order",
    projectRows().join(",") === "epsilon,alpha,delta,gamma,beta" &&
      temporaryRows().join(",") === "temporary",
    { project: projectRows(), temporary: temporaryRows() },
  );

  // Pinning keeps the global boundary: the row leaves the project group.
  useAppStore.setState({
    sessionMeta: { ...useAppStore.getState().sessionMeta, beta: { pinned: true } },
  });
  await frame();
  check(
    "a pinned row leaves the project group for the pinned section",
    pinnedRows().join(",") === "beta" && !projectRows().includes("beta"),
    { pinned: pinnedRows(), project: projectRows() },
  );

  // Project groups: the order follows the tabs the user opened, and nothing a
  // conversation does may reorder them.
  check(
    "project groups follow the order the user opened them",
    projectGroupKeys().join(",") === `${PROJECT_B},${PROJECT}`,
    projectGroupKeys(),
  );

  useAppStore.setState({
    sessions: (useAppStore.getState().sessions as unknown as FixtureSession[]).map(
      (item, index) => ({
        ...item,
        updatedAt: new Date(startedAt + index * 1000 + MINUTE).toISOString(),
      }),
    ) as never,
  });
  await frame();
  check(
    "activity across several projects keeps every group in place",
    projectGroupKeys().join(",") === `${PROJECT_B},${PROJECT}`,
    projectGroupKeys(),
  );

  const menu = await openSortMenu();
  const menuText = menu.textContent ?? "";
  check(
    "the sort menu separates session and project order without a reset entry",
    Boolean(menu.querySelector('[data-sort-group="sessions"]')) &&
      Boolean(menu.querySelector('[data-sort-group="projects"]')) &&
      !/restore default|reset|default order/i.test(menuText) &&
      !menu.querySelector('[data-action*="reset"]'),
    { text: menuText.replace(/\s+/g, " ").trim() },
  );
  (document.querySelector('[data-action="session-sort"]') as HTMLElement).click();
  await until(() => !sortMenu(), "sort menu closes");

  const sessionSortBeforeProjectChoice = useAppStore.getState().sessionView.sort;
  await chooseSort("project", "name");
  check(
    "choosing a project sort reorders projects only",
    projectGroupKeys().join(",") === `${PROJECT},${PROJECT_B}` &&
      useAppStore.getState().projectSort === "name" &&
      useAppStore.getState().sessionView.sort === sessionSortBeforeProjectChoice,
    {
      groups: projectGroupKeys(),
      projectSort: useAppStore.getState().projectSort,
      sessionSort: useAppStore.getState().sessionView.sort,
    },
  );

  await chooseSort("session", "name");
  check(
    "changing the session sort leaves the project sort alone",
    useAppStore.getState().projectSort === "name" &&
      useAppStore.getState().sessionView.sort === "name" &&
      projectGroupKeys().join(",") === `${PROJECT},${PROJECT_B}`,
    {
      groups: projectGroupKeys(),
      projectSort: useAppStore.getState().projectSort,
      sessionSort: useAppStore.getState().sessionView.sort,
    },
  );

  await chooseSort("project", "recent");
  check(
    "the existing recent project mode returns to the visit order",
    useAppStore.getState().projectSort === "recent" &&
      projectGroupKeys().join(",") === `${PROJECT_B},${PROJECT}` &&
      useAppStore.getState().sessionView.sort === "name",
    {
      groups: projectGroupKeys(),
      projectSort: useAppStore.getState().projectSort,
      sessionSort: useAppStore.getState().sessionView.sort,
    },
  );

  // Opening a conversation is not an explicit project open: the project order
  // the user built by opening tabs must survive a cross-project row click.
  const orderSessions: FixtureSession[] = [
    session({ id: "alpha", projectPath: PROJECT, createdAt: iso(3 * MINUTE) }),
    session({ id: "beta", projectPath: PROJECT, createdAt: iso(2 * MINUTE) }),
    session({ id: "b-one", projectPath: PROJECT_B, createdAt: iso(6 * MINUTE) }),
    session({ id: "c-one", projectPath: PROJECT_C, createdAt: iso(7 * MINUTE) }),
  ];
  rememberSessionProjects(orderSessions);
  const orderFixture = (pinned: readonly string[] = ["beta"]): void => {
    useAppStore.setState({
      page: "chat",
      workspace: { path: PROJECT_B, name: "session-order-b" } as never,
      openProjects: [
        { path: PROJECT, name: "session-order" },
        { path: PROJECT_B, name: "session-order-b" },
      ] as never,
      openProjectPaths: [PROJECT, PROJECT_B],
      activeProjectPath: PROJECT_B,
      activeSessionId: undefined,
      sessions: orderSessions as never,
      sessionMeta: Object.fromEntries(pinned.map((id) => [id, { pinned: true }])),
      projectMeta: {},
      projectSort: "recent",
      sessionView: { sort: "created", archived: false },
      runningSessions: {},
    });
  };
  const currentProjectPath = (): string | undefined =>
    useAppStore.getState().activeProjectPath;
  const tabOrder = (): string => useAppStore.getState().openProjectPaths.join(",");

  orderFixture();
  await until(() => projectGroupKeys().length === 2, "the order fixture renders");
  const orderBaseline = projectGroupKeys().join(",");
  check(
    "the retained tabs decide the group order before any conversation opens",
    orderBaseline === `${PROJECT_B},${PROJECT}`,
    projectGroupKeys(),
  );

  row("alpha").click();
  await until(
    () =>
      currentProjectPath() === PROJECT &&
      useAppStore.getState().activeSessionId === "alpha",
    "a conversation row in another project activates that project",
  );
  check(
    "opening a conversation keeps the retained-tab order",
    tabOrder() === `${PROJECT},${PROJECT_B}`,
    useAppStore.getState().openProjectPaths,
  );
  check(
    "opening a conversation does not reorder project groups",
    projectGroupKeys().join(",") === orderBaseline,
    projectGroupKeys(),
  );
  check(
    "opening a conversation still makes its row the current one",
    Boolean(
      document.querySelector(
        '[data-sidebar-session-row="alpha"] [aria-current="page"]',
      ),
    ),
    row("alpha").outerHTML.slice(0, 240),
  );

  orderFixture();
  await until(() => pinnedRows().includes("beta"), "the pinned row renders");
  document
    .querySelector<HTMLElement>(
      '[data-sidebar-session-section="pinned"] [data-sidebar-session-row="beta"]',
    )!
    .click();
  await until(
    () =>
      currentProjectPath() === PROJECT &&
      useAppStore.getState().activeSessionId === "beta",
    "a pinned conversation in another project activates that project",
  );
  check(
    "a pinned conversation opened across projects keeps the retained-tab order",
    tabOrder() === `${PROJECT},${PROJECT_B}` &&
      projectGroupKeys().join(",") === orderBaseline,
    { tabs: tabOrder(), groups: projectGroupKeys() },
  );

  orderFixture(["beta", "c-one"]);
  await until(() => pinnedRows().includes("c-one"), "the closed project's pin renders");
  document
    .querySelector<HTMLElement>(
      '[data-sidebar-session-section="pinned"] [data-sidebar-session-row="c-one"]',
    )!
    .click();
  await until(
    () =>
      currentProjectPath() === PROJECT_C &&
      useAppStore.getState().activeSessionId === "c-one",
    "a conversation in a project without a tab activates that project",
  );
  check(
    "a project reached through its conversation is appended after the existing tabs",
    tabOrder() === `${PROJECT},${PROJECT_B},${PROJECT_C}`,
    useAppStore.getState().openProjectPaths,
  );
  check(
    "the existing tabs keep their relative order when one is appended",
    useAppStore.getState().openProjectPaths.slice(0, 2).join(",") ===
      `${PROJECT},${PROJECT_B}`,
    useAppStore.getState().openProjectPaths,
  );
  check(
    "the appended tab is the most recently opened group",
    projectGroupKeys().join(",") === `${PROJECT_C},${PROJECT_B},${PROJECT}`,
    projectGroupKeys(),
  );

  orderFixture();
  useAppStore.setState({
    projectSort: "manual",
    projectMeta: {
      [PROJECT]: { order: 2 },
      [PROJECT_B]: { order: 0 },
      [PROJECT_C]: { order: 1 },
    },
  });
  await frame();
  const manualBaseline = projectGroupKeys().join(",");
  check(
    "the manual project order follows the stored ranks",
    manualBaseline === `${PROJECT_B},${PROJECT}`,
    projectGroupKeys(),
  );
  row("alpha").click();
  await until(
    () =>
      currentProjectPath() === PROJECT &&
      useAppStore.getState().activeSessionId === "alpha",
    "a conversation opens under the manual project order",
  );
  check(
    "the manual project order and the chosen sorts ignore conversation activation",
    projectGroupKeys().join(",") === manualBaseline &&
      useAppStore.getState().projectSort === "manual" &&
      useAppStore.getState().sessionView.sort === "created",
    {
      groups: projectGroupKeys(),
      projectSort: useAppStore.getState().projectSort,
      sessionSort: useAppStore.getState().sessionView.sort,
    },
  );

  orderFixture();
  await until(
    () => currentProjectPath() === PROJECT_B,
    "the order fixture resets to the other project",
  );
  await frame();
  projectTitleClick(PROJECT);
  await until(
    () => currentProjectPath() === PROJECT,
    "an explicit project open activates that project",
  );
  check(
    "opening a project from its title still promotes its tab",
    tabOrder() === `${PROJECT_B},${PROJECT}`,
    useAppStore.getState().openProjectPaths,
  );
  return { ok: checks.every((entry) => entry.ok), checks };
}

globalThis.sidebarSessionOrderProbe = probe;
