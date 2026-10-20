import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { bindingForCustomModel, IPC } from "@pi-desktop/shared";
import { ExtensionPromptHost } from "../../src/components/ExtensionPromptDialog";
import { SessionRenameDialog } from "../../src/components/SessionRenameDialog";
import { ProjectInstructionsDialog } from "../../src/components/ProjectInstructionsDialog";
import { ProjectMemoryDialog } from "../../src/components/ProjectMemoryDialog";
import { ProjectDeleteDialog } from "../../src/components/ProjectDeleteDialog";
import { PluginInstallDialog } from "../../src/components/plugins/PluginInstallDialog";
import { OAuthLoginDialog } from "../../src/components/settings/OAuthLoginDialog";
import { PluginDialogs } from "../../src/features/plugins/PluginDialogs";
import { PluginSettingsSheet } from "../../src/components/plugins/PluginSettingsSheet";
import { newInstallJob } from "../../src/features/plugins/install-progress";
import { ModelSelectionPanes } from "../../src/components/settings/ModelSelectionPanes";
import { isBlockingOverlayActive } from "../../src/lib/blocking-overlay";

const listeners = new Map();
const path = "C:\\Users\\Example\\AppData\\Local\\Temp\\pi-extension-fixture\\plugins\\greet\\src\\greet.ts";
const long = "Project_" + "abcdefghij".repeat(25);
window.piDesktop = {
  platform: "win32",
  on(channel, listener) {
    const set = listeners.get(channel) ?? new Set();
    listeners.set(channel, set); set.add(listener);
    return () => set.delete(listener);
  },
  async invoke(channel, ...args) {
    if (channel === IPC.invoke.extensionsUiRespond) window.dialogFixture.responses.push(args[0]);
    return { ok: true, data: { project: { scope: "project", path, content: "Fixture instructions", exists: true },
      content: "Fixture instructions", memory: { content: "", entries: [] } } };
  },
};
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: Object.fromEntries(["en", "zh-CN"].map((locale) => [locale, { translation: flattenCatalog(catalogs[locale]) }])),
  interpolation: { escapeValue: false } });
const root = createRoot(document.getElementById("root"));
let revision = 0;
const frame = () => new Promise(requestAnimationFrame);
const close = () => { window.dialogFixture.closed = true; flushSync(() => root.render(null)); };
const error = (value) => { throw value; };

const modelIds = ["grok-4.5", "grok-4.6", "grok-4.7", "grok-4.7-build-fast"];
function ModelPickerFixture() {
  const [models, setModelsState] = useState(() => modelIds.map(bindingForCustomModel));
  const rows = modelIds.map((id) => ({
    id,
    displayName: id.replace("grok", "Grok"),
    contextWindow: 200_000,
    maxTokens: 4_000,
  }));
  return (
    <div
      className="dialog-fixture-models"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "min(520px, calc(100vh - 48px))",
        minHeight: 0,
        padding: 24,
      }}
    >
      <ModelSelectionPanes
        discovery={{ status: "success", source: "remote", models: [], error: "" }}
        selection={{
          rows,
          models,
          publishedLevelsById: new Map(),
          bindingsToPersist: models,
          setModels: (update) => setModelsState((current) => update(current)),
        }}
        listTitle="Service models"
      />
    </div>
  );
}

// Regression surface: the rename dialog is mounted by parents (Sidebar,
// ProjectsPage) that pass a fresh inline onClose closure on every rerender.
// This fixture reproduces exactly that: each render creates new callback
// identities while the dialog stays mounted.
let bumpRename = () => {};
function RenameRerenderFixture() {
  const [tick, setTick] = useState(0);
  bumpRename = () => flushSync(() => setTick((current) => current + 1));
  window.dialogFixture.renameRenderTick = tick;
  return (
    <SessionRenameDialog
      session={{ id: "s", title: long }}
      onClose={() => {
        window.dialogFixture.renameClosedByTick = tick;
        close();
      }}
      onSave={async (value) => {
        window.dialogFixture.saved = value;
      }}
      onError={error}
    />
  );
}

