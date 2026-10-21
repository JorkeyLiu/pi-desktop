/**
 * How a subagent's own figures are presented on the chat surfaces.
 *
 * Two things are checked here. The presenter is a pure UI vocabulary module: it
 * states turns, tool calls, context occupancy and total spend in the reader's
 * language, in one order, with one centred separator — and it states only what
 * the runtime reported. Then the child card renders through that presenter, so
 * the card and the composer's dock cannot disagree about the same report, the
 * running mark sits inline in the status slot, and no step count survives.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { register } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The renderer sources import their siblings bundler-style (extensionless).
const here = fileURLToPath(new URL(".", import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const root = fileURLToPath(new URL("..", import.meta.url));

const {
  SUBAGENT_INFO_SEPARATOR,
  joinSubagentInfo,
  subagentMetricsLine,
  subagentMetricsParts,
  subagentStateParts,
} = await import("../src/lib/subagent-ui-metrics.ts");

const CREATED_AT = "2026-10-18T00:00:00.000Z";

async function translator(language) {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    resources: { [language]: { translation: catalogs[language] } },
  });
  return i18n.getFixedT(language);
}

function taskCall({
  id = "t1",
  toolCallId = "call-1",
  delegationId = "d1",
  status = "completed",
  agent = "manifestor",
  description = "Fix the cache stampede",
  resume,
  metrics,
  toolDurationMs = 32_000,
} = {}) {
  return {
    id,
    role: "tool",
    content: "",
    createdAt: CREATED_AT,
    toolName: "Task",
    toolCallId,
    toolStatus: status === "running" ? "running" : "success",
    toolDurationMs,
    toolArgs: {
      agent,
      description,
      task: "a long brief that is never a title",
      ...(resume === undefined ? {} : { resume }),
    },
    toolResult: {
      details: {
        delegationId,
        agent,
        status,
        ...(metrics ?? {}),
      },
    },
  };
}

const reported = {
  turns: 1,
  toolCalls: 2,
  contextTokens: 12_000,
  usage: { totalTokens: 3_400 },
};

test("the figures read label then value, in one order, in the reader's language", async () => {
  const english = await translator("en");
  assert.deepEqual(subagentMetricsParts(reported, english, "en"), [
    "Turns 1",
    "Tool calls 2",
    "Context 12K",
    "Spent 3.4K",
  ]);
  assert.equal(
    subagentMetricsLine(reported, english, "en"),
    "Turns 1 · Tool calls 2 · Context 12K · Spent 3.4K",
  );
  // Every part is a label followed by its value, never a value with a unit.
  for (const part of subagentMetricsParts(reported, english, "en")) {
    assert.match(part, /^[A-Za-z ]+ [\d.]+[KM]?$/, part);
  }

  // The same report in another language: same order, localized labels and
  // units, no runtime vocabulary (`ctx`, `spent`, `turns`) leaking through.
  const chinese = await translator("zh-CN");
  assert.deepEqual(subagentMetricsParts(reported, chinese, "zh-CN"), [
    "轮次 1",
    "工具调用 2",
    "上下文 1.2万",
    "累计消耗 3400",
  ]);
  assert.equal(
    subagentMetricsLine(reported, chinese, "zh-CN"),
    "轮次 1 · 工具调用 2 · 上下文 1.2万 · 累计消耗 3400",
  );
  for (const part of subagentMetricsParts(reported, chinese, "zh-CN")) {
    assert.match(part, /^\D+ [\d.]+(万)?$/, part);
  }
  assert.equal(SUBAGENT_INFO_SEPARATOR, " · ");
});

test("the four slots always exist: a reported zero is a zero, an unreported figure is a dash", async () => {
  const english = await translator("en");
  // Nothing reported at all still holds four labelled slots, so the card and
  // the dock row keep the same line height instead of collapsing it away.
  assert.deepEqual(subagentMetricsParts(undefined, english, "en"), [
    "Turns —",
    "Tool calls —",
    "Context —",
    "Spent —",
  ]);
  assert.equal(
    subagentMetricsLine(null, english, "en"),
    "Turns — · Tool calls — · Context — · Spent —",
  );
  // A zero the runtime did report is that zero, formatted like any other count.
  assert.deepEqual(
    subagentMetricsParts(
      { turns: 0, toolCalls: 0, contextTokens: 0, usage: { totalTokens: 0 } },
      english,
      "en",
    ),
    ["Turns 0", "Tool calls 0", "Context 0", "Spent 0"],
  );
  // A mixed report dashes only the slots the runtime never sent.
  assert.equal(
    subagentMetricsLine({ turns: 3, contextTokens: 0 }, english, "en"),
    "Turns 3 · Tool calls — · Context 0 · Spent —",
  );
  // An occupancy without counters is a metrics-only report; the counters it
  // never sent stay dashes rather than becoming invented zeros.
  assert.equal(
    subagentMetricsLine({ contextTokens: 41_200 }, english, "en"),
    "Turns — · Tool calls — · Context 41.2K · Spent —",
  );
  // An estimate keeps its label and is never rewritten as a tilde.
  assert.equal(
    subagentMetricsLine(
      { contextTokens: 7_700, contextEstimated: true },
      english,
      "en",
    ),
    "Turns — · Tool calls — · Context 7.7K (est.) · Spent —",
  );
  // An estimate flag without an occupancy marks nothing: there is no figure.
  assert.equal(
    subagentMetricsLine({ turns: 1, contextEstimated: true }, english, "en"),
    "Turns 1 · Tool calls — · Context — · Spent —",
  );
  // Legacy child usage without a total states no spend.
  assert.equal(
    subagentMetricsLine({ usage: { inputTokens: 7_400 } }, english, "en"),
    "Turns — · Tool calls — · Context — · Spent —",
  );
  // A value that is not a non-negative finite number is not a report: it keeps
  // the dash instead of printing `NaN`, `-1` or `Infinity`.
  assert.equal(
    subagentMetricsLine(
      {
        turns: -1,
        toolCalls: Number.NaN,
        contextTokens: -5,
        usage: { totalTokens: Number.POSITIVE_INFINITY },
      },
      english,
      "en",
    ),
    "Turns — · Tool calls — · Context — · Spent —",
  );
  // Every report is the same four slots, in the same order, with the same
  // labels — the line never grows and never shrinks.
  for (const input of [undefined, null, {}, { turns: 0 }, { contextTokens: 1 }]) {
    const parts = subagentMetricsParts(input, english, "en");
    assert.equal(parts.length, 4, JSON.stringify(input));
    assert.deepEqual(
      parts.map((part) => part.split(" ")[0]),
      ["Turns", "Tool", "Context", "Spent"],
    );
  }
});

test("the separator never starts, ends or doubles a line", async () => {
  assert.equal(joinSubagentInfo([]), "");
  assert.equal(joinSubagentInfo(["", null, undefined, false]), "");
  assert.equal(joinSubagentInfo(["a", "", null, "b"]), "a · b");
  assert.equal(joinSubagentInfo([null, "a", undefined]), "a");
  assert.deepEqual(subagentStateParts({ status: "Running" }), ["Running"]);
  assert.deepEqual(subagentStateParts({ status: "Running", duration: "32s" }), [
    "Running",
    "32s",
  ]);
  assert.deepEqual(subagentStateParts({ status: "Running", duration: "" }), [
    "Running",
  ]);
});

async function setup(language) {
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
    lng: language,
    resources: { [language]: { translation: catalogs[language] } },
  });
  const { ToolRow } = await vite.ssrLoadModule("/src/features/chat/transcript/ToolRow.tsx");
  const { TranscriptDisclosureProvider } = await vite.ssrLoadModule(
    "/src/features/chat/transcript/disclosure.tsx",
  );
  const { SubagentTitleProvider } = await vite.ssrLoadModule(
    "/src/lib/subagent-title-provider.tsx",
  );
  const { SubagentChainMetricsProvider } = await vite.ssrLoadModule(
    "/src/lib/subagent-metrics-provider.tsx",
  );
  // A card is mounted the way the transcript mounts it: under the
  // conversation-wide title and chain-metrics providers, with the same
  // `ToolRow` variant the transcript uses for a `Task` call.
  const render = (message, conversation = [message]) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          SubagentTitleProvider,
          { messages: conversation },
          createElement(
            SubagentChainMetricsProvider,
            { messages: conversation },
            createElement(
              TranscriptDisclosureProvider,
              null,
              createElement(ToolRow, { message, variant: "task" }),
            ),
          ),
        ),
      ),
    );
  return { vite, render };
}

function plain(html) {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

test("a card states the role under the title, the figures beneath it, and no step count", async () => {
  const { vite, render } = await setup("en");
  try {
    const html = render(taskCall({ metrics: reported }));
    // The title stays primary; the state sits inline at its right.
    assert.match(html, /<span class="subagent-task-title" title="Fix the cache stampede">/);
    assert.match(html, /class="subagent-task-state"/);
    // The role is on its own line beneath the title, after the title row closes.
    const titleRowEnd = html.indexOf('class="subagent-task-role"');
    assert.ok(titleRowEnd > 0, html.slice(0, 600));
    const titleRow = html.slice(html.indexOf('class="subagent-task-title-row"'), titleRowEnd);
    assert.doesNotMatch(titleRow, /subagent-task-role/);
    assert.match(html, /class="subagent-task-role" title="Subagent">manifestor</);
    // The figures come after the role, localized, through the shared presenter.
    assert.match(
      html,
      /class="subagent-task-metrics"[^>]*>Turns 1 · Tool calls 2 · Context 12K · Spent 3\.4K</,
    );
    assert.ok(html.indexOf("subagent-task-role") < html.indexOf("subagent-task-metrics"));
    // The state reads outcome · runtime, with the dot between.
    assert.equal(
      plain(html.match(/class="subagent-task-state">([\s\S]*?)<\/span><\/span>/)?.[1] ?? ""),
      "Completed · 32s",
    );
    // Steps are gone from the card entirely, and so is the detached spinner.
    assert.doesNotMatch(html, /\bsteps?\b/);
    assert.doesNotMatch(html, /subagent-task-steps/);
    assert.doesNotMatch(html, /class="tool-spinner"/);
  } finally {
    await vite.close();
  }
});

test("the running mark is inline in the status slot, before the localized outcome", async () => {
  const { vite, render } = await setup("en");
  try {
    const running = render(taskCall({ status: "running", metrics: reported }));
    const state = running.match(/class="subagent-task-state">([\s\S]*?)<\/span><\/span>/)?.[1] ?? "";
    // Inline: the mark is the state slot's first child, immediately before the
    // outcome, and it keeps its slot rather than floating in the card's corner.
    assert.match(state, /^<span class="subagent-task-spinner" data-active="true"/);
    assert.match(state, /<span class="subagent-task-status" role="status" aria-live="polite">Running<\/span>/);
    assert.match(state, /class="subagent-sep"[^>]*> · </);
    assert.match(state, /class="subagent-task-duration">32s/);
    assert.ok(state.indexOf("subagent-task-spinner") < state.indexOf("subagent-task-status"));
    // The mark is decoration for a state the status text already states.
    assert.match(state, /class="subagent-task-spinner"[^>]*aria-hidden="true"/);
    // A settled card keeps the same slot, hidden, so the text never shifts.
    const settled = render(taskCall({ metrics: reported }));
    assert.match(
      settled,
      /class="subagent-task-spinner" data-active="false" aria-hidden="true"/,
    );
    assert.ok(
      settled.indexOf("subagent-task-spinner") <
        settled.indexOf('subagent-task-status"'),
    );
  } finally {
    await vite.close();
  }
});

test("a card reads its figures in the reader's language, like the dock row for the same child", async () => {
  const { vite, render } = await setup("zh-CN");
  try {
    const html = render(taskCall({ status: "running", metrics: reported }));
    assert.match(
      html,
      /class="subagent-task-metrics"[^>]*>轮次 1 · 工具调用 2 · 上下文 1\.2万 · 累计消耗 3400</,
    );
    assert.equal(
      plain(html.match(/class="subagent-task-state">([\s\S]*?)<\/span><\/span>/)?.[1] ?? ""),
      "运行中 · 32s",
    );
    // Nothing on the card speaks the runtime's English vocabulary.
    assert.doesNotMatch(html, /\bctx\b/);
    assert.doesNotMatch(html, /\bsteps?\b/);
    assert.doesNotMatch(html, /Context|Spent|turns/);
    // The takeaway label is localized too.
    assert.match(html, /aria-label="子智能体 token 用量"/);
  } finally {
    await vite.close();
  }
});

/**
 * The four figures are never conditional: a card whose child reported nothing
 * keeps all four labelled slots, and a child that reported zeros states those
 * zeros. The line is the same shape on every card, so a transcript of cards
 * does not change height from one child to the next.
 */
