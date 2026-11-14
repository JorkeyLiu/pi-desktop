import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionDetail, UiMessage } from "./types.js";
import {
  delegationHistoryScope,
  MAIN_HISTORY_SCOPE,
  normalizeSessionHistoryScope,
  sameHistoryScope,
} from "./session-history.js";

const message = (id: string, extra: Partial<UiMessage> = {}): UiMessage => ({
  id,
  role: "assistant",
  content: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

test("a read without a scope keeps the legacy full-transcript meaning", () => {
  for (const value of [undefined, null, {}, { kind: "unknown" }, "main", 1, []]) {
    assert.equal(normalizeSessionHistoryScope(value), undefined);
  }
});

test("main scope is one shared frozen value", () => {
  assert.deepEqual(normalizeSessionHistoryScope({ kind: "main" }), { kind: "main" });
  assert.equal(normalizeSessionHistoryScope({ kind: "main" }), MAIN_HISTORY_SCOPE);
  assert.ok(Object.isFrozen(MAIN_HISTORY_SCOPE));
});

test("delegation scope trims its identity and rejects empty or oversized ids", () => {
  assert.deepEqual(normalizeSessionHistoryScope({ kind: "delegation", id: " d1 " }), {
    kind: "delegation",
    id: "d1",
  });
  assert.equal(normalizeSessionHistoryScope({ kind: "delegation", id: "   " }), undefined);
  assert.equal(normalizeSessionHistoryScope({ kind: "delegation" }), undefined);
  assert.equal(normalizeSessionHistoryScope({ kind: "delegation", id: 7 }), undefined);
  assert.equal(
    normalizeSessionHistoryScope({ kind: "delegation", id: "x".repeat(513) }),
    undefined,
  );
});

test("scope equality is identity-based: main matches main, chains match their id", () => {
  assert.equal(sameHistoryScope(MAIN_HISTORY_SCOPE, { kind: "main" }), true);
  assert.equal(sameHistoryScope(delegationHistoryScope("d1"), delegationHistoryScope("d1")), true);
  assert.equal(sameHistoryScope(delegationHistoryScope("d1"), delegationHistoryScope("d2")), false);
  assert.equal(sameHistoryScope(MAIN_HISTORY_SCOPE, delegationHistoryScope("d1")), false);
  assert.equal(sameHistoryScope(undefined, undefined), true);
  assert.equal(sameHistoryScope(undefined, MAIN_HISTORY_SCOPE), false);
});

test("a scoped detail carries its echoed scope and optional chain context", () => {
  const detail: SessionDetail = {
    id: "s1",
    title: "Delegation",
    mode: "agent",
    thinkingLevel: "off",
    permissionMode: "inherit",
    messageCount: 4000,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    messages: [message("child-1", { role: "tool", parentToolCallId: "call-1" })],
    messageStart: 0,
    hasMoreBefore: true,
    historyScope: { kind: "delegation", id: "d1" },
    historyContext: [message("task-1", { role: "tool", toolName: "Task", toolCallId: "call-1" })],
  };
  assert.deepEqual(detail.historyScope, { kind: "delegation", id: "d1" });
  assert.equal(detail.historyContext?.length, 1);
  // The legacy shape still compiles: no scope, no context, unchanged fields.
  const legacy: SessionDetail = { ...detail, historyScope: undefined, historyContext: undefined };
  assert.equal(legacy.historyScope, undefined);
});
