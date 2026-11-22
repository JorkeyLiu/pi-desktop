import assert from "node:assert/strict";
import test from "node:test";
import { placeContextMenu } from "../src/lib/context-menu.ts";

test("a menu that fits the viewport stays at the pointer", () => {
  assert.deepEqual(
    placeContextMenu({ x: 120, y: 80 }, { width: 184, height: 160 }, { width: 800, height: 600 }),
    { left: 120, top: 80 },
  );
});

test("a menu near the far edge clamps inside the viewport margin", () => {
  assert.deepEqual(
    placeContextMenu({ x: 790, y: 590 }, { width: 184, height: 160 }, { width: 800, height: 600 }),
    { left: 608, top: 432 },
  );
});

test("a surface larger than the viewport still stays reachable at the margin", () => {
  assert.deepEqual(
    placeContextMenu({ x: 400, y: 300 }, { width: 900, height: 700 }, { width: 800, height: 600 }),
    { left: 8, top: 8 },
  );
});
