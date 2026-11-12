import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/**
 * The chosen-model sheet as a user reaches it: Settings → model configuration,
 * Advanced disclosure, real `ModelSelectionPanes` in an Electron window.
 *
 * Only the component's external edges are stood in for — i18n, the IPC bridge
 * and the caller that owns the draft — so the assertions read the same markup,
 * the same callbacks and the same draft the provider dialog would.
 */

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))(
  "esbuild",
);

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import {
  ModelSelectionPanes,
  useModelSelection,
} from "../../apps/desktop/src/components/settings/ModelSelectionPanes";

await i18n.use(initReactI18next).init({
  lng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  invoke() { throw new Error("Unexpected IPC in the model settings fixture"); },
};

const info = {
  modelId: "fixture-llm",
  displayName: "Fixture LLM",
  providerId: "fixture",
  source: "discovered",
  catalogSource: "models.dev",
  capabilities: ["text", "pdf"],
  modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  limit: { context: 200000, output: 64000 },
  thinkingProtocol: "adaptive",
  supportedThinkingLevels: ["off", "low", "high"],
  contextWindow: 200000,
  maxTokens: 64000,
};
const seed = {
  id: "fixture-llm",
  contextWindow: 200000,
  contextWindowSource: "catalog",
  maxTokens: 32000,
  maxTokensSource: "user",
  thinkingLevels: ["off", "low", "high"],
  defaultThinkingLevel: "high",
  thinkingProtocol: "adaptive",
  supportsDocuments: null,
};
const discovery = { status: "ready", source: "discovered", models: [info] };
const imageCalls = [];

function Harness() {
  const [models, setModels] = React.useState([seed]);
  const [imageModelIds, setImageModelIds] = React.useState([]);
  const [apiStyle, setApiStyle] = React.useState("responses");
  const selection = useModelSelection(discovery, models, setModels);
  window.readDraft = () => models[0];
  window.setApiStyle = (next) => setApiStyle(next);
  return React.createElement(ModelSelectionPanes, {
    discovery,
    selection,
    listTitle: "Fixture service models",
    apiStyle,
    imageModelIds,
    onImageModelChange(id, selected) {
      imageCalls.push([id, selected]);
      setImageModelIds((current) =>
        selected
          ? [...current.filter((entry) => entry !== id), id]
          : current.filter((entry) => entry !== id),
      );
    },
  });
}

const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Harness)));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) {
  if (!condition) throw new Error(message);
}
const text = (element) => (element.textContent || "").trim().replace(/\s+/g, " ");
const boxes = () => [...document.querySelectorAll('.provider-chosen-row-body input[type="checkbox"]')];
const names = () => boxes().map((input) => text(input.closest("label")));
const groups = () => [...document.querySelectorAll(".provider-chosen-capabilities")];

/** Fresh mount state with the Advanced disclosure open. */
window.__openAdvanced = async () => {
  await settle();
  check(document.querySelectorAll(".provider-chosen-row").length === 1,
    "fixture did not render one chosen model");
  const toggle = document.querySelector(".provider-chosen-advanced-toggle");
  flushSync(() => toggle.click());
  await settle();
  const body = document.querySelector(".provider-chosen-row-body");
  check(body && !body.hidden, "Advanced disclosure did not open");
};

