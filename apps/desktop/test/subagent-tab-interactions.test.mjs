import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

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

function childAnswer(id, callId, content) {
  return message(id, "assistant", content, {
    parentToolCallId: callId,
    agentName: "explorer",
    status: "complete",
  });
}

function childEcho(id, callId, content) {
  return message(id, "user", content, {
    parentToolCallId: callId,
    agentName: "explorer",
    steering: true,
    status: "complete",
  });
}

function resumeCall(id, callId, resume, delegationId, status) {
  return message(id, "tool", "", {
    toolName: "Task",
    toolCallId: callId,
    toolStatus: status === "running" ? "running" : "success",
    toolArgs: { agent: "explorer", task: "Continue", resume },
    toolResult: {
      details: {
        delegationId,
        agent: "explorer",
        status,
        startedAt: Date.parse("2026-10-13T00:00:01Z"),
        toolCalls: 1,
        turns: 1,
      },
    },
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
  // Flattened catalogs, matching production (renderer-catalogs): plural
  // units resolve via `t(base, { count })`, never a hardcoded suffix.
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
  return { vite, render, useAppStore };
}

function seed(store, { session = { id: "s1", source: "local", title: "fixture" }, messages, running }) {
  // Zustand v5 serves selectors from the initial-state snapshot under SSR
  // (`renderToStaticMarkup`), so fixtures seed through getInitialState. Each
  // test below owns a fresh vite module graph, so seeds never leak across
  // tests; scenarios within one test re-assign before every render.
  Object.assign(store.getInitialState(), {
    activeSessionId: "s1",
    sessions: [session],
    messages,
    agentStatuses: running ? { s1: { currentTurnId: "turn-parent" } } : {},
    runningSessions: running ? { s1: true } : {},
    settings: { enterToSend: true },
  });
}

test("running delegation tab shows live status, steering echo attribution, and enabled child send", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    seed(useAppStore, {
      messages: [
        taskMessage("t1", "call-1", "d1", "running"),
        childEcho("echo-1", "call-1", "keep going"),
        childAnswer("a1", "call-1", "working on it"),
      ],
      running: true,
    });
    const html = render("d1");
    // Session/tab identity: the tab resolves the d1 chain in session s1.
    assert.match(html, /data-testid="subagent-transcript-tab"/);
    assert.match(html, /Running/);
    // User echo attribution: steering renders as the user side with its own
    // message id, never as an assistant answer.
    assert.match(html, /data-message-id="echo-1"/);
    const echo = html.slice(html.indexOf('data-message-id="echo-1"') - 200, html.indexOf('data-message-id="echo-1"') + 200);
    assert.match(echo, /message-row user/);
    assert.match(html, /keep going/);
    assert.match(html, /data-message-id="a1"/);
    assert.match(html, /working on it/);
    // Latest delegation send/stop/status: enabled child composer + stop + metrics.
    assert.match(html, /Message the running subagent/);
    assert.match(html, /Send to subagent/);
    assert.match(html, /stop-btn/);
    // Disabled modes: the model label is display-only even while live.
    assert.match(html, /subagent-transcript-model-static/);
    assert.doesNotMatch(html, /aria-haspopup/);
    assert.doesNotMatch(html, /composer-model-thinking-chevron/);
    assert.match(html, /test-model/);
  } finally { await vite.close(); }
});

test("settled continuable tab offers direct continue while stale and remote tabs stay read-only", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    const first = taskMessage("t1", "call-1", "d1", "failed");
    const resume = resumeCall("t2", "call-2", "d1", "d2", "completed");
    seed(useAppStore, { messages: [first, resume], running: false });
    // Latest tab owns the direct continue action with a single composer.
    const latest = render("d2");
    assert.match(latest, /Completed/);
    // Unified continue composer: retained-history helper, single Send.
    assert.match(latest, /retained history/);
    assert.match(latest, /Send/);
    // No parent-prompt path remains: no ask-parent label, no follow-up
    // distinction, no resume help.
    assert.doesNotMatch(latest, /Ask parent to resume/);
    assert.doesNotMatch(latest, /Follow-up for the resumed run/);
    assert.doesNotMatch(latest, /Resume with follow-up/);
    assert.doesNotMatch(latest, /Task\(resume/);
    // Static model label: display-only, never a fake menu.
    assert.doesNotMatch(latest, /aria-haspopup/);
    assert.doesNotMatch(latest, /composer-model-thinking-chevron/);
    // Single metrics region: header owns it, footer never duplicates.
    const headerCount = (latest.match(/subagent-transcript-metrics/g) ?? []).length;
    assert.equal(headerCount, 1);
    assert.doesNotMatch(latest, /subagent-transcript-footer-metrics/);
    // Stale tab never duplicates the continue for the same chain.
    const stale = render("d1");
    assert.doesNotMatch(stale, /Send a follow-up/);
    assert.match(stale, /continued elsewhere/);
    // Remote sessions stay read-only even when the delegate is continuable.
    seed(useAppStore, {
      session: { id: "s1", source: "remote", title: "fixture" },
      messages: [taskMessage("t1", "call-1", "d1", "completed")],
      running: false,
    });
    const remote = render("d1");
    assert.doesNotMatch(remote, /Send a follow-up/);
    assert.doesNotMatch(remote, /Send to subagent/);
    // Remote settled copy resolves to text (not a key path) in this fixture.
    assert.match(remote, /unavailable for remote or native sessions/);
  } finally { await vite.close(); }
});

