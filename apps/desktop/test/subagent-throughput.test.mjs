import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function load() {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    return await vite.ssrLoadModule("/src/lib/subagent-throughput.ts");
  } finally {
    await vite.close();
  }
}

const { aggregateSubagentThroughput } = await load();

function assistant(id, call, fields = {}) {
  return {
    id, role: "assistant", content: "x", parentToolCallId: call,
    status: "complete", ...fields,
  };
}

test("subagent throughput weights settled direct-chain output over model stream time", () => {
  const chain = new Set(["call-1", "call-2"]);
  const messages = [
    assistant("provider-a", "call-1", { usage: { outputTokens: 100 }, modelStreamDurationMs: 1000 }),
    assistant("provider-b", "call-2", { usage: { outputTokens: 50 }, modelStreamDurationMs: 3000 }),
    // Runtime contract: an interrupted response carries provider 0 plus the
    // visible-content estimate; the estimate wins and is flagged.
    assistant("estimated", "call-2", {
      usage: { outputTokens: 0 }, responseOutputTokens: 25,
      modelStreamDurationMs: 1000, status: "aborted",
    }),
    // Repeated id: an earlier stale representation must be replaced by the
    // later settled one, never summed and never dropped wholesale.
    assistant("repeated", "call-1", { usage: { outputTokens: 900 }, modelStreamDurationMs: 1000 }),
    assistant("repeated", "call-1", { usage: { outputTokens: 300 }, modelStreamDurationMs: 2000 }),
    assistant("streaming", "call-1", {
      usage: { outputTokens: 999 }, modelStreamDurationMs: 1000, status: "streaming",
    }),
    assistant("missing-time", "call-1", { usage: { outputTokens: 20 } }),
    assistant("zero-time", "call-1", { usage: { outputTokens: 20 }, modelStreamDurationMs: 0 }),
    assistant("nan-time", "call-1", { usage: { outputTokens: 20 }, modelStreamDurationMs: Number.NaN }),
    // Nested delegate whose owning Task call is in the selected chain.
    assistant("nested", "call-1", {
      usage: { outputTokens: 999 }, modelStreamDurationMs: 1000,
      nestedParentToolCallId: "inner-call", agentName: "nested",
    }),
    assistant("unrelated", "call-9", { usage: { outputTokens: 999 }, modelStreamDurationMs: 1000 }),
    assistant("negative", "call-1", { usage: { outputTokens: -1 }, modelStreamDurationMs: 1000 }),
    // A completed response that reported a real zero is a zero sample.
    assistant("zero", "call-1", { usage: { outputTokens: 0 }, modelStreamDurationMs: 1000 }),
    // Missing provider count falls back to the positive estimate.
    assistant("nan-provider", "call-1", {
      usage: { outputTokens: Number.NaN }, responseOutputTokens: 40, modelStreamDurationMs: 1000,
    }),
    // A zero or non-finite estimate is not a token count.
    assistant("zero-estimate", "call-1", { responseOutputTokens: 0, modelStreamDurationMs: 1000 }),
    assistant("nan-estimate", "call-1", {
      usage: { outputTokens: Number.NaN }, responseOutputTokens: Number.NaN,
      modelStreamDurationMs: 1000,
    }),
    // A positive provider count is preferred and never flagged as an estimate.
    assistant("provider-wins", "call-1", {
      usage: { outputTokens: 42 }, responseOutputTokens: 999, modelStreamDurationMs: 1000,
    }),
    // Wait duration is not stream time.
    assistant("duration-only", "call-1", { responseDurationMs: 1000 }),
    assistant("errored", "call-1", {
      usage: { outputTokens: 500 }, modelStreamDurationMs: 1000, status: "error",
    }),
    { ...assistant("tool", "call-1"), role: "tool", toolName: "Task", usage: { outputTokens: 500 }, modelStreamDurationMs: 1000 },
  ];

  assert.deepEqual(aggregateSubagentThroughput(messages, chain), {
    tokens: 557,
    durationMs: 10000,
    samples: 7,
    estimated: true,
    tokensPerSecond: 55.7,
  });
});

test("selected chain, duplicate representation, and missing samples stay honest", () => {
  const messages = [
    assistant("a", "call-1", { usage: { outputTokens: 100 }, modelStreamDurationMs: 1000 }),
    assistant("b", "call-2", { usage: { outputTokens: 50 }, modelStreamDurationMs: 3000 }),
    assistant("c", "call-2", {
      usage: { outputTokens: 0 }, responseOutputTokens: 25,
      modelStreamDurationMs: 1000, status: "aborted",
    }),
    // Latest settled representation of the same id is invalid: the stale
    // earlier row is not resurrected to fill the gap.
    assistant("stale", "call-1", { usage: { outputTokens: 700 }, modelStreamDurationMs: 1000 }),
    assistant("stale", "call-1", { usage: { outputTokens: 700 } }),
  ];

  assert.deepEqual(aggregateSubagentThroughput(messages, new Set(["call-2"])), {
    tokens: 75, durationMs: 4000, samples: 2, estimated: true, tokensPerSecond: 18.75,
  });
  assert.deepEqual(aggregateSubagentThroughput(messages, new Set(["call-1"])), {
    tokens: 100, durationMs: 1000, samples: 1, estimated: false, tokensPerSecond: 100,
  });
  assert.deepEqual(aggregateSubagentThroughput(messages, new Set()), {
    tokens: 0, durationMs: 0, samples: 0, estimated: false, tokensPerSecond: null,
  });
});

test("empty-chain, zero, and estimate-only semantics", () => {
  const zero = [assistant("zero", "call-1", { usage: { outputTokens: 0 }, modelStreamDurationMs: 1000 })];
  assert.deepEqual(aggregateSubagentThroughput(zero, new Set(["call-1"])), {
    tokens: 0, durationMs: 1000, samples: 1, estimated: false, tokensPerSecond: 0,
  });

  const estimated = [assistant("estimate", "call-1", {
    usage: { outputTokens: 0 }, responseOutputTokens: 100,
    modelStreamDurationMs: 2000, status: "aborted",
  })];
  assert.deepEqual(aggregateSubagentThroughput(estimated, new Set(["call-1"])), {
    tokens: 100, durationMs: 2000, samples: 1, estimated: true, tokensPerSecond: 50,
  });

  assert.equal(aggregateSubagentThroughput([
    assistant("streaming", "call-1", { usage: { outputTokens: 10 }, modelStreamDurationMs: 1000, status: "streaming" }),
    assistant("missing", "call-1", { usage: { outputTokens: 10 } }),
  ], new Set(["call-1"])).tokensPerSecond, null);
});
