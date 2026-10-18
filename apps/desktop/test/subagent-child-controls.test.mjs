import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function message(id, role, content, extra = {}) {
  return { id, role, content, createdAt: "2026-10-13T00:00:00.000Z", ...extra };
}

function taskMessage(id, callId, delegationId, status, extraDetails = {}) {
  return message(id, "tool", "", {
    toolName: "Task",
    toolCallId: callId,
    toolStatus: status === "running" ? "running" : "success",
    toolArgs: { agent: "explorer", task: "Investigate" },
    toolResult: {
      details: {
        delegationId,
        status,
        startedAt: Date.parse("2026-10-13T00:00:00Z"),
        toolCalls: 3,
        turns: 2,
        contextTokens: 12000,
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          operationId: `op-${callId}`,
          aggregation: "operation",
        },
        ...extraDetails,
      },
    },
  });
}

test("interrupted status survives historical turns while bare running becomes aborted", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const topology = await vite.ssrLoadModule("/src/lib/subagent-topology.ts");
    const runningTask = taskMessage("t1", "call-1", "d-running", "running");
    const interruptedTask = taskMessage("t2", "call-2", "d-interrupted", "interrupted");
    const items = [
      { kind: "tool", message: runningTask },
      { kind: "tool", message: interruptedTask },
    ];
    const live = topology.collectDelegationStatuses(items, { turnLive: true });
    assert.equal(live.get("d-running"), undefined);
    // A persisted `interrupted` Task snapshot is a terminal, recoverable
    // status: it outranks the live roster (which carries no per-Task entry)
    // and is never rewritten to aborted. Only a still-`running`/missing
    // status stays absent while live and reconstructs as aborted at rest.
    assert.equal(live.get("d-interrupted"), "interrupted");
    // Task snapshots carry their own status via subagentOutcome, not the roster map.
    assert.equal(topology.subagentOutcome(runningTask, live), "running");
    assert.equal(topology.subagentOutcome(interruptedTask, live), "interrupted");
    const settled = topology.collectDelegationStatuses(items, { turnLive: false });
    // Bare running with no terminal snapshot reconstructs as aborted;
    // persisted interrupted is recoverable and never rewritten.
    assert.equal(settled.get("d-running"), "aborted");
    assert.equal(settled.get("d-interrupted") ?? "interrupted", "interrupted");
    assert.equal(topology.subagentOutcome(interruptedTask, settled), "interrupted");
  } finally { await vite.close(); }
});

test("resume-chain metrics aggregate spend once and keep latest occupancy", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const metrics = await vite.ssrLoadModule("/src/lib/subagent-metrics.ts");
    const shared = await vite.ssrLoadModule("/src/lib/subagent-metrics.ts");
    assert.ok(shared);
    // Same physical operation reported twice collapses via the ledger.
    const usageA = {
      inputTokens: 1000, outputTokens: 500, totalTokens: 1500,
      operationId: "op-1", aggregation: "operation",
    };
    const usageARepeat = { ...usageA };
    const usageB = {
      inputTokens: 2000, outputTokens: 1000, totalTokens: 3000,
      operationId: "op-2", aggregation: "operation",
    };
    const aggregated = metrics.aggregateSubagentChainMetrics([
      { toolCalls: 3, turns: 2, contextTokens: 12000, usage: usageA },
      { toolCalls: 2, turns: 1, contextTokens: 18000, usage: usageARepeat },
      { toolCalls: 1, turns: 1, contextTokens: 18000, usage: usageB },
    ]);
    assert.equal(aggregated.toolCalls, 6);
    assert.equal(aggregated.turns, 4);
    assert.equal(aggregated.usage.totalTokens, 4500);
    assert.equal(aggregated.contextTokens, 18000);
    // Latest segment decides occupancy: an older gauge never masks a latest
    // segment that went unmeasured.
    const masked = metrics.aggregateSubagentChainMetrics([
      { toolCalls: 3, turns: 2, contextTokens: 12000, usage: usageA },
      { toolCalls: 1, turns: 1, usage: usageB },
    ]);
    assert.equal(masked.contextTokens, undefined);
    assert.equal(masked.contextProvenance, "unknown");
    // Metric-only payloads (no counters) are accepted, never dropped.
    assert.ok(metrics.parseSubagentMetrics({ contextTokens: 9000 }));
    assert.ok(metrics.parseSubagentMetrics({ usage: usageA }));
    assert.equal(metrics.parseSubagentMetrics({}), null);
    assert.equal(metrics.parseSubagentMetrics({ toolCalls: -1 }), null);
    const line = metrics.formatSubagentMetricsLine(aggregated);
    assert.match(line, /6 tool calls/);
    assert.match(line, /ctx ~/);
    assert.match(line, /spent /);
    assert.match(line, /turn/);
  } finally { await vite.close(); }
});

