#!/usr/bin/env node
/**
 * E2E-MESSAGE-DURABILITY-CONTRACT — the fractional generation-throughput figure
 * the runtime measures survives the real Host boundary, and a payload the Host
 * cannot index is refused with a typed rejection instead of being accepted and
 * silently stripped.
 *
 * What is real here: the built `pi-desktop-host-core` binary, its own NDJSON
 * RPC, SQLite and the on-disk transcript. What is synthetic: one temporary data
 * directory. No Desktop window, no provider, no model, no network call.
 *
 * Steps:
 *   1. `session.appendMessage` with `durationMs: 1234.567` (the exact shape the
 *      runtime sampler emits) and `session.get` returns the same fraction; the
 *      rate the renderer derives from it matches the producer's figure;
 *   2. `session.replaceMessages` (regenerate/rewrite path) keeps the fraction;
 *   3. payloads that cannot index a rate — negative, fractional counts, non
 *      numeric — are refused with `INVALID_PARAMS`, so a retrying outbox can
 *      quarantine them on the first refusal instead of stalling every session;
 *   4. a valid append after those refusals still lands, and the stored rows keep
 *      their order.
 *
 * Usage:
 *   PI_DESKTOP_HOST_BIN=target/debug/pi-desktop-host-core \
 *     node scripts/e2e-message-durability-contract.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const FRACTION_MS = 1234.567;
const TOKENS = 42;

function assistant(id, throughput) {
  return {
    id,
    role: "assistant",
    content: `answer ${id}`,
    createdAt: "2025-05-01T00:00:01Z",
    status: "complete",
    ...(throughput ? { throughput } : {}),
  };
}

/** The renderer's own rate formula, applied to the figure the Host returned. */
function throughputPerSecond(totals) {
  if (!totals) return null;
  if (!Number.isFinite(totals.tokens) || totals.tokens < 0) return null;
  if (!Number.isFinite(totals.samples) || totals.samples <= 0) return null;
  if (!Number.isFinite(totals.durationMs) || !(totals.durationMs > 0)) return null;
  return totals.tokens / (totals.durationMs / 1000);
}

const refusal = async (call) => {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error("the host accepted a payload it cannot index");
};

const root = await mkdtemp(join(tmpdir(), "pi-durability-e2e-"));
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });

const host = new Host(resolveHostBinary(), dataDir, { quiet: true });
await host.start();
try {
  const { session } = await host.call("session.create", { title: "Durability contract" });
  const detail = async () => (await host.call("session.get", { id: session.id })).session;

  // 1. The real runtime fraction survives append and read unchanged.
  await host.call("session.appendMessage", {
    sessionId: session.id,
    message: assistant("fraction-1", { tokens: TOKENS, durationMs: FRACTION_MS, samples: 1 }),
  });
  const appended = await detail();
  assert.equal(appended.messages.length, 1, "one row persisted");
  const totals = appended.messages[0].throughput;
  assert.ok(totals, "the row keeps its throughput");
  assert.equal(totals.durationMs, FRACTION_MS, "the exact fractional span is preserved");
  assert.equal(totals.tokens, TOKENS);
  assert.equal(totals.samples, 1);
  const rate = throughputPerSecond(totals);
  assert.equal(
    rate,
    TOKENS / (FRACTION_MS / 1000),
    "the rate the renderer derives matches the producer's figure",
  );
  assert.ok(
    Math.abs(rate - TOKENS / (Math.floor(FRACTION_MS) / 1000)) > 0.001,
    "a truncated span would change the rate, so this is not a rounding coincidence",
  );

  // 2. A transcript rewrite keeps the same figure.
  await host.call("session.replaceMessages", {
    sessionId: session.id,
    messages: [assistant("fraction-1", { tokens: TOKENS, durationMs: FRACTION_MS, samples: 1 })],
  });
  const rewritten = await detail();
  assert.equal(
    rewritten.messages[0].throughput.durationMs,
    FRACTION_MS,
    "replaceMessages keeps the fraction",
  );

  // 3. Deterministic payload refusals are typed, and write nothing.
  const badPayloads = [
    { tokens: 1, durationMs: -5.5, samples: 1 },
    { tokens: 1, durationMs: 10, samples: 0.5 },
    { tokens: 1, durationMs: "slow", samples: 1 },
  ];
  for (const throughput of badPayloads) {
    const error = await refusal(() =>
      host.call("session.appendMessage", {
        sessionId: session.id,
        message: assistant(`bad-${JSON.stringify(throughput)}`, throughput),
      }),
    );
    assert.equal(
      error.errorCode,
      "INVALID_PARAMS",
      `a rejected throughput payload carries INVALID_PARAMS: ${JSON.stringify(throughput)}`,
    );
    assert.match(String(error.message), /throughput|invalid type|expected/i);
  }
  const afterRefusals = await detail();
  assert.equal(
    afterRefusals.messages.length,
    1,
    "a refused payload never becomes a stored row",
  );

  // 4. Ordering still holds: a valid append after refusals lands last.
  await host.call("session.appendMessage", {
    sessionId: session.id,
    message: assistant("fraction-2", { tokens: 7, durationMs: 250.25, samples: 1 }),
  });
  const ordered = await detail();
  assert.deepEqual(
    ordered.messages.map((message) => message.id),
    ["fraction-1", "fraction-2"],
    "the refused payloads left no gap in the transcript order",
  );
  assert.equal(ordered.messages[1].throughput.durationMs, 250.25);

  console.log(
    JSON.stringify({
      result: "PASS",
      scenario: "E2E-MESSAGE-DURABILITY-CONTRACT",
      host: resolveHostBinary(),
      dataDir,
      fractionMs: FRACTION_MS,
      rate: rate,
      readBack: ordered.messages.map((message) => message.throughput),
    }),
  );
} finally {
  await host.stop().catch(() => undefined);
}
