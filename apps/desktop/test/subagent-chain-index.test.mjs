/**
 * The per-transcript subagent analysis every surface reads: chain membership,
 * original titles, chain metrics, the dock rows and the two provider folds.
 *
 * Two things are pinned here, and they fail for different reasons:
 *
 * 1. Behavior. A resume chain keeps its earliest description, its latest
 *    segment's figures and its identity under both resume forms, and malformed
 *    history (a cycle, a resume that names nothing, a fork) resolves the way
 *    the surfaces already resolve it.
 * 2. Work. Resolving every chain of a transcript reads each message row a
 *    bounded number of times, independent of how many chains the transcript
 *    holds. The rows are counted, not timed: a full-history rescan per chain
 *    reads them once per chain and shows up as a chain-count multiple.
 *
 * Every case is built from real `UiMessage` rows and read through the public
 * helpers and the dock model — no duplicated internals.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));

const AT = "2026-09-01T00:00:00.000Z";

function message(id, role, content, extra = {}) {
  return { id, role, content, createdAt: AT, ...extra };
}

const user = (id, content = "go") => message(id, "user", content);

const assistant = (id, content, extra = {}) =>
  message(id, "assistant", content, extra);

function taskCall(
  id,
  callId,
  {
    delegationId,
    description,
    resume,
    agent = "explorer",
    status = "running",
    metrics,
    task = "a long brief that is never a title",
  } = {},
) {
  return message(id, "tool", "", {
    toolName: "Task",
    toolCallId: callId,
    toolStatus: "running",
    toolArgs: {
      agent,
      task,
      ...(description === undefined ? {} : { description }),
      ...(resume === undefined ? {} : { resume }),
    },
    ...(delegationId === undefined
      ? {}
      : {
          toolResult: {
            details: {
              delegationId,
              agent,
              status,
              startedAt: 1_000,
              ...(metrics ?? {}),
            },
          },
        }),
  });
}

function lifecycleRow(id, toolName, entries, { stopped = false } = {}) {
  return message(id, "tool", "", {
    toolName,
    toolCallId: `lifecycle-${id}`,
    toolStatus: "success",
    toolArgs: {},
    toolResult: {
      details: stopped ? { stopped: entries } : { delegations: entries },
    },
  });
}

/** An ordinary workspace tool row: not a delegation, so it opens no chain. */
const ordinaryRow = (id, callId, toolName = "Bash") =>
  message(id, "tool", "", {
    toolName,
    toolCallId: callId,
    toolStatus: "success",
    toolArgs: { command: "printf done" },
    toolResult: { stdout: "done", exitCode: 0 },
  });

/** A child assistant row: the occupancy/spend fallback for a legacy segment. */
const childRow = (id, callId, usage) =>
  message(id, "assistant", `child output ${id}`, {
    parentToolCallId: callId,
    usage,
  });

const backgroundRows = (rows) =>
  Array.from({ length: rows }, (_, index) =>
    index % 2 === 0 ? user(`bg-u${index}`, `q${index}`) : assistant(`bg-a${index}`, `a${index}`),
  );

/**
 * `chains` resume chains of three `Task` segments each: the dispatch, a
 * `Task(resume …)` continuation that names the prior delegation id, and one
 * that names the prior call id. Every segment reports counters, the middle one
 * also has a child usage row, and the last segment's own report is missing so
 * the chain has to keep the figure its earlier segment reported.
 */