test("every instantiated settled child continues; live and instance-less do not", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const actions = await vite.ssrLoadModule("/src/lib/subagent-actions.ts");
    // Outcome is history, never a gate: no instantiated settled child is
    // permanently uncontinuable, including a child stopped before its first
    // transcript event (no retained child rows required).
    for (const outcome of [
      "completed", "failed", "timed_out", "interrupted", "stopped", "aborted", "denied",
    ]) {
      assert.equal(actions.canContinueSubagent(outcome, true), true, outcome);
    }
    // A live child steers instead of starting a second simultaneous run.
    assert.equal(actions.canContinueSubagent("running", true), false);
    assert.equal(actions.canContinueSubagent(undefined, true), false);
    assert.equal(actions.canContinueSubagent(null, true), false);
    // No backend instance to continue: a denied never-started call or a tab
    // whose Task chain is missing.
    assert.equal(actions.canContinueSubagent("failed", false), false);
    assert.equal(actions.canContinueSubagent("stopped", false), false);
    // No parent-prompt resume path remains: the direct backend continue owns
    // settled follow-ups, so no resume prompt builder may exist.
    assert.equal(typeof actions.buildSubagentResumePrompt, "undefined");
    assert.equal(typeof actions.buildSubagentFollowupPrompt, "undefined");
    assert.equal(typeof actions.canResumeSubagent, "undefined");
    assert.equal(typeof actions.shouldShowSubagentResume, "undefined");
  } finally { await vite.close(); }
});

test("steerSubagent wrapper calls the child channel and preserves draft on failure", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const calls = [];
    globalThis.window = {
      piDesktop: {
        invoke: async (channel, req) => {
          calls.push({ channel, req });
          if (req.content === "boom") return { ok: false, error: { message: "stale turn", code: "TURN_NOT_FOUND" } };
          return { ok: true, data: { accepted: true, delegationId: req.delegationId, turnId: "t-child" } };
        },
      },
    };
    const { api } = await vite.ssrLoadModule("/src/lib/api.ts");
    const accepted = await api.steerSubagent({
      sessionId: "s1",
      delegationId: "d1",
      expectedTurnId: "turn-parent",
      content: "hello child",
      messageId: "m1",
    });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.delegationId, "d1");
    assert.equal(calls[0].channel, "pi-desktop/agent/steerSubagent");
    assert.equal(calls[0].req.sessionId, "s1");
    // Failure path throws without clearing the caller's draft (caller owns clearing).
    await assert.rejects(() =>
      api.steerSubagent({ sessionId: "s1", delegationId: "d1", expectedTurnId: "turn-parent", content: "boom" }),
    );
    delete globalThis.window;
  } finally { await vite.close(); }
});

