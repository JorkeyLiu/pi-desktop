import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createModels, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { buildProviderModel } from "../../../packages/agent-runtime/dist/provider-binding.js";
import {
  apiStyleForAdapter,
  bindingForCustomModelInfo,
  catalogModelIdsMatch,
  modelIdsMatch,
  resolveApiStyle,
} from "@pi-desktop/shared";
import {
  MODELS_DEV_API_URL,
  ModelsDevCatalog,
  catalogModelConfigFor,
  modelConfigFromModelsDev,
  modelInfoFromModelsDev,
  parseModelsDevCatalog,
  thinkingLevelsFromModelsDev,
} from "../electron/main/models-dev-catalog.ts";

const catalogFixture = {
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-opus-4.6": {
        id: "claude-opus-4.6",
        name: "Claude 4.6 Opus",
        description: "High-end Claude for difficult coding, planning, and slower expert reasoning",
        family: "claude-opus",
        attachment: true,
        reasoning: true,
        reasoning_options: [{
          type: "effort",
          values: ["low", "medium", "high", "xhigh", "max"],
        }],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: "2025-05-31",
        release_date: "2026-02-05",
        last_updated: "2026-03-13",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        open_weights: false,
        limit: {
          context: 1_000_000,
          input: 1_000_000,
          output: 128_000,
        },
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
          reasoning: 25,
          input_audio: 7,
          output_audio: 28,
          tiers: [{
            input: 10,
            output: 37.5,
            cache_read: 1,
            tier: { type: "context", size: 200_000 },
          }],
          context_over_200k: {
            input: 10,
            output: 37.5,
            cache_read: 1,
            cache_write: 12.5,
          },
        },
        interleaved: { field: "reasoning_content" },
        status: "stable",
        experimental: { modes: { fast: { enabled: true } } },
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "audio-only": {
        id: "audio-only",
        modalities: { input: ["audio"], output: ["text"] },
      },
      "metadata-sparse": { id: "metadata-sparse" },
    },
  },
};

function responseFor(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function loadFixtureCatalog(t, fixture = catalogFixture) {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(fixture), "utf8");
  const catalog = new ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true);
  return catalog;
}

test("published metadata retains exact Pi transcript transport bindings through runtime launch", async (t) => {
  const pi = createModels({ modelsStore: new InMemoryModelsStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  for (const provider of builtinProviders()) pi.setProvider(provider);
  for (const [vendorKey, modelId] of [
    ["deepseek", "deepseek-flash"], ["anthropic", "claude-opus-5-5"],
    ["openai", "gpt-6.1-sol"], ["openai-codex", "gpt-6.1-sol"],
  ]) {
    const original = pi.getModel(vendorKey, modelId);
    assert.ok(original, `${vendorKey}/${modelId}`);
    const catalog = await loadFixtureCatalog(t, { [vendorKey]: {
      name: vendorKey, api: original.baseUrl, models: { [modelId]: {
        id: modelId, limit: { context: 543_210, output: 40_000 }, cost: { input: 1.25, output: 2.5 },
      } },
    } });
    const target = { providerId: "account", vendorKey, modelId, baseUrl: original.baseUrl,
      apiStyle: resolveApiStyle(original.api) };
    const config = catalog.modelConfigFor(target);
    assert.equal(config.source, "models.dev");
    assert.equal(config.contextWindow, 543_210);
    assert.equal(config.maxTokens, 40_000);
    assert.equal(config.cost.input, 1.25);
    assert.deepEqual(config.transcriptBinding, { modelId, api: original.api, baseUrl: original.baseUrl });
    const provider = { ...target, id: "account", name: "Fixture", apiKey: "", authKind: "none",
      supportsReasoning: false, supportedThinkingLevels: ["off"], modelConfig: config };
    const wire = buildProviderModel(provider);
    assert.equal(wire.compat.supportsMidConvoSystemMessages, true, vendorKey);
    assert.equal(wire.compat.supportsMidConvoToolChanges, original.compat?.supportsMidConvoToolChanges === true);
    assert.equal(wire.compat.supportsAdditionalTools, original.compat?.supportsAdditionalTools === true);
    const relay = { ...target, baseUrl: "https://relay.invalid/v1" };
    assert.equal(buildProviderModel({ ...provider, ...relay, modelConfig: catalog.modelConfigFor(relay) })
      .compat.supportsMidConvoSystemMessages, false);
    assert.equal(buildProviderModel({ ...provider, modelId: `${modelId}-alias` })
      .compat.supportsMidConvoSystemMessages, false);
  }
});

test("an explicit key reads the bundled OpenAI record; an unowned endpoint keeps only references", async () => {
  const catalogPath = fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url));
  const catalog = new ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true);
  // The configured key names a published publisher, so endpoint facts answer.
  const model = catalog.findModel({ vendorKey: "openai", modelId: "gpt-6.1-sol" });
  assert.ok(model);
  assert.equal(model.limit.context, 1_050_000);
  assert.equal(model.limit.output, 128_000);
  // The ChatGPT backend is not a published endpoint and openai-codex is not a
  // catalog key, so no publisher owns the row: models.dev can only report the
  // canonical references several publishers state.
  const input = {
    providerId: "chatgpt-account",
    vendorKey: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    modelId: "gpt-6.1-sol",
  };
  const reference = catalog.resolveModelReference(input);
  assert.equal(reference.state, "ambiguous");
  assert.equal(reference.domain, undefined);
  assert.ok(reference.candidates?.length > 1);
  assert.ok(reference.candidates?.every((candidate) => candidate.modelId === "gpt-6.1-sol"));
  assert.equal(catalog.findModel(input), undefined);
  const config = catalogModelConfigFor(catalog, input);
  assert.equal(config.source, "generic", "canonical ambiguity never becomes endpoint metadata");
});

test("explicit account limits stay pinned over a later models.dev value", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    openai: {
      name: "OpenAI",
      api: "https://api.openai.com/v1",
      models: { model: { id: "model", limit: { context: 1_000_000, output: 100_000 } } },
    },
  });
  const info = modelInfoFromModelsDev(catalog.findModel({ vendorKey: "openai", modelId: "model" }), "account");
  const binding = bindingForCustomModelInfo("model", info);
  binding.contextWindow = 40_000;
  binding.contextWindowSource = "user";
  binding.maxTokens = 4_000;
  binding.maxTokensSource = "user";
  catalog.configureAccount({ id: "account", vendorKey: "openai", models: [binding] });
  const config = catalog.modelConfigFor({ providerId: "account", vendorKey: "openai", modelId: "model" });
  assert.equal(config.contextWindow, 40_000);
  assert.equal(config.maxTokens, 4_000);
  assert.equal(config.source, "models.dev");
});

function observeModelIdReads(model) {
  const modelId = model.modelId;
  let reads = 0;
  Object.defineProperty(model, "modelId", {
    configurable: true,
    get() {
      reads += 1;
      return modelId;
    },
  });
  return () => reads;
}

test("repeated model matches and misses resolve through the bounded catalog index", async (t) => {
  const catalog = await loadFixtureCatalog(t);
  const input = { vendorKey: "anthropic", modelId: "claude-opus-4.6" };
  const match = catalog.findModel(input);
  assert.ok(match);
  const reads = observeModelIdReads(match);
  const perQuery = reads();

  assert.equal(catalog.findModel({ ...input }), match);
  assert.equal(catalog.findModel({ ...input, modelId: " CLAUDE-OPUS-4.6 " }), match);
  // A repeated exact match returns the same catalog object and touches only the
  // constant-sized candidate bucket, not a full catalog scan.
  assert.ok(reads() - perQuery <= 8, "a repeated match must reuse the catalog result");

  const missing = { ...input, modelId: "unpublished-model" };
  assert.equal(catalog.findModel(missing), undefined);
  const afterMiss = reads();
  assert.equal(catalog.findModel({ ...missing }), undefined);
  assert.equal(catalog.findModel({ ...missing, modelId: " UNPUBLISHED-MODEL " }), undefined);
  // A miss resolves through an empty bucket without scanning or growing the index.
  assert.equal(reads(), afterMiss, "a repeated miss must not search again");
});

