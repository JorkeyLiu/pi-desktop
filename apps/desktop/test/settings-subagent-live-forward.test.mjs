// Regression: a live `settings.set` that carries `subagentWakeup` /
// `subagentSelfHandoff` must reach a live sidecar runtime.
//
// The Rust `settings.set` RPC answers `{"ok":true}`
// (crates/host-core/src/rpc/mod.rs), not the merged AppSettings. The handler
// therefore has to forward the values the caller actually provided, not read
// them back off the RPC result — otherwise the `sidecar.configure` payload
// serializes without the field and `applySubagentWakeupConfigure` treats the
// save as unrelated, leaving live sessions on the previous trigger.
//
// Exercised through the real registered IPC handler
// (electron/main/ipc/settings-ipc.ts) with an external `host.call` mock that
// answers exactly what the Rust host answers, then through the same NDJSON
// line the desktop transport writes (packages/host-runtime/src/agent-sidecar.ts)
// and the real sidecar-side helper
// (packages/agent-runtime/src/sidecar-subagent-wakeup.ts).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";

function loadTranspiled(relativeUrl, dependencies = {}) {
  const file = new URL(relativeUrl, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (Object.prototype.hasOwnProperty.call(dependencies, id)) {
        return dependencies[id];
      }
      throw new Error(`Unexpected dependency ${id}`);
    },
    module.exports,
    module,
  );
  return module.exports;
}

/** Rust `settings.set` answers `{"ok":true}` and merges into the store. */
function registerSettingsHandler(initialSettings) {
  const handlers = new Map();
  const configureCalls = [];
  let persisted = structuredClone(initialSettings);
  const host = {
    binaryPath: "/tmp/settings-live-forward/host-core",
    async call(method, value) {
      if (method === "settings.get") return structuredClone(persisted);
      if (method === "settings.set") {
        persisted = { ...persisted, ...JSON.parse(JSON.stringify(value ?? {})) };
        return { ok: true };
      }
      throw new Error(`Unexpected host method ${method}`);
    },
  };
  const sidecar = {
    async call(method, params) {
      configureCalls.push({ method, params });
      return { ok: true };
    },
  };
  const { registerSettingsIpc } = loadTranspiled(
    "../electron/main/ipc/settings-ipc.ts",
    {
      "@pi-desktop/shared": { IPC },
      "../network-proxy": { currentSystemProxyRelayUrl: () => null },
    },
  );
  registerSettingsIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => sidecar,
    dataDir: "/tmp/settings-live-forward/data",
    normalizeSettings: (value) => value,
    validateSettingsWrite: (value) => value,
    testNetworkProxy: async () => ({}),
    applyNetworkProxyFromAppSettings: async () => {},
    currentNetworkProxy: () => null,
    applyApplicationMenuSettings: () => {},
    applyDeveloperMode: () => {},
    applyPreventScreenSleep: () => {},
    applyKeepAwakeWhileRunning: () => {},
    applyUpdatePreference: () => {},
    resolveEffectiveCommandShell: async () => ({ shells: [], defaultShellId: null }),
  });
  return {
    invoke: (channel, ...args) => handlers.get(channel)(...args),
    configureCalls,
    persisted: () => structuredClone(persisted),
  };
}

