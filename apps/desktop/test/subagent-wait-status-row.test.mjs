/**
 * The transcript tail's runtime status row against a parent-side child wait.
 *
 * A parent waiting on its delegates is already stated twice without this row:
 * the running-subagent dock above the composer lists every live child with its
 * own elapsed time, and the turn keeps the `Task` / `TaskWait` rows that began
 * and settled the wait. The aggregate purple row would be a third copy of the
 * same state, so the indicator draws nothing for that phase - while every
 * runtime phase the parent owns itself (its model wait, retry, and the rest)
 * keeps rendering exactly as before.
 *
 * Both payload shapes of the phase are covered: the snapshot with `agents[]`
 * and the older count-only payload without it. The phase keeps its aggregate
 * label in the model; only the tail row is gone, so the removed text is pinned
 * here rather than left to drift.
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

/** A live wait: the fixture is "now", so the row's own timer reads like one. */
const NOW = Date.now();

test("a wait on child agents draws no transcript status row, other phases do", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { RunActivityIndicator, runActivityLabel } = await server.ssrLoadModule(
      "/src/features/chat/transcript/ActivityGroup.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const t = (key, options) => i18n.t(key, options);
    const render = (activity) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(RunActivityIndicator, { activity }),
        ),
      );

    const threeChildren = {
      phase: "waiting-subagents",
      since: NOW - (18 * 60 + 47) * 1000,
      subagentCount: 3,
      agents: [
        { name: "manifestor", lastPhase: "waiting-model" },
        { name: "manifestor", lastPhase: "tool", lastToolName: "Bash" },
        { name: "manifestor", lastPhase: "thinking" },
      ],
    };

    // The dock and the Task/TaskWait rows own this state: no second aggregate
    // row, in either payload shape the phase can arrive in.
    for (const activity of [
      threeChildren,
      { phase: "waiting-subagents", since: NOW, subagentCount: 2 },
    ]) {
      const markup = render(activity);
      assert.equal(markup, "");
      assert.doesNotMatch(markup, /run-activity-indicator|working-indicator/);
    }

    // What that row used to say, and what it still says in the model: the
    // suppression is a render decision, not a lost localization.
    const removed = runActivityLabel(threeChildren, t, NOW);
    assert.match(removed, /^Waiting for 3 subagents · /);
    assert.match(removed, /manifestor Waiting for model/);
    assert.match(removed, /manifestor Running, manifestor Thinking$/);

    // The parent's own activity is untouched: its model wait still names the
    // phase on the same row it always did.
    const modelWait = render({ phase: "waiting-model", since: NOW - 4000 });
    assert.match(modelWait, /data-phase="waiting-model"/);
    assert.match(modelWait, /data-testid="run-activity-indicator"/);
    assert.match(modelWait, /Waiting for model/);

    // Naming quiet intervals beyond the child wait survives: a retry keeps its
    // reason and its error plate, not a silent row.
    const retry = render({
      phase: "retrying",
      since: NOW - 1000,
      attempt: 2,
      retryDelayMs: 5000,
      error: { code: "provider_unavailable", message: "upstream 503" },
    });
    assert.match(retry, /data-phase="retrying"/);
    assert.match(retry, /run-activity-error-popover message-error/);
    assert.match(retry, /upstream 503/);

    // Compaction and the other quiet parent phases keep their own rows.
    for (const activity of [
      { phase: "starting", since: NOW },
      { phase: "preparing", since: NOW },
      { phase: "recovering", since: NOW },
      { phase: "compacting", since: NOW, reason: "threshold" },
    ]) {
      assert.match(render(activity), /data-testid="run-activity-indicator"/);
    }
  } finally {
    await server.close();
  }
});
