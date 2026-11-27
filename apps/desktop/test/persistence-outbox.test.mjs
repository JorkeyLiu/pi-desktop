import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";
import { readMainModule, readMainSource } from "./helpers/main-source.mjs";

const silent = () => undefined;

test("session delete drops the outbox for that session (D318)", async () => {
  const main = await readMainSource();
  assert.match(main, /await persistenceOutbox\.dropSession\(id\)/);
});

test("handshake drains the outbox before the renderer can hydrate (D327)", async () => {
  const main = await readMainSource();
  // The handshake drain passes the runtime host, not the IPC request host:
  // the truncate boundary it used to share this assertion with now flushes,
  // cuts, then drops the session queue through dropSession instead.
  assert.match(main, /await persistenceOutbox\.flush\(\(\) => runtimeState\.host\)/);
  assert.doesNotMatch(main, /void persistenceOutbox\.flush\(\(\) => host\)/);
  assert.match(main, /session\.recoverInflightMessages/);
});

test("message_end checkpoints the finished snapshot before settling (D327)", async () => {
  const main = await readMainSource();
  assert.match(
    main,
    /event\.type === "message_end"[\s\S]*inflightCheckpointer\.observe\([\s\S]*settleIf\(sessionId, finalId\)/,
  );
});

test("deleting a session drops its queued outbox entries (D318)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue(
    {
      key: "message:keep:a",
      sessionId: "keep",
      message: { id: "a" },
    },
    () => null,
  );
  await outbox.enqueue(
    {
      key: "message:gone:b",
      sessionId: "gone",
      message: { id: "b" },
    },
    () => null,
  );
  assert.equal(outbox.size(), 2);
  await outbox.dropSession("gone");
  assert.equal(outbox.size(), 1);
  const stored = JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8"));
  assert.deepEqual(
    stored.map((entry) => entry.sessionId),
    ["keep"],
  );
});
test("truncate replacement drops queued appends the flush could not write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-truncate-"));
  const outbox = new PersistenceOutbox(dir, silent);
  // The host is down, so the flush a truncate boundary runs first cannot
  // write: the old tail stays queued behind it.
  await outbox.enqueue(
    {
      key: "message:trunc:old-assistant",
      sessionId: "trunc",
      message: { id: "old-assistant", role: "assistant", content: "discarded" },
    },
    () => null,
  );
  await outbox.enqueue(
    {
      key: "message:trunc:old-tool",
      sessionId: "trunc",
      message: { id: "old-tool", role: "tool", content: "discarded" },
    },
    () => null,
  );
  await outbox.enqueue(
    {
      key: "message:other:live",
      sessionId: "other",
      message: { id: "live", role: "user", content: "keep" },
    },
    () => null,
  );
  assert.equal(outbox.size(), 3);
  await outbox.prepareSessionReplacement("trunc", () => null);
  assert.equal(outbox.size(), 1, "only the truncated session's queue is dropped");
  const stored = JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8"));
  assert.deepEqual(
    stored.map((entry) => entry.sessionId),
    ["other"],
    "a late drain can no longer recreate the discarded tail",
  );
});

test("a failed truncate keeps the session queue instead of dropping it first", async () => {
  const agentIpc = await readMainModule("ipc/agent-ipc.ts");
  // The boundary under test: the edit/retry prompt's truncate block.
  const block = agentIpc.slice(
    agentIpc.indexOf("if (truncateFromMessageId || truncateBefore !== undefined)"),
    agentIpc.indexOf("sidecar.clearProjectInstructionRoot(req.sessionId)"),
  );
  assert.ok(block.length > 0, "the truncate block is found");
  const flushed = block.indexOf("persistenceOutbox.flush(");
  const cut = block.indexOf("\"session.truncateFrom\"");
  const dropped = block.indexOf("persistenceOutbox.dropSession(req.sessionId)");
  assert.ok(flushed >= 0 && cut > flushed, "writable appends land before the cut");
  assert.ok(dropped > cut, "the session queue is dropped only after the cut lands");
  assert.equal(
    block.indexOf("prepareSessionReplacement"),
    -1,
    "no drop runs before the fallible cut",
  );
});

