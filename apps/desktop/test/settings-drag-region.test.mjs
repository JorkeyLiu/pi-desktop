import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsSource = await readSettingsSource();
const globalStyles = await loadStyles();
const plateSource = await readFile(
  new URL("../src/components/SecondaryWindow.tsx", import.meta.url),
  "utf8",
);

test("settings owns no drag band inside a floating window", () => {
  // The plate is position-fixed, so nothing over it moves the OS window: the
  // titlebar-shaped band Settings used to paint above its content is gone.
  assert.doesNotMatch(settingsSource, /settings-titlebar/);
  assert.doesNotMatch(settingsSource, /settings-nav-top/);
  assert.doesNotMatch(settingsSource, /app-region/);
  assert.doesNotMatch(globalStyles, /\n\.settings-titlebar\s*\{/);
});

test("settings rail keeps the shared nav width token and only narrows inside the window", () => {
  assert.match(
    globalStyles,
    /\n\.settings-shell-full \.settings-nav\s*\{[^}]*width:\s*var\(--ds-settings-nav-width\);[^}]*flex:\s*0 0 var\(--ds-settings-nav-width\);/s,
  );
  assert.match(globalStyles, /--ds-settings-nav-width:\s*275px;/);
  // One fact, two scopes: the window redefines the token instead of giving the
  // rail a second width rule.
  assert.match(
    globalStyles,
    /\n\.settings-shell-window\s*\{\s*--ds-settings-nav-width:\s*252px;\s*\}/s,
  );
  assert.match(
    globalStyles,
    /@media \(max-width: 860px\), \(max-height: 640px\) \{[\s\S]*?--ds-settings-nav-width:\s*216px;/s,
  );
  assert.doesNotMatch(globalStyles, /\.settings-shell-window \.settings-nav\s*\{[^}]*width:/);
  assert.doesNotMatch(globalStyles, /\.settings-shell-window \.settings-nav\s*\{[^}]*flex-basis:/);
});

test("the window control row is not a drag region and its controls stay clickable", () => {
  // A centered plate never reaches the frameless window's control band, so it
  // reserves nothing for it and nothing inside it drags the OS window.
  assert.doesNotMatch(globalStyles, /\.secondary-window-bar\s*\{[^}]*app-region:\s*drag;/s);
  assert.doesNotMatch(globalStyles, /draws-window-controls/);
  assert.doesNotMatch(globalStyles, /secondary-window[^{]*\{[^}]*app-region:/s);
  // The plate has no title band at all: only the floating close control, which
  // sits in reserved content padding rather than a control row.
  assert.doesNotMatch(plateSource, /<header className="secondary-window-bar">/);
  assert.doesNotMatch(plateSource, /secondary-window-title/);
  assert.match(plateSource, /className="secondary-window-close"/);
  // The rail no longer sits under a drag strip either.
  assert.doesNotMatch(settingsSource, /no-drag/);
});
