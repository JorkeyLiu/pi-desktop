import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
  The tab stays on the original run past a rejected `Task(resume …)`.

  User path: a live delegate (d-orig) is running; the parent model issues a
  second `Task(resume d-orig)` which the runtime rejects (no new run, no new
  child rows, TaskList still reports d-orig running). Opening the subagent tab
  for d-orig must still show the original run — its prompt once, its rows
  including later progress — with a Running header, and never render the
  rejected brief as a delivered user prompt.
*/

const root = fileURLToPath(new URL("..", import.meta.url));

const ORIG_TASK = "Map the cache invalidation path.";
const BRIEF = "Supplemental brief: re-check the figures against source B and report deltas.";
const LATER_ROW = "Found the mismatch in source B.";

const usage = (op) => ({
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  operationId: op,
  aggregation: "operation",
});

function origCall() {
  const details = {
    delegationId: "d-orig",
    agent: "explorer",
    status: "running",
    startedAt: Date.parse("2026-10-13T00:00:00Z"),
    modelId: "test-model",
    thinkingLevel: "high",
    turns: 1,
    toolCalls: 1,
    usage: usage("op-orig"),
  };
  const result = {
    content: [{ type: "text", text: "Delegation d-orig: running." }],
    details,
  };
  return {
    id: "m-call-1",
    role: "tool",
    content: "",
    createdAt: "2026-10-13T00:00:00.000Z",
    toolCallId: "tc-orig-1",
    toolName: "Task",
    toolStatus: "success",
    toolArgs: { description: "Research X", task: ORIG_TASK },
    toolResult: result,
    toolCompletedAt: "2026-10-13T00:00:01.000Z",
    toolDurationMs: 1000,
    status: "complete",
    isError: false,
  };
}

function childAssistant(id, callId, content, op, second) {
  return {
    id,
    role: "assistant",
    content,
    createdAt: `2026-10-13T00:00:${String(second).padStart(2, "0")}.000Z`,
    parentToolCallId: callId,
    agentName: "explorer",
    status: "complete",
    usage: usage(op),
  };
}

function rejectedResume(resume) {
  return {
    id: "m-call-2",
    role: "tool",
    content: "",
    createdAt: "2026-10-13T00:00:07.000Z",
    toolCallId: "tc-resume-2",
    toolName: "Task",
    toolStatus: "error",
    toolArgs: { description: "Research X", task: BRIEF, resume },
    toolResult: {
      error: { code: "RESUME_REJECTED", message: "delegation d-orig is still running" },
    },
    error: { code: "RESUME_REJECTED", message: "delegation d-orig is still running" },
    status: "error",
    isError: true,
  };
}

function fixture(resume) {
  return [
    { id: "u1", role: "user", content: "Research X.", createdAt: "2026-10-12T23:59:59.000Z" },
    origCall(),
    childAssistant("child-a1", "tc-orig-1", "Working on the figures…", "op-orig-1", 5),
    {
      id: "m-list-1",
      role: "tool",
      content: "",
      createdAt: "2026-10-13T00:00:06.000Z",
      toolName: "TaskList",
      toolCallId: "tc-list-9",
      toolStatus: "success",
      toolResult: { details: { delegations: [{ delegationId: "d-orig", status: "running" }] } },
      status: "complete",
    },
    rejectedResume(resume),
    {
      id: "child-t1",
      role: "tool",
      content: "",
      createdAt: "2026-10-13T00:00:08.000Z",
      toolName: "Read",
      toolCallId: "child-tool-1",
      toolStatus: "success",
      parentToolCallId: "tc-orig-1",
      agentName: "explorer",
      status: "complete",
    },
    childAssistant("child-a2", "tc-orig-1", LATER_ROW, "op-orig-2", 9),
  ];
}

async function setup() {
  const vite = await createServer({
    root,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: flattenCatalog(catalogs.en) } },
  });
  const { SubagentTranscriptTab } = await vite.ssrLoadModule(
    "/src/components/workpanel/SubagentTranscriptTab.tsx",
  );
  const { SlotSessionProvider } = await vite.ssrLoadModule(
    "/src/plugins/renderer-slots/use-slots.tsx",
  );
  const { useAppStore } = await vite.ssrLoadModule("/src/stores/app-store.ts");
  const chain = await vite.ssrLoadModule("/src/lib/subagent-chain.ts");
  const render = (delegationId) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          SlotSessionProvider,
          { sessionId: "s1" },
          createElement(SubagentTranscriptTab, { delegationId }),
        ),
      ),
    );
  const paint = (store) => {
    const state = store.getState();
    Object.assign(store.getInitialState(), {
      activeSessionId: state.activeSessionId,
      sessions: state.sessions,
      messages: state.messages,
      agentStatuses: state.agentStatuses,
      runningSessions: state.runningSessions,
      retainedTranscripts: state.retainedTranscripts,
      transcriptViews: state.transcriptViews,
      settings: { enterToSend: true },
      workPanelTabs: state.workPanelTabs,
      activeWorkPanelTabId: state.activeWorkPanelTabId,
      workPanelContexts: state.workPanelContexts,
    });
  };
  const seed = (store, messages) => {
    store.setState({
      activeSessionId: "s1",
      sessions: [{ id: "s1", source: "local", title: "fixture" }],
      messages,
      retainedTranscripts: {},
      transcriptViews: {},
      sessionHistory: {},
      agentStatuses: { s1: { currentTurnId: "turn-parent" } },
      runningSessions: { s1: true },
      isRunning: true,
      pendingPermissions: {},
      pendingAsks: {},
      page: "chat",
      workspace: null,
      settings: { enterToSend: true },
      workPanelOpen: true,
      workPanelTabs: [{ id: "subagent:d-orig", kind: "subagent", resource: "d-orig", label: "Research X" }],
      activeWorkPanelTabId: "subagent:d-orig",
      workPanelContexts: {},
      workPanelFileRequest: null,
    });
  };
  return { vite, render, paint, seed, useAppStore, ...chain };
}

const countOccurrences = (html, text) => html.split(text).length - 1;

for (const resume of ["d-orig", "tc-orig-1"]) {
  test(`rejected resume (${resume}): the open tab stays on the original running delegation`, async () => {
    const { vite, render, paint, seed, useAppStore, subagentChainLatestDelegationId } = await setup();
    try {
      const messages = fixture(resume);
      seed(useAppStore, messages);

      // The failed request changes no active delegation: the chain-latest of
      // the original id is still the original run.
      assert.equal(subagentChainLatestDelegationId(messages, "d-orig"), "d-orig");

      paint(useAppStore);
      const html = render("d-orig");

      // One turn: the original prompt exactly once, never the rejected brief.
      assert.equal(countOccurrences(html, ORIG_TASK), 1);
      assert.ok(!html.includes("Supplemental brief"), "rejected brief must not render as a prompt");
      // Later child progress still appends under the original run.
      assert.ok(html.includes(LATER_ROW));
      // Header still reports the live run, not a stopped tab.
      assert.ok(html.includes(">Running<"), "header keeps the Running status");
      assert.ok(!html.includes("Stopped"), "header must not report a stop");
    } finally {
      await vite.close();
    }
  });
}