test("cached matches remain scoped to the requested provider and endpoint", async (t) => {
  const fixture = Object.fromEntries(["alpha", "beta"].map((key) => [key, {
    name: key,
    api: `https://${key}.example/v1`,
    models: {
      "shared-model": {
        id: "shared-model",
        name: `${key} model`,
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  }]));
  const catalog = await loadFixtureCatalog(t, fixture);
  const queries = [
    [{ vendorKey: "alpha", modelId: "shared-model" }, "alpha"],
    [{ vendorKey: "beta", modelId: "shared-model" }, "beta"],
    [{ vendorKey: "custom", baseUrl: "https://alpha.example/v1", modelId: "shared-model" }, "alpha"],
    [{ vendorKey: "custom", baseUrl: "https://beta.example/v1", modelId: "shared-model" }, "beta"],
    // A key naming another publisher contradicts the endpoint: ownership is
    // ambiguous and neither side answers.
    [{ vendorKey: "alpha", baseUrl: "https://beta.example/v1", modelId: "shared-model" }, undefined],
  ];
  for (const [input, providerKey] of [...queries, ...queries.toReversed()]) {
    assert.equal(catalog.findModel(input)?.providerKey, providerKey);
  }
});

test("catalog resolution reports domain, method and provenance", async (t) => {
  const fixture = {
    anthropic: {
      name: "Anthropic",
      api: "https://api.anthropic.com/v1",
      models: {
        "claude-opus-4.6": { id: "claude-opus-4.6", canonical_model_id: "anthropic/claude-opus-4.6" },
      },
    },
    twinA: { name: "Twin A", api: "https://twin-a.example/v1", models: { twin: { id: "twin" } } },
    twinB: { name: "Twin B", api: "https://twin-b.example/v1", models: { twin: { id: "twin" } } },
  };
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-provenance-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(fixture), "utf8");
  const now = Date.parse("2026-11-12T09:00:00.000Z");
  const catalog = new ModelsDevCatalog({
    catalogPath,
    now: () => now,
    fetchImpl: async () => responseFor(fixture),
  });
  assert.equal(await catalog.ensureLoaded(), true);
  assert.equal(await catalog.refresh(), true);
  const fetchedAt = new Date(now).toISOString();
  assert.equal(catalog.getProvenance().source, "remote");
  assert.equal(catalog.getProvenance().fetchedAt, fetchedAt);

  const owned = catalog.resolveModelReference({
    vendorKey: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    modelId: "claude-opus-4.6",
    endpointFetchedAt: "2026-11-12T08:30:00.000Z",
  });
  assert.equal(owned.state, "matched");
  assert.equal(owned.method, "publisher-exact-id");
  assert.equal(owned.domain, "endpoint");
  assert.equal(owned.fetchedAt, fetchedAt);
  assert.equal(owned.endpointFetchedAt, "2026-11-12T08:30:00.000Z");
  assert.equal(owned.source?.providerKey, "anthropic");

  // A canonical reference carries the same catalog provenance and claims no publisher.
  const canonical = catalog.resolveModelReference({ modelId: "Claude-Opus-4.6" });
  assert.equal(canonical.state, "matched");
  assert.equal(canonical.method, "global-exact-id-casefold");
  assert.equal(canonical.domain, "canonical");
  assert.equal(canonical.publisher.state, "unmatched");
  assert.equal(canonical.fetchedAt, fetchedAt);
  assert.equal(catalog.findModel({ modelId: "Claude-Opus-4.6" }), undefined);
  // A unique canonical basename is still a canonical reference, never endpoint capacity.
  const basename = catalog.resolveModelReference({ modelId: "unknown/claude-opus-4.6" });
  assert.equal(basename.method, "canonical-unique-basename");
  assert.equal(basename.domain, "canonical");

  // Ambiguity reports the competing owners without a value.
  const ambiguous = catalog.resolveModelReference({ modelId: "twin" });
  assert.equal(ambiguous.state, "ambiguous");
  assert.equal(ambiguous.fetchedAt, fetchedAt);
  assert.deepEqual(ambiguous.candidates?.map((candidate) => candidate.providerKey), ["twinA", "twinB"]);
  assert.equal(ambiguous.value, undefined);
});

test("unknown endpoints do not inherit ambiguous cross-provider metadata", async (t) => {
  for (const order of [["alpha", "beta"], ["beta", "alpha"]]) {
    const fixture = Object.fromEntries(order.map((key) => [key, {
      api: `https://${key}.example/v1`,
      models: {
        "shared-model": {
          id: "shared-model",
          reasoning: key === "alpha",
          limit: { context: key === "alpha" ? 128_000 : 32_000, output: 8_192 },
        },
      },
    }]));
    const catalog = await loadFixtureCatalog(t, fixture);
    for (const modelId of ["shared-model", "proxy/shared-model"]) {
      const unknown = { vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId };
      assert.equal(catalog.findModel(unknown), undefined, `ambiguous ${modelId} must miss`);
      assert.equal(catalog.findModel(unknown), undefined, "ambiguous misses are cached");
    }
    const alpha = catalog.findModel({
      vendorKey: "custom", baseUrl: "https://alpha.example/v1", modelId: "shared-model",
    });
    assert.equal(alpha?.providerKey, "alpha", "an exact endpoint scopes the lookup");
    assert.equal(alpha?.reasoning, true);
    assert.equal(alpha?.limit.context, 128_000);
    const beta = catalog.findModel({ vendorKey: "beta", modelId: "shared-model" });
    assert.equal(beta?.providerKey, "beta", "a known provider key scopes the lookup");
    assert.equal(beta?.reasoning, false);
    assert.equal(beta?.limit.context, 32_000);
  }
});

test("an unknown endpoint does not borrow a unique last-segment record", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alpha: { models: { "shared-model": { id: "shared-model", reasoning: true } } },
  });
  const input = { vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "proxy/shared-model" };
  assert.equal(catalog.findModel(input), undefined);
  assert.equal(catalog.resolveModelReference(input).state, "unmatched");
  assert.equal(catalog.modelsForProvider({ ...input, providerId: "row" }).length, 0);
});

test("a known endpoint cannot borrow another provider's record", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alpha: { api: "https://alpha.example/v1", models: { "alpha-only": { id: "alpha-only" } } },
    beta: { api: "https://beta.example/v1", models: {
      "proxy/shared-model": { id: "proxy/shared-model", reasoning: true },
    } },
  });
  assert.equal(catalog.findModel({ baseUrl: "https://alpha.example/v1", modelId: "shared-model" }), undefined);
  assert.equal(catalog.findModel({ baseUrl: "https://beta.example/v1", modelId: "shared-model" }), undefined);
  assert.equal(
    catalog.findModel({ baseUrl: "https://beta.example/v1", modelId: "proxy/shared-model" })?.providerKey,
    "beta",
  );
});

test("a shared catalog API prefers the explicitly selected vendor", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alpha: { api: "https://gateway.example/v1", models: { "alpha-only": { id: "alpha-only" } } },
    beta: { api: "https://gateway.example/v1", models: { "beta-only": { id: "beta-only" } } },
  });
  const input = { vendorKey: "beta", baseUrl: "https://gateway.example/v1" };
  assert.equal(catalog.findModel({ ...input, modelId: "beta-only" })?.providerKey, "beta");
  assert.equal(catalog.findModel({ ...input, modelId: "alpha-only" }), undefined);
});

test("a shared catalog API with no vendor key cannot select the first publisher", async (t) => {
  for (const order of [["alpha", "beta"], ["beta", "alpha"]]) {
    const catalog = await loadFixtureCatalog(t, Object.fromEntries(order.map((key) => [key, {
      api: "https://gateway.example/v1",
      models: { "shared-model": { id: "shared-model", reasoning: key === "alpha",
        limit: { context: key === "alpha" ? 128_000 : 32_000, output: 8_192 } } },
    }])));
    assert.equal(catalog.providerKeyForRow({ vendorKey: "custom", baseUrl: "https://gateway.example/v1" }), undefined);
    assert.equal(catalog.findModel({ vendorKey: "custom", baseUrl: "https://gateway.example/v1", modelId: "shared-model" }), undefined);
    assert.equal(catalog.findModel({ vendorKey: "beta", baseUrl: "https://gateway.example/v1", modelId: "shared-model" })?.providerKey, "beta");
  }
});

test("the configured key is the explicit identity when no published endpoint answers", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    openai: { models: { "shared-model": { id: "shared-model", limit: { context: 128_000 } } } },
    deepseek: { models: { "shared-model": { id: "shared-model", limit: { context: 64_000 } } } },
  });
  const input = { vendorKey: "openai", baseUrl: "https://api.deepseek.com", modelId: "shared-model" };
  const result = catalog.resolveModelReference(input);
  assert.equal(result.state, "matched");
  assert.equal(result.domain, "endpoint");
  assert.equal(result.publisher.method, "explicit-key");
  assert.equal(result.source?.providerKey, "openai");
  assert.equal(result.value?.limit.context, 128_000, "the endpoint host alone selects nothing");
});

test("model lookup memory is bounded by the catalog, not by query count", async (t) => {
  const catalog = await loadFixtureCatalog(t);
  const input = { vendorKey: "anthropic", modelId: "claude-opus-4.6" };
  const match = catalog.findModel(input);
  assert.ok(match);
  const reads = observeModelIdReads(match);

  // Thousands of distinct miss queries do not grow the per-generation index and
  // do not evict an already-resolved key from it.
  for (let index = 0; index < 3_000; index += 1) {
    assert.equal(catalog.findModel({ ...input, modelId: `unknown-${index}` }), undefined);
  }
  const beforeRepeat = reads();
  assert.equal(catalog.findModel(input), match);
  // The resolved key stays resolvable to the same object without a catalog rescan.
  assert.ok(reads() - beforeRepeat <= 8, "a resolved key stays usable after many distinct queries");
});

test("one read with more distinct keys than any cache budget does not rescan a resolved key", async (t) => {
  const catalog = await loadFixtureCatalog(t);
  const input = { vendorKey: "anthropic", modelId: "claude-opus-4.6" };
  const match = catalog.findModel(input);
  assert.ok(match);
  const reads = observeModelIdReads(match);
  const baseline = reads();
  const exactRepeats = 2_000;
  // Interleave the originally resolved key among a burst of distinct keys far
  // larger than the former 1,024-entry per-key eviction cache.
  for (let index = 0; index < exactRepeats; index += 1) {
    catalog.findModel({ ...input, modelId: `unknown-${index}` });
    catalog.findModel(input);
  }
  const touches = reads() - baseline;
  // Each exact re-query resolves through a bounded candidate bucket, so the work
  // stays proportional to the repeated queries and independent of the distinct
  // keys interleaved between them. The old 1,024-entry eviction cache would rescan
  // the whole catalog (thousands of model reads) on every repeat once its budget
  // was exceeded, growing with the distinct-key burst.
  assert.ok(
    touches <= exactRepeats * 8,
    `exact re-queries touched the model ${touches} times, expected <= ${exactRepeats * 8}`,
  );
});

