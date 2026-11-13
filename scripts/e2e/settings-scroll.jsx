// Mounted production SettingsPage; only the preload boundary uses fixture data.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { SettingsPage } from "../../apps/desktop/src/features/settings/SettingsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { initLanguageSync } from "../../apps/desktop/src/lib/app-language";

const destinations = ["A", "B"].map((id) => ({
  ref: `fixture:${id}`, pluginId: "fixture", label: `Themes ${id}`, keywords: [],
  description: "Fixture theme collection", themes: Array.from({ length: 12 }, (_, index) => ({
    themeId: `plugin:fixture:${id}${index}`, label: `Theme ${index}`, description: "Preview",
    previewUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", blur: 6,
  })),
}));
let settings = {
  defaultMode: "agent",
  theme: "light",
  language: "en",
  enterToSend: true,
  developerMode: false,
  networkProxy: { mode: "custom", url: "socks5://10.0.0.8:1080" },
};
let updateState = {
  mode: "in-app",
  preference: "automatic",
  defaultPreference: "automatic",
  automaticSupported: true,
  manualReminder: false,
  status: "available",
  currentVersion: "0.15.8",
  availableVersion: "0.15.9",
  releasesUrl: "https://github.com/vastsa/PI-Desktop/releases/latest",
};
const updateStateListeners = new Set();
window.piDesktop = {
  platform: "darwin",
  on(channel, listener) {
    if (channel === IPC.event.updatesState) updateStateListeners.add(listener);
    return () => updateStateListeners.delete(listener);
  },
  async invoke(channel, input) {
    let data;
    switch (channel) {
      case IPC.invoke.pluginScenicThemesDestinations: data = destinations; break;
      case IPC.invoke.settingsGet: data = settings; break;
      case IPC.invoke.settingsSet:
        settings = input;
        data = settings;
        if (settings.updatePreference === "automatic" || settings.updatePreference === "manual") {
          updateState = {
            ...updateState,
            preference: settings.updatePreference,
            mode: settings.updatePreference === "automatic" ? "in-app" : "manual",
          };
          for (const listener of updateStateListeners) listener(updateState);
        }
        break;
      case IPC.invoke.providersList: data = { providers: [] }; break;
      case IPC.invoke.sessionList: data = { sessions: [] }; break;
      case IPC.invoke.appGetOnboarding: data = {}; break;
      case IPC.invoke.updatesGetState: data = updateState; break;
      case IPC.invoke.configSyncGetState:
        data = {
          configured: false,
          enabled: false,
          paused: false,
          locked: false,
          status: "notConfigured",
          remoteMode: "strict",
          categories: {},
          includeSecrets: false,
          includeMemory: false,
          automaticSync: false,
          pendingApprovals: [],
          mappings: [],
        };
        break;
      case IPC.invoke.commandShellList: data = { choices: [], effective: null }; break;
      default: throw new Error(`Unexpected fixture IPC: ${channel}`);
    }
    return { ok: true, data };
  },
};
await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: {
    en: { translation: flattenCatalog(catalogs.en) },
    "pt-BR": { translation: flattenCatalog(catalogs["pt-BR"]) },
  },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ settings, settingsTab: "ai", page: "settings" });
initLanguageSync();
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<SettingsPage />));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message ?? "Timed out waiting for condition");
}
function assert(value, message) { if (!value) throw new Error(message); }
const pane = () => document.querySelector(".settings-content");
const navButton = (label) => [...document.querySelectorAll(".settings-nav-item")]
  .find((node) => node.querySelector(".settings-nav-label")?.textContent?.trim() === label);
