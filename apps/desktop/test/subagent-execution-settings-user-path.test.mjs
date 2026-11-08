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
import { IPC } from "@pi-desktop/shared";
import { AgentSubagentsPage } from "../../apps/desktop/src/components/settings/AgentSubagentsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/base.css";
import "../../apps/desktop/src/styles/ui-kit.css";
import "../../apps/desktop/src/styles/settings.css";

// The bundled stylesheet cannot resolve Tailwind's @theme scales, so the field
// metric and the type ramp the threshold cluster reads are declared for the
// harness exactly as the app's token block does at font scale 1.
document.documentElement.style.setProperty("--ds-field-height", "38px");
document.documentElement.style.setProperty("--text-sm-plus", "12.5px");
document.documentElement.style.setProperty("--text-sm", "12px");
document.documentElement.style.setProperty("--text-base", "14px");

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });

const toasts = [];
useAppStore.setState({ showToast: (message) => { toasts.push(String(message)); } });

// A minimal host: settings are read back from what was written, so a save is
// observable the same way the real renderer observes it.
let hostSettings = {
  enterToSend: true,
  language: "en",
  subagentWakeup: { kind: "time", value: 600 },
  // No subagentSelfHandoff: the shape every settings document written before
  // the feature existed. It must read as off.
};
const saves = [];
window.piDesktop = {
  platform: "linux",
  on() { return () => {}; },
  async invoke(channel, payload) {
    if (channel === IPC.invoke.settingsSet) {
      saves.push(JSON.parse(JSON.stringify(payload)));
      hostSettings = payload;
      return { ok: true, value: payload };
    }
    if (channel === IPC.invoke.settingsGet) return { ok: true, value: hostSettings };
    if (channel === IPC.invoke.providersList) return { ok: true, value: { providers: [] } };
    if (channel === IPC.invoke.sessionList) return { ok: true, value: { sessions: [] } };
    if (channel === IPC.invoke.subagentList) return { ok: true, value: { subagents: [] } };
    if (channel === IPC.invoke.subagentCatalog) return { ok: true, value: { subagents: [], builtins: [] } };
    return { ok: true, value: {} };
  },
};
useAppStore.setState({ settings: hostSettings });

const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(AgentSubagentsPage)));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); await frame(); }
async function settleSave() { await settle(); await new Promise((r) => setTimeout(r, 40)); await settle(); }
function check(condition, message) { if (!condition) throw new Error(message); }

const text = () => document.body.textContent || "";
// The two execution rows are full-width siblings under the one section
// heading; each row's visible left label is its feature name.
const executionSection = () =>
  document.getElementById("subagent-execution-heading")?.closest("section") ?? null;
