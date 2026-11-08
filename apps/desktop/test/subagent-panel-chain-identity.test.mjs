import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
  One logical subagent, one panel tab.

  A delegation chain reaches the main transcript as several `Task` rows: the
  original dispatch, each `Task(resume …)` the parent model issues after a stop,
  and — before a call's handle lands — the call id the card is keyed by. All of
  them are one child session, so the work panel keeps one tab for it. Opening a
  card of a chain that is already on screen focuses that tab instead of
  stacking a second one, and the tab renders the chain's newest run: an
  already-open panel follows the parent's resume instead of freezing on the
  stopped segment.

  The focused tab keeps its own identity — id, resource, and strip position —
  because the surface mounted for it is that tab's surface. That is what keeps
  the panel's local state (an unsent draft, staged images, scroll position)
  across an open of a different identity of the same chain, so the assertions
  here are about the tab the user already has, never about a rebuilt one.

  The flow is the real renderer one: the app store's own `handleAgentEvent`
  consumes the envelopes the host emits for a stopped run and for the parent's
  resume, then the real `SubagentTranscriptTab` renders from that store state.
*/

const root = fileURLToPath(new URL("..", import.meta.url));

const at = (second) =>
  new Date(Date.parse("2026-05-01T10:00:00.000Z") + second * 1000).toISOString();

const envelope = (event, turnId, extra = {}) => ({
  sessionId: "s1",
  turnId,
  ts: Date.parse(at(0)),
  event,
  ...extra,
});

function taskRow({
  id,
  delegationId,
  status,
  task = "Investigate the cache layer.",
  resume,
  at: second = 2,
  extra = {},
}) {
  const result = {
    content: [{ type: "text", text: `Delegation ${delegationId}: ${status}.` }],
    details: {
      delegationId,
      agent: "explorer",
      status,
      startedAt: Date.parse(at(0)),
      modelId: "test-model",
      thinkingLevel: "high",
      turns: 1,
      toolCalls: 1,
      ...extra,
    },
  };
  return {
    id,
    role: "tool",
    content: JSON.stringify(result),
    createdAt: at(second),
    toolCallId: id,
    toolName: "Task",
    toolArgs: { agent: "explorer", task, ...(resume ? { resume } : {}) },
    toolStatus: "success",
    toolResult: result,
    toolCompletedAt: at(second + 1),
    toolDurationMs: 1000,
    status: "complete",
    isError: false,
  };
}

const childAnswer = (id, callId, content, second) => ({
  id,
  role: "assistant",
  content,
  createdAt: at(second),
  parentToolCallId: callId,
  agentName: "explorer",
  status: "complete",
});

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
  const { SubagentTaskCard } = await vite.ssrLoadModule(
    "/src/features/chat/transcript/SubagentTaskCard.tsx",
  );
  const { SubagentChainKeyProvider } = await vite.ssrLoadModule(
    "/src/lib/subagent-chain-provider.tsx",
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
  // SSR reads selectors from the initial-state snapshot, so the committed state
  // is also handed to the renderer through the same fixture the other panel
  // tests use instead of a second store.
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
  const renderCard = (message) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          SubagentChainKeyProvider,
          { messages: useAppStore.getState().messages },
          createElement(SubagentTaskCard, { message }),
        ),
      ),
    );
  return {
    vite,
    render,
    renderCard,
    paint,
    useAppStore,
    ...chain,
  };
}

function seed(store, messages, { running = false, tabs = [] } = {}) {
  store.setState({
    activeSessionId: "s1",
    sessions: [{ id: "s1", source: "local", title: "fixture" }],
    messages,
    retainedTranscripts: {},
    transcriptViews: {},
    sessionHistory: {},
    agentStatuses: running ? { s1: { currentTurnId: "turn-parent" } } : {},
    runningSessions: running ? { s1: true } : {},
    isRunning: running,
    pendingPermissions: {},
    pendingAsks: {},
    page: "chat",
    workspace: null,
    settings: { enterToSend: true },
    workPanelOpen: true,
    workPanelTabs: tabs,
    activeWorkPanelTabId: tabs.at(-1)?.id ?? null,
    workPanelContexts: {},
    workPanelFileRequest: null,
  });
}

const subagentTabs = (store, state = store.getState()) =>
  state.workPanelTabs.filter((tab) => tab.kind === "subagent");

const reviewTab = { id: "review", kind: "review" };
const openChainTab = (label = "Investigate the cache layer.") => ({
  id: "subagent:d1",
  kind: "subagent",
  resource: "d1",
  label,
});

