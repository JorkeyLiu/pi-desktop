/**
 * A custom endpoint gets only the metadata the catalog can justify for it.
 *
 * models.dev answers for a configured row only inside the publisher that
 * explicitly owns that endpoint. A relay the snapshot cannot place therefore
 * keeps conservative generic metadata for ids that some other publisher states
 * — a relay id never proves the relay serves that publisher's record — while a
 * row on a published endpoint still reads the owner's record. Capacity the
 * endpoint itself reports outranks metadata for that field, wire ids are never
 * rewritten, and a hand-typed id follows the same ownership boundary.
 *
 * This drives the real handlers with the bundled snapshot, so it pins the whole
 * chain: discovery, endpoint resolution, catalog anchoring, the hand-typed id
 * channel, and Pi's own exact operation models.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");
const { IPC } = await import("@pi-desktop/shared");

const catalogPath = new URL("../resources/models.dev/api.json", import.meta.url).pathname;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Register the real handlers against one row and one served model list. */
async function handlersFor(t, row, body) {
  const catalog = new ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true, "the bundled snapshot must load");

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).endsWith("/models") ? jsonResponse(body) : new Response("", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const handlers = new Map();
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method) => {
        if (method === "providers.list") return { providers: [row] };
        if (method === "providers.getSecret") return { value: "sk-secret" };
        if (method === "providers.get") return { provider: row };
        return {};
      },
    }),
    modelsDevCatalog: catalog,
    vendorOAuth: {},
    logger: { app: () => {} },
    enrichProvider: (provider) => provider,
    listRuntimeProviders: async () => [row],
    enrichProviderList: (result) => result,
    bindingForModel: () => undefined,
  });

  const listModels = handlers.get(IPC.invoke.providersListModels);
  assert.equal(typeof listModels, "function", "list-models handler is not registered");
  const lookupModel = handlers.get(IPC.invoke.providersLookupModel);
  assert.equal(typeof lookupModel, "function", "model-lookup handler is not registered");

  return {
    calls,
    row,
    result: await listModels({ providerId: row.id, source: "refresh" }),
    /** The hand-typed id channel a picker uses when a user types an id in. */
    lookup: (input) => lookupModel(input),
  };
}

function rowOf(overrides) {
  return {
    name: "Row",
    vendorKey: "custom",
    apiStyle: "chat_completions",
    models: [],
    authKind: "api_key_and_base_url",
    headers: {},
    ...overrides,
  };
}

function modelById(models) {
  return new Map(models.map((model) => [model.modelId, model]));
}

/** Conservative seed values the host uses when the catalog stays silent. */
function assertGeneric(model, label) {
  assert.equal(model.catalogSource, undefined, `${label}: an unowned endpoint has no catalog record`);
  assert.equal(model.contextWindow, 128_000, `${label}: generic context window`);
  assert.equal(model.maxTokens, 8_192, `${label}: generic output limit`);
  assert.deepEqual(model.capabilities, ["text"], `${label}: generic capabilities`);
  assert.deepEqual(model.supportedThinkingLevels, [], `${label}: no invented thinking levels`);
}

test("a custom row on a published host gets that publisher's model metadata", async (t) => {
  const row = rowOf({
    id: "row-1",
    name: "Zhipu",
    baseUrl: "https://open.bigmodel.cn/api/v1",
    apiStyle: "responses",
  });
  const { result, calls } = await handlersFor(t, row, {
    models: [{ slug: "glm-5.3", display_name: "glm-5.3" }],
  });

  assert.deepEqual(calls, ["https://open.bigmodel.cn/api/v1/models"]);
  // The address the user typed answered, so it stays the row's address.
  assert.equal(result.effectiveBaseUrl, "https://open.bigmodel.cn/api/v1");

  const [model] = result.models;
  assert.equal(model.modelId, "glm-5.3", "the wire id is the one the service served");
  assert.equal(model.catalogSource, "models.dev", "the host identified the publisher");
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 131_072);
  for (const capability of ["tools", "reasoning"]) {
    assert.ok(model.capabilities.includes(capability), `expected ${capability} capability`);
  }
});

