import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";

/**
 * The running-send preference is a two-option row, and a settings document
 * written before the field existed must present the immediate option as the
 * current answer without persisting anything first.
 */
test("the running-send preference renders the immediate default and the queue option", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  await i18n.use(initReactI18next).init({
    lng: "en",
    keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } },
    interpolation: { escapeValue: false },
  });
  const { SendWhileRunningModeRow } = await server.ssrLoadModule(
    "/src/features/settings/primitives.tsx",
  );

  const patches = [];
  const render = (settings) =>
    renderToStaticMarkup(
      createElement(SendWhileRunningModeRow, {
        settings,
        saveSettings: async (patch) => patches.push(patch),
      }),
    );

  const defaultMarkup = render({ enterToSend: true });
  assert.match(defaultMarkup, /aria-label="Message while the agent is running"/);
  assert.match(defaultMarkup, />Send immediately</);
  assert.match(defaultMarkup, />Queue</);
  assert.match(defaultMarkup, /aria-pressed="true"[^>]*>Send immediately</);
  assert.doesNotMatch(defaultMarkup, /aria-pressed="true"[^>]*>Queue</);
  assert.doesNotMatch(defaultMarkup, /settings\.sendWhileRunningMode/, "copy resolves through i18n");

  const queuedMarkup = render({ sendWhileRunningMode: "queue" });
  assert.match(queuedMarkup, /aria-pressed="true"[^>]*>Queue</);
  assert.doesNotMatch(queuedMarkup, /aria-pressed="true"[^>]*>Send immediately</);

  assert.deepEqual(patches, [], "rendering the current answer does not write it back");

  const settingsPage = await readFile(
    new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    settingsPage,
    /<SendWhileRunningModeRow\s+settings={settings}\s+saveSettings={saveSettings}\s+\/>/,
    "the row stays beside the other composer defaults the user already visits",
  );
});
