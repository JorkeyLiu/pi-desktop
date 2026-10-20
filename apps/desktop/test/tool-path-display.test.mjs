import assert from "node:assert/strict";
import test from "node:test";
import { toolPathName } from "../src/lib/tool-path-display.ts";

/**
 * A collapsed file row prints one thing: the file's own name. These tests pin
 * that name for every spelling the tools report — POSIX, Windows, relative — and
 * pin the values that must stay whole because they have no name to show.
 */

const EXTERNAL =
  "/Users/jorkeyliu/workspace/repos/pi-desktop-mw/apps/desktop/src/features/chat/transcript/hooks/use-transcript-scroll.ts";
const SIBLING =
  "/Users/jorkeyliu/workspace/repos/pi-desktop-mw/apps/desktop/src/features/chat/transcript/hooks/use-transcript-window.ts";
const WINDOWS =
  "C:\\Users\\jorkeyliu\\workspace\\repos\\pi-desktop-mw\\apps\\desktop\\src\\features\\hooks\\use-transcript-scroll.ts";
const RELATIVE = "src/features/chat/transcript/hooks/use-transcript-scroll.ts";

test("a path prints its file name, never the directory", () => {
  for (const path of [EXTERNAL, RELATIVE, WINDOWS, `${EXTERNAL}`.replace(/\//g, "\\")]) {
    assert.equal(toolPathName(path), "use-transcript-scroll.ts");
  }
  // The directory never leaks into the hint, however deep it is.
  assert.equal(toolPathName(EXTERNAL).includes("/"), false);
  assert.equal(toolPathName(WINDOWS).includes("\\"), false);
});

test("a Windows spelling is read with its own separators", () => {
  assert.equal(toolPathName(WINDOWS), "use-transcript-scroll.ts");
  // A backslash inside a name is a separator for this value, exactly as the
  // runtime spelled it.
  assert.equal(toolPathName("C:\\a\\b\\index.ts"), "index.ts");
  // A mixed spelling follows the last separator of either kind.
  assert.equal(toolPathName("C:\\a/b\\c.ts"), "c.ts");
  assert.equal(toolPathName("a\\b/c.ts"), "c.ts");
});

test("a bare name is already the name it prints", () => {
  assert.equal(toolPathName("App.tsx"), "App.tsx");
  assert.equal(toolPathName("use-transcript-scroll.ts"), "use-transcript-scroll.ts");
  // No trailing separator is invented, and the extension stays whole.
  assert.equal(toolPathName("RELEASE-NOTES.md"), "RELEASE-NOTES.md");
});

test("a value with no name to show stays whole", () => {
  // A directory names its last segment and keeps the separator that says so, so
  // the row still reads as a folder rather than a file.
  assert.equal(toolPathName("src/features/"), "features/");
  assert.equal(toolPathName("/Users/jorkeyliu/workspace/"), "workspace/");
  assert.equal(toolPathName("C:\\Users\\me\\"), "me\\");
  // A root has no segment at all: showing nothing would leave the row blank.
  assert.equal(toolPathName("/"), "/");
  assert.equal(toolPathName("C:\\"), "C:\\");
  assert.equal(toolPathName(""), "");
});

test("two files under one prefix stay distinguishable", () => {
  assert.equal(toolPathName(EXTERNAL), "use-transcript-scroll.ts");
  assert.equal(toolPathName(SIBLING), "use-transcript-window.ts");
  assert.notEqual(toolPathName(EXTERNAL), toolPathName(SIBLING));
});

test("an unusually long name stays whole for the row to ellipsize", () => {
  const name = "a-considerably-longer-name-for-one-row-of-the-transcript.spec.mjs";
  const path = `/Users/me/workspace/repos/pi-desktop/apps/desktop/src/${name}`;
  // The hint is not shortened here: CSS ellipsizes it at the row's own edge, so
  // the remainder is still the value, not an omission the helper composed.
  assert.equal(toolPathName(path), name);
  assert.equal(toolPathName(path).includes("…"), false);
});
