import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * The preparing phase of a tool call, rendered through the production
 * transcript components.
 *
 * While the model writes a call's arguments the call has an identity but no
 * arguments and no result. That row shows the call's own icon and name, says
 * nothing in words, and carries no spinner, caret, summary, or chips — the
 * existing executing row that replaces it keeps all of those. A delegation
 * start call keeps its own card and breathes on its avatar and title instead.
 */

const stylesSource = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);
const baseStylesSource = await readFile(
  new URL("../src/styles/base.css", import.meta.url),
  "utf8",
);
const flat = (source) => source.replace(/\s+/g, " ");

const message = (id, role, content = "", extra = {}) => ({
  id,
  role,
  content,
  createdAt: "2026-10-13T00:00:00.000Z",
  ...extra,
});

async function transcriptSsr(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(async () => {
    await server.close();
  });
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  const { TranscriptHistory } = await server.ssrLoadModule(
    "/src/features/chat/transcript/AssistantTurn.tsx",
  );
  const { buildTranscriptEntries } = await server.ssrLoadModule("/src/lib/assistant-turns.ts");
  const { SlotSessionProvider } = await server.ssrLoadModule(
    "/src/plugins/renderer-slots/use-slots.tsx",
  );
  return (messages) => {
    const { entries } = buildTranscriptEntries(messages);
    return renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          SlotSessionProvider,
          { sessionId: "fixture" },
          createElement(TranscriptHistory, { entries, isRunning: true }),
        ),
      ),
    );
  };
}

test("a preparing call shows its icon and name only", async (t) => {
  const render = await transcriptSsr(t);
  const html = render([
    message("user-1", "user", "List the files."),
    message("answer", "assistant", "", { status: "streaming" }),
    message("call-1", "tool", "", {
      toolCallId: "call-1",
      toolName: "Bash",
      toolStatus: "preparing",
      status: "streaming",
    }),
  ]);
  assert.match(html, /class="tool-row +(?:open +)?is-preparing status-preparing"/);
  assert.match(html, /data-tool-name="Bash"/);
  assert.match(html, /class="tool-row-name">Run<\/span>/, "the localized identity is the row's only text");
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /tool-spinner/, "no spinner while nothing runs");
  assert.doesNotMatch(html, /tool-row-state/, "no state text while nothing runs");
  assert.doesNotMatch(html, /tool-row-summary/, "no argument summary before the arguments exist");
  assert.doesNotMatch(html, /tool-row-caret/, "there is nothing to disclose yet");
  // The accessible name still states a localized running state.
  assert.match(html, /aria-label="Tool: Run, Working…"/);
});

test("completed arguments stop the pulse but keep the identity row waiting", async (t) => {
  const render = await transcriptSsr(t);
  const html = render([
    message("user-1", "user", "List the files."),
    message("answer", "assistant", "", { status: "streaming" }),
    message("call-1", "tool", "", {
      toolCallId: "call-1",
      toolName: "Bash",
      toolStatus: "preparing",
      toolArgsComplete: true,
      status: "streaming",
    }),
  ]);
  // The model is done writing this call, but execution has not started: the
  // row keeps its identity and its position, and no longer breathes.
  assert.match(html, /class="tool-row +(?:open +)?status-preparing"/);
  assert.doesNotMatch(html, /is-preparing/);
  assert.match(html, /data-tool-name="Bash"/);
  assert.match(html, /class="tool-row-name">Run<\/span>/);
  assert.match(html, /aria-busy="true"/);
  // Still no execution claim: no spinner, no state text, no argument summary,
  // and nothing to disclose.
  assert.doesNotMatch(html, /tool-spinner/);
  assert.doesNotMatch(html, /tool-row-state/);
  assert.doesNotMatch(html, /tool-row-summary/);
  assert.doesNotMatch(html, /tool-row-caret/);
});