test("a parent resume of a stopped subagent shows the resumed run in the tab that was already open", async () => {
  const { vite, render, paint, useAppStore, subagentChainSameDelegate } = await setup();
  try {
    const stopped = taskRow({ id: "call-task-1", delegationId: "d1", status: "stopped" });
    seed(
      useAppStore,
      [
        { id: "u1", role: "user", content: "Investigate the cache layer.", createdAt: at(0) },
        stopped,
        childAnswer("child-a1", "call-task-1", "Reading the cache module.", 4),
      ],
      { running: false, tabs: [reviewTab, openChainTab()] },
    );

    // The parent model resumes the stopped chain: a new `Task(resume d1)` call
    // whose own handle is `d2`, then the resumed run's first row.
    const deliver = (item) => useAppStore.getState().handleAgentEvent(item);
    deliver(
      envelope(
        {
          type: "tool_start",
          toolCallId: "call-task-2",
          toolName: "Task",
          args: { agent: "explorer", task: "Continue the review yourself.", resume: "d1" },
        },
        "turn-parent-2",
      ),
    );
    deliver(
      envelope(
        {
          type: "tool_end",
          toolCallId: "call-task-2",
          toolName: "Task",
          isError: false,
          result: {
            content: [{ type: "text", text: "Delegation d2 started" }],
            details: {
              delegationId: "d2",
              agent: "explorer",
              status: "running",
              resumedFrom: "d1",
              startedAt: Date.parse(at(0)),
              modelId: "test-model",
              thinkingLevel: "high",
              turns: 1,
              toolCalls: 1,
              executionTurnId: "turn-parent-2",
            },
          },
        },
        "turn-parent-2",
      ),
    );
    deliver(
      envelope(
        { type: "message_end", message: childAnswer("child-a2", "call-task-2", "Continuing the cache work.", 20) },
        "turn-parent-2",
        { parentToolCallId: "call-task-2", agentName: "explorer" },
      ),
    );

    assert.equal(
      subagentChainSameDelegate(useAppStore.getState().messages, "d1", "d2"),
      true,
      "the resumed delegation must resolve to the same subagent as its chain",
    );

    // The tab that was already open — no click, no remount — is what the user
    // is looking at while the parent resumes. It renders the resumed run from
    // the live session rows the app-scoped event subscription kept updating,
    // and the parent turn is still live, so it offers that run's own Stop.
    useAppStore.setState({
      runningSessions: { s1: true },
      agentStatuses: { s1: { currentTurnId: "turn-parent-2" } },
    });
    paint(useAppStore);
    const alreadyOpen = render("d1");
    assert.match(alreadyOpen, /Continue the review yourself\./);
    assert.match(alreadyOpen, /data-message-id="child-a2"/);
    assert.match(alreadyOpen, /stop-btn/);

    // The user clicks the new resume card, whose identity is the new delegation.
    // It is the same child, so the request lands in the tab already on screen.
    useAppStore.getState().openSubagentTab("d2", "Continue the review yourself.");

    assert.deepEqual(
      useAppStore.getState().workPanelTabs.map((tab) => tab.id),
      ["review", "subagent:d1"],
      "the resumed card must focus the chain's open tab instead of stacking a second one",
    );
    assert.equal(useAppStore.getState().activeWorkPanelTabId, "subagent:d1");
    assert.deepEqual(
      subagentTabs(useAppStore).map((tab) => tab.resource),
      ["d1"],
      "the tab keeps the identity its surface is mounted under, so nothing remounts",
    );
    assert.equal(
      subagentTabs(useAppStore)[0].label,
      "Investigate the cache layer.",
      "a later prompt of the same chain does not rename the tab's work",
    );
    // Pane-local state (the composer draft, staged images, scroll) lives in the
    // surface mounted for this resource; a stable resource is what keeps it.
    assert.equal(subagentTabs(useAppStore).length, 1);

    // The focused tab renders the whole chain, including the run the parent
    // just resumed — the panel an open tab already was is not stranded on the
    // stopped segment.
    paint(useAppStore);
    const html = render(subagentTabs(useAppStore)[0].resource);
    assert.match(html, /data-testid="subagent-transcript-tab"/);
    assert.match(html, /Investigate the cache layer\./);
    assert.match(html, /Continue the review yourself\./);
    assert.match(html, /data-message-id="child-a1"/);
    assert.match(html, /data-message-id="child-a2"/);
    assert.match(html, /Continuing the cache work\./);
    assert.match(html, /stop-btn/, "the resumed run is live, so the panel offers its own Stop");

    // Opening the original card again is the same subagent: still one tab, same
    // identity, same conversation, no duplicate of either prompt.
    useAppStore.getState().openSubagentTab("d1", "Investigate the cache layer.");
    assert.deepEqual(
      useAppStore.getState().workPanelTabs.map((tab) => tab.id),
      ["review", "subagent:d1"],
      "the original card must land in the same tab the chain already has",
    );
    assert.equal(useAppStore.getState().activeWorkPanelTabId, "subagent:d1");
    paint(useAppStore);
    const reopened = render(subagentTabs(useAppStore)[0].resource);
    assert.equal(
      reopened.split("Continue the review yourself.").length - 1,
      1,
      "the resumed prompt must render exactly once",
    );
    assert.match(reopened, /data-message-id="child-a2"/);
  } finally {
    await vite.close();
  }
});