test("model IDs match provider namespaces without matching model variants", () => {
  assert.equal(modelIdsMatch("anthropic-claude-opus-5", "claude-opus-5"), true);
  assert.equal(modelIdsMatch("anthropic/claude-opus-5", "claude-opus-5"), true);
  assert.equal(modelIdsMatch("claude-opus-5@default", "claude-opus-5"), true);
  assert.equal(modelIdsMatch("claude-opus-5-fast", "claude-opus-5"), false);
  for (const suffix of ["agent", "latest", "thinking", "think"]) {
    assert.equal(modelIdsMatch("foo", `foo-${suffix}`), false);
    assert.equal(modelIdsMatch(`foo-${suffix}`, "foo"), false);
  }
  assert.equal(modelIdsMatch("gateway-a/foo", "gateway-b/foo"), false);
  assert.equal(modelIdsMatch("foo@us-east", "foo@eu-west"), false);
  assert.equal(modelIdsMatch("proxy/openai/gpt-4o", "openai/gpt-4o"), true);
  assert.equal(modelIdsMatch("openai/gpt-4o", "proxy/gpt-4o"), false);
});
test("catalog metadata IDs match only exact case-insensitive last segments", () => {
  for (const [catalogId, request] of [
    ["claude-opus-4.6", "proxy/claude-opus-4.6"],
    ["openai/gpt-4o", "hub/gpt-4o"],
    ["google/gemini-2.5-flash", "openai/gemini-2.5-flash"],
    ["proxy/nested/claude-opus-4.6", "other/CLAUDE-OPUS-4.6"],
    ["gateway-a/foo", "gateway-b/foo"],
  ]) {
    assert.equal(catalogModelIdsMatch(catalogId, request), true, `${catalogId} / ${request}`);
    assert.equal(catalogModelIdsMatch(request, catalogId), true, `${request} / ${catalogId}`);
  }

  for (const [catalogId, request] of [
    ["claude-opus-4.6", "proxy/claude-opus-4.6-thinking"],
    ["claude-opus-4.6", "claude-opus-4.6:thinking"],
    ["claude-opus-4.6", "proxy/claude-opus-4.6-agent"],
    ["claude-opus-4.6", "proxy/claude-opus-4.6-latest"],
    ["anthropic-claude-opus-4.6", "claude-opus-4.6"],
    ["google/gemini-pro-latest", "ag/gemini-pro-agent"],
    ["foo", "foo-think"],
    ["foo", "foo-agent"],
    ["foo", "foo-latest"],
    ["foo@us-east", "foo"],
  ]) {
    assert.equal(catalogModelIdsMatch(catalogId, request), false, `${catalogId} / ${request}`);
    assert.equal(catalogModelIdsMatch(request, catalogId), false, `${request} / ${catalogId}`);
  }
});

test("catalog lookup is endpoint-scoped and exact, never a last segment", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { models: {
      "nested/unique-model": { id: "nested/unique-model", reasoning: true },
      "route-a/shared-leaf": { id: "route-a/shared-leaf", reasoning: true },
      "route-b/shared-leaf": { id: "route-b/shared-leaf", reasoning: false },
      "regional@us-east": { id: "regional@us-east" },
    } },
  });
  const input = { vendorKey: "gateway" };
  assert.equal(catalog.findModel({ ...input, modelId: "nested/unique-model" })?.modelId, "nested/unique-model");
  // An unambiguous casefold is still the exact id, not a basename rewrite.
  assert.equal(
    catalog.findModel({ ...input, modelId: "NESTED/UNIQUE-MODEL" })?.modelId,
    "nested/unique-model",
  );
  // A route prefix does not strip to the published id.
  assert.equal(catalog.findModel({ ...input, modelId: "proxy/UNIQUE-MODEL" }), undefined);
  assert.equal(catalog.resolveModelReference({ ...input, modelId: "proxy/UNIQUE-MODEL" }).state, "unmatched");
  // A shared basename cannot select one of the row's own records.
  assert.equal(catalog.findModel({ ...input, modelId: "proxy/shared-leaf" }), undefined);
  assert.equal(catalog.findModel({ ...input, modelId: "route-a/shared-leaf" })?.modelId, "route-a/shared-leaf");
  assert.equal(catalog.findModel({ ...input, modelId: "regional" }), undefined);
  assert.equal(catalog.findModel({ ...input, modelId: "regional@us-east" })?.modelId, "regional@us-east");
});

test("references are never disambiguated by official status or capability consensus", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    relay: { models: { "route/shared-leaf": {
      id: "route/shared-leaf", reasoning: false, tool_call: false, limit: { context: 32_000 },
    } } },
    openai: { models: { "shared-leaf": {
      id: "shared-leaf", reasoning: true, tool_call: true, limit: { context: 128_000 },
    } } },
  });
  const input = { vendorKey: "custom", modelId: "proxy/shared-leaf" };
  assert.equal(catalog.findModel(input), undefined);
  assert.equal(catalog.resolveModelReference(input).state, "unmatched");

  // The same exact id under two publishers is ambiguous, never merged or voted.
  const duplicate = await loadFixtureCatalog(t, {
    publisherA: { models: { "shared-leaf": {
      id: "shared-leaf", reasoning: true, tool_call: true, modalities: { input: ["text", "image"], output: ["text"] },
    } } },
    publisherB: { models: { "shared-leaf": {
      id: "shared-leaf", reasoning: true, tool_call: true, modalities: { input: ["image", "text"], output: ["text"] },
    } } },
  });
  const result = duplicate.resolveModelReference({ modelId: "shared-leaf" });
  assert.equal(result.state, "ambiguous");
  assert.deepEqual(result.candidates?.map((candidate) => candidate.providerKey), ["publisherA", "publisherB"]);
  assert.equal(result.value, undefined);
});

test("ambiguous leaf matches with conflicting capabilities remain unmatched", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    relayA: { models: { "route-a/shared-leaf": {
      id: "route-a/shared-leaf", reasoning: true, tool_call: true,
    } } },
    relayB: { models: { "route-b/shared-leaf": {
      id: "route-b/shared-leaf", reasoning: false, tool_call: true,
    } } },
  });
  assert.equal(
    catalog.findModel({ vendorKey: "custom", modelId: "proxy/shared-leaf" }),
    undefined,
  );
});

test("gemini agent routes do not collapse to gemini latest catalog entries", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    google: { models: {
      "gemini-pro-latest": { id: "gemini-pro-latest", reasoning: true },
    } },
  });
  assert.equal(
    catalog.findModel({ vendorKey: "custom", modelId: "ag/gemini-pro-agent" }),
    undefined,
  );
});

test("catalog lookup never collapses reasoning or release suffix variants", async (t) => {
  const catalog = await loadFixtureCatalog(t);
  const exact = catalog.findModel({ vendorKey: "anthropic", modelId: "claude-opus-4.6" });
  assert.equal(exact?.modelId, "claude-opus-4.6");
  assert.equal(exact.reasoning, true);

  for (const modelId of [
    "claude-opus-4.6-thinking",
    "claude-opus-4.6-agent",
    "claude-opus-4.6-latest",
    "claude-opus-4.6:thinking",
    "anthropic-claude-opus-4.6",
  ]) {
    assert.equal(
      catalog.resolveModelReference({ vendorKey: "anthropic", modelId }).state,
      "unmatched",
      modelId,
    );
  }
});

/*
  A gateway is indexed by models.dev under the vendor that owns the weights, so
  an endpoint serving `Vendor/Model` ids often has no record of its own while
  several other publishers state the identical id. Issue #938: those rows used
  to fall back to the generic 128k text-only shape, hiding a correct context
  window and tool support that the catalog does publish.
*/

test("an even split on tool support leaves conflicting leaves unmatched", async (t) => {
  // Conflicting capability signatures (tool_call) mean shared-capabilities enrichment
  // must miss — no majority/consensus borrow for an unanchored / empty-gateway row.
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    publisherA: { models: { "Vendor/Split": { id: "Vendor/Split", tool_call: true, limit: { context: 262_144 } } } },
    publisherB: { models: { "Vendor/Split": { id: "Vendor/Split", tool_call: false, limit: { context: 262_144 } } } },
  });
  assert.equal(catalog.findModel({
    vendorKey: "gateway",
    baseUrl: "https://gateway.example/v1",
    modelId: "Vendor/Split",
  }), undefined);
});

test("a borrowed record never replaces what the row's own catalog provider publishes", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {
      "Vendor/Shared-Model": { id: "Vendor/Shared-Model", tool_call: false, limit: { context: 200_000 } },
    } },
    publisherA: { models: {
      "Vendor/Shared-Model": { id: "Vendor/Shared-Model", tool_call: true, limit: { context: 1_048_576 } },
    } },
  });
  const match = catalog.findModel({
    vendorKey: "gateway",
    baseUrl: "https://gateway.example/v1",
    modelId: "Vendor/Shared-Model",
  });
  assert.equal(match?.providerKey, "gateway");
  assert.equal(match.limit.context, 200_000);
  assert.equal(match.toolCall, false);
});

test("publishers that disagree about capabilities remain unmatched", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    publisherA: { models: { "Vendor/Disputed": {
      id: "Vendor/Disputed", tool_call: true, reasoning: true, limit: { context: 262_144 },
    } } },
    publisherB: { models: { "Vendor/Disputed": {
      id: "Vendor/Disputed", tool_call: false, reasoning: false, limit: { context: 262_144 },
    } } },
  });
  assert.equal(catalog.findModel({
    vendorKey: "gateway",
    baseUrl: "https://gateway.example/v1",
    modelId: "Vendor/Disputed",
  }), undefined);
});

