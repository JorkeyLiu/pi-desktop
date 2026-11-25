/**
 * A new prompt must not overtake the transcript rows the previous turn still
 * had queued.
 *
 * Assistant and tool rows reach the Host through Electron's persistence
 * outbox, while a prompt's own user row is appended directly after
 * `session.beginTurn`. When the outbox is paused (host restarting, a head in
 * bounded retry), the direct append used to land before the older rows, so a
 * long finished reply was written into the transcript after the user's next
 * message. The admission fence below waits for that session's already-queued
 * appends to reach a final disposition and refuses the prompt — retryably,
 * before any turn row exists — when they have not.
 *
 * These tests drive the real `registerAgentIpc` handler with the real
 * `PersistenceOutbox` and a fake Host, so the assertion is the production
 * append order (and the production refusal), not a helper's opinion of it.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

/**
 * The renderer's own user-row id is a UUID and is retained verbatim as the
 * durable row; the handler's message id is fixed here so append order is
 * asserted by identity.
 */
const USER_NEW_ID = "9d0b6f0e-2f3a-4a1b-9c5d-0f4e2a7b6c31";

/**
 * The IPC error contract: a thrown handler error carries `errorCode`, the
 * renderer-facing error carries `code`. Read either.
 */
const codeOf = (error) => error?.code ?? error?.errorCode;

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { PersistenceOutbox } = await import("../electron/main/persistence-outbox.ts");
const { IPC, ErrorCodes } = await import("@pi-desktop/shared");

/** A macrotask boundary: one full settle, not a wait for wall-clock time. */
const macrotask = () => new Promise((resolve) => setImmediate(resolve));

function createHost() {
  const calls = [];
  const appended = [];
  let turnSeq = 0;
  const host = {
    available: true,
    /** When set, `session.appendMessage` refuses that message id with a code. */
    refuseMessage: null,
    isAvailable: () => host.available,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "settings.get") return { settings: {} };
      if (method === "session.get") {
        return { session: { id: params.id, projectPath: "/tmp/project", messages: [] } };
      }
      if (method === "session.beginTurn") {
        turnSeq += 1;
        return { turnId: `turn-${turnSeq}` };
      }
      if (method === "session.appendMessage") {
        const refused = host.refuseMessage;
        if (refused && params.message?.id === refused.id) {
          host.refuseMessage = null;
          throw Object.assign(new Error("host refused the append payload"), {
            errorCode: refused.code ?? "INVALID_PARAMS",
          });
        }
        appended.push(params.message);
        return { ok: true };
      }
      return {};
    },
  };
  return { host, calls, appended };
}

