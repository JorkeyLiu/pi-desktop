/**
 * Which backend may receive a read scope.
 *
 * Only the local host implements scoped history. Native Pi sessions and remote
 * hosts answer the legacy physical transcript, so the field is dropped before
 * the request leaves the main process and the renderer keeps its legacy
 * behavior on the missing echo instead of filtering a legacy answer locally.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { historyScopeForBackend, historyScopeForwarding } = await import(
  "../electron/main/ipc/history-scope-forward.ts"
);

test("the local host receives the validated scope", () => {
  assert.deepEqual(historyScopeForBackend({ kind: "main" }, "host"), { kind: "main" });
  assert.deepEqual(historyScopeForBackend({ kind: "delegation", id: "d1" }, "host"), {
    kind: "delegation",
    id: "d1",
  });
  assert.deepEqual(historyScopeForwarding({ kind: "main" }, "host"), {
    historyScope: { kind: "main" },
  });
});

test("native and remote reads drop the scope explicitly", () => {
  for (const backend of ["native", "remote"]) {
    assert.equal(historyScopeForBackend({ kind: "main" }, backend), undefined);
    assert.deepEqual(
      historyScopeForwarding({ kind: "delegation", id: "d1" }, backend),
      {},
      `${backend} forwards no scope`,
    );
  }
});

test("an absent or malformed scope stays a legacy read", () => {
  // A stray extra field on `main` is ignored by the contract; an unusable
  // delegation id or an unknown kind keeps the legacy full-transcript meaning.
  for (const value of [undefined, null, {}, { kind: "delegation" }, { kind: "delegation", id: "   " }, "main", 7]) {
    assert.equal(historyScopeForBackend(value, "host"), undefined);
    assert.deepEqual(historyScopeForwarding(value, "host"), {});
  }
});
