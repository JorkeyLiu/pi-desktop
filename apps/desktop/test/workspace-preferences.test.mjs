import assert from "node:assert/strict";
import test from "node:test";
import {
  LAST_SELECTED_SESSION_KEY,
  clearLastSelectedSession,
  loadLastSelectedSession,
  saveLastSelectedSession,
} from "../src/lib/workspace-preferences.ts";

function memoryStorage(values = new Map()) {
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function withStorage(store, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: store,
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

test("the remembered session round-trips through storage and clears", () => {
  const store = memoryStorage();
  store.values.set("unrelated", "keep");
  withStorage(store, () => {
    assert.equal(loadLastSelectedSession(), undefined);
    saveLastSelectedSession("session-1");
    assert.equal(loadLastSelectedSession(), "session-1");
    assert.equal(
      store.values.get(LAST_SELECTED_SESSION_KEY),
      JSON.stringify("session-1"),
      "the stored value keeps the existing JSON string encoding",
    );
    saveLastSelectedSession("session-2");
    assert.equal(loadLastSelectedSession(), "session-2");
    clearLastSelectedSession();
    assert.equal(loadLastSelectedSession(), undefined);
    assert.equal(store.values.has(LAST_SELECTED_SESSION_KEY), false);
    assert.equal(store.values.get("unrelated"), "keep", "clearing leaves other keys alone");
  });
});

test("invalid or non-string stored values fall back to no remembered session", () => {
  const cases = [
    ["", undefined],
    ["   ", undefined],
    [JSON.stringify(""), undefined],
    [JSON.stringify("  "), undefined],
    [JSON.stringify(42), undefined],
    [JSON.stringify({ id: "session" }), undefined],
    [JSON.stringify(null), undefined],
    ["not json", undefined],
    [JSON.stringify(" session-1 "), " session-1 "],
  ];
  for (const [stored, expected] of cases) {
    const store = memoryStorage();
    store.values.set(LAST_SELECTED_SESSION_KEY, stored);
    withStorage(store, () => {
      assert.equal(loadLastSelectedSession(), expected, `stored ${JSON.stringify(stored)}`);
    });
  }
});

test("unavailable storage never blocks startup or shutdown", () => {
  const store = memoryStorage();
  store.setItem = () => {
    throw new Error("quota exceeded");
  };
  store.removeItem = () => {
    throw new Error("storage disabled");
  };
  withStorage(store, () => {
    assert.doesNotThrow(() => saveLastSelectedSession("session-1"));
    assert.doesNotThrow(() => clearLastSelectedSession());
  });

  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage unavailable");
    },
  });
  try {
    assert.equal(loadLastSelectedSession(), undefined);
    assert.doesNotThrow(() => saveLastSelectedSession("session-1"));
    assert.doesNotThrow(() => clearLastSelectedSession());
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});

test("no storage at all reads as no remembered session", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  delete globalThis.localStorage;
  try {
    assert.equal(loadLastSelectedSession(), undefined);
    assert.doesNotThrow(() => saveLastSelectedSession("session-1"));
    assert.doesNotThrow(() => clearLastSelectedSession());
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
  }
});
