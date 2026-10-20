import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import test from "node:test";

// Only Electron is replaced; the quit handler under test uses its production
// wiring. No user profile is opened by this test.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") return { url: "test:electron", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:electron") return {
      format: "module", shortCircuit: true,
      source: `import { EventEmitter } from "node:events";
        export const app = new EventEmitter();
        app.quit = () => {};
        export const globalShortcut = { unregister() {} };`,
    };
    return next(url, context);
  },
});
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { app } = await import("electron");
const { registerShutdownHandlers } = await import("../electron/main/bootstrap/shutdown.ts");

function createHarness({ sessionIds = [], confirm = true, installingUpdate = false } = {}) {
  const activeTurns = new Map(sessionIds.map((id, index) => [id, `turn-${index}`]));
  const calls = { confirm: 0, quit: 0 };
  const state = {
    shutdownComplete: false, shutdownPromise: null, quitting: false,
    quitConfirmed: false, closeBehavior: "quit", tray: null,
    pluginLauncherAccelerator: null, toggleWindowAccelerator: null,
  };
  const noop = () => undefined;
  const asyncNoop = async () => undefined;
  app.quit = () => { calls.quit += 1; };
  registerShutdownHandlers({
    hasSingleInstanceLock: true, state,
    getHost: () => null,
    // The production quit path aborts through the sidecar, whose terminal
    // events settle the turns. The stub settles them the same way.
    getSidecar: () => ({ call: async () => { activeTurns.clear(); }, dispose: asyncNoop }),
    getMcpControl: () => null, activeTurns,
    hasRunningSessions: () => activeTurns.size > 0,
    persistenceOutbox: { size: () => 0, flush: asyncNoop },
    inflightCheckpointer: {
      observe() {}, flush: asyncNoop, flushAll: asyncNoop, settleIf() {}, dispose() {},
    },
    flushEventPersistence: asyncNoop,
    pluginPanels: { closeAll: asyncNoop },
    plugins: { disposeAll: asyncNoop }, userMcp: { disposeAll: noop },
    browserHost: { dispose: noop }, pluginViews: { dispose: asyncNoop },
    updater: { dispose: noop, isInstallingUpdate: () => installingUpdate },
    logger: { app: noop },
    confirmQuitDialog: async () => { calls.confirm += 1; return confirm; },
    disposePowerSaveBlockers: noop,
  });
  return { state, calls, activeTurns };
}

async function emitQuit() {
  app.emit("before-quit", { preventDefault() {} });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("idle quit exits directly without a confirmation dialog", async (t) => {
  const { state, calls } = createHarness({ sessionIds: [] });
  t.after(() => app.removeAllListeners());
  await emitQuit();
  assert.equal(calls.confirm, 0, "no session is running, so no dialog may appear");
  assert.equal(state.quitting, true);
  assert.ok(state.shutdownPromise, "the ordered shutdown must start immediately");
  await state.shutdownPromise;
  assert.equal(state.shutdownComplete, true);
});

test("a running background session triggers the quit confirmation", async (t) => {
  // The gate reads every live turn, not the selected tab: a background
  // session alone must still prompt.
  const { state, calls } = createHarness({
    sessionIds: ["background-session", "another-session"],
    confirm: false,
  });
  t.after(() => app.removeAllListeners());
  await emitQuit();
  assert.equal(calls.confirm, 1, "active work in any session must prompt");
  assert.equal(state.quitting, false, "cancel must not start the shutdown");
  assert.equal(state.shutdownPromise, null);
  assert.equal(state.quitConfirmed, false, "cancel must allow a later quit to prompt again");
  assert.equal(calls.quit, 0, "cancel must not relaunch the quit");
});

test("confirming the dialog quits through the ordered shutdown", async (t) => {
  const { state, calls } = createHarness({ sessionIds: ["session"], confirm: true });
  t.after(() => app.removeAllListeners());
  await emitQuit();
  assert.equal(calls.confirm, 1);
  assert.equal(calls.quit, 1, "confirm must re-enter the quit");
  // Electron re-emits before-quit for the confirmed quit.
  await emitQuit();
  assert.equal(calls.confirm, 1, "the confirmed quit must not prompt again");
  assert.equal(state.quitting, true);
  await state.shutdownPromise;
  assert.equal(state.shutdownComplete, true);
});

test("a second quit while shutting down is ignored", async (t) => {
  const { state, calls } = createHarness({ sessionIds: [] });
  t.after(() => app.removeAllListeners());
  await emitQuit();
  const first = state.shutdownPromise;
  assert.ok(first);
  app.emit("before-quit", { preventDefault() {} });
  assert.equal(state.shutdownPromise, first, "reentrant quit must join, not restart");
  assert.equal(calls.confirm, 0);
  await first;
});

test("an update restart skips confirmation even with running sessions", async (t) => {
  const { state, calls } = createHarness({ sessionIds: ["session"], installingUpdate: true });
  t.after(() => app.removeAllListeners());
  await emitQuit();
  assert.equal(calls.confirm, 0, "the spawned installer aborts if the quit waits on a dialog");
  assert.equal(state.quitting, true);
  await state.shutdownPromise;
});

test("automated probe mode skips confirmation even with running sessions", async (t) => {
  process.env.PI_DESKTOP_BOOT_PROBE = "1";
  t.after(() => {
    delete process.env.PI_DESKTOP_BOOT_PROBE;
    app.removeAllListeners();
  });
  const { state, calls } = createHarness({ sessionIds: ["session"] });
  await emitQuit();
  assert.equal(calls.confirm, 0, "no human is present to answer the dialog");
  assert.equal(state.quitting, true);
  await state.shutdownPromise;
});
