/*
  Phase-1 acquisition/cache contract for canonical models.dev metadata.

  Everything here is exercised at a real external boundary: fake `fetch`,
  a temporary data directory, and an injected clock. No live network, no
  provider APIs, no shipping Electron instance.
*/

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MODELS_DEV_API_URL,
  ModelsDevCatalog,
  parseModelsDevCatalog,
} from "../electron/main/models-dev-catalog.ts";
import {
  MODELS_DEV_CACHE_VERSION,
  createModelsDevCache,
  modelsDevCachePath,
} from "../electron/main/model-metadata/models-dev-cache.ts";
import {
  ModelsDevSourceError,
  fetchModelsDevDocument,
} from "../electron/main/model-metadata/models-dev-source.ts";

const FIXED_NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

/** Minimal document the parser accepts; deliberately not a full fixture set. */
const bundledFixture = {
  alpha: {
    id: "alpha",
    name: "Alpha",
    api: "https://api.alpha.test",
    models: {
      "alpha-one": {
        id: "alpha-one",
        name: "Alpha One",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 32_000, output: 4_000 },
      },
    },
  },
};

const refreshedFixture = {
  alpha: {
    ...bundledFixture.alpha,
    models: {
      ...bundledFixture.alpha.models,
      "alpha-two": {
        id: "alpha-two",
        name: "Alpha Two",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 64_000, output: 8_000 },
      },
    },
  },
};

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function modelIds(catalog) {
  return catalog.getStatus().modelCount;
}

async function makeWorkspace(t, fixture = bundledFixture) {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(fixture), "utf8");
  return { dir, catalogPath, cachePath: modelsDevCachePath(dir) };
}

async function writeCacheFile(cachePath, contents) {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, contents, "utf8");
}

function seedCache(cachePath, entry) {
  const envelope = {
    version: MODELS_DEV_CACHE_VERSION,
    sourceUrl: MODELS_DEV_API_URL,
    ...entry,
  };
  return writeCacheFile(cachePath, JSON.stringify(envelope));
}

test("a disk-cached payload loads before the bundled snapshot and survives restart", async (t) => {
  const { dir, catalogPath, cachePath } = await makeWorkspace(t);
  await stat(dir);
  const calls = [];
  const first = new ModelsDevCatalog({
    catalogPath,
    cachePath,
    now: () => FIXED_NOW,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(refreshedFixture, { headers: { etag: '"alpha-v2"' } });
    },
  });
  t.after(() => first.dispose());

  assert.equal(await first.ensureLoaded(), true);
  assert.equal(first.getStatus().source, "bundled", "bootstrap fallback paints first");
  // The automatic revalidation shares the single-flight promise with refresh().
  assert.equal(await first.refresh(), true);
  assert.equal(calls.length, 1, "startup refresh and explicit refresh dedupe");
  assert.equal(calls[0].url, MODELS_DEV_API_URL);
  assert.equal(calls[0].init.credentials, "omit", "no credentials go to the public source");
  assert.deepEqual(calls[0].init.headers, { Accept: "application/json" });
  assert.equal(first.getStatus().source, "remote");
  assert.ok(first.getProvenance().fetchedAt);
  const fetchedAt = first.getStatus().fetchedAt;
  assert.equal(fetchedAt, new Date(FIXED_NOW).toISOString());

  const cacheRaw = await readFile(cachePath, "utf8");
  const envelope = JSON.parse(cacheRaw);
  assert.equal(envelope.version, MODELS_DEV_CACHE_VERSION);
  assert.equal(envelope.sourceUrl, MODELS_DEV_API_URL);
  assert.equal(envelope.fetchedAt, fetchedAt);
  assert.equal(envelope.validator.etag, '"alpha-v2"');
  const temporary = (await readdir(join(dir, "model-metadata"))).filter((name) =>
    name.endsWith(".tmp"),
  );
  assert.deepEqual(temporary, [], "atomic write leaves no temporary file");
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);

  // Restart: the validated cache wins over the bundled snapshot, no network.
  let restartFetches = 0;
  const second = new ModelsDevCatalog({
    catalogPath,
    cachePath,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      restartFetches += 1;
      throw new Error("a fresh cache must not revalidate");
    },
  });
  t.after(() => second.dispose());
  assert.equal(await second.ensureLoaded(), true);
  assert.equal(modelIds(second), 2, "refreshed payload is used after restart");
  assert.equal(second.getStatus().source, "remote");
  assert.equal(second.getStatus().fetchedAt, fetchedAt);
  assert.equal(second.getProvenance().source, "cache");
  assert.equal(restartFetches, 0);
});