function harness({ host, outbox, sidecarCalls, resolveLaunch, events = { finishTurns: [] } }) {
  const handlers = new Map();
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
  const sidecar = {
    async call(method, params) {
      sidecarCalls.push({ method, params });
      if (method === "agent.prompt") return { accepted: true, turnId: params.turnId };
      return {};
    },
    setProjectInstructionRoot() {},
  };
  registerAgentIpc({
    registrar,
    getHost: () => host,
    getSidecar: () => sidecar,
    getAgentHostBridge: () => null,
    logger: { app() {} },
    agentExtensions: {},
    cancelSessionTools() {},
    persistenceOutbox: outbox,
    dataDir: join(here, "..", "..", "..", "packages", "agent-runtime", "tmp-unused"),
    activeTurns: new Map(),
    isTurnDispatchable: () => true,
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: resolveLaunch ?? (async () => ({
      workspaceRoot: null,
      projectPath: null,
      providerId: "test",
      modelId: "test-model",
      sidecarParams: { sessionId: "session-1" },
    })),
    acquireSessionOperation: async () => () => {},
    finishTurn: async (sessionId, status, errorCode, options) => {
      events.finishTurns.push({ sessionId, status, errorCode, turnId: options?.turnId });
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
  return (request) => handlers.get(IPC.invoke.agentPrompt)(request);
}

/** One session-scoped outbox with hand-driven retry timers. */
function createOutbox(dir) {
  const timers = [];
  const outbox = new PersistenceOutbox(dir, () => undefined, {
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return { outbox, timers };
}

/** Queue the previous turn's finished assistant row while the Host is away. */
async function queueOlderRow(outbox, host, { sessionId = "session-1", id = "old-assistant" } = {}) {
  host.available = false;
  await outbox.enqueue(
    {
      key: `message:${sessionId}:${id}`,
      sessionId,
      message: { id, role: "assistant", content: "the long previous reply" },
      turnId: "turn-old",
    },
    () => host,
  );
  await macrotask();
}

const appendedIds = (calls) =>
  calls
    .filter((call) => call.method === "session.appendMessage")
    .map((call) => call.params.message.id);

test("a prompt waits for the session's queued older rows before it appends its user row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-order-"));
  const { outbox, timers } = createOutbox(dir);
  const { host, calls, appended } = createHost();
  const sidecarCalls = [];
  const prompt = harness({ host, outbox, sidecarCalls });
  await queueOlderRow(outbox, host);
  host.available = true;

  const result = await prompt({
    sessionId: "session-1",
    content: "next question",
    messageId: USER_NEW_ID,
    viewingSessionId: "session-1",
  });
  for (const fire of timers) fire();
  await macrotask();

  assert.equal(result.accepted, true);
  assert.deepEqual(appendedIds(calls), ["old-assistant", USER_NEW_ID]);
  assert.deepEqual(
    appended.map((message) => message.role),
    ["assistant", "user"],
  );
  // The turn row is opened only after the older rows are durable.
  const beginTurnIndex = calls.findIndex((call) => call.method === "session.beginTurn");
  const oldAppendIndex = calls.findIndex(
    (call) => call.method === "session.appendMessage" && call.params.message.id === "old-assistant",
  );
  assert.ok(beginTurnIndex > oldAppendIndex, "session.beginTurn must follow the older append");
  assert.equal(sidecarCalls.length, 1);
  assert.equal(sidecarCalls[0].method, "agent.prompt");
});

test("a prompt is refused retryably while the session's queued rows are still paused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-order-"));
  const { outbox } = createOutbox(dir);
  const { host, calls, appended } = createHost();
  const sidecarCalls = [];
  const prompt = harness({ host, outbox, sidecarCalls });
  await queueOlderRow(outbox, host);
  // The Host is still away: the queue is paused, not written.

  await assert.rejects(
    prompt({
      sessionId: "session-1",
      content: "next question",
      messageId: USER_NEW_ID,
      viewingSessionId: "session-1",
    }),
    (error) => {
      assert.equal(codeOf(error), ErrorCodes.PERSISTENCE_BACKLOG);
      return true;
    },
  );

  assert.equal(calls.filter((call) => call.method === "session.beginTurn").length, 0);
  assert.deepEqual(appendedIds(calls), []);
  assert.equal(sidecarCalls.length, 0);
  assert.equal(outbox.size(), 1, "the queued row stays queued, not dropped");
});

test("a quarantined older append refuses the prompt once and never reports it saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-order-"));
  const { outbox } = createOutbox(dir);
  const { host, calls, appended } = createHost();
  const sidecarCalls = [];
  const prompt = harness({ host, outbox, sidecarCalls });
  await queueOlderRow(outbox, host);
  host.available = true;
  host.refuseMessage = { id: "old-assistant", code: "INVALID_PARAMS" };

  await assert.rejects(
    prompt({
      sessionId: "session-1",
      content: "next question",
      messageId: USER_NEW_ID,
      viewingSessionId: "session-1",
    }),
    (error) => {
      assert.equal(codeOf(error), ErrorCodes.PERSISTENCE_QUARANTINED);
      return true;
    },
  );

  assert.equal(calls.filter((call) => call.method === "session.beginTurn").length, 0);
  // The refused row was attempted once and was never stored: the fake host
  // records only successful appends in `appended`.
  assert.deepEqual(
    appended.map((message) => message.id),
    [],
  );
  assert.equal(
    calls.filter((call) => call.method === "session.appendMessage").length,
    1,
    "the quarantined row is not retried on a later admission",
  );
  const deadLetters = JSON.parse(
    await readFile(join(dir, "session-message-outbox.dead-letter.json"), "utf8"),
  );
  assert.deepEqual(
    deadLetters.map((entry) => entry.message.id),
    ["old-assistant"],
    "the refused row is retained for recovery",
  );

  // The quarantined entry is gone from the queue, so a retry proceeds — once —
  // without pretending the lost row was written.
  const retried = await prompt({
    sessionId: "session-1",
    content: "next question",
    messageId: USER_NEW_ID,
    viewingSessionId: "session-1",
  });
  assert.equal(retried.accepted, true);
  assert.deepEqual(
    appended.map((message) => message.id),
    [USER_NEW_ID],
    "only the retried user row is stored",
  );
});