test("transcript replacement waits for an in-flight append before dropping the session queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-replace-"));
  const outbox = new PersistenceOutbox(dir, silent);
  let releaseAppend;
  let appendStarted;
  const started = new Promise((resolve) => { appendStarted = resolve; });
  const blockedAppend = new Promise((resolve) => { releaseAppend = resolve; });
  const host = mockHost(async () => {
    appendStarted();
    await blockedAppend;
  });

  await outbox.enqueue(
    {
      key: "message:replace-session:assistant-1",
      sessionId: "replace-session",
      message: { id: "assistant-1", role: "assistant", content: "obsolete" },
    },
    () => host,
  );
  await started;

  let replacementReady = false;
  const preparing = outbox
    .prepareSessionReplacement("replace-session", () => host)
    .then(() => { replacementReady = true; });
  await Promise.resolve();
  assert.equal(replacementReady, false, "replacement must wait for the active append");

  releaseAppend();
  await preparing;
  assert.equal(replacementReady, true);
  assert.equal(outbox.size(), 0);
});

function mockHost(handler) {
  return {
    isAvailable: () => true,
    call: async (method, params) => handler(method, params),
  };
}

test("duplicate message id does not stall later outbox entries (D444)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "call_421522") {
      throw new Error("UNIQUE constraint failed: messages.id");
    }
  });
  const getHost = () => host;
  await outbox.enqueue(
    {
      key: "message:s1:call_421522",
      sessionId: "s1",
      message: { id: "call_421522" },
    },
    getHost,
  );
  await outbox.enqueue(
    {
      key: "message:s2:assistant-1",
      sessionId: "s2",
      message: { id: "assistant-1" },
    },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.id, "assistant-1");
  assert.ok(
    logs.some((row) => row.message === "session persistence flush skipped duplicate message id"),
  );
});

test("a full outbox rejects an entry instead of reporting it enqueued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-full-"));
  const path = join(dir, "session-message-outbox.json");
  const entries = Array.from({ length: 1024 }, (_, index) => ({
    key: `message:s${index}:m${index}`,
    sessionId: `s${index}`,
    message: { id: `m${index}` },
  }));
  await writeFile(path, JSON.stringify(entries), "utf8");
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });

  await assert.rejects(
    outbox.enqueue(
      { key: "message:last:missing", sessionId: "last", message: { id: "missing" } },
      () => null,
    ),
    /outbox is full/i,
  );
  assert.equal(outbox.size(), 1024);
  assert.equal(JSON.parse(await readFile(path, "utf8")).length, 1024);
  assert.ok(
    logs.some(
      (entry) =>
        entry.message === "session persistence outbox is full" &&
        entry.data?.key === "message:last:missing",
    ),
  );
});

test("non-unique flush errors still pause the outbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  const host = mockHost(async () => {
    throw new Error("session not found");
  });
  const getHost = () => host;
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    getHost,
  );
  await outbox.enqueue(
    { key: "message:s2:b", sessionId: "s2", message: { id: "b" } },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 2);
});


test("poisoned provenance message does not stall later outbox entries (D597)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "steering-poison") {
      throw new Error("PERMISSION_DENIED: transcript input does not match its session delivery");
    }
  });
  const getHost = () => host;
  await outbox.enqueue(
    {
      key: "message:s1:steering-poison",
      sessionId: "s1",
      message: { id: "steering-poison", role: "user", steering: true },
    },
    getHost,
  );
  await outbox.enqueue(
    {
      key: "message:s2:assistant-1",
      sessionId: "s2",
      message: { id: "assistant-1", role: "assistant" },
    },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.id, "assistant-1");
  assert.ok(
    logs.some((row) => row.message === "session persistence flush dropped poisoned message"),
  );
});