function chainMessages(chains) {
  const rows = [user("u-live", "delegate the audits")];
  for (let chain = 0; chain < chains; chain += 1) {
    const base = `k${chain}`;
    rows.push(
      taskCall(`t-${base}-1`, `${base}-call-1`, {
        delegationId: `${base}-d1`,
        description: `Chain ${chain} audit`,
        metrics: {
          turns: 4,
          toolCalls: 5,
          contextTokens: 1_000 + chain,
          usage: { operationId: `op-${base}-1`, totalTokens: 100 },
        },
      }),
      childRow(`a-${base}-1`, `${base}-call-1`, { inputTokens: 10, outputTokens: 2 }),
      taskCall(`t-${base}-2`, `${base}-call-2`, {
        delegationId: `${base}-d2`,
        resume: `${base}-d1`,
        description: `Continuation ${chain}.2`,
        metrics: {
          turns: 6,
          toolCalls: 7,
          contextTokens: 2_000 + chain,
          usage: { operationId: `op-${base}-2`, totalTokens: 200 },
        },
      }),
      childRow(`a-${base}-2`, `${base}-call-2`, { inputTokens: 20, outputTokens: 3 }),
      taskCall(`t-${base}-3`, `${base}-call-3`, {
        delegationId: `${base}-d3`,
        resume: `${base}-call-2`,
        metrics: {},
      }),
    );
  }
  return rows;
}

/**
 * A read count over the message array: every indexed read the analysis makes is
 * one row visit. Array methods (`filter`, `some`, `at`, iteration) all reach
 * the elements through this trap, so the count is the real scan work.
 */
function counted(messages) {
  const stats = { reads: 0 };
  const proxy = new Proxy(messages, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) stats.reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { messages: proxy, stats };
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
  const chain = await server.ssrLoadModule("/src/lib/subagent-chain.ts");
  const metrics = await server.ssrLoadModule("/src/lib/subagent-metrics.ts");
  const title = await server.ssrLoadModule("/src/lib/subagent-title.ts");
  const keys = await server.ssrLoadModule("/src/lib/subagent-chain-provider.tsx");
  const metricsProvider = await server.ssrLoadModule(
    "/src/lib/subagent-metrics-provider.tsx",
  );
  const dockModel = await server.ssrLoadModule(
    "/src/features/chat/composer/subagent-dock-model.ts",
  );
  const { getTranscriptProjection } = await server.ssrLoadModule(
    "/src/lib/transcript-projection.ts",
  );
  const dock = (messages, running = true) => {
    const projection = getTranscriptProjection(messages);
    return dockModel.collectDockSubagents({
      messages,
      history: projection.history,
      tail: projection.entries.at(-1),
      running,
    });
  };
  return {
    server,
    chain,
    metrics,
    title,
    keys,
    metricsProvider,
    dockModel,
    getTranscriptProjection,
    dock,
  };
}

const api = await setup();
test.after(() => api.server.close());

test("one chain keeps every segment under either resume form", () => {
  const messages = chainMessages(2);
  for (const entry of ["k0-d1", "k0-call-1", "k0-d2", "k0-call-2", "k0-d3", "k0-call-3"]) {
    assert.deepEqual(
      [...api.chain.subagentChainCallIds(messages, entry)].sort(),
      ["k0-call-1", "k0-call-2", "k0-call-3"],
      `entry ${entry}`,
    );
  }
  // A neighbouring chain never joins it.
  assert.deepEqual(
    [...api.chain.subagentChainCallIds(messages, "k1-d1")].sort(),
    ["k1-call-1", "k1-call-2", "k1-call-3"],
  );
  // An unknown identity has no chain at all.
  assert.equal(api.chain.subagentChainCallIds(messages, "nope").size, 0);
  assert.equal(api.chain.subagentChainCallIds(messages, "   ").size, 0);
});

test("the chain's latest segment is its last Task call in session order", () => {
  const messages = chainMessages(1);
  assert.equal(api.chain.subagentChainLatestDelegationId(messages, "k0-d1"), "k0-d3");
  assert.equal(api.chain.subagentChainLatestDelegationId(messages, "k0-call-2"), "k0-d3");
  // No chain: the entry id stays the key.
  assert.equal(api.chain.subagentChainLatestDelegationId(messages, "unknown"), "unknown");
});

