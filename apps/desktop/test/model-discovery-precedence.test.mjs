/**
 * The AI service is the authority on which models it serves.
 *
 * `providersListModels` must probe the configured endpoint through its static
 * resolution before anything else, enrich only what the service returned, and
 * report a failed discovery as `source: "fallback"` with every configured
 * binding, the default id and the endpoint error. Canonical models.dev data is
 * never an availability list and never fills a failed probe.
 *
 * These tests register the real IPC handler and drive it through the service
 * path with fake host, endpoint sweep and catalog. No source text is asserted.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC } from "../../../packages/shared/src/protocol.ts";
import * as modelsDev from "../electron/main/models-dev-catalog.ts";

/** Minimal CJS loader for the main-process module under test. */
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const profile = {
  origin: "https://relay.example",
  candidates: ["https://relay.example/v1/models"],
  effectiveBaseUrl: "https://relay.example/v1",
};

function harness({ providers, outcome, attempts = [], cachedModels = [] }) {
  const handlers = new Map();
  const sweepCalls = [];
  const catalogCalls = [];
  const hostCalls = [];
  const cacheWrites = [];
  const modelsDevCatalog = {
    ensureLoaded: async () => true,
    loadLocal: async () => true,
    refresh: async () => true,
    getStatus: () => ({ loaded: true }),
    deleteAccount: () => {},
    configureAccount: (row) => catalogCalls.push(["configureAccount", row.id]),
    findModel: (input) => {
      catalogCalls.push(["findModel", input.modelId]);
      return undefined;
    },
    publishedModelFor: (input) => {
      catalogCalls.push(["publishedModelFor", input.modelId]);
      return undefined;
    },
    modelsForProvider: (input) => {
      catalogCalls.push(["modelsForProvider", input]);
      return [];
    },
    modelConfigFor: () => ({ modalities: { input: ["text"], output: ["text"] } }),
    settingsMetadataFor: () => undefined,
  };
  const host = {
    call: async (method, input) => {
      hostCalls.push(method);
      if (method === "providers.list") return { providers };
      if (method === "providers.getSecret") return { value: "stored-key" };
      if (method === "providers.listModels") return { models: cachedModels };
      if (method === "providers.cacheModels") {
        cacheWrites.push(input?.models ?? []);
        return {};
      }
      return {};
    },
  };
  const { registerProviderIpc } = load("../electron/main/ipc/provider-ipc.ts", {
    "@pi-desktop/shared": {
      IPC,
      ErrorCodes,
      inferEndpointProfile: () => profile,
      normalizeApiStyle: (value) => value ?? "chat_completions",
      resolveBindingLimits: () => ({}),
    },
    "../oauth": { OAUTH_AUTH_KIND: "oauth", VendorOAuth: {} },
    "../model-discovery": { probeProviderEndpoint: async () => undefined },
    "../provider-endpoint-probe": {
      probeDiscoveryCandidates: async (input) => {
        sweepCalls.push(input);
        return { attempts, outcome };
      },
    },
    "../models-dev-catalog": modelsDev,
    "../host-process": {},
    "../logger": { app: () => {} },
    "./types": {},
  });
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    modelsDevCatalog,
    vendorOAuth: {},
    logger: { app: () => {} },
    enrichProvider: (provider) => provider,
    listRuntimeProviders: async () => providers,
    enrichProviderList: async (result) => result,
    bindingForModel: () => undefined,
  });
  const handler = handlers.get(IPC.invoke.providersListModels);
  assert.equal(typeof handler, "function", "providersListModels is not registered");
  return {
    call: (input) => handler(input),
    sweepCalls,
    catalogCalls,
    hostCalls,
    cacheWrites,
  };
}

const configuredRow = {
  id: "relay",
  name: "Relay",
  vendorKey: "custom",
  baseUrl: "https://relay.example/v1",
  apiStyle: "chat_completions",
  authKind: "none",
  models: [{ id: "configured-a" }, { id: "configured-b" }],
  defaultModelId: "configured-default",
};

test("a failed discovery reports the endpoint error and keeps every configured id", async (t) => {
  const h = harness({
    providers: [configuredRow],
    attempts: [
      { baseUrl: "https://relay.example/v1/models", error: "401 unauthorized" },
      { baseUrl: "https://relay.example/v1/models?format=openai", error: "404 not found" },
    ],
  });
  const result = await h.call({ providerId: "relay", source: "refresh" });
  assert.equal(result.source, "fallback");
  assert.match(result.error, /401 unauthorized/);
  assert.match(result.error, /404 not found/);
  // The default id and both configured bindings stay visible for offline edits.
  assert.deepEqual(
    result.models.map((model) => model.modelId).sort(),
    ["configured-a", "configured-b", "configured-default"].sort(),
  );
  for (const id of ["configured-a", "configured-b"]) {
    assert.equal(result.models.find((model) => model.modelId === id)?.source, "user");
  }
  // Availability is never invented from the canonical catalog.
  assert.equal(h.catalogCalls.some(([method]) => method === "modelsForProvider"), false);
  assert.deepEqual(h.cacheWrites, [], "a failed discovery writes no model cache");
});

test("discovery probes the resolved candidates after the stored secret", async (t) => {
  const h = harness({ providers: [configuredRow], attempts: [] });
  await h.call({ providerId: "relay", source: "refresh" });
  assert.equal(h.sweepCalls.length, 1);
  assert.deepEqual(h.sweepCalls[0], {
    origin: profile.origin,
    candidates: profile.candidates,
    apiKey: "stored-key",
    headers: undefined,
  });
  assert.equal(h.hostCalls.filter((method) => method === "providers.getSecret").length, 1);
  assert.equal(h.sweepCalls[0].apiKey, "stored-key", "the stored secret resolves before the probe");
  assert.equal(h.catalogCalls.some(([method]) => method === "modelsForProvider"), false);
});

test("a live answer is reported as remote, keeps configured extras and caches only served ids", async (t) => {
  const h = harness({
    providers: [configuredRow],
    outcome: {
      effectiveBaseUrl: "https://relay.example/v1",
      discoveryStyle: "chat_completions",
      evidence: { type: "models" },
      models: [{ modelId: "served-a", displayName: "Served A" }],
    },
  });
  const result = await h.call({ providerId: "relay", source: "refresh" });
  assert.equal(result.source, "remote");
  assert.equal(result.effectiveBaseUrl, "https://relay.example/v1");
  assert.deepEqual(
    result.models.map((model) => model.modelId).sort(),
    ["configured-a", "configured-b", "served-a"].sort(),
  );
  assert.equal(result.models.find((model) => model.modelId === "served-a").source, "discovered");
  assert.equal(result.models.find((model) => model.modelId === "configured-a").source, "user");
  // Only the endpoint's own answer is cached; configured ids never become
  // evidence that the service serves them.
  assert.equal(h.cacheWrites.length, 1);
  assert.deepEqual(h.cacheWrites[0].map((model) => model.modelId), ["served-a"]);
});

test("a cached read preserves configured ids without probing the network", async (t) => {
  const h = harness({
    providers: [configuredRow],
    cachedModels: [{ modelId: "cached-a", displayName: "Cached A", source: "discovered" }],
  });
  const result = await h.call({ providerId: "relay", source: "cache" });
  assert.equal(result.source, "cache");
  assert.deepEqual(
    result.models.map((model) => model.modelId).sort(),
    ["cached-a", "configured-a", "configured-b"].sort(),
  );
  assert.deepEqual(h.sweepCalls, [], "a cache read never contacts the service");
  assert.deepEqual(h.hostCalls, ["providers.list", "providers.listModels"]);
});
