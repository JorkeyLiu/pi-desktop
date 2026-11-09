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
const unit = () => document.querySelector(".settings-number-unit");
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
  const option = [...menu.querySelectorAll('[role="option"]')].find((el) => el.textContent.trim() === i18n.t("settings.subagentSelfHandoffKind" + (id === "time" ? "Runtime" : id === "tool-calls" ? "ToolCalls" : id === "context-tokens" ? "ContextTokens" : "Off")));
  // Fallback: match by option order when labels shift.
  const options = [...menu.querySelectorAll('[role="option"]')];
  // Options are ordered context size -> tool calls -> runtime -> off.
  const target = option ?? options[{ "context-tokens": 0, "tool-calls": 1, time: 2, off: 3 }[id]];
  check(target, "kind option missing: " + id);
  flushSync(() => target.click());
  await settle();
}
window.wakeProbe = async () => {
  await settle();
  // Initial single-kind row.
  // The row's visible left label is the feature name; the obsolete inner label
  // ("Progress check") survives only as the numeric field's accessible name.
  check(document.body.textContent.includes(i18n.t("settings.subagentWakeTitle")), "feature row label missing");
  check(!document.body.textContent.includes(i18n.t("settings.subagentWakeKind")), "obsolete inner row label must be gone");
  // Both rows share one option vocabulary, taken from the self-handoff row;
  // time is edited in minutes while the section still stores seconds.
  check(trigger().textContent.includes(i18n.t("settings.subagentSelfHandoffKindRuntime")), "selector did not show elapsed runtime: " + trigger().textContent);
  check(numberInput() && numberInput().value === "10", "initial 600s must read 10 minutes: " + (numberInput() && numberInput().value));
  check(unit() && unit().textContent.includes(i18n.t("settings.subagentSelfHandoffUnitMinutes")), "minutes unit missing: " + (unit() && unit().textContent));
  check(!document.body.textContent.includes("Wake on completion"), "completion toggle must be gone");

  // The cluster reads value -> unit -> selector in DOM order, so the selector is
  // the rightmost control and the figure sits to its left.
  const CLUSTER_CLASSES = [
    "settings-threshold-input",
    "settings-number-unit",
    "settings-threshold-select-sizer",
    "settings-menu-select-anchor",
  ];
  const clusterOrder = () => {
    const cluster = document.querySelector(".settings-threshold-control");
    check(cluster, "threshold cluster missing");
    return [...cluster.children].map(
      (el) => CLUSTER_CLASSES.find((name) => el.classList.contains(name)) ?? "(unexpected)",
    );
  };
  check(
    JSON.stringify(clusterOrder()) === JSON.stringify(CLUSTER_CLASSES),
    "value and unit must precede the selector: " + JSON.stringify(clusterOrder()),
  );
  check(!document.body.textContent.includes("Periodic check-in"), "old multi-row title must be gone");
  // Mandatory result helper (behind the row help icon).
  const help = document.querySelector(".settings-row .ui-help-icon");
  check(help && (help.getAttribute("aria-label") || "").includes("Subagent results always wake the parent"), "mandatory helper missing");

  // Every catalog names the context trigger as a size/count and both Subagent
  // execution cards show the literal k tokens unit.
  const contextLabels = {
    en: "Context size",
    de: "Kontextgröße",
    es: "Tamaño del contexto",
    fr: "Taille du contexte",
    ko: "컨텍스트 크기",
    "pt-BR": "Tamanho do contexto",
    tr: "Bağlam boyutu",
    "zh-CN": "上下文数",
    "zh-TW": "上下文數",
  };
  for (const [locale, label] of Object.entries(contextLabels)) {
    const catalog = flattenCatalog(catalogs[locale]);
    check(catalog["settings.subagentWakeKindContextTokens"] === label, locale + " wake context label: " + catalog["settings.subagentWakeKindContextTokens"]);
    check(catalog["settings.subagentSelfHandoffKindContextTokens"] === label, locale + " handoff context label: " + catalog["settings.subagentSelfHandoffKindContextTokens"]);
    check(catalog["settings.subagentWakeUnitTokens"] === "k tokens", locale + " wake unit: " + catalog["settings.subagentWakeUnitTokens"]);
    check(catalog["settings.subagentSelfHandoffUnitKTokens"] === "k tokens", locale + " handoff unit: " + catalog["settings.subagentSelfHandoffUnitKTokens"]);
  }

  // The wake feature's visible name now says what it does, and every catalog
  // carries it.
  const wakeTitles = {
    en: "Check subagent progress",
    de: "Fortschritt der Subagenten prüfen",
    es: "Comprobar el progreso del subagente",
    fr: "Vérifier la progression du subagent",
    ko: "하위 에이전트 진행 확인",
    "pt-BR": "Verificar o progresso do subagente",
    tr: "Alt ajan ilerlemesini denetle",
    "zh-CN": "主动检查子代理",
    "zh-TW": "主動檢查子代理",
  };
  for (const [locale, title] of Object.entries(wakeTitles)) {
    check(flattenCatalog(catalogs[locale])["settings.subagentWakeTitle"] === title, locale + " wake title: " + flattenCatalog(catalogs[locale])["settings.subagentWakeTitle"]);
  }
  // Both rows read one vocabulary: the wake row takes the self-handoff option
  // and unit keys, and the catalogs stay key-aligned.
  const localeKeys = Object.keys(catalogs);
  const referenceKeys = Object.keys(flattenCatalog(catalogs[localeKeys[0]])).sort();
  for (const locale of localeKeys) {
    const catalog = flattenCatalog(catalogs[locale]);
    const keys = Object.keys(catalog).sort();
    check(keys.length === referenceKeys.length && keys.every((key, index) => key === referenceKeys[index]), locale + " catalog keys must stay aligned");
    for (const key of [
      "subagentSelfHandoffKindContextTokens",
      "subagentSelfHandoffKindToolCalls",
      "subagentSelfHandoffKindRuntime",
      "subagentSelfHandoffKindOff",
      "subagentSelfHandoffUnitKTokens",
      "subagentSelfHandoffUnitCalls",
      "subagentSelfHandoffUnitMinutes",
    ]) {
      const text = catalog["settings." + key];
      check(typeof text === "string" && text.length > 0, locale + " missing shared vocabulary " + key);
    }
  }

  // Minutes UI: 2 minutes persist as 120 seconds, and blank reverts without a
  // write.
  setNumber("2");
  await settle();
  const afterSet = numberInput() ? numberInput().value : "<missing>";
  blurNumber();
  await settle(); await settle(); await new Promise((r) => setTimeout(r, 50));
  check(saves.length >= 1, "numeric save missing saves=" + saves.length + " stored=" + JSON.stringify(stored) + " input=" + afterSet + " now=" + (numberInput() ? numberInput().value : "<missing>"));
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "time", value: 120 }), "time save not canonical: " + JSON.stringify(saves[saves.length - 1]));
  check(numberInput().value === "2", "input did not keep 2 minutes");

  // Blank reverts without saving.
  const before = saves.length;
  setNumber("");
  await settle();
  blurNumber();
  await settle();
  check(numberInput().value === "2", "blank did not revert to 2");
  check(saves.length === before, "blank must not save");

  // A stored second count that is not a whole minute reads exactly and is not
  // rewritten by opening or leaving the field.
  const legacyBase = stored;
  for (const [seconds, shown] of [[90, "1.5"], [100, "1.67"]]) {
    flushSync(() => setSettingsState({ ...legacyBase, subagentWakeup: { kind: "time", value: seconds } }));
    await settle(); await settle();
    check(numberInput().value === shown, seconds + "s must read " + shown + " minutes: " + numberInput().value);
    const legacyBefore = saves.length;
    blurNumber();
    await settle(); await settle(); await new Promise((r) => setTimeout(r, 50));
    check(saves.length === legacyBefore, seconds + "s must not save on open or blur");
    check(numberInput().value === shown, seconds + "s must stay " + shown + " after blur: " + numberInput().value);
  }
  // Leaving time back to a whole minute still saves the exact seconds.
  setNumber("2");
  await settle();
  blurNumber();
  await settle(); await settle(); await new Promise((r) => setTimeout(r, 50));
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "time", value: 120 }), "an edited minute must persist seconds: " + JSON.stringify(saves[saves.length - 1]));

  // Context trigger: edited in k tokens, persisted as raw tokens, literal unit.
  await chooseKind("context-tokens");
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "context-tokens", value: 200000 }), "context switch must store the 200000-token default: " + JSON.stringify(saves[saves.length - 1]));
  check(numberInput().value === "200", "context must show 200 (k tokens): " + numberInput().value);
  check(unit().textContent === "k tokens", "context unit must be literal k tokens: " + unit().textContent);
  check(numberInput().getAttribute("step") === "1", "k-token field must step by one k");
  check(numberInput().getAttribute("min") === "1", "k-token field floor must be 1k");
  check(numberInput().getAttribute("max") === "1000", "k-token field ceiling must be 1000k");
  setNumber("80");
  await settle();
  blurNumber();
  await settle(); await settle(); await new Promise((r) => setTimeout(r, 50));
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "context-tokens", value: 80000 }), "k-token edit must store tokens: " + JSON.stringify(saves[saves.length - 1]));
  check(numberInput().value === "80", "context draft must keep 80");

  // A legacy token count that is not a whole thousand is shown exactly and is
  // never rewritten by a blur, a switch away, or a switch back.
  setNumber("1.5");
  await settle();
  blurNumber();
  await settle(); await settle(); await new Promise((r) => setTimeout(r, 50));
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "context-tokens", value: 1500 }), "fractional k edit must store exact tokens: " + JSON.stringify(saves[saves.length - 1]));
  const legacySaves = saves.length;
  blurNumber();
  await settle(); await settle(); await new Promise((r) => setTimeout(r, 50));
  check(saves.length === legacySaves, "an unchanged 1.5 must not save again");
  check(numberInput().value === "1.5", "1.5 must stay exact after blur");
  await chooseKind("tool-calls");
  await chooseKind("context-tokens");
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "context-tokens", value: 1500 }), "1.5k must survive a kind round trip: " + JSON.stringify(saves[saves.length - 1]));
  check(numberInput().value === "1.5", "draft must still read 1.5 after the round trip");

  // Switch kind: remembered per-kind default, atomic (no stale seconds).
  await chooseKind("tool-calls");
  check(JSON.stringify(saves[saves.length - 1].subagentWakeup) === JSON.stringify({ kind: "tool-calls", value: 50 }), "tool switch not atomic default: " + JSON.stringify(saves[saves.length - 1]));
  check(numberInput().value === "50", "tool draft not 50");
  check(unit().textContent.includes(i18n.t("settings.subagentSelfHandoffUnitCalls")), "calls unit missing: " + unit().textContent);

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
  // Off leaves no hidden focus target behind, and the selector keeps the same
  // reserved columns to its left — it is still the cluster's last child.
  check(!unit(), "unit must hide when off");
  check(
    JSON.stringify(clusterOrder()) === JSON.stringify([
      "settings-threshold-select-sizer",
      "settings-menu-select-anchor",
    ]),
    "off must keep only the selector: " + JSON.stringify(clusterOrder()),
  );

  // Error preserves the selector position (stored unchanged).
  failNext = true;
  await chooseKind("time");
  await settle();
  check(JSON.stringify(stored.subagentWakeup) === JSON.stringify({ kind: "off" }), "failed save must not change stored: " + JSON.stringify(stored));
  check(toasts.some((m) => m.includes("host refused")), "error toast missing");
  check(trigger().textContent.includes(i18n.t("settings.subagentSelfHandoffKindOff")), "selector must revert to off after failure");

  // A settings document written before this section existed at all resolves to
  // the canonical 900s default (15 minutes) and is not written back untouched.
  flushSync(() => setSettingsState({}));
  await settle(); await settle();
  check(numberInput() && numberInput().value === "15", "missing wake settings must read the 900s default as 15 minutes: " + (numberInput() && numberInput().value));
  check(unit() && unit().textContent.includes(i18n.t("settings.subagentSelfHandoffUnitMinutes")), "default 900s must show the minutes unit");
  const missingSaves = saves.length;
  blurNumber();
  await settle(); await settle(); await new Promise((r) => setTimeout(r, 50));
  check(saves.length === missingSaves, "an untouched default must not be written back");
  check(numberInput().value === "15", "the default must still read 15 minutes");

  flushSync(() => rootNode.unmount());
  return { passed: true, saves };
};
`;

test("subagent wake kind: single selector, k-token context field persists raw tokens, off hides numeric, errors preserve", {
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