test("a payload outside the freshness window revalidates without blocking the caller", async (t) => {
  const { catalogPath, cachePath } = await makeWorkspace(t);
  await seedCache(cachePath, {
    fetchedAt: new Date(FIXED_NOW - 25 * HOUR_MS).toISOString(),
    validator: { etag: '"alpha-v1"' },
    payload: bundledFixture,
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requests = [];
  const catalog = new ModelsDevCatalog({
    catalogPath,
    cachePath,
    now: () => FIXED_NOW,
    fetchImpl: async (url, init) => {
      requests.push(init);
      return gate;
    },
  });
  t.after(() => catalog.dispose());

  assert.equal(await catalog.ensureLoaded(), true, "caller gets the cached catalog immediately");
  assert.equal(catalog.findModel({ vendorKey: "alpha", modelId: "alpha-one" })?.modelId, "alpha-one");
  assert.equal(requests.length, 1, "stale cache triggers one background revalidation");
  assert.equal(requests[0].headers["If-None-Match"], '"alpha-v1"');

  release(new Response(null, { status: 304, headers: { etag: '"alpha-v1"' } }));
  assert.equal(await catalog.refresh(), true, "304 succeeds with a usable cached payload");
  assert.equal(modelIds(catalog), 1, "304 keeps the cached payload");
  assert.equal(
    catalog.getStatus().fetchedAt,
    new Date(FIXED_NOW - 25 * HOUR_MS).toISOString(),
    "304 does not rewrite the payload timestamp",
  );
  assert.equal(catalog.getProvenance().status, "fresh");
});

test("a 304 without a usable cached payload fails instead of emptying the catalog", async (t) => {
  const { catalogPath, cachePath } = await makeWorkspace(t);
  const catalog = new ModelsDevCatalog({
    catalogPath,
    cachePath,
    now: () => FIXED_NOW,
    fetchImpl: async () => new Response(null, { status: 304 }),
  });
  t.after(() => catalog.dispose());

  assert.equal(await catalog.ensureLoaded(), true);
  assert.equal(await catalog.refresh(), false);
  assert.match(catalog.getStatus().lastError, /304/);
  assert.equal(modelIds(catalog), 1, "bundled snapshot stays usable");
  assert.equal(catalog.getStatus().loaded, true);
  await assert.rejects(readFile(cachePath, "utf8"), /ENOENT/, "nothing is persisted on failure");
});

test("a schema-invalid document is rejected at the boundary and keeps known-good data", async (t) => {
  const { catalogPath, cachePath } = await makeWorkspace(t);
  const bodies = [{}, [], { alpha: { name: "Alpha" } }];
  let index = 0;
  const catalog = new ModelsDevCatalog({
    catalogPath,
    cachePath,
    now: () => FIXED_NOW,
    fetchImpl: async () => jsonResponse(bodies[index++]),
  });
  t.after(() => catalog.dispose());

  assert.equal(await catalog.ensureLoaded(), true);
  for (const body of bodies) {
    assert.equal(await catalog.refresh(), false, `rejected payload ${JSON.stringify(body)}`);
    assert.match(catalog.getStatus().lastError, /usable providers|must be an object/);
    assert.equal(modelIds(catalog), 1, "known-good rows survive every rejection");
  }
  await assert.rejects(readFile(cachePath, "utf8"), /ENOENT/, "invalid data is never cached");
});

test("an oversized response is rejected while streaming, without a Content-Length", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"alpha":"'));
      controller.enqueue(encoder.encode("x".repeat(4_096)));
      controller.close();
    },
  });
  await assert.rejects(
    fetchModelsDevDocument({
      maxBytes: 1_024,
      fetchImpl: async () => new Response(stream),
    }),
    (error) => error instanceof ModelsDevSourceError && error.failure === "oversize",
  );
});

test("an unusable cache file is quarantined and the bundled snapshot still loads", async (t) => {
  const { catalogPath, cachePath } = await makeWorkspace(t);
  let fetches = 0;
  const catalog = new ModelsDevCatalog({
    catalogPath,
    cachePath,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("offline");
    },
  });
  t.after(() => catalog.dispose());

  await writeCacheFile(
    cachePath,
    JSON.stringify({ version: 99, sourceUrl: MODELS_DEV_API_URL, fetchedAt: "now", payload: {} }),
  );
  assert.equal(await catalog.ensureLoaded(), true, "unsupported version falls back to bundled");
  assert.equal(modelIds(catalog), 1);
  const names = await readdir(join(catalogPath, "..", "model-metadata"));
  assert.ok(names.some((name) => name.startsWith("models-dev-v1.json.corrupt-")), names.join(","));
  assert.ok(!names.includes("models-dev-v1.json"), "quarantined cache is moved aside");
});