test("PLUGIN_PERMISSION_DENIED is not poison and still pauses the outbox (D597)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  const host = mockHost(async () => {
    throw new Error("PLUGIN_PERMISSION_DENIED: missing grant for fs.write");
  });
  const getHost = () => host;
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    getHost,
  );
  await outbox.enqueue(
    { key: "message:s2:b", sessionId: "s2", message: { id: "b" } },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 2);
});


test("FOREIGN KEY constraint failed drops the orphaned entry and keeps draining (#996)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "orphaned-child") {
      throw new Error("Error: FOREIGN KEY constraint failed");
    }
  });
  const getHost = () => host;
  await outbox.enqueue(
    {
      key: "message:s1:orphaned-child",
      sessionId: "s1",
      message: { id: "orphaned-child" },
    },
    getHost,
  );
  await outbox.enqueue(
    {
      key: "message:s2:healthy",
      sessionId: "s2",
      message: { id: "healthy" },
    },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 0, "both entries should be drained");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.id, "healthy");
  assert.ok(
    logs.some((row) => row.message === "session persistence flush dropped orphaned message"),
  );
});

const DEAD_LETTER_FILE = "session-message-outbox.dead-letter.json";

/** Let every pending microtask settle before counting host calls. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drain with the retry backoff clock advanced past every window, returning the
 * number of appends still queued.
 */
async function drain(outbox, host, now, steps = 12) {
  for (let step = 0; step < steps && outbox.size() > 0; step += 1) {
    now.value += 60_000;
    await outbox.flush(() => host);
  }
  return outbox.size();
}

test("an unclassifiable head failure drains later entries instead of stalling them (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const logs = [];
  const outbox = new PersistenceOutbox(
    dir,
    (level, message, data) => {
      logs.push({ level, message, data });
    },
    { now: () => now.value },
  );
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "torn") {
      throw new Error("Error: stream did not contain valid UTF-8");
    }
  });
  await outbox.enqueue(
    { key: "message:s1:torn", sessionId: "s1", message: { id: "torn" } },
    () => host,
  );
  await outbox.enqueue(
    { key: "message:s2:healthy", sessionId: "s2", message: { id: "healthy" } },
    () => host,
  );
  assert.equal(outbox.size(), 2, "the bad head keeps its retry budget before quarantine");

  const remaining = await drain(outbox, host, now);
  assert.equal(remaining, 0, "the queue drains instead of blocking forever");
  assert.ok(
    calls.some((params) => params.message?.id === "healthy"),
    "a later entry reaches the host despite the bad head",
  );
  assert.ok(
    logs.some(
      (row) =>
        row.message === "session persistence flush quarantined entry" &&
        row.data?.key === "message:s1:torn",
    ),
    "quarantine is observable in the persistence log",
  );
  const dead = JSON.parse(await readFile(join(dir, DEAD_LETTER_FILE), "utf8"));
  assert.deepEqual(
    dead.map((entry) => entry.key),
    ["message:s1:torn"],
  );
  assert.equal(dead[0].sessionId, "s1");
  assert.match(dead[0].reason, /valid UTF-8/);
  assert.equal(dead[0].message.id, "torn", "the quarantined payload is kept verbatim");
  assert.equal(typeof dead[0].quarantinedAt, "string");
});

test("a failing head waits out its backoff before the host is called again (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    throw new Error("host is busy");
  });
  const getHost = () => host;
  await outbox.enqueue({ key: "message:s1:a", sessionId: "s1", message: { id: "a" } }, getHost);
  await outbox.flush(getHost);
  await settle();
  const afterFirstFailure = calls.length;
  assert.ok(afterFirstFailure >= 1);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await outbox.flush(getHost);
  }
  await settle();
  assert.equal(calls.length, afterFirstFailure, "no retry inside the backoff window");

  now.value += 120_000;
  await outbox.flush(getHost);
  await settle();
  assert.equal(calls.length, afterFirstFailure + 1, "the head is retried once its backoff elapses");
  assert.equal(outbox.size(), 1, "an unclassified failure still pauses instead of dropping");
});

