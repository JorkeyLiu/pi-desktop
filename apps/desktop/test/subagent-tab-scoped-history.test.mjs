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
    runs: [],
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
  const {
    applySubagentHistoryPage,
    createSubagentHistoryEntry,
    subagentHistoryMessages,
    subagentHistoryTranscript,
  } = await vite.ssrLoadModule("/src/lib/subagent-history.ts");
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
  return {
    vite,
    render,
    useAppStore,
    applySubagentHistoryPage,
    createSubagentHistoryEntry,
    subagentHistoryMessages,
    subagentHistoryTranscript,
  };
}
/**
 * The transcript the panel draws, flattened to the identities that reach the
 * DOM: a turn contributes its Task brief only when the retained window covers
 * the run's opening, then its own rows in physical order.
 */
function transcriptMessageIds(entry, subagentHistoryTranscript, live = []) {
  const transcript = subagentHistoryTranscript(entry, live, "d1");
  assert.ok(transcript, "the entry builds a transcript");
  return transcript.turns.flatMap((turn) => [
    ...(turn.showPrompt ? [turn.messageId] : []),
    ...turn.rows.map((row) => row.message.id),
  ]);
}

function renderedMessageIds(html) {
  return Array.from(html.matchAll(/data-message-id="([^"]+)"/g), (match) => match[1]);
}

function scopedDetail(messages, messageStart, context, hasMoreBefore, runs = [], hasMoreAfter = false) {
  return {
    id: "s1",
    title: "fixture",
    messages,
    messageStart,
    messageEnd: messageStart + messages.length,
    messageCount: 100,
    hasMoreBefore,
    hasMoreAfter,
    historyScope: { kind: "delegation", id: "d1" },
    historyContext: context,
    historyRuns: runs.length ? runs : undefined,
  };
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

test("a historical window keeps the jump control and never draws the live tail as contiguous", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    const target = childAnswer("a-11", "call-1", "the search target");
    seed(useAppStore, {
      mainMessages: [
        message("u-1", "user", "Summarize the issue"),
        childAnswer("a-2100", "call-1", "the newest live row"),
      ],
      entries: [
        delegateEntry({
          messages: [target],
          pages: [
            {
              start: 10,
              end: 12,
              ids: [target.id],
              hasMoreBefore: false,
              hasMoreAfter: true,
            },
          ],
          hasMoreAfter: true,
        }),
      ],
    });
    const html = render();
    assert.match(html, /the search target/, "the window around the target renders");
    assert.doesNotMatch(html, /the newest live row/, "a disconnected live row is not drawn");
    assert.match(html, /class="jump-latest-btn subagent-transcript-jump"/, "the range keeps its jump control");
    assert.doesNotMatch(html, /data-testid="subagent-history-omitted"/, "no omission marker exists");
    assert.doesNotMatch(html, /Show latest messages/, "there is no separate show-latest control");
    assert.doesNotMatch(html, /Show earlier messages/, "there is no separate show-earlier control");
  } finally {
    await vite.close();
  }
});

test("a window at the tail draws the live rows it follows", async () => {
  const { vite, render, useAppStore } = await setup();
  try {
    const page = childAnswer("a-10", "call-1", "the durable tail row");
    seed(useAppStore, {
      mainMessages: [childAnswer("a-11", "call-1", "the streaming row")],
      entries: [
        delegateEntry({
          messages: [page, childAnswer("a-11", "call-1", "the streaming row")],
          pages: [{ start: 10, end: 11, ids: [page.id], hasMoreBefore: true }],
          hasMoreAfter: false,
        }),
      ],
    });
    const html = render();
    assert.match(html, /the durable tail row/);
    assert.match(html, /the streaming row/, "a window at the tail keeps following live output");
    assert.doesNotMatch(html, /class="jump-latest-btn subagent-transcript-jump"/, "a tail window has nothing later");
  } finally {
    await vite.close();
  }
});

/**
 * A run's prompt is its chronological opening, not a page header. A window cut
 * inside the run keeps the children it holds and draws no prompt; the opening
 * appears once, at the head of the run, when an older page actually reaches the
 * run's first selected child.
 */