test("the earliest description titles the chain, continuations never rename it", () => {
  const messages = chainMessages(2);
  for (const entry of ["k0-d1", "k0-call-1", "k0-d2", "k0-d3", "k0-call-3"]) {
    assert.equal(api.title.subagentTaskTitle(messages, entry), "Chain 0 audit", entry);
  }
  const titles = api.title.subagentTaskTitles(messages);
  // Titles are keyed by the delegation identity a row is keyed by: the id the
  // Task result carries, or the call id while no result has landed.
  assert.deepEqual([...titles.keys()].sort(), [
    "k0-d1",
    "k0-d2",
    "k0-d3",
    "k1-d1",
    "k1-d2",
    "k1-d3",
  ]);
  assert.deepEqual(
    [...new Set(titles.values())].sort(),
    ["Chain 0 audit", "Chain 1 audit"],
  );
});

test("chain metrics fold turns and calls, keep the latest occupancy, dedupe spend", () => {
  const messages = chainMessages(1);
  const folded = api.metrics.aggregateChainMetricsFromMessages(messages, "k0-d1");
  // Counters accumulate over the segments that reported them.
  assert.equal(folded.turns, 10);
  assert.equal(folded.toolCalls, 12);
  // Occupancy is a gauge: the last segment that reported one wins.
  assert.equal(folded.contextTokens, 2_000);
  assert.equal(folded.contextProvenance, "snapshot");
  // Spend folds through the operation ledger.
  assert.equal(folded.usage.totalTokens, 300);
  // An identity no call belongs to has no metrics.
  assert.equal(api.metrics.aggregateChainMetricsFromMessages(messages, "nope"), null);
});

test("a resumed segment that reports nothing keeps the chain's figure", () => {
  const messages = chainMessages(1);
  // The middle segment's snapshot loses its occupancy, its counters and its
  // child usage row; the chain keeps the figure segment one reported.
  const rows = messages.filter((row) => row.id !== "a-k0-2");
  // The middle segment's snapshot loses its occupancy and its counters.
  rows[rows.findIndex((row) => row.id === "t-k0-2")] = taskCall("t-k0-2", "k0-call-2", {
    delegationId: "k0-d2",
    resume: "k0-d1",
    description: "Continuation 0.2",
    metrics: {},
  });
  const folded = api.metrics.aggregateChainMetricsFromMessages(rows, "k0-d1");
  assert.equal(folded.contextTokens, 1_000);
  assert.equal(folded.contextProvenance, "snapshot");
  assert.equal(folded.turns, 4);
  assert.equal(folded.toolCalls, 5);
});

test("a lifecycle roster row reports for a segment that reported nothing itself", () => {
  const messages = [
    user("u1"),
    taskCall("t1", "call-1", { delegationId: "d1", metrics: {} }),
    taskCall("t2", "call-2", { delegationId: "d2", resume: "d1", metrics: {} }),
    lifecycleRow("w1", "TaskWait", [{ delegationId: "d2", turns: 9, toolCalls: 11, contextTokens: 51_200 }]),
  ];
  const folded = api.metrics.aggregateChainMetricsFromMessages(messages, "d1");
  assert.equal(folded.contextTokens, 51_200);
  assert.equal(folded.contextProvenance, "lifecycle");
  assert.equal(folded.turns, 9);
  assert.equal(folded.toolCalls, 11);
  // A later roster row for the same delegation wins.
  const later = [...messages, lifecycleRow("w2", "TaskList", [{ delegationId: "d2", turns: 12 }])];
  assert.equal(api.metrics.aggregateChainMetricsFromMessages(later, "d1").turns, 12);
});