async function select(label) {
  const button = navButton(label);
  assert(button, `Missing destination: ${label}`);
  flushSync(() => button.click());
  await settle();
}
async function checkCloudSyncVisibility() {
  // The isolated renderer is a development build; packaged-build visibility is
  // asserted by settings-developer-only-destinations.test.mjs. The rail has no
  // in-page search filter any more, so destinations are checked directly.
  const syncButton = navButton("Cloud sync");
  assert(syncButton, "Cloud sync must appear in the Settings rail");
  assert(
    syncButton.querySelector(".settings-nav-experimental")?.textContent?.trim() === "Experimental",
    "Cloud sync's rail entry must carry the Experimental badge",
  );

  flushSync(() => syncButton.click());
  await settle();
  assert(useAppStore.getState().settingsTab === "sync", "Cloud sync must open its page");
  assert(
    document.querySelector(".settings-section-title")?.textContent?.includes("Experimental"),
    "Cloud sync's page title must carry the Experimental badge",
  );

  // Developer mode does not gate Cloud sync or Remote Hosts.
  settings = { ...settings, developerMode: true };
  flushSync(() => useAppStore.setState({ settings }));
  await settle();
  assert(navButton("Cloud sync"), "Cloud sync must stay in the rail with developer mode on");
  settings = { ...settings, developerMode: false };
  flushSync(() => useAppStore.setState({ settings }));
  await settle();
  assert(useAppStore.getState().settingsTab === "sync", "Cloud sync must stay selected");
  assert(navButton("Cloud sync"), "Cloud sync must stay in the rail without developer mode");

  const remoteButton = navButton("Remote hosts");
  assert(remoteButton, "Remote hosts must appear in the Settings rail");
  assert(
    remoteButton.querySelector(".settings-nav-experimental")?.textContent?.trim() === "Experimental",
    "Remote hosts must carry the Experimental badge",
  );
  flushSync(() => remoteButton.click());
  await settle();
  assert(useAppStore.getState().settingsTab === "remoteHosts", "Remote hosts must open");
  assert(
    document.querySelector(".settings-section-title")?.textContent?.includes("Experimental"),
    "Remote hosts page title must carry the Experimental badge",
  );

  for (const developerMode of [true, false]) {
    settings = { ...settings, developerMode };
    flushSync(() => useAppStore.setState({ settings }));
    await settle();
    assert(useAppStore.getState().settingsTab === "remoteHosts");
    assert(navButton("Remote hosts"), "Remote hosts must stay visible in every developer mode");
  }
}
async function scroll() {
  pane().scrollTop = 220;
  await settle();
  assert(pane().scrollTop > 0, "Destination must be scrollable for this check");
  return pane().scrollTop;
}
async function exerciseUpdatePreference() {
  await select("Info");
  await settle();
  const trigger = () => document.querySelector('button[aria-label="Update behavior"]');
  assert(trigger() instanceof HTMLButtonElement, "Update behavior selector must render");
  assert(trigger().textContent?.includes("Automatic"), "Installed package defaults to Automatic");
  const updateActionLabels = [...document.querySelectorAll(".about-update-actions button")]
    .map((button) => button.textContent?.trim() ?? "");
  assert(
    updateActionLabels.some((label) => label.includes("Check for updates")),
    `Automatic mode keeps the existing update check action: ${updateActionLabels.join(", ")}`,
  );

  async function choosePreference(label, value) {
    const selectTrigger = trigger();
    assert(selectTrigger instanceof HTMLButtonElement, "Update selector trigger must remain mounted");
    flushSync(() => selectTrigger.click());
    await settle();
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((candidate) => candidate.textContent?.trim() === label);
    assert(option instanceof HTMLButtonElement, `Missing update preference option: ${label}`);
    flushSync(() => option.click());
    await settle();
    assert(settings.updatePreference === value, `${label} preference must persist through settings IPC`);
    assert(useAppStore.getState().settings?.updatePreference === value, `${label} preference must update the renderer store`);
    assert(updateState.preference === value, `${label} preference must update the shared update state`);
  }

  await choosePreference("Manual", "manual");
  assert(trigger().textContent?.includes("Manual"), "Manual must become the selected value");
  assert(
    [...document.querySelectorAll(".about-update-actions button")]
      .some((button) => button.textContent?.includes("View release")),
    "Manual mode must offer the release page for an available version",
  );

  await select("Chat");
  await select("Info");
  await settle();
  assert(trigger().textContent?.includes("Manual"), "Manual preference must survive leaving and reopening Info");
  await choosePreference("Automatic", "automatic");
  assert(trigger().textContent?.includes("Automatic"), "Automatic must be selectable again");
  return { updatePreference: settings.updatePreference, updateMode: updateState.mode };
}

