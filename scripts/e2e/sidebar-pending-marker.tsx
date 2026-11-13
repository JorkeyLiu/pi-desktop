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
  var sidebarPendingMarkerIdleProbe: () => Promise<unknown>;
  var sidebarPendingMarkerPersistenceProbe: (markedId: string) => Promise<unknown>;
  var sidebarPendingMarkerFocusMark: (id: string) => boolean;
  var sidebarPendingMarkerActivationProbe: () => Promise<unknown>;
  var sidebarPendingMarkerReducedMotionProbe: () => Promise<unknown>;
}

const i18n = createInstance();
const ready = i18n.init({ lng: "en", resources: { en: { translation: en } }, initImmediate: false });

const PROJECT = "/fixture/pending-marker";
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

/** Four idle rows: the open conversation plus three plain ones. */
const initialSessions: FixtureSession[] = [
  session({ id: "open", createdAt: iso(4 * MINUTE) }),
  session({ id: "alpha", createdAt: iso(3 * MINUTE) }),
  session({ id: "beta", createdAt: iso(2 * MINUTE) }),
  session({ id: "gamma", createdAt: iso(MINUTE) }),
];

/** Host-boundary stub: only the preload bridge is replaced. */
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
            data: { workspace: { path: String(args[0]), name: "pending-marker", branch: "main" } },
          });
        case "pi-desktop/session/get":
          return Promise.resolve({
            ok: true,
            data: {
              session: {
                id: String((args[0] as { id?: string } | undefined)?.id ?? ""),
                title: "fixture",
                projectPath: PROJECT,
                messageCount: 1,
                mode: "agent",
                thinkingLevel: "off",
                permissionMode: "inherit",
                createdAt: iso(MINUTE),
                updatedAt: iso(MINUTE),
                messages: [],
              },
            },
          });
        case "pi-desktop/plans/pending":
          return Promise.resolve({ ok: true, data: { plans: [] } });
        case "pi-desktop/agent/pendingInteractive":
          return Promise.resolve({ ok: true, data: { asks: [], questions: [], permissions: [] } });
        default:
          return Promise.resolve({ ok: true, data: {} });
      }
    },
  },
});

