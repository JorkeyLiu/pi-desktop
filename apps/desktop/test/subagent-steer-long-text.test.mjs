/**
 * Steering a live child carries the user's own text.
 *
 * The main-process handler is the outermost validator for a child steer, so the
 * check is driven through the real `registerAgentIpc` registration surface: a
 * fake registrar captures the actual handler, a fake sidecar records exactly
 * what crossed the RPC boundary. Nothing else is stubbed below the handler, so
 * what these tests assert is the payload production code would send, not a
 * helper's opinion of it.
 *
 * A steer is free-form child input: no length cap applies, while the
 * structural guards (identifiers, a non-empty input, turn ownership) stay.
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

/** Markers at the beginning, middle, and end of a steer no cap may clip. */
function steerText() {
  return [
    "STEER-HEAD: also check the escape handler in PermissionDialog.tsx.",
    "steer detail with a path and a line number. ".repeat(1_000),
    "STEER-MIDDLE: the props stay unchanged.",
    "astral marker \u{1F642} and CJK marker \u{4EA4}\u{63A5} ".repeat(500),
    "STEER-TAIL: report the exact line before you finish.",
  ].join("\n");
}

/** The production registration surface, replaced by a capture map. */
function harness() {
  const handlers = new Map();
  const calls = [];
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
    call: async (method) => (method === "session.get" ? { session: {} } : {}),
  };
  const sidecar = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "agent.steerSubagent") {
        return { accepted: true, delegationId: params.delegationId, turnId: params.expectedTurnId };
      }
      if (method === "agent.steeringContext") {
        return { projectPath: undefined };
      }
      return {};
    },
  };
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
    activeTurns: new Map(),
    isTurnDispatchable: () => true,
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
    calls,
    steer: (request) => handlers.get(IPC.invoke.agentSteerSubagent)(request),
  };
}

test("an over-long steer crosses the main-process boundary unchanged", async () => {
  const { calls, steer } = harness();
  const content = steerText();
  // Comfortably past the retired 20000-character payload check.
  assert.ok(content.length > 60_000);
  const accepted = await steer({
    sessionId: "session-1",
    delegationId: "del-1",
    expectedTurnId: "parent-turn",
    content,
  });

  assert.deepEqual(accepted, {
    accepted: true,
    delegationId: "del-1",
    turnId: "parent-turn",
  });
  const dispatched = calls.filter((call) => call.method === "agent.steerSubagent");
  assert.equal(dispatched.length, 1, "one steer is one RPC dispatch");
  // The child receives the user's whole text: every authored character, no cut.
  assert.equal(dispatched[0].params.content, content);
  assert.ok(dispatched[0].params.content.startsWith("STEER-HEAD"));
  assert.ok(dispatched[0].params.content.includes("STEER-MIDDLE"));
  assert.ok(dispatched[0].params.content.includes("STEER-TAIL"));
  assert.match(dispatched[0].params.content, /astral marker/);
});

test("empty text and unbounded identifiers are still refused", async () => {
  const { calls, steer } = harness();
  await assert.rejects(
    () =>
      steer({
        sessionId: "session-1",
        delegationId: "del-1",
        expectedTurnId: "parent-turn",
        content: "   \n ",
      }),
    (error) => error?.errorCode === "INVALID_ARGUMENT",
  );
  // A long-but-empty payload is still empty: length never substitutes for text.
  await assert.rejects(
    () =>
      steer({
        sessionId: "session-1",
        delegationId: "del-1",
        expectedTurnId: "parent-turn",
        content: " ".repeat(30_000),
      }),
    (error) => error?.errorCode === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    () =>
      steer({
        sessionId: "session-1",
        delegationId: "d".repeat(129),
        expectedTurnId: "parent-turn",
        content: "go",
      }),
    (error) => error?.errorCode === "INVALID_ARGUMENT",
  );
  // The steer handler bounds the delegation id it dispatches under; a turn id
  // is validated as ownership (staleness), not by length, and that stays as is.
  // Nothing crossed the RPC boundary: a refusal happens before dispatch.
  assert.equal(calls.length, 0);
});
