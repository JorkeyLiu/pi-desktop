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
  status = "completed",
  agent = "manifestor",
  description = "Fix the cache stampede",
  metrics,
  toolDurationMs = 32_000,
} = {}) {
  return {
    id: "t1",
    role: "tool",
    content: "",
    createdAt: CREATED_AT,
    toolName: "Task",
    toolCallId: "call-1",
    toolStatus: status === "running" ? "running" : "success",
    toolDurationMs,
    toolArgs: { agent, description, task: "a long brief that is never a title" },
    toolResult: {
      details: {
        delegationId: "d1",
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

test("a figure the runtime never reported is absent or dashed, never invented", async () => {
  const english = await translator("en");
  // Nothing reported at all: no line, so the surface renders no figures.
  assert.deepEqual(subagentMetricsParts(undefined, english, "en"), []);
  assert.equal(subagentMetricsLine(null, english, "en"), "");
  assert.deepEqual(subagentMetricsParts({ turns: 0, toolCalls: 0 }, english, "en"), []);
  // Counters without an occupancy keep the panel's labelled dash.
  assert.equal(
    subagentMetricsLine({ turns: 3, toolCalls: 0 }, english, "en"),
    "Turns 3 · Context —",
  );
  // An occupancy without counters is a metrics-only report, not a zero row.
  assert.equal(
    subagentMetricsLine({ contextTokens: 41_200 }, english, "en"),
    "Context 41.2K",
  );
  // An estimate keeps its label and is never rewritten as a tilde.
  assert.equal(
    subagentMetricsLine(
      { contextTokens: 7_700, contextEstimated: true },
      english,
      "en",
    ),
    "Context 7.7K (est.)",
  );
  // Legacy child usage without a total states no spend.
  assert.equal(
    subagentMetricsLine({ usage: { inputTokens: 7_400 } }, english, "en"),
    "",
  );
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
  const render = (message) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          SubagentTitleProvider,
          { messages: [message] },
          createElement(
            TranscriptDisclosureProvider,
            null,
            createElement(ToolRow, { message, variant: "task" }),
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