test("owner chip and blocked composers name their own capability reason", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    // Attached live run: parent-owned with the busy hint in the title.
    seed(useAppStore, {
      messages: [taskMessage("t1", "call-1", "d1", "running")],
      running: true,
    });
    const attached = render("d1");
    assert.match(attached, /data-testid="subagent-delivery-owner"/);
    assert.match(attached, /Parent-owned/);
    // The flattened catalog resolves the owner hint to its copy in SSR.
    assert.match(attached, /goes to the main agent when it finishes/);
    // Detached live run: user-owned, report stays local.
    seed(useAppStore, {
      messages: [taskMessage("t1", "call-1", "d2", "running", { delivery: "user" })],
      running: true,
    });
    const detached = render("d2");
    assert.match(detached, /User-owned/);
    assert.match(detached, /Taken over by you/);
    // Stale tab names itself instead of the generic read-only copy.
    const first = taskMessage("t1", "call-1", "d1", "failed");
    const resume = resumeCall("t2", "call-2", "d1", "d2", "completed");
    seed(useAppStore, { messages: [first, resume], running: false });
    const stale = render("d1");
    assert.match(stale, /continued elsewhere/);
    assert.doesNotMatch(stale, /Send a follow-up/);
    // History-less settled tab names the missing history.
    seed(useAppStore, {
      messages: [taskMessage("t1", "call-1", "d9", "completed")],
      running: false,
    });
    // History-less means no chain transcript: craft it by rendering an id with
    // no Task call at all.
    const noHistory = render("missing");
    assert.match(noHistory, /No retained history to continue/);
    // Explicit ends name their own stop reason, resolved in SSR.
    const endedCopy = {
      stopped: /Stopped by request — it cannot continue/,
      aborted: /Stopped — it cannot continue/,
      denied: /Never started — nothing to continue/,
    };
    for (const status of ["stopped", "aborted", "denied"]) {
      seed(useAppStore, {
        messages: [taskMessage("t1", "call-1", "d3", status)],
        running: false,
      });
      const blocked = render("d3");
      assert.match(blocked, endedCopy[status]);
    }
  } finally { await vite.close(); }
});

test("draft clear guard preserves text across failure, session switch, and chain advance", async () => {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const actions = await vite.ssrLoadModule("/src/lib/subagent-actions.ts");
    const chain = await vite.ssrLoadModule("/src/lib/subagent-chain.ts");
    const same = {
      sendSucceeded: true,
      capturedSessionId: "s1",
      currentSessionId: "s1",
      capturedDelegationId: "d1",
      currentDelegationId: "d1",
    };
    assert.equal(actions.shouldClearSteerDraft(same), true);
    // Rejected steer preserves the draft for retry.
    assert.equal(actions.shouldClearSteerDraft({ ...same, sendSucceeded: false }), false);
    // A session switch during dispatch never wipes the new context's draft.
    assert.equal(actions.shouldClearSteerDraft({ ...same, currentSessionId: "s2" }), false);
    assert.equal(actions.shouldClearSteerDraft({ ...same, capturedSessionId: undefined }), false);
    // A d1 -> d2 continuation arriving mid-dispatch moves the composer to a
    // different target: the sent text stays instead of clearing the new draft.
    const first = taskMessage("t1", "call-1", "d1", "failed");
    const cont = resumeCall("t2", "call-2", "d1", "d2", "running");
    const before = [first];
    const after = [first, cont];
    assert.equal(chain.subagentChainLatestDelegationId(before, "d1"), "d1");
    assert.equal(chain.subagentChainLatestDelegationId(after, "d1"), "d2");
    assert.equal(
      actions.shouldClearSteerDraft({
        ...same,
        currentDelegationId: chain.subagentChainLatestDelegationId(after, "d1"),
      }),
      false,
    );
    // Tab identity resets the draft on switch: the surface remounts per
    // delegation and clears the composer whenever delegation or session moves.
    const tabSource = await readFile(new URL("../src/components/workpanel/SubagentTranscriptTab.tsx", import.meta.url), "utf8");
    assert.match(tabSource, /<TranscriptDisclosureProvider key=\{delegationId\}>/);
    assert.match(tabSource, /setDraft\(""\);\s*\n\s*setSendError\(null\)/);
    assert.match(tabSource, /\}, \[delegationId, activeSessionId\]\);/);
    // No parent-prompt resume path remains in the surface.
    assert.doesNotMatch(tabSource, /buildSubagentResumePrompt/);
    assert.doesNotMatch(tabSource, /askParentToResume/);
    assert.doesNotMatch(tabSource, /sendPrompt\(/);
  } finally { await vite.close(); }
});