test("the executing row that replaces it keeps the existing UI", async (t) => {
  const render = await transcriptSsr(t);
  const html = render([
    message("user-1", "user", "List the files."),
    message("answer", "assistant", "", { status: "streaming" }),
    message("call-1", "tool", "", {
      toolCallId: "call-1",
      toolName: "Read",
      toolStatus: "running",
      status: "streaming",
      toolArgs: { file_path: "/tmp/a.ts" },
    }),
  ]);
  assert.doesNotMatch(html, /is-preparing/);
  assert.doesNotMatch(html, /aria-busy/);
  assert.match(html, /class="tool-row-summary/);
  assert.match(html, /class="tool-spinner" aria-label="Working…"/);
});

test("a preparing delegation card is one integrated skeleton, never placeholder text", async (t) => {
  const render = await transcriptSsr(t);
  // Two frames of the same call: the first before any `description` is
  // parseable, the second after Pi reports one. Both are still being written,
  // so both must wait as the same skeleton — the unnamed fallback and a
  // half-written title are equally not the child's name yet.
  const card = (toolArgs) => [
    message("user-1", "user", "Please look into the parser."),
    message("answer", "assistant", "", { status: "streaming" }),
    message("task-1", "tool", "", {
      toolCallId: "task-1",
      toolName: "Task",
      toolStatus: "preparing",
      status: "streaming",
      ...(toolArgs ? { toolArgs } : {}),
    }),
  ];
  for (const toolArgs of [undefined, { description: "Audit the parser" }]) {
    const html = render(card(toolArgs));
    // The card's own element, including the tag that opens it. Nothing in it
    // may state text while the arguments are still being written.
    const start = html.indexOf('class="tool-row subagent-task');
    const markup = html.slice(html.lastIndexOf("<div", start));
    assert.match(
      html,
      /class="tool-row subagent-task is-running is-creating is-preparing"/,
    );
    assert.match(html, /data-outcome="running"/);
    // The card keeps its own geometry: one card node, an avatar-sized
    // placeholder, and exactly the three line slots the real card fills — the
    // title's line, the role's, and the figures' — so the waiting card is as
    // tall as the card that replaces it.
    assert.match(html, /class="subagent-task-card"/);
    assert.match(
      html,
      /class="subagent-task-skeleton-avatar" aria-hidden="true"/,
    );
    assert.equal(
      [...html.matchAll(/class="subagent-task-skeleton-line /g)].length,
      3,
      "the card did not reserve a title line, a role line and a figures line",
    );
    for (const slot of ["is-title", "is-role", "is-metrics"]) {
      assert.match(
        html,
        new RegExp(
          `class="subagent-task-skeleton-line ${slot}" aria-hidden="true">\\s*<span class="subagent-task-skeleton-bar">`,
        ),
        `the card did not fill the ${slot} line slot with a bar`,
      );
    }
    assert.equal(
      [...html.matchAll(/class="subagent-task-skeleton-bar"/g)].length,
      3,
      "the card did not paint one bar per line slot",
    );
    // No temporary text of any kind: no fallback label, no half-written
    // description, no hover title, and none of the real copy slots.
    assert.doesNotMatch(markup, /Unnamed subagent/);
    assert.doesNotMatch(markup, /Audit the parser/);
    assert.doesNotMatch(markup, /class="subagent-task-title/);
    assert.doesNotMatch(markup, /subagent-task-role/);
    // The wait is stated accessibly on the card itself, and its bars stay out
    // of the accessibility tree.
    assert.match(markup, /aria-busy="true"/);
    assert.match(markup, /aria-label="Preparing subagent…"/);
    assert.doesNotMatch(markup, / title="[^"]/, "the pending card offers no hover copy");
    assert.equal(
      markup.replace(/<[^>]*>/g, "").trim(),
      "",
      "the pending card renders no text content at all",
    );
    // No invented child state, clock, metrics or stop handle before the call
    // has a delegation at all.
    assert.doesNotMatch(html, /subagent-task-state/);
    assert.doesNotMatch(html, /subagent-task-spinner/);
    assert.doesNotMatch(html, /class="subagent-task-status"/);
    assert.doesNotMatch(html, /subagent-task-duration/);
    assert.doesNotMatch(html, /subagent-task-metrics/);
    assert.doesNotMatch(html, /Starting subagent/);
    assert.doesNotMatch(html, /subagent-stop-button/);
  }
});

test("the skeleton gives way to the real card across the preparation user path", async (t) => {
  const render = await transcriptSsr(t);
  const frame = (extra) => [
    message("user-1", "user", "Please look into the parser."),
    message("answer", "assistant", "", { status: "streaming" }),
    message("task-1", "tool", "", {
      toolCallId: "task-1",
      toolName: "Task",
      status: "streaming",
      toolArgs: { agent: "explorer", description: "Audit the parser" },
      ...extra,
    }),
  ];
  // 1. Named, arguments still streaming, no description parsed yet.
  const unnamed = render(frame({ toolStatus: "preparing" }));
  assert.match(unnamed, /is-preparing/);
  assert.match(unnamed, /subagent-task-skeleton-bar/);
  assert.doesNotMatch(unnamed, /Unnamed subagent/);

  // 2. The description arrives while the arguments are still streaming: still
  //    the same skeleton, so no half-written title flashes in place.
  const described = render(
    frame({
      toolStatus: "preparing",
      toolArgs: { agent: "explorer", description: "Audit the" },
    }),
  );
  assert.match(described, /is-preparing/);
  assert.match(described, /subagent-task-skeleton-bar/);
  assert.doesNotMatch(described, /Audit the/);

  // 3. Argument generation ends: the existing ready card, in place, with its
  //    real title and role and no skeleton left behind.
  const ready = render(frame({ toolStatus: "preparing", toolArgsComplete: true }));
  assert.doesNotMatch(ready, /is-preparing/);
  assert.doesNotMatch(ready, /subagent-task-skeleton/);
  assert.match(
    ready,
    /class="subagent-task-title" title="Audit the parser">Audit the parser</,
  );
  assert.match(ready, /subagent-task-role" title="Subagent">explorer</);
  assert.doesNotMatch(ready, /subagent-task-state/);

  // 4. Execution takes the same card over: the existing creating presentation,
  //    its own state line and metrics, no skeleton, no second card.
  const running = render(frame({ toolStatus: "running" }));
  assert.doesNotMatch(running, /subagent-task-skeleton/);
  assert.match(running, /subagent-task is-running is-creating"/);
  assert.match(running, /class="subagent-task-status" role="status"/);
  assert.match(running, /class="subagent-task-metrics"/);
  assert.equal(
    [...running.matchAll(/data-message-id="task-1"/g)].length,
    1,
    "execution rendered a second card for the same call",
  );
});

test("a prepared delegation waits static, still stating no child state", async (t) => {
  const render = await transcriptSsr(t);
  const html = render([
    message("user-1", "user", "Audit the parser."),
    message("answer", "assistant", "", { status: "streaming" }),
    message("task-1", "tool", "", {
      toolCallId: "task-1",
      toolName: "Task",
      toolStatus: "preparing",
      toolArgsComplete: true,
      status: "streaming",
      toolArgs: { description: "Audit the parser" },
    }),
  ]);
  assert.match(html, /class="tool-row subagent-task is-running is-creating"/);
  assert.doesNotMatch(html, /is-preparing/);
  assert.match(html, /class="subagent-task-title" title="Audit the parser">Audit the parser</);
  assert.doesNotMatch(html, /subagent-task-state/);
  assert.doesNotMatch(html, /subagent-task-spinner/);
  assert.doesNotMatch(html, /subagent-task-metrics/);
  assert.doesNotMatch(html, /subagent-stop-button/);
});

test("executing and settled delegation cards are unchanged", async (t) => {
  const render = await transcriptSsr(t);
  const card = (extra) => [
    message("user-1", "user", "Audit the parser."),
    message("answer", "assistant", "", { status: "streaming" }),
    message("task-1", "tool", "", {
      toolCallId: "task-1",
      toolName: "Task",
      status: "streaming",
      toolArgs: { agent: "explorer", description: "Audit the parser" },
      ...extra,
    }),
  ];
  // The call has started but has not returned its handle: the creating state.
  const creating = render(
    card({ toolStatus: "running" }),
  );
  assert.doesNotMatch(creating, /is-preparing/);
  assert.match(creating, /subagent-task is-running is-creating"/);
  assert.match(creating, /class="subagent-task-spinner" data-active="false"/);
  // A settled call keeps its own outcome presentation.
  const settled = render(
    card({
      toolStatus: "success",
      status: "complete",
      toolResult: { details: { delegationId: "delegate-1", status: "completed" } },
    }),
  );
  assert.doesNotMatch(settled, /is-preparing/);
  assert.match(settled, /data-outcome="completed"/);
});

test("only tool rows breathe; the delegation card waits as a bounded shimmer", () => {
  const styles = flat(stylesSource);
  // An ordinary call still breathes on its icon and name, and only there.
  assert.match(
    styles,
    /\.tool-row\.is-preparing \.tool-row-icon, \.tool-row\.is-preparing \.tool-row-name \{\s*animation: tool-preparing-breath 1\.4s var\(--motion-ease-standard\) infinite;/,
  );
  assert.match(
    styles,
    /@keyframes tool-preparing-breath \{\s*0%, 100% \{\s*opacity: 1; \}\s*50% \{\s*opacity: 0\.45; \}\s*\}/,
  );
  // The delegation card no longer breathes: its own copy is the argument being
  // written, so it waits as a skeleton with one highlight sweep.
  assert.doesNotMatch(
    styles,
    /\.subagent-task\.is-preparing \.subagent-task-(?:avatar|title)\s*\{/,
  );
  assert.match(
    styles,
    /\.subagent-task-skeleton-bar \{[^}]*animation: subagent-task-skeleton-shimmer 1s linear infinite;/,
  );
  // The skeleton loop stays inside the design system's 1s skeleton ceiling, and
  // its highlight is on the bar for the whole cycle: 90% → 10% on a 300%-wide
  // image moves the band by 1.6 bar widths, entering and leaving as it goes.
  assert.match(
    styles,
    /@keyframes subagent-task-skeleton-shimmer \{\s*from \{\s*background-position: 90% 0; \}\s*to \{\s*background-position: 10% 0; \}\s*\}/,
  );
  assert.match(
    styles,
    /\.subagent-task-skeleton-bar \{[^}]*background-size: 300% 100%;/,
  );
  // Bars and the avatar placeholder are drawn from the theme's own ink and the
  // shared radius tokens, not from a one-off colour.
  assert.match(
    styles,
    /\.subagent-task-skeleton-bar \{[^}]*background-color: color-mix\(in oklab, var\(--ds-text-primary\) 8%, transparent\);/,
  );
  // The highlight has to clear the bar's own fill to be seen at all: the band's
  // peak is a stronger step of the same theme ink than the fill it crosses.
  assert.match(
    styles,
    /\.subagent-task-skeleton-bar \{[^}]*color-mix\(in oklab, var\(--ds-text-primary\) 20%, transparent\) 50%/,
  );
  // Each line slot takes the line box of the real line it stands in, from that
  // line's own type tokens, so the waiting card and the card that replaces it
  // are the same height.
  assert.match(
    styles,
    /\.subagent-task-skeleton-line\.is-title \{\s*width: min\(58%, 240px\);\s*height: calc\(var\(--text-sm-plus\) \* var\(--leading-body\)\);/,
  );
  for (const slot of ["is-role", "is-metrics"]) {
    assert.match(
      styles,
      new RegExp(
        `\\.subagent-task-skeleton-line\\.${slot} \\{[^}]*height: calc\\(var\\(--text-2xs\\) \\* var\\(--leading-normal\\)\\);`,
      ),
      `the ${slot} slot does not take the line box of the real line`,
    );
  }
  // A pending card is disabled only for want of anything to open: it keeps full
  // opacity, while the shared disabled rule still dims every other card.
  assert.match(
    styles,
    /\.subagent-task\.is-preparing > \.subagent-task-card:disabled \{\s*opacity: 1;\s*\}/,
  );
  // The shared disabled rule itself is untouched: other tools' cards and every
  // other disabled control keep their existing dimming.
  assert.match(
    flat(baseStylesSource),
    /button:disabled, input:disabled, textarea:disabled \{\s*cursor: not-allowed;\s*opacity: 0\.5;\s*\}/,
    "the shared disabled rule was changed instead of scoped to the pending card",
  );
  assert.match(
    styles,
    /\.subagent-task-skeleton-avatar \{[^}]*width: 28px;[^}]*height: 28px;[^}]*border-radius: var\(--radius-round\);/,
  );
  // The card's corner badge keeps still, and reduced motion keeps every bar
  // static while the row presentation itself survives.
  assert.match(styles, /\.subagent-task\.is-preparing \.subagent-task-status-icon \{\s*animation: none;/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.tool-row\.is-preparing \.tool-row-icon, \.tool-row\.is-preparing \.tool-row-name \{\s*animation: none;/,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.subagent-task-skeleton-bar \{\s*animation: none;/,
  );
});