test("a card opened before its handle lands keeps its tab when the delegation id arrives", async () => {
  const { vite, useAppStore } = await setup();
  try {
    // A card is clickable the moment the model emits its `Task` call: the tab
    // is keyed by the call id until the run's own handle arrives.
    const creating = {
      id: "call-create-1",
      role: "tool",
      content: "",
      createdAt: at(2),
      toolCallId: "call-create-1",
      toolName: "Task",
      toolArgs: { agent: "explorer", task: "Map the cache invalidation path." },
      toolStatus: "running",
      status: "streaming",
    };
    seed(useAppStore, [creating], { running: true });
    useAppStore.getState().openSubagentTab("call-create-1", "Map the cache invalidation path.");
    assert.deepEqual(useAppStore.getState().workPanelTabs.map((tab) => tab.id), [
      "subagent:call-create-1",
    ]);

    useAppStore.getState().handleAgentEvent(
      envelope(
        {
          type: "message_end",
          message: taskRow({
            id: "call-create-1",
            delegationId: "d7",
            status: "running",
            task: "Map the cache invalidation path.",
          }),
        },
        "turn-parent",
      ),
    );

    // The same card now carries the run's handle; opening it is the same child,
    // so the tab keeps the identity its surface was mounted under.
    useAppStore.getState().openSubagentTab("d7", "Map the cache invalidation path.");
    assert.deepEqual(
      useAppStore.getState().workPanelTabs.map((tab) => tab.id),
      ["subagent:call-create-1"],
      "the arriving identity must not rebuild the tab the user already has",
    );
    assert.equal(subagentTabs(useAppStore).length, 1);
    assert.equal(subagentTabs(useAppStore)[0].resource, "call-create-1");
  } finally {
    await vite.close();
  }
});

test("parallel delegates keep their own tabs, and unrelated ids never merge", async () => {
  const { vite, useAppStore, subagentChainSameDelegate } = await setup();
  try {
    seed(useAppStore, [
      taskRow({ id: "call-a", delegationId: "d1", status: "stopped" }),
      taskRow({ id: "call-b", delegationId: "d9", status: "running", task: "Check the write path." }),
    ]);
    useAppStore.getState().openSubagentTab("d1", "Investigate the cache layer.");
    useAppStore.getState().openSubagentTab("d9", "Check the write path.");
    assert.deepEqual(useAppStore.getState().workPanelTabs.map((tab) => tab.id), [
      "subagent:d1",
      "subagent:d9",
    ]);
    assert.equal(useAppStore.getState().activeWorkPanelTabId, "subagent:d9");
    assert.equal(
      subagentChainSameDelegate(useAppStore.getState().messages, "d1", "d9"),
      false,
      "separate dispatches are separate subagents",
    );
    // A third, unrelated delegate never lands in either tab.
    useAppStore.getState().openSubagentTab("d-unrelated", "Something else.");
    assert.deepEqual(useAppStore.getState().workPanelTabs.map((tab) => tab.id), [
      "subagent:d1",
      "subagent:d9",
      "subagent:d-unrelated",
    ]);
  } finally {
    await vite.close();
  }
});

test("same-delegate resolution covers resume links, bare call ids, and unknown ids", async () => {
  const { vite, subagentChainSameDelegate } = await setup();
  try {
    const messages = [
      taskRow({ id: "call-1", delegationId: "d1", status: "stopped" }),
      taskRow({ id: "call-2", delegationId: "d2", status: "stopped", resume: "d1" }),
      taskRow({ id: "call-3", delegationId: "d3", status: "running", resume: "d2" }),
      childAnswer("child-1", "call-1", "first row", 4),
    ];
    assert.equal(subagentChainSameDelegate(messages, "d1", "d1"), true);
    assert.equal(subagentChainSameDelegate(messages, "d1", "d3"), true);
    assert.equal(subagentChainSameDelegate(messages, "d3", "d1"), true);
    assert.equal(subagentChainSameDelegate(messages, "call-1", "d2"), true, "a card keyed by its call id names the same chain");
    assert.equal(subagentChainSameDelegate(messages, "d1", "missing"), false);
    assert.equal(subagentChainSameDelegate(messages, "", "d1"), false);
    assert.equal(subagentChainSameDelegate([], "d1", "d2"), false);
  } finally {
    await vite.close();
  }
});