test("a child assistant row is the legacy occupancy fallback, flagged as an estimate", () => {
  const messages = [
    user("u1"),
    taskCall("t1", "call-1", { delegationId: "d1", metrics: {} }),
    childRow("a1", "call-1", { inputTokens: 900, outputTokens: 100 }),
    childRow("a2", "call-1", { inputTokens: 3_000, outputTokens: 200 }),
  ];
  const folded = api.metrics.aggregateChainMetricsFromMessages(messages, "d1");
  assert.equal(folded.contextTokens, 3_200);
  assert.equal(folded.contextProvenance, "child");
  assert.equal(folded.contextEstimated, true);
  // A segment with no report at all stays unknown rather than becoming zero.
  const unreported = api.metrics.aggregateChainMetricsFromMessages(
    [user("u1"), taskCall("t1", "call-1", { delegationId: "d1", metrics: {} })],
    "d1",
  );
  assert.equal(unreported, null);
});

test("the chain key map names every identity by the chain's earliest call", () => {
  const messages = chainMessages(1);
  const keys = api.keys.subagentChainKeysByIdentity(messages);
  for (const identity of ["k0-call-1", "k0-call-2", "k0-call-3", "k0-d1", "k0-d2", "k0-d3"]) {
    assert.equal(keys.get(identity), "k0-call-1", identity);
  }
});

test("every segment of a chain reads the same folded figures", () => {
  const messages = chainMessages(2);
  const byCall = api.metricsProvider.subagentChainMetricsByIdentity(messages);
  for (let chain = 0; chain < 2; chain += 1) {
    const ids = [`k${chain}-call-1`, `k${chain}-call-2`, `k${chain}-call-3`];
    const folded = ids.map((id) => byCall.get(id));
    assert.ok(folded.every(Boolean), `chain ${chain} segments are keyed`);
    assert.deepEqual(
      folded.map((entry) => [entry.turns, entry.toolCalls, entry.contextTokens]),
      folded.map(() => [10, 12, 2_000 + chain]),
    );
  }
});

test("malformed history resolves the way the surfaces already resolve it", () => {
  // A resume that names nothing resolvable still records its edge, so the
  // dangling name is a chain member alongside the call that resumed it.
  const dangling = [
    user("u1"),
    taskCall("t1", "call-1", { delegationId: "d1", resume: "ghost-call" }),
  ];
  assert.deepEqual(
    [...api.chain.subagentChainCallIds(dangling, "d1")].sort(),
    ["call-1", "ghost-call"],
  );

  const fork = [
    user("u1"),
    taskCall("t1", "call-1", { delegationId: "d1", description: "Fork root" }),
    taskCall("t2", "call-2", { delegationId: "d2", resume: "d1" }),
    taskCall("t3", "call-3", { delegationId: "d3", resume: "d1" }),
  ];
  // Two continuations of one call: the last one that resolved is the edge the
  // chain walks back from, so a later segment's seed reaches the whole fan-out
  // and an earlier sibling's seed stays on itself.
  assert.deepEqual(
    [...api.chain.subagentChainCallIds(fork, "call-1")].sort(),
    ["call-1", "call-2", "call-3"],
  );
  assert.deepEqual(
    [...api.chain.subagentChainCallIds(fork, "d3")].sort(),
    ["call-1", "call-2", "call-3"],
  );
  assert.deepEqual([...api.chain.subagentChainCallIds(fork, "d2")], ["call-2"]);
  assert.equal(api.title.subagentTaskTitle(fork, "d3"), "Fork root");
  assert.equal(api.metrics.aggregateChainMetricsFromMessages(fork, "d3"), null);

  // A resume cycle terminates instead of walking forever.
  const cycle = [
    user("u1"),
    taskCall("t1", "call-1", { delegationId: "d1", resume: "d2", description: "Cycle" }),
    taskCall("t2", "call-2", { delegationId: "d2", resume: "d1" }),
  ];
  const members = api.chain.subagentChainCallIds(cycle, "d1");
  assert.deepEqual([...members].sort(), ["call-1", "call-2"]);
  assert.equal(api.title.subagentTaskTitle(cycle, "d1"), "Cycle");

  // A resume that names the prior call id before that call's result landed.
  const bareBefore = [
    user("u1"),
    taskCall("t1", "call-1", { resume: undefined }),
    taskCall("t2", "call-2", { delegationId: "d2", resume: "call-1" }),
  ];
  assert.deepEqual(
    [...api.chain.subagentChainCallIds(bareBefore, "call-2")].sort(),
    ["call-1", "call-2"],
  );
  assert.equal(api.title.subagentTaskTitle(bareBefore, "d2"), "");

  // No Task call at all: no chain, no metrics, no title.
  const plain = [user("u1"), assistant("a1", "hi")];
  assert.equal(api.chain.subagentChainCallIds(plain, "d1").size, 0);
  assert.equal(api.metrics.aggregateChainMetricsFromMessages(plain, "d1"), null);
  assert.equal(api.title.subagentTaskTitle(plain, "d1"), "");
  assert.equal(api.keys.subagentChainKeysByIdentity(plain).size, 0);
  assert.equal(api.metricsProvider.subagentChainMetricsByIdentity(plain).size, 0);
});

