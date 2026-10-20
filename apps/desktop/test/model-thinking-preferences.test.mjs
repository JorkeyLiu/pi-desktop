import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_THINKING_PREFERENCES_KEY,
  loadModelThinkingPreferences,
  modelThinkingPreferenceKey,
  rememberedModelThinkingLevel,
  rememberModelThinkingLevel,
  resolveModelThinkingLevel,
} from "../src/lib/model-thinking-preferences.ts";

const catalogBinding = (thinkingLevels, defaultThinkingLevel) => ({
  thinkingLevels,
  defaultThinkingLevel,
});

function withStorage(t, { failWrites = false } = {}) {
  const previousStorage = globalThis.localStorage;
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error("quota exceeded");
      data.set(key, String(value));
    },
  };
  t.after(() => { globalThis.localStorage = previousStorage; });
  return data;
}

test("each provider/model pair keeps its own remembered level", (t) => {
  const data = withStorage(t);
  rememberModelThinkingLevel({ providerId: "p", modelId: "Model-A" }, "low");
  rememberModelThinkingLevel({ providerId: "q", modelId: "model-a" }, "high");
  assert.deepEqual(loadModelThinkingPreferences(), {
    [modelThinkingPreferenceKey({ providerId: "p", modelId: "model-a" })]: "low",
    [modelThinkingPreferenceKey({ providerId: "q", modelId: "model-a" })]: "high",
  });
  assert.equal(rememberedModelThinkingLevel({ providerId: "p", modelId: "model-a" }), "low");
  assert.equal(rememberedModelThinkingLevel({ providerId: "q", modelId: "model-a" }), "high");
  assert.equal(rememberedModelThinkingLevel({ providerId: "p", modelId: "other" }), null);
  assert.ok(data.has(MODEL_THINKING_PREFERENCES_KEY));

  // Changing one model never rewrites another.
  rememberModelThinkingLevel({ providerId: "p", modelId: "model-a" }, "max");
  assert.equal(rememberedModelThinkingLevel({ providerId: "p", modelId: "model-a" }), "max");
  assert.equal(rememberedModelThinkingLevel({ providerId: "q", modelId: "model-a" }), "high");
});

test("an incomplete identity or a blocked store is a no-op, never a crash", (t) => {
  withStorage(t);
  rememberModelThinkingLevel({ providerId: "p" }, "high");
  rememberModelThinkingLevel({ modelId: "model-a" }, "high");
  assert.deepEqual(loadModelThinkingPreferences(), {});
  assert.equal(rememberedModelThinkingLevel({}), null);

  withStorage(t, { failWrites: true });
  assert.doesNotThrow(() => rememberModelThinkingLevel({ providerId: "p", modelId: "a" }, "low"));
  assert.deepEqual(loadModelThinkingPreferences(), {});
});

test("stored payloads are validated and unusable data falls back to no memory", (t) => {
  const data = withStorage(t);
  for (const raw of ["not json", "[]", "null", '"high"', "{}"]) {
    data.set(MODEL_THINKING_PREFERENCES_KEY, raw);
    assert.deepEqual(loadModelThinkingPreferences(), {}, `rejects ${raw}`);
  }
  data.set(MODEL_THINKING_PREFERENCES_KEY, JSON.stringify({
    [modelThinkingPreferenceKey({ providerId: "p", modelId: "a" })]: "high",
    [modelThinkingPreferenceKey({ providerId: "p", modelId: "b" })]: "extreme",
    [modelThinkingPreferenceKey({ providerId: "p", modelId: "c" })]: 3,
  }));
  assert.deepEqual(loadModelThinkingPreferences(), {
    [modelThinkingPreferenceKey({ providerId: "p", modelId: "a" })]: "high",
  });
});

test("a remembered level is clamped onto what the model accepts now", (t) => {
  withStorage(t);
  const binding = catalogBinding(["low", "high"], "high");
  const resolve = (providerId, modelId) => resolveModelThinkingLevel({
    providerId,
    modelId,
    binding,
    catalogMatched: true,
    fallbackLevels: ["low", "high"],
  });

  assert.equal(resolve("p", "fresh"), "high", "no memory keeps the binding default");

  rememberModelThinkingLevel({ providerId: "p", modelId: "down" }, "max");
  assert.equal(resolve("p", "down"), "high", "a level above the ladder clamps down");
  rememberModelThinkingLevel({ providerId: "p", modelId: "up" }, "minimal");
  assert.equal(resolve("p", "up"), "low", "a level below the ladder clamps up");
  rememberModelThinkingLevel({ providerId: "p", modelId: "exact" }, "low");
  assert.equal(resolve("p", "exact"), "low");
  rememberModelThinkingLevel({ providerId: "p", modelId: "omit" }, "omit");
  assert.equal(resolve("p", "omit"), "omit", "omit is preserved on a reasoning binding");

  // A model that stopped accepting a level at all resolves to its only option.
  assert.equal(
    resolveModelThinkingLevel({
      providerId: "p",
      modelId: "exact",
      binding: catalogBinding([], null),
      catalogMatched: true,
      fallbackLevels: ["low", "high"],
    }),
    "off",
    "a remembered level never bypasses an empty binding ladder",
  );
  assert.equal(
    resolveModelThinkingLevel({
      providerId: "p",
      modelId: "omit",
      binding: catalogBinding(["off"], "off"),
      catalogMatched: true,
      fallbackLevels: ["off"],
    }),
    "off",
    "omit without an enabled reasoning level becomes off",
  );
});

test("unknown models keep their ladder and their remembered level", (t) => {
  withStorage(t);
  rememberModelThinkingLevel({ providerId: "p", modelId: "user-model" }, "high");
  assert.equal(
    resolveModelThinkingLevel({
      providerId: "p",
      modelId: "user-model",
      binding: catalogBinding([], null),
      catalogMatched: false,
    }),
    "high",
    "an unlisted free-form model can still remember an explicit level",
  );
  assert.equal(
    resolveModelThinkingLevel({
      providerId: "p",
      modelId: "other-model",
      binding: catalogBinding([], null),
      catalogMatched: false,
    }),
    "off",
    "an unknown model without memory still starts at off",
  );
  assert.equal(
    resolveModelThinkingLevel({
      providerId: "p",
      modelId: "other-model",
      binding: catalogBinding([], "high"),
      catalogMatched: false,
    }),
    "high",
    "an explicit binding default still wins without memory",
  );
});

test("an injected preference map resolves without touching storage", () => {
  const preferences = {
    [modelThinkingPreferenceKey({ providerId: "p", modelId: "a" })]: "low",
  };
  assert.equal(
    resolveModelThinkingLevel({
      providerId: "p",
      modelId: "a",
      binding: catalogBinding(["low", "high"], "high"),
      catalogMatched: true,
      preferences,
    }),
    "low",
  );
  assert.equal(rememberedModelThinkingLevel({ providerId: "p", modelId: "a" }, preferences), "low");
});