/** The exact NDJSON request line the desktop transport writes for a call. */
function wireParams(configureCall) {
  const line = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 91,
    method: configureCall.method,
    params: configureCall.params,
  })}\n`;
  return JSON.parse(line).params;
}

/** Push the received payload through the real sidecar-side helper. */
function applyToLiveRuntime(params) {
  const { applySubagentWakeupConfigure } = loadTranspiled(
    "../../../packages/agent-runtime/src/sidecar-subagent-wakeup.ts",
  );
  const applied = [];
  const runtimes = new Map([
    [
      "session-live",
      {
        setSubagentWakeup(value) {
          applied.push(value);
        },
      },
    ],
  ]);
  const updated = applySubagentWakeupConfigure(runtimes, params);
  return { updated, applied };
}

const initialSettings = {
  language: "auto",
  theme: "system",
  defaultMode: "agent",
  subagentWakeup: { kind: "off" },
  subagentSelfHandoff: { kind: "off" },
};

const wakeupCases = [
  { kind: "time", value: 60 },
  { kind: "tool-calls", value: 25 },
  { kind: "context-tokens", value: 400_000 },
  { kind: "off" },
];

for (const wakeup of wakeupCases) {
  test(`settings.set forwards subagentWakeup ${JSON.stringify(wakeup)} to a live runtime`, async () => {
    const harness = registerSettingsHandler(initialSettings);

    // The IPC result stays the host contract, not a synthesized AppSettings.
    const returned = await harness.invoke(IPC.invoke.settingsSet, {
      subagentWakeup: wakeup,
    });
    assert.deepEqual(returned, { ok: true });

    // Stored value is correct: both the store and a re-read through IPC.
    assert.deepEqual(harness.persisted().subagentWakeup, wakeup);
    const readback = await harness.invoke(IPC.invoke.settingsGet);
    assert.deepEqual(readback.subagentWakeup, wakeup);

    // Forwarded value survives the JSON line the sidecar actually receives.
    assert.equal(harness.configureCalls.length, 1);
    const { method, params } = harness.configureCalls[0];
    assert.equal(method, "sidecar.configure");
    const wire = wireParams(harness.configureCalls[0]);
    assert.deepEqual(wire.subagentWakeup, wakeup);

    // And the real helper applies it to the live runtime.
    const live = applyToLiveRuntime(wire);
    assert.equal(live.updated, true);
    assert.deepEqual(live.applied, [wakeup]);

    // An unrelated field belongs to no other session's write.
    assert.equal(
      Object.prototype.hasOwnProperty.call(wire, "subagentSelfHandoff"),
      false,
    );
    assert.deepEqual(harness.persisted().subagentSelfHandoff, { kind: "off" });
  });
}

test("settings.set forwards subagentSelfHandoff to a live runtime", async () => {
  const harness = registerSettingsHandler(initialSettings);
  const handoff = { kind: "time", value: 30 };
  const returned = await harness.invoke(IPC.invoke.settingsSet, {
    subagentSelfHandoff: handoff,
  });
  assert.deepEqual(returned, { ok: true });
  assert.deepEqual(harness.persisted().subagentSelfHandoff, handoff);
  const readback = await harness.invoke(IPC.invoke.settingsGet);
  assert.deepEqual(readback.subagentSelfHandoff, handoff);

  const wire = wireParams(harness.configureCalls[0]);
  assert.deepEqual(wire.subagentSelfHandoff, handoff);
  assert.equal(Object.prototype.hasOwnProperty.call(wire, "subagentWakeup"), false);
  assert.deepEqual(harness.persisted().subagentWakeup, { kind: "off" });
});

test("a save that does not touch the wake fields forwards neither of them", async () => {
  const harness = registerSettingsHandler(initialSettings);
  await harness.invoke(IPC.invoke.settingsSet, { theme: "dark" });

  assert.equal(harness.persisted().theme, "dark");
  assert.equal(harness.configureCalls.length, 1);
  const wire = wireParams(harness.configureCalls[0]);
  assert.equal(Object.prototype.hasOwnProperty.call(wire, "subagentWakeup"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(wire, "subagentSelfHandoff"),
    false,
  );
  // Untouched fields keep their persisted values.
  assert.deepEqual(harness.persisted().subagentWakeup, { kind: "off" });
  assert.deepEqual(harness.persisted().subagentSelfHandoff, { kind: "off" });
  // The configure payload still carries the non-settings wiring.
  assert.equal(wire.hostBinary, "/tmp/settings-live-forward/host-core");
  assert.equal(wire.dataDir, "/tmp/settings-live-forward/data");
});
