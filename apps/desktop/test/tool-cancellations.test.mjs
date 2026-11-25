/**
 * The main process holds one cancellation record per in-flight host-bound tool
 * call. host-core reports the cancel for one `(sessionId, toolCallId)`; the
 * registry is the only thing that carries it into the plugin JS or MCP call
 * main started, plus a short-lived tombstone so a call cancelled before it
 * began never starts late.
 *
 * These are resource-lifecycle rules, not authorization: nothing here decides
 * whether a call may run, only whether one exact already-cancelled call stops.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createToolCancellationRegistry } = await import(
  "../electron/main/runtime/tool-cancellations.ts"
);

test("an abort before dispatch is remembered until the call begins", () => {
  const registry = createToolCancellationRegistry();
  registry.noteAbort("session-1", "call-1");

  const call = registry.begin("session-1", "call-1");
  assert.ok(call, "a call with both ids gets a record");
  assert.equal(call.aborted, true, "the tombstone refuses the call");
  assert.equal(call.signal.aborted, true);
  assert.equal(call.signal.reason?.code, "TOOL_ABORTED");
  call.dispose();
});

test("a tombstone is consumed once and does not reach another call", () => {
  const registry = createToolCancellationRegistry();
  registry.noteAbort("session-1", "call-1");

  const first = registry.begin("session-1", "call-1");
  assert.equal(first.aborted, true);
  first.dispose();

  // The same id cannot be cancelled twice: the tombstone belonged to the call
  // that consumed it, and a later call on this id starts clean.
  const second = registry.begin("session-1", "call-1");
  assert.equal(second.aborted, false);
  second.dispose();
});

test("an abort of a live call aborts its controller exactly once", () => {
  const registry = createToolCancellationRegistry();
  const call = registry.begin("session-1", "call-1");
  assert.equal(call.aborted, false);
  assert.equal(call.signal.aborted, false);

  registry.noteAbort("session-1", "call-1");
  assert.equal(call.aborted, true);
  assert.equal(call.signal.aborted, true);
  assert.equal(call.signal.reason?.code, "TOOL_ABORTED");

  // A repeated report for the same live call is harmless.
  registry.noteAbort("session-1", "call-1");
  assert.equal(call.aborted, true);
  call.dispose();
});

test("a disposed call leaves no live record behind", () => {
  const registry = createToolCancellationRegistry();
  const call = registry.begin("session-1", "call-1");
  call.dispose();

  assert.equal(call.aborted, false, "dispose does not retroactively cancel");
  registry.noteAbort("session-1", "call-1");
  const next = registry.begin("session-1", "call-1");
  assert.equal(next.aborted, true, "the later abort became a tombstone");
  next.dispose();
});

test("the pair is (session, call): a sibling session or call is untouched", () => {
  const registry = createToolCancellationRegistry();
  const first = registry.begin("session-1", "call-1");
  const siblingCall = registry.begin("session-1", "call-2");
  const otherSession = registry.begin("session-2", "call-1");

  registry.noteAbort("session-1", "call-1");

  assert.equal(first.aborted, true);
  assert.equal(siblingCall.aborted, false);
  assert.equal(otherSession.aborted, false);
  first.dispose();
  siblingCall.dispose();
  otherSession.dispose();
});

test("a payload without both ids gets no record and no tombstone", () => {
  const registry = createToolCancellationRegistry();
  registry.noteAbort("session-1", undefined);
  registry.noteAbort(undefined, "call-1");
  registry.noteAbort("   ", "call-1");

  assert.equal(registry.begin("session-1", "call-1")?.aborted, false);
  assert.equal(registry.begin(undefined, "call-1"), undefined);
  assert.equal(registry.begin("session-1", " "), undefined);
});

test("a stale tombstone expires before it could cancel a newer call", () => {
  let now = 1000;
  const registry = createToolCancellationRegistry({ tombstoneTtlMs: 10, now: () => now });
  registry.noteAbort("session-1", "call-1");
  now += 10;

  const call = registry.begin("session-1", "call-1");
  assert.equal(call.aborted, false, "an expired abort must not cancel a later call");
  call.dispose();
});

test("a fresh tombstone survives the same window", () => {
  let now = 1000;
  const registry = createToolCancellationRegistry({ tombstoneTtlMs: 10, now: () => now });
  registry.noteAbort("session-1", "call-1");
  now += 9;

  assert.equal(registry.begin("session-1", "call-1").aborted, true);
});

test("remembered tombstones stay bounded, dropping the oldest", () => {
  let now = 1000;
  const registry = createToolCancellationRegistry({ maxTombstones: 2, now: () => now });
  registry.noteAbort("session-1", "call-1");
  now += 1;
  registry.noteAbort("session-1", "call-2");
  now += 1;
  registry.noteAbort("session-1", "call-3");

  const oldest = registry.begin("session-1", "call-1");
  assert.equal(oldest.aborted, false, "the oldest record was dropped");
  const newest = registry.begin("session-1", "call-3");
  assert.equal(newest.aborted, true);
});

test("clear aborts every live call and drops every record: the host is gone", () => {
  const registry = createToolCancellationRegistry();
  const first = registry.begin("session-1", "call-1");
  const second = registry.begin("session-2", "call-2");
  registry.noteAbort("session-1", "call-3");
  const signals = [];
  for (const call of [first, second]) {
    call.signal.addEventListener("abort", () => signals.push(call.signal.reason?.code), { once: true });
  }

  registry.clear();

  // The plugin/MCP work main started is still running after its host exits;
  // the cancellation reaches it, so the signal is not silently dropped.
  assert.equal(first.aborted, true);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.deepEqual(signals, ["TOOL_ABORTED", "TOOL_ABORTED"]);
  // Nothing is remembered for the dead generation: a later report only
  // addresses calls the replacement host registered itself.
  registry.noteAbort("session-1", "call-1");
  assert.equal(registry.begin("session-1", "call-3")?.aborted, false, "tombstones cleared too");
});

test("a call registered after clear is not reached by the previous generation", () => {
  const registry = createToolCancellationRegistry();
  const previous = registry.begin("session-1", "call-1");

  registry.clear();
  const current = registry.begin("session-1", "call-1");
  assert.equal(current.aborted, false, "the replacement host's call starts clean");
  assert.equal(current.signal.aborted, false);

  // The dead generation's own cleanup runs after re-registration; it is bound
  // to its own entry, so it cannot delete or cancel the live record.
  previous.dispose();
  assert.equal(current.signal.aborted, false);
  registry.noteAbort("session-1", "call-1");
  assert.equal(current.signal.aborted, true, "the live record is still reachable");
  assert.equal(previous.signal.aborted, true, "and the dead call stays cancelled");
  current.dispose();
});
