import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function message(id, role, content, extra = {}) {
  return { id, role, content, createdAt: "2026-10-13T00:00:00.000Z", ...extra };
}

function taskMessage(id, callId, delegationId, status, extraDetails = {}) {
  return message(id, "tool", "", {
    toolName: "Task",
    toolCallId: callId,
    toolStatus: status === "running" ? "running" : "success",
    toolArgs: { agent: "explorer", task: "Investigate the cache" },
    toolResult: {
      details: {
        delegationId,
        agent: "explorer",
        status,
        startedAt: Date.parse("2026-10-13T00:00:00Z"),
        modelId: "test-model",
        thinkingLevel: "high",
        toolCalls: 1,
        turns: 1,
        ...extraDetails,
      },
    },
  });
}

function childAssistant(id, callId, usage, content = "working on it") {
  return message(id, "assistant", content, {
    parentToolCallId: callId,
    agentName: "explorer",
    status: "complete",
    ...(usage ? { usage } : {}),
  });
}

function lifecycleMessage(id, kind, entries) {
  return message(id, "tool", "", {
    toolName: kind,
    toolCallId: `lifecycle-${id}`,
    toolStatus: "success",
    toolArgs: {},
    toolResult: { details: { delegations: entries } },
  });
}

async function setup() {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const i18n = createInstance();
  // Production loads flattened catalogs (see renderer-catalogs); the tab
  // under test resolves `t("chat.subagentMetricsTurnsUnit", { count })`
  // through i18next plural rules, never a hardcoded `_one` suffix.
  await i18n.init({ lng: "en", resources: { en: { translation: flattenCatalog(catalogs.en) } } });
  const { SubagentTranscriptTab } = await vite.ssrLoadModule(
    "/src/components/workpanel/SubagentTranscriptTab.tsx",
  );
  const { SlotSessionProvider } = await vite.ssrLoadModule(
    "/src/plugins/renderer-slots/use-slots.tsx",
  );
  const { useAppStore } = await vite.ssrLoadModule("/src/stores/app-store.ts");
  const render = (delegationId) =>
    renderToStaticMarkup(
      createElement(I18nextProvider, { i18n },
        createElement(SlotSessionProvider, { sessionId: "s1" },
          createElement(SubagentTranscriptTab, { delegationId }))),
    );
  return { vite, render, useAppStore, i18n };
}

function seed(store, { session = { id: "s1", source: "local", title: "fixture" }, messages, running }) {
  Object.assign(store.getInitialState(), {
    activeSessionId: "s1",
    sessions: [session],
    messages,
    agentStatuses: running ? { s1: { currentTurnId: "turn-parent" } } : {},
    runningSessions: running ? { s1: true } : {},
    settings: { enterToSend: true },
  });
}

const opUsage = (id, total) => ({
  inputTokens: Math.round(total * 0.6),
  outputTokens: Math.round(total * 0.4),
  totalTokens: total,
  operationId: id,
  aggregation: "operation",
});

