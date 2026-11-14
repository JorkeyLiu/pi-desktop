/**
 * The delegate panel renders its own scoped history, not the main window.
 *
 * The main conversation's read budget covers its own top-level rows, so a
 * delegate tab cannot take availability or content from whatever the parent
 * window happens to hold. These SSR renders seed the store with a main window
 * that has no Task card at all and a delegate entry loaded from its own scope;
 * the panel must still draw the delegate's conversation, its status, and its
 * inline states.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function message(id, role, content, extra = {}) {
  return { id, role, content, createdAt: "2026-10-13T00:00:00.000Z", ...extra };
}

function taskRecord() {
  return message("call-1-row", "tool", "", {
    toolName: "Task",
    toolCallId: "call-1",
    toolStatus: "success",
    toolArgs: { agent: "explorer", task: "Investigate the cache" },
    toolResult: {
      details: {
        delegationId: "d1",
        agent: "explorer",
        status: "completed",
        startedAt: Date.parse("2026-10-13T00:00:00Z"),
        modelId: "test-model",
        thinkingLevel: "high",
        toolCalls: 1,
        turns: 1,
        contextTokens: 1234,
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

function delegateEntry(overrides = {}) {
  return {
    sessionId: "s1",
    tabKey: "d1",
    canonicalId: "d1",
    aliases: ["d1"],
    status: "ready",
    messages: [childAnswer("a-10", "call-1", "The cache misses were a stale key.")],
    context: [taskRecord()],
    messageStart: 10,
    hasMoreBefore: false,
    hasMoreAfter: false,
    finalized: true,
    refreshing: false,
    focus: null,
    scoped: true,
    touched: 1,
    ...overrides,
  };
}

async function setup() {
  const vite = await createServer({
    root, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
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
  return { vite, render, useAppStore };
}

/**
 * Zustand v5 serves selectors from the initial-state snapshot under SSR, so
 * fixtures seed that snapshot. `mainMessages` is deliberately tiny: the panel
 * must not need a Task card or child rows from the main window.
 */
function seed(store, { mainMessages = [], entries = [delegateEntry()] } = {}) {
  const subagentHistory = {};
  for (const entry of entries) {
    subagentHistory[entry.sessionId] ??= {};
    subagentHistory[entry.sessionId][entry.tabKey] = entry;
  }
  Object.assign(store.getInitialState(), {
    activeSessionId: "s1",
    sessions: [{ id: "s1", source: "local", title: "fixture" }],
    messages: mainMessages,
    subagentHistory,
    agentStatuses: {},
    runningSessions: {},
    settings: { enterToSend: true },
  });
}

test("a delegate panel renders its own scoped page when the main window holds no Task card", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    // The reader replaced the main range: it holds other top-level rows only.
    seed(useAppStore, {
      mainMessages: [
        message("u-1", "user", "Summarize the issue"),
        message("a-1", "assistant", "Here is the summary"),
      ],
    });
    const html = render();
    assert.match(html, /The cache misses were a stale key\./, "the child's own row renders");
    assert.doesNotMatch(
      html,
      /no longer available/i,
      "availability comes from the delegate's entry, not the main window",
    );
    assert.doesNotMatch(html, /Summarize the issue/, "the parent's rows are not mixed in");
    assert.match(html, /data-testid="subagent-metrics-context">1\.2K/, "chain evidence resolves metrics");
  } finally {
    await vite.close();
  }
});

test("another chain's live rows never stand in for this delegate", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    const otherTask = message("call-9-row", "tool", "", {
      toolName: "Task",
      toolCallId: "call-9",
      toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Other chain" },
      toolResult: { details: { delegationId: "d9", agent: "explorer", status: "completed" } },
    });
    seed(useAppStore, {
      mainMessages: [otherTask, childAnswer("a-90", "call-9", "other chain output")],
      entries: [
        delegateEntry({
          messages: [childAnswer("a-10", "call-1", "this chain output")],
        }),
      ],
    });
    const html = render("d1");
    assert.match(html, /this chain output/, "the panel draws its own page");
    assert.doesNotMatch(html, /other chain output/, "no foreign chain row leaks in");
  } finally {
    await vite.close();
  }
});

