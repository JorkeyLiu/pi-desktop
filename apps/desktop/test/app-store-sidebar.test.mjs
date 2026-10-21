import { readStoreSource, readStoreModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const storeSource = await readStoreSource();
const projectSliceSource = await readStoreModule("slices/project-slice.ts");
const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const hoverSource = await readFile(
  new URL("../src/features/sessions/SessionHoverCard.tsx", import.meta.url),
  "utf8",
);
const topbarSource = await readFile(
  new URL("../src/components/ConversationTopbar.tsx", import.meta.url),
  "utf8",
);

test("opening an archived project restores its sidebar visibility", () => {
  const activationBlock = projectSliceSource.match(
    /activateProject: async[\s\S]*?openProjectPath:/,
  )?.[0] ?? "";
  const setProjectIndex = activationBlock.indexOf(
    "await api.setProject(requestedPath)",
  );
  const navigationGuardIndex = activationBlock.indexOf(
    "if (!runtime.navigationIntentIsCurrent(intent)) return null;",
    setProjectIndex,
  );
  const restoreIndex = activationBlock.indexOf(
    "get().restoreProject(workspace.path)",
  );
  const restoreBlock = projectSliceSource.match(
    /restoreProject: \(path\) => \{[\s\S]*?persistCurrentSidebar\(get\);\s*\},/,
  )?.[0] ?? "";

  assert.ok(setProjectIndex >= 0, "activation must set the host project");
  assert.ok(
    navigationGuardIndex > setProjectIndex,
    "stale activation must be ignored",
  );
  assert.ok(
    restoreIndex > navigationGuardIndex,
    "only a successful activation restores visibility",
  );
  assert.match(
    activationBlock,
    /if \(projectIsArchived\(workspace\.path, get\(\)\.projectMeta\)\)\s*\{\s*get\(\)\.restoreProject\(workspace\.path\);\s*\}/,
  );
  assert.match(restoreBlock, /archived:\s*false/);
});

test("project activation separates visible transcript state from background run state", () => {
  const activationBlock = storeSource.match(
    /activateProject: async[\s\S]*?openProjectPath:/,
  )?.[0] ?? "";
  assert.match(activationBlock, /switchesVisibleProject[\s\S]*activeSessionId: undefined/);
  assert.match(activationBlock, /switchesVisibleProject[\s\S]*messages: \[\]/);
  assert.match(activationBlock, /switchesVisibleProject[\s\S]*isRunning: false/);
  assert.doesNotMatch(
    activationBlock,
    /runningSessions:\s*\{\}/,
  );
  assert.doesNotMatch(activationBlock, /pendingPermissions:\s*\{\}/);
});

test("sidebar hover refreshes the active project branch without activating a project", () => {
  const refreshBlock = projectSliceSource.match(
    /refreshProject: async[\s\S]*?\n    openProjectPath:/,
  )?.[0] ?? "";
  assert.match(refreshBlock, /api\.getProject\(\)/);
  assert.match(refreshBlock, /normalizeProjectPath\(workspace\.path\) !== requestedKey/);
  assert.match(refreshBlock, /normalizeProjectPath\(state\.activeProjectPath\) !== requestedKey/);
  assert.match(refreshBlock, /openProjects: upsertWorkspace\(state\.openProjects, workspace\)/);

  assert.match(hoverSource, /refreshProject\(session\.projectPath \?\? ""\)/);
  assert.match(hoverSource, /current && target\.isConnected && workspace/);
  assert.match(hoverSource, /setProject\(\{ space: workspace\.name, branch: workspace\.branch \}\)/);
  assert.match(sidebarSource, /branch: entry\?\.branch/);
  assert.match(sidebarSource, /for \(const entry of projectEntries\) map\.set\(entry\.key, entry\)/);
  assert.match(sidebarSource, /projectEntriesByPath\.get\(normalizedProjectPath \?\? ""\)/);
});

test("closed projects are not recreated from historical sidebar sessions", () => {
  assert.doesNotMatch(sidebarSource, /add\(session\.projectPath\)/);
  assert.match(sidebarSource, /const entry = byPath\.get\(sessionPath\)/);
  assert.match(sidebarSource, /if \(entry\) entry\.sessions\.push\(session\)/);
});

test("project new-session creation uses one store-owned navigation transaction", () => {
  assert.match(
    sidebarSource,
    /const createProjectSession[\s\S]*createSession\(\{ projectPath: path \}\)/,
  );
  assert.doesNotMatch(
    sidebarSource,
    /const createProjectSession[\s\S]*selectProject\(path\)/,
  );
});

test("durable empty sessions render and title heuristics do not filter them", () => {
  assert.doesNotMatch(
    sidebarSource,
    /candidates\.filter\(\(session\) => !isDefaultSessionTitle\(session\.title\)\)/,
  );
  assert.match(storeSource, /latestSessionInScope/);
  assert.match(storeSource, /sessionIsReusableEmpty/);
  assert.match(storeSource, /pendingNewSessionRequests/);
  assert.doesNotMatch(sidebarSource, /keptEmptyScopes/);
});

test("project title toggles its conversation group without forcing it open", () => {
  const projectTitleBlock = sidebarSource.match(
    /className="sidebar-session-group-title project-toggle"[\s\S]*?<IconFolder/,
  )?.[0] ?? "";
  assert.match(projectTitleBlock, /aria-expanded=\{!collapsedProject\}/);
  assert.match(projectTitleBlock, /data-action="toggle-project-collapse"/);
  assert.match(projectTitleBlock, /sidebar-disclosure-icon/);
  assert.match(projectTitleBlock, /setCollapsed\(entry\.path, !collapsedProject\)/);
  assert.doesNotMatch(projectTitleBlock, /setCollapsed\(entry\.path, false\)/);
  assert.doesNotMatch(sidebarSource, /className="project-collapse-toggle"/);
});

test("collapsing a project resets its expanded session history", () => {
  const collapseBlock = sidebarSource.match(
    /const setCollapsed = \(path: string, value: boolean\) => \{[\s\S]*?\n  \};/,
  )?.[0] ?? "";

  assert.match(
    collapseBlock,
    /if \(value\) \{[\s\S]*?setExpandedProjectSessions\([\s\S]*?updateProjectSessionExpansion\(previous, normalized, false\)/,
  );
  const loadMoreBlock = sidebarSource.match(
    /const expandProjectSessions = \(projectKey: string\) => \{[\s\S]*?\n  \};/,
  )?.[0] ?? "";
  assert.match(
    loadMoreBlock,
    /updateProjectSessionExpansion\(previous, projectKey, true\)/,
  );
});

test("global search stays on the conversation topbar, not the sidebar header", () => {
  assert.doesNotMatch(sidebarSource, /onOpenSearch|IconSearch|nav\.search/);
  assert.doesNotMatch(sidebarSource, /sidebar-session-search|toggleSearch/);
  assert.match(topbarSource, /onOpenSearch/);
  assert.match(topbarSource, /<IconSearch/);
  assert.match(topbarSource, /ariaLabel=\{t\("nav\.search"\)\}/);
});

test("project rows expose press-and-move title drag and keyboard reorder behavior", () => {
  assert.doesNotMatch(sidebarSource, /sidebar-project-drag-handle/);
  assert.doesNotMatch(sidebarSource, /IconGripVertical/);
  assert.doesNotMatch(sidebarSource, /PROJECT_DRAG_MIME/);
  assert.doesNotMatch(sidebarSource, /PROJECT_REORDER_LONG_PRESS_MS/);
  assert.match(sidebarSource, /projectReorderShouldArm/);
  assert.match(sidebarSource, /beginProjectReorderPress\(event, entry\.key\)/);
  assert.match(sidebarSource, /onKeyDown=\{\(event\) => moveProjectWithKeyboard/);
  assert.match(sidebarSource, /aria-grabbed=\{draggingProjectKey === entry.key\}/);
  assert.match(sidebarSource, /className="sidebar-session-group-title project-toggle"/);
  assert.match(sidebarSource, /is-drop-before/);
  assert.match(storeSource, /reorderProjects: \(paths\) =>/);
  assert.match(storeSource, /projectSort: "manual"/);
  assert.match(storeSource, /persistCurrentSidebar\(get\)/);
});

test("a session drag persists a manual order instead of a transient one", () => {
  const reorderBlock =
    projectSliceSource.match(/reorderSessions: \(orderedIds\) => \{[\s\S]*?persistCurrentSidebar\(get\);\s*\},/)?.[0] ??
    "";
  assert.ok(reorderBlock, "the store must own session reordering");
  assert.match(reorderBlock, /sessionOrderRanks\(orderedIds\)/, "ranks come from one helper");
  assert.match(reorderBlock, /order: ranks\[id\]/);
  assert.match(reorderBlock, /sort: "manual"/, "a dragged order is the manual sort");
  assert.match(
    reorderBlock,
    /persistCurrentSidebar\(get\)/,
    "the order must survive a renderer restart",
  );
  assert.match(
    projectSliceSource,
    /sessionMeta: withoutSessionOrder\(current\.sessionMeta, id\)/,
    "a session that changes project starts unranked in its new group",
  );
});

test("session rows reorder inside their own list without leaving the sort menu", () => {
  assert.match(
    sidebarSource,
    /onDragOver=\{\(event\) => onSessionRowDragOver\(event, session\)\}/,
  );
  assert.match(sidebarSource, /onDrop=\{\(event\) => onSessionRowDrop\(event, session\)\}/);
  assert.match(sidebarSource, /canReorderSidebarSessions\(source, target, sessionMeta\)/);
  assert.match(sidebarSource, /reorderSessions\(next\)/);
  assert.match(
    sidebarSource,
    /draggable=\{!isRemoteSession\(session\)\}/,
    "a running session may still be reordered locally",
  );
  assert.doesNotMatch(
    sidebarSource,
    /draggable=\{!running && !isRemoteSession\(session\)\}/,
    "running must not disable local reordering",
  );
  assert.match(
    projectSliceSource,
    /if \(state\.runningSessions\[id\]\) return false;/,
    "cross-project moves keep the stop-first rule",
  );
  const sortModes = sidebarSource.match(/\(\["created", "oldest", "name"\] as const\)/);
  assert.ok(sortModes, "the session sort menu offers only stable orders");
  assert.match(sidebarSource, /nav\.sortManual/, "a manual order is shown as the current state");
  assert.doesNotMatch(sidebarSource, /nav\.sortRecent/, "session activity recency is gone");
});

test("session and project sort are separate menu groups with separate setters", () => {
  const menuSource = sidebarSource.slice(sidebarSource.indexOf("if (sortOpen) {"));
  const [sessionGroup = "", projectGroup = ""] = menuSource.split('data-sort-group="projects"');

  assert.match(
    sessionGroup,
    /data-sort-group="sessions"/,
    "the menu labels the session group",
  );
  assert.match(sessionGroup, /data-sort-scope="session"/);
  assert.match(
    sessionGroup,
    /onClick=\{\(\) => applySessionSort\(value\)\}/,
    "a session sort choice only changes the session sort",
  );
  assert.doesNotMatch(
    sessionGroup,
    /applyProjectSort/,
    "a session sort choice must not change the project sort",
  );

  assert.match(projectGroup, /data-sort-scope="project"/);
  for (const mode of ["recent", "created", "oldest", "name"]) {
    assert.match(
      projectGroup,
      new RegExp(`\\["recent", "created", "oldest", "name"\\]`),
      "every existing project sort mode stays selectable",
    );
  }
  assert.match(projectGroup, /onClick=\{\(\) => applyProjectSort\(value\)\}/);
  assert.match(
    projectGroup,
    /nav\.sortProjectsRecent/,
    "the default project order is described as a visit order, not message recency",
  );
  assert.doesNotMatch(
    projectGroup,
    /applySessionSort/,
    "a project sort choice must not change the session sort",
  );

  const sessionSetter = sidebarSource.match(
    /const applySessionSort = \(next: SessionSort\) => \{([\s\S]*?)\n  \};/,
  )?.[1] ?? "";
  const projectSetter = sidebarSource.match(
    /const applyProjectSort = \(next: ProjectSort\) => \{([\s\S]*?)\n  \};/,
  )?.[1] ?? "";
  assert.match(sessionSetter, /setSessionSort\(next\)/);
  assert.doesNotMatch(
    sessionSetter,
    /setProjectSort/,
    "changing the session sort never touches the project sort",
  );
  assert.match(projectSetter, /setProjectSort\(next\)/);
  assert.doesNotMatch(
    projectSetter,
    /setSessionSort/,
    "changing the project sort never touches the session sort",
  );
});

test("sidebar project groups order by user visits instead of session activity", () => {
  assert.match(
    sidebarSource,
    /sortProjectGroups\(result, displayProjectSort, projectVisitRankMap\)/,
    "project groups use the shared project order",
  );
  assert.match(sidebarSource, /const projectVisitRankMap = useMemo\(/);
  assert.doesNotMatch(
    sidebarSource,
    /lastSessionDate\(a\.sessions, "updatedAt"\)/,
    "conversation activity must not drive project-group order",
  );
});

test("the tray menu mirrors the sidebar order it is given", async () => {
  const traySource = await readFile(
    new URL("../src/features/app/useTraySessions.ts", import.meta.url),
    "utf8",
  );
  assert.match(traySource, /sort: store\.sessionView\.sort/);
  assert.doesNotMatch(
    traySource,
    /sessionView\.sort === "manual" \? "recent"/,
    "the tray must not downgrade a manual order",
  );
});

test("activation and resume register a project without moving an existing one", () => {
  // One centralized rule: every route into a project retains its place, and
  // only a path the sidebar did not hold yet is appended. The behavior itself
  // is covered by the rendered sidebar E2E and project-open-order tests; this
  // guards the store wiring that connects them.
  const activationBlock =
    projectSliceSource.match(/activateProject: async[\s\S]*?refreshProject:/)?.[0] ?? "";
  assert.match(
    activationBlock,
    /const openProjectPaths = retainProjectPath\(\s*state\.openProjectPaths,\s*workspace\.path,\s*\)/,
    "activation appends a new project and leaves a retained one where it is",
  );
  assert.doesNotMatch(
    storeSource,
    /promoteProjectPath|preserveProjectOrder/,
    "no per-caller promotion branch may survive in the store",
  );

  const bootstrapBlock =
    storeSource.match(/const persistedPaths = get\(\)\.openProjectPaths;[\s\S]*?const openProjects/)?.[0] ??
    "";
  assert.match(
    bootstrapBlock,
    /retainProjectPath\(persistedPaths, currentWorkspace\.path\)/,
    "resuming a workspace keeps its retained-tab position",
  );
});