test("metrics prefer snapshot, then lifecycle, then child estimate, else unknown", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const metrics = await vite.ssrLoadModule("/src/lib/subagent-metrics.ts");
    // Snapshot wins with provenance.
    const snap = metrics.aggregateChainMetricsFromMessages(
      [taskMessage("t1", "call-1", "d1", "completed", { contextTokens: 12000, usage: opUsage("op-1", 1500) })],
      "d1",
    );
    assert.equal(snap.contextTokens, 12000);
    assert.equal(snap.contextProvenance, "snapshot");
    assert.equal(snap.contextEstimated, undefined);
    // Lifecycle fills a snapshot that never reported context.
    const noCtx = taskMessage("t1", "call-1", "d1", "completed", { usage: opUsage("op-1", 1500) });
    delete noCtx.toolResult.details.contextTokens;
    const withLifecycle = metrics.aggregateChainMetricsFromMessages(
      [noCtx, lifecycleMessage("l1", "TaskList", [{ delegationId: "d1", status: "completed", contextTokens: 9000, toolCalls: 2, turns: 1 }])],
      "d1",
    );
    assert.equal(withLifecycle.contextTokens, 9000);
    assert.equal(withLifecycle.contextProvenance, "lifecycle");
    // Child provider usage is the honest estimate, via renderer occupancy semantics.
    const legacy = taskMessage("t1", "call-1", "d1", "completed");
    delete legacy.toolResult.details.contextTokens;
    delete legacy.toolResult.details.usage;
    const child = childAssistant("a1", "call-1", { inputTokens: 8000, outputTokens: 2000, totalTokens: 10000 });
    const estimated = metrics.aggregateChainMetricsFromMessages([legacy, child], "d1");
    assert.equal(estimated.contextTokens, 10000);
    assert.equal(estimated.contextProvenance, "child");
    assert.equal(estimated.contextEstimated, true);
    // Legacy rows with no token carrier stay unknown: never hidden, never 0.
    const unknown = metrics.aggregateChainMetricsFromMessages([legacy], "d1");
    assert.equal(unknown.contextTokens, undefined);
    assert.equal(unknown.contextProvenance, "unknown");
    assert.equal(unknown.toolCalls, 1);
    // Spend is never summed as context: spend folds, occupancy stays gauge.
    const spendy = metrics.aggregateChainMetricsFromMessages(
      [taskMessage("t1", "call-1", "d1", "completed", { contextTokens: 5000, usage: opUsage("op-1", 1500) }),
        childAssistant("a1", "call-1", opUsage("op-child", 3000))],
      "d1",
    );
    assert.equal(spendy.usage.totalTokens, 4500);
    assert.equal(spendy.contextTokens, 5000);
  } finally { await vite.close(); }
});

test("spend dedups by operation and latest segment occupancy never masks missing", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const metrics = await vite.ssrLoadModule("/src/lib/subagent-metrics.ts");
    const first = taskMessage("t1", "call-1", "d1", "failed", { contextTokens: 12000, usage: opUsage("op-1", 1500) });
    const second = message("t2", "tool", "", {
      toolName: "Task", toolCallId: "call-2", toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Continue", resume: "d1" },
      toolResult: {
        details: {
          delegationId: "d2", status: "completed", toolCalls: 4, turns: 3,
          usage: { ...opUsage("op-1", 1500) },
        },
      },
    });
    const replayed = metrics.aggregateChainMetricsFromMessages([first, second], "d1");
    // Same physical operation reported twice collapses; latest segment has no
    // occupancy so the chain reports unknown instead of the older gauge.
    assert.equal(replayed.usage.totalTokens, 1500);
    assert.equal(replayed.contextTokens, undefined);
    assert.equal(replayed.contextProvenance, "unknown");
    assert.equal(replayed.toolCalls, 5);
  } finally { await vite.close(); }
});

test("single metrics region separates context from spend with unknown helper", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    seed(useAppStore, {
      messages: [
        taskMessage("t1", "call-1", "d1", "completed", { contextTokens: 12000, usage: opUsage("op-1", 1500) }),
        childAssistant("a1", "call-1", opUsage("op-1", 1500)),
      ],
      running: false,
    });
    const html = render("d1");
    // One region only: header owns it, footer never duplicates.
    assert.equal((html.match(/subagent-transcript-metrics/g) ?? []).length, 1);
    assert.doesNotMatch(html, /subagent-transcript-footer-metrics/);
    assert.match(html, /data-testid="subagent-metrics-context"/);
    assert.match(html, /data-testid="subagent-metrics-spend"/);
    assert.match(html, /data-testid="subagent-metrics-activity"/);
    assert.match(html, /Context/);
    assert.match(html, /Spent/);
    // Plurals resolve through i18next (`t(base, { count })`), never a
    // hardcoded `_one` suffix leaking as a raw key.
    assert.match(html, /title="1 turn · 1 call"/);
    assert.doesNotMatch(html, /TurnsUnit_|CallsUnit_/);
    assert.doesNotMatch(html, /subagent-metrics-context">—</);
    // Unknown context renders — with a helper, never 0 and never hidden.
    const legacyTask = taskMessage("t1", "call-1", "d9", "completed");
    seed(useAppStore, { messages: [legacyTask], running: false });
    const unknownHtml = render("d9");
    assert.match(unknownHtml, /subagent-metrics-context">—/);
    assert.match(unknownHtml, /ui-help-icon/);
  } finally { await vite.close(); }
});