test("a failed delegate read states its own error and retry inline", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    seed(useAppStore, {
      mainMessages: [],
      entries: [
        delegateEntry({
          status: "error",
          error: "host unavailable",
          messages: [],
          context: [],
        }),
      ],
    });
    const html = render();
    assert.match(html, /Could not load this subagent&#x27;s conversation\./);
    assert.match(html, /Retry/);
    assert.match(html, /data-testid="subagent-history-error"/);
    assert.doesNotMatch(html, /no longer available/i, "an error is not an unavailable panel");
  } finally {
    await vite.close();
  }
});

test("a known chain with no rows renders its empty state, not an unavailable panel", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    seed(useAppStore, {
      mainMessages: [],
      entries: [
        delegateEntry({
          status: "empty",
          messages: [],
          // A valid chain: the root `Task` records came back with the scope
          // echo, the delegate simply produced no child row.
          context: [taskRecord()],
          hasMoreBefore: false,
        }),
      ],
    });
    const html = render();
    assert.doesNotMatch(html, /no longer available/i, "a known chain is not unavailable");
    assert.doesNotMatch(html, /data-testid="subagent-history-error"/, "no failure is claimed");
    assert.match(html, /Investigate the cache/, "the chain's own task is rendered");
  } finally {
    await vite.close();
  }
});

test("a chain the host no longer answers is unavailable with a retry", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    seed(useAppStore, {
      mainMessages: [],
      entries: [
        delegateEntry({
          status: "error",
          error: "Subagent transcript is no longer available.",
          messages: [],
          context: [],
          hasMoreBefore: false,
        }),
      ],
    });
    const html = render();
    assert.match(html, /data-testid="subagent-history-error"/);
    assert.match(html, /Could not load this subagent&#x27;s conversation\./);
    assert.match(html, /Retry/);
    assert.doesNotMatch(
      html,
      /data-testid="subagent-history-empty"/,
      "an unavailable chain is never reported as an empty delegate",
    );
    assert.doesNotMatch(html, /This subagent has no messages yet\./);
  } finally {
    await vite.close();
  }
});

test("a failed refresh keeps the delegate's rows beside its inline error", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    seed(useAppStore, {
      mainMessages: [],
      entries: [
        delegateEntry({
          error: "host unavailable",
        }),
      ],
    });
    const html = render();
    assert.match(html, /The cache misses were a stale key\./, "loaded rows stay rendered");
    assert.match(html, /data-testid="subagent-history-error"/, "the failure is stated inline");
    assert.match(html, /Retry/);
  } finally {
    await vite.close();
  }
});

test("the show-latest trigger appears only while the scope has newer rows", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    seed(useAppStore, {
      mainMessages: [],
      entries: [delegateEntry({ hasMoreAfter: true })],
    });
    const withNewer = render();
    assert.match(withNewer, /data-testid="subagent-show-latest"/);
    assert.match(withNewer, /Show latest messages/);

    seed(useAppStore, {
      mainMessages: [],
      entries: [delegateEntry({ hasMoreAfter: false })],
    });
    const atTail = render();
    assert.doesNotMatch(atTail, /Show latest messages/);
  } finally {
    await vite.close();
  }
});

test("the show-earlier trigger appears only while the page has older rows", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    seed(useAppStore, {
      mainMessages: [],
      entries: [delegateEntry({ hasMoreBefore: true })],
    });
    const withOlder = render();
    assert.match(withOlder, /Show earlier messages/);

    seed(useAppStore, {
      mainMessages: [],
      entries: [delegateEntry({ hasMoreBefore: false })],
    });
    const atHead = render();
    assert.doesNotMatch(atHead, /Show earlier messages/);
  } finally {
    await vite.close();
  }
});

test("a retained range states the omission it stands on", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    seed(useAppStore, {
      mainMessages: [],
      entries: [
        delegateEntry({
          messages: [
            childAnswer("a-11", "call-1", "the search target"),
            childAnswer("a-2100", "call-1", "the newest page"),
          ],
          omittedAfterId: "a-11",
        }),
      ],
    });
    const html = render();
    assert.match(html, /data-testid="subagent-history-omitted"/, "the omission is stated in place");
    assert.match(html, /Earlier messages are omitted here/);
    assert.ok(
      html.indexOf("a-11") < html.indexOf("subagent-history-omitted"),
      "the statement follows the retained row it belongs to",
    );
    assert.ok(
      html.indexOf("subagent-history-omitted") < html.indexOf("a-2100"),
      "the two ranges are never presented as one contiguous conversation",
    );
  } finally {
    await vite.close();
  }
});
