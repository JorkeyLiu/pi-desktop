/**
 * The composer's running-subagent dock: its rendered frame, its row content and
 * its row actions.
 *
 * The dock is rendered from its real module against the real store, so the
 * collapsed summary, the row content, the localized figures and the action
 * gating are checked as the renderer produces them. Whether the composer still
 * mounts the todo dock, and how the controls behave when clicked, are proved in
 * a browser by `scripts/e2e-subagent-dock.mjs`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { readComposerSource } from "./helpers/composer-source.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const AT = "2026-10-18T00:00:00.000Z";

function task(id, delegationId, description, agent, metrics) {
  return {
    id,
    role: "tool",
    content: "",
    createdAt: AT,
    toolName: "Task",
    toolCallId: `call-${id}`,
    toolStatus: "success",
    toolArgs: { agent, description, task: "a long brief that is never a title" },
    toolResult: {
      details: {
        delegationId,
        agent,
        status: "running",
        startedAt: Date.now() - 30_000,
        ...(metrics ?? {}),
      },
    },
  };
}

const runningMessages = [
  { id: "u1", role: "user", content: "go", createdAt: AT },
  { id: "a1", role: "assistant", content: "Delegating.", createdAt: AT },
  task("t1", "d1", "Review auth flow", "explorer", {
    turns: 3,
    toolCalls: 5,
    contextTokens: 41_200,
    usage: { totalTokens: 8_400 },
  }),
  { id: "a2", role: "assistant", content: "Delegating another.", createdAt: AT },
  // A child that has reported no counters yet.
  task("t2", "d2", "Audit dependencies", "auditor"),
];

/** Two actions sit in one row: neither may be a button inside a button. */
function assertNoNestedButtons(html) {
  let depth = 0;
  for (const token of html.match(/<\/?button\b[^>]*>/gi) ?? []) {
    if (token.startsWith("</")) {
      depth -= 1;
      assert.ok(depth >= 0, "a </button> closes a button that was never opened");
    } else {
      depth += 1;
      assert.ok(depth <= 1, "the dock nests one <button> inside another");
    }
  }
  assert.equal(depth, 0, "the dock's buttons are unbalanced");
}

function buttons(html) {
  return html.match(/<button\b[^>]*>/gi) ?? [];
}

/** The rendered text of a fragment, the way a reader (and a screen reader) sees it. */
function plain(html) {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
async function setup(language = "en") {
  const server = await createServer({
    root,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { SubagentDock } = await server.ssrLoadModule("/src/components/SubagentDock.tsx");
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    resources: { [language]: { translation: catalogs[language] } },
  });
  const render = () =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(SubagentDock, { sessionId: "s1" }),
      ),
    );
  return { server, useAppStore, render };
}

function seed(useAppStore, overrides) {
  Object.assign(useAppStore.getInitialState(), {
    activeSessionId: "s1",
    sessions: [{ id: "s1", source: "local", title: "fixture" }],
    messages: runningMessages,
    isRunning: true,
    settings: { enterToSend: true },
    ...overrides,
  });
}

test("the dock lists every running child with the original title, in one collapsed summary", async () => {
  const { server, useAppStore, render } = await setup();
  try {
    // SSR reads the store's initial snapshot, so the fixture mutates it in
    // place the way the other component tests seed state.
    seed(useAppStore, {});
    const html = render();
    assert.match(html, /class="subagent-dock"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /2 subagents running · Review auth flow/);
    assert.match(html, /class="subagent-dock-content" aria-hidden="true"/);
    assert.match(html, />Review auth flow</);
    assert.match(html, />Audit dependencies</);
    assert.match(html, />explorer</);
    assert.match(html, />auditor</);
    assert.match(plain(html), /Running · \d+s/);
    // The row's own stop control is the shared one, named per child.
    assert.match(html, /aria-label="Stop explorer"/);
    // A long brief is never promoted to a title.
    assert.doesNotMatch(html, /a long brief/);
    assertNoNestedButtons(html);
  } finally {
    await server.close();
  }
});
test("no running child renders nothing at all", async () => {
  const { server, useAppStore, render } = await setup();
  try {
    seed(useAppStore, {
      messages: [
        { id: "u1", role: "user", content: "go", createdAt: AT },
        { id: "a1", role: "assistant", content: "Done.", createdAt: AT },
      ],
      isRunning: false,
    });
    assert.equal(render(), "");
  } finally {
    await server.close();
  }
});