test("an unowned relay list does not borrow a publisher's record for a known id", async (t) => {
  const row = rowOf({
    id: "row-2",
    name: "Relay",
    baseUrl: "https://relay.example/v1",
  });
  const { result, calls } = await handlersFor(t, row, {
    data: [{ id: "claude-sonnet-4-5" }, { id: "some-private-model" }],
  });

  assert.deepEqual(calls, ["https://relay.example/v1/models"]);
  const byId = modelById(result.models);

  // Anthropic publishes this id, but the relay does not own Anthropic's
  // endpoint, so its record is never borrowed here.
  const known = byId.get("claude-sonnet-4-5");
  assert.equal(known.modelId, "claude-sonnet-4-5", "the wire id stays as served");
  assertGeneric(known, "known publisher id on a relay");
  // An id no publisher states lands on the same conservative seed.
  const unknown = byId.get("some-private-model");
  assert.equal(unknown.modelId, "some-private-model");
  assertGeneric(unknown, "unpublished id on a relay");
});

test("an unowned relay's reported capacity is kept over generic metadata", async (t) => {
  const row = rowOf({
    id: "row-reported-capacity",
    name: "Relay",
    baseUrl: "https://relay.example/v1",
  });
  const { result } = await handlersFor(t, row, {
    data: [{ id: "claude-sonnet-4-5", context_length: 321_000, max_tokens: 12_345 }],
  });

  const [model] = result.models;
  // The live list states what the endpoint actually gives, field by field.
  assert.equal(model.contextWindow, 321_000, "the endpoint reports its actual context window");
  assert.equal(model.maxTokens, 12_345, "the endpoint reports its actual output limit");
  // Reported capacity is not catalog ownership; the remaining fields stay generic.
  assert.equal(model.catalogSource, undefined);
  assert.deepEqual(model.capabilities, ["text"]);
  assert.deepEqual(model.supportedThinkingLevels, []);
});

test("a hand-typed id resolves only inside the publisher that owns the endpoint", async (t) => {
  const owned = rowOf({
    id: "row-typed-owned",
    name: "Xiaomi",
    vendorKey: "xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
  });
  const { calls, lookup } = await handlersFor(t, owned, { data: [] });
  const networkCallsBeforeLookup = calls.length;

  const exact = await lookup({
    modelId: "mimo-v2.5-pro",
    baseUrl: owned.baseUrl,
    vendorKey: owned.vendorKey,
    providerId: owned.id,
  });
  assert.ok(exact.info, "an id the owning publisher states must reach its record");
  assert.equal(exact.info.modelId, "mimo-v2.5-pro");
  assert.equal(exact.info.providerId, owned.id);
  assert.equal(exact.info.catalogSource, "models.dev");
  assert.ok(exact.info.capabilities.includes("tools"), "the owner's record supplies capabilities");

  // A deployment suffix the owner does not state is never stripped.
  const suffix = await lookup({
    modelId: "mimo-v2.5-pro-1m",
    baseUrl: owned.baseUrl,
    vendorKey: owned.vendorKey,
    providerId: owned.id,
  });
  assert.equal(suffix.info, null, "variant suffix is not guessed");
  // Another publisher's id is not borrowed through the owning publisher.
  const foreign = await lookup({
    modelId: "claude-sonnet-4-5",
    baseUrl: owned.baseUrl,
    vendorKey: owned.vendorKey,
    providerId: owned.id,
  });
  assert.equal(foreign.info, null, "another owner's record is not borrowed");

  // A hand-typed id on a relay the catalog cannot place stays unknown.
  const relay = rowOf({ id: "row-typed-relay", name: "Relay", baseUrl: "https://relay.example/v1" });
  const { lookup: relayLookup } = await handlersFor(t, relay, { data: [] });
  const relayKnown = await relayLookup({
    modelId: "claude-sonnet-4-5",
    baseUrl: relay.baseUrl,
    vendorKey: relay.vendorKey,
    providerId: relay.id,
  });
  assert.equal(relayKnown.info, null, "an unowned endpoint keeps a known id unresolved");
  const relayPrivate = await relayLookup({ modelId: "some-private-model", baseUrl: relay.baseUrl });
  assert.equal(relayPrivate.info, null);
  assert.equal(calls.length, networkCallsBeforeLookup, "lookup must not contact the network");
});

