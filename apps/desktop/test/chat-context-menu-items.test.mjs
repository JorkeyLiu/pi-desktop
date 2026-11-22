import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const t = (key) => key;
const noop = () => {};
const actions = { copyText: noop, quoteText: noop };

function loadMenuItems() {
  const file = new URL("../src/features/chat/transcript/menu-items.tsx", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file.pathname,
  });
  const imports = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "i18next": {},
    "../../../components/ContextMenu": {},
    "../../../components/icons": new Proxy({}, { get: () => () => null }),
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked menu-item dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const { selectedTextMenuItems } = loadMenuItems();

const ids = (items) => items.map((item) => item.id);

test("the selected-text menu offers only copy and quote", () => {
  const items = selectedTextMenuItems({ t, actions });
  assert.deepEqual(ids(items), ["copy", "quote"]);
  assert.equal(items.find((item) => item.id === "copy").label, "chat.copy");
  assert.equal(items.find((item) => item.id === "quote").label, "chat.quote");
  for (const item of items) {
    assert.equal(item.separatorBefore, undefined);
    assert.equal(item.danger, undefined);
    assert.equal(item.disabled, undefined);
  }
});

test("copy carries the exact live selection, whitespace included", () => {
  const copied = [];
  const copyActions = {
    copyText: (selection) => copied.push(selection),
    quoteText: noop,
  };
  const items = selectedTextMenuItems({ t, actions: copyActions });
  items.find((item) => item.id === "copy").onSelect("  this line  ");
  assert.deepEqual(copied, ["  this line  "]);
});

test("quote carries the exact live selection to the composer path", () => {
  const quoted = [];
  const quoteActions = {
    copyText: noop,
    quoteText: (selection) => quoted.push(selection),
  };
  const items = selectedTextMenuItems({ t, actions: quoteActions });
  items.find((item) => item.id === "quote").onSelect("only this phrase");
  assert.deepEqual(quoted, ["only this phrase"]);
});