test("quarantined appends survive a restart without being replayed (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const logs = [];
  const log = (level, message, data) => {
    logs.push({ level, message, data });
  };
  const outbox = new PersistenceOutbox(dir, log, { now: () => now.value });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "torn") {
      throw new Error("Error: stream did not contain valid UTF-8");
    }
  });
  await outbox.enqueue(
    { key: "message:s1:torn", sessionId: "s1", message: { id: "torn" } },
    () => host,
  );
  assert.equal(await drain(outbox, host, now), 0);

  const reopened = new PersistenceOutbox(dir, log, { now: () => now.value });
  assert.equal(reopened.size(), 0, "the dead letter is not queued again");
  assert.equal(
    JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8")).length,
    0,
  );
  const before = calls.length;
  await reopened.flush(() => host);
  assert.equal(calls.length, before, "no replay against the host");
  const dead = JSON.parse(await readFile(join(dir, DEAD_LETTER_FILE), "utf8"));
  assert.deepEqual(
    dead.map((entry) => entry.key),
    ["message:s1:torn"],
  );
});

test("the dead-letter file keeps its newest appends at the cap (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const logs = [];
  const outbox = new PersistenceOutbox(
    dir,
    (level, message, data) => {
      logs.push({ level, message, data });
    },
    { now: () => now.value, maxDeadLetters: 2 },
  );
  const host = mockHost(async (_method, params) => {
    if (["m1", "m2", "m3"].includes(params.message.id)) {
      throw new Error("Error: stream did not contain valid UTF-8");
    }
  });
  for (const id of ["m1", "m2", "m3"]) {
    await outbox.enqueue({ key: `message:s1:${id}`, sessionId: "s1", message: { id } }, () => host);
    assert.equal(await drain(outbox, host, now), 0, `${id} is quarantined and the queue drains`);
  }
  const dead = JSON.parse(await readFile(join(dir, DEAD_LETTER_FILE), "utf8"));
  assert.deepEqual(
    dead.map((entry) => entry.key),
    ["message:s1:m2", "message:s1:m3"],
  );
  assert.ok(
    logs.some(
      (row) =>
        row.message === "session persistence outbox dead letter discarded" &&
        row.data?.key === "message:s1:m1",
    ),
    "a discarded dead letter is observable",
  );
});

test("deleting a session drops its quarantined appends too (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const host = mockHost(async () => {
    throw new Error("Error: stream did not contain valid UTF-8");
  });
  await outbox.enqueue(
    { key: "message:gone:torn", sessionId: "gone", message: { id: "torn" } },
    () => host,
  );
  assert.equal(await drain(outbox, host, now), 0);
  await outbox.dropSession("gone");
  assert.deepEqual(JSON.parse(await readFile(join(dir, DEAD_LETTER_FILE), "utf8")), []);
});

test("a restarted host retries the paused head without waiting out the backoff (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const calls = [];
  const failing = mockHost(async (_method, params) => {
    calls.push(params.message.id);
    throw new Error("host is busy");
  });
  await outbox.enqueue({ key: "message:s1:a", sessionId: "s1", message: { id: "a" } }, () => failing);
  await outbox.flush(() => failing);
  await settle();
  const paused = calls.length;
  assert.ok(paused >= 1, "the head was attempted against the failing generation");

  await outbox.flush(() => failing);
  assert.equal(calls.length, paused, "the same generation waits out the backoff");

  const restarted = mockHost(async (_method, params) => {
    calls.push(params.message.id);
  });
  await outbox.flush(() => restarted);
  assert.equal(outbox.size(), 0, "a fresh host generation drains the paused head at once");
  assert.equal(calls.length, paused + 1);
});