test("a truncated cache file is quarantined instead of being trusted", async (t) => {
  const { catalogPath, cachePath } = await makeWorkspace(t);
  const catalog = new ModelsDevCatalog({ catalogPath, cachePath, now: () => FIXED_NOW });
  t.after(() => catalog.dispose());
  await writeCacheFile(cachePath, '{"version":1,"sourceUrl":"https://models.dev/api.json",');
  assert.equal(await catalog.ensureLoaded(), true);
  assert.match(catalog.getStatus().source, /bundled/);
});

test("a failed refresh keeps the cache and retries automatic revalidation only once", async (t) => {
  const { catalogPath, cachePath } = await makeWorkspace(t);
  await seedCache(cachePath, {
    fetchedAt: new Date(FIXED_NOW - 25 * HOUR_MS).toISOString(),
    payload: bundledFixture,
  });
  const cacheBefore = await readFile(cachePath, "utf8");
  let fetches = 0;
  const catalog = new ModelsDevCatalog({
    catalogPath,
    cachePath,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("offline");
    },
  });
  t.after(() => catalog.dispose());

  assert.equal(await catalog.ensureLoaded(), true);
  assert.equal(await catalog.refresh(), false);
  assert.match(catalog.getStatus().lastError, /offline/);
  assert.equal(modelIds(catalog), 1, "still-usable cached data is not rejected");
  assert.equal(await readFile(cachePath, "utf8"), cacheBefore, "failed refresh never rewrites the cache");
  await catalog.ensureLoaded();
  assert.equal(fetches, 1, "an automatic revalidation failure is not retried in-process");
});

test("concurrent refreshes share one request", async (t) => {
  const { catalogPath, cachePath } = await makeWorkspace(t);
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const catalog = new ModelsDevCatalog({
    catalogPath,
    cachePath,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      fetches += 1;
      return gate;
    },
  });
  t.after(() => catalog.dispose());
  assert.equal(await catalog.ensureLoaded(), true);
  const a = catalog.refresh();
  const b = catalog.refresh();
  release(jsonResponse(refreshedFixture));
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(fetches, 1);
  assert.equal(modelIds(catalog), 2);
});

test("dispose aborts in-flight work and nothing is persisted afterwards", async (t) => {
  const { catalogPath, cachePath } = await makeWorkspace(t);
  const catalog = new ModelsDevCatalog({
    catalogPath,
    cachePath,
    now: () => FIXED_NOW,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  });
  assert.equal(await catalog.ensureLoaded(), true);
  const refresh = catalog.refresh();
  catalog.dispose();
  assert.equal(await refresh, false);
  assert.match(catalog.getStatus().lastError, /cancel|abort/i);
  assert.equal(catalog.getStatus().loaded, true, "known-good data survives disposal");
  t.after(() => rm(join(catalogPath, ".."), { recursive: true, force: true }));
  await assert.rejects(readFile(cachePath, "utf8"), /ENOENT/);
});

test("the shipped api.json is accepted by the versioned cache", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-real-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = JSON.parse(
    await readFile(new URL("../resources/models.dev/api.json", import.meta.url), "utf8"),
  );
  const cache = createModelsDevCache({
    filePath: join(dir, "model-metadata", "models-dev-v1.json"),
    sourceUrl: MODELS_DEV_API_URL,
    validatePayload: (raw) => parseModelsDevCatalog(raw).length,
    now: () => FIXED_NOW,
  });
  await cache.write({ fetchedAt: new Date(FIXED_NOW).toISOString(), payload });
  const read = await cache.read();
  assert.equal(read.kind, "ok");
  assert.equal(parseModelsDevCatalog(read.entry.payload).length, parseModelsDevCatalog(payload).length);
  assert.ok(parseModelsDevCatalog(read.entry.payload).length > 0);
});

test("a cache written for another source is quarantined", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-source-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "model-metadata", "models-dev-v1.json");
  const cache = createModelsDevCache({
    filePath,
    sourceUrl: MODELS_DEV_API_URL,
    validatePayload: (raw) => parseModelsDevCatalog(raw).length,
    now: () => FIXED_NOW,
  });
  await writeCacheFile(
    filePath,
    JSON.stringify({
      version: MODELS_DEV_CACHE_VERSION,
      sourceUrl: "https://example.test/api.json",
      fetchedAt: new Date(FIXED_NOW).toISOString(),
      payload: bundledFixture,
    }),
  );
  const read = await cache.read();
  assert.equal(read.kind, "invalid");
  const names = await readdir(join(dir, "model-metadata"));
  assert.ok(names.some((name) => name.includes(".corrupt-")));
});
