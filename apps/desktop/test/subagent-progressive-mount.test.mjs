/**
 * A delegate panel no longer puts a whole scoped page into one commit.
 *
 * The panel's *data* is unchanged: apply a page, project the entry's messages,
 * build the transcript, and flatten it. These cases render that projection
 * through the real component and assert the commit shape around it - the first
 * commit mounts a bounded run near the tail, the loaded rows arrive in batches,
 * and every loaded row (prompt rows included) ends up mounted in true order.
 *
 * SSR renders exactly one commit, so a long window's markup is the bounded run
 * and its rows states the batches that follow. The projection cases drive the
 * same reducer the pane drives, so the rows the markup does not show are
 * asserted through the state they land in rather than by pretending the first
 * commit is the finished list.
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
    toolResult: { details: { delegationId: "d1", agent: "explorer", status: "completed" } },
  });
}

const childId = (index) => `child-${index}`;

function childAnswer(index, callId = "call-1") {
  return message(childId(index), "assistant", `child row ${index}`, {
    parentToolCallId: callId,
    agentName: "explorer",
    status: "complete",
  });
}

function pageEntry({
  count,
  start,
  callId = "call-1",
  runs = [],
  hasMoreBefore = true,
  prefix = "child",
} = {}) {
  const messages = Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return prefix === "child"
      ? childAnswer(index, callId)
      : message(`${prefix}-${index}`, "assistant", `row ${index}`, {
          parentToolCallId: callId,
          agentName: "explorer",
          status: "complete",
        });
  });
  return {
    sessionId: "s1",
    tabKey: "d1",
    canonicalId: "d1",
    aliases: ["d1"],
    status: "ready",
    messages,
    context: [taskRecord()],
    runs,
    pages: [
      {
        start,
        end: start + count,
        ids: messages.map((row) => row.id),
        hasMoreBefore,
        hasMoreAfter: false,
      },
    ],
    messageStart: start,
    messageEnd: start + count,
    messageCount: 5000,
    hasMoreBefore,
    hasMoreAfter: false,
    finalized: true,
    refreshing: false,
    focus: null,
    scoped: true,
    touched: 1,
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
  const hydration = await vite.ssrLoadModule("/src/lib/subagent-hydration.ts");
  const {
    applySubagentHistoryPage,
    createSubagentHistoryEntry,
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
    hydration,
    applySubagentHistoryPage,
    createSubagentHistoryEntry,
    subagentHistoryTranscript,
  };
}

function renderedMessageIds(html) {
  return Array.from(html.matchAll(/data-message-id="([^"]+)"/g), (match) => match[1]);
}

const hydrationState = (html) => (html.match(/data-hydration-state="([^"]+)"/) ?? [])[1] ?? null;

function seed(store, entries) {
  const subagentHistory = {};
  for (const entry of entries) {
    subagentHistory[entry.sessionId] ??= {};
    subagentHistory[entry.sessionId][entry.tabKey] = entry;
  }
  Object.assign(store.getInitialState(), {
    activeSessionId: "s1",
    sessions: [{ id: "s1", source: "local", title: "fixture" }],
    messages: [],
    subagentHistory,
    agentStatuses: {},
    runningSessions: {},
    settings: { enterToSend: true },
  });
}

/** Flatten the unit projection the component mounts from these turns. */
function unitsOf(turns, hydration) {
  return hydration.buildSubagentTranscriptUnits(turns);
}

const idsOf = (rows) => rows.map((row) => row.messageId);

/** Drive the batches with the same reducer the frame pump uses. */
function drain(state, hydration) {
  const steps = [state];
  let guard = 0;
  while (hydration.subagentHydrationPending(state)) {
    state = hydration.reduceSubagentHydration(state, { kind: "step" });
    steps.push(state);
    guard += 1;
    assert.ok(guard < 100, "the batches terminate");
  }
  return steps;
}