async function exerciseBrazilianPortuguese() {
  await select("General");
  const trigger = document.querySelector(".settings-language-trigger");
  assert(trigger instanceof HTMLButtonElement, "Language picker trigger must render");
  flushSync(() => trigger.click());
  await settle();

  const search = document.querySelector(".settings-language-search input");
  assert(search instanceof HTMLInputElement, "Language picker search must render");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert(setter, "Language search input must expose its value setter");
  setter.call(search, "Português (Brasil)");
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();

  const option = [...document.querySelectorAll(".settings-language-option")]
    .find((candidate) => candidate.textContent?.includes("Português (Brasil)"));
  assert(option instanceof HTMLButtonElement, "Brazilian Portuguese must be searchable");
  const languageChanged = new Promise((resolve) => i18n.once("languageChanged", resolve));
  flushSync(() => option.click());
  await languageChanged;
  await settle();

  assert(settings.language === "pt-BR", "Choosing Portuguese must persist pt-BR");
  assert(useAppStore.getState().settings?.language === "pt-BR", "App settings must retain pt-BR");
  assert(document.documentElement.lang === "pt-BR", "Document language must update to pt-BR");
  assert(navButton("Geral"), "Settings navigation must switch to Brazilian Portuguese");
  assert(!navButton("General"), "English navigation must be replaced after switching locales");
  const languageTitle = [...document.querySelectorAll(".settings-row-title")]
    .find((node) => node.textContent?.trim() === "Idioma");
  assert(languageTitle, "The language setting label must be translated");
  const selectedLabel = document.querySelector(".settings-language-trigger-label");
  assert(selectedLabel?.textContent?.trim() === "Português (Brasil)", "Picker must show the selected native name");
  return { locale: i18n.language, language: settings.language, label: selectedLabel.textContent.trim() };
}
async function exerciseProxyDraftRestoration() {
  await select("General");
  // General hosts the two sections that used to own rail rows of their own.
  assert(document.querySelector(".live-voice-settings"),
    "General must host the Live Voice settings section");
  assert(document.querySelector(".settings-panel.shortcut-map"),
    "General must host the Keyboard shortcuts section");
  const urlInput = () => document.querySelector('input[aria-label="Proxy URL"]');
  const input = urlInput();
  assert(input instanceof HTMLInputElement, "Custom proxy URL field must render");
  const rememberedUrl = settings.networkProxy.url;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert(setter, "Proxy URL input must expose its value setter");
  setter.call(input, "not-a-proxy");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  urlInput().blur();
  await settle();
  assert(settings.networkProxy.url === rememberedUrl, "An invalid draft must not overwrite the saved proxy");

  const chooseMode = async (label) => {
    const group = document.querySelector('.settings-segment[aria-label="Proxy"]');
    assert(group, "Proxy mode control must render");
    const option = [...group.querySelectorAll('[role="radio"]')]
      .find((candidate) => candidate.textContent?.trim() === label);
    assert(option instanceof HTMLButtonElement, `Missing proxy mode: ${label}`);
    flushSync(() => option.click());
    await settle();
  };

  await chooseMode("System");
  assert(settings.networkProxy.mode === "system", "System mode must persist");
  assert(settings.networkProxy.url === rememberedUrl, "System mode must retain the remembered proxy");
  await chooseMode("Custom");
  assert(settings.networkProxy.mode === "custom", "Custom mode must persist on re-entry");
  assert(urlInput()?.value === rememberedUrl, "Re-entering Custom must restore the remembered URL");
  assert(settings.networkProxy.url === rememberedUrl, "Re-entry must not replace the saved URL with the default");
  return { proxyMode: settings.networkProxy.mode, proxyUrl: settings.networkProxy.url };
}
/**
 * The Chat page owns the send-while-running preference; an unset value must
 * read as the immediate default, and a change must persist through the settings
 * boundary and survive leaving and reopening the page.
 */
