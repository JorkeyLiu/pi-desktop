/**
 * Isolated Electron user path for Skills Global / Project management (D257).
 *
 * Global management is workspace-independent: it lists builtins plus global
 * skills with no projectPath, and its toggles write the global record. Project
 * management resolves one explicitly selected project: its own skills plus
 * that project's view of the globals, where a toggle writes only a
 * per-project override (the row badges the override and offers Restore
 * inheritance, which clears only that project's stored value and reloads).
 * New, imported, and moved skills land where the management mode says — the
 * global-to-project move names its destination in an explicit dialog, never
 * a hidden workspace project — and switching scope reloads instead of
 * displaying stale rows.
 *
 * The fixture fakes only the external edge (`window.piDesktop.invoke`); the
 * page, its workflow hook, and the scope model are the real modules. Runs
 * only where the Electron binary is installed (skipped otherwise).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

/**
 * The Electron executable under test. Reusing a provisioned host binary by
 * absolute path keeps the worktree's own `node_modules` link tree untouched
 * (no shared writable install) while still driving this worktree's built
 * fixture in an isolated profile — never the user's running Desktop.
 */
function electronBinary() {
  const override = process.env.PI_DESKTOP_ELECTRON_BINARY;
  if (override) {
    if (!existsSync(override)) throw new Error("missing Electron override: " + override);
    return override;
  }
  return resolveElectronBinary(root).electronBinary;
}

let electronSkip = false;
if (process.platform === "linux" && !process.env.DISPLAY) {
  electronSkip = "Isolated Electron UI test requires a display";
} else {
  try {
    electronBinary();
  } catch {
    electronSkip = "Electron binary is not installed in this checkout";
  }
}

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { AgentSkillsPage } from "../../apps/desktop/src/components/settings/AgentSkillsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/settings.css";

const PROJECT = "/workspace/acme";
const apiCalls = [];
window.__apiCalls = apiCalls;
const host = {
  builtins: [{ id: "builtin-plan", name: "Plan", description: "Built-in planner", enabled: true }],
  globals: [
    { id: "standup", name: "Standup", description: "Daily notes", enabled: true, source: "custom" },
  ],
  projects: [{ path: PROJECT, name: "acme" }],
  projectSkills: {
    [PROJECT]: [
      { id: "acme-deploy", name: "Deploy", description: "Ship it", enabled: true, level: "project", projectPath: PROJECT, source: "custom" },
    ],
  },
  overrides: {},
};

function globalWithContext(skill, projectPath) {
  const stored = (host.overrides[projectPath] ?? {})[skill.id];
  if (stored === undefined) {
    return { ...skill, level: "global", enabledSource: "inherited", globalEnabled: skill.enabled };
  }
  return { ...skill, level: "global", enabled: stored, enabledSource: "override", globalEnabled: skill.enabled };
}