test("retrying after the backlog drains appends the user row exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-order-"));
  const { outbox, timers } = createOutbox(dir);
  const { host, calls } = createHost();
  const sidecarCalls = [];
  const prompt = harness({ host, outbox, sidecarCalls });
  await queueOlderRow(outbox, host);

  await assert.rejects(
    prompt({
      sessionId: "session-1",
      content: "next question",
      messageId: USER_NEW_ID,
      viewingSessionId: "session-1",
    }),
    (error) => {
      assert.equal(codeOf(error), ErrorCodes.PERSISTENCE_BACKLOG);
      return true;
    },
  );
  assert.equal(outbox.size(), 1);

  host.available = true;
  for (const fire of timers) fire();
  await macrotask();
  assert.equal(outbox.size(), 0);

  const retried = await prompt({
    sessionId: "session-1",
    content: "next question",
    messageId: USER_NEW_ID,
    viewingSessionId: "session-1",
  });
  await macrotask();

  assert.equal(retried.accepted, true);
  assert.deepEqual(appendedIds(calls), ["old-assistant", USER_NEW_ID]);
  assert.equal(calls.filter((call) => call.method === "session.beginTurn").length, 1);
  assert.equal(sidecarCalls.length, 1);
});

test("an unrelated session's queued row does not block this prompt and is not duplicated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-order-"));
  const { outbox, timers } = createOutbox(dir);
  const { host, calls } = createHost();
  const sidecarCalls = [];
  const prompt = harness({ host, outbox, sidecarCalls });
  await queueOlderRow(outbox, host, { sessionId: "session-2", id: "other-assistant" });
  host.available = true;

  const result = await prompt({
    sessionId: "session-1",
    content: "next question",
    messageId: USER_NEW_ID,
    viewingSessionId: "session-1",
  });
  for (const fire of timers) fire();
  await macrotask();

  assert.equal(result.accepted, true);
  assert.deepEqual(appendedIds(calls), [USER_NEW_ID, "other-assistant"]);
  assert.equal(outbox.size(), 0, "both rows drained, neither repeated");
  assert.equal(calls.filter((call) => call.method === "session.beginTurn").length, 1);
});

test("a row enqueued while the fence waits is retained and does not extend it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-order-"));
  const { outbox } = createOutbox(dir);
  const { host, calls } = createHost();
  const sidecarCalls = [];
  const prompt = harness({ host, outbox, sidecarCalls });
  await queueOlderRow(outbox, host);
  host.available = true;

  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const originalCall = host.call;
  host.call = async (method, params) => {
    if (method === "session.appendMessage" && params.message?.id === "old-assistant") {
      await blocked;
    }
    return originalCall(method, params);
  };

  const pending = prompt({
    sessionId: "session-1",
    content: "next question",
    messageId: USER_NEW_ID,
    viewingSessionId: "session-1",
  });
  await macrotask();
  await outbox.enqueue(
    {
      key: "message:session-1:late-assistant",
      sessionId: "session-1",
      message: { id: "late-assistant", role: "assistant", content: "late row" },
      turnId: "turn-old",
    },
    () => host,
  );
  release();
  const result = await pending;
  await macrotask();

  assert.equal(result.accepted, true);
  const ids = appendedIds(calls);
  assert.deepEqual(
    ids.filter((id) => id === "late-assistant").length,
    1,
    "the late row is retained exactly once",
  );
  assert.ok(
    ids.indexOf("old-assistant") < ids.indexOf(USER_NEW_ID),
    "the row the fence snapshotted still precedes the user row",
  );
});