test("the header is one disclosure and offers no dock-wide stop", async () => {
  const { server, useAppStore, render } = await setup();
  try {
    seed(useAppStore, {});
    const html = render();
    const header = html.match(/<div class="subagent-dock-header">[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.ok(header);
    // The disclosure is the header's only control: stopping is per child, in
    // the row of the child it stops.
    assert.equal(buttons(header).length, 1, "the header holds the disclosure only");
    assert.match(header, /class="[^"]*subagent-dock-toggle[^"]*"[^>]*aria-expanded="false"/);
    assert.doesNotMatch(html, /Stop all subagents/);
    assert.doesNotMatch(header, /stop-btn/);
    // The disclosure never wraps the row's stop controls either.
    const toggleMarkup =
      html.match(/<button[^>]*subagent-dock-toggle[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    assert.notEqual(toggleMarkup, "");
    assert.equal(buttons(toggleMarkup).length, 1);
    // Only the two rows carry stop actions, one each.
    assert.equal((html.match(/class="stop-btn"/g) ?? []).length, 2);
  } finally {
    await server.close();
  }
});

test("the whole row body is the open control and the stop control is its sibling", async () => {
  const { server, useAppStore, render } = await setup();
  try {
    seed(useAppStore, {});
    const html = render();
    const firstRow = html.match(/<div class="subagent-dock-row"[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.notEqual(firstRow, "");
    const rowButtons = buttons(firstRow);
    assert.equal(rowButtons.length, 2, "one row action plus one stop action");
    assert.match(rowButtons[0], /class="[^"]*subagent-dock-row-main[^"]*"/);
    assert.equal(rowButtons[0].includes("disabled"), false);
    assert.match(firstRow, /role="listitem"/);
    // The title, the role, the figures and the live state all live inside that
    // one button, so a click anywhere on the row opens the chain.
    const openButton = firstRow.match(/<button[^>]*subagent-dock-row-main[\s\S]*?<\/button>/)?.[0] ?? "";
    assert.match(plain(openButton), /^Review auth flow\s*Running · \d+s\s*explorer · Turns 3 · Tool calls 5 · Context 41\.2K · Spent 8\.4K$/);
    // No separate open affordance is left over from the row's older shape.
    assert.doesNotMatch(html, /subagent-dock-row-open/);
  } finally {
    await server.close();
  }
});

test("a row lays the title out first and the role under it, on its own line", async () => {
  const { server, useAppStore, render } = await setup();
  try {
    seed(useAppStore, {});
    const html = render();
    const firstRow = html.match(/<div class="subagent-dock-row"[\s\S]*?<\/div>/)?.[0] ?? "";
    // The title row carries the title and the state, never the role.
    const titleRow =
      firstRow.match(/class="subagent-dock-row-title-row"[\s\S]*?<\/span><\/span>/)?.[0] ?? "";
    assert.match(titleRow, /class="subagent-dock-row-title">Review auth flow</);
    assert.match(titleRow, /class="subagent-dock-row-state"/);
    assert.doesNotMatch(titleRow, /subagent-dock-row-role/);
    // The role opens the second line, then the child's own figures.
    const infoLine =
      firstRow.match(/class="subagent-dock-row-info"[\s\S]*?<\/span><\/span>/)?.[0] ?? "";
    assert.match(infoLine, /class="subagent-dock-row-role">explorer</);
    assert.match(infoLine, /class="subagent-sep"[^>]*> · </);
    assert.match(infoLine, /class="subagent-dock-row-metrics"/);
    assert.ok(
      infoLine.indexOf("subagent-dock-row-role") <
        infoLine.indexOf("subagent-dock-row-metrics"),
    );
    // The state reads "Running · <duration>": a dot before the duration, never a
    // run-together fragment, and no status without it.
    const state = firstRow.match(/class="subagent-dock-row-state">([\s\S]*?)<\/span><\/span>/)?.[1] ?? "";
    assert.match(state, /^<span class="subagent-dock-row-status">Running<\/span>/);
    assert.match(state, /class="subagent-sep"[^>]*> · </);
    assert.match(state, /class="subagent-dock-row-duration">\d+/);
  } finally {
    await server.close();
  }
});

test("the row reads the child's own figures in the reader's language", async () => {
  const english = await setup("en");
  try {
    seed(english.useAppStore, {});
    const html = english.render();
    const metrics =
      html.match(/class="subagent-dock-row-metrics"[^>]*>([^<]*)</)?.[1] ?? "";
    assert.equal(metrics, "Turns 3 · Tool calls 5 · Context 41.2K · Spent 8.4K");
    // No runtime vocabulary leaks into the surface, and no step count at all.
    assert.doesNotMatch(html, /\bctx\b/);
    assert.doesNotMatch(html, /\bsteps?\b/);
  } finally {
    await english.server.close();
  }
  const chinese = await setup("zh-CN");
  try {
    seed(chinese.useAppStore, {});
    const html = chinese.render();
    const metrics =
      html.match(/class="subagent-dock-row-metrics"[^>]*>([^<]*)</)?.[1] ?? "";
    assert.equal(metrics, "轮次 3 · 工具调用 5 · 上下文 4.1万 · 累计消耗 8400");
    assert.match(plain(html), /运行中 · \d+s/);
    assert.doesNotMatch(plain(html), /Running|turns|Context|Spent/);
  } finally {
    await chinese.server.close();
  }
});

test("a child that reported no counters shows no numbers, and never the parent's", async () => {
  const { server, useAppStore, render } = await setup();
  try {
    seed(useAppStore, {});
    const html = render();
    const rows = html.match(/<div class="subagent-dock-row"[\s\S]*?<\/div>/g) ?? [];
    assert.equal(rows.length, 2);
    assert.match(rows[0], /subagent-dock-row-metrics/);
    assert.doesNotMatch(rows[1], /subagent-dock-row-metrics/);
    // One reported row, so one metrics line — nothing is invented per row.
    assert.equal((html.match(/subagent-dock-row-metrics/g) ?? []).length, 1);
  } finally {
    await server.close();
  }
});

test("a child that reported turns without an occupancy keeps the labelled dash", async () => {
  const { server, useAppStore, render } = await setup();
  try {
    seed(useAppStore, {
      messages: [
        { id: "u1", role: "user", content: "go", createdAt: AT },
        { id: "a1", role: "assistant", content: "Delegating.", createdAt: AT },
        task("t1", "d1", "Review auth flow", "explorer", { turns: 2 }),
      ],
    });
    const html = render();
    assert.match(html, />Turns 2 · Context —</);
    assert.match(html, /title="[^"]*Turns 2 · Context —[^"]*"/);
  } finally {
    await server.close();
  }
});

test("a child whose handle has not landed lists as creating with its actions disabled", async () => {
  const { server, useAppStore, render } = await setup();
  try {
    seed(useAppStore, {
      messages: [
        { id: "u1", role: "user", content: "go", createdAt: AT },
        { id: "a1", role: "assistant", content: "Delegating.", createdAt: AT },
        {
          id: "t1",
          role: "tool",
          content: "",
          createdAt: AT,
          toolName: "Task",
          toolCallId: "call-1",
          toolStatus: "running",
          toolArgs: { agent: "explorer" },
        },
      ],
    });
    const html = render();
    assert.match(html, /Starting subagent…/);
    assert.match(html, />explorer</);
    // No delegation id yet: neither action can target it.
    assert.doesNotMatch(html, /class="stop-btn"/);
    assert.match(
      html,
      /disabled=""[^>]*class="[^"]*subagent-dock-row-main[^"]*"|class="[^"]*subagent-dock-row-main[^"]*"[^>]*disabled=""/,
    );
    assert.doesNotMatch(html, /subagent-dock-row-metrics/);
    assertNoNestedButtons(html);
  } finally {
    await server.close();
  }
});

test("the composer's dock slot mounts the subagent dock, not the todo dock", async () => {
  const source = await readComposerSource();
  const composer = await readFile(
    fileURLToPath(new URL("../src/components/Composer.tsx", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(composer, /TodoDock/);
  assert.match(composer, /import \{ SubagentDock \} from "\.\/SubagentDock"/);
  assert.match(composer, /<SubagentDock sessionId=\{activeSessionId\} \/>/);
  // The dock module itself never falls back to the todo store.
  assert.doesNotMatch(source, /sessionTodos/);
});

test("the dock keeps the todo dock's disclosure contract in the stylesheet", async () => {
  const css = await readFile(
    fileURLToPath(new URL("../src/styles/composer.css", import.meta.url)),
    "utf8",
  );
  assert.match(css, /\.subagent-dock \{[\s\S]*?margin-bottom: 8px;[\s\S]*?var\(--radius-md\)/);
  assert.match(css, /\.subagent-dock-toggle:active:not\(:disabled\)\s*\{[\s\S]*?transform:\s*none;/);
  assert.match(css, /\.subagent-dock-content\s*\{[\s\S]*?grid-template-rows:\s*0fr;[\s\S]*?opacity:\s*0;/);
  assert.match(css, /\.subagent-dock\.is-expanded \.subagent-dock-content\s*\{[\s\S]*?grid-template-rows:\s*1fr;/);
  assert.match(
    css,
    /\.subagent-dock\.is-expanded \.subagent-dock-list\s*\{[\s\S]*?max-height:[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/,
  );
  // The row action fills the row and the stop control keeps its own box. The
  // action is qualified by its own row, so the shared button rules that load
  // after this partial cannot repaint its geometry or its fill.
  assert.match(
    css,
    /\.subagent-dock-row > \.subagent-dock-row-main \{[^}]*flex: 1 1 auto;/,
  );
  assert.match(
    css,
    /\.subagent-dock-row > \.subagent-dock-row-main:focus-visible \{[^}]*outline:/,
  );
  // Two stacked lines: the title row, then the role and the figures.
  assert.match(css, /\.subagent-dock-row-copy\s*\{[\s\S]*?flex-direction:\s*column;/);
  assert.match(css, /\.subagent-dock-row-title-row\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(css, /\.subagent-dock-row-info\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(css, /\.subagent-dock-row-metrics\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/);
  // The header is its own surface: the expanded rows start below a deliberate
  // gap, so the header's hover fill never touches the first row's tile.
  assert.match(css, /\.subagent-dock-list \{[^}]*padding: 8px 10px 10px;/);
  // The header is the disclosure and nothing else: no reserved stop slot.
  assert.doesNotMatch(css, /\.subagent-dock-header\s*\{[\s\S]{0,120}?padding-right:\s*6px;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.subagent-dock-content/);
});

/** Every declaration body whose selector list contains `selector`, in source order. */
function blocksFor(css, selector) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  for (const [, selectorList, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectorList.split(",").map((entry) => entry.trim()).includes(selector)) {
      blocks.push(body.trim());
    }
  }
  return blocks;
}

test("the whole row paints the hover and keyboard focus surface, not the inner button", async () => {
  const css = await readFile(
    fileURLToPath(new URL("../src/styles/composer.css", import.meta.url)),
    "utf8",
  );
  const rowFill =
    /^background:\s*color-mix\(in oklab, var\(--ds-accent\) 18%, var\(--ds-tile-deep\)\);$/;
  // Hovering the row's open action lights the row itself, so one fill covers the
  // symbol on the left, the whole body and the gap the stop control sits in.
  const hoverSelector = ".subagent-dock-row:has(.subagent-dock-row-main:hover:not(:disabled))";
  const hover = blocksFor(css, hoverSelector);
  assert.equal(hover.length, 1, "the open action's hover fill is not moved out to the row");
  assert.match(hover[0], rowFill, `the hovered row paints the row fill (got "${hover[0]}")`);
  // Keyboard focus is the same surface, proved by :focus-visible rather than a
  // pointer-only state.
  const focusSelector = ".subagent-dock-row:has(.subagent-dock-row-main:focus-visible)";
  const focus = blocksFor(css, focusSelector);
  assert.equal(focus.length, 1, "keyboard focus on the open action does not light the row");
  assert.match(focus[0], rowFill, `the focused row paints the row fill (got "${focus[0]}")`);
  // The stop control is in neither selector: pointing at or focusing Stop never
  // lights the row, and the row never wakes on a bare pointer over it.
  assert.doesNotMatch(hover[0] + focus[0], /stop-btn/);
  assert.equal(
    blocksFor(css, ".subagent-dock-row:hover").length,
    0,
    "the row must not light up for any pointer over it, only for its open action",
  );
  // The button inside stays transparent in every state, so no second rectangle is
  // painted: the row's own fill is the only surface, including behind the stop.
  const main = blocksFor(css, ".subagent-dock-row > .subagent-dock-row-main");
  assert.equal(main.length, 1);
  assert.match(main[0], /background: transparent;/);
  assert.match(main[0], /padding: 3px 4px 3px 7px;/);
  assert.match(main[0], /font-size: inherit;/);
  assert.match(main[0], /gap: 7px;/);
  const states = [
    ".subagent-dock-row > .subagent-dock-row-main:hover:not(:disabled)",
    ".subagent-dock-row > .subagent-dock-row-main:active:not(:disabled)",
    ".subagent-dock-row > .subagent-dock-row-main:focus-visible",
  ].flatMap((selector) => blocksFor(css, selector));
  assert.ok(states.length > 0, "the open action declares no state rules");
  for (const body of states) {
    const declared = body.match(/background(?:-color)?:\s*([^;]+);/);
    assert.ok(
      declared === null || declared[1].trim() === "transparent",
      `the inner button paints its own fill: ${body}`,
    );
  }
  // The focused open action keeps a visible ring, and Stop keeps its own hover.
  assert.match(
    blocksFor(css, ".subagent-dock-row > .subagent-dock-row-main:focus-visible").join(
      "\n",
    ),
    /outline:\s*2px solid/,
  );
  const stopHover = blocksFor(css, ".stop-btn:hover");
  assert.equal(stopHover.length, 1, "the stop control keeps its own hover");
  assert.match(stopHover[0], /^background:/);
  // The row owns the fill transition, and reduced motion drops it.
  assert.match(blocksFor(css, ".subagent-dock-row")[0] ?? "", /transition: background-color/);
  assert.doesNotMatch(main[0], /transition:/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.subagent-dock-row,/,
  );
});

/** CSS specificity as `[ids, classes/attributes/pseudo-classes, elements]`. */
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+/g) ?? []).length;
  const attributes = (selector.match(/\[[^\]]*\]/g) ?? []).length;
  const pseudoClasses = (selector.match(/:(?!:)[a-z-]+/g) ?? []).length;
  const elements = (
    selector
      .replace(/::?[\w-]+(\([^)]*\))?/g, " ")
      .replace(/\.[\w-]+/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/#[\w-]+/g, " ")
      .match(/[a-z][\w-]*/gi) ?? []
  ).length;
  return [ids, classes + attributes + pseudoClasses, elements];
}

const outranks = (winner, loser) => {
  const [winnerIds, winnerClasses, winnerElements] = specificity(winner);
  const [loserIds, loserClasses, loserElements] = specificity(loser);
  if (winnerIds !== loserIds) return winnerIds > loserIds;
  if (winnerClasses !== loserClasses) return winnerClasses > loserClasses;
  return winnerElements > loserElements;
};

test("the row action's own rules outrank the shared button that loads after them", async () => {
  const composerCss = await readFile(
    fileURLToPath(new URL("../src/styles/composer.css", import.meta.url)),
    "utf8",
  );
  const uiKitCss = await readFile(
    fileURLToPath(new URL("../src/styles/ui-kit.css", import.meta.url)),
    "utf8",
  );
  const globalsCss = await readFile(
    fileURLToPath(new URL("../src/styles/globals.css", import.meta.url)),
    "utf8",
  );
  // The hazard: the shared button lives in a partial imported after the dock's,
  // so equal specificity hands the shared declaration to the later file.
  const composerImport = globalsCss.indexOf('@import "./composer.css"');
  const uiKitImport = globalsCss.indexOf('@import "./ui-kit.css"');
  assert.ok(
    composerImport >= 0 && uiKitImport > composerImport,
    "composer styles no longer load before the shared ui-kit styles",
  );
  const action = ".subagent-dock-row > .subagent-dock-row-main";
  const states = {
    hover: `${action}:hover:not(:disabled)`,
    active: `${action}:active:not(:disabled)`,
    focus: `${action}:focus-visible`,
    disabled: `${action}:disabled`,
  };
  for (const selector of [action, ...Object.values(states)]) {
    assert.ok(
      blocksFor(composerCss, selector).length >= 1,
      `${selector} is not declared in composer.css`,
    );
  }
  assert.match(
    blocksFor(composerCss, states.active).join("\n"),
    /transform: none;/,
  );
  assert.match(
    blocksFor(composerCss, states.hover).join("\n"),
    /background: transparent;/,
  );
  assert.match(
    blocksFor(composerCss, states.active).join("\n"),
    /background: transparent;/,
  );
  assert.match(blocksFor(composerCss, action)[0], /padding: 3px 4px 3px 7px;/);
  // Every shared declaration that would repaint the action, and the dock rule
  // that has to win it on specificity instead of import order.
  const shared = [
    [".btn", ["padding", "font-size", "gap", "border-radius"]],
    [".btn-ghost", ["color"]],
    [".btn-ghost:hover:not(:disabled)", ["background", "color"]],
    [".btn:active:not(:disabled)", ["transform"]],
  ];
  for (const [sharedSelector, properties] of shared) {
    assert.equal(
      blocksFor(uiKitCss, sharedSelector).length,
      1,
      `ui-kit.css does not declare ${sharedSelector}`,
    );
    const winner = sharedSelector.includes(":hover")
      ? states.hover
      : sharedSelector.includes(":active")
        ? states.active
        : action;
    assert.ok(
      outranks(winner, sharedSelector),
      `${winner} must outrank ${sharedSelector} (${properties.join(", ")})`,
    );
  }
});