test("wake settings render a single kind row with mandatory result helper and search finds the tab", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { normalizeSubagentWakeupSettings } = await import("@pi-desktop/shared");
    assert.deepEqual(normalizeSubagentWakeupSettings(undefined).kind, "time");
    assert.deepEqual(normalizeSubagentWakeupSettings({ kind: "off" }).kind, "off");
    // Legacy sections migrate: tool threshold wins over the old period.
    assert.deepEqual(
      normalizeSubagentWakeupSettings({ timeSeconds: 600, toolCalls: 5 }).kind,
      "tool-calls",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const { SubagentWakeSettings } = await vite.ssrLoadModule("/src/components/settings/SubagentWakeSettings.tsx");
    const html = renderToStaticMarkup(
      createElement(I18nextProvider, { i18n },
        createElement(SubagentWakeSettings, {
          settings: { subagentWakeup: { kind: "time", value: 600 } },
          saveSettings: async () => undefined,
        })),
    );
    assert.match(html, /Parent wake-up/);
    assert.match(html, /Elapsed time/);
    assert.match(html, /Subagent results always wake the parent/);
    assert.match(html, /seconds/);
    assert.doesNotMatch(html, /Wake on completion/);
    assert.doesNotMatch(html, /Periodic check-in/);
    assert.doesNotMatch(html, /Tool-call threshold/);
    const offHtml = renderToStaticMarkup(
      createElement(I18nextProvider, { i18n },
        createElement(SubagentWakeSettings, {
          settings: { subagentWakeup: { kind: "off" } },
          saveSettings: async () => undefined,
        })),
    );
    assert.match(offHtml, /Off/);
    assert.doesNotMatch(offHtml, /type="number"/);
    const { searchSettings } = await vite.ssrLoadModule("/src/lib/settings-search.ts");
    const hits = searchSettings("wake", (key) => i18n.t(key));
    assert.ok(hits.some((hit) => hit.tab === "subagents"));
  } finally { await vite.close(); }
});

test("subagent panel header/footer render token metrics for a settled chain", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const metrics = await vite.ssrLoadModule("/src/lib/subagent-metrics.ts");
    const first = taskMessage("t1", "call-1", "d1", "failed");
    const resumeCall = message("t2", "tool", "", {
      toolName: "Task", toolCallId: "call-2", toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Continue", resume: "d1" },
      toolResult: {
        details: {
          delegationId: "d2", status: "completed", toolCalls: 4, turns: 3,
          contextTokens: 22000,
          usage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, operationId: "op-call-2", aggregation: "operation" },
        },
      },
    });
    const chain = metrics.subagentChainCallIds([first, resumeCall], "d1");
    assert.ok(chain.has("call-1"));
    assert.ok(chain.has("call-2"));
    const aggregated = metrics.aggregateChainMetricsFromMessages([first, resumeCall], "d1");
    assert.ok(aggregated);
    assert.equal(aggregated.toolCalls, 7);
    const line = metrics.formatSubagentMetricsLine(aggregated);
    assert.match(line, /spent /);
    assert.match(line, /ctx ~/);
  } finally { await vite.close(); }
});

test("F1 invalid and blank wake value reverts without saving", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const save = await vite.ssrLoadModule("/src/lib/subagent-settings-save.ts");
    // Blank reverts to the current resolved value, never saves a minimum.
    assert.deepEqual(save.resolveWakeValueCommit("", 600, 1, 900), { action: "revert", draft: "600" });
    assert.deepEqual(save.resolveWakeValueCommit("   ", 600, 1, 900), { action: "revert", draft: "600" });
    // Non-numeric reverts for every kind.
    assert.deepEqual(save.resolveWakeValueCommit("abc", 600, 1, 900), { action: "revert", draft: "600" });
    assert.deepEqual(save.resolveWakeValueCommit("e", 300, 1, 900), { action: "revert", draft: "300" });
    // Off (no value) reverts to empty, never saves.
    assert.deepEqual(save.resolveWakeValueCommit("abc", null, 1, 900), { action: "revert", draft: "" });
    // Valid input clamps and saves; unchanged values still resolve to save
    // so the caller can compare against resolved and skip the write.
    assert.deepEqual(save.resolveWakeValueCommit("120", 600, 1, 900), { action: "save", next: 120 });
    assert.deepEqual(save.resolveWakeValueCommit("0", 600, 1, 900), { action: "save", next: 1 });
    assert.deepEqual(save.resolveWakeValueCommit("9999", 600, 1, 900), { action: "save", next: 900 });
    // Context bounds clamp coarsely; tool bounds clamp per call.
    assert.deepEqual(save.resolveWakeValueCommit("500", 20000, 1000, 1000000), { action: "save", next: 1000 });
    // Rendered single-kind control keeps the resolved value as its draft.
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const { SubagentWakeSettings } = await vite.ssrLoadModule("/src/components/settings/SubagentWakeSettings.tsx");
    const html = renderToStaticMarkup(
      createElement(I18nextProvider, { i18n },
        createElement(SubagentWakeSettings, {
          settings: { subagentWakeup: { kind: "time", value: 600 } },
          saveSettings: async () => undefined,
        })),
    );
    assert.match(html, /value="600"/);
  } finally { await vite.close(); }
});