/**
 * A `Task` whose resume names an ordinary tool's call id, with that tool row
 * later in the conversation. Only a `Task` call names a chain: the tool row is
 * a member of the chain the resume edge points at, but it is never a segment,
 * never the chain's latest segment, and never a chain of its own.
 */
test("a bare tool id never seeds or retargets a delegation chain", () => {
  const messages = [
    user("u1", "audit"),
    taskCall("t1", "call-1", {
      delegationId: "d1",
      description: "Audit auth",
      resume: "call-bash",
      metrics: { turns: 2, toolCalls: 3, contextTokens: 900 },
    }),
    ordinaryRow("b1", "call-bash"),
  ];

  // The resume edge still makes the named call a member, forward and backward.
  assert.deepEqual([...api.chain.subagentChainCallIds(messages, "d1")].sort(), [
    "call-1",
    "call-bash",
  ]);
  // The entry identity that names only the ordinary tool has no chain at all.
  assert.equal(api.chain.subagentChainCallIds(messages, "call-bash").size, 0);
  assert.equal(api.title.subagentTaskTitle(messages, "call-bash"), "");
  assert.equal(api.metrics.aggregateChainMetricsFromMessages(messages, "call-bash"), null);

  // The latest segment is the chain's last delegation call, never a later
  // ordinary tool row that happens to share the chain.
  assert.equal(api.chain.subagentChainLatestDelegationId(messages, "d1"), "d1");
  assert.equal(api.chain.subagentChainLatestDelegationId(messages, "call-1"), "d1");
  assert.equal(api.chain.subagentChainLatestDelegationId(messages, "call-bash"), "call-bash");

  // The chain keeps its title and its own segment's figures.
  assert.equal(api.title.subagentTaskTitle(messages, "d1"), "Audit auth");
  assert.deepEqual(api.metrics.aggregateChainMetricsFromMessages(messages, "d1"), {
    toolCalls: 3,
    turns: 2,
    contextTokens: 900,
    contextProvenance: "snapshot",
  });

  // The batch maps name delegation identities only; an ordinary call id is not
  // an identity any surface can ask a chain about.
  assert.deepEqual([...api.title.subagentTaskTitles(messages).keys()], ["d1"]);
  assert.deepEqual([...api.keys.subagentChainKeysByIdentity(messages).entries()].sort(), [
    ["call-1", "call-bash"],
    ["d1", "call-bash"],
  ]);
  // Folded figures stay published under every id the chain holds, as before.
  assert.deepEqual([...api.metricsProvider.subagentChainMetricsByIdentity(messages).keys()].sort(), [
    "call-1",
    "call-bash",
  ]);

  // The dock lists the delegation, not the ordinary tool.
  assert.deepEqual(
    api.dock(messages).map((row) => [row.delegationId, row.title]),
    [["d1", "Audit auth"]],
  );
});

/**
 * The ordinary shape: a chain whose segments sit between unrelated tool rows,
 * with a lifecycle roster row and a child usage row in the same transcript.
 * Every fallback row still reaches the fold, and no ordinary call id leaks into
 * the identity maps.
 */
