import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { SubagentWakeSettings } from "../../apps/desktop/src/components/settings/SubagentWakeSettings";
import { createSerializedSaver, mergeSettingsPatch } from "../../apps/desktop/src/lib/subagent-settings-save";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/settings.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
const toasts = [];
useAppStore.setState({ showToast: (message) => { toasts.push(String(message)); } });
window.piDesktop = { platform: "linux", on() { return () => {}; },
  invoke() { throw new Error("Unexpected IPC in wake-kind test"); } };
let stored = { subagentWakeup: { kind: "time", value: 600 } };
let failNext = false;
const saves = [];
const queue = createSerializedSaver();
let setSettingsState = null;
async function saveSettings(patch) {
  return queue.enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (failNext) { failNext = false; throw new Error("host refused"); }
    saves.push(JSON.parse(JSON.stringify(patch)));
    const current = stored;
    const next = mergeSettingsPatch(current, patch);
    stored = next;
    flushSync(() => setSettingsState(next));
  });
}
function Surface() {
  const [settings, setSettings] = React.useState(stored);
  setSettingsState = setSettings;
  // Keep module-level stored in sync for the probe.
  React.useEffect(() => { stored = settings; }, [settings]);
  return React.createElement(SubagentWakeSettings, { settings, saveSettings });
}
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Surface)));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
const trigger = () => document.querySelector(".settings-menu-select-trigger");
const numberInput = () => document.querySelector('input[type="number"]');
const unit = () => document.querySelector(".settings-wake-unit");
function setNumber(value) {
  const input = numberInput();
  check(input, "numeric input missing");
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function blurNumber() {
  const input = numberInput();
  check(input, "numeric input missing for blur");
  // Headless windows may not take focus, so fire the blur path explicitly.
  try { input.blur(); } catch {}
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
}
async function chooseKind(id) {
  flushSync(() => trigger().click());
  await settle();
  const menu = document.body.querySelector('[role="listbox"]');
  check(menu, "kind menu did not open");
  const option = [...menu.querySelectorAll('[role="option"]')].find((el) => el.textContent.trim() === i18n.t("settings.subagentWakeKind" + (id === "time" ? "Time" : id === "tool-calls" ? "ToolCalls" : id === "context-tokens" ? "ContextTokens" : "Off")));
  // Fallback: match by option order when labels shift.
  const options = [...menu.querySelectorAll('[role="option"]')];
  const target = option ?? options[{ time: 0, "tool-calls": 1, "context-tokens": 2, off: 3 }[id]];
  check(target, "kind option missing: " + id);
  flushSync(() => target.click());
  await settle();
}
window.wakeProbe = async () => {
  await settle();
  // Initial single-kind row.
  check(document.body.textContent.includes(i18n.t("settings.subagentWakeKind")), "kind row title missing");
  check(document.body.textContent.includes(i18n.t("settings.subagentWakeKindTime")), "time option label missing");
  check(trigger().textContent.includes(i18n.t("settings.subagentWakeKindTime")), "selector did not show time");
  check(numberInput() && numberInput().value === "600", "initial value not 600: " + (numberInput() && numberInput().value));
  check(unit() && unit().textContent.includes(i18n.t("settings.subagentWakeUnitSeconds")), "seconds unit missing");
  check(!document.body.textContent.includes("Wake on completion"), "completion toggle must be gone");
  check(!document.body.textContent.includes("Periodic check-in"), "old multi-row title must be gone");
  // Mandatory result helper (behind the row help icon).
  const help = document.querySelector(".settings-row .ui-help-icon");
  check(help && (help.getAttribute("aria-label") || "").includes("Subagent results always wake the parent"), "mandatory helper missing");

  // Numeric blur persists canonical time value.
  setNumber("120");
  await settle();
  const afterSet = numberInput() ? numberInput().value : "<missing>";
  blurNumber();
  await settle(); await settle(); await new Promise((r) => setTimeout(r, 50));
  check(saves.length >= 1, "numeric save missing saves=" + saves.length + " stored=" + JSON.stringify(stored) + " input=" + afterSet + " now=" + (numberInput() ? numberInput().value : "<missing>"));
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "time", value: 120 }), "time save not canonical: " + JSON.stringify(saves[saves.length - 1]));
  check(numberInput().value === "120", "input did not keep 120");

  // Blank reverts without saving.
  const before = saves.length;
  setNumber("");
  await settle();
  blurNumber();
  await settle();
  check(numberInput().value === "120", "blank did not revert to 120");
  check(saves.length === before, "blank must not save");

  // Switch kind: remembered per-kind default, atomic (no stale seconds).
  await chooseKind("tool-calls");
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "tool-calls", value: 10 }), "tool switch not atomic default: " + JSON.stringify(saves[saves.length - 1]));
  check(numberInput().value === "10", "tool draft not 10");
  check(unit().textContent.includes(i18n.t("settings.subagentWakeUnitCalls")), "calls unit missing");

  setNumber("25");
  await settle();
  blurNumber();
  await settle(); await settle();
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "tool-calls", value: 25 }), "tool value save wrong");

  // Rapid numeric edits: last write wins whole.
  setNumber("30");
  await settle();
  blurNumber();
  setNumber("31");
  await settle();
  blurNumber();
  await settle(); await settle(); await settle();
  check(stored.subagentWakeup.kind === "tool-calls" && stored.subagentWakeup.value === 31, "rapid saves lost: " + JSON.stringify(stored));

  // Off hides the numeric field.
  await chooseKind("off");
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "off" }), "off save must carry no value");
  check(!numberInput(), "numeric must hide when off");

  // Error preserves the selector position (stored unchanged).
  failNext = true;
  await chooseKind("time");
  await settle();
  check(JSON.stringify(stored.subagentWakeup) === JSON.stringify({ kind: "off" }), "failed save must not change stored: " + JSON.stringify(stored));
  check(toasts.some((m) => m.includes("host refused")), "error toast missing");
  check(trigger().textContent.includes(i18n.t("settings.subagentWakeKindOff")), "selector must revert to off after failure");

  flushSync(() => rootNode.unmount());
  return { passed: true, saves };
};
`;

test("subagent wake kind: single selector persists canonical, off hides numeric, errors preserve", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.wake-kind-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("WAKE_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.wakeProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-8000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("WAKE_PROBE "));
    assert.ok(line, output.slice(-8000));
    const result = JSON.parse(line.slice("WAKE_PROBE ".length));
    assert.equal(result.passed, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