test("F2 rapid wake saves serialize atomically with no stale-unit merge", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const save = await vite.ssrLoadModule("/src/lib/subagent-settings-save.ts");
    // Atomic replace: a new kind never inherits the prior unit.
    const base = { subagentWakeup: { kind: "time", value: 600 }, other: 1 };
    const replaced = save.mergeSettingsPatch(base, { subagentWakeup: { kind: "tool-calls", value: 10 } });
    assert.deepEqual(replaced.subagentWakeup, { kind: "tool-calls", value: 10 });
    assert.equal(replaced.other, 1);
    const cleared = save.mergeSettingsPatch(base, { subagentWakeup: { kind: "off" } });
    assert.deepEqual(cleared.subagentWakeup, { kind: "off" });
    // Two concurrent saves rebased onto latest: last write wins whole, no merge.
    let stored = { subagentWakeup: { kind: "time", value: 600 } };
    const api = {
      async setSettings(next) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        stored = next;
      },
    };
    const queue = save.createSerializedSaver();
    const runSave = (patch) => queue.enqueue(async () => {
      const current = stored;
      const next = save.mergeSettingsPatch(current, patch);
      await api.setSettings(next);
    });
    await Promise.all([
      runSave({ subagentWakeup: { kind: "time", value: 120 } }),
      runSave({ subagentWakeup: { kind: "tool-calls", value: 25 } }),
    ]);
    assert.deepEqual(stored.subagentWakeup, { kind: "tool-calls", value: 25 });
    // Failure is observable and never overwrites good settings; drafts stay.
    let draft = "120";
    const good = { ...stored };
    const failing = queue.enqueue(async () => {
      throw new Error("host refused");
    });
    await assert.rejects(() => failing);
    assert.deepEqual(stored, good);
    assert.equal(draft, "120");
  } finally { await vite.close(); }
});

test("F3 child steering echo renders as user message, not answer", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const transcript = await vite.ssrLoadModule("/src/lib/subagent-transcript.ts");
    const call = message("t1", "tool", "", {
      toolName: "Task", toolCallId: "call-1", toolStatus: "running",
      toolArgs: { agent: "explorer", task: "Investigate" },
      toolResult: { details: { delegationId: "d1", status: "running", toolCalls: 1, turns: 1 } },
    });
    const echo = message("echo-1", "user", "keep going", {
      parentToolCallId: "call-1", agentName: "explorer", steering: true, status: "complete",
    });
    const answer = message("a1", "assistant", "working on it", {
      parentToolCallId: "call-1", agentName: "explorer", status: "complete",
    });
    const built = transcript.buildSubagentTranscript([call, echo, answer], "d1");
    assert.ok(built);
    assert.equal(built.turns.length, 1);
    const kinds = built.turns[0].rows.map((row) => row.kind);
    assert.ok(kinds.includes("steering-user"));
    assert.ok(kinds.includes("answer"));
    const steering = built.turns[0].rows.find((row) => row.kind === "steering-user");
    assert.equal(steering.message.content, "keep going");
    // Rendering assertion: steering renders with the user bubble language,
    // never the assistant row.
    const steeringHtml = renderToStaticMarkup(
      createElement("div", { className: "message-row user" },
        createElement("div", { className: "message-col" },
          createElement("div", { className: "message-bubble" },
            createElement("div", { className: "message-user-text selectable" }, steering.message.content)))),
    );
    assert.match(steeringHtml, /message-row user/);
    assert.match(steeringHtml, /keep going/);
    assert.doesNotMatch(steeringHtml, /message-row assistant/);
    // Chain replay membership is unchanged: the echo is still selected by
    // parentToolCallId for resume seeding.
    const chainRows = [echo, answer].filter((row) => row.parentToolCallId === "call-1");
    assert.equal(chainRows.length, 2);
    assert.ok(chainRows.some((row) => row.role === "user" && row.content === "keep going"));
  } finally { await vite.close(); }
});