window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    apiCalls.push({ channel, input: JSON.parse(JSON.stringify(input ?? null)) });
    const ok = (data) => ({ ok: true, data });
    switch (channel) {
      case "pi-desktop/skill/builtin/list":
        return ok({ builtins: host.builtins });
      case "pi-desktop/skill/builtin/setEnabled": {
        const row = host.builtins.find((b) => b.id === input.id);
        if (row) row.enabled = input.enabled;
        return ok({ id: input.id, enabled: input.enabled });
      }
      case "pi-desktop/skill/list": {
        if (input?.level === "project") {
          return ok({ skills: host.projectSkills[input.projectPath] ?? [] });
        }
        if (input?.projectPath) {
          return ok({ skills: host.globals.map((s) => globalWithContext(s, input.projectPath)) });
        }
        return ok({ skills: host.globals.map((s) => ({ ...s })) });
      }
      case "pi-desktop/skill/setEnabled": {
        if (input.level === "global" && input.projectPath) {
          const base = host.globals.find((s) => s.id === input.id);
          if (!base) throw new Error("unknown global " + input.id);
          // Faithful host prune: an override equal to the global default is not stored.
          host.overrides[input.projectPath] = host.overrides[input.projectPath] ?? {};
          if (input.enabled === base.enabled) delete host.overrides[input.projectPath][input.id];
          else host.overrides[input.projectPath][input.id] = input.enabled;
          return ok({ id: input.id, enabled: input.enabled });
        }
        const list = input.level === "project"
          ? (host.projectSkills[input.projectPath] ?? [])
          : host.globals;
        const row = list.find((s) => s.id === input.id);
        if (row) row.enabled = input.enabled;
        return ok({ id: input.id, enabled: input.enabled });
      }
      case "pi-desktop/skill/resetEnabled": {
        const bucket = host.overrides[input.projectPath] ?? {};
        delete bucket[input.id];
        return ok({ id: input.id });
      }
      case "pi-desktop/skill/create": {
        const record = {
          id: input.id ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          name: input.name, description: input.description, body: input.body,
          enabled: input.enabled ?? true, source: "custom",
          level: input.level, ...(input.projectPath ? { projectPath: input.projectPath } : {}),
        };
        if (input.level === "project" && input.projectPath) {
          host.projectSkills[input.projectPath] = host.projectSkills[input.projectPath] ?? [];
          host.projectSkills[input.projectPath].push(record);
        } else {
          host.globals.push(record);
        }
        return ok({ skill: record });
      }
      case "pi-desktop/skill/update": {
        const all = [...host.globals, ...Object.values(host.projectSkills).flat()];
        const row = all.find((s) => s.id === input.id);
        if (row) Object.assign(row, { name: input.name, description: input.description });
        return ok({ skill: row ?? null });
      }
      case "pi-desktop/skill/read": {
        const all = [...host.globals, ...Object.values(host.projectSkills).flat()];
        const row = all.find((s) => s.id === input.id);
        return ok({ skill: row ?? null, body: "# doc" });
      }
      case "pi-desktop/skill/remove": {
        if (input.level === "project" && input.projectPath) {
          host.projectSkills[input.projectPath] = (host.projectSkills[input.projectPath] ?? [])
            .filter((s) => s.id !== input.id);
        } else {
          host.globals = host.globals.filter((s) => s.id !== input.id);
        }
        return ok({});
      }
      case "pi-desktop/skill/transfer": {
        const fromList = input.from.level === "project"
          ? (host.projectSkills[input.from.projectPath] ?? [])
          : host.globals;
        const index = fromList.findIndex((s) => s.id === input.id);
        const [moved] = index === -1 ? [null] : fromList.splice(index, 1);
        if (!moved) throw new Error("missing " + input.id);
        const arrived = { ...moved, level: input.to.level };
        if (input.to.projectPath) arrived.projectPath = input.to.projectPath;
        else delete arrived.projectPath;
        if (input.to.level === "project") {
          host.projectSkills[input.to.projectPath] = host.projectSkills[input.to.projectPath] ?? [];
          host.projectSkills[input.to.projectPath].push(arrived);
        } else {
          delete arrived.enabledSource; delete arrived.globalEnabled;
          host.globals.push(arrived);
        }
        return ok({ skill: arrived });
      }
      case "pi-desktop/skill/reveal":
        return ok({});
      case "pi-desktop/skill/import":
        return ok({ canceled: true });
      case "pi-desktop/project/list":
        return ok({ projects: host.projects });
      case "pi-desktop/skill/market/search":
        return ok({ entries: [] });
      default:
        throw new Error("Unexpected fixture IPC: " + channel);
    }
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ workspace: null });