test("ordinary tool rows beside a chain keep every fallback figure", () => {
  const messages = [
    user("u1", "audit"),
    taskCall("t1", "call-1", {
      delegationId: "d1",
      description: "Audit auth",
      metrics: { turns: 4, toolCalls: 5, contextTokens: 1_000 },
    }),
    ordinaryRow("b1", "bash-1"),
    childRow("a1", "call-1", { inputTokens: 10, outputTokens: 2 }),
    lifecycleRow("w1", "TaskWait", [{ delegationId: "d1", turns: 4, toolCalls: 5, contextTokens: 1_200 }]),
    taskCall("t2", "call-2", {
      delegationId: "d2",
      resume: "d1",
      description: "Continuation",
      metrics: { turns: 6, toolCalls: 7, contextTokens: 2_000 },
    }),
    ordinaryRow("b2", "bash-2", "Read"),
    childRow("a2", "call-2", { inputTokens: 20, outputTokens: 3 }),
  ];

  for (const entry of ["d1", "call-1", "d2", "call-2"]) {
    assert.deepEqual(
      [...api.chain.subagentChainCallIds(messages, entry)].sort(),
      ["call-1", "call-2"],
      entry,
    );
    assert.equal(api.chain.subagentChainLatestDelegationId(messages, entry), "d2", entry);
    assert.equal(api.title.subagentTaskTitle(messages, entry), "Audit auth", entry);
  }
  // A tool row is not an identity: no chain, no title, no figures.
  for (const id of ["bash-1", "bash-2"]) {
    assert.equal(api.chain.subagentChainCallIds(messages, id).size, 0, id);
    assert.equal(api.chain.subagentChainLatestDelegationId(messages, id), id, id);
    assert.equal(api.metrics.aggregateChainMetricsFromMessages(messages, id), null, id);
  }

  // The fold still reads both the snapshot and the lifecycle roster row.
  const folded = api.metrics.aggregateChainMetricsFromMessages(messages, "d1");
  assert.deepEqual([folded.turns, folded.toolCalls, folded.contextTokens], [10, 12, 2_000]);
  assert.equal(folded.contextProvenance, "snapshot");

  // Identity maps hold delegation identities and delegation call ids only.
  assert.deepEqual([...api.title.subagentTaskTitles(messages).keys()].sort(), ["d1", "d2"]);
  assert.deepEqual(
    [...api.keys.subagentChainKeysByIdentity(messages).entries()].sort(),
    [
      ["call-1", "call-1"],
      ["call-2", "call-1"],
      ["d1", "call-1"],
      ["d2", "call-1"],
    ],
  );
  assert.deepEqual(
    [...api.metricsProvider.subagentChainMetricsByIdentity(messages).keys()].sort(),
    ["call-1", "call-2"],
  );
  assert.deepEqual(
    api.dock(messages).map((row) => [row.delegationId, row.title, row.metrics?.turns]),
    [["d2", "Audit auth", 10]],
  );
});