test("ownership bounds matching: an unowned relay borrows nothing, an owning endpoint matches exact ids", async (t) => {
  const relay = rowOf({ id: "row-4", name: "Relay", baseUrl: "https://relay.example/v1" });
  const { result } = await handlersFor(t, relay, {
    data: [
      { id: "deepseek-v4-flash" },
      { id: "mimo-v2.5-pro" },
      { id: "mimo-v2.5-pro-1m" },
      { id: "mimo-v2.5-tts" },
      { id: "gemini-2.5-pro-1m" },
      { id: "claude-sonnet-4-5" },
    ],
  });
  const byId = modelById(result.models);

  // These ids belong to other publishers; the relay owns none of their endpoints.
  for (const id of [
    "deepseek-v4-flash",
    "mimo-v2.5-pro",
    "mimo-v2.5-pro-1m",
    "gemini-2.5-pro-1m",
    "claude-sonnet-4-5",
  ]) {
    const model = byId.get(id);
    assert.equal(model.modelId, id, `${id}: the wire id is never rewritten`);
    assertGeneric(model, id);
  }

  // Pi still owns its exact speech model; that is an operation record, not an
  // endpoint match, so it carries no models.dev catalog source.
  const tts = byId.get("mimo-v2.5-tts");
  assert.equal(tts.source, "bundled");
  assert.equal(tts.catalogSource, undefined);
  assert.deepEqual(tts.capabilities, ["text", "audio"]);
  assert.equal(tts.contextWindow, 8_192);
  assert.equal(tts.maxTokens, 8_192);

  const owned = rowOf({
    id: "row-4-owned",
    name: "Xiaomi",
    vendorKey: "xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
  });
  const { result: ownedResult } = await handlersFor(t, owned, {
    data: [
      { id: "mimo-v2.5-pro" },
      { id: "mimo-v2.5-pro-1m" },
      { id: "claude-sonnet-4-5" },
    ],
  });
  const ownedById = modelById(ownedResult.models);

  // The exact Xiaomi id matches inside the publisher that owns the endpoint.
  const exact = ownedById.get("mimo-v2.5-pro");
  assert.equal(exact.modelId, "mimo-v2.5-pro");
  assert.equal(exact.catalogSource, "models.dev");
  for (const capability of ["tools", "reasoning"]) {
    assert.ok(exact.capabilities.includes(capability), `expected ${capability} capability`);
  }

  // A suffix alias and another publisher's id stay generic even on an owned row.
  for (const id of ["mimo-v2.5-pro-1m", "claude-sonnet-4-5"]) {
    const model = ownedById.get(id);
    assert.equal(model.modelId, id, `${id}: the wire id is never rewritten`);
    assertGeneric(model, id);
  }
});

test("an unowned relay does not borrow a uniquely published dated leaf", async (t) => {
  const row = rowOf({ id: "row-5", name: "Relay", baseUrl: "https://relay.example/v1" });
  const { result } = await handlersFor(t, row, { data: [{ id: "doubao-seed-2-0-pro-260215" }] });

  const [model] = result.models;
  assert.equal(model.modelId, "doubao-seed-2-0-pro-260215", "the served wire id is preserved");
  assertGeneric(model, "dated leaf on a relay");
});