test("a window cut inside a run draws children without its prompt until the page reaches the first child", async () => {
  const {
    vite,
    render,
    useAppStore,
    applySubagentHistoryPage,
    createSubagentHistoryEntry,
    subagentHistoryTranscript,
  } = await setup();
  try {
    const root = taskRecord();
    const runs = [
      { callId: "call-1", taskMessageId: "call-1-row", taskIndex: 1, firstChildIndex: 2 },
    ];
    const thinkingOnly = message("a-05", "assistant", "", {
      parentToolCallId: "call-1",
      thinking: "Inspect the older page before answering.",
      agentName: "explorer",
    });
    let entry = createSubagentHistoryEntry("s1", "d1", 1);
    entry = applySubagentHistoryPage(entry, scopedDetail([
      childAnswer("a-06", "call-1", "newest row"),
      childAnswer("a-07", "call-1", "newer row"),
      childAnswer("a-08", "call-1", "newer answer"),
    ], 6, [root], true, runs), "initial", 1);
    assert.deepEqual(
      transcriptMessageIds(entry, subagentHistoryTranscript),
      ["a-06", "a-07", "a-08"],
      "a latest window cut inside the run draws its children and no prompt",
    );
    const ordinaryMainRow = message("u-main", "user", "ordinary parent prompt");
    seed(useAppStore, { mainMessages: [ordinaryMainRow], entries: [entry] });
    const partialHtml = render();
    assert.doesNotMatch(partialHtml, /message-row user/, "a partial window draws no prompt row");
    assert.doesNotMatch(partialHtml, /Investigate the cache/, "the Task prompt is not a sticky page header");
    assert.doesNotMatch(partialHtml, /ordinary parent prompt/, "ordinary top-level main rows stay outside the local scope");

    // Several older pages prepend children in true order, still without the
    // prompt: the retained window has not reached the run's first child.
    entry = applySubagentHistoryPage(entry, scopedDetail([
      childAnswer("a-03", "call-1", "older row"),
      childAnswer("a-04", "call-1", "older answer"),
      thinkingOnly,
    ], 3, [root], true, runs), "before", 2);
    assert.deepEqual(
      transcriptMessageIds(entry, subagentHistoryTranscript),
      ["a-03", "a-04", "a-05", "a-06", "a-07", "a-08"],
      "an older page inside the run stays prompt-free",
    );
    seed(useAppStore, { mainMessages: [ordinaryMainRow], entries: [entry] });
    const olderHtml = render();
    assert.doesNotMatch(olderHtml, /message-row user/, "no prompt row reappears above the older children");
    assert.doesNotMatch(olderHtml, /Investigate the cache/);

    // The page that reaches the run's first child introduces the prompt once.
    entry = applySubagentHistoryPage(entry, scopedDetail([
      childAnswer("a-02", "call-1", "first child"),
    ], 2, [root], false, runs), "before", 3);
    const expected = [
      "call-1-row",
      "a-02", "a-03", "a-04", "a-05", "a-06", "a-07", "a-08",
    ];
    assert.deepEqual(
      transcriptMessageIds(entry, subagentHistoryTranscript),
      expected,
      "the run opening appears once at the head, before its true child order",
    );
    const transcript = subagentHistoryTranscript(entry, [], "d1");
    assert.deepEqual(
      transcript.turns.map(({ callId, messageId, showPrompt }) => ({ callId, messageId, showPrompt })),
      [{ callId: "call-1", messageId: "call-1-row", showPrompt: true }],
      "the prompt keeps the Task row's stable source identity",
    );
    seed(useAppStore, { mainMessages: [ordinaryMainRow], entries: [entry] });
    const headHtml = render();
    assert.deepEqual(renderedMessageIds(headHtml), expected, "every fragment, including a thinking-only row, anchors");
    assert.equal(renderedMessageIds(headHtml).filter((id) => id === "call-1-row").length, 1);
    assert.equal(renderedMessageIds(headHtml).filter((id) => id === "a-05").length, 1);
    assert.match(headHtml, /Investigate the cache/, "the opening is drawn once the window covers it");
    assert.doesNotMatch(headHtml, /ordinary parent prompt/);
  } finally {
    await vite.close();
  }
});

/**
 * A later Task/resume prompt belongs to its own run start, not to the chain
 * head: the chain keeps older rows, and only the resume run's opening is inside
 * the retained window.
 */
test("a later resume opening appears at its own run start even while the chain has older rows", async () => {
  const {
    vite,
    render,
    useAppStore,
    applySubagentHistoryPage,
    createSubagentHistoryEntry,
    subagentHistoryTranscript,
  } = await setup();
  try {
    const root = taskRecord();
    const resume = message("call-2-row", "tool", "", {
      toolName: "Task",
      toolCallId: "call-2",
      toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Continue the cache investigation", resume: "call-1" },
      toolResult: { details: { delegationId: "d2", agent: "explorer", status: "completed" } },
    });
    const runs = [
      { callId: "call-1", taskMessageId: "call-1-row", taskIndex: 1, firstChildIndex: 2 },
      { callId: "call-2", taskMessageId: "call-2-row", taskIndex: 19, firstChildIndex: 20 },
    ];
    let entry = createSubagentHistoryEntry("s1", "d1", 1);
    entry = applySubagentHistoryPage(entry, scopedDetail([
      childAnswer("a-10", "call-1", "root segment answer"),
    ], 10, [root, resume], true, runs), "initial", 1);
    assert.deepEqual(
      transcriptMessageIds(entry, subagentHistoryTranscript),
      ["a-10"],
      "neither run's opening is inside a window that covers neither first child",
    );

    entry = applySubagentHistoryPage(entry, scopedDetail([
      childAnswer("a-20", "call-2", "resume segment answer"),
      childAnswer("a-21", "call-2", "resume follow-up answer"),
    ], 20, [root, resume], true, runs, true), "after", 2);
    assert.deepEqual(
      transcriptMessageIds(entry, subagentHistoryTranscript),
      ["a-10", "call-2-row", "a-20", "a-21"],
      "the resume prompt appears at its run start, not at the chain's older rows",
    );
    seed(useAppStore, { mainMessages: [], entries: [entry] });
    const resumeHtml = render();
    assert.equal((resumeHtml.match(/message-row user/g) ?? []).length, 1, "exactly one prompt row is drawn");
    assert.match(resumeHtml, /data-message-id="call-2-row"/);
    assert.doesNotMatch(resumeHtml, /Investigate the cache/, "the root prompt stays out of a window that has not reached it");
    assert.match(resumeHtml, /Continue the cache investigation/);

    entry = applySubagentHistoryPage(entry, scopedDetail([
      childAnswer("a-02", "call-1", "first root child"),
    ], 2, [root, resume], false, runs), "before", 3);
    const expected = [
      "call-1-row", "a-02", "a-10",
      "call-2-row", "a-20", "a-21",
    ];
    assert.deepEqual(transcriptMessageIds(entry, subagentHistoryTranscript), expected);
    seed(useAppStore, { mainMessages: [], entries: [entry] });
    const bothHtml = render();
    assert.deepEqual(renderedMessageIds(bothHtml), expected, "each run opens once at its own chain position");
    assert.equal(renderedMessageIds(bothHtml).filter((id) => id === "call-1-row").length, 1);
    assert.equal(renderedMessageIds(bothHtml).filter((id) => id === "call-2-row").length, 1);
    assert.ok(
      bothHtml.indexOf("call-1-row") < bothHtml.indexOf("call-2-row"),
      "run openings keep run order",
    );
  } finally {
    await vite.close();
  }
});

