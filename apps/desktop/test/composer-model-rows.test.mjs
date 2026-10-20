/**
 * The Composer model menu's rendered rows.
 *
 * The list and the reasoning slider are rendered from their real modules, with
 * a fixture catalog, through the same server-rendering harness the other
 * component tests use: what this asserts is the first frame of a mount, so a
 * row's own content and semantics are checked without a browser.
 *
 * Layout is not measured here. The single-line, ellipsized label is asserted as
 * a style contract in `composer-model-thinking-menu.test.mjs`, and the rendered
 * rectangles belong to the Composer model menu E2E.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const LONG_ID = "claude-sonnet-4-5-20260101-experimental-magpie-route";
const PROVIDER_NAME = "Magpie";

const provider = {
  id: "magpie",
  name: PROVIDER_NAME,
  vendorKey: "magpie",
  type: "openai_compatible",
  protocol: "openai",
  enabled: true,
  authKind: "api_key",
  hasSecret: true,
  models: [{ id: LONG_ID }, { id: "lightweight" }],
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "medium", "high"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const model = (modelId, extra = {}) => ({
  modelId,
  displayName: modelId,
  providerId: provider.id,
  capabilities: ["text"],
  source: "user",
  contextWindow: 1_050_000,
  ...extra,
});

const translations = {
  "chat.recentModels": "Recent",
  "chat.otherModels": "Other models",
  "chat.searchModels": "Search models",
  "chat.noModelResults": "No models",
};

/** Visible text with attributes, tags and comments removed. */
const visibleText = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function renderMenu() {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { ComposerModelList } = await server.ssrLoadModule(
      "/src/features/chat/composer/ComposerModelList.tsx",
    );
    const { ThinkingLevelSlider } = await server.ssrLoadModule(
      "/src/features/chat/composer/ThinkingLevelSlider.tsx",
    );
    const t = (key) => translations[key] ?? key;
    const noRef = { current: null };
    const list = renderToStaticMarkup(
      createElement(ComposerModelList, {
        t,
        query: "",
        setQuery() {},
        modelSearchRef: noRef,
        modelListRef: noRef,
        modelGroups: [
          {
            provider,
            providerDisplayName: PROVIDER_NAME,
            models: [model(LONG_ID), model("lightweight")],
          },
        ],
        modelHighlight: 1,
        setModelHighlight() {},
        selectedProviderId: provider.id,
        selectedModelId: LONG_ID,
        selectModel() {},
        recentEntries: [
          { provider, model: model(LONG_ID) },
          { provider, model: model("lightweight") },
        ],
        hasOtherModels: true,
        otherModelsExpanded: false,
        setOtherModelsExpanded() {},
      }),
    );
    const slider = renderToStaticMarkup(
      createElement(ThinkingLevelSlider, {
        levels: ["off", "medium", "high"],
        level: "medium",
        label: "Reasoning level",
        commit: async () => true,
      }),
    );
    return { list, slider };
  } finally {
    await server.close();
  }
}

test("a recent row renders the model label only and keeps its selection check", async () => {
  const { list } = await renderMenu();
  const recentMarker = '<div class="composer-model-group" role="group" aria-label="Recent">';
  const recentStart = list.indexOf(recentMarker);
  const recent = list.slice(
    recentStart,
    list.indexOf('<div class="composer-model-group"', recentStart + recentMarker.length),
  );
  const recentText = visibleText(recent);

  // The recent group has no provider heading, so the provider name used to sit
  // in the row itself and wrapped a long id onto a second line.
  // The recent group and the Other models disclosure, and no provider name.
  assert.equal(recentText, `Recent ${LONG_ID} lightweight Other models`);
  assert.doesNotMatch(recentText, new RegExp(PROVIDER_NAME));
  assert.match(
    recent,
    new RegExp(`title="${PROVIDER_NAME} · ${escapeForRegex(LONG_ID)}"`),
  );

  // Only the model rows: the Other models disclosure is a button too.
  const rows = recent.match(/<button[^>]*role="menuitemradio"[\s\S]*?<\/button>/g) ?? [];
  assert.equal(rows.length, 2);
  assert.match(rows[0], /role="menuitemradio" aria-checked="true"/);
  assert.match(rows[1], /role="menuitemradio" aria-checked="false"/);
  // The selection check stays on the active recent row, and only there.
  assert.equal((rows[0].match(/<svg/g) ?? []).length, 1);
  assert.equal((rows[1].match(/<svg/g) ?? []).length, 0);
  assert.deepEqual(
    rows.map((row) => row.match(/data-model-index="(\d+)"/)?.[1]),
    ["0", "1"],
  );
});

test("model rows carry no capability or context cells and keep the full id as the title", async () => {
  const { list } = await renderMenu();

  assert.doesNotMatch(list, /composer-model-option-(badge|ctx|meta)/);
  assert.doesNotMatch(list, /role="img"/);
  // 1,050,000 renders as 1.05M through the shared formatter: no row prints it.
  assert.doesNotMatch(list, /1\.05M/);
  assert.doesNotMatch(visibleText(list), /reasoning|vision/);

  // The whole row is one label; the wire id stays reachable as its title.
  const titleMatches = list.match(new RegExp(`title="${escapeForRegex(LONG_ID)}"`, "g"));
  assert.equal(titleMatches?.length, 1);
  const group = list.slice(list.indexOf(`aria-label="${PROVIDER_NAME}"`));
  assert.match(group, /composer-model-check/);
});

test("the running list keeps search, group headings, flattened keyboard order and the reasoning slider", async () => {
  const { list, slider } = await renderMenu();

  assert.match(list, /class="composer-model-search"/);
  assert.match(list, /placeholder="Search models"/);
  assert.match(list, /aria-label="Recent"/);
  assert.match(list, /composer-model-group-label">Recent</);
  assert.match(list, /composer-model-group-label">Magpie</);
  assert.match(list, /aria-expanded="false"/);
  // Highlight indices run over recent entries and then the provider groups, so
  // ArrowDown keeps stepping through one flat list.
  assert.deepEqual(
    [...list.matchAll(/data-model-index="(\d+)"/g)].map((match) => match[1]),
    ["0", "1", "2", "3"],
  );
  assert.match(list, /composer-model-option[^"]*kb-active/);

  // The reasoning strength control at the bottom of the menu still renders.
  assert.match(slider, /class="composer-thinking-slider"/);
  assert.match(slider, /type="range"/);
  assert.match(slider, /aria-label="Reasoning level"/);
  assert.match(slider, /aria-valuetext="medium"/);
  assert.match(slider, /class="composer-thinking-ticks"/);
});