test("a majority of publishers with conflicting capability signatures stays unmatched", async (t) => {
  // #1047 does not majority-vote across publishers for an empty/unanchored row.
  // Conflicting tool_call signatures ⇒ unmatched.
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    publisherA: { models: { "Vendor/Majority": { id: "Vendor/Majority", tool_call: true, limit: { context: 262_144 } } } },
    publisherB: { models: { "Vendor/Majority": { id: "Vendor/Majority", tool_call: true, limit: { context: 1_048_576 } } } },
    publisherC: { models: { "Vendor/Majority": { id: "Vendor/Majority", tool_call: true, limit: { context: 1_048_576 } } } },
    publisherD: { models: { "Vendor/Majority": { id: "Vendor/Majority", tool_call: false, limit: { context: 1_048_576 } } } },
  });
  assert.equal(catalog.findModel({
    vendorKey: "gateway",
    baseUrl: "https://gateway.example/v1",
    modelId: "Vendor/Majority",
  }), undefined);
});

test("conflicting reseller and shipped records for a leaf stay unmatched without an official", async (t) => {
  // deepseek is not an official/source family for #1047 disambiguation, and the
  // capability signatures conflict, so an unanchored relay must miss.
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    deepseek: { models: { "shared-model": {
      id: "shared-model", tool_call: true, limit: { context: 1_000_000, output: 393_216 },
    } } },
    resellerA: { models: { "shared-model": {
      id: "shared-model", tool_call: false, limit: { context: 128_000, output: 8_192 },
    } } },
    resellerB: { models: { "shared-model": {
      id: "shared-model", tool_call: false, limit: { context: 131_072, output: 8_192 },
    } } },
  });
  assert.equal(catalog.findModel({
    vendorKey: "custom",
    baseUrl: "https://relay.example/v1",
    modelId: "shared-model",
  }), undefined);
});

test("reseller records are not preferred, merged or suffix-stripped for unknown rows", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    resellerA: { models: { "reseller-only-model": {
      id: "reseller-only-model", tool_call: true, limit: { context: 262_144 },
    } } },
    resellerB: { models: { "reseller-only-model": {
      id: "reseller-only-model", tool_call: true, limit: { context: 262_144 },
    } } },
  });
  const input = { vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "reseller-only-model" };
  assert.equal(catalog.findModel(input), undefined, "no publisher owns the relay");
  assert.deepEqual(
    catalog.resolveModelReference(input).candidates?.map((candidate) => candidate.providerKey),
    ["resellerA", "resellerB"],
  );
  // A route prefix or deployment marker is part of the id and never strips.
  for (const modelId of ["test/reseller-only-model", "reseller-only-model-test", "reseller-only-model-latest"]) {
    assert.equal(catalog.resolveModelReference({ ...input, modelId }).state, "unmatched", modelId);
  }
});

test("a reseller row reads only its own publisher's records", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    reseller: { api: "https://reseller.example/v1", models: { "reseller/own": { id: "reseller/own" } } },
    xai: { models: { "Vendor/Model": {
      id: "Vendor/Model", tool_call: true, limit: { context: 500_000, output: 500_000 },
    } } },
  });
  const input = { vendorKey: "reseller", baseUrl: "https://reseller.example/v1", modelId: "Vendor/Model" };
  assert.equal(catalog.findModel(input), undefined);
  assert.equal(catalog.resolveModelReference(input).publisher.state, "matched");
  const reference = catalog.resolveModelReference({ modelId: "Vendor/Model" });
  assert.equal(reference.domain, "canonical");
  assert.equal(reference.source?.providerKey, "xai");
  assert.equal(reference.value?.limit.context, 500_000);
});

test("an exact wire id on an unidentified relay is a canonical reference only", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    xiaomi: { models: { "mimo-v2.5": {
      id: "mimo-v2.5", tool_call: true,
      modalities: { input: ["text", "image", "audio"], output: ["text"] },
      limit: { context: 1_048_576, output: 131_072 },
    } } },
    huggingface: { models: { "XiaomiMiMo/MiMo-V2.5": {
      id: "XiaomiMiMo/MiMo-V2.5", tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 1_048_576, output: 131_072 },
    } } },
  });
  const input = { vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "mimo-v2.5" };
  assert.equal(catalog.findModel(input), undefined, "canonical references never become endpoint capacity");
  const reference = catalog.resolveModelReference(input);
  assert.equal(reference.state, "matched");
  assert.equal(reference.domain, "canonical");
  assert.equal(reference.method, "global-exact-id");
  assert.equal(reference.publisher.state, "unmatched");
  assert.equal(reference.source?.providerKey, "xiaomi");
  assert.deepEqual(reference.value?.modalities.input, ["text", "image", "audio"]);
  const folded = catalog.resolveModelReference({ modelId: "MIMO-V2.5" });
  assert.equal(folded.method, "global-exact-id-casefold");
});

test("the same exact id published by two owners stays ambiguous", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    xiaomi: { models: { "mimo-v2.5": {
      id: "mimo-v2.5", tool_call: true, limit: { context: 1_048_576, output: 131_072 },
    } } },
    reseller: { models: { "mimo-v2.5": {
      id: "mimo-v2.5", tool_call: true, limit: { context: 262_144, output: 16_384 },
    } } },
  });
  const input = { vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "mimo-v2.5" };
  assert.equal(catalog.findModel(input), undefined);
  const reference = catalog.resolveModelReference(input);
  assert.equal(reference.state, "ambiguous");
  assert.deepEqual(reference.candidates?.map((candidate) => candidate.providerKey), ["xiaomi", "reseller"]);
});

test("an unanchored relay stays generic when owner aliases disagree on capacity", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    minimax: { models: { "MiniMax-M2.7": {
      id: "MiniMax-M2.7", tool_call: true,
      limit: { context: 204_800, output: 131_072 },
    } } },
    "minimax-cn": { models: { "MiniMax-M2.7": {
      id: "MiniMax-M2.7", tool_call: true,
      limit: { context: 128_000, output: 65_536 },
    } } },
  });

  assert.equal(catalog.findModel({
    vendorKey: "custom",
    baseUrl: "https://relay.example/v1",
    modelId: "MiniMax-M2.7",
  }), undefined, "conflicting owner limits must not be chosen by catalog order");
});

test("exact ids resolve globally only as canonical references", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    publisherA: { models: {
      "Vendor/Known": { id: "Vendor/Known", limit: { context: 262_144 } },
      "Vendor/Known-2507": { id: "Vendor/Known-2507", limit: { context: 131_072 } },
    } },
  });
  const input = { vendorKey: "gateway", baseUrl: "https://gateway.example/v1" };
  // A different route with the same basename is not the published id.
  assert.equal(catalog.findModel({ ...input, modelId: "Other/Known" }), undefined);
  assert.equal(catalog.resolveModelReference({ ...input, modelId: "Other/Known" }).state, "unmatched");
  assert.equal(catalog.findModel({ ...input, modelId: "Vendor/Known-3000" }), undefined);

  for (const modelId of ["Vendor/Known", "vendor/known"]) {
    assert.equal(catalog.findModel({ ...input, modelId }), undefined, "scoped miss");
    const reference = catalog.resolveModelReference({ modelId });
    assert.equal(reference.state, "matched");
    assert.equal(reference.domain, "canonical");
    assert.equal(reference.source?.providerKey, "publisherA");
    assert.equal(reference.value?.limit.context, 262_144);
  }
  const dated = catalog.resolveModelReference({ modelId: "Vendor/Known-2507" });
  assert.equal(dated.value?.modelId, "Vendor/Known-2507", "the sibling is never borrowed");
});

test("endpoint ownership answers its own negative; canonical references stay separate", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alpha: { api: "https://gateway.example/v1", models: { "alpha-only": { id: "alpha-only" } } },
    beta: { api: "https://gateway.example/v1", models: { "beta-only": { id: "beta-only" } } },
  });
  const input = { vendorKey: "beta", baseUrl: "https://gateway.example/v1" };
  assert.equal(catalog.findModel({ ...input, modelId: "alpha-only" }), undefined);
  assert.equal(catalog.resolveModelReference({ ...input, modelId: "alpha-only" }).publisher.state, "matched");

  const other = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: { "gateway/own": { id: "gateway/own" } } },
    publisherA: { models: { "Vendor/Elsewhere": { id: "Vendor/Elsewhere", limit: { context: 262_144 } } } },
  });
  const row = { vendorKey: "gateway", baseUrl: "https://gateway.example/v1", modelId: "Vendor/Elsewhere" };
  assert.equal(other.findModel(row), undefined, "a scoped miss is not borrowed");
  const reference = other.resolveModelReference(row);
  assert.equal(reference.state, "unmatched");
  assert.equal(reference.publisher.state, "matched");
  // The exact id's canonical owner is reported without claiming the endpoint.
  const canonical = other.resolveModelReference({ modelId: "Vendor/Elsewhere" });
  assert.equal(canonical.state, "matched");
  assert.equal(canonical.domain, "canonical");
  assert.equal(canonical.source?.providerKey, "publisherA");
});

