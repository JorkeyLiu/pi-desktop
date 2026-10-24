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

test("a preparing delegation keeps its card and names the work when it can", async (t) => {
  const render = await transcriptSsr(t);
  const html = render([
    message("user-1", "user", "Audit the parser."),
    message("answer", "assistant", "", { status: "streaming" }),
    message("task-1", "tool", "", {
      toolCallId: "task-1",
      toolName: "Task",
      toolStatus: "preparing",
      status: "streaming",
      toolArgs: { description: "Audit the parser" },
    }),
  ]);
  assert.match(
    html,
    /class="tool-row subagent-task is-running is-creating is-preparing"/,
  );
  assert.match(html, /data-outcome="running"/);
  assert.match(html, /class="subagent-task-title" title="Audit the parser">Audit the parser</);
  // The card states no child state at all while the parent is still writing
  // this call: no spinner, no status wording, no clock, and no metric
  // placeholders. It also offers no stop handle before a delegation exists.
  assert.doesNotMatch(html, /subagent-task-state/);
  assert.doesNotMatch(html, /subagent-task-spinner/);
  assert.doesNotMatch(html, /class="subagent-task-status"/);
  assert.doesNotMatch(html, /subagent-task-duration/);
  assert.doesNotMatch(html, /subagent-task-metrics/);
  assert.doesNotMatch(html, /Starting subagent/);
  assert.doesNotMatch(html, /subagent-stop-button/);
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

test("the breath is icon-and-name only and reduced motion keeps it static", () => {
  const styles = flat(stylesSource);
  assert.match(
    styles,
    /\.tool-row\.is-preparing \.tool-row-icon, \.tool-row\.is-preparing \.tool-row-name, \.subagent-task\.is-preparing \.subagent-task-avatar, \.subagent-task\.is-preparing \.subagent-task-title \{\s*animation: tool-preparing-breath 1\.4s var\(--motion-ease-standard\) infinite;/,
  );
  // One synchronized keyframe for both surfaces: only opacity changes.
  assert.match(
    styles,
    /@keyframes tool-preparing-breath \{\s*0%, 100% \{\s*opacity: 1; \}\s*50% \{\s*opacity: 0\.45; \}\s*\}/,
  );
  // Nothing else in the row animates while arguments stream: no whole-row or
  // whole-card effect, and the card's corner badge keeps still.
  assert.match(styles, /\.subagent-task\.is-preparing \.subagent-task-status-icon \{\s*animation: none;/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.tool-row\.is-preparing \.tool-row-icon, \.tool-row\.is-preparing \.tool-row-name, \.subagent-task\.is-preparing \.subagent-task-avatar, \.subagent-task\.is-preparing \.subagent-task-title \{\s*animation: none;/,
  );
});
