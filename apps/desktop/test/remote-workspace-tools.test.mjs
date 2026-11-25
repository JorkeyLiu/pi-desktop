/**
 * The remote-workspace tool relay admits one concrete call and then owns the
 * local await for it. Its only cancellation fact is the call's own
 * `(sessionId, toolCallId)` from the shared per-call registry, so a stop reaches
 * a remote dispatch regardless of turn liveness, tool name or class.
 *
 * These are lifecycle rules on the real relay interface: no sleeps, only
 * controlled deferred remote results.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createRemoteWorkspaceToolRelay } = await import(
  "../electron/main/remote/remote-workspace-tools.ts"
);
const { createToolCancellationRegistry } = await import(
  "../electron/main/runtime/tool-cancellations.ts"
);

const request = {
  requestId: "request",
  sessionId: "session",
  turnId: "turn",
  toolCallId: "tool",
  toolName: "Read",
  args: { path: "README.md" },
  remoteWorkspace: { hostKey: "ssh", path: "/work/app" },
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(execute) {
  const sent = [];
  const replies = [];
  const aborted = [];
  let current = true;
  const cancellations = createToolCancellationRegistry();
  const relay = createRemoteWorkspaceToolRelay(
    {
      call: async (method, params) => {
        replies.push({ method, params });
      },
    },
    {
      getBoot: () => ({
        executeWorkspaceTool: async (input) => {
          sent.push(input);
          return execute(input);
        },
        abortWorkspaceTool: async (input) => {
          aborted.push(input);
        },
      }),
      isCurrent: () => current,
      cancellations,
      log: () => {},
    },
  );
  return {
    relay,
    sent,
    replies,
    aborted,
    cancellations,
    replace: () => {
      current = false;
    },
  };
}

test("one admitted call sends only its own workspace tool and completes locally", async () => {
  const f = fixture(() => ({ ok: true, content: "remote README" }));
  await f.relay.execute(request);
  assert.deepEqual(f.sent, [
    {
      hostKey: "ssh",
      path: "/work/app",
      sessionId: "session",
      turnId: "turn",
      toolCallId: "tool",
      toolName: "Read",
      args: { path: "README.md" },
    },
  ]);
  assert.deepEqual(f.replies, [
    {
      method: "tools.remoteComplete",
      params: { requestId: "request", result: { ok: true, content: "remote README" } },
    },
  ]);
});

test("a call is dispatched on its own identity when it names no turn", async () => {
  const { turnId: _turnId, ...withoutTurn } = request;
  const f = fixture(() => ({ ok: true, content: "remote README" }));
  await f.relay.execute(withoutTurn);
  assert.equal(f.sent.length, 1);
  assert.ok(!("turnId" in f.sent[0]), "no turn attribution is invented");
  assert.equal(f.sent[0].toolCallId, "tool");
  assert.equal(f.replies[0].params.result.ok, true);
});

test("a call is dispatched on its own identity when its turn already ended", async () => {
  const f = fixture(() => ({ ok: true, content: "remote README" }));
  await f.relay.execute({ ...request, turnId: "finished-turn" });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].turnId, "finished-turn", "attribution is forwarded, not judged");
  assert.equal(f.replies[0].params.result.ok, true);
});

test("the relay adds no tool-name or class gate of its own", async () => {
  const f = fixture(() => ({ ok: true, content: "forwarded" }));
  await f.relay.execute({ ...request, toolName: "AnyTool" });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].toolName, "AnyTool");
  assert.equal(f.replies[0].params.result.ok, true);
});

test("a cancel that arrives before the call starts leaves no remote side effect", async () => {
  const f = fixture(() => assert.fail("a cancelled call must not dispatch"));
  f.relay.cancel({ sessionId: "session", toolCallId: "tool" });
  await f.relay.execute(request);
  assert.equal(f.sent.length, 0);
  assert.equal(f.aborted.length, 0);
  assert.equal(f.replies[0].params.result.errorCode, "TOOL_ABORTED");
});

test("an abort during the remote await aborts that call once and refuses its late success", async () => {
  const pendingResult = deferred();
  const f = fixture(() => pendingResult.promise);
  const pending = f.relay.execute(request);
  f.relay.cancel({ sessionId: "session", toolCallId: "tool" });
  pendingResult.resolve({ ok: true, content: "late result" });
  await pending;
  assert.deepEqual(f.aborted, [{ hostKey: "ssh", sessionId: "session", toolCallId: "tool" }]);
  assert.equal(f.replies[0].params.result.errorCode, "TOOL_ABORTED");
});

test("duplicate cancellation reports for one call abort it once", async () => {
  const pendingResult = deferred();
  const f = fixture(() => pendingResult.promise);
  const pending = f.relay.execute(request);
  // host-core reports the same stop as tools.aborted and tools.remoteAbort;
  // both must land on one call and one remote abort.
  f.cancellations.noteAbort("session", "tool");
  f.relay.cancel({ sessionId: "session", toolCallId: "tool" });
  assert.equal(f.aborted.length, 1);
  pendingResult.resolve({ ok: true, content: "late result" });
  await pending;
  assert.equal(f.replies[0].params.result.errorCode, "TOOL_ABORTED");
});

test("a replaced local Host does not receive a previous generation result", async () => {
  const pendingResult = deferred();
  const f = fixture(() => pendingResult.promise);
  const pending = f.relay.execute(request);
  f.replace();
  f.relay.dispose();
  pendingResult.resolve({ ok: true, content: "old result" });
  await pending;
  assert.equal(f.aborted.length, 1, "the live remote request is cancelled");
  assert.equal(f.replies.length, 0, "a dead generation answers nothing");
});

test("a simultaneous duplicate request is refused without taking over the live call", async () => {
  const pendingResult = deferred();
  const f = fixture(() => pendingResult.promise);
  const pending = f.relay.execute(request);
  await f.relay.execute({ ...request, requestId: "duplicate" });
  f.relay.cancel({ sessionId: "session", toolCallId: "tool" });
  pendingResult.resolve({ ok: true, content: "late result" });
  await pending;
  assert.equal(f.sent.length, 1, "only the admitted call reached the remote workspace");
  assert.equal(f.aborted.length, 1, "the live call still owns its cancellation");
  assert.equal(
    f.replies.find((reply) => reply.params.requestId === "duplicate").params.result.errorCode,
    "REMOTE_TOOL_FAILED",
  );
  assert.equal(
    f.replies.find((reply) => reply.params.requestId === "request").params.result.errorCode,
    "TOOL_ABORTED",
  );
});

test("a cancel for another session or call cannot abort an unrelated call", async () => {
  const pendingResult = deferred();
  const f = fixture(() => pendingResult.promise);
  const pending = f.relay.execute(request);
  f.relay.cancel({ sessionId: "other-session", toolCallId: "tool" });
  f.relay.cancel({ sessionId: "session", toolCallId: "other-tool" });
  assert.equal(f.aborted.length, 0);
  pendingResult.resolve({ ok: true, content: "untouched" });
  await pending;
  assert.equal(f.replies[0].params.result.ok, true);
});

test("a cancel after a call settled never reaches the call that follows it", async () => {
  const f = fixture(() => ({ ok: true, content: "done" }));
  await f.relay.execute(request);
  f.relay.cancel({ sessionId: "session", toolCallId: "tool" });
  const next = await f.relay.execute({ ...request, requestId: "next", toolCallId: "next-tool" });
  assert.equal(f.aborted.length, 0);
  assert.equal(f.sent.length, 2);
  assert.equal(f.replies.at(-1).params.result.ok, true);
  assert.equal(next, undefined);
});

test("remote failure remains an observable local tool error without fallback", async () => {
  const f = fixture(() => {
    throw Object.assign(new Error("disconnected"), { errorCode: "HOST_DISCONNECTED" });
  });
  await f.relay.execute(request);
  assert.equal(f.sent.length, 1);
  assert.equal(f.replies[0].params.result.errorCode, "HOST_DISCONNECTED");
  assert.equal(f.replies[0].params.result.content.error, "disconnected");
});
