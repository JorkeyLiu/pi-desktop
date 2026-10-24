import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * A child, unlike the parent transcript, wrote no working indicator of its own:
 * a running delegate showed a frozen list between events. The panel now ends
 * its rows with the transcript's own working indicator, and shows it only while
 * the child is genuinely working — a child waiting on the user keeps the wait
 * as the only thing on screen.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

const message = (id, role, content = "", extra = {}) => ({
  id,
  role,
  content,
  createdAt: "2026-10-13T00:00:00.000Z",
  ...extra,
});

const taskCall = (status, delegationId = "d1") =>
  message("task-1", "tool", "", {
    toolName: "Task",
    toolCallId: "task-1",
    toolStatus: status === "running" ? "running" : "success",
    toolArgs: { agent: "explorer", description: "Investigate the cache" },
    toolResult: {
      details: {
        delegationId,
        agent: "explorer",
        status,
        startedAt: Date.parse("2026-10-13T00:00:00.000Z"),
      },
    },
  });

const childToolRow = (toolCallId, extra = {}) =>
  message(toolCallId, "tool", "", {
    toolCallId,
    toolName: "Read",
    toolStatus: "running",
    status: "streaming",
    parentToolCallId: "task-1",
    agentName: "explorer",
    ...extra,
  });

async function setup() {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
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
  const { SubagentTranscriptTab } = await server.ssrLoadModule(
    "/src/components/workpanel/SubagentTranscriptTab.tsx",
  );
  const { SlotSessionProvider } = await server.ssrLoadModule(
    "/src/plugins/renderer-slots/use-slots.tsx",
  );
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const render = (delegationId = "d1") =>
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
  return { server, render, useAppStore };
}

function seed(store, { running, pendingPermissions = {}, pendingAsks = {}, messages }) {
  Object.assign(store.getInitialState(), {
    activeSessionId: "s1",
    sessions: [{ id: "s1", source: "local", title: "fixture" }],
    messages,
    agentStatuses: running ? { s1: { currentTurnId: "turn-parent" } } : {},
    runningSessions: running ? { s1: true } : {},
    pendingPermissions,
    pendingAsks,
    settings: { enterToSend: true },
  });
}

test("a running child ends its rows with the transcript's working indicator", async (t) => {
  const { server, render, useAppStore } = await setup();
  t.after(async () => {
    await server.close();
  });
  seed(useAppStore, {
    running: true,
    messages: [taskCall("running"), childToolRow("child-1")],
  });
  const html = render();
  assert.match(html, /data-testid="working-indicator"/);
  assert.match(html, /class="working-indicator-label">Working…</);
  // It follows the child's rows rather than preceding them.
  assert.ok(html.indexOf('data-message-id="child-1"') < html.indexOf('data-testid="working-indicator"'));
});

test("a settled child shows no working indicator", async (t) => {
  const { server, render, useAppStore } = await setup();
  t.after(async () => {
    await server.close();
  });
  seed(useAppStore, {
    running: false,
    messages: [taskCall("completed")],
  });
  assert.doesNotMatch(render(), /data-testid="working-indicator"/);
});

test("a child waiting on a permission or a question claims no progress", async (t) => {
  const { server, render, useAppStore } = await setup();
  t.after(async () => {
    await server.close();
  });
  const messages = [taskCall("running"), childToolRow("child-1")];
  seed(useAppStore, {
    running: true,
    messages,
    pendingPermissions: {
      s1: [
        {
          requestId: "perm-1",
          sessionId: "s1",
          toolCallId: "child-1",
          toolName: "Read",
          argsPreview: {},
          risk: "low",
          reason: "reads a file",
          agentName: "explorer",
          parentToolCallId: "task-1",
        },
      ],
    },
  });
  assert.doesNotMatch(render(), /data-testid="working-indicator"/);
  // The same wait for another delegation does not hide this child's progress.
  seed(useAppStore, {
    running: true,
    messages,
    pendingPermissions: {
      s1: [
        {
          requestId: "perm-2",
          sessionId: "s1",
          toolCallId: "other-child-tool",
          toolName: "Read",
          argsPreview: {},
          risk: "low",
          reason: "reads a file",
        },
      ],
    },
    pendingAsks: {
      s1: [
        {
          requestId: "ask-1",
          sessionId: "s1",
          toolCallId: "child-1",
          questions: [{ id: "q1", question: "Which file?", options: [], multiSelect: false }],
        },
      ],
    },
  });
  assert.doesNotMatch(render(), /data-testid="working-indicator"/);
  seed(useAppStore, {
    running: true,
    messages,
    pendingAsks: {
      s1: [
        {
          requestId: "ask-2",
          sessionId: "s1",
          toolCallId: "another-delegation-tool",
          questions: [{ id: "q1", question: "Which file?", options: [], multiSelect: false }],
        },
      ],
    },
  });
  assert.match(render(), /data-testid="working-indicator"/);
});