test("a session fence waits for that session's queued rows, not for the queue's tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  let available = false;
  const writes = [];
  let releaseOther;
  const otherGate = new Promise((resolve) => {
    releaseOther = resolve;
  });
  const host = {
    isAvailable: () => true,
    call: async (_method, params) => {
      writes.push(params.sessionId);
      if (params.sessionId === "other") await otherGate;
    },
  };
  const getHost = () => (available ? host : null);
  await outbox.enqueue(
    { key: "message:target:1", sessionId: "target", message: { id: "target-1" } },
    getHost,
  );
  await outbox.enqueue(
    { key: "message:other:1", sessionId: "other", message: { id: "other-1" } },
    getHost,
  );
  assert.equal(outbox.size(), 2, "a host that is not running keeps both appends queued");
  const fence = outbox.waitForSession("target", getHost);
  available = true;
  const result = await fence;
  assert.deepEqual(result, { remaining: 0, paused: false, failed: 0 });
  assert.equal(writes[0], "target", "the pass writes this session's row first");
  assert.equal(
    outbox.size(),
    1,
    "the unrelated tail is still queued, so the read never waited for it",
  );
  releaseOther();
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 0, "the tail keeps draining after the read");
});

test("a session fence with nothing of its own queued reads at once", async () => {
  const outbox = new PersistenceOutbox(await mkdtemp(join(tmpdir(), "pi-outbox-")), silent);
  const result = await outbox.waitForSession("target", () => null);
  assert.deepEqual(result, { remaining: 0, paused: false, failed: 0 });
});

test("a session fence reports a paused host instead of a clean write", async () => {
  const outbox = new PersistenceOutbox(await mkdtemp(join(tmpdir(), "pi-outbox-")), silent);
  await outbox.enqueue(
    { key: "message:s1:1", sessionId: "s1", message: { id: "s1-1" } },
    () => null,
  );
  const result = await outbox.waitForSession("s1", () => null);
  assert.deepEqual(result, { remaining: 1, paused: true, failed: 0 });
});

test("a session fence reports a quarantined append instead of a clean write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const host = mockHost(async () => {
    throw new Error("Error: stream did not contain valid UTF-8");
  });
  await outbox.enqueue(
    { key: "message:s1:torn", sessionId: "s1", message: { id: "torn" } },
    () => null,
  );
  // Four failed passes spend most of the retry budget; the fifth attempt,
  // inside the fence's own pass, quarantines the head.
  await drain(outbox, host, now, 4);
  assert.equal(outbox.size(), 1);
  now.value += 60_000;
  const fence = await outbox.waitForSession("s1", () => host);
  assert.deepEqual(
    fence,
    { remaining: 0, paused: false, failed: 1 },
    "a quarantined append is a genuine persistence failure, not a written row",
  );
});

/** A deterministic timer seam: records handles instead of waiting on wall time. */
function fakeTimers() {
  const handles = [];
  let nextId = 1;
  return {
    handles,
    setTimer: (callback, delayMs) => {
      const handle = { id: nextId, cleared: false };
      nextId += 1;
      handles.push({ handle, callback, delayMs });
      return handle;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
    pending: () => handles.filter((timer) => !timer.handle.cleared),
  };
}

/** An error the transport throws for a typed JSON-RPC rejection. */
function rpcError(message, errorCode) {
  return Object.assign(new Error(message), { errorCode });
}

test("an INVALID_PARAMS payload is quarantined at once and the next row persists in the same pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const timers = fakeTimers();
  const logs = [];
  const outbox = new PersistenceOutbox(
    dir,
    (level, message, data) => {
      logs.push({ level, message, data });
    },
    { now: () => now.value, setTimer: timers.setTimer, clearTimer: timers.clearTimer },
  );
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params.message.id);
    if (params.message.id === "invalid") {
      throw rpcError(
        "Error: invalid type: floating point `1234.567`, expected i64 at line 1 column 1",
        "INVALID_PARAMS",
      );
    }
  });
  // Both rows are queued behind an unavailable host, so the fence's own pass
  // meets the bad head and reports the quarantine honestly.
  await outbox.enqueue(
    { key: "message:s1:invalid", sessionId: "s1", message: { id: "invalid" } },
    () => null,
  );
  await outbox.enqueue(
    { key: "message:s2:valid", sessionId: "s2", message: { id: "valid" } },
    () => null,
  );
  assert.equal(outbox.size(), 2);
  const fence = await outbox.waitForSession("s1", () => host);
  assert.deepEqual(
    fence,
    { remaining: 0, paused: false, failed: 1 },
    "a payload refusal is a genuine persistence failure, not a clean write",
  );
  await settle();
  await outbox.flush(() => host);
  await settle();

  assert.equal(outbox.size(), 0, "the deterministic refusal never blocks the queue");
  assert.deepEqual(
    calls,
    ["invalid", "valid"],
    "the bad head is refused once, then the next session's row writes without a backoff",
  );
  assert.equal(timers.pending().length, 0, "a payload refusal schedules no retry");
  const dead = JSON.parse(await readFile(join(dir, DEAD_LETTER_FILE), "utf8"));
  assert.deepEqual(
    dead.map((entry) => entry.key),
    ["message:s1:invalid"],
  );
  assert.match(dead[0].reason, /expected i64/);
  assert.equal(dead[0].message.id, "invalid", "the quarantined payload is kept verbatim");
  assert.ok(
    logs.some(
      (row) =>
        row.message === "session persistence flush quarantined invalid payload" &&
        row.data?.code === "INVALID_PARAMS",
    ),
    "the invalid quarantine is observable with its typed code",
  );
});

