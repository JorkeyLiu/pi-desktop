/**
 * The tab menu's outside press must reach the renderer even where the panel
 * header is a native window-drag rectangle.
 *
 * `ContextMenu` dismisses on a capture-phase `pointerdown` on `window`, so no
 * renderer listener can keep it open across an outside press. The remaining
 * way such a press can be lost is the native layer: a `-webkit-app-region:
 * drag` rectangle resolves in Electron before the renderer sees anything, and
 * the blank header band around the tab strip is one. These assertions pin the
 * two halves of that contract — the menu really does land directly under
 * `<body>`, and the header's drag rectangle stands down while it is there.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

const styles = await loadStyles();
const contextMenuSource = await read("../src/components/ContextMenu.tsx");
const portalSource = await read("../src/lib/portal-visibility.tsx");

const declarationsOnly = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

test("the menu is a direct child of body, so a body-scoped rule sees it", () => {
  // The drag stand-down below is keyed on `body:has(> .context-menu)`. If the
  // menu stops being portaled straight into body, that rule silently stops
  // matching and the click that dismisses goes back to being swallowed.
  assert.match(portalSource, /createPortal\(visiblePortalContent\(node\), document\.body\)/);
  assert.match(contextMenuSource, /return portalToBody\(/);
  assert.match(contextMenuSource, /className=\{`context-menu\$\{placement \? " is-open" : ""\}`\}/);
});

test("the panel header's drag rectangle stands down while a menu is open", () => {
  const css = declarationsOnly(styles);
  const headerRule = css.match(/\.work-panel-header\s*\{[^}]*\}/);
  assert.ok(headerRule, "work-panel.css lost its header rule");
  // Dragging outside a menu is the behaviour that must not regress.
  assert.match(headerRule[0], /-webkit-app-region:\s*drag;/);

  const standDown = css.match(
    /body:has\(> \.context-menu\) \.work-panel-header\s*\{[^}]*\}/,
  );
  assert.ok(
    standDown,
    "no rule hands the header back to the renderer while a context menu is open",
  );
  assert.match(standDown[0], /-webkit-app-region:\s*no-drag;/);
  assert.match(standDown[0], /\bapp-region:\s*no-drag;/);

  // The descendant selector is more specific and declared later, so the
  // stand-down wins the cascade without depending on either alone.
  assert.ok(
    css.indexOf(standDown[0]) > css.indexOf(headerRule[0]),
    "the stand-down rule must be declared after the header's drag rectangle",
  );
});