test("models.dev records retain all published model parameters and modalities", () => {
  const [provider] = parseModelsDevCatalog(catalogFixture);
  assert.equal(provider.providerKey, "anthropic");
  assert.equal(provider.models.length, 3, "raw parsing keeps non-text records too");

  const model = provider.models.find((item) => item.modelId === "claude-opus-4.6");
  assert.equal(model.providerApi, undefined);
  assert.equal(model.displayName, "Claude 4.6 Opus");
  assert.equal(model.description, "High-end Claude for difficult coding, planning, and slower expert reasoning");
  assert.equal(model.family, "claude-opus");
  assert.equal(model.attachment, true);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.reasoningOptions, [{
    type: "effort",
    values: ["low", "medium", "high", "xhigh", "max"],
  }]);
  assert.deepEqual(model.modalities, {
    input: ["text", "image", "pdf"],
    output: ["text"],
  });
  assert.deepEqual(model.limit, {
    context: 1_000_000,
    input: 1_000_000,
    output: 128_000,
  });
  assert.deepEqual(model.cost, {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    reasoning: 25,
    inputAudio: 7,
    outputAudio: 28,
    tiers: [{
      input: 10,
      output: 37.5,
      cacheRead: 1,
      tier: { type: "context", size: 200_000 },
    }],
    contextOver200k: {
      input: 10,
      output: 37.5,
      cacheRead: 1,
      cacheWrite: 12.5,
    },
  });
  assert.deepEqual(model.interleaved, { field: "reasoning_content" });
  assert.equal(model.status, "stable");
  assert.equal(model.temperature, false);
  assert.deepEqual(model.experimental, { modes: { fast: { enabled: true } } });
  assert.deepEqual(model.provider, { npm: "@ai-sdk/anthropic" });

  const info = modelInfoFromModelsDev(model, "provider-row");
  assert.equal(info.providerId, "provider-row");
  assert.equal(info.contextWindow, 1_000_000);
  assert.equal(info.maxTokens, 128_000);
  assert.ok(info.capabilities.includes("text"));
  assert.ok(info.capabilities.includes("tools"));
  assert.ok(info.capabilities.includes("vision"));
  assert.ok(info.capabilities.includes("pdf"));
  assert.ok(info.capabilities.includes("reasoning"));
  assert.ok(info.capabilities.includes("json"));
  assert.ok(info.capabilities.includes("attachments"));
  assert.equal(info.capabilities.includes("temperature"), false);
  assert.equal(info.catalogSource, "models.dev");
  assert.deepEqual(info.thinkingLevelMap, {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
    // Effort ladder without a published none/off value (#603).
    off: null,
  });
  assert.deepEqual(info.provider, { npm: "@ai-sdk/anthropic" });
  assert.deepEqual(info.experimental, { modes: { fast: { enabled: true } } });
  assert.ok(
    modelInfoFromModelsDev({ ...model, temperature: true }, "provider-row").capabilities.includes(
      "temperature",
    ),
  );
  const allModalities = {
    input: ["text", "image", "audio", "video", "pdf"],
    output: ["text", "image", "audio", "video", "pdf"],
  };
  const multimodalInfo = modelInfoFromModelsDev(
    { ...model, modalities: allModalities },
    "provider-row",
  );
  assert.deepEqual(multimodalInfo.modalities, allModalities);
  for (const capability of ["vision", "audio", "video", "pdf"]) {
    assert.ok(multimodalInfo.capabilities.includes(capability), capability);
  }

  const config = modelConfigFromModelsDev(model, "https://api.anthropic.com");
  assert.equal(config.source, "models.dev");
  assert.equal(config.name, "Claude 4.6 Opus");
  assert.equal(config.contextWindow, 1_000_000);
  assert.equal(config.maxTokens, 128_000);
  assert.deepEqual(config.input, ["text", "image"]);
  assert.deepEqual(config.modalities, info.modalities);
  assert.deepEqual(config.supportedThinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(config.thinkingProtocol, "adaptive");
  assert.deepEqual(config.thinkingLevelMap, {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
    // Effort ladder without a published none/off value (#603).
    off: null,
  });
  assert.equal(config.cost.reasoning, 25);
  assert.deepEqual(config.provider, { npm: "@ai-sdk/anthropic" });
  assert.deepEqual(config.catalogProvider, { npm: "@ai-sdk/anthropic" });
  assert.deepEqual(config.experimental, { modes: { fast: { enabled: true } } });
  assert.equal(config.cost.inputAudio, 7);
  assert.equal(config.cost.outputAudio, 28);
  assert.equal(config.cost.tiers?.[0]?.tier?.size, 200_000);
  assert.equal(config.interleaved?.field, "reasoning_content");

  const sparse = provider.models.find((item) => item.modelId === "metadata-sparse");
  assert.equal(sparse.reasoningPublished, false);
  assert.equal(sparse.modalitiesPublished, false);
});

test("models.dev parsing keeps the per-model wire API with a responses-only fallback", () => {
  const [provider, llmGateway] = parseModelsDevCatalog({
    "opencode-go": {
      name: "OpenCode Go",
      api: "https://opencode.ai/zen/go/v1",
      models: {
        "muse-spark-1.3-contributor": { id: "muse-spark-1.3-contributor" },
        "deepseek-v4-flash": { id: "deepseek-v4-flash" },
        "custom-responses": { id: "custom-responses", api: "openai-responses" },
      },
    },
    "llmgateway": {
      name: "LLM Gateway",
      models: {
        "muse-spark-1.3-contributor": { id: "muse-spark-1.3-contributor" },
      },
    },
  });
  const byId = Object.fromEntries(provider.models.map((model) => [model.modelId, model]));
  assert.equal(byId["muse-spark-1.3-contributor"].modelApi, "openai-responses");
  assert.equal(byId["deepseek-v4-flash"].modelApi, undefined);
  assert.equal(byId["custom-responses"].modelApi, "openai-responses");
  const gatewayMuse = llmGateway.models.find((model) => model.modelId === "muse-spark-1.3-contributor");
  assert.equal(gatewayMuse.modelApi, undefined);
  const config = modelConfigFromModelsDev(
    byId["muse-spark-1.3-contributor"],
    "https://opencode.ai/zen/go/v1",
  );
  assert.equal(config.api, "openai-responses");
});

test("models.dev parsing retains every model in a provider", () => {
  const models = Object.fromEntries(
    Array.from({ length: 627 }, (_, index) => [
      `model-${String(index).padStart(4, "0")}`,
      { id: `model-${String(index).padStart(4, "0")}` },
    ]),
  );
  const [provider] = parseModelsDevCatalog({
    provider: { name: "Provider", models },
  });
  assert.equal(provider.models.length, 627);
  assert.equal(provider.models.at(-1)?.modelId, "model-0626");
});

test("a vendor prefix outside the configured key never selects a publisher", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-provider-match-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      gateway: {
        name: "Gateway",
        api: "https://gateway.example/v1",
        models: {
          "deepseek/deepseek-v4": {
            id: "deepseek/deepseek-v4",
            name: "DeepSeek V4",
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 128_000, output: 16_000 },
          },
        },
      },
    }),
    "utf8",
  );
  try {
    const catalog = new ModelsDevCatalog({ catalogPath });
    assert.equal(await catalog.ensureLoaded(), true);
    const input = { vendorKey: "deepseek", modelId: "deepseek-v4" };
    assert.equal(catalog.findModel(input), undefined, "a vendor prefix is not publisher identity");
    assert.equal(catalog.resolveModelReference(input).state, "unmatched");
    assert.equal(
      catalog.modelsForProvider({ ...input, providerId: "row" }).length,
      0,
      "an unknown publisher contributes no models",
    );
    // The gateway's own record answers only inside the gateway's exact scope.
    const owned = catalog.findModel({ vendorKey: "gateway", modelId: "deepseek/deepseek-v4" });
    assert.equal(owned?.providerKey, "gateway");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an OAuth account endpoint without a published match keeps canonical references only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-openai-codex-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      openai: {
        name: "OpenAI",
        models: {
          "gpt-5.6-sol": {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 1_050_000, output: 128_000 },
          },
        },
      },
    }),
    "utf8",
  );
  try {
    const catalog = new ModelsDevCatalog({ catalogPath });
    assert.equal(await catalog.ensureLoaded(), true);

    const input = {
      vendorKey: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.6-sol",
    };
    assert.equal(catalog.findModel(input), undefined, "no publisher owns the OAuth backend");
    const reference = catalog.resolveModelReference(input);
    assert.equal(reference.state, "matched");
    assert.equal(reference.domain, "canonical");
    assert.equal(reference.publisher.state, "unmatched");
    assert.equal(reference.source?.providerKey, "openai");
    assert.equal(reference.value?.reasoning, true);
    assert.equal(reference.value?.limit.context, 1_050_000);
    assert.equal(catalog.providerKeyForRow(input), undefined);
    assert.equal(
      catalog.modelsForProvider({ ...input, providerId: "oauth-row" }).length,
      0,
      "an unowned endpoint never manufactures a publisher list",
    );

    // The same id under the explicit catalog key is endpoint-serving metadata.
    const owned = catalog.findModel({ vendorKey: "openai", modelId: "gpt-5.6-sol" });
    assert.equal(owned?.providerKey, "openai");
    assert.equal(owned?.limit.context, 1_050_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("published endpoints identify publishers; a vendor alias does not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-zhipu-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      zhipuai: {
        name: "Zhipu AI",
        api: "https://open.bigmodel.cn/api/paas/v4",
        models: { "glm-5": { id: "glm-5", limit: { context: 204_800, output: 131_072 } } },
      },
      zai: {
        name: "Z.AI",
        api: "https://api.z.ai/api/paas/v4",
        models: { "glm-5.1": { id: "glm-5.1", limit: { context: 200_000, output: 131_072 } } },
      },
      "zai-coding-plan": {
        name: "Z.AI Coding Plan",
        api: "https://api.z.ai/api/coding/paas/v4",
        models: { "glm-5.2": { id: "glm-5.2", limit: { context: 1_000_000, output: 131_072 } } },
      },
    }),
    "utf8",
  );
  try {
    const catalog = new ModelsDevCatalog({ catalogPath });
    assert.equal(await catalog.ensureLoaded(), true);
    const chinaApi = catalog.findModel({
      vendorKey: "custom",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      modelId: "glm-5",
    });
    assert.equal(chinaApi?.providerKey, "zhipuai");
    const intlCoding = catalog.findModel({
      vendorKey: "custom",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      modelId: "glm-5.2",
    });
    assert.equal(intlCoding?.providerKey, "zai-coding-plan");
    assert.equal(
      catalog.providerKeyForRow({ vendorKey: "bigmodel", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }),
      "zhipuai",
      "an exact endpoint identifies the publisher without a key alias",
    );
    // A key that is not a catalog key and has no endpoint evidence names nothing.
    const aliasOnly = { vendorKey: "zai-coding-cn", modelId: "glm-5.3" };
    assert.equal(catalog.findModel(aliasOnly), undefined);
    assert.equal(catalog.resolveModelReference(aliasOnly).state, "unmatched");
    assert.equal(catalog.modelsForProvider({ ...aliasOnly, providerId: "row" }).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("host-only endpoint inheritance is gone; precise endpoints still match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-minimax-openai-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      "minimax-cn": {
        name: "MiniMax (China)",
        api: "https://api.minimaxi.com/anthropic/v1",
        models: {
          "MiniMax-M3": {
            id: "MiniMax-M3",
            name: "MiniMax-M3",
            attachment: true,
            modalities: { input: ["text", "image", "video"], output: ["text"] },
            limit: { context: 1_048_576, output: 524_288 },
          },
        },
      },
    }),
    "utf8",
  );
  try {
    const catalog = new ModelsDevCatalog({ catalogPath });
    assert.equal(await catalog.ensureLoaded(), true);
    const unowned = {
      vendorKey: "custom",
      baseUrl: "https://api.minimaxi.com/v1",
      providerId: "custom-row",
      modelId: "MiniMax-M3",
    };
    assert.equal(catalog.findModel(unowned), undefined, "a shared host does not own the row");
    const reference = catalog.resolveModelReference(unowned);
    assert.equal(reference.state, "matched");
    assert.equal(reference.domain, "canonical");
    assert.equal(catalog.modelsForProvider(unowned).length, 0);

    const exact = { ...unowned, baseUrl: "https://api.minimaxi.com/anthropic/v1" };
    const match = catalog.findModel(exact);
    assert.equal(match?.providerKey, "minimax-cn");
    assert.deepEqual(match?.modalities.input, ["text", "image", "video"]);
    assert.equal(match?.attachment, true);
    assert.equal(catalog.modelsForProvider(exact)[0]?.modelId, "MiniMax-M3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("models.dev reasoning options map to canonical levels", () => {
  assert.deepEqual(
    thinkingLevelsFromModelsDev(true, [{
      type: "effort",
      values: ["max", "low", "none", "invalid"],
    }]),
    ["off", "low", "max"],
  );
  assert.deepEqual(thinkingLevelsFromModelsDev(true, [{ type: "toggle" }]), ["off", "medium"]);
  assert.deepEqual(thinkingLevelsFromModelsDev(true, [{ type: "budget_tokens", min: 1024 }]), ["off", "medium"]);
  assert.deepEqual(thinkingLevelsFromModelsDev(true, []), ["low", "medium", "high"]);
  assert.deepEqual(thinkingLevelsFromModelsDev(false, [{ type: "effort", values: ["high"] }]), []);
});