test("a card keeps all four figures visible whether the run reported zeros or nothing", async () => {
  const { vite, render } = await setup("en");
  try {
    const lineOf = (html) =>
      html.match(/class="subagent-task-metrics"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? null;
    const tooltipOf = (html) =>
      html.match(/class="subagent-task-metrics" title="([^"]*)"/)?.[1] ?? null;
    // A run that reported nothing at all still holds the four slots.
    const silent = render(taskCall({ metrics: {} }));
    assert.equal(lineOf(silent), "Turns — · Tool calls — · Context — · Spent —");
    assert.equal(tooltipOf(silent), "Turns — · Tool calls — · Context — · Spent —");
    // Zeros the runtime did report are the figures it reported.
    assert.equal(
      lineOf(
        render(
          taskCall({
            metrics: {
              turns: 0,
              toolCalls: 0,
              contextTokens: 0,
              usage: { totalTokens: 0 },
            },
          }),
        ),
      ),
      "Turns 0 · Tool calls 0 · Context 0 · Spent 0",
    );
    // A mixed report dashes only what was never sent, at every layer: the
    // parser keeps an unreported counter absent rather than turning it into 0.
    assert.equal(
      lineOf(render(taskCall({ metrics: { turns: 2, contextTokens: 900 } }))),
      "Turns 2 · Tool calls — · Context 900 · Spent —",
    );
    // The line is never dropped, so the card's height never depends on the
    // child's report.
    for (const html of [silent, render(taskCall({ metrics: reported }))]) {
      assert.equal((html.match(/class="subagent-task-metrics"/g) ?? []).length, 1);
    }
  } finally {
    await vite.close();
  }
});