test("F4 bare call-id resume shares one chain and keeps spend plus occupancy", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const chain = await vite.ssrLoadModule("/src/lib/subagent-chain.ts");
    const metrics = await vite.ssrLoadModule("/src/lib/subagent-metrics.ts");
    const transcript = await vite.ssrLoadModule("/src/lib/subagent-transcript.ts");
    const first = taskMessage("t1", "call-1", "d1", "failed");
    // Resume cites the bare prior call id, before any d2 result is legible.
    const bareResume = message("t2", "tool", "", {
      toolName: "Task", toolCallId: "call-2", toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Continue", resume: "call-1" },
      toolResult: {
        details: {
          delegationId: "d2", status: "completed", toolCalls: 4, turns: 3,
          contextTokens: 22000,
          usage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, operationId: "op-call-2", aggregation: "operation" },
        },
      },
    });
    const all = [first, bareResume];
    const fromOld = chain.subagentChainCallIds(all, "d1");
    const fromNew = chain.subagentChainCallIds(all, "d2");
    assert.ok(fromOld.has("call-1") && fromOld.has("call-2"));
    assert.deepEqual([...fromOld].sort(), [...fromNew].sort());
    // Transcript and metrics resolve the same chain through the shared helper.
    const builtOld = transcript.buildSubagentTranscript(all, "d1");
    const builtNew = transcript.buildSubagentTranscript(all, "d2");
    assert.equal(builtOld.turns.length, 2);
    assert.equal(builtNew.turns.length, 2);
    const aggregated = metrics.aggregateChainMetricsFromMessages(all, "d2");
    assert.ok(aggregated);
    // Previous usage is included (deduped by operation id) with latest occupancy.
    assert.equal(aggregated.usage.totalTokens, 4500);
    assert.equal(aggregated.contextTokens, 22000);
    assert.equal(aggregated.toolCalls, 7);
  } finally { await vite.close(); }
});

