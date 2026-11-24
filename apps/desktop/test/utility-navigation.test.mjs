import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createInteractionSlice } = await import("../src/stores/slices/interaction-slice.ts");
const { usePluginBrowseState } = await import("../src/features/plugins/browse-state.ts");

// Execute the actual footer handler against the real history slice. Native
// rendering and retained composer behavior are covered by the manual UI journey.
const source = ts.createSourceFile("Sidebar.tsx",
  readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = [];
function visit(node) {
  if (ts.isJsxAttribute(node) && node.name.getText(source) === "onClick" &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression?.getText(source).includes('page === "plugins"')) {
    handlers.push(node.initializer.expression.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(handlers.length, 1, "identify the Plugins footer handler uniquely");
const clickFooter = new Function("state",
  `const { page, canNavBack, navBack, setPage } = state; return (${handlers[0]})();`);

function harness(page = "chat") {
  let intents = 0;
  const selections = [];
  let state = {
    page, activeSessionId: "session-a",
    navStack: [{ page, sessionId: page === "chat" ? "session-a" : undefined }], navIndex: 0,
    selectSession: (...args) => selections.push(args),
  };
  const actions = createInteractionSlice({
    get: () => state,
    set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    runtime: { beginNavigationIntent: () => ++intents },
    interactionRuntime: {},
  });
  state = { ...state, ...actions };
  return { get: () => state, actions, selections, click: () => clickFooter(state),
    set: (patch) => { state = { ...state, ...patch }; } };
}

for (const page of ["chat", "scheduled", "settings"]) {
  test(`Plugins footer opens the window from ${page} and closes it again`, () => {
    const h = harness(page);
    h.click();
    assert.equal(h.get().page, "plugins");
    assert.equal(h.get().navStack.length, 1, "A window is not a history entry");
    assert.equal(h.get().navIndex, 0);
    h.click();
    assert.equal(h.get().page, "chat");
    assert.equal(h.get().navStack.length, 1);
    assert.equal(h.get().navIndex, 0);
    assert.deepEqual(h.selections, [], "Closing a window selects no conversation");
  });
}

test("switching destinations replaces the one window without stacking history", () => {
  const h = harness("scheduled");
  h.actions.setPage("settings");
  assert.equal(h.get().page, "settings");
  h.click();
  assert.equal(h.get().page, "plugins");
  assert.equal(h.get().navStack.length, 1);
  // History belongs to conversations alone, so while a window covers chat
  // neither direction moves the reader anywhere.
  h.actions.navForward();
  assert.equal(h.get().page, "plugins");
  h.actions.navBack();
  assert.equal(h.get().page, "plugins");
});

test("Plugins footer closes the window when it is already presented", () => {
  const h = harness("plugins");
  h.click();
  assert.equal(h.get().page, "chat");
  assert.deepEqual(h.selections, []);
});

test("plugin browsing choices survive subscribers disconnecting without retaining dialogs or operations", () => {
  const before = usePluginBrowseState.getInitialState();
  try {
    const unsubscribe = usePluginBrowseState.subscribe(() => {});
    usePluginBrowseState.getState().setTab("market");
    usePluginBrowseState.getState().setQuery("browser");
    usePluginBrowseState.getState().setInstalledQuery("local");
    usePluginBrowseState.getState().setCategory("productivity");
    unsubscribe();
    const reopened = usePluginBrowseState.getState();
    assert.equal(reopened.tab, "market");
    assert.equal(reopened.query, "browser");
    assert.equal(reopened.installedQuery, "local");
    assert.equal(reopened.category, "productivity");
    assert.deepEqual(Object.keys(reopened).filter((key) => typeof reopened[key] !== "function").sort(),
      ["category", "installedQuery", "query", "tab"]);
  } finally { usePluginBrowseState.setState(before, true); }
});