test("every card of a chain reports the open panel, and no other card does", async () => {
  const { vite, renderCard, paint, useAppStore } = await setup();
  try {
    const first = taskRow({ id: "call-1", delegationId: "d1", status: "stopped" });
    const resumed = taskRow({
      id: "call-2",
      delegationId: "d2",
      status: "running",
      task: "Continue the review yourself.",
      resume: "d1",
      at: 10,
    });
    const unrelated = taskRow({
      id: "call-3",
      delegationId: "d9",
      status: "running",
      task: "Check the write path.",
      at: 12,
    });
    // The strip holds the chain's original tab, as it does after the user
    // opened the dispatch's card.
    seed(useAppStore, [first, resumed, unrelated], {
      running: true,
      tabs: [reviewTab, openChainTab()],
    });
    paint(useAppStore);

    const openCard = (message) => {
      const html = renderCard(message);
      return /class="tool-row subagent-task is-panel-open/.test(html);
    };
    // Both cards of the open chain read as open — the dispatch and the parent's
    // resume, whose own delegation id the strip does not hold.
    assert.equal(openCard(first), true, "the dispatch card names the open panel");
    assert.equal(openCard(resumed), true, "the resume card names the same open panel");
    assert.equal(openCard(unrelated), false, "another delegate is not this panel");

    // Activating a different child's tab moves the mark with it.
    useAppStore.getState().openSubagentTab("d9", "Check the write path.");
    paint(useAppStore);
    assert.equal(openCard(first), false, "a closed surface is not the open panel");
    assert.equal(openCard(resumed), false);
    assert.equal(openCard(unrelated), true);
  } finally {
    await vite.close();
  }
});

test("a later open refreshes a title the tab never captured, and an alias never renames it", async () => {
  const { vite, useAppStore } = await setup();
  try {
    seed(useAppStore, [
      taskRow({ id: "call-1", delegationId: "d1", status: "stopped" }),
      taskRow({ id: "call-2", delegationId: "d2", status: "running", task: "Continue the review yourself.", resume: "d1", at: 10 }),
    ]);
    // A card that had no title yet opens first: the strip falls back to its own
    // localized name until a real one arrives.
    useAppStore.getState().openSubagentTab("d1");
    assert.equal(subagentTabs(useAppStore)[0].label, undefined);
    // The same card opened again once the title resolved states it.
    useAppStore.getState().openSubagentTab("d1", "Investigate the cache layer.");
    assert.equal(subagentTabs(useAppStore)[0].label, "Investigate the cache layer.");
    // A resume card of the same chain does not rename the tab's work.
    useAppStore.getState().openSubagentTab("d2", "Continue the review yourself.");
    assert.equal(subagentTabs(useAppStore)[0].label, "Investigate the cache layer.");
    assert.deepEqual(useAppStore.getState().workPanelTabs.map((tab) => tab.id), ["subagent:d1"]);
  } finally {
    await vite.close();
  }
});

test("a conversation's chains never resolve from another conversation's rows", async () => {
  const { vite, useAppStore } = await setup();
  try {
    // s1 is the visible conversation and holds the d1 -> d2 chain. s2 is a
    // conversation the panel can be asked to open something in, and holds no
    // rows at all: nothing about it may be resolved from s1's transcript.
    seed(useAppStore, [
      taskRow({ id: "call-1", delegationId: "d1", status: "stopped" }),
      taskRow({ id: "call-2", delegationId: "d2", status: "running", task: "Continue the review yourself.", resume: "d1", at: 10 }),
    ], { tabs: [reviewTab, openChainTab()] });
    useAppStore.setState({
      sessions: [
        { id: "s1", source: "local", title: "one" },
        { id: "s2", source: "local", title: "two" },
      ],
      retainedTranscripts: {},
    });

    useAppStore.getState().activateWorkPanelTab("review");
    useAppStore.getState().openWorkPanelTabForSession("s2", {
      id: "subagent:d1",
      kind: "subagent",
      resource: "d1",
      label: "Investigate the cache layer.",
    });
    useAppStore.getState().openWorkPanelTabForSession("s2", {
      id: "subagent:d2",
      kind: "subagent",
      resource: "d2",
      label: "Continue the review yourself.",
    });

    const state = useAppStore.getState();
    assert.deepEqual(
      state.workPanelContexts.s2.tabs.map((tab) => tab.id),
      ["subagent:d1", "subagent:d2"],
      "without rows of its own a conversation cannot prove the two ids are one child",
    );
    assert.deepEqual(
      state.workPanelTabs.map((tab) => tab.id),
      ["review", "subagent:d1"],
      "the visible conversation's strip is unchanged by an open in another one",
    );
    assert.equal(state.activeWorkPanelTabId, "review");
  } finally {
    await vite.close();
  }
});