test("header names the live report owner from backend fields, settled stays bare", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    // Attached running run: parent still expects the report.
    seed(useAppStore, {
      messages: [taskMessage("t1", "call-1", "d1", "running")],
      running: true,
    });
    const attached = render("d1");
    assert.match(attached, /data-testid="subagent-delivery-owner"/);
    assert.match(attached, /Parent-owned/);
    assert.doesNotMatch(attached, /User-owned/);
    // Detached running run: a recorded `delivery: "user"` summary (or a
    // user-origin marker's `toolArgs.source`) names the user owner even
    // though the delegate is live.
    seed(useAppStore, {
      messages: [taskMessage("t1", "call-1", "d2", "running", { delivery: "user" })],
      running: true,
    });
    const detached = render("d2");
    assert.match(detached, /User-owned/);
    assert.doesNotMatch(detached, /Parent-owned/);
    // Settled runs omit the owner chip: the report already landed.
    seed(useAppStore, {
      messages: [taskMessage("t1", "call-1", "d3", "completed")],
      running: false,
    });
    const settled = render("d3");
    assert.doesNotMatch(settled, /subagent-delivery-owner/);
  } finally { await vite.close(); }
});

test("running steers, every settled child continues, only an instance-less call stays read-only", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    // Running: steer composer via existing channel labels.
    seed(useAppStore, {
      messages: [taskMessage("t1", "call-1", "d1", "running")],
      running: true,
    });
    const live = render("d1");
    assert.match(live, /Running/);
    assert.match(live, /Message the running subagent/);
    assert.match(live, /Send to subagent/);
    // Settled continuable: direct continue composer, no parent prompt.
    seed(useAppStore, {
      messages: [taskMessage("t1", "call-1", "d2", "completed")],
      running: false,
    });
    const settled = render("d2");
    assert.match(settled, /Completed/);
    assert.match(settled, /Send a follow-up/);
    assert.match(settled, /Continues this subagent as a new run/);
    assert.doesNotMatch(settled, /Ask parent/);
    assert.doesNotMatch(settled, /Task\(resume/);
    // Outcome is history, never a gate: every instantiated settled child —
    // including one stopped before its first transcript event — offers the
    // continue composer, and never a permanent cannot-continue line. The
    // stopped/aborted cases have no child rows at all.
    const statusLabel = {
      stopped: /Stopped by request/,
      aborted: /Stopped/,
      failed: /Failed/,
      timed_out: /Timed out/,
      interrupted: /Interrupted/,
    };
    for (const status of ["stopped", "aborted", "failed", "timed_out", "interrupted"]) {
      seed(useAppStore, {
        messages: [taskMessage("t1", "call-1", "d3", status)],
        running: false,
      });
      const continued = render("d3");
      assert.match(continued, statusLabel[status]);
      assert.match(continued, /Send a follow-up/);
      assert.match(continued, /Send/);
      assert.doesNotMatch(continued, /cannot continue/);
      assert.doesNotMatch(continued, /nothing to continue/);
    }
    // A denied never-started call carries no delegation identity: no backend
    // instance, so no continue composer and a meaningful no-instance reason.
    seed(useAppStore, {
      messages: [message("t1", "tool", "", {
        toolName: "Task",
        toolCallId: "call-9",
        toolStatus: "denied",
        toolArgs: { agent: "explorer", task: "Investigate the cache" },
        toolResult: { details: { denied: true } },
      })],
      running: false,
    });
    const denied = render("call-9");
    assert.doesNotMatch(denied, /Send a follow-up/);
    assert.match(denied, /Never started — nothing to continue/);
    // A tab whose Task calls are missing is likewise instance-less.
    seed(useAppStore, {
      messages: [taskMessage("t1", "call-1", "d9", "completed")],
      running: false,
    });
    const missing = render("missing");
    assert.doesNotMatch(missing, /Send a follow-up/);
    assert.match(missing, /Never started — nothing to continue/);
  } finally { await vite.close(); }
});

