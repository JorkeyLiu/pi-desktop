/**
 * Host restart against a live agent turn (integration, real host-core process).
 *
 * host-core marks every turn that was running when the previous process died
 * `aborted` while it boots (`boot_maintenance`), so the replacement host refuses
 * anything that turn-scopes: a `TodoWrite` from the run that was live during the
 * crash comes back `TOOL_TURN_CANCELLED`. The agent run itself lives in the
 * sidecar, which stays up across a host restart — so whoever owns the host
 * process also owes that interrupted turn a decision: stop the run and settle the
 * turn, or leave an agent that looks alive writing into a turn the host no longer
 * has.
 *
 * These cases drive the real host-core child (spawned, SIGKILLed, respawned by
 * the real supervisor) through the real host runtime, turn coordination and turn
 * finalizer. Only the sidecar is a boundary double, so the test can see exactly
 * which turn identity the host tells it to stop.
 *
 * Run: node --test apps/desktop/test/host-restart-turn-settlement.test.mjs
 * Needs a built host-core (`cargo build -p host-core`), or PI_DESKTOP_HOST_BIN.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createHostRuntime } = await import("../electron/main/runtime/host.ts");
const { createPlanRuntime } = await import("../electron/main/runtime/plans.ts");
const { createRuntimeLifecycle } = await import("../electron/main/runtime/lifecycle.ts");
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);

const exe = process.platform === "win32" ? ".exe" : "";
const repoRoot = join(here, "..", "..", "..");
const hostBinary =
  [process.env.PI_DESKTOP_HOST_BIN, join(repoRoot, "target", "debug", `pi-desktop-host-core${exe}`), join(repoRoot, "target", "release", `pi-desktop-host-core${exe}`)].find(
    (candidate) => typeof candidate === "string" && candidate.length > 0 && existsSync(candidate),
  ) ?? null;
if (hostBinary && !process.env.PI_DESKTOP_HOST_BIN) process.env.PI_DESKTOP_HOST_BIN = hostBinary;
const missingHost = hostBinary
  ? false
  : "host-core binary not built (cargo build -p host-core) and PI_DESKTOP_HOST_BIN is unset";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The loopback relay URL host-core accepts as its system-proxy route: an
 * internal SOCKS5 credential plus a non-zero loopback port. Nothing in this
 * test proxies outward, so the port never has to answer.
 */
const RELAY_URL = `socks5://system-auto:${"0".repeat(64)}@127.0.0.1:1`;

/** Poll until `predicate` is truthy; fails the test with `what` when it never is. */
async function until(predicate, what, budgetMs = 15_000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - startedAt > budgetMs) assert.fail(`timed out waiting until ${what}`);
    await sleep(25);
  }
}

const todoWrite = (sessionId, turnId, content) => ({
  sessionId,
  turnId,
  toolCallId: `todo-${Math.random().toString(36).slice(2)}`,
  toolName: "TodoWrite",
  args: { todos: [{ content, status: "pending" }] },
  mode: "agent",
});

/**
 * The production host supervision wiring with one double at the sidecar
 * boundary, plus recorded renderer traffic and log lines.
 */
