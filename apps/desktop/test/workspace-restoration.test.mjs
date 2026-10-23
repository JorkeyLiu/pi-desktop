import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { restorableSessionId } from "../src/lib/workspace-restoration.ts";

const ordinary = (id, projectPath, extra = {}) => ({
  id,
  projectPath,
  source: "desktop",
  ...extra,
});

test("restores an existing ordinary session in the restored project", () => {
  const sessions = [
    ordinary("same-project", "/work/app"),
    ordinary("other-project", "/work/other"),
    ordinary("remote", "/work/app", { source: "remote" }),
  ];
  assert.equal(restorableSessionId("same-project", sessions, "/work/app"), "same-project");
  assert.equal(restorableSessionId("same-project", sessions, "/work/app/"), "same-project");
  assert.equal(restorableSessionId("other-project", sessions, "/work/app"), undefined);
  assert.equal(restorableSessionId("remote", sessions, "/work/app"), undefined);
});

test("missing selection and deleted sessions safely fall back to home", () => {
  const sessions = [ordinary("session", "/work/app")];
  assert.equal(restorableSessionId(undefined, sessions, "/work/app"), undefined);
  assert.equal(restorableSessionId("", sessions, "/work/app"), undefined);
  assert.equal(restorableSessionId("deleted", sessions, "/work/app"), undefined);
  assert.equal(restorableSessionId("session", [], "/work/app"), undefined);
  assert.equal(restorableSessionId("session", sessions, "/work/deleted"), undefined);
});

test("a pathless ordinary session restores when the host restored no workspace", () => {
  const sessions = [
    ordinary("global", undefined),
    ordinary("project", "/work/app"),
  ];
  // Workspace restoration does not require a project.
  assert.equal(restorableSessionId("global", sessions, undefined), "global");
  assert.equal(restorableSessionId("global", sessions, ""), "global");
  // A project-bound session cannot be reopened without its project, and a
  // pathless session is not a substitute for a restored project.
  assert.equal(restorableSessionId("project", sessions, undefined), undefined);
  assert.equal(restorableSessionId("global", sessions, "/work/app"), undefined);
});

test("archived selections do not reopen", () => {
  const sessions = [
    ordinary("meta-archived", "/work/app"),
    ordinary("row-archived", "/work/app", { archived: true }),
    ordinary("flag-not-boolean", "/work/app", { archived: "true" }),
  ];
  assert.equal(
    restorableSessionId("meta-archived", sessions, "/work/app", {
      "meta-archived": { archived: true },
    }),
    undefined,
  );
  // `SessionSummary` has no archived field; the runtime row flag counts only
  // when it is exactly true.
  assert.equal(restorableSessionId("row-archived", sessions, "/work/app"), undefined);
  assert.equal(
    restorableSessionId("flag-not-boolean", sessions, "/work/app"),
    "flag-not-boolean",
  );
  assert.equal(
    restorableSessionId("row-archived", sessions, "/work/app", {
      "row-archived": { archived: false },
    }),
    undefined,
  );
});

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `missing source marker after ${start}: ${end}`);
  return source.slice(from, to);
}

test("selectSession owns the remembered selection and delete only clears it", async () => {
  const sessionSlice = await readFile(
    new URL("../src/stores/slices/session-slice.ts", import.meta.url),
    "utf8",
  );
  const projectSlice = await readFile(
    new URL("../src/stores/slices/project-slice.ts", import.meta.url),
    "utf8",
  );
  const selection = between(sessionSlice, "commitSelection = (", "const alignWorkspace");
  assert.match(
    selection,
    /const record = opts\?\.record !== false;\s*\n\s*if \(record && opts\?\.rememberSelection !== false\) saveLastSelectedSession\(id\);/,
    "a recorded selection saves the remembered session",
  );

  const deletion = between(projectSlice, "deleteSession: async (id) => {", "setSessionSort:");
  assert.match(deletion, /if \(!id\) return;/, "deleting an empty id stays a no-op");
  assert.match(
    deletion,
    /if \(loadLastSelectedSession\(\) === id\) clearLastSelectedSession\(\);/,
    "deleting the remembered session clears the preference",
  );
  assert.doesNotMatch(
    deletion,
    /saveLastSelectedSession/,
    "the delete path never writes the remembered selection",
  );
});

test("startup gives pending plans priority without replacing the manual selection", async () => {
  const store = await readFile(new URL("../src/stores/app-store.ts", import.meta.url), "utf8");
  const pendingPlan = between(store, "if (livePlanSessionId) {", "} else {");
  assert.match(
    pendingPlan,
    /selectSession\(livePlanSessionId, \{ rememberSelection: false \}\)/,
    "the pending-plan session is shown without recording it as the chosen session",
  );
  assert.doesNotMatch(
    pendingPlan,
    /clearLastSelectedSession/,
    "showing a pending plan keeps the remembered ordinary selection",
  );

  const restoration = between(store, "const restoredSessionId = restorableSessionId(", "} catch (e) {");
  assert.match(restoration, /loadLastSelectedSession\(\)/);
  assert.match(restoration, /hydratedSessions/);
  assert.match(restoration, /currentWorkspace\?\.path/);
  assert.match(restoration, /get\(\)\.sessionMeta/, "archived rows are excluded using sidebar metadata");
  assert.match(restoration, /await get\(\)\.selectSession\(restoredSessionId\)/);
  assert.doesNotMatch(
    restoration,
    /selectSession\(restoredSessionId, \{ rememberSelection: false \}\)/,
    "the restored session stays the remembered selection",
  );
  assert.ok(
    store.indexOf("const restoredSessionId = restorableSessionId(") > store.indexOf("if (livePlanSessionId)"),
    "ordinary session restoration follows pending-plan restoration",
  );
});