/**
 * "No child row yet" is not "no prompt": a chain that is known but empty, and a
 * run that exists only in the live tail, still open with their Task row.
 */
test("an empty known chain and a live-only run still draw their opening prompt", async () => {
  const { vite, render, useAppStore, createSubagentHistoryEntry, subagentHistoryTranscript } =
    await setup();
  try {
    const empty = delegateEntry({
      status: "empty",
      messages: [],
      context: [taskRecord()],
      hasMoreBefore: false,
      runs: [{ callId: "call-1", taskMessageId: "call-1-row", taskIndex: 1 }],
    });
    seed(useAppStore, { mainMessages: [], entries: [empty] });
    const emptyHtml = render();
    assert.match(emptyHtml, /Investigate the cache/, "a known empty chain still states its prompt");
    assert.equal((emptyHtml.match(/message-row user/g) ?? []).length, 1);
    assert.deepEqual(
      transcriptMessageIds(empty, subagentHistoryTranscript),
      ["call-1-row"],
      "the empty run is an opening with no child rows",
    );

    // Live-only: no durable page names this run, so no physical position is
    // invented; the live Task row opens the run it announces.
    const liveTask = message("call-9-row", "tool", "", {
      toolName: "Task",
      toolCallId: "call-9",
      toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Trace the live cache" },
      toolResult: { details: { delegationId: "d1", agent: "explorer", status: "running" } },
    });
    const liveEntry = createSubagentHistoryEntry("s1", "d1", 1);
    assert.deepEqual(
      transcriptMessageIds(liveEntry, subagentHistoryTranscript, [liveTask]),
      ["call-9-row"],
      "a live-only run keeps its prompt",
    );
  } finally {
    await vite.close();
  }
});

/**
 * An older backend serves scope and context without per-run physical openings.
 * The panel must not guess a head from the chain-wide page bounds: only a
 * window that provably reaches the chain head may draw the prompts.
 */
test("a scoped answer without run metadata drops partial-window prompts instead of guessing a head", async () => {
  const { vite, render, useAppStore, subagentHistoryTranscript } = await setup();
  try {
    const row = childAnswer("a-30", "call-1", "a row inside the chain");
    const partial = delegateEntry({
      messages: [row],
      pages: [{ start: 30, end: 31, ids: [row.id], hasMoreBefore: true, hasMoreAfter: false }],
      messageStart: 30,
      messageEnd: 31,
      hasMoreBefore: true,
      runs: [],
    });
    assert.deepEqual(transcriptMessageIds(partial, subagentHistoryTranscript), ["a-30"]);
    seed(useAppStore, { mainMessages: [], entries: [partial] });
    const partialHtml = render();
    assert.doesNotMatch(partialHtml, /message-row user/, "an unstated head is not drawn at the page head");
    assert.doesNotMatch(partialHtml, /Investigate the cache/);

    const head = delegateEntry({
      messages: [row],
      pages: [{ start: 10, end: 11, ids: [row.id], hasMoreBefore: false, hasMoreAfter: false }],
      messageStart: 10,
      messageEnd: 11,
      hasMoreBefore: false,
      runs: [],
    });
    assert.deepEqual(
      transcriptMessageIds(head, subagentHistoryTranscript),
      ["call-1-row", "a-30"],
      "a window at the chain head may state the prompt",
    );

    // The legacy physical read holds every selected row, so its prompt is
    // already in the window it renders.
    const legacy = delegateEntry({ scoped: false, runs: [] });
    assert.deepEqual(transcriptMessageIds(legacy, subagentHistoryTranscript), [
      "call-1-row",
      "a-10",
    ]);
  } finally {
    await vite.close();
  }
});