window.__probe = async (size) => {
  await settle();
  const body = document.querySelector(".provider-chosen-row-body");
  const report = { size, headings: [], names: names(), clipped: [] };
  const seen = groups();
  check(seen.length === 2, "expected two functional groups, saw " + seen.length);
  report.headings = seen.map((group) =>
    text(group.querySelector(".provider-chosen-thinking-label")),
  );
  check(report.headings[0] === "Model usage",
    "first group heading is " + report.headings[0]);
  check(report.headings[1] === "Request options",
    "second group heading is " + report.headings[1]);
  check(report.names.join(" | ") ===
    "Set as image model | Available for AI delegation | Native web search",
    "unexpected checkbox set: " + report.names.join(" | "));
  check(!body.textContent.includes("PDF"),
    "the sheet still offers PDF capability editing");
  check(!body.textContent.includes("Capabilities"),
    "the sheet still keeps a capability group");
  // Nothing in the sheet can write an attachment capability.
  const before = window.readDraft();
  check(!("supportsImages" in before) && before.supportsDocuments === null,
    "fixture draft started with an unexpected attachment override");
  report.groups = seen.map((group) => {
    const label = group.querySelector(".provider-chosen-thinking-label");
    const groupRect = group.getBoundingClientRect();
    const rowsRect = group.querySelector(".provider-chosen-capability-rows")
      .getBoundingClientRect();
    check(label.scrollWidth <= label.clientWidth + 1,
      "group heading is truncated at " + size + ": " + text(label));
    check(label.getBoundingClientRect().height >= 10,
      "group heading did not lay out at " + size);
    check(rowsRect.width > 0, "group rows collapsed at " + size);
    return {
      heading: text(label),
      top: Math.round(groupRect.top),
      bottom: Math.round(groupRect.bottom),
      width: Math.round(groupRect.width),
    };
  });
  check(report.groups[1].top >= report.groups[0].bottom - 1,
    "the two groups overlap at " + size);
  report.sheet = {
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
  };
  check(body.scrollWidth <= body.clientWidth + 1,
    "the Advanced sheet overflows horizontally at " + size + ": " +
      body.scrollWidth + " > " + body.clientWidth);
  for (const span of body.querySelectorAll(".provider-chosen-capability span")) {
    if (span.scrollWidth > span.clientWidth + 1) {
      report.clipped.push(text(span));
    }
  }
  check(report.clipped.length === 0,
    "labels are truncated at " + size + ": " + report.clipped.join(", "));
  for (const input of boxes()) {
    const rect = input.getBoundingClientRect();
    check(rect.width >= 12 && rect.height >= 12,
      "checkbox hit target is too small at " + size);
  }

  // The image-generation role keeps its callback and its own label.
  const imageBox = boxes()[0];
  const imageCallsBefore = imageCalls.length;
  flushSync(() => imageBox.click());
  await settle();
  check(imageCalls.length === imageCallsBefore + 1,
    "image role toggle did not reach its callback");
  check(imageCalls[imageCallsBefore][0] === "fixture-llm" &&
    imageCalls[imageCallsBefore][1] === true,
    "image role callback args were " + JSON.stringify(imageCalls[imageCallsBefore]));
  check(names()[0] === "Selected image model",
    "image role label did not follow the callback: " + names()[0]);
  check(boxes()[0].checked, "image role switch did not render selected");

  // AI delegation stays a real draft opt-in.
  flushSync(() => boxes()[1].click());
  await settle();
  check(window.readDraft().availableForSubagents === true,
    "delegation switch did not update the draft");

  // Native web search keeps its wire gate and its stored opt-in.
  const capableSearch = boxes()[2];
  check(capableSearch.disabled === false,
    "native search should be offered on a Responses wire");
  flushSync(() => capableSearch.click());
  await settle();
  check(window.readDraft().nativeWebSearch === true,
    "native search switch did not update the draft");
  flushSync(() => window.setApiStyle("chat_completions"));
  await settle();
  const blockedSearch = boxes()[2];
  check(blockedSearch.disabled === true,
    "native search should be disabled on a chat-completions wire");
  check(blockedSearch.title.includes("has not integrated native search"),
    "disabled native search lost its reason: " + JSON.stringify(blockedSearch.title));
  const searchBefore = window.readDraft().nativeWebSearch;
  flushSync(() => blockedSearch.click());
  await settle();
  check(window.readDraft().nativeWebSearch === searchBefore,
    "a disabled native search control changed the draft");

  // Token limits and thinking selections are untouched by the regroup.
  const numeric = [...body.querySelectorAll('input[type="number"]')]
    .map((input) => input.value);
  check(numeric[0] === "200000" && numeric[1] === "32000",
    "stored token limits changed: " + numeric.join(","));
  const chips = [...body.querySelectorAll(
    ".provider-chosen-thinking-chips .provider-thinking-chip")];
  check(chips.length === 7, "thinking chips are missing: " + chips.length);
  check(chips.filter((chip) => chip.getAttribute("aria-pressed") === "true")
    .map((chip) => chip.textContent.trim()).join(",") === "off,low,high",
    "enabled thinking levels changed");
  const minimal = chips.find((chip) => chip.textContent.trim() === "minimal");
  flushSync(() => minimal.click());
  await settle();
  check(window.readDraft().thinkingLevels.includes("minimal"),
    "thinking chips no longer write the draft");
  check(window.readDraft().defaultThinkingLevel === "high",
    "editing a chip changed the saved default");
  const finalDraft = window.readDraft();
  // The stored attachment metadata is neither written nor dropped: the seed's
  // legacy null survives every interaction above.
  check(!("supportsImages" in finalDraft) && finalDraft.supportsDocuments === null,
    "interacting with the sheet wrote an attachment capability: " +
      JSON.stringify(finalDraft));
  report.draft = {
    contextWindow: finalDraft.contextWindow,
    maxTokens: finalDraft.maxTokens,
    thinkingLevels: finalDraft.thinkingLevels,
    defaultThinkingLevel: finalDraft.defaultThinkingLevel,
    availableForSubagents: finalDraft.availableForSubagents,
    nativeWebSearch: finalDraft.nativeWebSearch,
    supportsDocuments: finalDraft.supportsDocuments,
  };
  report.imageCalls = imageCalls;
  return report;
};
`;

test(
  "advanced model settings group functional rows and edit no attachment capability",
  {
    skip:
      process.platform === "linux" && !process.env.DISPLAY
        ? "Electron requires a display"
        : false,
  },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-model-settings-ui-"));
    const evidenceDir = process.env.PI_MODEL_SETTINGS_EVIDENCE_DIR;
    try {
      await build({
        stdin: {
          contents: fixture,
          resolveDir: join(root, "scripts/e2e"),
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
          "@pi-desktop/shared": join(root, "packages/shared/src"),
          react: join(root, "apps/desktop/node_modules/react"),
          "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
          i18next: join(root, "apps/desktop/node_modules/i18next"),
          "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
        },
        nodePaths: [join(root, "apps/desktop/node_modules")],
      });
      await writeFile(
        join(temp, "index.html"),
        '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>',
      );
      const sizes = [
        { name: "standard", width: 760, height: 900 },
        { name: "narrow", width: 420, height: 900 },
      ];
      await writeFile(
        join(temp, "main.cjs"),
        `const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const sizes = ${JSON.stringify(sizes)};
