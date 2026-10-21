import assert from "node:assert/strict";
import test from "node:test";
import { loadRecentProjects, rememberProject } from "../src/lib/recent-projects.ts";
import { buildProjectIndex } from "../src/lib/project-archive.ts";
import { projectVisitRanks, sortProjectGroups } from "../src/lib/sidebar-project-order.ts";

/**
 * Opening, selecting, or restoring a project the user already has must not
 * change where that project sits in the sidebar, the home switcher, or the
 * Projects index. Only a newly registered project takes a new place, and it
 * takes the newest place.
 */

const RECENTS_KEY = "pi.desktop.recentProjects";

function withLocalStorage(run) {
  const previous = globalThis.localStorage;
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  try {
    return run(data);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

function recents(entries) {
  return JSON.stringify(entries);
}

function durableGroup(id, path, lastOpenedAt) {
  return {
    id,
    name: path.slice(path.lastIndexOf("/") + 1),
    primaryPath: path,
    roots: [{ path, name: path, position: 0 }],
    lastOpenedAt,
    pinned: false,
  };
}

test("reopening an existing project keeps its ordering time and list position", () => {
  withLocalStorage((data) => {
    // The user registered B after A, so B is the newer project.
    data.set(
      RECENTS_KEY,
      recents([
        { path: "/work/b", name: "b", openedAt: 200 },
        { path: "/work/a", name: "a", openedAt: 100 },
      ]),
    );

    rememberProject({ path: "/work/a", name: "a", branch: "feature" });

    const list = loadRecentProjects();
    assert.deepEqual(
      list.map((project) => project.path),
      ["/work/b", "/work/a"],
      "opening A again must not move it above B",
    );
    const reopened = list.find((project) => project.path === "/work/a");
    assert.equal(reopened.openedAt, 100, "the ordering time is the registration time");
    assert.equal(reopened.branch, "feature", "workspace metadata still refreshes");
  });
});

test("a newly registered project still takes the newest place", () => {
  withLocalStorage((data) => {
    data.set(
      RECENTS_KEY,
      recents([
        { path: "/work/b", name: "b", openedAt: 200 },
        { path: "/work/a", name: "a", openedAt: 100 },
      ]),
    );

    rememberProject({ path: "/work/c", name: "c" });
    rememberProject({ path: "/work/a", name: "a" });

    const list = loadRecentProjects();
    assert.deepEqual(
      list.map((project) => project.path),
      ["/work/c", "/work/b", "/work/a"],
    );
    assert.ok(
      list.find((project) => project.path === "/work/c").openedAt > 200,
      "a new project is registered with the current time",
    );
  });
});

test("the Projects index does not move an existing project to the front when it becomes active", () => {
  const projects = [
    durableGroup("a", "/work/a", 1_000),
    durableGroup("b", "/work/b", 2_000),
  ];

  const activated = buildProjectIndex({
    durableProjects: projects,
    recents: [
      { path: "/work/b", name: "b", openedAt: 2_000 },
      { path: "/work/a", name: "a", openedAt: 1_000 },
    ],
    sessionProjects: [],
    workspace: { path: "/work/a", name: "a" },
    projectMeta: {},
  });

  assert.deepEqual(
    activated.map((project) => project.path),
    ["/work/b", "/work/a"],
    "activating A must not lift it above the newer project B",
  );
  assert.equal(
    activated.find((project) => project.path === "/work/a").openedAt,
    1_000,
    "activation must not rewrite the project's position timestamp",
  );

  // Restoring the same workspace through the index build is equally stable.
  const restored = buildProjectIndex({
    durableProjects: projects,
    recents: [],
    sessionProjects: [{ path: "/work/a", name: "a", updatedAt: 1_500 }],
    workspace: { path: "/work/a", name: "a" },
    projectMeta: {},
  });
  assert.deepEqual(restored.map((project) => project.path), ["/work/b", "/work/a"]);
});

test("a project the index has never seen still opens at the newest place", () => {
  const items = buildProjectIndex({
    durableProjects: [durableGroup("a", "/work/a", 1_000)],
    recents: [{ path: "/work/created", name: "created", openedAt: 9_000 }],
    sessionProjects: [],
    workspace: { path: "/work/created", name: "created" },
    projectMeta: {},
  });
  assert.deepEqual(items.map((project) => project.path), ["/work/created", "/work/a"]);
});

test("retained tabs decide the sidebar order: registering a project appends, opening one does not move it", () => {
  const entries = [
    { key: "/work/a", name: "a", meta: {}, sessions: [] },
    { key: "/work/b", name: "b", meta: {}, sessions: [] },
  ];
  const registered = sortProjectGroups(
    entries,
    "recent",
    projectVisitRanks(["/work/a", "/work/b"]),
  );
  assert.deepEqual(registered.map((entry) => entry.key), ["/work/b", "/work/a"]);

  // A newly registered project is appended, so it takes the front; the
  // projects already in the sidebar keep their relative order.
  const appended = sortProjectGroups(
    [...entries, { key: "/work/c", name: "c", meta: {}, sessions: [] }],
    "recent",
    projectVisitRanks(["/work/a", "/work/b", "/work/c"]),
  );
  assert.deepEqual(appended.map((entry) => entry.key), ["/work/c", "/work/b", "/work/a"]);

  // Reopening an existing project leaves the retained-tab array untouched, so
  // the rendered groups cannot move either.
  const reopened = sortProjectGroups(entries, "recent", projectVisitRanks(["/work/a", "/work/b"]));
  assert.deepEqual(reopened.map((entry) => entry.key), ["/work/b", "/work/a"]);
});