test("continue identity omits the turn guard when idle and blocks read-only", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const actions = await vite.ssrLoadModule("/src/lib/subagent-actions.ts");
    assert.deepEqual(
      actions.captureContinueIdentity({ sessionId: "s1", turnId: "turn-live", source: "local", canPrompt: true }),
      { ok: true, sessionId: "s1", turnId: "turn-live" },
    );
    assert.deepEqual(
      actions.captureContinueIdentity({ sessionId: "s1", source: "local", canPrompt: true }),
      { ok: true, sessionId: "s1" },
    );
    assert.deepEqual(
      actions.captureContinueIdentity({ sessionId: "remote:1", source: "remote", sessionStartsWithRemote: true, canPrompt: true }),
      { ok: false, reason: "read-only" },
    );
    assert.deepEqual(
      actions.captureContinueIdentity({ sessionId: "s1", source: "local", canPrompt: false }),
      { ok: false, reason: "unavailable" },
    );
    assert.equal(actions.canContinueSubagent("completed", true), true);
    assert.equal(actions.canContinueSubagent("failed", true), true);
    assert.equal(actions.canContinueSubagent("timed_out", true), true);
    assert.equal(actions.canContinueSubagent("interrupted", true), true);
    assert.equal(actions.canContinueSubagent("stopped", true), true);
    assert.equal(actions.canContinueSubagent("aborted", true), true);
    assert.equal(actions.canContinueSubagent("denied", true), true);
    assert.equal(actions.canContinueSubagent("running", true), false);
    assert.equal(actions.canContinueSubagent("completed", false), false);
  } finally { await vite.close(); }
});

test("delivery owner reads backend fields and steer prefers the kept execution turn", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const actions = await vite.ssrLoadModule("/src/lib/subagent-actions.ts");
    const chain = await vite.ssrLoadModule("/src/lib/subagent-chain.ts");
    // Recorded summary marking wins; user-origin marker args count;
    // anything else defaults to the parent (backward compatible).
    assert.equal(actions.subagentDeliveryOwner({ details: { delivery: "user" } }), "user");
    assert.equal(
      actions.subagentDeliveryOwner({ toolArgs: { source: "user", resume: "d1" } }),
      "user",
    );
    assert.equal(actions.subagentDeliveryOwner({ details: { delivery: "parent" } }), "parent");
    assert.equal(actions.subagentDeliveryOwner({}), "parent");
    // Owner turn: a kept execution turn covers the status-lag window after
    // a detached continue; otherwise the status's current turn travels
    // (live parent turn attached, adopted execution turn detached).
    assert.equal(
      actions.resolveSteerOwnerTurn({ keptTurnId: "exec-1", currentTurnId: "turn-parent" }),
      "exec-1",
    );
    assert.equal(
      actions.resolveSteerOwnerTurn({ currentTurnId: "turn-parent" }),
      "turn-parent",
    );
    assert.equal(actions.resolveSteerOwnerTurn({}), undefined);
    // Chain level: the latest segment decides, so a user continuation of a
    // parent chain is user-owned from that segment on.
    const first = taskMessage("t1", "call-1", "d1", "completed");
    assert.equal(chain.subagentChainDeliveryOwner([first], "d1"), "parent");
    const marker = message("t2", "tool", "", {
      toolName: "Task", toolCallId: "call-2", toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Continue", resume: "d1", source: "user" },
      toolResult: {
        details: { delegationId: "d2", status: "completed", toolCalls: 1, turns: 1 },
      },
    });
    assert.equal(chain.subagentChainDeliveryOwner([first, marker], "d1"), "user");
    assert.equal(chain.subagentChainDeliveryOwner([first, marker], "d2"), "user");
  } finally { await vite.close(); }
});