const evidenceDir = ${JSON.stringify(evidenceDir ?? null)};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 760, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    // The window stays visible (inactive) for every iteration: a hidden
    // renderer stops animation frames, and the probe waits on them.
    win.showInactive();
    win.setPosition(0, 0);
    for (const size of sizes) {
      win.setContentSize(size.width, size.height);
      await win.loadFile(path.join(__dirname, "index.html"));
      await win.webContents.executeJavaScript("window.__openAdvanced()");
      if (evidenceDir) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const image = await win.webContents.capturePage();
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(path.join(evidenceDir, "model-settings-" + size.name + ".png"), image.toPNG());
      }
      const report = await win.webContents.executeJavaScript(
        "window.__probe(" + JSON.stringify(size.name) + ")");
      console.log("MODEL_SETTINGS_PROBE " + JSON.stringify({ size: size.name, report }));
    }
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`,
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output += chunk;
        });
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
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
      const probes = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith("MODEL_SETTINGS_PROBE "))
        .map((line) => JSON.parse(line.slice("MODEL_SETTINGS_PROBE ".length)));
      assert.equal(probes.length, sizes.length, output.slice(-6000));
      for (const probe of probes) {
        assert.deepEqual(probe.report.headings, ["Model usage", "Request options"]);
        assert.deepEqual(probe.report.draft, {
          contextWindow: 200000,
          maxTokens: 32000,
          thinkingLevels: ["off", "low", "high", "minimal"],
          defaultThinkingLevel: "high",
          availableForSubagents: true,
          nativeWebSearch: true,
          supportsDocuments: null,
        });
        assert.deepEqual(probe.report.imageCalls, [["fixture-llm", true]]);
      }
      const [standard, narrow] = probes.map((probe) => probe.report);
      assert.ok(standard.sheet.clientWidth > 300, JSON.stringify(standard.sheet));
      assert.ok(narrow.sheet.clientWidth > 0, JSON.stringify(narrow.sheet));
      assert.ok(narrow.groups[0].width <= narrow.sheet.clientWidth + 1);
      assert.ok(
        narrow.groups[1].top >= narrow.groups[0].bottom - 1,
        JSON.stringify(narrow.groups),
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
