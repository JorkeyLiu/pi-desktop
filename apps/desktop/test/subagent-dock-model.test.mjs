/**
 * The running-subagent dock's model, against the transcript's own projection.
 *
 * Every case is built from real `UiMessage` rows and read back through
 * `getTranscriptProjection`, so the assertions are about the same live set and
 * the same delegation statuses the transcript renders — not about a parallel
 * interpretation of the runtime.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));

const AT = "2026-10-13T00:00:00.000Z";

function message(id, role, content, extra = {}) {
  return { id, role, content, createdAt: AT, ...extra };
}

function user(id, content = "go") {
  return message(id, "user", content);
}

function assistant(id, content) {
  return message(id, "assistant", content);
}

function task(
  id,
  callId,
  { delegationId, status = "running", agent = "explorer", description, startedAt = 1_000, toolStatus, resume, metrics } = {},
) {
  const settled = status !== "running";
  return message(id, "tool", "", {
    toolName: "Task",
    toolCallId: callId,
    toolStatus: toolStatus ?? (delegationId ? "success" : "running"),
    toolArgs: {
      agent,
      task: "long brief that must never be a title",
      ...(description ? { description } : {}),
      ...(resume ? { resume } : {}),
    },
    ...(delegationId
      ? {
          toolResult: {
            details: {
              delegationId,
              agent,
              status,
              startedAt,
              ...(settled ? { completedAt: startedAt + 5_000 } : {}),
              ...(metrics ?? {}),
            },
          },
        }
      : {}),
  });
}

function lifecycle(id, toolName, entries, { stopped = false } = {}) {
  return message(id, "tool", "", {
    toolName,
    toolCallId: `lifecycle-${id}`,
    toolStatus: "success",
    toolArgs: {},
    toolResult: {
      details: stopped ? { stopped: entries } : { delegations: entries, status: "wakeup" },
    },
  });
}

async function setup() {
  const server = await createServer({
    root,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const model = await server.ssrLoadModule(
    "/src/features/chat/composer/subagent-dock-model.ts",
  );
  const { getTranscriptProjection } = await server.ssrLoadModule(
    "/src/lib/transcript-projection.ts",
  );
  const dock = (messages, running = true) => {
    const projection = getTranscriptProjection(messages);
    return model.collectDockSubagents({
      messages,
      history: projection.history,
      tail: projection.entries.at(-1),
      running,
    });
  };
  return { server, model, dock };
}

test("two live dispatch turns list one row per running child, in transcript order", async () => {
  const { server, dock } = await setup();
  try {
    const rows = dock([
      user("u1"),
      assistant("a1", "Reviewing the auth flow."),
      task("t1", "call-1", { delegationId: "d1", description: "Review auth flow" }),
      assistant("a2", "Auditing dependencies in parallel."),
      task("t2", "call-2", {
        delegationId: "d2",
        agent: "auditor",
        description: "Audit dependencies",
      }),
    ]);
    assert.deepEqual(
      rows.map((row) => [row.delegationId, row.title, row.role]),
      [
        ["d1", "Review auth flow", "explorer"],
        ["d2", "Audit dependencies", "auditor"],
      ],
    );
    assert.equal(rows[0].creating, false);
    assert.equal(rows[0].startedAt, 1_000);
  } finally {
    await server.close();
  }
});

test("a background child stays listed after its parent turn ended", async () => {
  const { server, dock } = await setup();
  try {
    const rows = dock([
      user("u1"),
      assistant("a1", "Delegating the audit."),
      task("t1", "call-1", { delegationId: "d1", description: "Audit dependencies" }),
      assistant("a2", "Waiting for the audit to report."),
    ]);
    assert.deepEqual(rows.map((row) => row.delegationId), ["d1"]);
  } finally {
    await server.close();
  }
});

test("a finished dispatch turn does not relabel its children live in a newer turn", async () => {
  const { server, dock } = await setup();
  try {
    const rows = dock([
      user("u1"),
      assistant("a1", "Delegating the audit."),
      task("t1", "call-1", { delegationId: "d1" }),
      assistant("a2", "Audit is still running."),
      user("u2", "now review the auth flow"),
      assistant("a3", "Reviewing the auth flow."),
      task("t2", "call-2", { delegationId: "d2", description: "Review auth flow" }),
    ]);
    assert.deepEqual(rows.map((row) => row.delegationId), ["d2"]);
  } finally {
    await server.close();
  }
});

test("wait lifecycle settles one child and keeps the other", async () => {
  const { server, dock } = await setup();
  try {
    const rows = dock([
      user("u1"),
      assistant("a1", "Delegating both."),
      task("t1", "call-1", { delegationId: "d1" }),
      task("t2", "call-2", { delegationId: "d2" }),
      lifecycle("w1", "TaskWait", [
        { delegationId: "d1", agent: "explorer", status: "completed" },
        { delegationId: "d2", agent: "auditor", status: "running" },
      ]),
    ]);
    assert.deepEqual(rows.map((row) => row.delegationId), ["d2"]);
  } finally {
    await server.close();
  }
});

test("TaskStop settles the stopped id only", async () => {
  const { server, dock } = await setup();
  try {
    const rows = dock([
      user("u1"),
      assistant("a1", "Delegating both."),
      task("t1", "call-1", { delegationId: "d1" }),
      task("t2", "call-2", { delegationId: "d2" }),
      lifecycle(
        "s1",
        "TaskStop",
        [{ delegationId: "d1", agent: "explorer", status: "running" }],
        { stopped: true },
      ),
    ]);
    assert.deepEqual(rows.map((row) => row.delegationId), ["d2"]);
  } finally {
    await server.close();
  }
});

test("a terminal Task snapshot outranks an older running lifecycle row", async () => {
  const { server, dock } = await setup();
  try {
    const rows = dock([
      user("u1"),
      assistant("a1", "Delegating."),
      lifecycle("w0", "TaskWait", [
        { delegationId: "d1", agent: "explorer", status: "running" },
      ]),
      task("t1", "call-1", { delegationId: "d1", status: "completed" }),
    ]);
    assert.deepEqual(rows, []);
  } finally {
    await server.close();
  }
});

test("a resumed chain is one row, keeping the original description", async () => {
  const { server, dock } = await setup();
  try {
    const rows = dock([
      user("u1"),
      assistant("a1", "Delegating."),
      task("t1", "call-1", { delegationId: "d1", description: "Investigate the cache" }),
      lifecycle("w1", "TaskWait", [
        { delegationId: "d1", agent: "explorer", status: "completed" },
      ]),
      assistant("a2", "Continuing it."),
      task("t2", "call-2", {
        delegationId: "d2",
        description: "Continue: check the eviction path",
        resume: "d1",
      }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delegationId, "d2");
    assert.equal(rows[0].title, "Investigate the cache");
  } finally {
    await server.close();
  }
});

test("a Task before its handle lands is a creating row with no id", async () => {
  const { server, dock } = await setup();
  try {
    const rows = dock([
      user("u1"),
      assistant("a1", "Delegating."),
      message("t1", "tool", "", {
        toolName: "Task",
        toolCallId: "call-1",
        toolStatus: "running",
        toolArgs: { agent: "explorer" },
      }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delegationId, undefined);
    assert.equal(rows[0].creating, true);
    assert.equal(rows[0].title, "explorer");
    assert.equal(rows[0].key, "call:call-1");
    assert.equal(rows[0].startedAt, Date.parse(AT));
  } finally {
    await server.close();
  }
});

test("settled outcomes never list: completed, failed, stopped, timed out, interrupted", async () => {
  const { server, dock } = await setup();
  try {
    for (const status of ["completed", "failed", "stopped", "timed_out", "interrupted", "aborted", "denied"]) {
      const rows = dock([
        user("u1"),
        assistant("a1", "Delegating."),
        task("t1", "call-1", { delegationId: "d1", status }),
      ]);
      assert.deepEqual(rows, [], `${status} must not be a running row`);
    }
  } finally {
    await server.close();
  }
});

test("a reloaded session lists nothing: leftover running rows are not live", async () => {
  const { server, dock } = await setup();
  try {
    const messages = [
      user("u1"),
      assistant("a1", "Delegating."),
      task("t1", "call-1", { delegationId: "d1" }),
    ];
    assert.deepEqual(dock(messages, false), []);
    // The same rows read as live only while the session run is the live one.
    assert.deepEqual(dock(messages, true).map((row) => row.delegationId), ["d1"]);
  } finally {
    await server.close();
  }
});

test("switching to a settled session lists nothing", async () => {
  const { server, dock } = await setup();
  try {
    const settled = [
      user("u1"),
      assistant("a1", "Delegated."),
      task("t1", "call-1", { delegationId: "d1", status: "completed" }),
      assistant("a2", "Done."),
    ];
    assert.deepEqual(dock(settled, false), []);
    assert.deepEqual(dock(settled, true), []);
  } finally {
    await server.close();
  }
});

test("elapsed time is measured from the row's own start", async () => {
  const { server, model } = await setup();
  try {
    assert.equal(
      model.dockSubagentDuration({ key: "k", title: "t", role: "r", creating: false, startedAt: 1_000 }, 6_500),
      5_500,
    );
    assert.equal(
      model.dockSubagentDuration({ key: "k", title: "t", role: "r", creating: false }, 6_500),
      undefined,
    );
  } finally {
    await server.close();
  }
});

test("a running child shows the turns and context occupancy the runtime reported", async () => {
  const { server, dock } = await setup();
  try {
    const rows = dock([
      user("u1"),
      assistant("a1", "Delegating."),
      task("t1", "call-1", {
        delegationId: "d1",
        description: "Review auth flow",
        metrics: { turns: 3, toolCalls: 5, contextTokens: 41_200, usage: { totalTokens: 8_400 } },
      }),
    ]);
    assert.deepEqual(rows[0].metrics, {
      turns: 3,
      toolCalls: 5,
      contextTokens: 41_200,
      usage: { totalTokens: 8_400 },
    });
  } finally {
    await server.close();
  }
});

test("a lifecycle roster row supplies the counts when the Task snapshot has none", async () => {
  const { server, dock } = await setup();
  try {
    const rows = dock([
      user("u1"),
      assistant("a1", "Delegating."),
      task("t1", "call-1", { delegationId: "d1" }),
      lifecycle("w1", "TaskWait", [
        {
          delegationId: "d1",
          agent: "explorer",
          status: "running",
          turns: 2,
          contextTokens: 9_800,
        },
      ]),
    ]);
    assert.deepEqual(rows[0].metrics, { turns: 2, toolCalls: 0, contextTokens: 9_800 });
  } finally {
    await server.close();
  }
});

test("a child's own reported usage is the last resort, and the parent's is never used", async () => {
  const { server, dock } = await setup();
  try {
    const childUsage = { inputTokens: 7_400, outputTokens: 300 };
    const parentUsage = { inputTokens: 120_000, outputTokens: 2_000 };
    const rows = dock([
      user("u1"),
      // The parent turn's own usage must never become a child's occupancy.
      message("a1", "assistant", "Delegating.", { usage: parentUsage }),
      task("t1", "call-1", { delegationId: "d1" }),
      // A child transcript event, tagged with the Task call that owns it.
      message("c1", "assistant", "Working.", {
        usage: childUsage,
        parentToolCallId: "call-1",
      }),
    ]);
    assert.deepEqual(rows[0].metrics, {
      turns: 0,
      toolCalls: 0,
      contextTokens: 7_700,
      contextEstimated: true,
      // The child's own spend travels with its occupancy; the presenter states
      // it only when the usage carries a total, so this legacy shape shows the
      // context estimate and no invented spend.
      usage: { inputTokens: 7_400, outputTokens: 300 },
    });
  } finally {
    await server.close();
  }
});

test("a child that has reported nothing carries no counts at all", async () => {
  const { server, dock } = await setup();
  try {
    const fromTaskHandle = dock([
      user("u1"),
      assistant("a1", "Delegating."),
      task("t1", "call-1", { delegationId: "d1" }),
    ]);
    assert.equal(fromTaskHandle[0].metrics, undefined);
    const creating = dock([
      user("u1"),
      assistant("a1", "Delegating."),
      message("t1", "tool", "", {
        toolName: "Task",
        toolCallId: "call-1",
        toolStatus: "running",
        toolArgs: { agent: "explorer" },
      }),
    ]);
    assert.equal(creating[0].metrics, undefined);
  } finally {
    await server.close();
  }
});
