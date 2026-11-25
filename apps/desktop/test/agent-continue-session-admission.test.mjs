/**
 * A continued subagent run keeps the session's own-operation admission until
 * the sidecar has accepted it.
 *
 * `agent.continueSubagent` is serialized with prompts: the user's continuation
 * is an ordinary independent run, so the admission is what keeps a main prompt
 * from starting while the child run is still being registered. Releasing it
 * before the sidecar answered would let a prompt begin in the window between
 * dispatch and acceptance and make the next parent turn busy under it.
 *
 * These tests drive the real `registerAgentIpc` handler with a fake registrar
 * and a deferred sidecar, so the assertion is the production release order, not
 * a helper's opinion of it.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

/** Resolve/reject one deferred by hand; no clock, no sleep. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness({ activeTurn = false } = {}) {
  const handlers = new Map();
  const log = [];
  const replies = [];
  const registrar = {
    ipcMain: {},
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    handleWithEvent(channel, handler) {
      handlers.set(channel, handler);
    },
    assertMainWindowSender() {},
  };
  const host = {
    call: async (method) => {
      if (method === "session.get") {
        return { session: { id: "session-1", projectPath: "/tmp/project" } };
      }
      if (method === "settings.get") {
        return { settings: {} };
      }
      return {};
    },
  };
  const sidecar = {
    call(method) {
      assert.equal(method, "agent.continueSubagent");
      const reply = deferred();
      replies.push(reply);
      log.push("dispatch");
      return reply.promise.then(
        (value) => {
          log.push("accepted");
          return value;
        },
        (error) => {
          log.push("rejected");
          throw error;
        },
      );
    },
    setProjectInstructionRoot() {},
  };
  const activeTurns = new Map();
  if (activeTurn) activeTurns.set("session-1", "parent-turn");
  registerAgentIpc({
    registrar,
    getHost: () => host,
    getSidecar: () => sidecar,
    getAgentHostBridge: () => null,
    logger: { app() {} },
    agentExtensions: {},
    cancelSessionTools() {},
    persistenceOutbox: {},
    dataDir: join(here, "..", "..", "..", "packages", "agent-runtime", "tmp-unused"),
    activeTurns,
    isTurnDispatchable: () => true,
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({
      workspaceRoot: null,
      projectPath: null,
      sidecarParams: { sessionId: "session-1" },
    }),
    acquireSessionOperation: async () => {
      log.push("acquired");
      return () => log.push("released");
    },
    finishTurn: async () => undefined,
    lockAbortReason() {},
    finishApprovedExecution: async () => undefined,
    dispatchApprovedPlan: async () => undefined,
    dispatchExecutionForProposal: async () => undefined,
    emitAgentEvent() {},
    setNotificationViewingSessionId() {},
    optionalWorkspaceRoot: async () => null,
    composerCommandService: { buildComposerCommands: async () => [] },
    loadComposerTemplatesCached: async () => [],
  });
  return {
    log,
    reply: () => replies.at(-1),
    continueSubagent: (request) => handlers.get(IPC.invoke.agentContinueSubagent)(request),
  };
}

const request = {
  sessionId: "session-1",
  delegationId: "del-1",
  content: "keep going",
};

/** Wait until the handler has actually dispatched, without sleeping. */
async function dispatched(h) {
  for (let turn = 0; turn < 64; turn += 1) {
    if (h.log.includes("dispatch")) return;
    await Promise.resolve();
  }
  assert.fail("continuation was never dispatched");
}

test("a live-parent continuation keeps admission until the child accepts it", async () => {
  const h = harness({ activeTurn: true });
  const pending = h.continueSubagent(request);
  await dispatched(h);
  // The sidecar has the request and has not answered: the session stays held.
  assert.deepEqual(h.log, ["acquired", "dispatch"]);
  h.reply().resolve({ accepted: true, delegationId: "del-1", turnId: "child-run" });
  await pending;
  // Admission is released only after acceptance, and exactly once.
  assert.deepEqual(h.log, ["acquired", "dispatch", "accepted", "released"]);
});

test("an idle continuation keeps admission across its launch reads until acceptance", async () => {
  const h = harness();
  const pending = h.continueSubagent(request);
  await dispatched(h);
  // settings.get/session.get/resolve already ran; nothing released them.
  assert.deepEqual(h.log, ["acquired", "dispatch"]);
  h.reply().resolve({ accepted: true, delegationId: "del-1", turnId: "child-run" });
  await pending;
  assert.deepEqual(h.log, ["acquired", "dispatch", "accepted", "released"]);
});

test("a rejected continuation still releases admission after the rejection", async () => {
  const h = harness();
  const pending = h.continueSubagent(request);
  await dispatched(h);
  assert.deepEqual(h.log, ["acquired", "dispatch"]);
  const failure = Object.assign(new Error("child refused the continuation"), {
    errorCode: "TURN_NOT_FOUND",
  });
  h.reply().reject(failure);
  await assert.rejects(() => pending, (error) => error === failure);
  assert.deepEqual(h.log, ["acquired", "dispatch", "rejected", "released"]);
});