function createHarness(options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-host-restart-"));
  const events = [];
  const logs = [];
  const sidecarCalls = [];
  const hostLinks = [];
  const activeTurns = new Map();
  const runtimeState = { host: null, sidecar: null };
  const approvedExecutionIdsBySession = new Map();
  const claimedExecutionSessions = new Map();
  const state = { quitting: false };

  const logger = {
    app: (area, level, message, details) => logs.push({ area, level, message, details }),
    flushChild: () => {},
    child: () => () => {},
  };
  const sendToRenderer = (channel, payload) => events.push({ channel, payload });
  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });
  const plans = createPlanRuntime({
    runtimeState,
    planState: { approvedExecutionDrain: null },
    logger,
    sendToRenderer,
    coordination,
    scheduledRunsBySession: new Map(),
    activeToolCalls: new Map(),
    planSubmissionTurnIds: new Set(),
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    approvedExecutionTurns: new Map(),
    startedApprovedExecutions: new Set(),
    finishedApprovedExecutions: new Set(),
    dispatchingApprovedExecutions: new Set(),
    inFlightExecutionFinishes: new Set(),
    pendingExecutionFinishes: new Map(),
    announceTurnEnded: (payload) => events.push({ channel: "turnEnded", payload }),
    emitAgentEvent: () => {},
    acquireSessionOperation: coordination.acquireSessionOperation,
    resolveAgentRuntimeLaunch: async () => ({}),
    isQuitting: () => state.quitting,
  });

  let lifecycle = null;
  // The supervisor's own start path. `bootBackends` calls `startHost` directly,
  // so every call arriving here is a restart.
  const supervisedStartHost = async () => {
    if (options.failHostRestart) throw new Error("host cannot come back");
    await hostRuntime.startHost();
  };
  const hostRuntime = createHostRuntime({
    runtimeState,
    dataDir,
    logger,
    persistenceOutbox: { flush: async () => {}, size: () => 0 },
    activeToolCalls: new Map(),
    activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
    sessionProjects: new Map(),
    plugins: { getTools: () => [], drainToasts: () => [] },
    userMcp: { callTool: async () => null },
    pluginActiveInProject: () => false,
    sendToRenderer,
    emitAgentEvent: () => {},
    togglePluginLauncher: async () => {},
    finishTurn: plans.finishTurn,
    finishApprovedExecution: plans.finishApprovedExecution,
    isTurnDispatchable: coordination.isTurnDispatchable,
    activeTurns,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    importLegacyScheduled: async () => {},
    superviseRestart: (kind) => lifecycle.superviseRestart(kind),
    isQuitting: () => state.quitting,
    ensureSystemProxyRelay: async () => RELAY_URL,
  });
  runtimeState.sidecar = {
    call: async (method, params) => {
      sidecarCalls.push({ method, params });
      if (method === "agent.abort") return { ok: true, aborted: true };
      return {};
    },
    setHost: (host) => hostLinks.push(host),
  };
  lifecycle = createRuntimeLifecycle({
    runtimeState,
    dataDir,
    logger,
    sendToRenderer,
    startHost: supervisedStartHost,
    startSidecar: async () => {},
    drainApprovedPlanExecutions: async () => {},
    applyNetworkProxyFromAppSettings: async () => {},
    plugins: { setServices: () => {} },
    rememberPluginScopes: () => {},
    refreshUserMcp: async () => {},
    isQuitting: () => state.quitting,
    getDisplayLocale: () => "en",
  });

  return {
    dataDir,
    events,
    logs,
    sidecarCalls,
    hostLinks,
    activeTurns,
    runtimeState,
    state,
    coordination,
    hostRuntime,
    lifecycle,
    /** Open a session and its live turn, as a prompt would. */
    async startTurn() {
      const host = runtimeState.host;
      const created = await host.call("session.create", {});
      const sessionId = created.session.id;
      const { turnId } = await host.call("session.beginTurn", { sessionId });
      activeTurns.set(sessionId, turnId);
      return { host, sessionId, turnId };
    },
    /** SIGKILL the host the way the supervision probe and an OOM kill do. */
    killHost(host) {
      host.child.kill("SIGKILL");
    },
    /**
     * The host the supervisor brought back after `dead`, once that restart
     * attempt is complete. The transport opens the moment the child spawns, but
     * the host answers only after its database is open, and the supervisor keeps
     * the attempt in flight until it has wired the replacement — a second kill
     * inside that window would join a loop that is already finishing.
     */
    async nextHost(dead, budgetMs = 30_000) {
      const restarted = () =>
        events.filter((event) => event.payload?.restarted === true && event.payload?.component === "host")
          .length;
      const before = restarted();
      const current = await until(
        async () => {
          const candidate = runtimeState.host;
          if (!candidate || candidate === dead) return null;
          try {
            // The child answers only after its handshake; before that the call
            // is refused, so the wait is a retrying probe rather than a sleep.
            await candidate.call("app.health");
            return candidate;
          } catch {
            return null;
          }
        },
        "a restarted host answers app.health",
        budgetMs,
      );
      await until(() => restarted() > before, "the restart attempt to finish", budgetMs);
      return current;
    },
    async dispose() {
      state.quitting = true;
      await runtimeState.host?.dispose().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("a host restart stops the run that owned the interrupted turn and settles it", { skip: missingHost }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  await harness.hostRuntime.startHost();
  const { host, sessionId, turnId } = await harness.startTurn();
  const before = await host.call("tools.execute", todoWrite(sessionId, turnId, "before the crash"));
  assert.equal(before.ok, true, "the live turn can write before the restart");

  harness.sidecarCalls.length = 0;
  harness.killHost(host);
  const restarted = await harness.nextHost(host);

  await until(() => !harness.activeTurns.has(sessionId), "the interrupted turn is released", 5_000);

  // The run that owned the dead turn is stopped with that turn's identity. The
  // session alone would also stop a turn the user started in the meantime.
  const abort = harness.sidecarCalls.find((call) => call.method === "agent.abort");
  assert.deepEqual(
    abort?.params,
    { sessionId, turnId },
    "the sidecar is told to abort the turn the host lost",
  );

  // The replacement host has already refused that turn since it booted, so a run
  // left alive would keep writing into it and see every turn-scoped tool fail.
  const after = await restarted.call("tools.execute", todoWrite(sessionId, turnId, "after the restart"));
  assert.equal(after.ok, false);
  assert.equal(after.errorCode, "TOOL_TURN_CANCELLED");

  // A new turn on the restarted host works: the session is not left busy.
  const next = await restarted.call("session.beginTurn", { sessionId });
  assert.notEqual(next.turnId, turnId);
  harness.activeTurns.set(sessionId, next.turnId);
  const fresh = await restarted.call("tools.execute", todoWrite(sessionId, next.turnId, "new turn"));
  assert.equal(fresh.ok, true, "a turn started after the restart can write");

  // The renderer learns the interrupted turn ended, once, as an abort.
  const ended = harness.events.filter(
    (event) => event.channel === "turnEnded" && event.payload.turnId === turnId,
  );
  assert.deepEqual(ended, [
    { channel: "turnEnded", payload: { sessionId, turnId, reason: "aborted" } },
  ]);
});

test("an idle host restart settles nothing and aborts no run", { skip: missingHost }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  await harness.hostRuntime.startHost();
  const host = harness.runtimeState.host;
  const created = await host.call("session.create", {});
  const sessionId = created.session.id;

  harness.sidecarCalls.length = 0;
  harness.events.length = 0;
  harness.killHost(host);
  const restarted = await harness.nextHost(host);
  assert.ok(await restarted.call("app.health"));

  assert.deepEqual(
    harness.sidecarCalls.filter((call) => call.method === "agent.abort"),
    [],
    "an idle restart stops no agent run",
  );
  assert.equal(harness.activeTurns.size, 0);
  assert.deepEqual(
    harness.events.filter((event) => event.channel === "turnEnded"),
    [],
    "an idle restart announces no turn end",
  );
  // The session is still usable: nothing about an idle restart touches it.
  const { turnId } = await restarted.call("session.beginTurn", { sessionId });
  const write = await restarted.call("tools.execute", todoWrite(sessionId, turnId, "after idle restart"));
  assert.equal(write.ok, true);
});