test("toggle ladders still map off to none", () => {
  const [provider] = parseModelsDevCatalog({
    vendor: {
      name: "Vendor",
      models: {
        "toggle-model": {
          id: "toggle-model",
          reasoning: true,
          reasoning_options: [{ type: "toggle" }],
        },
      },
    },
  });
  const info = modelInfoFromModelsDev(provider.models[0], "row");
  assert.equal(info.thinkingLevelMap?.off, "none");
});

test("the application loads the bundled release snapshot without network access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-release-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(catalogFixture), "utf8");
  let calls = 0;
  try {
    const catalog = new ModelsDevCatalog({
      catalogPath,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("startup must not fetch");
      },
    });
    assert.equal(
      catalog.findModel({ vendorKey: "anthropic", modelId: "claude-opus-4.6" }),
      undefined,
      "a lookup before the bundled snapshot loads can miss",
    );
    assert.equal(await catalog.ensureLoaded(), true);
    assert.equal(calls, 0);
    assert.equal(catalog.getStatus().source, "bundled");
    assert.equal(catalog.getStatus().catalogPath, catalogPath);
    assert.equal(
      catalog.findModel({ vendorKey: "anthropic", modelId: "claude-opus-4.6" })?.family,
      "claude-opus",
    );
    assert.equal(
      catalog.modelsForProvider({ vendorKey: "anthropic", providerId: "row" }).length,
      2,
      "only text-capable models enter the agent picker",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the bundled snapshot resolves the published 0.87.1 ids", async () => {
  const catalog = new ModelsDevCatalog({
    catalogPath: fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url)),
  });
  assert.equal(await catalog.ensureLoaded(), true);

  const cases = [
    {
      vendorKey: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-opus-5-5",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      vendorKey: "xai",
      baseUrl: "https://api.x.ai/v1",
      modelId: "grok-4.7",
      contextWindow: 500_000,
      maxTokens: 500_000,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
    },
  ];

  for (const expected of cases) {
    const model = catalog.findModel(expected);
    assert.ok(model, `${expected.vendorKey}/${expected.modelId} must be in the snapshot`);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.thinkingLevels, expected.thinkingLevels);
    assert.deepEqual(model.modalities.input, ["text", "image", "pdf"]);
    const config = modelConfigFromModelsDev(model, expected.baseUrl);
    assert.equal(config.contextWindow, expected.contextWindow);
    assert.equal(config.maxTokens, expected.maxTokens);
    assert.deepEqual(config.input, ["text", "image"]);
  }

  const copilotClaude = catalog.findModel({
    vendorKey: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    modelId: "claude-opus-5.5",
  });
  assert.ok(copilotClaude, "GitHub Copilot must include Claude Opus 5.5");
  assert.equal(copilotClaude.reasoning, true);
  assert.equal(copilotClaude.limit.context, 1_000_000);

  // The ChatGPT account backend is not a published endpoint and its key is not a
  // catalog key; the same wire id lives under several publishers, so the only
  // honest answer is canonical ambiguity, never endpoint metadata.
  const codexInput = {
    vendorKey: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
  };
  for (const modelId of ["gpt-6-sol", "gpt-6-luna"]) {
    const input = { ...codexInput, modelId };
    assert.equal(catalog.findModel(input), undefined, `${modelId} is unowned`);
    const reference = catalog.resolveModelReference(input);
    assert.equal(reference.state, "ambiguous", `${modelId} has several published owners`);
    assert.ok(reference.candidates?.length > 1);
  }
});

