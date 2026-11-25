/**
 * A delegation-scoped `session/get` observes the transcript the app published.
 *
 * The renderer publishes a delegate's live `Task` card before the persistence
 * outbox has appended that row to host-core, so a scoped read issued in that
 * window used to answer "no such chain". These tests drive the real IPC handler
 * and prove the ordering the fix relies on: a delegation read waits for that
 * session's outbox fence before the host read, the main transcript does not pay
 * for it, an incomplete fence is reported rather than hidden, and a fence
 * failure is reported without turning a readable session into a failure.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import * as historyScopeForward from "../electron/main/ipc/history-scope-forward.ts";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/src/protocol.ts";

function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const shared = { ErrorCodes, IPC, IPC_WHITELIST };
const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "@pi-desktop/shared": shared,
  "../importers": {},
  "./history-scope-forward": historyScopeForward,
  "../services/session-collaboration": { readSessionCollaboration: async () => ({}) },
  "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
  "../services/session-search": { searchSessionsAcrossSources: async () => ({}) },
});

const session = (id) => ({ id, title: "Conversation", messages: [], messageCount: 0 });
const fenced = { remaining: 0, paused: false, failed: 0 };

function harness({ fence } = {}) {
  const handlers = new Map();
  const calls = [];
  const logs = [];
  const fences = [];
  const host = {
    call: async (method, input) => {
      calls.push({ method, input });
      return { session: session(input.id) };
    },
  };
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    dataDir: "/tmp",
    activeTurns: new Map(),
    sessionProjects: new Map(),
    persistenceOutbox: {
      waitForSession: async (...args) => {
        fences.push(args[0]);
        return fence?.(...args) ?? fenced;
      },
      flush: async () => {},
      dropSession: async () => {},
    },
    logger: { app: (...args) => logs.push(args) },
    plugins: { broadcastEvent: () => {} },
    sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
    enrichSession: (value) => value,
    acquireSessionOperation: async () => () => {},
    stripWinLongPrefix: (value) => value,
  });
  const handle = handlers.get(IPC.invoke.sessionGet);
  assert.equal(typeof handle, "function");
  return { handle, calls, fences, logs };
}

test("a delegation-scoped read waits for its session fence before reading the host", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { handle, calls, fences } = harness({ fence: () => gate });
  const pending = handle({
    id: "session-1",
    historyScope: { kind: "delegation", id: "call-1" },
    messageLimit: 100,
  });
  assert.equal(fences.length, 1, "the delegation read waits for its own session's appends");
  assert.deepEqual(fences, ["session-1"], "the fence is scoped to the session being read");
  assert.equal(calls.length, 0, "the host read waits for the fence to finish");
  release();
  const result = await pending;
  assert.deepEqual(calls.map((entry) => entry.method), ["session.get"]);
  assert.deepEqual(calls[0].input.historyScope, { kind: "delegation", id: "call-1" });
  assert.equal(result.session.id, "session-1");
});

test("the main transcript does not pay for the delegation fence", async () => {
  const { handle, fences } = harness();
  await handle({ id: "session-1", historyScope: { kind: "main" } });
  await handle({ id: "session-1" });
  await handle({ id: "session-1", historyScope: { kind: "delegation", id: "" } });
  assert.equal(fences.length, 0, "only a resolved delegate scope is fenced");
});

test("an incomplete fence is reported and the read still answers", async () => {
  const { handle, calls, logs } = harness({
    fence: () => ({ remaining: 3, paused: true, failed: 1 }),
  });
  const result = await handle({
    id: "session-1",
    historyScope: { kind: "delegation", id: "call-1" },
  });
  assert.equal(result.session.id, "session-1", "a paused outbox is not a read failure");
  assert.deepEqual(calls.map((entry) => entry.method), ["session.get"]);
  const warn = logs.find(
    (entry) => entry[1] === "warn" && entry[2] === "scoped history outbox fence incomplete",
  );
  assert.ok(warn, "an unwritten snapshot stays diagnosable");
  assert.deepEqual(warn[3].data, { pending: 3, failed: 1, paused: true });
});

test("a fence failure is reported and the read still answers", async () => {
  const { handle, calls, logs } = harness({
    fence: async () => {
      throw new Error("outbox is not writable");
    },
  });
  const result = await handle({
    id: "session-1",
    historyScope: { kind: "delegation", id: "call-1" },
  });
  assert.equal(result.session.id, "session-1", "a fence failure is not a read failure");
  assert.deepEqual(calls.map((entry) => entry.method), ["session.get"]);
  const warn = logs.find(
    (entry) => entry[1] === "warn" && entry[2] === "scoped history outbox fence failed",
  );
  assert.ok(warn, "the fence failure stays diagnosable");
  assert.match(String(warn[3].data), /outbox is not writable/);
});