window.dialogFixture = {
  responses: [], closed: false, saved: null, renameRenderTick: 0, renameClosedByTick: null,
  isBlockingOverlayActive,
  rerender() { bumpRename(); },
  async show(kind, options = {}) {
    flushSync(() => root.render(null));
    this.responses = []; this.closed = false; this.saved = null;
    this.renameRenderTick = 0; this.renameClosedByTick = null;
    document.documentElement.dataset.theme = options.theme ?? "light";
    await i18n.changeLanguage(options.locale ?? "en");
    const project = { name: long, path, groupId: "fixture-group", sessionCount: 2 };
    const props = { project, onClose: close, onSaved() {}, onError: error };
    let component;
    if (kind === "extension") component = <ExtensionPromptHost key={++revision} />;
    if (kind === "rename") component = <SessionRenameDialog session={{ id: "s", title: long }} onClose={close} onSave={async (value) => { this.saved = value; }} onError={error} />;
    if (kind === "rename-rerender") { renameTrigger.focus(); component = <RenameRerenderFixture key={++revision} />; }
    if (kind === "instructions") component = <ProjectInstructionsDialog {...props} />;
    if (kind === "memory") component = <ProjectMemoryDialog {...props} />;
    if (kind === "delete") component = <ProjectDeleteDialog {...props} runningSessionIds={[]} onDeleted={() => {}} />;
    if (kind === "install") component = <PluginInstallDialog job={{ ...newInstallJob({ id: "fixture", name: long, grantedPermissions: [], autoUpdate: false }), status: "failed", error: long }} onCancel={close} onRetry={() => {}} onClose={close} />;
    if (kind === "plugin-settings") component = <PluginSettingsSheet plugin={{ id: "fixture", name: long, settings: [] }} platform="win32" onClose={close} onSaved={() => {}} />;
    if (kind === "plugin-review") component = <PluginDialogs t={i18n.t.bind(i18n)} pendingInstall={{ id: "fixture", name: long, permissions: [] }} setPendingInstall={close} confirmInstall={close} autoUpdate={false} setAutoUpdate={() => {}} />;
    if (kind === "oauth") component = <OAuthLoginDialog vendor={{ id: "fixture", name: "Fixture" }} onClose={close} onDone={close} session={{
      subscribe(listener) { queueMicrotask(() => listener({ kind: "authUrl", url: "https://example.invalid/" + long, instructions: "Open the sign-in URL", opened: false })); return () => {}; },
      cancel: async () => {},
    }} />;
    if (kind === "models") component = <ModelPickerFixture key={++revision} />;
    flushSync(() => root.render(component));
    await frame();
    if (kind === "extension") {
      const requestKind = options.request ?? "input";
      const request = { kind: requestKind, title: options.longTitle ? long : "Your name?",
        placeholder: "e.g. Ann", message: long.repeat(2), options: [long, "Second option"] };
      for (const listener of listeners.get(IPC.event.extensionsUiPrompt) ?? []) {
        listener({ promptId: `fixture-${revision}`, sessionId: "s", extensionId: path,
          extensionLabel: options.longTitle ? long : "greet", request });
      }
    }
    await frame(); await frame();
    await Promise.all(document.getAnimations().filter((animation) => animation.effect.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  },
};
// Stand-in for whatever had focus before the dialog opened, so focus
// restoration is observable. Kept 1px and unpainted so it cannot overlap a
// dialog under pointer hit-testing.
const renameTrigger = document.createElement("button");
renameTrigger.id = "rename-trigger";
renameTrigger.type = "button";
renameTrigger.textContent = "open rename";
renameTrigger.style.cssText =
  "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;padding:0;border:0;overflow:hidden";
document.body.appendChild(renameTrigger);