async function exerciseSendWhileRunning() {
  await select("Chat");
  const group = () => document.querySelector('.settings-segment[aria-label="Message while the agent is running"]');
  const option = (label) => [...(group()?.querySelectorAll(".settings-segment-item") ?? [])]
    .find((candidate) => candidate.textContent?.trim() === label);
  assert(group(), "Chat must expose the send-while-running preference");
  assert(option("Send immediately")?.getAttribute("aria-pressed") === "true",
    "An unset preference must default to sending immediately");
  assert(option("Queue")?.getAttribute("aria-pressed") === "false",
    "Queue must not be selected by default");

  // The fixture settings boundary answers by replacing the whole settings
  // object, so a one-key diff against the settings the page renders from shows
  // the patch it actually persisted.
  const before = useAppStore.getState().settings;
  const target = option("Queue");
  assert(target instanceof HTMLButtonElement, "Queue must be selectable");
  flushSync(() => target.click());
  await waitFor(() => settings.sendWhileRunningMode === "queue" &&
    useAppStore.getState().settings?.sendWhileRunningMode === "queue",
  "Queue must persist through settings IPC and reach the renderer store");
  assert(settings.sendWhileRunningMode === "queue",
    "Choosing Queue must persist the preference through settings IPC");
  // Nested values are rebuilt objects, so compare them by content.
  const changed = Object.keys(settings).filter(
    (key) => JSON.stringify(settings[key]) !== JSON.stringify(before?.[key]),
  );
  assert(changed.length === 1 && changed[0] === "sendWhileRunningMode",
    `Choosing Queue must persist only the changed preference, got ${changed.join(", ")}`);
  assert(useAppStore.getState().settings?.sendWhileRunningMode === "queue",
    "The renderer store must carry the saved preference");
  assert(option("Queue")?.getAttribute("aria-pressed") === "true",
    "Queue must render as selected after saving");
  assert(option("Send immediately")?.getAttribute("aria-pressed") === "false",
    "Send immediately must stop reading as selected");

  // Leaving the page and coming back must render the stored value.
  await select("General");
  await select("Chat");
  assert(option("Queue")?.getAttribute("aria-pressed") === "true",
    "Reopening Chat must show the persisted Queue preference");

  flushSync(() => option("Send immediately").click());
  await waitFor(() => settings.sendWhileRunningMode === "immediate" &&
    useAppStore.getState().settings?.sendWhileRunningMode === "immediate",
  "The immediate default must be restorable");
  return { preferenceHost: "chat", defaultMode: "immediate", saved: "queue", reloaded: "queue", restored: "immediate" };
}
window.settingsScrollProbe = async () => {
  await settle();
  assert(
    document.activeElement === document.querySelector(".settings-back"),
    "Mounting Settings must move focus to the rail's back action",
  );
  // The retired in-page rail search is gone; the back action stays in the rail's
  // top band, above the scrollable destination list, on the same left edge.
  assert(document.querySelector(".settings-search") === null,
    "The Settings rail must not carry a page-local search input");
  const back = document.querySelector(".settings-back");
  const navScroll = document.querySelector(".settings-nav-scroll");
  assert(back && navScroll, "Settings must render the back action and the destination list");
  const backBounds = back.getBoundingClientRect();
  const navBounds = navScroll.getBoundingClientRect();
  assert(backBounds.bottom <= navBounds.top + 1, "Back to app must sit above the destination list");
  const railBounds = document.querySelector(".settings-nav").getBoundingClientRect();
  assert(backBounds.left - railBounds.left < 24, "Back to app must sit at the rail's left edge");
  const checks = [];
  checks.push(await exerciseProxyDraftRestoration());
  await checkCloudSyncVisibility();
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    await select("Chat");
    const position = await scroll();
    await select("Chat");
    assert(pane().scrollTop === position, "Re-selecting Chat must retain scroll");
    flushSync(() => useAppStore.setState({ settings: { ...settings, enterToSend: false } }));
    await settle();
    assert(pane().scrollTop === position, "Settings updates must retain scroll");
    await select("General");
    assert(pane().scrollTop === 0, "Chat → General must start at top");
    await scroll();
    await select("Chat");
    assert(pane().scrollTop === 0, "Returning to Chat must start at top");
    await scroll();
    await select("Themes A");
    assert(pane().scrollTop === 0, "Built-in → extension must start at top");
    const extensionPosition = await scroll();
    await select("Themes A");
    assert(pane().scrollTop === extensionPosition, "Re-selecting extension must retain scroll");
    await select("Themes B");
    assert(pane().scrollTop === 0, "Extension → extension must start at top");
    await scroll();
    await select("Chat");
    assert(pane().scrollTop === 0, "Extension → unchanged built-in tab must start at top");
    await select("Themes A");
    await scroll();
    flushSync(() => useAppStore.getState().setSettingsTab("shortcuts"));
    assert(!document.querySelector(".plugin-scenic-theme-card"), "External tab change must leave the plugin");
    // The retired shortcuts tab id resolves to General, which owns the
    // keyboard-shortcuts section.
    assert(document.querySelector(".settings-section-title")?.textContent?.includes("General"), "Legacy shortcuts tab must resolve to General");
    assert(document.querySelector(".shortcut-map"), "Legacy shortcuts tab must land on the keyboard shortcuts section");
    assert(pane().scrollTop === 0, "External tab change must start at the top");
    await select("Themes A");
    await scroll();
    flushSync(() => {
      useAppStore.getState().setSettingsAnchor("settings.enterToSend");
      useAppStore.getState().setSettingsTab("ai");
    });
    assert(!document.querySelector(".plugin-scenic-theme-card"), "Search must leave the plugin destination");
    const fromPlugin = document.querySelector(".settings-anchor-flash");
    assert(fromPlugin && pane().scrollTop > 0, "Search from a plugin must be positioned before paint");
    const fromPluginBounds = fromPlugin.getBoundingClientRect();
    const fromPluginViewport = pane().getBoundingClientRect();
    assert(fromPluginBounds.top >= fromPluginViewport.top && fromPluginBounds.bottom <= fromPluginViewport.bottom,
      "Search from a plugin must show the target");
    // The same public store entry points used by SearchDialog.openSettingsHit.
    await select("General");
    await scroll();
    flushSync(() => {
      useAppStore.getState().setSettingsAnchor("settings.enterToSend");
      useAppStore.getState().setSettingsTab("ai");
    });
    const target = document.querySelector(".settings-anchor-flash");
    assert(target && pane().scrollTop > 0, "Search anchor must be positioned before paint");
    const bounds = target.getBoundingClientRect();
    const viewport = pane().getBoundingClientRect();
    assert(bounds.top >= viewport.top && bounds.bottom <= viewport.bottom,
      "Search target must be visible");
    assert(useAppStore.getState().settingsAnchor === null, "Search anchor must be consumed");
    const anchoredPosition = pane().scrollTop;
    await settle();
    assert(pane().scrollTop === anchoredPosition, "Consuming anchor must not reset scroll");
    pane().scrollTop = 0;
    flushSync(() => useAppStore.getState().setSettingsAnchor("settings.enterToSend"));
    const withinTab = document.querySelector(".settings-anchor-flash");
    assert(withinTab && pane().scrollTop > 0, "Search within the active tab must be positioned before paint");
    await settle();
    assert(pane().scrollTop > 0, "Search within the active tab must still locate its row");
    checks.push({ theme, ok: true });
  }
  checks.push(await exerciseUpdatePreference());
  checks.push(await exerciseSendWhileRunning());
  checks.push(await exerciseBrazilianPortuguese());
  return { ok: true, checks };
};