test("a long scoped window mounts a bounded run near the tail first", async () => {
  const { vite, render, useAppStore, hydration } = await setup();
  try {
    const entry = pageEntry({ count: 500, start: 2500 });
    seed(useAppStore, [entry]);
    const html = render();
    const ids = renderedMessageIds(html);
    assert.equal(
      hydrationState(html),
      "pending",
      "the first commit says the loaded rows are still arriving",
    );
    assert.equal(
      ids.length,
      hydration.SUBAGENT_HYDRATION_FIRST_ROWS,
      `the first commit mounts a bounded run (${ids.length} rows)`,
    );
    assert.deepEqual(
      ids,
      entry.messages.slice(-hydration.SUBAGENT_HYDRATION_FIRST_ROWS).map((row) => row.id),
      "the first commit is the newest rows of the window, not its head",
    );
    assert.ok(ids.includes(childId(2999)), "the tail row the reader opens on is drawn");
    assert.ok(!ids.includes(childId(2500)), "the window's head waits for a batch");
    assert.doesNotMatch(html, /Investigate the cache/, "the prompt is not a page header");
  } finally {
    await vite.close();
  }
});

test("a window that fits the first batch mounts whole and says it is ready", async () => {
  const { vite, render, useAppStore, hydration } = await setup();
  try {
    const entry = pageEntry({ count: 8, start: 10, hasMoreBefore: false });
    seed(useAppStore, [entry]);
    const html = render();
    assert.equal(hydrationState(html), "ready", "a short window has no batches to spend");
    assert.deepEqual(
      renderedMessageIds(html),
      ["call-1-row", ...entry.messages.map((row) => row.id)],
      "every row of a short window is in the first commit, prompt at its run head",
    );
    assert.ok(hydration.SUBAGENT_HYDRATION_FIRST_ROWS > 8, "the short window is inside one batch");
  } finally {
    await vite.close();
  }
});

test("the batches mount every loaded row of the window in true order", async () => {
  const { vite, render, useAppStore, hydration, subagentHistoryTranscript } = await setup();
  try {
    const entry = pageEntry({ count: 500, start: 2500 });
    seed(useAppStore, [entry]);
    const html = render();
    const firstIds = renderedMessageIds(html);
    const transcript = subagentHistoryTranscript(entry, [], "d1");
    const units = unitsOf(transcript.turns, hydration);
    assert.equal(units.length, 500, "the projection is the whole loaded window");
    const state = hydration.initialSubagentHydration(units.length);
    const steps = drain(state, hydration);
    const mounted = steps.map((step) => idsOf(hydration.subagentVisibleRows(units, step)));
    assert.deepEqual(mounted[0], firstIds, "the markup is the first commit, not the whole page");
    for (const [index, ids] of mounted.entries()) {
      assert.deepEqual(
        ids,
        entry.messages.slice(entry.messages.length - ids.length).map((row) => row.id),
        `batch ${index} is one contiguous trailing run of the window`,
      );
    }
    assert.deepEqual(
      mounted.at(-1),
      entry.messages.map((row) => row.id),
      "the finished list is every loaded row in physical order",
    );
    assert.ok(steps.length > 1, "a 500-row page costs more than one commit");
    assert.ok(
      steps.length <= 6,
      `a 500-row page finishes in a handful of frames (${steps.length} commits)`,
    );
  } finally {
    await vite.close();
  }
});

test("an older page is revealed under the rows the reader already had", async () => {
  const {
    vite,
    render,
    useAppStore,
    hydration,
    applySubagentHistoryPage,
    createSubagentHistoryEntry,
    subagentHistoryTranscript,
  } = await setup();
  try {
    let entry = pageEntry({ count: 500, start: 2500 });
    entry = applySubagentHistoryPage(
      createSubagentHistoryEntry("s1", "d1", 1),
      {
        id: "s1",
        title: "fixture",
        messages: entry.messages,
        messageStart: 2500,
        messageEnd: 3000,
        messageCount: 5000,
        hasMoreBefore: true,
        hasMoreAfter: false,
        historyScope: { kind: "delegation", id: "d1" },
        historyContext: [taskRecord()],
      },
      "initial",
      1,
    );
    seed(useAppStore, [entry]);
    render();

    const older = pageEntry({ count: 500, start: 2000 });
    entry = applySubagentHistoryPage(
      entry,
      {
        id: "s1",
        title: "fixture",
        messages: older.messages,
        messageStart: 2000,
        messageEnd: 2500,
        messageCount: 5000,
        hasMoreBefore: true,
        hasMoreAfter: false,
        historyScope: { kind: "delegation", id: "d1" },
        historyContext: [taskRecord()],
      },
      "before",
      2,
    );
    const transcript = subagentHistoryTranscript(entry, [], "d1");
    const units = unitsOf(transcript.turns, hydration);
    assert.equal(units.length, 1000, "the window keeps both pages");
    assert.deepEqual(
      idsOf(units).slice(0, 2),
      [childId(2000), childId(2001)],
      "the older page sits at the head of the projection",
    );

    // The reader's page is hydrated, so growth keeps it mounted and hides only
    // the new head rows. Each batch then mounts rows above it, never below.
    let state = { rowCount: 500, start: 0, end: 500 };
    state = hydration.reduceSubagentHydration(state, {
      kind: "rows",
      change: hydration.classifySubagentRowChange(
        entry.messages.slice(500).map((row) => `answer-${row.id}`),
        entry.messages.map((row) => `answer-${row.id}`),
      ),
    });
    assert.equal(hydration.subagentVisibleCount(state), 500, "no row the reader was reading is dropped");
    const steps = drain(state, hydration);
    let previous = idsOf(hydration.subagentVisibleRows(units, steps[0]));
    assert.deepEqual(
      previous,
      Array.from({ length: 500 }, (_, offset) => childId(2500 + offset)),
      "the mounted run is still the page the reader had",
    );
    for (const step of steps.slice(1)) {
      const visible = idsOf(hydration.subagentVisibleRows(units, step));
      assert.deepEqual(
        visible.slice(visible.length - previous.length),
        previous,
        "each batch prepends rows and keeps the ones already mounted",
      );
      assert.ok(visible.length > previous.length, "each batch mounts more of the older page");
      previous = visible;
    }
    assert.deepEqual(previous, idsOf(units), "every loaded row of both pages ends up mounted");
  } finally {
    await vite.close();
  }
});