test("an INTERNAL host failure keeps its retry budget instead of being called a bad payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const timers = fakeTimers();
  const logs = [];
  const outbox = new PersistenceOutbox(
    dir,
    (level, message, data) => {
      logs.push({ level, message, data });
    },
    { now: () => now.value, setTimer: timers.setTimer, clearTimer: timers.clearTimer },
  );
  const host = mockHost(async () => {
    throw rpcError("Error: host overloaded", "INTERNAL");
  });
  await outbox.enqueue(
    { key: "message:s1:1", sessionId: "s1", message: { id: "1" } },
    () => host,
  );
  await settle();
  await settle();

  assert.equal(outbox.size(), 1, "a transient host failure keeps the row queued");
  assert.equal(timers.pending().length, 1, "the transient failure owns one retry");
  assert.equal(timers.pending()[0].delayMs, 5_000);
  assert.ok(
    !logs.some((row) => row.message === "session persistence flush quarantined invalid payload"),
    "host trouble is never relabelled as an invalid payload",
  );
});

test("the owned timer retries a transiently failing head without a new enqueue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const timers = fakeTimers();
  const calls = [];
  let hostUp = false;
  const host = mockHost(async (_method, params) => {
    calls.push(params.message.id);
    if (!hostUp) throw rpcError("host pipe closed", "HOST_UNAVAILABLE");
  });
  const outbox = new PersistenceOutbox(dir, silent, {
    now: () => now.value,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    () => host,
  );
  await settle();
  await settle();
  assert.equal(outbox.size(), 1, "the row waits for the retry window");
  assert.equal(timers.pending().length, 1, "exactly one retry is scheduled");

  // Nothing else wakes the outbox: no caller flush, no second enqueue.
  hostUp = true;
  now.value += timers.pending()[0].delayMs;
  const scheduled = timers.pending()[0];
  scheduled.handle.cleared = true;
  scheduled.callback();
  await settle();
  await settle();

  assert.equal(outbox.size(), 0, "the timer's own drain wrote the row");
  assert.deepEqual(calls, ["a", "a"], "one retry attempt after the backoff");
  assert.equal(timers.pending().length, 0, "a successful write clears the schedule");
});

test("dispose cancels the owned retry timer and a later enqueue is refused, not reported saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const timers = fakeTimers();
  const host = mockHost(async () => {
    throw rpcError("host pipe closed", "HOST_UNAVAILABLE");
  });
  const outbox = new PersistenceOutbox(dir, silent, {
    now: () => now.value,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    () => host,
  );
  await settle();
  await settle();
  assert.equal(timers.pending().length, 1);

  outbox.dispose();
  assert.equal(timers.pending().length, 0, "shutdown leaves no live retry timer");
  await assert.rejects(
    outbox.enqueue(
      { key: "message:s2:b", sessionId: "s2", message: { id: "b" } },
      () => host,
    ),
    /disposed/,
  );
  assert.equal(outbox.size(), 1, "the durable row stays on disk for the next launch");
});