test("a restart that cannot come back still settles the interrupted turn", { skip: missingHost }, async (t) => {
  const harness = createHarness({ failHostRestart: true });
  t.after(() => harness.dispose());
  await harness.hostRuntime.startHost();
  const { host, sessionId, turnId } = await harness.startTurn();

  harness.killHost(host);
  await until(() => !harness.activeTurns.has(sessionId), "the interrupted turn is released", 5_000);

  assert.deepEqual(
    harness.sidecarCalls.filter((call) => call.method === "agent.abort"),
    [{ method: "agent.abort", params: { sessionId, turnId } }],
    "the run is stopped even though the replacement host never answers",
  );
  const fatal = await until(
    () => harness.events.find((event) => event.payload?.fatal === true && event.payload?.component === "host"),
    "the supervisor gives up on the host",
    15_000,
  );
  assert.equal(fatal.payload.ok, false);
  assert.equal(harness.activeTurns.has(sessionId), false, "the turn is not left looking alive");
});

test("a repeated restart stops only the turn it interrupted and stale events stay stale", { skip: missingHost }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  await harness.hostRuntime.startHost();
  const first = await harness.startTurn();
  harness.killHost(first.host);
  const second = await harness.nextHost(first.host);
  await until(() => !harness.activeTurns.has(first.sessionId), "the first turn is released", 5_000);

  const secondTurn = (await second.call("session.beginTurn", { sessionId: first.sessionId })).turnId;
  harness.activeTurns.set(first.sessionId, secondTurn);
  harness.killHost(second);
  const third = await harness.nextHost(second);
  await until(() => !harness.activeTurns.has(first.sessionId), "the second turn is released", 5_000);

  assert.deepEqual(
    harness.sidecarCalls.filter((call) => call.method === "agent.abort").map((call) => call.params),
    [
      { sessionId: first.sessionId, turnId: first.turnId },
      { sessionId: first.sessionId, turnId: secondTurn },
    ],
    "each restart stops exactly the turn it interrupted",
  );
  // A late terminal event for a dead turn cannot conclude the turn a newer one
  // now owns.
  const newest = (await third.call("session.beginTurn", { sessionId: first.sessionId })).turnId;
  harness.activeTurns.set(first.sessionId, newest);
  const terminal = (turnId) => ({
    sessionId: first.sessionId,
    turnId,
    ts: Date.now(),
    event: { type: "agent_end", message: null },
  });
  assert.equal(harness.coordination.isStaleTerminalEvent(terminal(first.turnId)), true);
  assert.equal(harness.coordination.isStaleTerminalEvent(terminal(newest)), false);
  assert.equal(await third.call("app.health").then((health) => health.ok), true);
  assert.equal(await third.call("app.health").then((health) => health.ok), true);
});