const executionRows = () => [...(executionSection()?.querySelectorAll(".settings-row") ?? [])];
const rowLabel = (el) => el.querySelector(".settings-row-title")?.textContent.trim() ?? "";
const rowFor = (name) => executionRows().find((el) => rowLabel(el) === name) ?? null;
const triggerIn = (el) => el.querySelector(".settings-menu-select-trigger");
const numberIn = (el) => el.querySelector('input[type="number"]');
const unitIn = (el) => el.querySelector(".settings-number-unit");
const controlIn = (el) => el.querySelector(".settings-row-control");
const rect = (el) => el.getBoundingClientRect();
function setNumber(el, value) {
  const input = numberIn(el);
  check(input, "numeric input missing");
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function blurNumber(el) {
  const input = numberIn(el);
  try { input.blur(); } catch {}
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
}
async function chooseOption(el, id) {
  flushSync(() => triggerIn(el).click());
  await settle();
  const menu = document.body.querySelector('[role="listbox"]');
  check(menu, "trigger menu did not open");
  const options = [...menu.querySelectorAll('[role="option"]')];
  // Both execution cards use the shared selector; match the option by its
  // label in either card's namespace, then fall back to its position.
  const labels = {
    "context-tokens": ["settings.subagentSelfHandoffKindContextTokens"],
    "tool-calls": ["settings.subagentSelfHandoffKindToolCalls"],
    runtime: ["settings.subagentSelfHandoffKindRuntime"],
    time: ["settings.subagentSelfHandoffKindRuntime"],
    off: ["settings.subagentSelfHandoffKindOff"],
  }[id] ?? [];
  const order = { "context-tokens": 0, "tool-calls": 1, runtime: 2, time: 0, off: 3 };
  const target = options.find((option) => option.dataset.value === id || option.getAttribute("data-value") === id)
    ?? options.find((option) => labels.some((key) => option.textContent.trim() === i18n.t(key)))
    ?? options[order[id]];
  check(target, "option missing: " + id);
  flushSync(() => target.click());
  await settleSave();
}
const lastSave = () => saves[saves.length - 1];
// Read a row's option texts without choosing one: open, read, close again.
async function optionTexts(row) {
  flushSync(() => triggerIn(row).click());
  await settle();
  const menu = document.body.querySelector('[role="listbox"]');
  check(menu, "trigger menu did not open");
  const texts = [...menu.querySelectorAll('[role="option"]')].map((el) => el.textContent.trim());
  flushSync(() => triggerIn(row).click());
  await settle();
  return texts;
}

window.executionProbe = async () => {
// Geometry of the section: each row must fill the section width, keep its
// label on the left and its trigger cluster flush to the right edge, and never
// overflow.
function layoutProbe() {
  const section = executionSection();
  const stack = section.querySelector(".subagent-execution-rows");
  const rows = executionRows().map((row) => {
    const label = row.querySelector(".settings-row-title");
    const control = controlIn(row);
    const cluster = row.querySelector(".settings-threshold-control");
    return {
      width: rect(row).width,
      left: rect(row).left,
      top: rect(row).top,
      bottom: rect(row).bottom,
      rowRight: rect(row).right,
      paddingRight: parseFloat(getComputedStyle(row).paddingRight) || 0,
      labelLeft: rect(label).left,
      labelTop: rect(label).top,
      controlLeft: rect(control).left,
      controlTop: rect(control).top,
      controlRight: rect(control).right,
      clusterLeft: rect(cluster).left,
      clusterRight: rect(cluster).right,
      overflowX: row.scrollWidth - row.clientWidth,
      sectionOverflowX: section.scrollWidth - section.clientWidth,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  return { width: window.innerWidth, stackWidth: rect(stack).width, rows };
}
window.layoutProbe = layoutProbe;

// --- Reserved columns: the value, the unit and the selector each keep one
// column, read left to right, so switching kind changes neither the selector's
// x nor the value's — and the selector stays the cluster's rightmost control.
const wakeRowOf = () => executionRows()[0] ?? null;
const handoffRowOf = () => executionRows()[1] ?? null;


// The cluster's children in DOM order, named by the shared control classes: the
// numeric field, its unit, the hidden sizer, then the trigger. Off keeps only
// the selector pair.
const CLUSTER_CLASSES = [
  "settings-threshold-input",
  "settings-number-unit",
  "settings-threshold-select-sizer",
  "settings-menu-select-anchor",
];
const clusterOrder = (row) => {
  const cluster = row.querySelector(".settings-threshold-control");
  return [...cluster.children].map(
    (el) => CLUSTER_CLASSES.find((name) => el.classList.contains(name)) ?? "(unexpected)",
  );
};
const ENABLED_ORDER = CLUSTER_CLASSES;
const OFF_ORDER = ["settings-threshold-select-sizer", "settings-menu-select-anchor"];

function columnStamp(row) {
  const trigger = triggerIn(row);
  const input = numberIn(row);
  const unit = unitIn(row);
  const cluster = row.querySelector(".settings-threshold-control");
  const t = rect(trigger);
  const round = (value) => Math.round(value * 100) / 100;
  const inputStyle = input ? getComputedStyle(input) : null;
  return {
    triggerText: trigger.textContent.trim(),
    triggerLeft: round(t.left),
    triggerRight: round(t.right),
    triggerWidth: round(t.width),
    triggerHeight: round(t.height),
    inputLeft: input ? round(rect(input).left) : null,
    inputRight: input ? round(rect(input).right) : null,
    inputWidth: input ? round(rect(input).width) : null,
    inputHeight: input ? round(rect(input).height) : null,
    unitLeft: unit ? round(rect(unit).left) : null,
    unitRight: unit ? round(rect(unit).right) : null,
    unitWidth: unit ? round(rect(unit).width) : null,
    unitText: unit ? unit.textContent : null,
    unitTitle: unit ? unit.getAttribute("title") : null,
    unitClipped: unit ? unit.scrollWidth > unit.clientWidth + 1 : null,
    clusterLeft: round(rect(cluster).left),
    clusterRight: round(rect(cluster).right),
    clusterWidth: round(rect(cluster).width),
    domOrder: clusterOrder(row),
    rowRight: round(rect(row).right),
    rowPaddingRight: parseFloat(getComputedStyle(row).paddingRight) || 0,
    rowOverflowX: row.scrollWidth - row.clientWidth,
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    // Chromium resolves appearance: textfield as the suppressed state; the
    // default (auto) is the one that draws the stepper. The scratch rig proves
    // the rendered result, the assertion here proves the applied style.
    spinAppearance: input
      ? getComputedStyle(input, "::-webkit-inner-spin-button").appearance
      : null,
    inputAppearance: inputStyle ? inputStyle.appearance : null,
    tabularNumeric: inputStyle ? inputStyle.fontVariantNumeric : null,
    // The value is centred, not flush to the column's right edge, and the
    // selected label always fits the column the sizer reserves.
    textAlign: inputStyle ? inputStyle.textAlign : null,
    triggerLabelClipped: (() => {
      const label = trigger.querySelector(".settings-menu-select-trigger-label");
      return label ? label.scrollWidth > label.clientWidth + 1 : null;
    })(),
    sizerWidth: (() => {
      const sizer = row.querySelector(".settings-threshold-select-sizer");
      return sizer ? round(rect(sizer).width) : null;
    })(),
  };
}

function checkColumns(stamps, label, { narrow = false } = {}) {
  const first = stamps[0];
  for (const stamp of stamps) {
    check(
      Math.abs(stamp.triggerLeft - first.triggerLeft) <= 0.5,
      label + ": selector x must not move on " + stamp.triggerText + " (" + first.triggerLeft + " -> " + stamp.triggerLeft + ")",
    );
    check(
      Math.abs(stamp.triggerRight - first.triggerRight) <= 0.5,
      label + ": selector right edge must not move on " + stamp.triggerText + " (" + first.triggerRight + " -> " + stamp.triggerRight + ")",
    );
    check(
      Math.abs(stamp.triggerWidth - first.triggerWidth) <= 0.5,
      label + ": selector width must not follow the selected label on " + stamp.triggerText + " (" + first.triggerWidth + " -> " + stamp.triggerWidth + ")",
    );
    check(
      stamp.triggerLabelClipped === false,
      label + ": the selected label must fit its column on " + stamp.triggerText,
    );
    check(
      stamp.sizerWidth !== null && Math.abs(stamp.sizerWidth - stamp.triggerWidth) <= 0.5,
      label + ": the selector column must be the sizer's width on " + stamp.triggerText,
    );
    // Content-sized, not the retired fixed 180px box: the widest option only
    // needs its own label plus the trigger's padding and chevron.
    check(
      stamp.triggerWidth >= 88 && stamp.triggerWidth < 180,
      label + ": selector must be compact but usable, got " + stamp.triggerWidth + "px on " + stamp.triggerText,
    );
    check(stamp.rowOverflowX <= 1, label + ": row must not overflow on " + stamp.triggerText);
    check(stamp.pageOverflowX <= 1, label + ": page must not scroll sideways on " + stamp.triggerText);
    // Right alignment: the cluster ends on the row's content edge, and its
    // rightmost control is the selector — for every kind, off included, because
    // the value and unit columns stay reserved.
    const contentRight = stamp.rowRight - stamp.rowPaddingRight;
    check(
      Math.abs(stamp.clusterRight - contentRight) <= 1,
      label + ": cluster must sit flush to the row's right edge on " + stamp.triggerText + " (" + stamp.clusterRight + " vs " + contentRight + ")",
    );
    check(
      Math.abs(stamp.triggerRight - stamp.clusterRight) <= 0.5,
      label + ": the selector must be the cluster's rightmost control on " + stamp.triggerText + " (" + stamp.triggerRight + " vs " + stamp.clusterRight + ")",
    );
    check(
      JSON.stringify(stamp.domOrder) === JSON.stringify(stamp.inputLeft === null ? OFF_ORDER : ENABLED_ORDER),
      label + ": value, unit, then selector in DOM order on " + stamp.triggerText + ", got " + JSON.stringify(stamp.domOrder),
    );
  }
  const enabled = stamps.filter((stamp) => stamp.inputLeft !== null);
  check(enabled.length === 3, label + ": three kinds must show a numeric field, got " + enabled.length);
  const base = enabled[0];
  for (const stamp of enabled) {
    check(
      Math.abs(stamp.inputLeft - base.inputLeft) <= 0.5,
      label + ": value x must not move on " + stamp.triggerText + " (" + base.inputLeft + " -> " + stamp.inputLeft + ")",
    );
    check(
      Math.abs(stamp.inputWidth - base.inputWidth) <= 0.5,
      label + ": value width must not change on " + stamp.triggerText,
    );
    check(
      Math.abs(stamp.unitLeft - base.unitLeft) <= 0.5,
      label + ": unit x must not move on " + stamp.triggerText + " (" + base.unitLeft + " -> " + stamp.unitLeft + ")",
    );
    check(
      Math.abs(stamp.unitWidth - base.unitWidth) <= 0.5,
      label + ": unit column must stay reserved on " + stamp.triggerText,
    );
    // The figure and its unit sit to the LEFT of the trigger, the unit directly
    // beside the figure: value -> unit -> selector, never selector first.
    check(
      stamp.unitLeft >= stamp.inputRight + 7,
      label + ": the unit must follow the numeric field on " + stamp.triggerText + " (" + stamp.inputRight + " -> " + stamp.unitLeft + ")",
    );
    check(
      stamp.triggerLeft >= stamp.unitRight + 7,
      label + ": the selector must come after the unit on " + stamp.triggerText + " (" + stamp.unitRight + " -> " + stamp.triggerLeft + ")",
    );
    // Compact, spinner-free figure on the selector's own height.
    check(
      stamp.inputWidth >= 60 && stamp.inputWidth <= 68,
      label + ": numeric field must stay compact, got " + stamp.inputWidth + "px on " + stamp.triggerText,
    );
    check(
      Math.abs(stamp.inputHeight - stamp.triggerHeight) <= 1,
      label + ": numeric field must share the selector height, got " + stamp.inputHeight + " vs " + stamp.triggerHeight,
    );
    check(
      stamp.spinAppearance === "textfield" && stamp.inputAppearance === "textfield",
      label + ": native spinner must be suppressed, computed appearance was " + stamp.inputAppearance + "/" + stamp.spinAppearance,
    );
    check(
      stamp.tabularNumeric === "tabular-nums",
      label + ": numeric field must use tabular figures, got " + stamp.tabularNumeric,
    );
    check(
      stamp.textAlign === "center",
      label + ": numeric value must be centred, got " + stamp.textAlign + " on " + stamp.triggerText,
    );
    check(stamp.unitTitle === stamp.unitText, label + ": unit must carry its full text as title");
  }
  const off = stamps.find((stamp) => stamp.inputLeft === null);
  check(off, label + ": the off kind must be measured");
  check(
    Math.abs(off.clusterLeft - first.clusterLeft) <= 0.5,
    label + ": off must keep the selector in its column",
  );
  if (narrow) {
    check(first.triggerWidth > 60, label + ": the selector must stay usable when narrow, got " + first.triggerWidth);
  }
  return stamps;
}

async function measureColumns(row, kinds, label, options) {
  const stamps = [];
  for (const kind of kinds) {
    await chooseOption(row, kind);
    const stamp = columnStamp(row);
    stamp.requested = kind;
    stamps.push(stamp);
    if (kind === "off") {
      check(!numberIn(row), label + ": off must not leave a numeric field behind");
      check(!row.querySelector(".settings-number-unit"), label + ": off must not leave a unit behind");
    }
  }
  return checkColumns(stamps, label, options);
}

window.columnsProbe = async () => {
  const wake = await measureColumns(wakeRowOf(), ["context-tokens", "tool-calls", "time", "off"], "wake row");
  const handoff = await measureColumns(handoffRowOf(), ["context-tokens", "tool-calls", "runtime", "off"], "self-handoff row");
  check(Math.abs(wake[0].inputWidth - handoff[0].inputWidth) <= 0.5, "both rows must reserve one value width");
  check(Math.abs(wake[0].unitWidth - handoff[0].unitWidth) <= 0.5, "both rows must reserve one unit width");
  check(Math.abs(wake[0].triggerWidth - handoff[0].triggerWidth) <= 0.5, "both rows must reserve one selector width");

  // Paste/typing: a fractional k-token figure reaches the field through the
  // same input event a real paste produces and stores exact tokens.
  await chooseOption(handoffRowOf(), "context-tokens");
  const field = numberIn(handoffRowOf());
  field.focus();
  field.select();
  document.execCommand("insertText", false, "2.5");
  await settle();
  check(field.value === "2.5", "a pasted fractional figure must land in the field: " + field.value);
  blurNumber(handoffRowOf());
  await settleSave();
  check(
    JSON.stringify(lastSave().subagentSelfHandoff) === JSON.stringify({ kind: "context-tokens", value: 2500 }),
    "pasted 2.5k must store 2500 tokens: " + JSON.stringify(lastSave().subagentSelfHandoff),
  );
  // Leave both rows enabled so the remaining layout checks see their fields.
  await chooseOption(wakeRowOf(), "tool-calls");
  await chooseOption(handoffRowOf(), "tool-calls");
  return { passed: true, wake, handoff };
};

window.narrowColumnsProbe = async () => {
  check(window.innerWidth <= 420, "narrow column probe must run narrow: " + window.innerWidth);
  const wake = await measureColumns(wakeRowOf(), ["context-tokens", "tool-calls", "time", "off"], "narrow wake row", { narrow: true });
  const handoff = await measureColumns(handoffRowOf(), ["context-tokens", "tool-calls", "runtime", "off"], "narrow self-handoff row", { narrow: true });
  for (const [row, stamps] of [
    [wakeRowOf(), wake],
    [handoffRowOf(), handoff],
  ]) {
    for (const stamp of stamps) {
      check(
        stamp.clusterRight <= rect(row).right + 1,
        "narrow cluster must stay inside its row: " + stamp.clusterRight + " > " + rect(row).right,
      );
      check(
        stamp.clusterLeft >= rect(row).left - 1,
        "narrow cluster must start inside its row: " + stamp.clusterLeft + " < " + rect(row).left,
      );
    }
  }
  await chooseOption(wakeRowOf(), "time");
  await chooseOption(handoffRowOf(), "off");
  return { passed: true, wake, handoff, width: window.innerWidth };
};

  await settle();

  // --- Page hierarchy: the destination keeps its own title, and the page
  // groups the program-owned controls above the agent list.
  const executionHeading = document.getElementById("subagent-execution-heading");
  const availableHeading = document.getElementById("subagent-available-heading");
  check(executionHeading, "execution section heading missing");
  check(availableHeading, "available-subagents heading missing");
  check(executionHeading.tagName === "H2", "execution heading must be a section heading");
  check(executionHeading.textContent.includes(i18n.t("settings.subagentExecutionTitle")), "execution heading text wrong");
  check(availableHeading.textContent.includes(i18n.t("settings.subagentAvailableTitle")), "available heading text wrong");
  check(
    executionHeading.compareDocumentPosition(availableHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    "execution section must come before the agent list",
  );

  // Two full-width rows stacked inside the one execution section, each labelled
  // on its left by its feature name and carrying the trigger cluster on the
  // right.
  const wakeName = i18n.t("settings.subagentWakeTitle");
  const handoffName = i18n.t("settings.subagentSelfHandoffTitle");
  check(executionRows().length === 2, "expected two execution rows, got " + executionRows().length);
  const wakeRow = rowFor(wakeName);
  const handoffRow = rowFor(handoffName);
  check(wakeRow, "parent wake-up row missing");
  check(handoffRow, "self-handoff row missing");
  check(executionRows()[0] === wakeRow, "parent wake-up must be the first row");
  check(Boolean(wakeRow.closest(".subagent-execution-rows")), "rows must share the execution stack");
  // The feature name is the label INSIDE the row and appears exactly once in
  // the page: there is no card heading above or outside it, and the section's
  // own h2 stays the sole shared heading.
  const occurrences = (needle) => text().split(needle).length - 1;
  check(occurrences(wakeName) === 1, "wake feature name must label the row exactly once: " + occurrences(wakeName));
  check(occurrences(handoffName) === 1, "handoff feature name must label the row exactly once: " + occurrences(handoffName));
  check(rowLabel(wakeRow) === wakeName, "wake row label must be the feature name: " + rowLabel(wakeRow));
  check(rowLabel(handoffRow) === handoffName, "handoff row label must be the feature name: " + rowLabel(handoffRow));
  check(
    executionSection().querySelectorAll("h3").length === 0,
    "no per-row card heading may remain inside the execution section",
  );
  // The obsolete inner row labels are gone from the card text in both locales'
  // vocabulary: the feature name replaced them.
  for (const obsolete of ["settings.subagentWakeKind", "settings.subagentSelfHandoffKind"]) {
    check(!text().includes(i18n.t(obsolete)), "obsolete inner label must be gone: " + obsolete);
  }
  // Each row keeps its help tooltip beside the visible feature name.
  for (const [row, hint] of [
    [wakeRow, "settings.subagentWakeKindDesc"],
    [handoffRow, "settings.subagentSelfHandoffKindDesc"],
  ]) {
    const help = row.querySelector(".settings-row-title .ui-help-icon");
    check(help, "row help icon missing beside the feature label");
    check(
      (help.getAttribute("aria-label") || help.getAttribute("title") || "").includes(i18n.t(hint)),
      "row tooltip must carry its explanation: " + hint,
    );
  }
  // Stacked full width at every width, with the label left and the controls
  // right: no second column, no side-by-side cards.
  const layout = layoutProbe();
  check(layout.rows.length === 2, "layout probe must see two rows");
  for (let index = 0; index < layout.rows.length; index += 1) {
    const item = layout.rows[index];
    check(Math.abs(item.width - layout.stackWidth) <= 2, "row must fill the section width");
    check(item.labelLeft <= item.controlLeft, "the label must sit left of the controls");
    check(item.controlRight <= item.rowRight + 1, "controls must stay inside the row");
    // Flush to the row's content edge: the cluster is right-aligned, not merely
    // somewhere in the right half of the tile.
    check(
      Math.abs(item.clusterRight - (item.rowRight - item.paddingRight)) <= 1,
      "the control cluster must end on the row's right edge: " + item.clusterRight + " vs " + (item.rowRight - item.paddingRight),
    );
    check(item.clusterLeft >= item.labelLeft, "the label must sit left of the cluster");
    check(item.overflowX <= 1, "row must not overflow horizontally: " + item.overflowX);
    check(item.sectionOverflowX <= 1, "section must not overflow horizontally: " + item.sectionOverflowX);
    if (index > 0) {
      check(item.top >= layout.rows[index - 1].bottom - 1, "rows must stack, never share a line");
      check(Math.abs(item.left - layout.rows[0].left) <= 2, "rows must start on the same left edge");
    }
  }

  // Search and create belong to the list they act on.
  const searchInput = document.querySelector('.agent-capability-toolbar input[type="search"], .agent-capability-toolbar input');
  check(searchInput, "search field missing");
  check(
    availableHeading.compareDocumentPosition(searchInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    "search must sit under the available-subagents heading",
  );
  check(!text().includes(i18n.t("settings.subagentSelfHandoffTitle") + "s"), "no stray pluralised heading");

  // --- Self-handoff defaults to off for a settings document that never had it.
  check(triggerIn(handoffRow).textContent.includes(i18n.t("settings.subagentSelfHandoffKindOff")), "self-handoff must default to off");
  check(!numberIn(handoffRow), "off must hide the numeric field");

  // Context threshold: edited in k tokens, stored in tokens.
  await chooseOption(handoffRow, "context-tokens");
  check(
    JSON.stringify(lastSave().subagentSelfHandoff) === JSON.stringify({ kind: "context-tokens", value: 200000 }),
    "context kind must save the 200k-token default: " + JSON.stringify(lastSave().subagentSelfHandoff),
  );
  check(numberIn(handoffRow) && numberIn(handoffRow).value === "200", "context value must show 200 (k tokens): " + (numberIn(handoffRow) && numberIn(handoffRow).value));
  check(unitIn(handoffRow).textContent === "k tokens", "handoff context unit must be literal k tokens: " + unitIn(handoffRow).textContent);
  setNumber(handoffRow, "80");
  await settleSave();
  blurNumber(handoffRow);
  await settleSave();
  check(
    JSON.stringify(lastSave().subagentSelfHandoff) === JSON.stringify({ kind: "context-tokens", value: 80000 }),
    "context edit must store tokens: " + JSON.stringify(lastSave().subagentSelfHandoff),
  );

  // A stored token count that is not a whole thousand reads exactly and stays
  // exact: the k-token field must not migrate a legacy value by rounding it.
  setNumber(handoffRow, "1.5");
  await settleSave();
  blurNumber(handoffRow);
  await settleSave();
  check(
    JSON.stringify(lastSave().subagentSelfHandoff) === JSON.stringify({ kind: "context-tokens", value: 1500 }),
    "handoff legacy token count must stay exact: " + JSON.stringify(lastSave().subagentSelfHandoff),
  );
  check(numberIn(handoffRow).value === "1.5", "handoff legacy value must read 1.5: " + numberIn(handoffRow).value);

  // Runtime: edited in minutes, stored in seconds.
  await chooseOption(handoffRow, "runtime");
  check(
    JSON.stringify(lastSave().subagentSelfHandoff) === JSON.stringify({ kind: "runtime", value: 900 }),
    "runtime kind must save the default in seconds: " + JSON.stringify(lastSave().subagentSelfHandoff),
  );
  check(numberIn(handoffRow).value === "15", "runtime must show 15 minutes");
  check(unitIn(handoffRow).textContent.includes(i18n.t("settings.subagentSelfHandoffUnitMinutes")), "minutes unit missing");
  setNumber(handoffRow, "30");
  await settleSave();
  blurNumber(handoffRow);
  await settleSave();
  check(
    JSON.stringify(lastSave().subagentSelfHandoff) === JSON.stringify({ kind: "runtime", value: 1800 }),
    "runtime edit must store seconds: " + JSON.stringify(lastSave().subagentSelfHandoff),
  );

  // Tool calls: integer calls.
  await chooseOption(handoffRow, "tool-calls");
  check(
    JSON.stringify(lastSave().subagentSelfHandoff) === JSON.stringify({ kind: "tool-calls", value: 50 }),
    "tool kind must save the 50-call default: " + JSON.stringify(lastSave().subagentSelfHandoff),
  );
  check(unitIn(handoffRow).textContent.includes(i18n.t("settings.subagentSelfHandoffUnitCalls")), "calls unit missing");
  setNumber(handoffRow, "5");
  await settleSave();
  blurNumber(handoffRow);
  await settleSave();
  check(
    JSON.stringify(lastSave().subagentSelfHandoff) === JSON.stringify({ kind: "tool-calls", value: 5 }),
    "tool edit must save calls: " + JSON.stringify(lastSave().subagentSelfHandoff),
  );

  // Off carries no value and hides the field again.
  await chooseOption(handoffRow, "off");
  check(JSON.stringify(lastSave().subagentSelfHandoff) === JSON.stringify({ kind: "off" }), "off must save no value");
  check(!numberIn(handoffRow), "off must hide the numeric field");

  // --- The wake control keeps its stored semantics, in the shared vocabulary.
  check(triggerIn(wakeRow).textContent.includes(i18n.t("settings.subagentSelfHandoffKindRuntime")), "wake must read elapsed runtime like the other row");
  check(numberIn(wakeRow).value === "10", "wake must show 600 stored seconds as 10 minutes: " + numberIn(wakeRow).value);
  check(unitIn(wakeRow).textContent.includes(i18n.t("settings.subagentSelfHandoffUnitMinutes")), "wake minutes unit missing: " + unitIn(wakeRow).textContent);
  setNumber(wakeRow, "2");
  await settleSave();
  blurNumber(wakeRow);
  await settleSave();
  check(
    JSON.stringify(lastSave().subagentWakeup) === JSON.stringify({ kind: "time", value: 120 }),
    "wake save must stay canonical: " + JSON.stringify(lastSave().subagentWakeup),
  );
  // Both sections survive one another's saves: the write is not a section reset.
  check(
    JSON.stringify(lastSave().subagentSelfHandoff) === JSON.stringify({ kind: "off" }),
    "a wake save must not drop the self-handoff section: " + JSON.stringify(lastSave().subagentSelfHandoff),
  );

  // --- Both rows offer the same option texts: the self-handoff vocabulary is
  // the single source of truth, and the wake row keeps its kind order.
  const wakeOptions = await optionTexts(wakeRow);
  const handoffOptions = await optionTexts(handoffRow);
  check(wakeOptions.length === 4 && handoffOptions.length === 4, "both rows must offer four options: " + wakeOptions.length + "/" + handoffOptions.length);
  // Exact order, not an unordered set: context size, tool calls, runtime, off.
  const sharedOrder = [
    i18n.t("settings.subagentSelfHandoffKindContextTokens"),
    i18n.t("settings.subagentSelfHandoffKindToolCalls"),
    i18n.t("settings.subagentSelfHandoffKindRuntime"),
    i18n.t("settings.subagentSelfHandoffKindOff"),
  ];
  check(
    JSON.stringify(wakeOptions) === JSON.stringify(handoffOptions),
    "both rows must offer the same menu texts in the same order: " + JSON.stringify(wakeOptions) + " vs " + JSON.stringify(handoffOptions),
  );
  check(
    JSON.stringify(wakeOptions) === JSON.stringify(sharedOrder),
    "both rows must order context size -> tool calls -> runtime -> off: " + JSON.stringify(wakeOptions),
  );

  // --- Wake context trigger: the same k-token field, raw tokens persisted.
  await chooseOption(wakeRow, "context-tokens");
  check(
    JSON.stringify(lastSave().subagentWakeup) === JSON.stringify({ kind: "context-tokens", value: 200000 }),
    "wake context kind must save the 200k-token default: " + JSON.stringify(lastSave().subagentWakeup),
  );
  check(numberIn(wakeRow).value === "200", "wake context must show 200 (k tokens): " + numberIn(wakeRow).value);
  check(unitIn(wakeRow).textContent === "k tokens", "wake context unit must be literal k tokens: " + unitIn(wakeRow).textContent);
  check(numberIn(wakeRow).getAttribute("step") === "1", "wake k-token field must step by one k");
  setNumber(wakeRow, "40");
  await settleSave();
  blurNumber(wakeRow);
  await settleSave();
  check(
    JSON.stringify(lastSave().subagentWakeup) === JSON.stringify({ kind: "context-tokens", value: 40000 }),
    "wake k-token edit must store tokens: " + JSON.stringify(lastSave().subagentWakeup),
  );
  setNumber(wakeRow, "1.5");
  await settleSave();
  blurNumber(wakeRow);
  await settleSave();
  check(
    JSON.stringify(lastSave().subagentWakeup) === JSON.stringify({ kind: "context-tokens", value: 1500 }),
    "wake legacy token count must stay exact: " + JSON.stringify(lastSave().subagentWakeup),
  );
  const legacyWakeSaves = saves.length;
  blurNumber(wakeRow);
  await settleSave();
  check(saves.length === legacyWakeSaves, "an unchanged 1.5k must not save again");
  check(numberIn(wakeRow).value === "1.5", "wake legacy value must read 1.5: " + numberIn(wakeRow).value);

  // Returning to elapsed time restores its own remembered value.
  await chooseOption(wakeRow, "time");
  check(
    JSON.stringify(lastSave().subagentWakeup) === JSON.stringify({ kind: "time", value: 120 }),
    "wake time must restore its remembered value: " + JSON.stringify(lastSave().subagentWakeup),
  );
  check(numberIn(wakeRow).value === "2", "wake time field must show 2 minutes: " + numberIn(wakeRow).value);

  // Keyboard: Enter is handled by the row (it prevents the default and leaves
  // the field), and the value commits through the same blur path.
  setNumber(wakeRow, "3");
  await settleSave();
  const input = numberIn(wakeRow);
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  input.dispatchEvent(enter);
  check(enter.defaultPrevented, "Enter must be handled by the threshold row");
  blurNumber(wakeRow);
  await settleSave();
  check(
    JSON.stringify(lastSave().subagentWakeup) === JSON.stringify({ kind: "time", value: 180 }),
    "Enter must commit the value in seconds: " + JSON.stringify(lastSave().subagentWakeup),
  );

  // No inline layout: the compact cluster is styled, not hand-positioned.
  const cluster = handoffRow.querySelector(".settings-threshold-control");
  check(cluster, "shared compact control missing");
  check(!cluster.getAttribute("style"), "control cluster must be styled by class, not inline");
  check(
    !numberIn(wakeRow).getAttribute("style"),
    "the numeric field must take its width from the shared class, not inline styles",
  );
  check(
    Boolean(document.querySelector(".settings-subsection-title")) &&
      Boolean(document.querySelector(".subagent-execution-rows")),
    "section and row-stack classes must be styled from the stylesheet",
  );

  // The window is resized and probed again before teardown, so the rows are
  // measured at both widths from the same mounted page.
  return { passed: true, saves };
};

// The same rows at the narrowest workbench width: still stacked full width,
// still no horizontal overflow anywhere on the page.
window.narrowProbe = () => {
  const layout = layoutProbe();
  check(layout.width <= 420, "narrow probe must run in a narrow window: " + layout.width);
  check(layout.rows.length === 2, "narrow probe must see two rows");
  for (let index = 0; index < layout.rows.length; index += 1) {
    const item = layout.rows[index];
    check(Math.abs(item.width - layout.stackWidth) <= 2, "a narrow row must still fill the section width");
    check(item.overflowX <= 1, "narrow row must not overflow: " + item.overflowX);
    check(item.sectionOverflowX <= 1, "narrow section must not overflow: " + item.sectionOverflowX);
    check(item.pageOverflowX <= 1, "narrow page must not scroll sideways: " + item.pageOverflowX);
    check(item.clusterLeft >= item.left - 1, "the trigger cluster must start inside the row");
    check(item.clusterRight <= item.rowRight + 1, "the trigger cluster must end inside the row");
    // The stacked narrow row still right-aligns its cluster: it does not drop
    // back to the left text edge the way a full-width form field would.
    check(
      Math.abs(item.clusterRight - (item.rowRight - item.paddingRight)) <= 1,
      "the narrow cluster must stay flush to the row's right edge: " + item.clusterRight + " vs " + (item.rowRight - item.paddingRight),
    );
    check(item.labelLeft >= item.left - 1, "the row label must start inside the row");
    check(item.labelTop < item.controlTop, "the row label must sit above its control on one line of the narrow row");
    if (index > 0) check(item.top >= layout.rows[index - 1].bottom - 1, "narrow rows must stack");
  }
  return { passed: true, width: layout.width, rows: layout.rows.length };
};

window.teardownProbe = () => {
  flushSync(() => rootNode.unmount());
  return { passed: true };
};
`;

test("subagent execution settings: one section heading, two stacked full-width feature rows, k-token fields retained", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.execution-settings-ui-"));
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
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("EXECUTION_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.executionProbe()")));
    console.log("COLUMNS_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.columnsProbe()")));
    // Same page, narrowest workbench width: the rows must stack, stay full
    // width, and never overflow.
    win.setContentSize(360, 900);
    await new Promise((resolve) => setTimeout(resolve, 250));
    console.log("NARROW_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.narrowProbe()")));
    console.log("NARROW_COLUMNS_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.narrowColumnsProbe()")));
    await win.webContents.executeJavaScript("window.teardownProbe()");
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-8000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("EXECUTION_PROBE "));
    assert.ok(line, output.slice(-8000));
    const result = JSON.parse(line.slice("EXECUTION_PROBE ".length));
    assert.equal(result.passed, true);
    assert.ok(result.saves.length >= 8, `expected several saves, got ${result.saves.length}`);
    const columnsLine = output.split(/\r?\n/).find((item) => item.startsWith("COLUMNS_PROBE "));
    assert.ok(columnsLine, output.slice(-8000));
    const columns = JSON.parse(columnsLine.slice("COLUMNS_PROBE ".length));
    assert.equal(columns.passed, true);
    assert.equal(columns.wake.length, 4);
    assert.equal(columns.handoff.length, 4);
    const narrowLine = output.split(/\r?\n/).find((item) => item.startsWith("NARROW_PROBE "));
    assert.ok(narrowLine, output.slice(-8000));
    const narrow = JSON.parse(narrowLine.slice("NARROW_PROBE ".length));
    assert.equal(narrow.passed, true);
    assert.equal(narrow.rows, 2);
    assert.ok(narrow.width <= 420, `narrow probe must run narrow, got ${narrow.width}`);
    const narrowColumnsLine = output.split(/\r?\n/).find((item) => item.startsWith("NARROW_COLUMNS_PROBE "));
    assert.ok(narrowColumnsLine, output.slice(-8000));
    const narrowColumns = JSON.parse(narrowColumnsLine.slice("NARROW_COLUMNS_PROBE ".length));
    assert.equal(narrowColumns.passed, true);
    assert.equal(narrowColumns.wake.length, 4);
    assert.equal(narrowColumns.handoff.length, 4);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