test("a retry that fires into a host restart keeps its own recheck instead of losing autonomy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const timers = fakeTimers();
  const calls = [];
  let live = null;
  const liveHost = mockHost(async (_method, params) => {
    calls.push(params.message.id);
  });
  // `getHost()` returns null while the sidecar is restarting: the queue must
  // not make an RPC against a dead pipe, but it also must not stop asking.
  const getHost = () => live;
  const outbox = new PersistenceOutbox(dir, silent, {
    now: () => now.value,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    getHost,
  );
  await settle();
  await settle();

  assert.equal(outbox.size(), 1, "the row waits for a live host");
  assert.deepEqual(calls, [], "no append is attempted against a dead host");
  assert.equal(timers.pending().length, 1, "the paused drain owns exactly one recheck");
  assert.equal(timers.pending()[0].delayMs, 5_000, "the recheck is the bounded backoff step");

  // A scoped read while the host is down answers honestly and at once.
  const fence = await outbox.waitForSession("s1", getHost);
  assert.deepEqual(fence, { remaining: 1, paused: true, failed: 0 });
  assert.equal(timers.pending().length, 1, "still one recheck, replaced rather than stacked");

  // The timer fires while the host is still restarting: same recheck, no
  // attempt spent, no quarantine, still no RPC.
  now.value += timers.pending()[0].delayMs;
  const duringRestart = timers.pending()[0];
  duringRestart.handle.cleared = true;
  duringRestart.callback();
  await settle();
  await settle();

  assert.equal(outbox.size(), 1, "host trouble never quarantines the row");
  assert.deepEqual(calls, [], "the recheck makes no RPC while the host is down");
  assert.equal(timers.pending().length, 1, "the fired recheck arms the next one");
  await assert.rejects(
    readFile(join(dir, DEAD_LETTER_FILE), "utf8"),
    /ENOENT/,
    "an unavailable host is not a payload refusal, so nothing is quarantined",
  );

  // Shutdown while the host is down leaves no live timer behind.
  const haltedTimers = fakeTimers();
  const halted = new PersistenceOutbox(dir, silent, {
    now: () => now.value,
    setTimer: haltedTimers.setTimer,
    clearTimer: haltedTimers.clearTimer,
  });
  await halted.enqueue(
    { key: "message:s2:b", sessionId: "s2", message: { id: "b" } },
    () => null,
  );
  await settle();
  await settle();
  assert.equal(haltedTimers.pending().length, 1);
  halted.dispose();
  assert.equal(
    haltedTimers.pending().length,
    0,
    "dispose cancels the recheck while the host is down",
  );

  // No new enqueue and no caller flush: the recheck alone drains once the host
  // is back, and the row persists.
  live = liveHost;
  now.value += timers.pending()[0].delayMs;
  const afterRestart = timers.pending()[0];
  afterRestart.handle.cleared = true;
  afterRestart.callback();
  await settle();
  await settle();

  assert.equal(outbox.size(), 0, "the recheck's own drain wrote the row");
  assert.deepEqual(calls, ["a"], "exactly one append for the recovered row");
  assert.equal(timers.pending().length, 0, "a successful write clears the schedule");
  // The emptied queue is rewritten in place (truncate, then write), so a read
  // landing inside that window sees a zero-length file. Poll a bounded number
  // of settle cycles for the persisted clear marker instead of racing the
  // write; the assertion is the durable outcome, not the read timing.
  let persisted = "";
  for (let attempt = 0; attempt < 200 && !persisted.trim(); attempt += 1) {
    await settle();
    persisted = await readFile(join(dir, "session-message-outbox.json"), "utf8").catch(() => "");
  }
  assert.equal(persisted.trim(), "[]", "the drained queue is persisted as cleared");
});