test("concurrent catalog reads share the bundled snapshot load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-concurrent-load-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(catalogFixture), "utf8");
  try {
    const catalog = new ModelsDevCatalog({ catalogPath });
    const first = catalog.ensureLoaded();
    const second = catalog.ensureLoaded();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(
      catalog.findModel({ vendorKey: "anthropic", modelId: "claude-opus-4.6" })?.family,
      "claude-opus",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Settings refresh always refetches models.dev and only updates memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-refresh-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(catalogFixture), "utf8");
  const refreshedFixture = {
    ...catalogFixture,
    anthropic: {
      ...catalogFixture.anthropic,
      models: {
        ...catalogFixture.anthropic.models,
        "claude-opus-4.6": {
          ...catalogFixture.anthropic.models["claude-opus-4.6"],
          name: "Updated Claude",
        },
        "new-model": {
          id: "new-model",
          name: "New Model",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 64_000, output: 4_000 },
        },
      },
    },
  };
  const calls = [];
  try {
    const catalog = new ModelsDevCatalog({
      catalogPath,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return responseFor(refreshedFixture);
      },
    });
    assert.equal(await catalog.ensureLoaded(), true);
    const existingInput = { vendorKey: "anthropic", modelId: "claude-opus-4.6" };
    const previousMatch = catalog.findModel(existingInput);
    assert.ok(previousMatch);
    assert.equal(catalog.findModel({ vendorKey: "anthropic", modelId: "new-model" }), undefined);
    assert.equal(calls.length, 0);
    assert.equal(await catalog.refresh(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, MODELS_DEV_API_URL);
    assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
    const refreshedMatch = catalog.findModel(existingInput);
    assert.notEqual(refreshedMatch, previousMatch);
    assert.equal(refreshedMatch?.displayName, "Updated Claude");
    assert.equal(
      catalog.findModel({ vendorKey: "anthropic", modelId: "new-model" })?.displayName,
      "New Model",
    );
    assert.deepEqual(
      JSON.parse(await readFile(catalogPath, "utf8")),
      catalogFixture,
      "settings refresh must not write the bundled release resource",
    );
    assert.equal(await catalog.refresh(), true, "a second settings refresh is also remote");
    assert.equal(calls.length, 2);
    assert.equal(catalog.getStatus().source, "remote");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed settings refresh preserves the loaded snapshot in memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-failure-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(catalogFixture), "utf8");
  try {
    const catalog = new ModelsDevCatalog({
      catalogPath,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(await catalog.ensureLoaded(), true);
    const input = { vendorKey: "anthropic", modelId: "claude-opus-4.6" };
    const match = catalog.findModel(input);
    assert.ok(match);
    const reads = observeModelIdReads(match);
    const missing = { ...input, modelId: "unpublished-model" };
    assert.equal(catalog.findModel(missing), undefined);
    const beforeRefresh = reads();
    assert.equal(await catalog.refresh(), false);
    assert.equal(catalog.findModel(input), match);
    assert.equal(catalog.findModel(missing), undefined);
    // Lookups are index-based: each one touches a constant number of published
    // ids and never rescans the catalog, so a failure keeps the same answers.
    assert.ok(reads() - beforeRefresh <= 4, "a failed refresh preserves bounded lookups");
    assert.equal(
      catalog.findModel({ vendorKey: "anthropic", modelId: "claude-opus-4.6" })?.family,
      "claude-opus",
    );
    assert.match(catalog.getStatus().lastError, /offline/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/*
  The published `npm` / `env` / `doc` fields survive parsing because the setup
  form still derives the wire API from the adapter package and still points the
  user at the provider's own docs. Migrated here when the catalog-search suite
  was removed with the browsable-catalog UI.
*/
test("parsed providers keep the published npm, env and doc fields", () => {
  const providers = parseModelsDevCatalog({
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      api: "https://api.anthropic.com",
      doc: "https://docs.anthropic.com",
      env: ["ANTHROPIC_API_KEY"],
      models: {
        "claude-opus-4.6": {
          id: "claude-opus-4.6",
          name: "Claude 4.6 Opus",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 200000, output: 64000 },
        },
      },
    },
    "openrouter-lite": {
      id: "openrouter-lite",
      name: "OpenRouter Lite",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "some-model": {
          id: "some-model",
          name: "Some Model",
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
  });
  const anthropic = providers.find((item) => item.providerKey === "anthropic");
  assert.equal(anthropic.npm, "@ai-sdk/anthropic");
  assert.equal(anthropic.doc, "https://docs.anthropic.com");
  assert.deepEqual(anthropic.env, ["ANTHROPIC_API_KEY"]);
  assert.equal(anthropic.api, "https://api.anthropic.com");
  const gateway = providers.find((item) => item.providerKey === "openrouter-lite");
  assert.deepEqual(gateway.env, [], "a provider without env vars parses to an empty list");
  assert.equal(gateway.doc, undefined);
});

test("the wire API style is derived from the published adapter package", () => {
  assert.equal(apiStyleForAdapter("@ai-sdk/anthropic"), "anthropic_messages");
  assert.equal(apiStyleForAdapter("@ai-sdk/google-vertex/anthropic"), "anthropic_messages");
  assert.equal(apiStyleForAdapter("@ai-sdk/google"), "google_generative_ai");
  assert.equal(apiStyleForAdapter("@ai-sdk/openai"), "responses");
  // The long tail of gateways is OpenAI-compatible chat completions.
  assert.equal(apiStyleForAdapter("@ai-sdk/openai-compatible"), "chat_completions");
  assert.equal(apiStyleForAdapter(undefined), "chat_completions");
});

// A custom Anthropic Messages gateway (unknown base URL, vendorKey "custom")
// serving a Claude id that several catalog providers publish with differing
// reasoning options. The lookup refuses to pick one publisher, but the thinking
// wire shape of an exact Anthropic id is Anthropic's own (#990).
const ambiguousClaudeFixture = {
  anthropic: {
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-opus-5-5": {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_000_000, output: 128_000 },
      },
    },
  },
  requesty: {
    name: "Requesty",
    npm: "@ai-sdk/openai-compatible",
    api: "https://router.requesty.ai/v1",
    models: {
      "claude-opus-5-5": {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["none", "low", "medium", "high", "max"] },
          { type: "budget_tokens" },
        ],
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 200_000, output: 64_000 },
      },
      "glm-5": {
        id: "glm-5",
        name: "GLM 5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 200_000, output: 32_000 },
      },
    },
  },
};

const customGateway = {
  vendorKey: "custom",
  baseUrl: "https://gateway.example/v1",
};

test("a custom Anthropic Messages gateway receives only Anthropic's exact thinking shape", async (t) => {
  const catalog = await loadFixtureCatalog(t, ambiguousClaudeFixture);
  const config = catalogModelConfigFor(catalog, {
    ...customGateway,
    apiStyle: "anthropic_messages",
    modelId: "claude-opus-5-5",
  });
  // The endpoint is unowned, so no publisher's limits, price or modalities apply.
  assert.equal(config.source, "generic");
  assert.equal(config.contextWindow, 128_000, "the generic default, not a publisher's 1M window");
  // Anthropic's own exact record states the wire thinking shape; that is a model
  // property, not deployment metadata, so it transfers to the Messages row.
  assert.deepEqual(config.reasoningOptions, [
    { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
  ]);
  assert.deepEqual(config.thinkingLevelMap, {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
    off: null,
  });
});

test("ambiguous Claude metadata is never borrowed across API styles", async (t) => {
  const catalog = await loadFixtureCatalog(t, ambiguousClaudeFixture);
  const completions = catalogModelConfigFor(catalog, {
    ...customGateway,
    apiStyle: "chat_completions",
    modelId: "claude-opus-5-5",
  });
  assert.equal(completions.source, "generic");
  assert.equal(completions.reasoningOptions, undefined);
  assert.equal(completions.thinkingLevelMap, undefined);

  // An id absent from every publisher stays generic, even on Anthropic Messages.
  const unlisted = catalogModelConfigFor(catalog, {
    ...customGateway,
    apiStyle: "anthropic_messages",
    modelId: "unlisted-reasoning-model",
  });
  assert.equal(unlisted.source, "generic");
  assert.equal(unlisted.reasoningOptions, undefined);
  assert.equal(unlisted.thinkingLevelMap, undefined);

  // Aliases of a Claude id are not an exact Anthropic id.
  const renamed = catalogModelConfigFor(catalog, {
    ...customGateway,
    apiStyle: "anthropic_messages",
    modelId: "my-claude-opus-5-5-thinking",
  });
  assert.equal(renamed.reasoningOptions, undefined);
});

test("a resolved catalog record still wins over the Anthropic thinking fallback", async (t) => {
  const catalog = await loadFixtureCatalog(t, ambiguousClaudeFixture);
  const config = catalogModelConfigFor(catalog, {
    vendorKey: "requesty",
    baseUrl: "https://router.requesty.ai/v1",
    apiStyle: "anthropic_messages",
    modelId: "claude-opus-5-5",
  });
  assert.equal(config.source, "models.dev");
  assert.equal(config.contextWindow, 200_000);
  assert.ok(config.reasoningOptions?.some((option) => option.type === "budget_tokens"));
});

/*
  Release stamps in the published catalog.

  A gateway serves `mify/mimo-v2.5-pro-0731` while models.dev indexes the model
  under the id that owns the weights. The alias only ever borrows metadata: the
  id the row is addressed with stays the discovery result.
*/
test("a dated snapshot leaf does not borrow an undated published model", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    mify: {
      api: "https://api.mify.example/v1",
      models: {
        "mimo-v2.5-pro": {
          id: "mimo-v2.5-pro",
          name: "MiMo v2.5 Pro",
          reasoning: true,
          tool_call: true,
          limit: { context: 262_144, output: 32_768 },
        },
      },
    },
  });
  assert.equal(
    catalog.findModel({ vendorKey: "mify", modelId: "mify/mimo-v2.5-pro-0731" }),
    undefined,
  );
});

test("release-stamped ids resolve exactly and never collapse into a shorter sibling", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alpha: { api: "https://alpha.example/v1", models: {
      "foo-v2": { id: "foo-v2", limit: { context: 32_000 } },
      "foo-v2-0731": { id: "foo-v2-0731", limit: { context: 128_000 } },
    } },
    beta: { api: "https://beta.example/v1", models: {
      "foo-v2": { id: "foo-v2", limit: { context: 64_000 } },
    } },
  });
  const exact = catalog.findModel({ vendorKey: "alpha", modelId: "foo-v2-0731" });
  assert.equal(exact?.modelId, "foo-v2-0731");
  assert.equal(exact?.limit.context, 128_000);
  // An unpublished stamp does not strip down to a shorter sibling.
  assert.equal(catalog.findModel({ vendorKey: "alpha", modelId: "foo-v2-0815" }), undefined);
  // An unowned row sees the exact id under two owners: ambiguous, never merged.
  const shared = catalog.resolveModelReference({ modelId: "foo-v2" });
  assert.equal(shared.state, "ambiguous");
  assert.deepEqual(shared.candidates?.map((candidate) => candidate.providerKey), ["alpha", "beta"]);
  // A uniquely published dated id is a canonical reference, not endpoint capacity.
  const published = catalog.resolveModelReference({ modelId: "foo-v2-0731" });
  assert.equal(published.state, "matched");
  assert.equal(published.domain, "canonical");
  assert.equal(published.source?.providerKey, "alpha");
  assert.equal(published.value?.limit.context, 128_000);
});

/*
  A custom endpoint is often the same publisher on another path.

  The reported failure: a custom row at `https://open.bigmodel.cn/api/v1` listed
  its models but every one of them showed generic defaults, because provider
  matching only accepted models.dev's own path for that host.
*/
test("an endpoint on another path keeps only a canonical reference", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alpha: {
      api: "https://alpha.example/api/paas/v4",
      models: { "glm-5.3": {
        id: "glm-5.3", reasoning: true, tool_call: true,
        limit: { context: 1_000_000, output: 131_072 },
      } },
    },
  });
  const row = { vendorKey: "custom", baseUrl: "https://alpha.example/api/v1", providerId: "row" };
  assert.equal(catalog.findModel({ ...row, modelId: "glm-5.3" }), undefined, "a host alone owns nothing");
  const reference = catalog.resolveModelReference({ ...row, modelId: "glm-5.3" });
  assert.equal(reference.state, "matched");
  assert.equal(reference.domain, "canonical");
  assert.equal(reference.source?.providerKey, "alpha");
  assert.equal(reference.value?.limit.context, 1_000_000);
  assert.equal(catalog.modelsForProvider(row).length, 0, "an unknown endpoint lists no publisher models");
  // The published endpoint path is exact and does own the row.
  const exact = { ...row, baseUrl: "https://alpha.example/api/paas/v4", modelId: "glm-5.3" };
  const match = catalog.findModel(exact);
  assert.equal(match?.providerKey, "alpha");
  assert.equal(match?.limit.context, 1_000_000);
  assert.equal(catalog.modelsForProvider({ ...row, baseUrl: "https://alpha.example/api/paas/v4" }).length, 1);
});

