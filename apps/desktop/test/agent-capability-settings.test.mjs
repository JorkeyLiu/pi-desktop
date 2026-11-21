import {
  readSettingsSourceSync,
  readPluginsSourceSync,
  readMainSourceSync,
  readMainModuleSync,
} from "./helpers/source-contracts.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadStyles } from "./helpers/styles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "../src");
const settingsDir = join(srcDir, "components/settings");
const read = (path) => readFileSync(join(here, path), "utf8");
const settingsPage = readSettingsSourceSync();
const pluginsPage = readPluginsSourceSync();
const layout = read("../src/components/settings/AgentCapabilityLayout.tsx");
const skills = read("../src/components/settings/AgentSkillsPage.tsx");
const mcp = read("../src/components/settings/AgentMcpPage.tsx");
const subagents = read("../src/components/settings/AgentSubagentsPage.tsx");
const subagentSettings = read("../src/components/settings/subagent-settings.ts");
const hostCollection = read("../src/hooks/use-host-collection.ts");
const mcpEditor = read("../src/components/extensions/McpEditorSheet.tsx");
const electron = readMainSourceSync();
const skillImport = readMainModuleSync("ipc/skills-ipc.ts");
const styles = await loadStyles();

// Keep this suite source-oriented like the neighboring desktop contracts: it
// catches IA regressions without requiring an Electron window or a native picker.
test("agent settings have three independent destinations and extensions have two tabs", () => {
  assert.match(settingsPage, /tab === "skills" && <AgentSkillsPage \/>/);
  assert.match(settingsPage, /tab === "mcp" && <AgentMcpPage \/>/);
  assert.match(settingsPage, /tab === "subagents" && <AgentSubagentsPage \/>/);
  assert.match(pluginsPage, /type TabId = "installed" \| "market"/);
  assert.doesNotMatch(pluginsPage, /plugins-(?:tab|panel)-(?:mcp|skills|subagents)/);
});