/**
 * The canonical reader is the one place the four figures are derived from a
 * Task payload, so "never reported" must stay distinguishable from "reported
 * zero" here — not only in the presenter. A context/spend-only payload carries
 * no counters; a chain sums only the counters its segments actually reported;
 * a reported zero is a report and survives the fold.
 */
test("the canonical reader keeps an unreported counter absent and a reported zero at zero", async () => {
  const { vite } = await setup("en");
  try {
    const metrics = await vite.ssrLoadModule("/src/lib/subagent-metrics.ts");
    const ui = await vite.ssrLoadModule("/src/lib/subagent-ui-metrics.ts");
    const t = await translator("en");
    const line = (value) => ui.subagentMetricsLine(value, t, "en");

    // A metrics-only payload (occupancy and spend, no counters).
    const metricOnly = metrics.parseSubagentMetrics({
      contextTokens: 9_000,
      usage: { totalTokens: 1_200 },
    });
    assert.equal(metricOnly.turns, undefined);
    assert.equal(metricOnly.toolCalls, undefined);
    assert.equal(metricOnly.contextTokens, 9_000);
    assert.equal(
      line(metricOnly),
      "Turns — · Tool calls — · Context 9K · Spent 1.2K",
    );

    // A payload that reported real zeros keeps them.
    const zeros = metrics.parseSubagentMetrics({ turns: 0, toolCalls: 0 });
    assert.equal(zeros.turns, 0);
    assert.equal(zeros.toolCalls, 0);
    assert.equal(line(zeros), "Turns 0 · Tool calls 0 · Context — · Spent —");

    // Values that are not non-negative counts are not reports: no poison, and
    // a fractional count is the floor the parser already applied.
    const invalid = metrics.parseSubagentMetrics({
      turns: "3",
      toolCalls: 1.9,
      contextTokens: -5,
    });
    assert.equal(invalid.turns, undefined);
    assert.equal(invalid.toolCalls, 1);
    assert.equal(invalid.contextTokens, undefined);
    assert.doesNotMatch(line(invalid), /NaN|Infinity|-5/);

    // A chain sums only what its segments reported. The first segment reported
    // no counters; the second reported a real zero for tool calls.
    const folded = metrics.aggregateSubagentChainMetrics([
      { contextTokens: 4_000 },
      { toolCalls: 0, turns: 2 },
    ]);
    assert.equal(folded.toolCalls, 0);
    assert.equal(folded.turns, 2);
    assert.equal(
      line(folded),
      "Turns 2 · Tool calls 0 · Context — · Spent —",
    );

    // No segment reported a counter: the chain reports none, never a zero.
    const silentCounters = metrics.aggregateSubagentChainMetrics([
      { contextTokens: 4_000, usage: { totalTokens: 500 } },
      { usage: { totalTokens: 700 } },
    ]);
    assert.equal(silentCounters.turns, undefined);
    assert.equal(silentCounters.toolCalls, undefined);
    // Spend still folds and its total is untouched by the missing counters.
    assert.equal(silentCounters.usage.totalTokens, 1_200);
    assert.equal(
      line(silentCounters),
      "Turns — · Tool calls — · Context — · Spent 1.2K",
    );
  } finally {
    await vite.close();
  }
});

