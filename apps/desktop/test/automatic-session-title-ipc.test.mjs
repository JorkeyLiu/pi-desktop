import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes, err, ok } from "../../../packages/shared/src/errors.ts";
import { IPC } from "../../../packages/shared/src/protocol.ts";

// The real Electron main registration and the real automatic-title service run
// here. Only module edges the claim does not cover (other IPC registrars) and
// the host/model boundaries are substituted: `host.call` is the RPC boundary
// and `completeFastModelTitle` is the model boundary.

function loadTs(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  const require = (id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency ${id} from ${relative}`);
    return imports[id];
  };
  new Function("require", "exports", "module", outputText)(require, module.exports, module);
  return module.exports;
}

const shared = { ErrorCodes, IPC, err, ok };
const automaticTitle = loadTs("../electron/main/services/automatic-session-title.ts", {});
const fastModelTitle = loadTs("../electron/main/ipc/fast-model-title-ipc.ts", {
  "@pi-desktop/shared": shared,
  "../services/automatic-session-title": automaticTitle,
});

const noop = () => undefined;
const noopRegister = () => undefined;
const registerImports = {
  "node:path": path,
  electron: { dialog: {}, shell: { openPath: async () => undefined } },
  "@pi-desktop/shared": shared,
  "../remote/backend-router": { ROUTE_LOCAL: Symbol("local") },
  "../agent-extensions-ipc": { registerAgentExtensionIpc: noopRegister },
  "../npm-preferences": { readNpmPath: noop, writeNpmPath: noop },
  "./agent-ipc": { registerAgentIpc: noopRegister },
  "./app-ipc": { registerAppIpc: noopRegister },
  "./diagnostics-ipc": { registerDiagnosticsIpc: noopRegister },
  "./market-ipc": { registerMarketIpc: noopRegister },
  "./mcp-ipc": { registerMcpIpc: noopRegister },
  "../mcp-registry-catalog": { searchMcpMarket: noop },
  "./notification-ipc": { registerNotificationIpc: noopRegister },
  "./plugin-ipc": { registerPluginIpc: noopRegister },
  "./plugin-ui-ipc": { registerPluginUiIpc: noopRegister },
  "./jev-ipc": { registerJevIpc: noopRegister },
  "./provider-ipc": { registerProviderIpc: noopRegister },
  "./scheduled-ipc": { registerScheduledIpc: noopRegister },
  "./session-ipc": { registerSessionIpc: noopRegister },
  "./fast-model-title-ipc": fastModelTitle,
  "./settings-ipc": { registerSettingsIpc: noopRegister },
  "../storage/ipc": { registerStorageIpc: noopRegister },
  "./config-sync-ipc": { registerConfigSyncIpc: noopRegister },
  "./skills-ipc": { registerSkillsIpc: noopRegister },
  "./agent-import-ipc": { registerAgentImportIpc: noopRegister },
  "./remote-host-ipc": { registerRemoteHostIpc: noopRegister },
  "../skill-market-catalog": { fetchSkillMarketDocument: noop, searchSkillMarket: noop },
  "./window-ipc": { registerWindowIpc: noopRegister },
  "./worktree-ipc": { registerWorktreeIpc: noopRegister },
  "./workspace-ipc": { createComposerTemplateLoader: () => noop, registerWorkspaceIpc: noopRegister },
  "./composer-ipc": { registerComposerIpc: () => ({}) },
  "./speech-ipc": { registerSpeechIpc: noopRegister },
  "./voice-ipc": { registerVoiceIpc: noopRegister },
  "./live-voice-ipc": { registerLiveVoiceIpc: noopRegister },
};
const { registerIpcHandlers } = loadTs("../electron/main/ipc/register.ts", registerImports);

function harness({ settings, source = "desktop" }) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, listener) => handlers.set(channel, listener) };
  const hostCalls = [];
  const completions = [];
  const host = {
    call: async (method, params) => {
      hostCalls.push({ method, params });
      if (method === "settings.get") return settings;
      if (method === "session.get") return { session: { id: params.id, source } };
      if (method === "session.setAutomaticTitle") return { updated: true };
      throw new Error(`unexpected host call: ${method}`);
    },
  };
  const dependencies = new Proxy(
    {
      isQuitting: () => false,
      ipcMain,
      getMainWindow: () => null,
      getHost: () => host,
      getSidecar: () => null,
      getAgentHostBridge: () => null,
      getNotificationViewingSessionId: () => null,
      setNotificationViewingSessionId: noop,
      dataDir: "/tmp/pi-automatic-title-test",
      logger: { app: noop },
      traySessions: { observeInvoke: noop, setPreferences: noop },
      taskbarUnreadBadge: { observeInvoke: noop },
      completeFastModelTitle: async (request) => {
        completions.push(request);
        return { text: "Fix login flow" };
      },
    },
    { get: (target, property) => (property in target ? target[property] : noop) },
  );
  registerIpcHandlers(dependencies);
  const listener = handlers.get(IPC.invoke.sessionTitleGenerate);
  assert.equal(typeof listener, "function", "registerIpcHandlers registers the title channel");
  return {
    hostCalls,
    completions,
    invoke: (request) => listener({}, request),
    titleWrites: () => hostCalls.filter((call) => call.method === "session.setAutomaticTitle"),
  };
}

const request = { sessionId: "s1", prompt: "Fix the login flow", fallbackTitle: "Fix the login flow" };

test("configured fast model receives the completion and the CAS title write", async () => {
  const title = harness({ settings: { fastModelProviderId: "provider", fastModelId: "model" } });
  assert.deepEqual(await title.invoke(request), { ok: true, data: { updated: true } });
  assert.equal(title.completions.length, 1, "a configured fast model must be used");
  assert.equal(title.completions[0].providerId, "provider");
  assert.equal(title.completions[0].modelId, "model");
  assert.equal(title.completions[0].sessionId, "title:s1");
  assert.deepEqual(title.titleWrites(), [
    {
      method: "session.setAutomaticTitle",
      params: { id: "s1", expectedTitle: "Fix the login flow", title: "Fix login flow" },
    },
  ]);
});

test("missing fast-model binding skips completion and keeps the fallback title", async () => {
  for (const settings of [{}, { fastModelProviderId: null, fastModelId: null }]) {
    const title = harness({ settings });
    assert.deepEqual(await title.invoke(request), { ok: true, data: { updated: true } });
    assert.equal(title.completions.length, 0);
    assert.equal(title.titleWrites().length, 0);
  }
});

test("remote sessions never spend the local fast model", async () => {
  const title = harness({
    settings: { fastModelProviderId: "provider", fastModelId: "model" },
    source: "remote",
  });
  assert.deepEqual(await title.invoke(request), { ok: true, data: { updated: false } });
  assert.equal(title.completions.length, 0);
  assert.equal(title.titleWrites().length, 0);
});