/** Run a prompt while a launch hook holds it between preflight and append. */
async function promptWithLateRow({ availableAtEnqueue, availableAtAppend }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-order-"));
  const { outbox, timers } = createOutbox(dir);
  const { host, calls, appended } = createHost();
  const sidecarCalls = [];
  const events = { finishTurns: [] };
  let release;
  const launchGate = new Promise((resolve) => {
    release = resolve;
  });
  const prompt = harness({
    host,
    outbox,
    sidecarCalls,
    events,
    resolveLaunch: async () => {
      await launchGate;
      return {
        workspaceRoot: null,
        projectPath: null,
        providerId: "test",
        modelId: "test-model",
        sidecarParams: { sessionId: "session-1" },
      };
    },
  });
  const pending = prompt({
    sessionId: "session-1",
    content: "next question",
    messageId: USER_NEW_ID,
    viewingSessionId: "session-1",
  });
  await macrotask();
  host.available = availableAtEnqueue;
  await outbox.enqueue(
    {
      key: "message:session-1:late-assistant",
      sessionId: "session-1",
      message: {
        id: "late-assistant",
        role: "assistant",
        content: "the previous turn's last settled reply",
        status: "complete",
      },
      turnId: "turn-old",
    },
    () => host,
  );
  await macrotask();
  host.available = availableAtAppend;
  release();
  return { pending, host, calls, appended, outbox, timers, sidecarCalls, events, invoke: prompt };
}

test("a row settled during launch refuses the turn at the admission checkpoint", async () => {
  // The preflight saw an empty queue; the previous turn's last row is queued
  // while this prompt is between the preflight and its user append, with the
  // Host still paused. The turn was already opened, so the refusal must close
  // it and write nothing.
  const run = await promptWithLateRow({ availableAtEnqueue: false, availableAtAppend: false });

  await assert.rejects(run.pending, (error) => {
    assert.equal(codeOf(error), ErrorCodes.PERSISTENCE_BACKLOG);
    return true;
  });

  assert.equal(run.calls.filter((call) => call.method === "session.beginTurn").length, 1);
  assert.deepEqual(appendedIds(run.calls), [], "no user row is written");
  assert.equal(run.sidecarCalls.length, 0, "no runtime dispatch");
  assert.deepEqual(
    run.events.finishTurns,
    [{ sessionId: "session-1", status: "error", errorCode: ErrorCodes.PERSISTENCE_BACKLOG, turnId: "turn-1" }],
    "the opened turn is closed through the error path",
  );
  assert.equal(run.outbox.size(), 1, "the settled row stays queued, not dropped");

  // Recovery: once the queue drains, the same prompt writes exactly one user
  // row, after the row it had to wait for.
  run.host.available = true;
  for (const fire of run.timers) fire();
  await macrotask();
  assert.equal(run.outbox.size(), 0);

  const retried = await run.invoke({
    sessionId: "session-1",
    content: "next question",
    messageId: USER_NEW_ID,
    viewingSessionId: "session-1",
  });
  await macrotask();
  assert.equal(retried.accepted, true);
  assert.deepEqual(appendedIds(run.calls), ["late-assistant", USER_NEW_ID]);
  assert.equal(run.calls.filter((call) => call.method === "session.beginTurn").length, 2);
  assert.equal(run.sidecarCalls.length, 1);
  assert.deepEqual(run.events.finishTurns.length, 1);
});

test("a row settled during launch is written before the user row, not after it", async () => {
  // Same ordering hazard, but the gate is live again before admission: the
  // checkpoint must drain the older row instead of refusing.
  const run = await promptWithLateRow({ availableAtEnqueue: false, availableAtAppend: true });

  const result = await run.pending;

  assert.equal(result.accepted, true);
  assert.deepEqual(appendedIds(run.calls), ["late-assistant", USER_NEW_ID]);
  assert.equal(run.calls.filter((call) => call.method === "session.beginTurn").length, 1);
  assert.equal(run.sidecarCalls.length, 1);
  assert.deepEqual(run.events.finishTurns, []);
});
