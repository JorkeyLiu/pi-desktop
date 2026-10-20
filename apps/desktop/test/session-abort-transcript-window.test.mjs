import assert from "node:assert/strict";
import test from "node:test";
import { readStoreModule } from "./helpers/source-contracts.mjs";

/*
  A native/remote abort replaces the visible transcript with the settled
  canonical read. That read is uncapped, so the reading window it produces is
  the whole transcript: keeping the pre-abort cursors would advertise older and
  later pages that no longer exist. There is no module-mocking seam for the
  store's typed IPC boundary, so this contract is asserted on the slice source.
*/
test("a native/remote abort publishes the window metadata that matches its full read", async () => {
  const sliceSource = await readStoreModule("slices/transcript-slice.ts");
  const branch = sliceSource.match(
    /if \(target\?\.source === "pi-native" \|\| isRemoteSession\(target\)\) \{[\s\S]*?\n      \}\n/,
  )?.[0];
  assert.ok(branch, "the native/remote abort branch must stay in place");
  assert.match(
    branch,
    /await runtime\.loadFullSessionMessages\(sessionId\)/,
    "the settled read must use the canonical full read that caches its own window",
  );
  assert.doesNotMatch(
    branch,
    /api\.getSession\(sessionId\)/,
    "the branch must not run a second uncapped read that skips the window cache",
  );
  assert.match(
    branch,
    /\[sessionId\]: FULL_TRANSCRIPT_WINDOW,/,
    "the abort must reset the session's reading window to the full transcript",
  );
});