test("continue wrapper uses the shared channel without renderer-local duplicates", async () => {
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
          return { ok: true, data: { accepted: true, delegationId: "d-new", turnId: "t-new" } };
        },
      },
    };
    try {
      const { api } = await vite.ssrLoadModule("/src/lib/api.ts");
      const idle = await api.continueSubagent({ sessionId: "s1", delegationId: "d1", content: "go on" });
      assert.equal(idle.accepted, true);
      assert.equal(idle.delegationId, "d-new");
      assert.equal(calls[0].channel, "pi-desktop/agent/continueSubagent");
      assert.equal(calls[0].req.sessionId, "s1");
      assert.equal(calls[0].req.delegationId, "d1");
      assert.ok(!("expectedTurnId" in calls[0].req));
      const guarded = await api.continueSubagent({
        sessionId: "s1", delegationId: "d1", content: "go on",
        messageId: "m1", expectedTurnId: "turn-live",
      });
      assert.equal(guarded.turnId, "t-new");
      assert.equal(calls[1].req.expectedTurnId, "turn-live");
      assert.equal(calls[1].req.messageId, "m1");
    } finally {
      delete globalThis.window;
    }
    const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
    // Canonical shared channel: the renderer imports the shared
    // request/response types and names `IPC.invoke.agentContinueSubagent`
    // directly — no local type mirrors, no literal fallback.
    assert.match(apiSource, /IPC\.invoke\.agentContinueSubagent/);
    assert.doesNotMatch(apiSource, /agentContinueSubagentChannel/);
    assert.doesNotMatch(apiSource, /export type AgentContinueSubagentRequest = \{/);
    assert.doesNotMatch(apiSource, /export type AgentContinueSubagentResponse = \{/);
    assert.doesNotMatch(apiSource, /pi-desktop\/agent\/continueSubagent"/);
  } finally { await vite.close(); }
});

test("header styles exist once and narrow panels wrap instead of clipping", async () => {
  const css = await readFile(new URL("../src/styles/work-panel.css", import.meta.url), "utf8");
  for (const selector of [
    ".subagent-transcript-header",
    ".subagent-transcript-status",
    ".subagent-transcript-metrics",
    ".subagent-transcript-metric",
    ".subagent-transcript-metric-label",
    ".subagent-transcript-metric-value",
    ".subagent-transcript-model-static",
    ".subagent-transcript-error",
    ".subagent-transcript-helper",
  ]) {
    assert.ok(css.includes(selector), `${selector} missing`);
  }
  assert.match(css, /flex-wrap: wrap/);
  assert.match(css, /@media \(max-width: 480px\)/);
  const tabSource = await readFile(
    new URL("../src/components/workpanel/SubagentTranscriptTab.tsx", import.meta.url), "utf8",
  );
  assert.equal((tabSource.match(/subagent-transcript-footer-metrics/g) ?? []).length, 0);
  assert.equal((tabSource.match(/formatSubagentMetricsLine/g) ?? []).length, 0);
});

const narrowFixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { SubagentTranscriptTab } from "../src/components/workpanel/SubagentTranscriptTab";
import { useAppStore } from "../src/stores/app-store";
import "../src/styles/work-panel.css";
import "../src/styles/messages.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
const calls = [];
let failNext = null;
window.piDesktop = { platform: "linux", on() { return () => {}; },
  invoke: async (channel, req) => {
    calls.push({ channel, req });
    if (failNext) { const error = failNext; failNext = null; return { ok: false, error }; }
    if (channel === "pi-desktop/agent/steerSubagent") {
      return { ok: true, data: { accepted: true, delegationId: req.delegationId, turnId: "t-child" } };
    }
    if (channel === "pi-desktop/agent/continueSubagent") {
      return { ok: true, data: { accepted: true, delegationId: "d-new", turnId: "t-new" } };
    }
    throw new Error("Unexpected channel " + channel);
  } };