/**
 * The same reading through the transcript's own fold: a Task row that reported
 * only context and spend states no counters on its card, a neighbouring row
 * that reported zeros still states zeros.
 */
test("a card reads a context-and-spend-only run as no counters, end to end", async () => {
  const { vite, render } = await setup("en");
  try {
    const lineOf = (html) =>
      html.match(/class="subagent-task-metrics"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? null;
    const metricOnly = taskCall({
      metrics: { contextTokens: 9_000, usage: { totalTokens: 1_200 } },
    });
    assert.equal(
      lineOf(render(metricOnly)),
      "Turns — · Tool calls — · Context 9K · Spent 1.2K",
    );
    const zeros = taskCall({
      metrics: {
        turns: 0,
        toolCalls: 0,
        contextTokens: 0,
        usage: { totalTokens: 0 },
      },
    });
    assert.equal(
      lineOf(render(zeros)),
      "Turns 0 · Tool calls 0 · Context 0 · Spent 0",
    );
  } finally {
    await vite.close();
  }
});

/**
 * A resume chain's numbers are the child session's, not one invocation's: the
 * card states exactly what the child's tab header states, so a `Task(resume …)`
 * continuation never restarts the figures its earlier segment already reported.
 */
test("a resumed card states the child session's totals, exactly as its tab header does", async () => {
  const { vite, render } = await setup("en");
  try {
    const metrics = await vite.ssrLoadModule("/src/lib/subagent-metrics.ts");
    const ui = await vite.ssrLoadModule("/src/lib/subagent-ui-metrics.ts");
    const first = taskCall({
      id: "t1",
      toolCallId: "call-1",
      delegationId: "d1",
      metrics: {
        turns: 1,
        toolCalls: 2,
        contextTokens: 12_000,
        usage: {
          inputTokens: 2_000,
          outputTokens: 1_400,
          totalTokens: 3_400,
          operationId: "op-1",
          aggregation: "operation",
        },
      },
    });
    const resumed = taskCall({
      id: "t2",
      toolCallId: "call-2",
      delegationId: "d2",
      resume: "d1",
      description: "Continue the reconciliation",
      status: "running",
      metrics: {
        turns: 3,
        toolCalls: 4,
        contextTokens: 22_000,
        usage: {
          inputTokens: 2_000,
          outputTokens: 1_000,
          totalTokens: 3_000,
          operationId: "op-2",
          aggregation: "operation",
        },
      },
    });
    const other = taskCall({
      id: "t3",
      toolCallId: "call-3",
      delegationId: "d3",
      description: "Unrelated work",
      metrics: { turns: 1, toolCalls: 5, contextTokens: 8_000, usage: { totalTokens: 900 } },
    });
    const conversation = [first, resumed, other];
    // One canonical fold, the same one the tab header renders.
    const canonical = metrics.aggregateChainMetricsFromMessages(conversation, "d1");
    assert.deepEqual(
      {
        turns: canonical.turns,
        toolCalls: canonical.toolCalls,
        contextTokens: canonical.contextTokens,
        spent: canonical.usage.totalTokens,
      },
      { turns: 4, toolCalls: 6, contextTokens: 22_000, spent: 6_400 },
    );
    const t = await translator("en");
    const expected = ui.subagentMetricsLine(canonical, t, "en");
    assert.equal(expected, "Turns 4 · Tool calls 6 · Context 22K · Spent 6.4K");
    // The header derives its own values from that same object with the same
    // formatters, so the card line is the header line.
    assert.equal(ui.formatCompactTokens(canonical.contextTokens, "en"), "22K");
    assert.equal(ui.formatCompactTokens(canonical.usage.totalTokens, "en"), "6.4K");
    assert.deepEqual(
      [ui.formatCount(canonical.turns, "en"), ui.formatCount(canonical.toolCalls, "en")],
      ["4", "6"],
    );
    const lineOf = (html) =>
      html.match(/class="subagent-task-metrics"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "";
    // Both segments of the chain state the child session's totals.
    assert.equal(lineOf(render(first, conversation)), expected);
    assert.equal(lineOf(render(resumed, conversation)), expected);
    // The earlier segment never falls back to its own per-run counters.
    assert.doesNotMatch(lineOf(render(first, conversation)), /Turns 1 · Tool calls 2/);
    // Occupancy is the latest segment's gauge, never a sum of the chain's
    // windows, and the totals are not the latest segment's spend either.
    assert.doesNotMatch(expected, /34K/);
    // An unrelated chain is untouched by its neighbours.
    assert.equal(
      lineOf(render(other, conversation)),
      ui.subagentMetricsLine(
        metrics.aggregateChainMetricsFromMessages(conversation, "d3"),
        t,
        "en",
      ),
    );
  } finally {
    await vite.close();
  }
});

/**
 * The transcript folds each chain once and hands the result to every card of
 * it, so a live update in a later segment moves the earlier card with it
 * instead of leaving a stale per-run figure behind.
 */
test("one fold serves every card of a chain, and a resumed run updates all of them", async () => {
  const { vite } = await setup("en");
  try {
    const provider = await vite.ssrLoadModule("/src/lib/subagent-metrics-provider.tsx");
    const chain = (resumeMetrics) => [
      taskCall({
        id: "t1",
        toolCallId: "call-1",
        delegationId: "d1",
        metrics: { turns: 1, toolCalls: 2, contextTokens: 12_000, usage: { totalTokens: 3_400 } },
      }),
      taskCall({
        id: "t2",
        toolCallId: "call-2",
        delegationId: "d2",
        resume: "d1",
        metrics: resumeMetrics,
      }),
      taskCall({
        id: "t3",
        toolCallId: "call-3",
        delegationId: "d3",
        metrics: { turns: 1, toolCalls: 5, contextTokens: 8_000, usage: { totalTokens: 900 } },
      }),
    ];
    const before = provider.subagentChainMetricsByIdentity(
      chain({ turns: 3, toolCalls: 4, contextTokens: 22_000, usage: { totalTokens: 3_000 } }),
    );
    // Every card of the chain reads one folded object, not a fold of its own.
    assert.equal(before.get("call-1"), before.get("call-2"));
    assert.equal(before.get("call-1").turns, 4);
    assert.equal(before.get("call-1").toolCalls, 6);
    // A neighbouring chain keeps its own figures.
    assert.equal(before.get("call-3").turns, 1);
    assert.equal(before.get("call-3").toolCalls, 5);
    // The running segment reports more: both cards of the chain move together.
    const after = provider.subagentChainMetricsByIdentity(
      chain({ turns: 4, toolCalls: 6, contextTokens: 31_000, usage: { totalTokens: 5_000 } }),
    );
    assert.equal(after.get("call-1"), after.get("call-2"));
    assert.equal(after.get("call-1").turns, 5);
    assert.equal(after.get("call-1").toolCalls, 8);
    assert.equal(after.get("call-1").contextTokens, 31_000);
    assert.equal(after.get("call-1").usage.totalTokens, 8_400);
    assert.equal(after.get("call-3").turns, 1);
    // A call that has reported nothing carries no entry: the card states
    // nothing rather than an invented zero row.
    const silent = provider.subagentChainMetricsByIdentity([
      taskCall({ id: "t9", toolCallId: "call-9", delegationId: "d9" }),
    ]);
    assert.equal(silent.get("call-9"), undefined);
  } finally {
    await vite.close();
  }
});
