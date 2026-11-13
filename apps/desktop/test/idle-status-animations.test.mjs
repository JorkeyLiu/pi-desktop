import assert from "node:assert/strict";
import test from "node:test";
import { loadStylesSync } from "./helpers/styles.mjs";

/**
 * Idle status indicators must not keep submitting frames.
 *
 * Any continuously animating indicator keeps the window surface dirty, and the
 * macOS window is `transparent: true` over the native `sidebar` vibrancy
 * material, so it is re-composited every frame it stays dirty: a 7px dot is
 * enough to drive WindowServer GPU to ~70% on an otherwise idle desktop. See
 * issue #1064 and `04-ux/07-ui-design-system.md` (sidebar status marks).
 *
 * The one deliberate exception is the running workspace halo: it animates only
 * while a turn really is in flight, and the reduced-motion rule keeps it static.
 */

const styles = loadStylesSync();

function declarationBlock(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule block for ${selector}`);
  const end = styles.indexOf("}", start);
  assert.ok(end > start, `unterminated rule block for ${selector}`);
  return styles.slice(start, end + 1);
}

function containedRule(scope, selector) {
  const start = scope.indexOf(`${selector} {`);
  if (start < 0) return null;
  const end = scope.indexOf("}", start);
  return scope.slice(start, end + 1);
}

/** Every top-level `@media (prefers-reduced-motion: reduce)` block, by brace. */
function reducedMotionBlocks() {
  const marker = "@media (prefers-reduced-motion: reduce) {";
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = styles.indexOf(marker, from);
    if (start < 0) return blocks;
    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < styles.length; index += 1) {
      if (styles[index] === "{") depth += 1;
      else if (styles[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(styles.slice(start, index + 1));
    from = index + 1;
  }
}

// Running marks were bounded by #1064; the rest stay mounted while nothing is
// running (a session waiting on permission, plan mode left on, a backend
// warning banner), so they kept animating on an idle window.
const IDLE_INDICATORS = [
  ".sidebar-session-hover-card-session-link-status::before",
  ".thread-item-status.permission::before",
  '.composer-mode-chip[data-planning="true"] svg',
  ".backend-banner.warn .backend-dot",
];

test("idle status indicators stop submitting frames", () => {
  for (const selector of IDLE_INDICATORS) {
    const block = declarationBlock(selector);
    assert.doesNotMatch(
      block,
      /infinite/,
      `${selector} must not animate forever while the window is idle`,
    );
    assert.match(
      block,
      /animation:[^;]*\b[12];/,
      `${selector} must keep a finite cycle count`,
    );
  }
});

// The manual idle marks stay perfectly still: a hollow ring for an unmarked
// session, a plain orange fill for a marked one. Only live work moves.
test("manual sidebar marks never animate", () => {
  for (const selector of [
    ".thread-item-status.idle::before",
    ".thread-item-status.pending::before",
    ".thread-item-status.running::before",
  ]) {
    const block = declarationBlock(selector);
    assert.doesNotMatch(block, /animation/, `${selector} must stay static`);
    assert.doesNotMatch(block, /infinite/, `${selector} must not loop`);
  }
});

test("the running halo is the sidebar's one continuous animation, scoped to running", () => {
  const halo = declarationBlock(".thread-item-status.running::after");
  assert.match(halo, /animation:[^;]*infinite/, "running halo animates while active");
  // A static ring remains under reduced motion, so running never degrades to
  // a plain fill that reads like the manual pending mark.
  assert.match(halo, /box-shadow:/, "the running halo keeps a static ring");
  const reduced = reducedMotionBlocks();
  const rule = reduced
    .map((block) => containedRule(block, ".thread-item-status.running::after"))
    .find((candidate) => candidate !== null);
  assert.ok(rule, "running halo needs a prefers-reduced-motion fallback");
  assert.match(rule, /animation: none/);
});

test("idle status indicators honour reduced motion", () => {
  const blocks = reducedMotionBlocks();
  for (const selector of IDLE_INDICATORS) {
    const rule = blocks
      .map((block) => containedRule(block, selector))
      .find((candidate) => candidate !== null);
    assert.ok(rule, `${selector} needs a prefers-reduced-motion fallback`);
    assert.match(
      rule,
      /animation: none/,
      `${selector} must disable its animation under reduced motion`,
    );
  }
});