const base = { id: "s1", source: "local", title: "fixture" };
function task(id, callId, delegationId, status, extra = {}) {
  return { id, role: "tool", content: "", createdAt: "2026-10-13T00:00:00.000Z",
    toolName: "Task", toolCallId: callId, toolStatus: status === "running" ? "running" : "success",
    toolArgs: { agent: "explorer", task: "Investigate the cache" },
    toolResult: { details: { delegationId, agent: "explorer", status,
      startedAt: Date.parse("2026-10-13T00:00:00Z"), modelId: "test-model", thinkingLevel: "high",
      toolCalls: 17, turns: 7, contextTokens: 41000,
      usage: { inputTokens: 3000, outputTokens: 1000, totalTokens: 4000, operationId: "op-" + callId, aggregation: "operation" },
      ...extra } } };
}
function childAnswer(id, callId) {
  return { id, role: "assistant", content: "done", createdAt: "2026-10-13T00:00:00.000Z",
    parentToolCallId: callId, agentName: "explorer", status: "complete" };
}
const runningMessages = [task("t1", "call-1", "d1", "running"), childAnswer("a1", "call-1")];
const settledMessages = [task("t1", "call-1", "d1", "completed"), childAnswer("a1", "call-1")];
function seed(messages, running) {
  useAppStore.setState({ activeSessionId: "s1", sessions: [base],
    agentStatuses: running ? { s1: { currentTurnId: "turn-parent" } } : {},
    runningSessions: running ? { s1: true } : {},
    settings: { enterToSend: true }, showToast() {} });
  // Transcript view reads messages through the store event pipeline; seed the
  // slice the hook observes.
  useAppStore.setState({ messages });
}
const rootNode = createRoot(document.getElementById("root"));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
function header() { return document.querySelector('[data-testid="subagent-panel-header"]'); }
function composerTextarea() { return document.querySelector('[data-testid="subagent-panel-footer"] textarea'); }
function sendButton() {
  return [...document.querySelectorAll('[data-testid="subagent-panel-footer"] button')]
    .find((button) => /^(Send|Sending)/.test(button.textContent.trim()));
}
function setDraft(value) {
  const area = composerTextarea();
  check(area, "composer textarea missing");
  area.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(area, value);
  area.dispatchEvent(new Event("input", { bubbles: true }));
  area.dispatchEvent(new Event("change", { bubbles: true }));
}
window.continueProbe = async () => {
  async function setPanelWidth(px) {
    document.getElementById("root").style.width = px + "px";
    await settle();
  }
  function checkNoClip(label) {
    const tab = document.querySelector('[data-testid="subagent-transcript-tab"]');
    check(tab, "transcript tab missing for " + label);
    check(tab.scrollWidth <= tab.clientWidth + 1,
      label + " clips: scrollWidth " + tab.scrollWidth + " clientWidth " + tab.clientWidth);
  }
  // Settled narrow panel at 320px and 400px: one metrics region, no clipped
  // overflow, readable status plus context/spend labels.
  await setPanelWidth(320);
  seed(settledMessages, false);
  flushSync(() => rootNode.render(React.createElement(SubagentTranscriptTab, { delegationId: "d1" })));
  await settle();
  check(header(), "header missing");
  check(document.body.textContent.includes("Completed"), "settled status missing");
  check((document.querySelectorAll(".subagent-transcript-metrics").length) === 1, "metrics region must appear exactly once");
  check(!document.body.textContent.includes("Ask parent to resume"), "ask-parent must be gone");
  check(!document.querySelector(".subagent-transcript-model-static [aria-haspopup]"), "model must not fake a menu");
  check(!document.querySelector(".composer-model-thinking-chevron"), "model chevron must be gone");
  checkNoClip("settled 320px");
  check(document.body.textContent.includes("Context") && document.body.textContent.includes("Spent"), "context/spend labels missing");
  await setPanelWidth(400);
  checkNoClip("settled 400px");
  check(document.body.textContent.includes("Context") && document.body.textContent.includes("Spent"), "400px context/spend labels missing");
  // Settled send continues the same chain directly; idle omits the turn guard.
  setDraft("go on");
  await settle();
  const send = sendButton();
  check(send && !send.disabled, "settled Send must enable when idle with local rights");
  calls.length = 0;
  flushSync(() => send.click());
  await settle(); await settle(); await new Promise((r) => setTimeout(r, 50)); await settle();
  const continued = calls.find((call) => call.channel === "pi-desktop/agent/continueSubagent");
  check(continued, "settled Send must call continueSubagent, saw " + JSON.stringify(calls));
  check(continued.req.delegationId === "d1" && continued.req.content === "go on", "continue payload wrong: " + JSON.stringify(continued.req));
  check(!("expectedTurnId" in continued.req), "idle continue must omit expectedTurnId");
  check(!calls.some((call) => call.channel === "pi-desktop/agent/steerSubagent"), "settled must not steer");
  check(composerTextarea().value === "", "draft must clear after accepted continue");
  // Failure preserves the draft for retry with a fresh idempotent id.
  setDraft("retry me");
  await settle();
  failNext = { message: "host refused", code: "REFUSED" };
  calls.length = 0;
  flushSync(() => sendButton().click());
  await settle(); await settle(); await new Promise((r) => setTimeout(r, 50)); await settle();
  check(composerTextarea().value === "retry me", "failure must preserve draft");
  check(document.body.textContent.includes("host refused"), "failure must surface");
  // A child stopped before its first transcript event (no retained child rows)
  // still continues directly: the Task chain identity is enough, the outcome
  // stays as history, and there is no cannot-continue line. Same public path
  // as the settled send above: draft -> Send -> continueSubagent -> clear.
  for (const [outcome, statusText] of [["stopped", "Stopped by request"], ["aborted", "Stopped"]]) {
    seed([task("t1", "call-1", "d1", outcome)], false);
    flushSync(() => rootNode.render(React.createElement(SubagentTranscriptTab, { delegationId: "d1" })));
    await settle();
    check(document.body.textContent.includes(statusText), outcome + " status missing");
    check(!document.body.textContent.includes("cannot continue"), outcome + " must not show cannot-continue");
    check(composerTextarea(), outcome + " continue composer missing");
    check(document.body.textContent.includes("Continues this subagent"), outcome + " continue help missing");
    setDraft("continue after " + outcome);
    await settle();
    const send = sendButton();
    check(send && !send.disabled, outcome + " Send must enable");
    calls.length = 0;
    flushSync(() => send.click());
    await settle(); await settle(); await new Promise((r) => setTimeout(r, 50)); await settle();
    const continued = calls.find((call) => call.channel === "pi-desktop/agent/continueSubagent");
    check(continued, outcome + " Send must call continueSubagent, saw " + JSON.stringify(calls));
    check(continued.req.delegationId === "d1" && continued.req.content === "continue after " + outcome,
      outcome + " continue payload wrong: " + JSON.stringify(continued.req));
    check(!("expectedTurnId" in continued.req), outcome + " idle continue must omit expectedTurnId");
    check(!calls.some((call) => call.channel === "pi-desktop/agent/steerSubagent"), outcome + " must not steer");
    check(composerTextarea().value === "", outcome + " draft must clear after accepted continue");
  }
  // Running narrow panel at 320px: steer path intact, same single region.
  await setPanelWidth(320);
  seed(runningMessages, true);
  flushSync(() => rootNode.render(React.createElement(SubagentTranscriptTab, { delegationId: "d1" })));
  await settle();
  check(document.body.textContent.includes("Running"), "running status missing");
  check((document.querySelectorAll(".subagent-transcript-metrics").length) === 1, "running must keep one metrics region");
  checkNoClip("running 320px");
  setDraft("keep going");
  await settle();
  calls.length = 0;
  flushSync(() => sendButton().click());
  await settle(); await settle(); await new Promise((r) => setTimeout(r, 50)); await settle();
  const steered = calls.find((call) => call.channel === "pi-desktop/agent/steerSubagent");
  check(steered && steered.req.expectedTurnId === "turn-parent", "running Send must steer with turn guard");
  flushSync(() => rootNode.unmount());
  return { passed: true };
};
`;

test("subagent continue narrow panel: single metrics region, direct continue, draft guards", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  // `root` is already apps/desktop: scratch temp and node_modules resolve
  // from there, while repo-level packages resolve from the repo root above.
  const repoRoot = join(root, "..", "..");
  const { build } = createRequire(join(repoRoot, "packages/agent-runtime/package.json"))("esbuild");
  const temp = await mkdtemp(join(root, ".continue-ui-"));
  try {
    await build({
      stdin: { contents: narrowFixture, resolveDir: join(root, "test"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".eot": "file" },
      alias: {
        "@pi-desktop/i18n": join(repoRoot, "packages/i18n/src"),
        "@pi-desktop/shared": join(repoRoot, "packages/shared/src"),
        react: join(root, "node_modules/react"),
        "react-dom": join(root, "node_modules/react-dom"),
        i18next: join(root, "node_modules/i18next"),
        "react-i18next": join(root, "node_modules/react-i18next"),
      },
      nodePaths: [join(root, "node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><div id="root" style="width:360px"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("CONTINUE_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.continueProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(repoRoot).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-8000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("CONTINUE_PROBE "));
    assert.ok(line, output.slice(-8000));
    assert.deepEqual(JSON.parse(line.slice("CONTINUE_PROBE ".length)), { passed: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
