/**
 * Real-Host end-to-end: a prompt's user row must be physically written after
 * the previous turn's rows the persistence outbox still holds.
 *
 * `scripts/e2e/host.mjs` spawns the real host-core binary in a temporary data
 * directory, and this test registers the real `agent/prompt` handler with the
 * real `PersistenceOutbox` against it. Only the sidecar (provider runtime) and
 * the launch resolution are fixtures: no provider is configured and no model
 * call is made. The physical transcript is asserted through the Host's own
 * `session.get` and then through the stopped Host's `messages` table — the
 * read path is never trusted to sort, and the rows are not reordered here.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { Host, resolveHostBinary } from "../../../../../scripts/e2e/host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "helpers", "ts-import-hooks.mjs")));

const { registerAgentIpc } = await import("../../../electron/main/ipc/agent-ipc.ts");
const { PersistenceOutbox } = await import("../../../electron/main/persistence-outbox.ts");
const { IPC, ErrorCodes } = await import("@pi-desktop/shared");

const hostBin = resolveHostBinary();
const USER_NEW_ID = "9d0b6f0e-2f3a-4a1b-9c5d-0f4e2a7b6c31";
const OLD_USER_ID = "old-user";
const OLD_ASSISTANT_ID = "old-assistant";
const OLD_TOOL_ID = "old-tool";
const codeOf = (error) => error?.code ?? error?.errorCode;
const macrotask = () => new Promise((resolve) => setImmediate(resolve));
const appendedIds = (calls) =>
  calls
    .filter((call) => call.method === "session.appendMessage")
    .map((call) => call.params.message.id);

/**
 * One real Host in a fresh data directory plus the outbox that feeds it.
 *
 * `wire.available` is the Host availability the outbox consults. Pausing it
 * while the Host process is up is the seam the production gate is built on
 * (restarting, reconnecting); it is not a user's session.
 */
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-order-e2e-"));
  const projectPath = join(dataDir, "project");
  await mkdir(projectPath, { recursive: true });
  const real = new Host(hostBin, dataDir, { quiet: true });
  await real.start();
  const wire = { available: true, methods: [] };
  const calls = [];
  const facade = {
    isAvailable: () => wire.available,
    async call(method, params) {
      wire.methods.push(method);
      calls.push({ method, params });
      return real.call(method, params);
    },
  };
  const outbox = new PersistenceOutbox(dataDir, () => {});
  t.after(async () => {
    outbox.dispose();
    await real.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });

  const created = await real.call("session.create", { projectPath, mode: "agent" });
  const sessionId = created.session.id;
  const oldTurn = await real.call("session.beginTurn", {
    sessionId,
    providerId: "fixture-provider",
    modelId: "fixture-model",
  });
  await real.call("session.appendMessage", {
    sessionId,
    turnId: oldTurn.turnId,
    message: {
      id: OLD_USER_ID,
      role: "user",
      content: "the first question",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
  await real.call("session.endTurn", {
    sessionId,
    turnId: oldTurn.turnId,
    status: "completed",
    createNotification: false,
  });

  return {
    dataDir,
    projectPath,
    real,
    wire,
    facade,
    calls,
    outbox,
    sessionId,
    oldTurnId: oldTurn.turnId,
  };
}

/** Queue the settled previous turn's rows while the outbox gate is paused. */
async function queueOlderRows(fx, { available = false } = {}) {
  fx.wire.available = available;
  await fx.outbox.enqueue(
    {
      key: `message:${fx.sessionId}:${OLD_ASSISTANT_ID}`,
      sessionId: fx.sessionId,
      message: {
        id: OLD_ASSISTANT_ID,
        role: "assistant",
        content: "the long previous reply",
        status: "complete",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      turnId: fx.oldTurnId,
    },
    () => fx.facade,
  );
  await fx.outbox.enqueue(
    {
      key: `message:${fx.sessionId}:${OLD_TOOL_ID}`,
      sessionId: fx.sessionId,
      message: {
        id: OLD_TOOL_ID,
        role: "tool",
        content: "",
        toolName: "read_file",
        toolCallId: "call-old-1",
        toolStatus: "complete",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      turnId: fx.oldTurnId,
    },
    () => fx.facade,
  );
  await macrotask();
}

/** Register the real prompt handler against the real Host and outbox. */
function promptHandler(fx, { resolveLaunch } = {}) {
  const handlers = new Map();
  const sidecarCalls = [];
  const finishTurns = [];
  registerAgentIpc({
    registrar: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      handleWithEvent(channel, handler) {
        handlers.set(channel, handler);
      },
      assertMainWindowSender() {},
    },
    getHost: () => fx.facade,
    getSidecar: () => ({
      async call(method, params) {
        sidecarCalls.push({ method, params });
        if (method === "agent.prompt") return { accepted: true, turnId: params.turnId };
        return {};
      },
      setProjectInstructionRoot() {},
    }),
    getAgentHostBridge: () => null,
    logger: { app() {} },
    agentExtensions: {},
    cancelSessionTools() {},
    persistenceOutbox: fx.outbox,
    dataDir: fx.dataDir,
    activeTurns: new Map(),
    isTurnDispatchable: () => true,
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch:
      resolveLaunch ??
      (async () => ({
        workspaceRoot: null,
        projectPath: fx.projectPath,
        providerId: "fixture-provider",
        modelId: "fixture-model",
        sidecarParams: { sessionId: fx.sessionId },
      })),
    acquireSessionOperation: async () => () => {},
    finishTurn: async (sessionId, status, errorCode, options) => {
      finishTurns.push({ sessionId, status, errorCode, turnId: options?.turnId });
    },
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
  const invoke = (request) => handlers.get(IPC.invoke.agentPrompt)(request);
  return { invoke, sidecarCalls, finishTurns };
}

const promptRequest = (sessionId) => ({
  sessionId,
  content: "next question",
  messageId: USER_NEW_ID,
  viewingSessionId: sessionId,
});

/** The stopped Host's own index: physical row order and turn ownership. */
function readPhysicalRows(dataDir, sessionId) {
  const db = new DatabaseSync(join(dataDir, "pi.sqlite"), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT seq, id, role, turn_id, text FROM messages WHERE session_id = ? ORDER BY seq")
      .all(sessionId);
    const turns = db
      .prepare("SELECT id, status, started_at FROM turns WHERE session_id = ? ORDER BY started_at, id")
      .all(sessionId);
    return { rows, turns };
  } finally {
    db.close();
  }
}

test("a real prompt writes the previous turn's queued rows before its user row", { timeout: 90_000 }, async (t) => {
  const fx = await fixture(t);
  await queueOlderRows(fx);
  const handler = promptHandler(fx);
  const baseline = fx.calls.length;

  // The gate is live again before the prompt: the preflight must drain the
  // paused rows into the real Host, then the user row follows them.
  fx.wire.available = true;
  const result = await handler.invoke(promptRequest(fx.sessionId));
  assert.equal(result.accepted, true);

  const read = await fx.real.call("session.get", { id: fx.sessionId });
  assert.deepEqual(
    read.session.messages.map((message) => message.id),
    [OLD_USER_ID, OLD_ASSISTANT_ID, OLD_TOOL_ID, USER_NEW_ID],
    "session.get keeps the physical order",
  );
  assert.equal(handler.sidecarCalls.length, 1);
  assert.equal(
    fx.calls.filter((call) => call.method === "session.beginTurn").length,
    1,
    "only the prompt opened a turn through the handler",
  );
  await fx.real.stop();
  const { rows, turns } = readPhysicalRows(fx.dataDir, fx.sessionId);
  assert.deepEqual(
    rows.map((row) => row.id),
    [OLD_USER_ID, OLD_ASSISTANT_ID, OLD_TOOL_ID, USER_NEW_ID],
    "the durable rows are ordered old rows first",
  );
  assert.equal(rows[1].turn_id, fx.oldTurnId, "the assistant row keeps its turn");
  assert.equal(rows[2].turn_id, fx.oldTurnId, "the tool row keeps its turn");
  assert.equal(rows[3].role, "user");
  assert.notEqual(rows[3].turn_id, fx.oldTurnId, "the user row belongs to the new turn");
  assert.equal(turns.length, 2, "one closed turn and one opened turn");
  assert.equal(turns.at(-1).id, rows[3].turn_id);
  assert.equal(turns.at(-1).status, "running");
  assert.equal(fx.calls.length > baseline, true);
});

test("a real row settled during launch is written before the user row", { timeout: 90_000 }, async (t) => {
  const fx = await fixture(t);
  const handler = promptHandler(fx, {
    resolveLaunch: async () => {
      // The previous turn settles while this prompt is between the preflight
      // and its user append. The outbox gate is paused, so the row stays queued
      // until the admission checkpoint.
      await queueOlderRows(fx);
      fx.wire.available = true;
      return {
        workspaceRoot: null,
        projectPath: fx.projectPath,
        providerId: "fixture-provider",
        modelId: "fixture-model",
        sidecarParams: { sessionId: fx.sessionId },
      };
    },
  });

  const result = await handler.invoke(promptRequest(fx.sessionId));
  assert.equal(result.accepted, true);
  assert.deepEqual(appendedIds(fx.calls).slice(-3), [OLD_ASSISTANT_ID, OLD_TOOL_ID, USER_NEW_ID]);
  await fx.real.stop();
  const { rows, turns } = readPhysicalRows(fx.dataDir, fx.sessionId);
  assert.deepEqual(
    rows.map((row) => row.id),
    [OLD_USER_ID, OLD_ASSISTANT_ID, OLD_TOOL_ID, USER_NEW_ID],
    "the row queued during launch precedes the user row",
  );
  assert.equal(turns.at(-1).id, rows.at(-1).turn_id);
  assert.equal(turns.at(-1).status, "running");
  assert.deepEqual(handler.finishTurns, []);
});

test("a real prompt is refused before any turn while the gate is paused", { timeout: 90_000 }, async (t) => {
  const fx = await fixture(t);
  await queueOlderRows(fx);
  const handler = promptHandler(fx);
  const baseline = fx.calls.length;

  // The real Host is up, but its availability gate is paused — the outbox
  // cannot write the previous turn's rows. Nothing may open a turn.
  await assert.rejects(handler.invoke(promptRequest(fx.sessionId)), (error) => {
    assert.equal(codeOf(error), ErrorCodes.PERSISTENCE_BACKLOG);
    return true;
  });

  const delta = fx.calls.slice(baseline).map((call) => call.method);
  assert.equal(delta.includes("session.beginTurn"), false, "no turn was opened");
  assert.equal(delta.includes("session.appendMessage"), false, "no row was appended");
  assert.equal(handler.sidecarCalls.length, 0, "no runtime was dispatched");
  assert.deepEqual(handler.finishTurns, [], "no turn needed closing");

  const read = await fx.real.call("session.get", { id: fx.sessionId });
  assert.deepEqual(read.session.messages.map((message) => message.id), [OLD_USER_ID]);
  assert.equal(fx.outbox.size(), 2, "the paused rows stay queued");
});