test("bundled skill activation validates the catalog and writes host-owned state", () => {
  assert.match(skillImport, /handle\(IPC\.invoke\.skillBuiltinList,[\s\S]*?disabledBuiltinSkills\(\)/);
  assert.match(skillImport, /handle\([\s\S]*?IPC\.invoke\.skillBuiltinSetEnabled,[\s\S]*?typeof payload\.enabled !== "boolean"/);
  assert.match(skillImport, /builtinSkillCatalog\(\)\.some\(\(skill\) => skill\.id === payload\.id\)/);
  assert.match(skillImport, /host\.call\("skills\.setBuiltinEnabled"/);
  assert.match(skillImport, /sendToRenderer\(IPC\.event\.pluginChanged, \{ reason: "skill" \}\)/);
});

test("MCP filters one list by level; skills manages explicit global/project modes", () => {
  // MCP keeps the level filter: one toolbar, one panel, groups inside it.
  assert.match(mcp, /useAgentProjects\(\)/);
  assert.match(mcp, /AgentProjectPicker/);
  assert.match(mcp, /level: "global"/);
  assert.match(mcp, /level: "project"/);
  // One toolbar, one panel, group headers inside it — not a section per level.
  assert.match(mcp, /<CapabilityToolbar/);
  assert.match(mcp, /<CapabilityPanel/);
  assert.match(mcp, /CapabilityGroupHeader/);
  assert.match(mcp, /useState<CapabilityFilter>\("all"\)/);
  assert.match(mcp, /const showGlobal = filter !== "project"/);
  assert.match(mcp, /const showProject = filter !== "global"/);
  assert.doesNotMatch(layout, /AgentCapabilitySection|AgentCapabilityColumn/);
  assert.match(layout, /agent-capability-list/);
  assert.match(layout, /<SegmentedControl[\s\S]*?value=\{filter\}/);
  assert.match(layout, /settings\.capabilityFilterAll/);
  // Skills replaces the filter with a Global/Project management switch: the
  // picker only exists in Project mode and Global never sends a projectPath.
  assert.match(skills, /useAgentSkillsManagement\(deleteArm\)/);
  assert.match(skills, /modeSwitch=\{/);
  assert.match(skills, /value=\{mode\}/);
  assert.match(skills, /settings\.skillsManageGlobal/);
  assert.match(skills, /settings\.skillsManageProject/);
  assert.match(skills, /settings\.skillsManageModeLabel/);
  assert.match(skills, /settings\.skillsGlobalModeDesc/);
  assert.match(skills, /settings\.skillsProjectModeDesc/);
  assert.match(skills, /isProjectMode \? \(/);
  assert.match(skills, /"global"|"project"/);
  assert.doesNotMatch(skills, /CapabilityFilter/);
  assert.doesNotMatch(skills, /showGlobal|showProject/);
  assert.doesNotMatch(skills, /targetLevel/);
  assert.match(layout, /\{modeSwitch \?\? null\}/);
  // Subagents are global-only, so they get no level filter and no project.
  assert.doesNotMatch(subagents, /AgentProjectPicker|projectPath|CapabilityFilter/);
  assert.doesNotMatch(subagentSettings, /AgentProjectPicker|projectPath|CapabilityFilter/);
  assert.match(subagents, /settings\.globalOnly/);
  assert.match(subagents, /t\("settings\.subagentsEmpty"\)/);
  assert.doesNotMatch(subagents, /settings\.subagents\.empty|t\("subagents\.empty"\)/);
});

test("one search field covers the page and every row carries its level", () => {
  for (const source of [skills, mcp, subagents]) {
    assert.match(source, /matchesCapabilitySearch\(/);
    assert.match(source, /settings\.capabilityNoMatches/);
  }
  assert.match(layout, /agent-capability-search-clear/);
  assert.match(layout, /settings\.clearSearch/);
  for (const source of [skills, mcp]) {
    assert.match(source, /agent-capability-badge is-level/);
  }
  assert.match(styles, /\.agent-capability-badge\.is-level\s*\{/);
});

test("skills keep file imports in group headers and expose the external scan in-page", () => {
  const toolbar = skills.slice(skills.indexOf("<CapabilityToolbar"), skills.indexOf("<CapabilityPanel"));
  assert.match(toolbar, /actions=\{[\s\S]*?CapabilityButton variant="primary"/);
  assert.match(toolbar, /settings\.newSkill/);
  assert.match(toolbar, /ImportToggleButton/);
  assert.match(toolbar, /settings\.importSkillFromTools/);
  assert.doesNotMatch(toolbar, /extensions\.skills\.add/);
  assert.match(skills, /action=\{importButton\("global", true\)\}/);
  assert.match(
    skills,
    /selectedProjectPath \? importButton\("project", true\) : undefined/,
  );
  assert.match(skills, /<AgentSkillImportPanel/);
  assert.match(skills, /level=\{destination\.level\}/);
  assert.match(skills, /\{destination\.ok \? \(/);
  assert.match(skills, /disabled=\{!destination\.ok\}/);
  assert.match(mcp, /<AgentMcpImportPanel/);
  assert.match(mcp, /settings\.importMcpFromTools/);
  assert.match(layout, /action\?: ReactNode/);
});

test("capability lists flow at natural height with skeleton loading", () => {
  assert.doesNotMatch(styles, /\.agent-capability-list\s*\{[^}]*?height:\s*\d+px/);
  assert.match(styles, /\.agent-capability-list\s*\{[\s\S]*?flex-direction:\s*column/);
  assert.match(
    styles,
    /\.agent-capability-row\.is-off \.agent-capability-copy\s*\{[\s\S]*?opacity:/,
  );
  assert.match(layout, /CapabilitySkeleton/);
  assert.match(styles, /\.agent-capability-skeleton-row\s*\{/);
  assert.match(layout, /aria-busy=\{loading \|\| undefined\}/);
  assert.match(layout, /agent-capability-empty/);
});

test("capability surfaces use the shared settings hierarchy", () => {
  assert.match(layout, /AgentCapabilityPage/);
  assert.match(layout, /settings-panel/);
  assert.match(styles, /\.agent-capability-intro-description\s*\{/);
  assert.match(styles, /\.agent-capability-intro-note\s*\{/);
  assert.match(styles, /\.agent-capability-group-label\s*\{[\s\S]*?font-weight:\s*var\(--font-weight-strong\)/);
  assert.match(styles, /\.agent-capability-group-path\s*\{[\s\S]*?font-family:\s*var\(--font-mono\)/);
  // Scoped to the rule block: [\s\S] would run past the closing brace and
  // match a "dashed" belonging to any later stylesheet in the cascade.
  assert.doesNotMatch(styles, /\.agent-capability-empty\s*\{[^}]*dashed/);
  assert.match(styles, /\.settings-icon-button\s*\{/);
});

test("the workbench reuses the shared segmented control instead of a third copy", () => {
  assert.match(layout, /<SegmentedControl/);
  assert.match(layout, /className="agent-capability-segment"/);
  assert.match(layout, /itemClassName="agent-capability-segment-btn"/);
  // providers.css defines the shared segment and imports after settings.css, so
  // a bare local class would silently lose. Every local override must compound.
  for (const decl of [
    /\.settings-segment\.agent-capability-segment\s*\{/,
    /\.settings-segment-item\.agent-capability-segment-btn\s*\{/,
  ]) {
    assert.match(styles, decl);
  }
  // Leading \s* so a rule nested in a media query counts too: that is exactly
  // where two bare selectors first slipped past this check.
  assert.doesNotMatch(styles, /^\s*\.agent-capability-segment\s*\{/m);
  assert.doesNotMatch(styles, /^\s*\.agent-capability-segment-btn\s*\{/m);
});

test("the empty state dresses its own glyph, not the icon in its CTA button", () => {
  // Lucide icons set inline width/height. Padding the SVG itself crushed the
  // stroke into a blank chip, and a descendant `svg` rule also ate the CTA
  // button's icon. Chip the host Icon on a wrapper instead.
  assert.match(layout, /agent-capability-empty-icon/);
  assert.match(styles, /\.agent-capability-empty-icon\s*\{/);
  assert.doesNotMatch(styles, /\.agent-capability-empty svg\s*\{/);
  assert.doesNotMatch(styles, /\.agent-capability-empty > svg\s*\{/);
  // The pages that pass a CTA into the empty state are the ones that regressed.
  for (const page of [mcp, subagents]) {
    assert.match(page, /action=\{addButton\}|action=\{[a-zA-Z]*[Bb]utton\}/);
  }
});

test("toolbar buttons carry their own compact geometry", () => {
  // `Button size="sm"` is inert app-wide: its utilities are in Tailwind's
  // `utilities` layer and every partial here is unlayered, so `.btn` wins. A
  // previous pass zeroed the buttons' vertical padding and leaned on a fixed
  // container height instead, which collapsed them whenever that height did not
  // apply. Geometry belongs on the button.
  assert.doesNotMatch(layout, /^\s+size="sm"$/m);
  const actions = styles.slice(styles.indexOf(".agent-capability-toolbar-actions"));
  const rule = actions.slice(
    actions.indexOf(".agent-capability-toolbar-actions > .btn"),
    actions.indexOf("}", actions.indexOf(".agent-capability-toolbar-actions > .btn")),
  );
  assert.match(rule, /min-height:\s*var\(--agent-capability-control-height\)/);
  assert.match(rule, /padding:\s*5px 11px/);
  assert.doesNotMatch(styles, /\.agent-capability-toolbar-actions > \.btn \{[^}]*padding-top:\s*0/);
});

test("capability elevation is theme-relative and meaningful text is not faint", () => {
  const block = styles.slice(
    styles.indexOf(".agent-capability-page"),
    styles.indexOf(".agent-mcp-scope"),
  );
  assert.ok(block.length > 0, "capability style block not found");
  // --ds-bg-elevated-opaque is an absolute gray: #ffffff in light and #282828 in
  // dark. On the group strip that read as white-on-white, then *below* its own
  // strip in dark. Relative mixes invert with the theme instead.
  assert.match(
    block,
    /\.agent-capability-group-count\s*\{[\s\S]*?background:\s*color-mix\(in oklab, var\(--ds-text-primary\)/,
  );
  // The floating menu is the one place the absolute token is right, and it needs
  // a dark override because #282828 does not detach from a #212121 panel.
  assert.match(styles, /:root\[data-theme="dark"\] \.agent-capability-menu\s*\{/);
  // --ds-text-faint is #afafaf, ~2.2:1 on white. The level badge, resolved path,
  // and command string are content, so they use the muted tier.
  for (const rule of [
    /\.agent-capability-badge\.is-level\s*\{[\s\S]*?color:\s*var\(--ds-text-muted\)/,
    /\.agent-capability-group-path\s*\{[\s\S]*?color:\s*var\(--ds-text-muted\)/,
    /\.agent-capability-command\s*\{[\s\S]*?color:\s*var\(--ds-text-muted\)/,
  ]) {
    assert.match(block, rule);
  }
  // Live handshake tint follows .ext-row-glyph, and being switched off clears it.
  assert.match(block, /\.agent-capability-glyph\.is-ready\s*\{[\s\S]*?var\(--ds-success\)/);
  assert.match(
    block,
    /\.agent-capability-row\.is-off \.agent-capability-glyph\s*\{[\s\S]*?background:\s*transparent/,
  );
  assert.match(block, /\.agent-capability-row:not\(\.is-off\):hover \.agent-capability-glyph/);
});

test("the capability toolbar stacks when narrow", () => {
  assert.match(styles, /\.agent-capability-group-label\s*\{[\s\S]*?white-space:\s*nowrap/);
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)[\s\S]*?\.agent-capability-toolbar[\s\S]*?flex-direction:\s*column/,
  );
});

test("a busy row does not lock the page and a refresh does not flash skeletons", () => {
  assert.match(layout, /settings\.capabilityCount/);
  assert.match(layout, /aria-busy=\{busy \|\| undefined\}/);
  assert.match(styles, /\.settings-toggle:focus-visible/);
  for (const source of [skills, mcp, subagents]) {
    // Busy is scoped to the row that is working, never to the whole list.
    assert.match(source, /busy=\{busy/);
    assert.doesNotMatch(source, /disabled=\{loading \|\| busy/);
    // Skeletons are first paint only; later loads dim the rows they already
    // have. MCP and Subagents own that state through the shared collection
    // hook; Skills owns it through the extracted management hook.
    assert.doesNotMatch(source, /hydrated = useRef\(false\)/);
    assert.match(source, /refreshing=\{refreshing\}/);
  }
  assert.match(mcp, /useHostCollection\(/);
  assert.match(subagents, /useHostCollection\(/);
  assert.match(skills, /useAgentSkillsManagement\(deleteArm\)/);
  const management = read("../src/components/settings/useAgentSkillsManagement.ts");
  // Switching mode or project refetches instead of showing stale rows: the
  // fetch closes over the scope, so its identity changes with it and the
  // collection retires the in-flight request for the dead scope.
  assert.match(management, /globalSkillsQuery\(scope\.mode, scope\.projectPath\)/);
  assert.match(management, /\}, \[scope\]\);/);
  assert.match(hostCollection, /hydrated = useRef\(false\)/);
  assert.match(hostCollection, /if \(hydrated\.current\) setRefreshing\(true\)/);
  assert.match(styles, /\.agent-capability-panel\.is-refreshing \.agent-capability-list\s*\{/);
  assert.match(layout, /settings\.capabilityRefreshing/);
});

test("toggling a capability flips locally and reverts only if the host refuses", () => {
  const cases = [
    [mcp, "setMcpServerEnabled", "server"],
    [subagents, "setUserSubagentEnabled", "subagent"],
  ];
  for (const [source, method, row] of cases) {
    const toggle = source.slice(
      source.indexOf("const toggle = async"),
      source.indexOf("const toggle = async") + 1400,
    );
    assert.notEqual(toggle, "", `${method} toggle should be present`);
    assert.match(toggle, /enabled: next/);
    assert.match(toggle, new RegExp(`api\\.${method}`));
    // Success needs no reload: the local patch already matches what the host did.
    assert.doesNotMatch(toggle.slice(0, toggle.indexOf("catch")), /await load\(\)/);
    assert.match(toggle, new RegExp(`catch[\\s\\S]*?enabled: ${row}\\.enabled`));
  }
  // Skills toggles through the extracted management hook: the row's provenance
  // prediction flips first, the call carries the row's scope query, and a
  // response that lands after a scope switch reloads instead of patching rows
  // it no longer owns. Only a refusal on the current scope reverts the patch.
  const management = read("../src/components/settings/useAgentSkillsManagement.ts");
  const toggle = management.slice(management.indexOf("const toggle = async"));
  assert.notEqual(toggle, "", "skills toggle should be present");
  assert.match(toggle, /provenanceAfterToggle\(skill, next\)/);
  assert.match(toggle, /api\.setUserSkillEnabled\(skill\.id, next, query\)/);
  assert.match(toggle, /toggleQueryForRow\(captured\.scope, level\)/);
  assert.match(toggle, /sameSkillsScope\(captured\.scope, guard\.current\.current\(\)\)/);
  assert.match(toggle, /await load\(\)/);
  assert.match(toggle, /catch[\s\S]*?enabled: skill\.enabled/);
});

test("each capability page can create, edit, and delete without leaving settings", () => {
  const management = read("../src/components/settings/useAgentSkillsManagement.ts");
  assert.match(management, /api\.createUserSkill/);
  assert.match(management, /api\.updateUserSkill/);
  assert.match(management, /api\.removeUserSkill/);
  assert.match(management, /api\.revealUserSkill/);
  assert.match(skills, /<SkillEditorSheet/);
  assert.match(subagents, /api\.createUserSubagent/);
  assert.match(subagents, /api\.updateUserSubagent/);
  assert.match(subagents, /api\.removeUserSubagent/);
  assert.match(subagents, /api\.revealSubagent/);
  assert.match(subagents, /<SubagentEditorSheet/);
  assert.match(mcp, /api\.upsertMcpServer/);
  assert.match(mcp, /api\.removeMcpServer/);
  // Destructive row actions arm first and say so before they fire. The
  // page owns the arm through the shared hook; the extracted management
  // hook receives it, so the arm keeps one expiring implementation.
  assert.match(skills, /const deleteArm = useArmedDelete\(\)/);
  assert.match(management, /useAgentSkillsManagement\(arm: SkillsDeleteArm\)/);
  assert.match(skills, /settings\.capabilityRemoveConfirm/);
  assert.match(skills, /danger: true/);
  for (const source of [mcp, subagents]) {
    assert.match(source, /useArmedDelete\(\)/);
    assert.match(source, /settings\.capabilityRemoveConfirm/);
    assert.match(source, /danger: true/);
  }
  // The arm and its expiry live in the shared hook the settings pages
  // re-export from the layout, so one timeout covers every armed delete.
  assert.match(layout, /export \{ useArmedDelete \} from "\.\.\/\.\.\/hooks\/use-armed-delete"/);
  assert.match(read("../src/hooks/use-armed-delete.ts"), /ARMED_DELETE_MS/);
  assert.match(styles, /\.agent-capability-menu button\.danger\s*\{/);
});

test("row actions stay quiet until the row is engaged, but not on touch", () => {
  assert.match(
    styles,
    /\.agent-capability-row-actions > \.settings-icon-button[\s\S]{0,200}?opacity:\s*0;/,
  );
  assert.match(styles, /\.agent-capability-row:hover \.agent-capability-row-actions/);
  assert.match(styles, /\.agent-capability-row:focus-within \.agent-capability-row-actions/);
  assert.match(styles, /\.agent-capability-row\.menu-open \.agent-capability-row-actions/);
  assert.match(styles, /@media \(hover: none\)[\s\S]*?opacity:\s*1/);
});

test("revealing a skill carries the level so project skills resolve", () => {
  const api = read("../src/lib/api.ts");
  assert.match(api, /revealUserSkill:\s*\(id: string, query\?: Partial<AgentCapabilityQuery>\)/);
  assert.match(api, /IPC\.invoke\.skillReveal, \{ id, \.\.\.query \}/);
  const handler = skillImport.slice(skillImport.indexOf("IPC.invoke.skillReveal"));
  assert.match(handler, /typeof payload === "string" \? \{ id: payload \} : payload/);
  assert.match(handler, /host\.call<\{ skill: UserSkillRecord \| null \}>\("skills\.read", request\)/);
  const management = read("../src/components/settings/useAgentSkillsManagement.ts");
  assert.match(management, /api\.revealUserSkill\(skill\.id, toggleQueryForRow\(scope, level\)\)/);
  assert.match(management, /api\.readUserSkill\(skill\.id, query\)/);
  assert.match(management, /api\.removeUserSkill\(skill\.id, toggleQueryForRow\(scope, level\)\)/);
});

test("skill file import stays single-select while folder import selects many", () => {
  assert.notEqual(skillImport, "", "skill import handler should be present");
  assert.match(skillImport, /properties:\s*\["openFile"\]/);
  assert.match(skillImport, /properties:\s*\["openDirectory", "multiSelections"\]/);
  assert.match(skillImport, /defaultPath: lastDirectory/);
  assert.match(skillImport, /writeLastSkillImportDirectory\(dataDir, lastImportedPath\)/);
  assert.match(skillImport, /importSkillFolders<UserSkillRecord>\(\s*picked\.filePaths/);
  assert.match(skillImport, /currentHost\.call\("skills\.import"/);
  assert.match(read("../../../crates/host-core/src/user_skills.rs"), /fs::copy\(source, target\)/);
});

test("MCP management reuses the validated modal and blocks same-level duplicates", () => {
  assert.match(mcp, /<McpEditorSheet/);
  assert.match(mcp, /settings\.mcpDuplicate/);
  assert.match(mcpEditor, /role="dialog"/);
  assert.match(mcpEditor, /disabled=\{!!editing\}/);
  assert.match(mcpEditor, /\^\[a-zA-Z\]\[a-zA-Z0-9_-\]\{0,63\}\$/);
  assert.match(mcp, /api\.testMcpServer/);
});

test("capability state stays outside capability files and active merge shadows disabled project rows", () => {
  const capabilities = read("../../../crates/host-core/src/agent_capabilities.rs");
  const mcpRegistry = read("../../../crates/host-core/src/mcp_servers.rs");
  const skillRegistry = read("../../../crates/host-core/src/user_skills.rs");
  assert.match(capabilities, /agent-capabilities/);
  assert.match(mcpRegistry, /\.agents\/servers/);
  // `.agents/skills` was only ever spelled in this file's own Rust test
  // fixtures, which now live beside the module they cover
  // (crates/host-core/src/user_skills/tests.rs). Pin the production pair
  // instead: the skills leaf the registry resolves, and the `.agents` root
  // capability_dir resolves it under.
  assert.match(capabilities, /pub const AGENTS_DIR: &str = "\.agents";/);
  assert.match(skillRegistry, /capability_dir\([^;]*"skills"/);
  assert.match(mcpRegistry, /existing\.id != record\.id/);
  assert.match(mcpRegistry, /if record\.enabled \{/);
  assert.match(skillRegistry, /existing\.id != record\.id/);
  assert.match(skillRegistry, /if record\.enabled \{/);
});

test("all capability paths are agents roots, not legacy capability directories", () => {
  for (const source of [layout, skills, mcp, subagents, subagentSettings, mcpEditor, electron]) {
    assert.doesNotMatch(source, /\.pi\/(?:agents|skills|mcp)/);
  }
});

test("Settings lists shipped builtin subagents with a switch of their own", () => {
  const api = read("../src/lib/api.ts");
  assert.match(subagentSettings, /api\.subagentCatalog/);
  assert.match(subagentSettings, /item\.source === "builtin"/);
  assert.match(subagentSettings, /fallbackBuiltinDefinitions/);
  assert.match(subagentSettings, /owned\.filter\(\(row\) => row\.enabled\)/);
  assert.match(subagentSettings, /catalog\.builtins/);
  assert.match(subagents, /extensions\.subagents\.sourceBuiltin/);
  assert.match(subagents, /extensions\.subagents\.copy/);
  assert.match(subagents, /draftFromDefinition/);
  assert.match(subagents, /copyBuiltin/);
  assert.match(subagents, /presetId: definition\.name/);
  assert.match(subagents, /initialPresetId=\{editor\.presetId\}/);
  // A builtin row keeps its badge and Copy as mine, gains the switch, and still
  // has no Reveal or Delete: there is no file behind it.
  const builtinRow = subagents.slice(
    subagents.indexOf("const renderBuiltin"),
    subagents.indexOf("const renderRow"),
  );
  assert.notEqual(builtinRow, "", "builtin row renderer should be present");
  assert.match(builtinRow, /IconCopy/);
  assert.match(builtinRow, /<CapabilityToggle/);
  assert.match(builtinRow, /checked=\{definition\.enabled\}/);
  assert.doesNotMatch(
    builtinRow,
    /setUserSubagentEnabled|revealSubagent|removeUserSubagent/,
  );
  // The switch writes builtin activation, flipping locally first like the rows
  // that own a document do.
  const toggle = subagents.slice(
    subagents.indexOf("const toggleBuiltin = async"),
    subagents.indexOf("const openEdit = async"),
  );
  assert.notEqual(toggle, "", "builtin toggle should be present");
  assert.match(toggle, /api\.setBuiltinSubagentEnabled\(handle, next\)/);
  assert.match(toggle, /enabled: next/);
  assert.doesNotMatch(toggle.slice(0, toggle.indexOf("catch")), /await load\(\)/);
  assert.match(toggle, /catch[\s\S]*?enabled: builtin\.enabled/);
  assert.match(api, /setBuiltinSubagentEnabled: \(id: string, enabled: boolean\) =>/);
});

test("a capability can be moved between the global and a project level", () => {
  const api = read("../src/lib/api.ts");
  const protocol = read("../../../packages/shared/src/protocol.ts");
  const sharedTypes = read("../../../packages/shared/src/types/capabilities.ts");
  const mcpIpc = readMainModuleSync("ipc/mcp-ipc.ts");
  const rpc = read("../../../crates/host-core/src/rpc/mod.rs");
  const capabilities = read("../../../crates/host-core/src/agent_capabilities.rs");
  const mcpRegistry = read("../../../crates/host-core/src/mcp_servers.rs");
  const skillRegistry = read("../../../crates/host-core/src/user_skills.rs");

  // Both ends travel with the request, so a global source that names a project
  // as its enablement context is never mistaken for the destination.
  assert.match(
    sharedTypes,
    /export type AgentCapabilityMove = \{[\s\S]*?from: AgentCapabilityTarget;[\s\S]*?to: AgentCapabilityTarget;/,
  );
  assert.match(protocol, /mcpTransfer: "pi-desktop\/mcp\/transfer"/);
  assert.match(protocol, /skillTransfer: "pi-desktop\/skill\/transfer"/);
  assert.match(api, /transferMcpServer: \(move: AgentCapabilityMove\) =>/);
  assert.match(api, /transferUserSkill: \(move: AgentCapabilityMove\) =>/);
  assert.match(mcpIpc, /host\.call<\{ server: McpServerRecord \}>\("mcp\.transfer", payload\)/);
  assert.match(
    skillImport,
    /host\.call<\{ skill: UserSkillRecord \}>\("skills\.transfer", payload\)/,
  );
  assert.match(rpc, /"mcp\.transfer" =>/);
  assert.match(rpc, /"skills\.transfer" =>/);

  // The host moves the document instead of copying it, so the source level
  // stops listing it, and the enabled value follows it to the new level. The
  // state entry dropped is the source owner's, never another project's.
  assert.match(capabilities, /pub fn set_moved_capability_state\(/);
  assert.match(
    capabilities,
    /state\.forget\(kind, source_level, source_id, source_project_path\)\?;/,
  );
  assert.match(capabilities, /pub fn move_capability_file\(/);
  assert.match(mcpRegistry, /pub fn transfer\(/);
  assert.match(skillRegistry, /pub fn transfer\(/);
  // A destination that already owns the id or name keeps both by renaming.
  assert.match(capabilities, /pub fn suffixed_capability_id\(/);
  assert.match(capabilities, /pub fn suffixed_display_name\(/);
  // A directory-shaped skill carries its sibling resources, so the directory is
  // the unit, not the one markdown file.
  assert.match(skillRegistry, /fn directory_skill_root\(/);
  assert.match(skillRegistry, /copy_directory_tree\(dir, &target_unit, true\)/);
  // Renaming must not reformat the document it edits.
  assert.match(skillRegistry, /fn rewrite_document_name\(/);
  assert.doesNotMatch(
    skillRegistry.slice(
      skillRegistry.indexOf("pub fn transfer("),
      skillRegistry.indexOf("pub fn new(data_dir"),
    ),
    /render_document/,
  );
});

test("the move action offers a level only when there is a destination", () => {
  const management = read("../src/components/settings/useAgentSkillsManagement.ts");
  assert.match(mcp, /settings\.capabilityMoveToGlobal/);
  assert.match(mcp, /settings\.capabilityMoveToProject/);
  assert.match(mcp, /settings\.capabilityMovedRenamed/);
  assert.match(mcp, /IconArrowUpDown/);
  // The project picker owns the destination, so a global row has nowhere to
  // go until a project is selected; a project row always has Global.
  assert.match(mcp, /moveTarget\[level === "global" \? "project" : "global"\]/);
  assert.match(mcp, /showToast\(t\("settings\.selectProjectFirst"\)/);
  // Skills moves through an explicit destination dialog: Global management
  // shows no picker, so a global row asks for the project instead of using a
  // hidden one; the project row's Move to Global stays direct, and the global
  // context rows in Project management offer no move at all.
  assert.match(skills, /settings\.capabilityMoveToGlobal/);
  assert.match(skills, /settings\.capabilityMoveToProjectMenu/);
  assert.match(management, /settings\.capabilityMovedRenamed/);
  assert.match(skills, /IconArrowUpDown/);
  assert.match(skills, /settings\.skillMoveTitle/);
  assert.match(skills, /settings\.skillMoveDestinationLabel/);
  assert.match(skills, /settings\.skillMoveConfirm/);
  assert.match(skills, /role="dialog"/);
  assert.match(skills, /confirmMoveToProject\(moveProjectChoice\)/);
  assert.match(skills, /moveToGlobal\(skill\)/);
  assert.match(management, /from: \{ level: "global" \}/);
  assert.match(management, /to: \{ level: "project", projectPath: destinationProjectPath \}/);
  assert.match(management, /from: \{ level: "project", projectPath \}/);
  assert.match(management, /to: \{ level: "global" \}/);
  assert.doesNotMatch(skills, /moveTarget\[/);
  // Opening the dialog resets its choice so a stale project is never sent.
  assert.match(skills, /setMoveProjectChoice\(""\);\s*\n\s*setMoveDestinationFor\(skill\)/);
});

test("project-mode global rows toggle an override and restore only that project's inheritance", () => {
  const management = read("../src/components/settings/useAgentSkillsManagement.ts");
  const model = read("../src/components/settings/skills-management-model.ts");
  // Provenance is the host's stored override state, never inferred from equal
  // booleans: the field alone decides.
  assert.match(model, /return skill\.enabledSource === "override"/);
  assert.match(model, /enabledSource\?: "inherited" \| "override"/);
  // Global management queries without a project path; Project management pairs
  // the global level with the selected project so rows carry provenance.
  assert.match(model, /if \(mode === "project" && projectPath\) return \{ level: "global", projectPath \}/);
  assert.match(management, /toggleQueryForRow\(captured\.scope, level\)/);
  // Reset clears exactly one project's stored override and the reload is the
  // truth; it is only offered on overridden rows.
  assert.match(
    management,
    /api\.resetUserSkillEnabled\(skill\.id, \{ level: "global", projectPath \}\)/,
  );
  assert.match(management, /if \(!projectPath \|\| !isSkillOverrideForProject\(skill\)\) return/);
  assert.match(skills, /\{overridden \? \(/);
  assert.match(skills, /settings\.skillRestoreInheritance/);
  assert.match(management, /settings\.skillInheritanceRestored/);
  assert.match(skills, /settings\.skillInheritedFromGlobal/);
  assert.match(skills, /settings\.skillOverriddenForProject/);
  assert.match(skills, /settings\.skillGlobalReadOnlyHint/);
  assert.match(skills, /settings\.skillOpenInGlobal/);
  assert.match(skills, /settings\.skillsBuiltinsGlobalOnlyHint/);
  // Selection and mode switches retire in-flight loads instead of showing them.
  assert.match(model, /createSkillsScopeGuard/);
  assert.match(model, /isCurrent\(captured: \{ token: number \}\)/);
  assert.match(management, /guard\.current\.isCurrent\(captured\)/);
});

test("MCP OAuth subscribe is owned by a ref cleaned up on unmount", () => {
  const mcpIpc = readMainModuleSync("ipc/mcp-ipc.ts");
  assert.match(mcp, /pendingOAuthRef/);
  assert.match(mcp, /useEffect\(\(\) => \{/);
  assert.match(mcp, /pendingOAuthRef\.current\?\.unsubscribe\(\)/);
  assert.match(mcp, /api\.onMcpOAuth\(/);
  assert.match(mcpIpc, /oauth\.start\(server\.id, server\.url, server\)/);
});
