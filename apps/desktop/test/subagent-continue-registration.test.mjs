/**
 * The continuation handler registers exactly the run the sidecar accepted —
 * and never a dead one.
 *
 * Main learns the new run id only when `agent.continueSubagent` resolves, so
 * registration happens there. An idempotent retry (`already-applied`) for a
 * run that has since settled reports `live: false`; registering it would
 * resurrect a dead run after its terminal settlement revoked it. These tests
 * drive the real `registerAgentIpc` continuation handler with a fake sidecar
 * and the real session coordination, asserting what registers, not a
 * helper's opinion of it.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);
const { IPC } = await import("@pi-desktop/shared");

const SESSION_ID = "session-1";

/** The production registration surface, replaced by a capture map. */
function harness(sidecarResponse) {
  const handlers = new Map();
  const sidecarCalls = [];
  const registered = [];
  const tracked = [];
  const activeTurns = new Map([[SESSION_ID, "parent-turn-live"]]);
  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });
  const host = {
    call: async (method) => (method === "session.get" ? { session: {} } : {}),
  };
  const sidecar = {
    call: async (method, params) => {
      sidecarCalls.push({ method, params });
      if (method === "agent.continueSubagent") return sidecarResponse;
      return {};
    },
  };
  registerAgentIpc({
    registrar: {
      ipcMain: {},
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      handleWithEvent(channel, handler) {
        handlers.set(channel, handler);
      },
      assertMainWindowSender() {},
    },
    getHost: () => host,
    getSidecar: () => sidecar,
    getAgentHostBridge: () => null,
    logger: { app() {} },
    agentExtensions: {},
    cancelSessionTools() {},
    persistenceOutbox: { size: () => 0, flush: async () => undefined },
    dataDir: join(here, "..", "..", "..", "packages", "agent-runtime", "tmp-unused"),
    activeTurns,
    isTurnDispatchable: () => true,
    registerIndependentChildRun: (sessionId, childRunId) => {
      registered.push({ sessionId, childRunId });
      coordination.registerIndependentChildRun(sessionId, childRunId);
    },
    trackPendingChildAcceptance: (sessionId, pending) => {
      tracked.push(sessionId);
      coordination.trackPendingChildAcceptance(sessionId, pending);
    },
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => undefined,
    acquireSessionOperation: async () => () => {},
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
    coordination,
    registered,
    tracked,
    sidecarCalls,
    cont: (request) => handlers.get(IPC.invoke.agentContinueSubagent)(request),
  };
}

function contRequest() {
  return { sessionId: SESSION_ID, delegationId: "del-1", content: "Keep going." };
}

test("an accepted live child registers exactly the run the sidecar accepted", async () => {
  const response = {
    accepted: true,
    delegationId: "child-new",
    turnId: "row-1",
    live: true,
  };
  const h = harness(response);

  const accepted = await h.cont(contRequest());

  assert.deepEqual(accepted, response, "the acceptance passes through unchanged");
  assert.deepEqual(h.registered, [{ sessionId: SESSION_ID, childRunId: "child-new" }]);
  assert.equal(
    h.coordination.isIndependentChildRunLive(SESSION_ID, "child-new"),
    true,
    "the accepted run dispatches its tools",
  );
  assert.deepEqual(h.tracked, [SESSION_ID], "the in-flight acceptance is published");
  assert.equal(h.coordination.pendingChildAcceptance(SESSION_ID), undefined);
});

test("a settled idempotent retry reports not-live and registers nothing", async () => {
  const response = {
    accepted: true,
    delegationId: "child-old",
    turnId: "row-0",
    live: false,
  };
  const h = harness(response);

  const accepted = await h.cont(contRequest());

  assert.deepEqual(accepted, response, "the retry receipt still passes through");
  assert.deepEqual(h.registered, [], "a dead run must never be (re-)registered");
  assert.equal(
    h.coordination.isIndependentChildRunLive(SESSION_ID, "child-old"),
    false,
    "a settled run stays revoked",
  );
});

test("an acceptance without liveness still registers, for older sidecars", async () => {
  const response = { accepted: true, delegationId: "child-legacy", turnId: "row-1" };
  const h = harness(response);

  const accepted = await h.cont(contRequest());

  assert.deepEqual(accepted, response);
  assert.deepEqual(h.registered, [{ sessionId: SESSION_ID, childRunId: "child-legacy" }]);
});