test("a search hit is reached by bounded batches, never by one unbounded reveal", async () => {
  const { vite, hydration } = await setup();
  try {
    const units = Array.from({ length: 500 }, (_, index) => ({
      kind: "answer",
      key: `answer-${childId(index)}`,
      messageId: childId(index),
    }));
    const target = childId(250);
    const index = units.findIndex((unit) => unit.messageId === target);
    let state = hydration.initialSubagentHydration(units.length);
    assert.equal(hydration.subagentRowMounted(state, index), false, "the hit is above the run");
    let batches = 0;
    while (!hydration.subagentRowMounted(state, index)) {
      const previous = hydration.subagentVisibleCount(state);
      state = hydration.reduceSubagentHydration(state, { kind: "step" });
      const visible = hydration.subagentVisibleCount(state);
      assert.ok(visible > previous, `batch ${batches + 1} mounts rows`);
      assert.ok(
        visible - previous <= hydration.SUBAGENT_HYDRATION_STEP_ROWS,
        `batch ${batches + 1} stays inside one batch (${visible - previous} rows)`,
      );
      batches += 1;
      assert.ok(batches < 10, "the hit is reached in a handful of batches");
    }
    assert.equal(
      hydration.subagentRowMounted(state, index),
      true,
      "the hit is inside the mounted run, so the focus effect can align it",
    );
    assert.ok(hydration.subagentVisibleCount(state) < units.length, "reaching the hit does not mount the whole page");
    assert.equal(
      "revealAll" in hydration,
      false,
      "there is no unbounded reveal for a focus to call",
    );
    const done = hydration.reduceSubagentHydration(state, { kind: "step" });
    assert.equal(
      hydration.subagentVisibleCount(done) - hydration.subagentVisibleCount(state) <=
        hydration.SUBAGENT_HYDRATION_STEP_ROWS,
      true,
      "and the rows after it are one batch each",
    );
  } finally {
    await vite.close();
  }
});

test("a reached run head still draws its prompt once, in the same commit as its first child", async () => {
  const { vite, render, useAppStore, hydration } = await setup();
  try {
    const entry = pageEntry({
      count: 8,
      start: 10,
      hasMoreBefore: false,
      runs: [{ callId: "call-1", taskMessageId: "call-1-row", taskIndex: 1, firstChildIndex: 10 }],
    });
    seed(useAppStore, [entry]);
    const html = render();
    assert.equal(hydrationState(html), "ready");
    const ids = renderedMessageIds(html);
    assert.equal(ids[0], "call-1-row", "the run opens with its Task row");
    assert.deepEqual(
      ids.slice(1),
      Array.from({ length: 8 }, (_, offset) => childId(10 + offset)),
      "the prompt keeps its physical position ahead of the run's first child",
    );
    assert.equal(ids.filter((id) => id === "call-1-row").length, 1, "the prompt appears once");
    assert.match(html, /Investigate the cache/);
  } finally {
    await vite.close();
  }
});
