import assert from "node:assert/strict";
import test from "node:test";
import { ModelResolver } from "../electron/main/model-metadata/model-resolver.ts";

const providers = [
  {
    providerKey: "openai",
    api: "https://api.openai.com/v1",
    models: [
      { modelId: "gpt-5", canonicalModelId: "openai/gpt-5" },
      { modelId: "gpt-5-128k" },
    ],
  },
  {
    providerKey: "anthropic",
    api: "https://api.anthropic.com/v1",
    models: [{ modelId: "claude-opus-4.6", canonicalModelId: "anthropic/claude-opus-4.6" }],
  },
  {
    providerKey: "reseller",
    api: "https://relay.example.com/v1",
    models: [{ modelId: "gpt-5", canonicalModelId: "reseller/gpt-5" }],
  },
  {
    providerKey: "shared-a",
    api: "https://shared.example.com/v1",
    models: [{ modelId: "m-a", canonicalModelId: "vendor/m-a" }],
  },
  {
    providerKey: "shared-b",
    api: "https://shared.example.com/v1",
    models: [{ modelId: "m-b", canonicalModelId: "vendor/m-b" }],
  },
  {
    providerKey: "twin-a",
    api: "https://twin-a.example.com/v1",
    models: [{ modelId: "twin", canonicalModelId: "same/shared-basename" }],
  },
  {
    providerKey: "twin-b",
    api: "https://twin-b.example.com/v1",
    models: [{ modelId: "twin-other", canonicalModelId: "other/shared-basename" }],
  },
];

const resolver = new ModelResolver(providers, { fetchedAt: "2026-11-12T00:00:00.000Z" });

test("exact endpoint and explicit key resolve the endpoint's own publisher", () => {
  const result = resolver.resolve({
    modelId: "gpt-5",
    vendorKey: "openai",
    baseUrl: "https://api.openai.com/v1/",
    endpointFetchedAt: "2026-11-12T01:00:00.000Z",
  });
  assert.equal(result.state, "matched");
  assert.equal(result.method, "publisher-exact-id");
  assert.equal(result.domain, "endpoint");
  assert.equal(result.publisher.method, "explicit-key-and-exact-endpoint");
  assert.equal(result.value?.modelId, "gpt-5");
  assert.equal(result.fetchedAt, "2026-11-12T00:00:00.000Z");
  assert.equal(result.endpointFetchedAt, "2026-11-12T01:00:00.000Z");
});

test("endpoint ownership is exact; a shared endpoint needs the exact key", () => {
  const anonymous = resolver.resolvePublisher({ baseUrl: "https://shared.example.com/v1" });
  assert.equal(anonymous.state, "ambiguous");
  assert.deepEqual(anonymous.candidates, ["shared-a", "shared-b"]);
  const scoped = resolver.resolvePublisher({
    baseUrl: "https://shared.example.com/v1",
    vendorKey: "shared-a",
  });
  assert.equal(scoped.state, "matched");
  assert.equal(scoped.provider?.providerKey, "shared-a");
});

test("a key naming another publisher never overrides the endpoint", () => {
  const result = resolver.resolvePublisher({
    vendorKey: "openai",
    baseUrl: "https://api.anthropic.com/v1",
  });
  assert.equal(result.state, "ambiguous");
  assert.deepEqual(result.candidates, ["openai", "anthropic"]);
});

test("an endpoint with no published provider keeps only explicit key identity", () => {
  const publisher = resolver.resolvePublisher({ vendorKey: "reseller" });
  assert.equal(publisher.state, "matched");
  assert.equal(publisher.method, "explicit-key");
});

test("a scoped miss is not filled by another publisher or suffix guessing", () => {
  const unknownEndpoint = resolver.resolve({ modelId: "gpt-5", baseUrl: "https://unknown.example.com/v1" });
  assert.equal(unknownEndpoint.state, "ambiguous");
  assert.equal(unknownEndpoint.publisher.state, "unmatched");
  const scopedMiss = resolver.resolve({
    modelId: "gpt-5-64k",
    vendorKey: "openai",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(scopedMiss.state, "unmatched");
  assert.equal(scopedMiss.value, undefined);
});

test("canonical references answer only when no publisher owns the row", () => {
  const scoped = resolver.resolve({
    modelId: "openai/gpt-5",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(scoped.state, "unmatched");
  const global = resolver.resolve({ modelId: "openai/gpt-5" });
  assert.equal(global.state, "matched");
  assert.equal(global.method, "canonical-exact-id");
  assert.equal(global.domain, "canonical");
  assert.equal(global.publisher.state, "unmatched");
  assert.equal(global.value?.modelId, "gpt-5");
});
test("an exact full id outranks the canonical basename, and unique basenames stay canonical", () => {
  // The request is the published wire id with a case-only difference, so the
  // exact-id casefold step answers before any basename step.
  const casefolded = resolver.resolve({ modelId: "Claude-Opus-4.6" });
  assert.equal(casefolded.state, "matched");
  assert.equal(casefolded.method, "global-exact-id-casefold");
  assert.equal(casefolded.domain, "canonical");
  assert.equal(casefolded.publisher.state, "unmatched");
  assert.equal(casefolded.value?.modelId, "claude-opus-4.6");

  // A vendor-prefixed reference no wire id or canonical id equals falls back to
  // a globally unique canonical basename; it is a canonical reference, never
  // endpoint capacity, and reports its own method.
  const unique = resolver.resolve({ modelId: "unknown/claude-opus-4.6" });
  assert.equal(unique.state, "matched");
  assert.equal(unique.method, "canonical-unique-basename");
  assert.equal(unique.domain, "canonical");
  assert.equal(unique.publisher.state, "unmatched");
  assert.equal(unique.source?.providerKey, "anthropic");
  assert.equal(unique.value?.modelId, "claude-opus-4.6");

  // Two publishers publish the same basename under different canonical ids.
  const ambiguous = resolver.resolve({ modelId: "shared-basename" });
  assert.equal(ambiguous.state, "ambiguous");
  assert.deepEqual(ambiguous.candidates?.map((entry) => entry.providerKey), ["twin-a", "twin-b"]);
});

test("case collisions and explicit declarations stay deterministic", () => {
  const index = new ModelResolver([
    {
      providerKey: "case-a",
      api: "https://case.example.com/v1",
      models: [
        { modelId: "Case-Model" },
        { modelId: "case-model" },
        { modelId: "alpha", canonicalModelId: "decl/alpha" },
      ],
    },
  ]);
  const collision = index.resolve({
    modelId: "CASE-MODEL",
    baseUrl: "https://case.example.com/v1",
  });
  assert.equal(collision.state, "ambiguous");
  assert.deepEqual(collision.candidates?.map((entry) => entry.modelId), ["Case-Model", "case-model"]);
  const declared = index.resolve({
    modelId: "not-published",
    baseUrl: "https://case.example.com/v1",
    declaredCanonicalModelId: "decl/alpha",
  });
  assert.equal(declared.state, "matched");
  assert.equal(declared.method, "declared-canonical-id");
});

test("an ambiguous publisher reports ambiguity, not a false miss", () => {
  const result = resolver.resolve({ modelId: "anything", baseUrl: "https://shared.example.com/v1" });
  assert.equal(result.state, "ambiguous");
  assert.equal(result.publisher.state, "ambiguous");
});