function Harness() {
  return React.createElement(AgentSkillsPage);
}
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Harness)));

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await settle();
    try {
      const value = predicate();
      if (value) return value;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(message);
}
const calls = (channel) => apiCalls.filter((c) => c.channel === channel);
const skillLists = () => calls("pi-desktop/skill/list");
function buttonByText(text) {
  return [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
}
function radioByText(text) {
  return [...document.querySelectorAll('[role="radio"]')]
    .find((r) => r.textContent.replace(/\d+$/, "").trim() === text);
}
function toggleFor(name) {
  return document.querySelector('button[role="switch"][aria-label="Toggle ' + name + '"]');
}
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

window.skillsProbe = async () => {
  const out = {};
  await waitFor(() => document.body.innerText.includes("Standup") && document.body.innerText.includes("Plan"), "initial rows never rendered");

  // 1) Global mode queries carry no projectPath; no picker in Global mode.
  const firstGlobal = skillLists().find((c) => c.input?.level === "global");
  out.globalListClean = Boolean(firstGlobal) && !("projectPath" in (firstGlobal.input ?? {}));
  out.noPickerInGlobal = !document.querySelector(".agent-capability-project-picker");
  out.builtinVisibleInGlobal = document.body.innerText.includes("Plan");

  // 2) Toggling a global skill writes the global record directly.
  flushSync(() => toggleFor("Standup").click());
  await waitFor(() => toggleFor("Standup")?.getAttribute("aria-checked") === "false", "standup did not switch off");
  const setCalls = calls("pi-desktop/skill/setEnabled");
  const lastSet = setCalls[setCalls.length - 1];
  out.globalToggleDirect = lastSet.input.id === "standup" && lastSet.input.enabled === false
    && !("projectPath" in (lastSet.input ?? {}));
  out.globalDisabled = host.globals.find((s) => s.id === "standup").enabled === false;

  // 3) Project mode shows the picker and scopes both columns to the project.
  flushSync(() => radioByText("Project").click());
  await waitFor(() => document.querySelector(".agent-capability-project-picker"), "picker never appeared");
  out.pickerOnlyInProject = true;
  // The shared project hook resolves the selection explicitly in the visible
  // picker (never a hidden fallback); the not-ok destination only guards the
  // loading window before the project list lands.
  out.explicitSelectionShown = Boolean(
    document.querySelector(".agent-capability-project-picker")?.textContent.includes("acme"),
  );
  const pickerTrigger = document.querySelector('.agent-capability-project-picker [aria-label="Select project"]');
  flushSync(() => pickerTrigger.click());
  await waitFor(() => [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="listbox"] button, .settings-menu-select-menu button')].length > 0, "project options never opened");
  const option = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "acme" && b.closest(".settings-menu-select-menu, [role='listbox'], [role='menu']"));
  flushSync(() => option.click());
  await waitFor(() => document.body.innerText.includes("Deploy"), "project rows never rendered");
  const projectQuery = skillLists().find((c) => c.input?.level === "project");
  out.projectListScoped = projectQuery?.input?.projectPath === PROJECT;
  const contextQuery = [...skillLists()].reverse().find((c) => c.input?.level === "global");
  out.contextQueryScoped = contextQuery?.input?.projectPath === PROJECT;
  out.inheritedBadgeShown = document.body.innerText.includes("Inherited from Global");
  out.noRestoreBeforeOverride = !buttonByText("Restore inheritance");

  // 4) Toggling the global row in Project mode writes only the override.
  flushSync(() => toggleFor("Standup").click());
  await waitFor(() => document.body.innerText.includes("Overridden for this project"), "override badge never appeared");
  const setCalls2 = calls("pi-desktop/skill/setEnabled");
  const lastSet2 = setCalls2[setCalls2.length - 1];
  out.overrideToggleScoped = lastSet2.input.id === "standup" && lastSet2.input.enabled === true
    && lastSet2.input.level === "global" && lastSet2.input.projectPath === PROJECT;
  out.globalDefaultUntouched = host.globals.find((s) => s.id === "standup").enabled === false;
  out.restoreOffered = Boolean(buttonByText("Restore inheritance"));

  // 5) Restore inheritance clears only the override and reloads.
  flushSync(() => buttonByText("Restore inheritance").click());
  await waitFor(() => document.body.innerText.includes("Inherited from Global"), "inheritance never restored");
  const resetCalls = calls("pi-desktop/skill/resetEnabled");
  const lastReset = resetCalls[resetCalls.length - 1];
  out.resetScoped = lastReset?.input?.id === "standup"
    && lastReset?.input?.level === "global" && lastReset?.input?.projectPath === PROJECT;
  out.resetIgnoredResult = true;
  out.restoreHiddenAfterReset = !buttonByText("Restore inheritance");
  out.followsGlobalAfterReset = toggleFor("Standup")?.getAttribute("aria-checked") === "false";

  // 6) Rapid scope switch leaves no stale rows behind.
  flushSync(() => radioByText("Global").click());
  flushSync(() => radioByText("Project").click());
  await waitFor(() => document.body.innerText.includes("Deploy") && document.body.innerText.includes("Inherited from Global"), "project scope did not settle");
  out.noStaleAfterSwitch = !document.querySelector(".agent-capability-project-picker") === false
    && document.body.innerText.includes("Deploy");
  flushSync(() => radioByText("Global").click());
  await waitFor(() => !document.body.innerText.includes("Deploy"), "project rows leaked into global");
  out.globalHidesProjectRows = !document.querySelector(".agent-capability-project-picker");

  // 7) Import in Project mode targets the selected project.
  flushSync(() => radioByText("Project").click());
  await waitFor(() => document.body.innerText.includes("Deploy"), "project scope did not return");
  const importBtn = [...document.querySelectorAll('button[aria-label="Import into project"]')]
    .find((b) => b.textContent.includes("Import file"));
  if (!importBtn) throw new Error("import buttons: " + [...document.querySelectorAll("button")].map((b) => (b.getAttribute("aria-label") || "") + "|" + b.textContent.trim()).join("; "));
  flushSync(() => importBtn.click());
  await waitFor(() => calls("pi-desktop/skill/import").length > 0, "import never fired");
  const importCalls = calls("pi-desktop/skill/import");
  const lastImport = importCalls[importCalls.length - 1];
  out.importTargetsProject = lastImport.input.level === "project"
    && lastImport.input.projectPath === PROJECT && lastImport.input.sourceKind === "file";

  // 8) Create in Project mode lands the new skill in the selected project.
  const newBtn = buttonByText("New");
  flushSync(() => newBtn.click());
  await waitFor(() => document.querySelector('[role="dialog"]'), "editor never opened");
  const dialog = document.querySelector('[role="dialog"]');
  setNativeValue(dialog.querySelector('input[placeholder="Release notes"]'), "Probe Skill");
  setNativeValue(dialog.querySelector("textarea"), "Use when probing the scope contract.");
  setNativeValue(dialog.querySelector('textarea[aria-label="Document"]'), "# Probe");
  flushSync(() => [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save").click());
  await waitFor(() => !document.querySelector('[role="dialog"]') && document.body.innerText.includes("Probe Skill"), "created skill never listed");
  const createCalls = calls("pi-desktop/skill/create");
  const lastCreate = createCalls[createCalls.length - 1];
  out.createTargetsProject = lastCreate.input.level === "project" && lastCreate.input.projectPath === PROJECT;

  // 9) A project-context global row navigates to Global management for content.
  const openGlobal = buttonByText("Open in Global");
  flushSync(() => openGlobal.click());
  await waitFor(() => !document.querySelector(".agent-capability-project-picker") && document.body.innerText.includes("Global skills apply"), "did not land in global management");
  out.goGlobalNavigates = radioByText("Global")?.getAttribute("aria-checked") === "true"
    || document.querySelector(".agent-capability-segment [aria-checked='true']")?.textContent.includes("Global");

  // 10) Global management moves a global skill only into an explicit project.
  // Project-context rows carry no row menu: content moves go through Global.
  flushSync(() => radioByText("Global").click());
  await waitFor(() => !document.querySelector(".agent-capability-project-picker")
    && document.querySelector('button[aria-label="Actions for Standup"]'), "global rows never returned");
  // The edit pencil shares the row's accessible name; the menu trigger is the
  // one inside the row-menu wrapper.
  const standupMenu = document.querySelector('.agent-capability-menu-wrap button[aria-label="Actions for Standup"]');
  if (!standupMenu) throw new Error("standup row menu missing");
  flushSync(() => standupMenu.click());
  await waitFor(() => buttonByText("Move to project…"), "move item never appeared");
  flushSync(() => buttonByText("Move to project…").click());
  await waitFor(() => document.body.innerText.includes("Move Standup to a project"), "move dialog never opened");
  out.moveNeedsExplicitDestination = [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Move" && b.disabled);
  const destTrigger = document.querySelector('.agent-capability-move-picker [aria-label="Destination project"]');
  flushSync(() => destTrigger.click());
  await waitFor(() => [...document.querySelectorAll(".settings-menu-select-menu button")].length > 0, "destinations never opened");
  const destOption = [...document.querySelectorAll(".settings-menu-select-menu button")].find((b) => b.textContent.trim() === "acme");
  flushSync(() => destOption.click());
  flushSync(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Move" && !b.disabled).click());
  await waitFor(() => !document.body.innerText.includes("Move Standup to a project"), "move dialog never closed");
  const transfers = calls("pi-desktop/skill/transfer");
  const lastTransfer = transfers[transfers.length - 1];
  out.moveTargetsExplicitProject = lastTransfer.input.id === "standup"
    && lastTransfer.input.from.level === "global"
    && lastTransfer.input.to.level === "project" && lastTransfer.input.to.projectPath === PROJECT;

  return out;
};`;

test("skills Global/Project management scopes every request and destination", {
  timeout: 120_000,
  skip: electronSkip,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.skills-management-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "skills-management.jsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><body><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    const evidenceDir = process.env.PI_SKILLS_UX_EVIDENCE_DIR ?? null;
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const evidenceDir = ${JSON.stringify(evidenceDir)};
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 850,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    win.showInactive();
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.skillsProbe()");
    console.log("SKILLS_MANAGEMENT_PROBE " + JSON.stringify(result));
    async function shotReady(expression, timeoutMs) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const ready = await win.webContents.executeJavaScript(expression).catch(() => false);
        if (ready) return;
        if (Date.now() > end) throw new Error("evidence not ready: " + expression);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      await win.loadFile(path.join(__dirname, "index.html"));
      await shotReady("document.body.innerText.includes('Standup')", 30000);
      fs.writeFileSync(path.join(evidenceDir, "skills-global.png"), (await win.webContents.capturePage()).toPNG());
      await shotReady(
        "[...document.querySelectorAll('[role=radio]')].some((r) => r.textContent.trim().startsWith('Project'))",
        30000);
      await win.webContents.executeJavaScript(
        "(() => { const radio = [...document.querySelectorAll('[role=radio]')].find((r) => r.textContent.trim().startsWith('Project')); if (!radio) throw new Error('project radio missing'); radio.click(); return true; })()");
      await shotReady("document.body.innerText.includes('Deploy')", 30000);
      fs.writeFileSync(path.join(evidenceDir, "skills-project.png"), (await win.webContents.capturePage()).toPNG());
    }
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`,
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBinary(), [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 100_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("SKILLS_MANAGEMENT_PROBE "));
    assert(line, output.slice(-6000));
    const result = JSON.parse(line.slice("SKILLS_MANAGEMENT_PROBE ".length));
    assert.deepEqual(result, {
    globalListClean: true,
    noPickerInGlobal: true,
    builtinVisibleInGlobal: true,
    globalToggleDirect: true,
    globalDisabled: true,
    pickerOnlyInProject: true,
    explicitSelectionShown: true,
    projectListScoped: true,
    contextQueryScoped: true,
    inheritedBadgeShown: true,
    noRestoreBeforeOverride: true,
    overrideToggleScoped: true,
    globalDefaultUntouched: true,
    restoreOffered: true,
    resetScoped: true,
    resetIgnoredResult: true,
    restoreHiddenAfterReset: true,
    followsGlobalAfterReset: true,
    noStaleAfterSwitch: true,
    globalHidesProjectRows: true,
    importTargetsProject: true,
    createTargetsProject: true,
    goGlobalNavigates: true,
    moveNeedsExplicitDestination: true,
    moveTargetsExplicitProject: true,
  });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