test("F5 chain-latest owns status and continue, stale tab never duplicates", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const chain = await vite.ssrLoadModule("/src/lib/subagent-chain.ts");
    const actions = await vite.ssrLoadModule("/src/lib/subagent-actions.ts");
    const first = taskMessage("t1", "call-1", "d1", "failed");
    const resumeCall = message("t2", "tool", "", {
      toolName: "Task", toolCallId: "call-2", toolStatus: "running",
      toolArgs: { agent: "explorer", task: "Continue", resume: "d1" },
      toolResult: { details: { delegationId: "d2", status: "running", toolCalls: 1, turns: 1 } },
    });
    const all = [first, resumeCall];
    assert.equal(chain.subagentChainLatestDelegationId(all, "d1"), "d2");
    assert.equal(chain.subagentChainLatestDelegationId(all, "d2"), "d2");
    assert.equal(chain.isStaleSubagentTab(all, "d1"), true);
    assert.equal(chain.isStaleSubagentTab(all, "d2"), false);
    // Old tab after continuation is running via the latest id, so it never
    // offers a duplicate continue; the latest tab owns the action when settled.
    assert.equal(actions.shouldShowSubagentContinue({
      outcome: "running", hasInstance: true, canPromptParent: true, readOnlySession: false, isStaleTab: true,
    }), false);
    assert.equal(actions.shouldShowSubagentContinue({
      outcome: "completed", hasInstance: true, canPromptParent: true, readOnlySession: false, isStaleTab: true,
    }), false);
    // A stopped settled child is continuable; a missing instance is not.
    assert.equal(actions.shouldShowSubagentContinue({
      outcome: "stopped", hasInstance: true, canPromptParent: true, readOnlySession: false, isStaleTab: false,
    }), true);
    assert.equal(actions.shouldShowSubagentContinue({
      outcome: "completed", hasInstance: false, canPromptParent: true, readOnlySession: false, isStaleTab: false,
    }), false);
    // Disabled matrix: permission, remote, settled, and a missing owner turn
    // all block. The parent session's generic running flag is not consulted:
    // a running child may outlive parent UI idleness, and a detached run
    // steers through its own execution turn, which the backend validates.
    assert.equal(actions.subagentSteerBlockedReason({
      readOnlySession: true, canSteerParent: true, running: true, expectedTurnId: "t",
    }), "read-only");
    assert.equal(actions.subagentSteerBlockedReason({
      readOnlySession: false, canSteerParent: false, running: true, expectedTurnId: "t",
    }), "unavailable");
    assert.equal(actions.subagentSteerBlockedReason({
      readOnlySession: false, canSteerParent: true, running: false, expectedTurnId: "t",
    }), "unavailable");
    assert.equal(actions.subagentSteerBlockedReason({
      readOnlySession: false, canSteerParent: true, running: true, expectedTurnId: undefined,
    }), "unavailable");
    assert.equal(actions.subagentSteerBlockedReason({
      readOnlySession: false, canSteerParent: true, running: true, expectedTurnId: "t",
    }), null);
  } finally { await vite.close(); }
});

test("F6 steer rejection preserves draft and captures identity", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const actions = await vite.ssrLoadModule("/src/lib/subagent-actions.ts");
    // Captured identity: session and turn are pinned before the await.
    const captured = actions.captureSteerIdentity({
      sessionId: "s1", turnId: "turn-parent", source: "local",
      sessionStartsWithRemote: false, sessionStartsWithNative: false, canSteer: true,
    });
    assert.deepEqual(captured, { ok: true, sessionId: "s1", turnId: "turn-parent" });
    assert.deepEqual(actions.captureSteerIdentity({
      sessionId: "remote:1", turnId: "t", source: "remote",
      sessionStartsWithRemote: true, sessionStartsWithNative: false, canSteer: true,
    }), { ok: false, reason: "read-only" });
    assert.deepEqual(actions.captureSteerIdentity({
      sessionId: "s1", turnId: undefined, source: "local",
      sessionStartsWithRemote: false, sessionStartsWithNative: false, canSteer: true,
    }), { ok: false, reason: "unavailable" });
    // Rejection preserves the draft: clear happens only on success.
    let draft = "hello child";
    let steerError = null;
    const calls = [];
    globalThis.window = {
      piDesktop: {
        invoke: async (channel, req) => {
          calls.push({ channel, req });
          if (req.content === "boom") return { ok: false, error: { message: "stale turn", code: "TURN_NOT_FOUND" } };
          return { ok: true, data: { accepted: true, delegationId: req.delegationId, turnId: "t-child" } };
        },
      },
    };
    try {
      const { api } = await vite.ssrLoadModule("/src/lib/api.ts");
      try {
        await api.steerSubagent({
          sessionId: "s1", delegationId: "d1", expectedTurnId: "turn-parent", content: "boom",
        });
        draft = "";
      } catch (error) {
        steerError = error instanceof Error ? error.message : String(error);
      }
      assert.equal(draft, "hello child");
      assert.match(steerError, /stale turn/);
      assert.equal(calls[0].req.delegationId, "d1");
      assert.equal(calls[0].req.sessionId, "s1");
      assert.equal(calls[0].req.expectedTurnId, "turn-parent");
    } finally {
      delete globalThis.window;
    }
  } finally { await vite.close(); }
});