test("a host two publishers share leaves conflicting leaves unmatched", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alpha: {
      api: "https://shared.example/api/paas/v4",
      models: { "glm-5.3": { id: "glm-5.3", reasoning: true, limit: { context: 1_000_000 } } },
    },
    beta: {
      api: "https://shared.example/api/coding/v4",
      models: { "glm-5.3": { id: "glm-5.3", reasoning: false, limit: { context: 32_000 } } },
    },
  });
  assert.equal(catalog.findModel({
    vendorKey: "custom",
    baseUrl: "https://shared.example/v1",
    modelId: "glm-5.3",
  }), undefined);
  // Naming the publisher still resolves it to that publisher's own record.
  const alpha = catalog.findModel({
    vendorKey: "alpha",
    baseUrl: "https://shared.example/v1",
    modelId: "glm-5.3",
  });
  assert.equal(alpha?.providerKey, "alpha");
  assert.equal(alpha?.limit.context, 1_000_000);
});

test("dotted and dashed version spellings are distinct ids", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    anthropic: { models: { "claude-sonnet-4-5": {
      id: "claude-sonnet-4-5", tool_call: true, limit: { context: 200_000, output: 64_000 },
    } } },
  });
  const input = { vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "claude-sonnet-4.5" };
  assert.equal(catalog.findModel(input), undefined, "a notation difference is not the owner's id");
  assert.equal(catalog.resolveModelReference(input).state, "unmatched");
  // The published spelling answers only inside its owning publisher's scope.
  const exact = catalog.findModel({ vendorKey: "anthropic", modelId: "claude-sonnet-4-5" });
  assert.equal(exact?.modelId, "claude-sonnet-4-5");
  assert.equal(exact?.limit.context, 200_000);
});

test("a canonical reference duplicated across live and deprecated records stays ambiguous", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    deepseek: { models: {
      "deepseek-flash": {
        id: "deepseek-flash", tool_call: true,
        canonical_model_id: "deepseek/deepseek-v4.1-flash",
        limit: { context: 1_000_000, output: 393_216 },
      },
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash", tool_call: true, status: "deprecated",
        canonical_model_id: "deepseek/deepseek-v4.1-flash",
        limit: { context: 1_000_000, output: 393_216 },
      },
    } },
  });
  const input = { vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "deepseek-v4.1-flash" };
  assert.equal(catalog.findModel(input), undefined, "a canonical basename is not endpoint capacity");
  const reference = catalog.resolveModelReference(input);
  assert.equal(reference.state, "ambiguous");
  // A live/deprecated status is a record property, never a tie-breaker.
  assert.deepEqual(reference.candidates?.map((candidate) => candidate.modelId), [
    "deepseek-flash", "deepseek-v4-flash",
  ]);
});

test("a generation name the catalog never publishes stays unmatched", async (t) => {
  // `gemini-3-flash` is a distinct (non-preview) model the catalog does not
  // publish; a preview record must not answer for it.
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    google: { models: { "gemini-3-flash-preview": {
      id: "gemini-3-flash-preview", tool_call: true, limit: { context: 1_000_000 },
    } } },
  });
  assert.equal(catalog.findModel({
    vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "gemini-3-flash",
  }), undefined);
});

test("a unique exact wire id on an unidentified relay is canonical only", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    alibaba: { models: { "qwen3.7-flash": { id: "qwen3.7-flash" } } },
    "alibaba-token-plan": { models: { "qwen3.8-flash": {
      id: "qwen3.8-flash", tool_call: true, limit: { context: 1_000_000, output: 131_072 },
    } } },
  });
  const input = { vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "qwen3.8-flash" };
  assert.equal(catalog.findModel(input), undefined, "no vendor family selects a publisher");
  const reference = catalog.resolveModelReference(input);
  assert.equal(reference.state, "matched");
  assert.equal(reference.domain, "canonical");
  assert.equal(reference.method, "global-exact-id");
  assert.equal(reference.source?.providerKey, "alibaba-token-plan");
  assert.equal(catalog.modelsForProvider({ vendorKey: "custom", baseUrl: "https://relay.example/v1", providerId: "row" }).length, 0);
});

test("the configured key selects its publisher without sibling interference", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alibaba: { models: { "qwen3.8-flash": {
      id: "qwen3.8-flash", tool_call: true, limit: { context: 512_000, output: 64_000 },
    } } },
    "alibaba-token-plan": { models: { "qwen3.8-flash": {
      id: "qwen3.8-flash", tool_call: true, limit: { context: 1_000_000, output: 131_072 },
    } } },
  });
  const match = catalog.findModel({ vendorKey: "alibaba", modelId: "qwen3.8-flash" });
  assert.equal(match?.providerKey, "alibaba");
  assert.equal(match?.limit.context, 512_000);
  assert.equal(match?.limit.output, 64_000);
  // An unowned row cannot pick one of the two owners by catalog order.
  assert.equal(catalog.resolveModelReference({ modelId: "qwen3.8-flash" }).state, "ambiguous");
});

test("a declared canonical reference several publishers claim stays ambiguous", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    google: { models: { "gemini-3-flash-preview": { id: "gemini-3-flash-preview" } } },
    neon: { models: { "google/gemini-3-flash": {
      id: "google/gemini-3-flash", canonical_model_id: "google/gemini-3-flash-preview",
    } } },
    pioneer: { models: { "google/gemini-3-flash": {
      id: "google/gemini-3-flash", canonical_model_id: "google/gemini-3-flash-preview",
    } } },
  });
  const declared = catalog.resolveModelReference({
    modelId: "google/gemini-3-flash",
    declaredCanonicalModelId: "google/gemini-3-flash-preview",
  });
  assert.equal(declared.state, "ambiguous");
  assert.deepEqual(declared.candidates?.map((candidate) => candidate.providerKey), ["neon", "pioneer"]);
  assert.equal(catalog.findModel({ modelId: "google/gemini-3-flash" }), undefined);
});

test("a publisher's private canonical declaration never rewrites a served id", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    google: { models: { "gemini-3-flash-preview": { id: "gemini-3-flash-preview" } } },
    "some-reseller": { models: { "google/gemini-3-flash": {
      id: "google/gemini-3-flash", canonical_model_id: "google/gemini-3-flash-preview",
    } } },
  });
  // The bare served name is not the reseller's published record and the catalog
  // publishes no basename for it, so nothing answers.
  assert.equal(catalog.resolveModelReference({ modelId: "gemini-3-flash" }).state, "unmatched");
  const record = catalog.resolveModelReference({ modelId: "google/gemini-3-flash" });
  assert.equal(record.state, "matched");
  assert.equal(record.domain, "canonical");
  assert.equal(record.source?.providerKey, "some-reseller");
  // An explicitly declared canonical id is the source's own evidence, not a guess.
  const declared = catalog.resolveModelReference({
    modelId: "google/gemini-3-flash",
    declaredCanonicalModelId: "google/gemini-3-flash-preview",
  });
  assert.equal(declared.state, "matched");
  assert.equal(declared.method, "declared-canonical-id");
  assert.equal(declared.source?.providerKey, "some-reseller");
});

test("an ambiguous canonical translation stays unmatched", async (t) => {
  // Two corroborated targets say the name maps two ways. The resellers disagree
  // on capability flags, so no shared record answers either; nothing is claimed.
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    google: { models: {
      "gemini-3-flash-preview": {
        id: "gemini-3-flash-preview", tool_call: true, limit: { context: 1_048_576 },
      },
      "gemini-3-flash-lite": {
        id: "gemini-3-flash-lite", tool_call: true, limit: { context: 1_000_000 },
      },
    } },
    neon: { models: { "google/gemini-3-flash": {
      id: "google/gemini-3-flash", tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      canonical_model_id: "google/gemini-3-flash-preview",
      limit: { context: 1_000_000 },
    } } },
    pioneer: { models: { "google/gemini-3-flash": {
      id: "google/gemini-3-flash", tool_call: true,
      canonical_model_id: "google/gemini-3-flash-preview",
      limit: { context: 1_000_000 },
    } } },
    opencode: { models: { "google/gemini-3-flash": {
      id: "google/gemini-3-flash", tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      canonical_model_id: "google/gemini-3-flash-lite",
      limit: { context: 1_000_000 },
    } } },
    vercel: { models: { "google/gemini-3-flash": {
      id: "google/gemini-3-flash", tool_call: true,
      canonical_model_id: "google/gemini-3-flash-lite",
      limit: { context: 1_000_000 },
    } } },
  });
  assert.equal(catalog.findModel({
    vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "gemini-3-flash",
  }), undefined);
});

test("two publishers publishing the relay's exact id stay ambiguous", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    google: { models: { "gemini-3-flash-preview": { id: "gemini-3-flash-preview" } } },
    neon: { models: { "gemini-3-flash": {
      id: "gemini-3-flash", canonical_model_id: "google/gemini-3-flash-preview",
    } } },
    pioneer: { models: { "gemini-3-flash": {
      id: "gemini-3-flash", canonical_model_id: "google/gemini-3-flash-preview",
    } } },
  });
  const input = { vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "gemini-3-flash" };
  assert.equal(catalog.findModel(input), undefined);
  const reference = catalog.resolveModelReference(input);
  assert.equal(reference.state, "ambiguous");
  assert.deepEqual(reference.candidates?.map((candidate) => candidate.providerKey), ["neon", "pioneer"]);
});
