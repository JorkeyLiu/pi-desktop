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
  var sidebarPendingMarkerInformationalProbe: () => Promise<unknown>;
  var sidebarPendingMarkerPersistenceProbe: (markedId: string) => Promise<unknown>;
  var sidebarPendingMarkerFocusAnchor: () => boolean;
  var sidebarPendingMarkerKeyboardFocusProbe: () => {
    checks: unknown[];
    focused: boolean;
  };
  var sidebarPendingMarkerActivationProbe: (
    expected: "pending" | "idle",
    key: string,
  ) => Promise<unknown>;
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
                // A selected conversation needs one real message, otherwise
                // the empty-read guard refuses to commit the selection.
                messages: [
                  {
                    id: `${String((args[0] as { id?: string } | undefined)?.id ?? "")}-m1`,
                    role: "user",
                    content: "fixture",
                    createdAt: iso(MINUTE),
                    updatedAt: iso(MINUTE),
                  },
                ],
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
  check(
    "the idle mark is at least 24x24, the WCAG pointer target minimum",
    rect.width >= 24 && rect.height >= 24,
    { width: rect.width, height: rect.height },
  );

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
  // Selecting the marked conversation must keep the mark on its own row; the
  // row background is the only thing selection paints.
  const betaMain = row("beta").querySelector<HTMLButtonElement>(".thread-item-main");
  if (!betaMain) throw new Error("missing beta row button");
  betaMain.click();
  await until(() => useAppStore.getState().activeSessionId === "beta", "beta row selects");
  await frame();
  check(
    "selecting a marked conversation keeps the manual mark visible",
    status("beta") === "pending" &&
      mark("beta").getAttribute("aria-pressed") === "true" &&
      storedMark("beta") === true &&
      row("beta").classList.contains("active"),
    { status: status("beta"), activeSessionId: useAppStore.getState().activeSessionId },
  );

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
    "a running mark never toggles the stored manual flag",
    status("beta") === "running" &&
      storedMark("beta") === true &&
      useAppStore.getState().activeSessionId === "beta",
    { status: status("beta"), stored: storedMark("beta") },
  );
  // The action boundary repeats the row rule, so a direct caller cannot flip
  // the flag under live work or invent metadata for an unknown session.
  useAppStore.getState().toggleSessionPending("beta");
  useAppStore.getState().toggleSessionPending("ghost");
  await frame();
  check(
    "a direct toggle under a run or for an unknown session is refused",
    storedMark("beta") === true &&
      loadSidebarPreferences().sessionMeta.ghost === undefined,
    { stored: storedMark("beta"), meta: loadSidebarPreferences().sessionMeta },
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
  await until(() => useAppStore.getState().activeSessionId === "gamma", "gamma selects from its outcome mark");
  // Selecting the row acknowledges its own unread outcome, exactly as a click
  // on the title does, and the stored manual flag is never flipped.
  await until(() => status("gamma") === "pending", "outcome acknowledgement clears the mark");
  await frame();
  check(
    "an outcome mark selects the row without toggling the manual mark",
    storedMark("gamma") === true &&
      row("gamma").classList.contains("active") &&
      mark("gamma").getAttribute("aria-pressed") === "true",
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

/**
 * An informational mark is not a control: a click reaches the row exactly as a
 * click on the title does, so the row still selects, while the stored manual
 * flag on any row is never flipped. Runs on the sidebar mounted by the idle
 * phase, with gamma selected from the outcome acknowledgement.
 */
async function informationalProbe() {
  const checks: { label: string; ok: boolean; detail?: unknown }[] = [];
  const check = (label: string, ok: boolean, detail?: unknown) => {
    checks.push({ label, ok, detail });
  };

  useAppStore.setState({ runningSessions: { alpha: true } });
  await frame();
  check("the running mark is informational", status("alpha") === "running" && mark("alpha").tagName === "SPAN");
  (mark("alpha") as HTMLElement).click();
  await until(() => useAppStore.getState().activeSessionId === "alpha", "a running mark selects its row");
  await frame();
  check(
    "clicking a running mark selects the row and leaves the manual flag alone",
    useAppStore.getState().activeSessionId === "alpha" &&
      row("alpha").classList.contains("active") &&
      storedMark("alpha") === false &&
      storedMark("beta") === true,
    { active: useAppStore.getState().activeSessionId, meta: loadSidebarPreferences().sessionMeta },
  );

  useAppStore.setState({ runningSessions: {} });
  seed(loadSidebarPreferences());
  await frame();
  check("clearing the run returns the row to idle", status("alpha") === "idle");

  useAppStore.setState({
    pendingPermissions: {
      alpha: [
        {
          id: "permission-2",
          sessionId: "alpha",
          turnId: "turn-2",
          toolName: "write",
          createdAt: iso(0),
          args: {},
        },
      ],
    } as never,
  });
  await frame();
  check("the permission mark is informational", status("alpha") === "permission" && mark("alpha").tagName === "SPAN");
  (mark("alpha") as HTMLElement).click();
  await until(() => useAppStore.getState().activeSessionId === "alpha", "a permission mark selects its row");
  await frame();
  check(
    "clicking a permission mark selects the row and leaves the manual flag alone",
    useAppStore.getState().activeSessionId === "alpha" &&
      storedMark("alpha") === false &&
      storedMark("beta") === true,
    { active: useAppStore.getState().activeSessionId, meta: loadSidebarPreferences().sessionMeta },
  );

  useAppStore.setState({ pendingPermissions: {} });
  useAppStore.setState({ sessionOutcomes: { beta: "failed" } });
  await frame();
  check("the outcome mark is informational", status("beta") === "failed" && mark("beta").tagName === "SPAN");
  (mark("beta") as HTMLElement).click();
  await until(() => useAppStore.getState().activeSessionId === "beta", "an outcome mark selects its row");
  await frame();
  check(
    "clicking an unread outcome selects the row and keeps the manual flag stored",
    useAppStore.getState().activeSessionId === "beta" && storedMark("beta") === true,
    { active: useAppStore.getState().activeSessionId, stored: storedMark("beta") },
  );
  // The row click acknowledges the outcome it selected, exactly as before.
  await until(() => status("beta") === "pending", "outcome acknowledgement reveals the manual mark");
  await frame();
  check(
    "acknowledging that outcome brings back the stored manual mark",
    status("beta") === "pending" && mark("beta").getAttribute("aria-pressed") === "true",
    { status: status("beta") },
  );
  useAppStore.setState({ sessionOutcomes: {} });
  return { checks };
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

function focusEvidence(id: string) {
  const element = mark(id);
  const style = getComputedStyle(element);
  return {
    focused: document.activeElement === element,
    activeTag: (document.activeElement as HTMLElement | null)?.tagName ?? null,
    activeAction: document.activeElement?.getAttribute("data-action") ?? null,
    activeStatus: document.activeElement?.getAttribute("data-session-status") ?? null,
    activeClass: (document.activeElement as HTMLElement | null)?.className ?? null,
    activeRow: document.activeElement?.closest("[data-sidebar-session-row]")?.getAttribute("data-sidebar-session-row") ?? null,
    activeText: (document.activeElement as HTMLElement | null)?.textContent?.slice(0, 40) ?? null,
    hasFocus: document.hasFocus(),
    outlineWidth: style.outlineWidth,
    outlineStyle: style.outlineStyle,
    outlineColor: style.outlineColor,
  };
}

/**
 * Focus the last control of the row before beta, so the runner only has to
 * press a real Tab key: the harness never focuses the mark directly.
 */
function focusAnchor() {
  // The element immediately before the mark in real tab order, whatever the
  // row grouping order is, so one Tab key is the only way to reach the mark.
  const target = mark("beta");
  const focusables = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null && !element.hasAttribute("disabled"));
  const index = focusables.indexOf(target);
  if (index <= 0) throw new Error("the mark is not in the tab order");
  focusables[index - 1].focus();
  return document.activeElement === focusables[index - 1];
}

function keyboardFocusProbe() {
  const evidence = focusEvidence("beta");
  const checks: { label: string; ok: boolean; detail?: unknown }[] = [];
  const check = (label: string, ok: boolean, detail?: unknown) => {
    checks.push({ label, ok, detail });
  };
  check("a real Tab key reaches the mark from the previous row", evidence.focused, evidence);
  check(
    "keyboard focus paints the focus-visible outline",
    evidence.focused &&
      evidence.outlineStyle !== "none" &&
      parseFloat(evidence.outlineWidth) > 0,
    evidence,
  );
  return { checks, focused: evidence.focused };
}

async function activationProbe(expected: "pending" | "idle", key: string) {
  const checks: { label: string; ok: boolean; detail?: unknown }[] = [];
  const check = (label: string, ok: boolean, detail?: unknown) => {
    checks.push({ label, ok, detail });
  };
  await frame();
  check(
    `${key} on the focused mark toggles the manual flag`,
    status("beta") === expected && storedMark("beta") === (expected === "pending"),
    { status: status("beta"), stored: storedMark("beta"), expected },
  );
  check(
    "keyboard activation never selects the session",
    useAppStore.getState().activeSessionId === "open" && !row("beta").classList.contains("active"),
    useAppStore.getState().activeSessionId,
  );
  const evidence = focusEvidence("beta");
  check(
    "the control keeps its visible focus outline after activation",
    evidence.focused && evidence.outlineStyle !== "none" && parseFloat(evidence.outlineWidth) > 0,
    evidence,
  );
  return { checks };
}

async function reducedMotionProbe() {
  const checks: { label: string; ok: boolean; detail?: unknown }[] = [];
  const check = (label: string, ok: boolean, detail?: unknown) => {
    checks.push({ label, ok, detail });
  };
  // Ensure beta is marked through the store action, then run it, so the manual
  // mark and the run coexist under reduced motion. The action needs a mounted
  // session list, so seed one first.
  seed(loadSidebarPreferences());
  if (storedMark("beta") !== true) useAppStore.getState().toggleSessionPending("beta");
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
globalThis.sidebarPendingMarkerInformationalProbe = informationalProbe;
globalThis.sidebarPendingMarkerPersistenceProbe = persistenceProbe;
globalThis.sidebarPendingMarkerFocusAnchor = focusAnchor;
globalThis.sidebarPendingMarkerKeyboardFocusProbe = keyboardFocusProbe;
globalThis.sidebarPendingMarkerActivationProbe = activationProbe;
globalThis.sidebarPendingMarkerReducedMotionProbe = reducedMotionProbe;
