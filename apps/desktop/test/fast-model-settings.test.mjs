import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

function loadSettingsIpc() {
  const file = new URL("../electron/main/ipc/settings-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (id === "@pi-desktop/shared") return { IPC };
    if (id === "../network-proxy") return { currentSystemProxyRelayUrl: () => null };
    throw new Error(`Unexpected settings IPC dependency ${id}`);
  }, module.exports, module);
  return module.exports;
}

const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});

async function registerSettingsHandler(validateSettingsWrite) {
  const handlers = new Map();
  const storage = new Map();
  let persisted = { defaultMode: "agent", theme: "system", enterToSend: true };
  storage.set("app", persisted);
  const host = {
    async call(method, value) {
      if (method === "settings.get") return structuredClone(persisted);
      if (method === "settings.set") {
        persisted = { ...persisted, ...JSON.parse(JSON.stringify(value)) };
        storage.set("app", structuredClone(persisted));
        return structuredClone(persisted);
      }
      throw new Error(`Unexpected host method ${method}`);
    },
  };
  const { registerSettingsIpc } = loadSettingsIpc();
  registerSettingsIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, getSidecar: () => null, dataDir: "/test-data",
    normalizeSettings: (value) => value, validateSettingsWrite,
    testNetworkProxy: async () => ({}), applyNetworkProxyFromAppSettings: async () => {},
    currentNetworkProxy: () => null, applyApplicationMenuSettings: () => {},
    applyDeveloperMode: () => {}, applyPreventScreenSleep: () => {},
    applyKeepAwakeWhileRunning: () => {}, applyUpdatePreference: () => {},
    resolveEffectiveCommandShell: async () => ({}),
  });
  return { handlers, storage };
}

test("quick model selection and clear persist across renderer JSON, settings IPC, host merge, and reread", async () => {
  const previousWindow = globalThis.window;
  try {
    const { api, validateSettingsWrite, normalizeSettings } = await server.ssrLoadModule("/src/lib/api.ts");
    const harness = await registerSettingsHandler(validateSettingsWrite);
    globalThis.window = { piDesktop: { platform: "darwin", invoke: async (channel, ...args) => {
      const data = await harness.handlers.get(channel)(...args);
      return { ok: true, data };
    } } };
    const legacy = { defaultMode: "agent", theme: "system", enterToSend: true };
    assert.equal(normalizeSettings(legacy).fastModelId, undefined);
    assert.equal(validateSettingsWrite(legacy).fastModelId, undefined);
    await api.setSettings({ ...legacy, fastModelProviderId: "provider-a", fastModelId: "model-one" });
    const selected = await api.getSettings();
    assert.deepEqual([selected.fastModelProviderId, selected.fastModelId], ["provider-a", "model-one"]);
    assert.deepEqual([harness.storage.get("app").fastModelProviderId, harness.storage.get("app").fastModelId], ["provider-a", "model-one"]);
    await api.setSettings({ ...selected, fastModelProviderId: null, fastModelId: null });
    const reread = await api.getSettings();
    assert.deepEqual([reread.fastModelProviderId, reread.fastModelId], [null, null]);
    assert.deepEqual([harness.storage.get("app").fastModelProviderId, harness.storage.get("app").fastModelId], [null, null]);
    assert.equal(JSON.stringify({ fastModelProviderId: null, fastModelId: null }), '{"fastModelProviderId":null,"fastModelId":null}');
    await assert.rejects(() => harness.handlers.get(IPC.invoke.settingsSet)({ ...legacy, fastModelProviderId: "provider-a", fastModelId: null }), /incomplete/);
    assert.throws(() => validateSettingsWrite({ ...legacy, fastModelProviderId: null, fastModelId: "model-one" }), /incomplete/);
  } finally {
    globalThis.window = previousWindow;
    await server.close();
  }
});