const elements: Root[] = [];
function mount() {
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

function seed(preferences: SidebarPreferences, running: string[] = []) {
  useAppStore.setState({
    ready: true,
    page: "chat",
    workspace: { path: PROJECT, name: "pending-marker" },
    openProjects: [{ path: PROJECT, name: "pending-marker" }],
    openProjectPaths: [PROJECT],
    activeProjectPath: PROJECT,
    activeSessionId: "open",
    sessions: initialSessions as never,
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

function mark(id: string): HTMLElement {
  const element = row(id).querySelector<HTMLElement>(".thread-item-status");
  if (!element) throw new Error(`missing status mark on ${id}`);
  return element;
}

function status(id: string) {
  return mark(id).getAttribute("data-session-status");
}

function pseudo(id: string, part: "::before" | "::after") {
  const element = mark(id);
  const style = getComputedStyle(element, part);
  return {
    backgroundColor: style.backgroundColor,
    borderTopWidth: style.borderTopWidth,
    boxShadow: style.boxShadow,
    animationName: style.animationName,
    animationIterationCount: style.animationIterationCount,
  };
}

function storedMark(id: string) {
  return loadSidebarPreferences().sessionMeta[id]?.pending;
}

async function idleProbe() {
  await ready;
  const checks: { label: string; ok: boolean; detail?: unknown }[] = [];
  const check = (label: string, ok: boolean, detail?: unknown) => {
    checks.push({ label, ok, detail });
  };

  seed(loadSidebarPreferences());
  mount();
  await until(() => document.querySelectorAll("[data-sidebar-session-row]").length === 4, "rows render");
  await frame();

  // 1. Every idle row carries the hollow mark, including the selected one.
  const idleMarks = ["open", "alpha", "beta", "gamma"].map((id) => status(id));
  check("every idle row shows a mark, selected row included", idleMarks.every((value) => value === "idle"), idleMarks);
  check("the open row stays visually selected", row("open").classList.contains("active"));

  const alphaMark = mark("alpha");
  const rect = alphaMark.getBoundingClientRect();
  check(
    "the idle mark is a real button with a localized name and pressed state",
    alphaMark.tagName === "BUTTON" &&
      alphaMark.getAttribute("aria-pressed") === "false" &&
      Boolean(alphaMark.getAttribute("aria-label")) &&
      alphaMark.getAttribute("draggable") === "false",
    {
      tag: alphaMark.tagName,
      pressed: alphaMark.getAttribute("aria-pressed"),
      label: alphaMark.getAttribute("aria-label"),
    },
  );
  check("the idle mark has a usable hit target", rect.width >= 20 && rect.height >= 24, rect);

  const idlePseudo = pseudo("alpha", "::before");
  check(
    "the idle mark is a hollow ring with no motion",
    idlePseudo.backgroundColor === "rgba(0, 0, 0, 0)" &&
      parseFloat(idlePseudo.borderTopWidth) > 0 &&
      idlePseudo.animationName === "none",
    idlePseudo,
  );

  // 2. Clicking the idle mark marks the row without selecting it.
  (mark("alpha") as HTMLElement).click();
  await frame();
  const selectionAfterClick = useAppStore.getState().activeSessionId;
  check(
    "clicking a plain idle mark never selects the session",
    selectionAfterClick === "open" && !row("alpha").classList.contains("active"),
    selectionAfterClick,
  );
  check(
    "the first click fills the manual mark",
    status("alpha") === "pending" &&
      mark("alpha").getAttribute("aria-pressed") === "true" &&
      storedMark("alpha") === true,
    { status: status("alpha"), stored: storedMark("alpha") },
  );
  const pendingPseudo = pseudo("alpha", "::before");
  check(
    "the manual mark is a static orange fill: no halo, no animation",
    pendingPseudo.backgroundColor !== "rgba(0, 0, 0, 0)" &&
      parseFloat(pendingPseudo.borderTopWidth) === 0 &&
      pendingPseudo.animationName === "none" &&
      pendingPseudo.boxShadow === "none",
    pendingPseudo,
  );

  // 3. A second click clears it.
  (mark("alpha") as HTMLElement).click();
  await frame();
  check(
    "a second click clears the manual mark",
    status("alpha") === "idle" && storedMark("alpha") === false,
    { status: status("alpha"), stored: storedMark("alpha") },
  );

  // 4. Mark beta for the remaining phases.
  (mark("beta") as HTMLElement).click();
  await frame();
  check("beta is marked before the running phase", status("beta") === "pending" && storedMark("beta") === true);

  // 5. Running overrides the manual visual and keeps the stored mark.
  useAppStore.setState({ runningSessions: { beta: true } });
  await frame();
  check(
    "running outranks the manual mark and is not a toggle",
    status("beta") === "running" &&
      mark("beta").tagName === "SPAN" &&
      mark("beta").getAttribute("aria-label") === "Working" &&
      storedMark("beta") === true,
    { status: status("beta"), tag: mark("beta").tagName },
  );
  const runningHalo = pseudo("beta", "::after");
  const runningDot = pseudo("beta", "::before");
  check(
    "running shows a filled dot with an externally visible animated halo",
    runningDot.backgroundColor !== "rgba(0, 0, 0, 0)" &&
      runningHalo.boxShadow !== "none" &&
      runningHalo.animationName === "sidebar-status-halo" &&
      runningHalo.animationIterationCount === "infinite",
    { runningDot, runningHalo },
  );
  (mark("beta") as HTMLElement).click();
  await frame();
  check(
    "a running mark cannot be toggled",
    status("beta") === "running" && storedMark("beta") === true,
    { status: status("beta"), stored: storedMark("beta") },
  );

  // 6. Ending the run returns the manual mark the user set.
  useAppStore.setState({ runningSessions: {} });
  await frame();
  check(
    "the manual mark survives the end of a run",
    status("beta") === "pending" && storedMark("beta") === true,
    { status: status("beta"), stored: storedMark("beta") },
  );

  // 7. An unread outcome outranks the manual mark and refuses the toggle.
  (mark("gamma") as HTMLElement).click();
  await frame();
  useAppStore.setState({ sessionOutcomes: { gamma: "completed" } });
  await frame();
  check(
    "an unread outcome outranks the manual mark",
    status("gamma") === "completed" && mark("gamma").tagName === "SPAN",
    { status: status("gamma") },
  );
  (mark("gamma") as HTMLElement).click();
  await frame();
  check(
    "an outcome glyph is never replaced by a click",
    status("gamma") === "completed" && storedMark("gamma") === true,
    { status: status("gamma"), stored: storedMark("gamma") },
  );
  useAppStore.setState({ sessionOutcomes: {} });
  await frame();
  check(
    "clearing the outcome reveals the manual mark again",
    status("gamma") === "pending" && storedMark("gamma") === true,
    { status: status("gamma"), stored: storedMark("gamma") },
  );

  // 8. A pending permission outranks both.
  useAppStore.setState({
    pendingPermissions: {
      gamma: [
        {
          id: "permission-1",
          sessionId: "gamma",
          turnId: "turn-1",
          toolName: "write",
          createdAt: iso(0),
          args: {},
        },
      ],
    } as never,
  });
  await frame();
  check(
    "a pending permission outranks the manual mark",
    status("gamma") === "permission" && mark("gamma").tagName === "SPAN",
    { status: status("gamma") },
  );
  useAppStore.setState({ pendingPermissions: {} });

  // 9. A drag cannot start from the toggle.
  const dragStart = new DragEvent("dragstart", {
    bubbles: true,
    cancelable: true,
    dataTransfer: new DataTransfer(),
  });
  const dragAccepted = mark("alpha").dispatchEvent(dragStart);
  await frame();
  check(
    "dragging from the toggle never starts a row drag",
    dragAccepted === false && row("alpha").getAttribute("draggable") === "true",
    { dragAccepted, draggable: row("alpha").getAttribute("draggable") },
  );

  const stored = loadSidebarPreferences();
  check(
    "the manual mark is written to the sidebar preference record",
    stored.sessionMeta.beta?.pending === true && stored.sessionMeta.alpha?.pending === false,
    stored.sessionMeta,
  );
  return { checks, markedId: "beta" };
}

async function persistenceProbe(markedId: string) {
  const checks: { label: string; ok: boolean; detail?: unknown }[] = [];
  const check = (label: string, ok: boolean, detail?: unknown) => {
    checks.push({ label, ok, detail });
  };
  check(
    "a fresh renderer rehydrates the manual mark from preferences",
    useAppStore.getState().sessionMeta[markedId]?.pending === true,
    useAppStore.getState().sessionMeta,
  );
  check(
    "the stored preference record still holds the mark",
    loadSidebarPreferences().sessionMeta[markedId]?.pending === true,
    loadSidebarPreferences().sessionMeta,
  );
  const preferences = loadSidebarPreferences();
  seed(preferences);
  mount();
  await until(() => document.querySelectorAll("[data-sidebar-session-row]").length === 4, "rows render after relaunch");
  await frame();
  const persisted = mark(markedId);
  check(
    "the relaunched sidebar paints the marked row as pending",
    status(markedId) === "pending" &&
      persisted.tagName === "BUTTON" &&
      persisted.getAttribute("aria-pressed") === "true",
    { status: status(markedId), pressed: persisted.getAttribute("aria-pressed") },
  );
  // Only what the user marked comes back; an unmarked row stays hollow.
  check(
    "an unmarked row comes back hollow",
    status("alpha") === "idle" && storedMark("alpha") === false,
    { status: status("alpha"), stored: storedMark("alpha") },
  );
  return { checks };
}

function focusMark(id: string) {
  const element = mark(id);
  element.focus();
  return document.activeElement === element;
}

async function activationProbe() {
  const checks: { label: string; ok: boolean; detail?: unknown }[] = [];
  const check = (label: string, ok: boolean, detail?: unknown) => {
    checks.push({ label, ok, detail });
  };
  await frame();
  check(
    "Enter on the focused mark toggles it",
    status("beta") === "idle" && storedMark("beta") === false,
    { status: status("beta"), stored: storedMark("beta") },
  );
  check(
    "keyboard activation never selects the session",
    useAppStore.getState().activeSessionId === "open" && !row("beta").classList.contains("active"),
    useAppStore.getState().activeSessionId,
  );
  check(
    "the mark keeps its visible focus ring after activation",
    document.activeElement === mark("beta"),
    { tag: (document.activeElement as HTMLElement | null)?.tagName },
  );
  return { checks };
}

async function reducedMotionProbe() {
  const checks: { label: string; ok: boolean; detail?: unknown }[] = [];
  const check = (label: string, ok: boolean, detail?: unknown) => {
    checks.push({ label, ok, detail });
  };
  // Re-mark beta through the store action, then run it, so the manual mark and
  // the run coexist under reduced motion.
  useAppStore.getState().toggleSessionPending("beta");
  seed(loadSidebarPreferences(), ["beta"]);
  mount();
  await until(() => document.querySelectorAll("[data-sidebar-session-row]").length === 4, "rows render under reduced motion");
  await frame();
  const halo = pseudo("beta", "::after");
  const dot = pseudo("beta", "::before");
  check(
    "reduced motion disables the running halo animation",
    halo.animationName === "none",
    halo,
  );
  check(
    "reduced motion keeps a static halo so running stays distinct",
    halo.boxShadow !== "none" && dot.backgroundColor !== "rgba(0, 0, 0, 0)",
    { halo, dot },
  );
  check(
    "the manual mark stays stored while running is displayed",
    storedMark("beta") === true,
    storedMark("beta"),
  );
  return { checks };
}

globalThis.sidebarPendingMarkerIdleProbe = idleProbe;
globalThis.sidebarPendingMarkerPersistenceProbe = persistenceProbe;
globalThis.sidebarPendingMarkerFocusMark = focusMark;
globalThis.sidebarPendingMarkerActivationProbe = activationProbe;
globalThis.sidebarPendingMarkerReducedMotionProbe = reducedMotionProbe;
