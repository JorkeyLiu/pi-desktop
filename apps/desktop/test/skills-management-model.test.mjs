/**
 * Skills management scope model: interaction coverage for the Global vs
 * Project management contract. These tests execute the real model module
 * (esbuild-transformed, type-only shared imports erased) against realistic
 * records and scope transitions — they assert behavior, not source text.
 *
 * The page and its workflow hook wire these primitives to `api`; the API
 * boundary itself is faked in the isolated UI run, never here.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/components/settings/skills-management-model.ts", import.meta.url),
  "utf8",
);
const require = createRequire(
  new URL("../../../packages/agent-runtime/package.json", import.meta.url),
);
const { transform } = require("esbuild");
const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const model = await import(`data:text/javascript,${encodeURIComponent(compiled.code)}`);

const PROJECT = "/workspace/acme";

function record(overrides = {}) {
  return {
    id: "standup",
    name: "Standup",
    description: "Daily notes",
    enabled: true,
    source: "custom",
    ...overrides,
  };
}

test("global management queries global skills without a projectPath", () => {
  // Even with a workspace project around, Global management stays
  // workspace-independent: the query carries no project context at all.
  const query = model.globalSkillsQuery("global", PROJECT);
  assert.deepEqual(query, { level: "global" });
  assert.ok(!("projectPath" in query), "global query must not name a project");

  // Project management pairs the global column with the selected project so
  // rows arrive with override provenance.
  assert.deepEqual(model.globalSkillsQuery("project", PROJECT), {
    level: "global",
    projectPath: PROJECT,
  });

  // Project mode without a selection falls back to the context-free global
  // list; the project column simply has nothing to show.
  assert.deepEqual(model.globalSkillsQuery("project", null), { level: "global" });
  assert.equal(model.projectSkillsQuery(null), null);
  assert.deepEqual(model.projectSkillsQuery(PROJECT), {
    level: "project",
    projectPath: PROJECT,
  });
});

test("a project-mode global row toggles the override, every other row its own record", () => {
  // The switch on a global row in Project mode writes the per-project
  // override of that global skill — never the global record itself.
  assert.deepEqual(
    model.toggleQueryForRow({ mode: "project", projectPath: PROJECT }, "global"),
    { level: "global", projectPath: PROJECT },
  );

  // The same row in Global management toggles the global record directly:
  // no project context may leak into the call.
  const globalToggle = model.toggleQueryForRow({ mode: "global", projectPath: null }, "global");
  assert.deepEqual(globalToggle, { level: "global" });
  assert.ok(!("projectPath" in globalToggle), "global toggle must not name a project");

  // Project rows always toggle their own level record.
  assert.deepEqual(
    model.toggleQueryForRow({ mode: "project", projectPath: PROJECT }, "project"),
    { level: "project", projectPath: PROJECT },
  );
});

test("override state comes only from the host field, never boolean equality", () => {
  // A stored override may equal the global default, so equal booleans with
  // no field must read as inherited — the restore control stays hidden.
  assert.equal(
    model.isSkillOverrideForProject(record({ enabled: true, globalEnabled: true })),
    false,
  );
  assert.equal(
    model.isSkillOverrideForProject(record({ enabled: false, globalEnabled: false })),
    false,
  );
  // Only the host-populated field decides.
  assert.equal(
    model.isSkillOverrideForProject(
      record({ enabled: true, globalEnabled: true, enabledSource: "override" }),
    ),
    true,
  );
  assert.equal(
    model.isSkillOverrideForProject(
      record({ enabled: false, globalEnabled: true, enabledSource: "inherited" }),
    ),
    false,
  );
});

test("new and imported skills land where the mode says, never a hidden fallback", () => {
  assert.deepEqual(model.skillWriteDestination("global", PROJECT), {
    ok: true,
    level: "global",
  });
  assert.deepEqual(model.skillWriteDestination("global", null), {
    ok: true,
    level: "global",
  });
  assert.deepEqual(model.skillWriteDestination("project", PROJECT), {
    ok: true,
    level: "project",
    projectPath: PROJECT,
  });

  // Project management without a selected project cannot name a destination:
  // the caller must say so instead of silently using a hidden workspace.
  const missing = model.skillWriteDestination("project", null);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "select-project-first");
});

test("the toggle prediction matches the host prune rule for the toggle call", () => {
  // Context-free rows carry no provenance to predict.
  assert.deepEqual(model.provenanceAfterToggle(record(), false), { enabled: false });

  // A project-context row that flips away from the global default becomes an
  // override; flipping back to the default prunes the stored override, so it
  // predicts inherited — exactly what the next load reports.
  const fromDefault = record({ enabled: true, globalEnabled: true, enabledSource: "inherited" });
  assert.deepEqual(model.provenanceAfterToggle(fromDefault, false), {
    enabled: false,
    enabledSource: "override",
  });
  const overridden = record({ enabled: false, globalEnabled: true, enabledSource: "override" });
  assert.deepEqual(model.provenanceAfterToggle(overridden, true), {
    enabled: true,
    enabledSource: "inherited",
  });

  // Same rule against a disabled global default.
  const disabledDefault = record({
    enabled: true,
    globalEnabled: false,
    enabledSource: "override",
  });
  assert.deepEqual(model.provenanceAfterToggle(disabledDefault, false), {
    enabled: false,
    enabledSource: "inherited",
  });
});

test("a slow load for a dead scope can never overwrite the live one", () => {
  const guard = model.createSkillsScopeGuard();
  guard.update({ mode: "global", projectPath: null });
  const stale = guard.capture();

  // The user switches to Project mode while the global fetch is in flight.
  guard.update({ mode: "project", projectPath: PROJECT });
  assert.equal(guard.isCurrent(stale), false);
  assert.deepEqual(guard.current(), { mode: "project", projectPath: PROJECT });

  const live = guard.capture();
  assert.equal(guard.isCurrent(live), true);
  // Captures are snapshots: a later switch does not rewrite them.
  guard.update({ mode: "global", projectPath: null });
  assert.deepEqual(live.scope, { mode: "project", projectPath: PROJECT });
  assert.equal(guard.isCurrent(live), false);
});

test("a mutation that lands after a scope switch reloads instead of patching", () => {
  const guard = model.createSkillsScopeGuard();
  guard.update({ mode: "project", projectPath: PROJECT });
  const captured = guard.capture();

  // The toggle response arrives after the user left for Global management:
  // the captured scope no longer matches, so the workflow must reload the
  // now-current scope rather than patch rows it no longer owns.
  guard.update({ mode: "global", projectPath: null });
  assert.equal(model.sameSkillsScope(captured.scope, guard.current()), false);

  // While the scope is unchanged, the same check passes and the local patch
  // is safe to keep.
  guard.update({ mode: "project", projectPath: PROJECT });
  const steady = guard.capture();
  assert.equal(model.sameSkillsScope(steady.scope, guard.current()), true);
  assert.equal(model.sameSkillsScope(steady.scope, { mode: "project", projectPath: PROJECT }), true);
  assert.equal(model.sameSkillsScope(steady.scope, { mode: "global", projectPath: null }), false);
});

test("skill paths name the level the row belongs to", () => {
  assert.equal(model.SKILLS_GLOBAL_PATH, "~/.agents/skills");
  assert.equal(model.projectSkillsPath(PROJECT), `${PROJECT}/.agents/skills`);
});