test("the dock keeps one row per chain with the chain's title and figures", () => {
  const messages = [
    user("u1"),
    assistant("a1", "Delegating both audits."),
    taskCall("t1", "call-1", {
      delegationId: "d1",
      description: "Review auth flow",
      metrics: { turns: 4, toolCalls: 5, contextTokens: 1_000 },
    }),
    taskCall("t2", "call-2", {
      delegationId: "d2",
      agent: "auditor",
      description: "Audit dependencies",
    }),
  ];
  const rows = api.dock(messages);
  assert.deepEqual(
    rows.map((row) => [row.delegationId, row.title, row.role, row.metrics?.turns]),
    [
      ["d1", "Review auth flow", "explorer", 4],
      ["d2", "Audit dependencies", "auditor", undefined],
    ],
  );
  // A continuation of the first chain replaces its row instead of adding one,
  // and reports the folded figures under the original title.
  const resumed = [
    ...messages,
    taskCall("t3", "call-3", {
      delegationId: "d3",
      resume: "d1",
      description: "Continuation",
      metrics: { turns: 6, toolCalls: 7, contextTokens: 2_000 },
    }),
  ];
  const live = api.dock(resumed);
  assert.deepEqual(
    live.map((row) => [row.delegationId, row.title, row.metrics?.turns, row.metrics?.contextTokens]),
    [
      ["d2", "Audit dependencies", undefined, undefined],
      ["d3", "Review auth flow", 10, 2_000],
    ],
  );
  // A settled row leaves the dock, and an idle turn empties it.
  const stopped = [...resumed, lifecycleRow("s1", "TaskStop", [{ delegationId: "d3" }], { stopped: true })];
  assert.deepEqual(api.dock(stopped).map((row) => row.delegationId), ["d2"]);
  assert.deepEqual(api.dock(resumed, false), []);
});

test("folding a transcript's chains reads each message row a bounded number of times", () => {
  const rows = chainMessages(2);
  const fixture = [...backgroundRows(600), ...rows];
  const { messages, stats } = counted(fixture);
  const byCall = api.metricsProvider.subagentChainMetricsByIdentity(messages);
  assert.equal(byCall.size, 6);
  const perRow = stats.reads / fixture.length;
  assert.ok(
    perRow <= 6,
    `fold read ${stats.reads} rows for ${fixture.length} messages (${perRow.toFixed(1)} per row)`,
  );

  const dockFixture = [
    user("u-live", "delegate"),
    ...backgroundRows(600),
    taskCall("t1", "call-1", { delegationId: "d1", description: "Review auth flow" }),
    taskCall("t2", "call-2", { delegationId: "d2", description: "Audit dependencies" }),
    taskCall("t3", "call-3", { delegationId: "d3", resume: "d1" }),
    taskCall("t4", "call-4", { delegationId: "d4", resume: "d2" }),
  ];
  // The transcript's own projection is a separate reader; this counts what the
  // dock model itself walks.
  const dockProjection = api.getTranscriptProjection(dockFixture);
  const dockCount = counted(dockFixture);
  const rowsOut = api.dockModel.collectDockSubagents({
    messages: dockCount.messages,
    history: dockProjection.history,
    tail: dockProjection.entries.at(-1),
    running: true,
  });
  assert.equal(rowsOut.length, 2);
  const dockPerRow = dockCount.stats.reads / dockFixture.length;
  assert.ok(
    dockPerRow <= 8,
    `dock read ${dockCount.stats.reads} rows for ${dockFixture.length} messages (${dockPerRow.toFixed(1)} per row)`,
  );
  console.log(
    `SUBAGENT_INDEX_ROWS fold=${stats.reads}/${fixture.length} dock=${dockCount.stats.reads}/${dockFixture.length}`,
  );
});

test("the fold's row work does not grow with the number of chains", () => {
  const measure = (chains) => {
    const fixture = [...backgroundRows(600), ...chainMessages(chains)];
    const { messages, stats } = counted(fixture);
    assert.equal(
      api.metricsProvider.subagentChainMetricsByIdentity(messages).size,
      chains * 3,
    );
    return { reads: stats.reads, rows: fixture.length };
  };
  const two = measure(2);
  const twelve = measure(12);
  // Post-change, both are one pass over their own array. Reading a row once per
  // chain would make the twelve-chain transcript about six times as expensive.
  const growth = twelve.reads / twelve.rows / (two.reads / two.rows);
  assert.ok(
    growth <= 1.5,
    `per-row work grew ${growth.toFixed(2)}x from 2 to 12 chains ` +
      `(${two.reads}/${two.rows} then ${twelve.reads}/${twelve.rows})`,
  );
  console.log(
    `SUBAGENT_INDEX_SCALE chains2=${two.reads}/${two.rows} chains12=${twelve.reads}/${twelve.rows}`,
  );
});
