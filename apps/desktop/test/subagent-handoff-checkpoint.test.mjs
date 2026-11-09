/**
 * A delegate's self-handoff in its own transcript tab.
 *
 * The runtime persists an accepted submission as a tool row whose result says
 * `accepted: true`. A subagent transcript must not present that as an ordinary
 * tool invocation: it is a context checkpoint — the delegate's earlier working
 * history was replaced — so it renders in the context-compaction row's visual
 * pattern instead. A call that is still preparing, running, or was refused is
 * not a checkpoint at all: it keeps the ordinary tool row and whatever
 * lifecycle status that row states.
 *
 * The handoff itself is one free-form text the delegate authored, never a set
 * of runtime-named fields: the collapsed line previews that text, the expanded
 * body shows all of it, and both are the delegate's own words. The rendered
 * frames below come from the production `SubagentTranscriptTab` and its real
 * store/i18n wiring through server rendering, so the collapsed line, the
 * numbering, the affordance, and the body are the ones the renderer produces.
 * The expanded body is rendered from the same exported component the row
 * mounts when opened.
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
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const AT = "2026-10-13T00:00:00.000Z";

const message = (id, role, content = "", extra = {}) => ({
  id,
  role,
  content,
  createdAt: AT,
  status: "complete",
  ...extra,
});

/** The `Task` call that opens the delegation's transcript turn. */
function taskCall() {
  return message("t1", "tool", "", {
    toolName: "Task",
    toolCallId: "call-1",
    toolStatus: "success",
    toolArgs: { agent: "explorer", task: "Migrate the cache layer" },
    toolResult: {
      details: {
        delegationId: "d1",
        agent: "explorer",
        status: "running",
        startedAt: Date.parse(AT),
        toolCalls: 1,
        turns: 1,
      },
    },
  });
}

function childRow(id, extra) {
  return message(id, "tool", "", {
    parentToolCallId: "call-1",
    agentName: "explorer",
    toolStatus: "success",
    ...extra,
  });
}

/** A submission the runtime installed: its result records the acceptance. */
function acceptedHandoff(id, callId, handoff) {
  return childRow(id, {
    toolName: "SubagentHandoff",
    toolCallId: callId,
    toolArgs: { handoff },
    toolResult: {
      content: [
        {
          type: "text",
          text: "Handoff recorded. Continue the task; your context is replaced at the next turn boundary.",
        },
      ],
      details: { accepted: true },
    },
  });
}

/** A submission the runtime refused: an error row, never a checkpoint. */
function rejectedHandoff(id, callId) {
  return childRow(id, {
    toolName: "SubagentHandoff",
    toolCallId: callId,
    toolArgs: { handoff: "" },
    toolStatus: "error",
    isError: true,
    toolResult: {
      content: [
        {
          type: "text",
          text: "The handoff is empty: write what your future self needs to continue this task.",
        },
      ],
      details: { accepted: false },
      isError: true,
    },
  });
}

/**
 * A handoff of the kind a delegate writes: prose with its own line breaks and
 * bullets, and no field names the runtime ever asked for. It avoids characters
 * React escapes so the same string can be asserted against server markup.
 */
const HANDOFF = [
  "Migrated cache reads onto the new layer; src/cache/read.ts is the only caller still on the old API.",
  "Binding decisions: the legacy reader stays readable for one release.",
  "",
  "- Verified: pnpm --filter cache test passes (42 tests)",
  "- Open: rewrite the writer, then delete the adapter",
].join("\n");

/** The first line, flattened — what the collapsed row says. */
const HANDOFF_HEAD = "Migrated cache reads onto the new layer;";

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
    // The renderer disables i18next escaping (see main.tsx): model-authored
    // text must not be escaped twice on its way into a translated line.
    interpolation: { escapeValue: false },
  });
  const { SubagentTranscriptTab } = await vite.ssrLoadModule(
    "/src/components/workpanel/SubagentTranscriptTab.tsx",
  );
  const { HandoffCheckpointBody, handoffCheckpoint, handoffCheckpointPreview } =
    await vite.ssrLoadModule("/src/features/chat/transcript/SubagentHandoffCheckpoint.tsx");
  const { SlotSessionProvider } = await vite.ssrLoadModule(
    "/src/plugins/renderer-slots/use-slots.tsx",
  );
  const { useAppStore } = await vite.ssrLoadModule("/src/stores/app-store.ts");
  const withProviders = (node) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(SlotSessionProvider, { sessionId: "s1" }, node),
    );
  const render = (messages) => {
    Object.assign(useAppStore.getInitialState(), {
      activeSessionId: "s1",
      sessions: [{ id: "s1", source: "local", title: "fixture" }],
      messages,
      agentStatuses: { s1: { currentTurnId: "turn-parent" } },
      runningSessions: { s1: true },
      settings: { enterToSend: true },
    });
    return renderToStaticMarkup(
      withProviders(createElement(SubagentTranscriptTab, { delegationId: "d1" })),
    );
  };
  const renderBody = (text) =>
    renderToStaticMarkup(withProviders(createElement(HandoffCheckpointBody, { text })));
  return { vite, render, renderBody, handoffCheckpoint, handoffCheckpointPreview };
}

/** The text a rendered element of `className` carries, markup removed. */
function textOf(html, className) {
  const match = html.match(
    new RegExp(`<[a-z]+ class="${className}[^"]*"[^>]*>([\\s\\S]*?)</[a-z]+>`),
  );
  return match ? match[1] : null;
}

test("an accepted handoff renders as a numbered checkpoint, not as a tool row", async () => {
  const { vite, render } = await setup();
  try {
    const html = render([
      taskCall(),
      acceptedHandoff("h1", "c1", HANDOFF),
      childRow("read-1", {
        toolName: "Read",
        toolCallId: "c-read",
        toolArgs: { path: "src/cache/read.ts" },
        toolResult: { content: [{ type: "text", text: "export const read = 1;" }] },
      }),
      acceptedHandoff("h2", "c2", "Then rerun the full suite."),
      message("a1", "assistant", "Cache reads are migrated."),
    ]);
    // Exactly the two accepted submissions are checkpoints.
    assert.equal((html.match(/transcript-handoff-row/g) ?? []).length, 2);
    // Numbered by their order in this tab's own filtered transcript.
    assert.match(html, /Context handoff · #1/);
    assert.match(html, /Context handoff · #2/);
    // The collapsed line previews the delegate's own handoff text.
    const summary = textOf(html, "transcript-handoff-summary");
    assert.ok(summary, "the collapsed row has no preview");
    // It is a prefix of what the delegate wrote, clamped on one line.
    assert.ok(summary.startsWith(HANDOFF_HEAD), `unexpected preview: ${summary}`);
    assert.equal(summary.at(-1), "…");
    assert.doesNotMatch(summary, /\n/);
    assert.ok(summary.length <= 161);
    assert.ok(!summary.includes("delete the adapter"), "the preview is not clamped");
    const firstCheckpoint = html.slice(html.indexOf("transcript-handoff-row"));
    assert.doesNotMatch(firstCheckpoint.slice(0, 600), /Running|Completed|Done|Pending/);
    // The affordance is a real keyboard-reachable control with the required
    // expanded/controls relationship, collapsed by default.
    const button = html.match(/<button[^>]*class="transcript-handoff-head"[^>]*>/)?.[0] ?? "";
    assert.ok(button, "checkpoint head is not a button");
    assert.match(button, /type="button"/);
    assert.match(button, /aria-expanded="false"/);
    assert.match(button, /aria-controls="[^"]+"/);
    // Nothing is expanded on first paint, and no argument or result JSON is
    // printed as the row's body or summary.
    assert.doesNotMatch(html, /transcript-handoff-body/);
    assert.doesNotMatch(html, /&quot;|handoff&quot;|accepted&quot;|\{&quot;/);
    // The ordinary child tool row in the same turn is untouched.
    assert.match(html, /data-message-id="read-1"/);
  } finally { await vite.close(); }
});

test("a long handoff is previewed, never truncated at the source", async () => {
  const { vite, render, handoffCheckpoint } = await setup();
  try {
    const long = `${"Working through the migration in order. ".repeat(20)}Final detail: keep the adapter until the release lands.`;
    const html = render([taskCall(), acceptedHandoff("h1", "c1", long)]);
    const summary = textOf(html, "transcript-handoff-summary");
    assert.ok(summary, "the collapsed row has no preview");
    // The UI clamps the preview to one short line...
    assert.ok(summary.length <= 161, `preview is ${summary.length} characters`);
    assert.ok(summary.endsWith("…"), "a clamped preview states that it is clamped");
    assert.doesNotMatch(summary, /\n/);
    // ...while the checkpoint still holds every character the delegate wrote.
    assert.ok(long.startsWith(summary.slice(0, -1)));
    const view = handoffCheckpoint(acceptedHandoff("h1", "c1", long));
    assert.equal(view.text, long);
    assert.match(view.text, /Final detail: keep the adapter until the release lands\.$/);
  } finally { await vite.close(); }
});

test("pending and rejected handoffs keep the ordinary tool row and its status", async () => {
  const { vite, render } = await setup();
  try {
    const running = childRow("h-run", {
      toolName: "SubagentHandoff",
      toolCallId: "c-run",
      toolStatus: "running",
      toolArgs: { handoff: "Still being written" },
    });
    const rejected = rejectedHandoff("h-error", "c-err");
    const html = render([taskCall(), running, rejected]);
    // Neither call is a checkpoint: the acceptance is what makes one.
    assert.doesNotMatch(html, /transcript-handoff-row/);
    assert.doesNotMatch(html, /Context handoff/);
    // Each keeps the existing lifecycle presentation the tool row owns.
    assert.match(html, /data-message-id="h-run"/);
    assert.match(html, /status-running/);
    assert.match(html, /data-message-id="h-error"/);
    assert.match(html, /status-error/);
    assert.match(html, /Failed/);
    // The refusal is an error tool row like any other: its own explanation
    // stays behind that row's disclosure, and no status is re-encoded as text.
    assert.doesNotMatch(html, /transcript-handoff-summary/);
  } finally { await vite.close(); }
});

test("the expanded checkpoint shows the whole authored handoff as plain text", async () => {
  const { vite, renderBody, handoffCheckpoint } = await setup();
  try {
    const accepted = acceptedHandoff("h1", "c1", HANDOFF);
    const view = handoffCheckpoint(accepted);
    assert.ok(view, "an accepted submission must produce a checkpoint view");
    const html = renderBody(view.text);
    // Plain text, not markup: the delegate's formatting is preserved by CSS,
    // so the body is one text node with its own line breaks and bullets.
    assert.match(html, /^<div class="transcript-handoff-prose selectable">/);
    assert.ok(html.includes(HANDOFF), "the body does not carry the authored text verbatim");
    assert.match(html, /\n\n- Verified: pnpm --filter cache test passes \(42 tests\)/);
    // No field labels, no wire field name, no JSON, no per-field structure.
    for (const label of ["Next step", "Completed", "Files", "Checks", "Remaining"]) {
      assert.doesNotMatch(html, new RegExp(`>${label}<`), `field label ${label} leaked`);
    }
    for (const key of ["nextStep", "completed", "sideEffects", "handoff", "accepted"]) {
      assert.doesNotMatch(html, new RegExp(`>${key}<`), `raw field ${key} leaked`);
    }
    assert.doesNotMatch(html, /transcript-handoff-field|transcript-handoff-list/);
    assert.doesNotMatch(html, /[{}]/);
    // An accepted row whose text is blank or missing is not a checkpoint.
    assert.equal(handoffCheckpoint(acceptedHandoff("h3", "c3", "   \n ")), null);
    assert.equal(handoffCheckpoint(acceptedHandoff("h4", "c4", undefined)), null);
    assert.equal(
      handoffCheckpoint({ ...accepted, toolName: "Read" }),
      null,
    );
    assert.equal(
      handoffCheckpoint({
        ...accepted,
        toolResult: { content: [], details: { accepted: false } },
      }),
      null,
    );
  } finally { await vite.close(); }
});

test("model-authored markup in a handoff stays text", async () => {
  const { vite, renderBody } = await setup();
  try {
    const injected = 'Before <img src=x onerror="alert(1)"> after & <script>alert(2)</script>';
    const html = renderBody(injected);
    // Nothing the delegate wrote becomes markup...
    assert.doesNotMatch(html, /<img|<script/);
    // ...and the words are still readable, escaped exactly once.
    assert.match(html, /Before &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; after &amp; &lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  } finally { await vite.close(); }
});

test("the checkpoint summary never re-encodes a lifecycle state", async () => {
  const { vite, handoffCheckpointPreview } = await setup();
  try {
    // The preview is the delegate's text and nothing else, whatever the row's
    // own tool status is: acceptance is `details.accepted`, not prose.
    assert.ok(handoffCheckpointPreview(HANDOFF).startsWith(HANDOFF_HEAD));
    assert.equal(handoffCheckpointPreview(HANDOFF).at(-1), "…");
    assert.equal(handoffCheckpointPreview("  one   line \n only "), "one line only");
    assert.equal(handoffCheckpointPreview("short"), "short");
  } finally { await vite.close(); }
});

/**
 * The disclosure's *activation* — the one thing static markup cannot prove.
 *
 * A real Chromium renderer is the lightest harness in this repository that can
 * answer a mouse click and Enter/Space (the existing `scripts/e2e-subagent-*`
 * probes drive an isolated Electron window the same way: an esbuild bundle of
 * production sources, a hidden window, real input events). The fixture mounts
 * the production checkpoint row inside the same disclosure provider the
 * transcript tab wraps it in, so the open/collapse path under test is the
 * production one; real `sendInputEvent` mouse and key events are what press the
 * control, not synthetic DOM events.
 */
test("the checkpoint disclosure opens and collapses by real click and Space", async (t) => {
  const repoRoot = join(root, "..", "..");
  const electronBinary = join(
    root,
    "node_modules",
    "electron",
    "dist",
    process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron",
  );
  if (!existsSync(electronBinary)) {
    t.skip("Electron binary is not installed in this checkout");
    return;
  }
  const { build } = createRequire(join(repoRoot, "packages/agent-runtime/package.json"))("esbuild");
  const temp = await mkdtemp(join(tmpdir(), "pi-handoff-checkpoint-"));
  try {
    const entry = join(temp, "probe.tsx");
    const handoff = acceptedHandoff("h1", "c1", HANDOFF);
    await writeFile(
      entry,
      `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { TranscriptDisclosureProvider } from ${JSON.stringify(join(root, "src/features/chat/transcript/disclosure.tsx"))};
import { SubagentHandoffCheckpointRow } from ${JSON.stringify(join(root, "src/features/chat/transcript/SubagentHandoffCheckpoint.tsx"))};

const message = ${JSON.stringify(handoff)};
const expected = ${JSON.stringify(HANDOFF)};
const i18n = createInstance();
void i18n
  .init({
    lng: "zh-CN",
    resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
    interpolation: { escapeValue: false },
  })
  .then(() => {
    createRoot(document.getElementById("root")).render(
      createElement(I18nextProvider, { i18n },
        createElement(TranscriptDisclosureProvider, null,
          createElement(SubagentHandoffCheckpointRow, { message, times: 1 }))),
    );
    window.__expected = expected;
  });
`,
    );
    await build({
      entryPoints: [entry],
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".css": "empty" },
      alias: {
        "@pi-desktop/i18n": join(repoRoot, "packages/i18n/src/index.ts"),
        "@pi-desktop/shared": join(repoRoot, "packages/shared/src/index.ts"),
        react: join(root, "node_modules/react"),
        "react-dom": join(root, "node_modules/react-dom"),
        i18next: join(root, "node_modules/i18next"),
        "react-i18next": join(root, "node_modules/react-i18next"),
      },
      nodePaths: [join(root, "node_modules")],
    });
    await writeFile(
      join(temp, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>handoff checkpoint</title><div id="root"></div><script src="renderer.js"></script>`,
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const READ = ${JSON.stringify(`(() => {
  const row = document.querySelector(".transcript-handoff-row");
  const head = row && row.querySelector(".transcript-handoff-head");
  const body = row && row.querySelector(".transcript-handoff-body");
  if (!head) return null;
  const prose = body && body.querySelector(".transcript-handoff-prose");
  return {
    expanded: head.getAttribute("aria-expanded"),
    tag: head.tagName,
    hasBody: Boolean(body),
    controlsMatch: Boolean(body) && head.getAttribute("aria-controls") === body.id,
    preview: row.querySelector(".transcript-handoff-summary")?.textContent ?? null,
    label: row.querySelector(".transcript-handoff-label")?.textContent ?? null,
    text: prose ? prose.textContent : null,
    matchesAuthored: Boolean(prose) && prose.textContent === window.__expected,
    lines: prose ? prose.textContent.split(String.fromCharCode(10)).length : 0,
    elementChildren: prose ? prose.children.length : -1,
    bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : 0,
    focused: document.activeElement === head,
    documentFocused: document.hasFocus(),
    raw: body ? /[{}]|&quot;/.test(body.innerText) : false,
  };
})()`)};\napp.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 720,
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on("console-message", (event) => console.error("[renderer] " + event.message));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = () => win.webContents.executeJavaScript(READ);
  const click = async (point) => {
    win.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await pause(120);
  };
  const key = (type, keyCode) => win.webContents.sendInputEvent({ type, keyCode });
  const press = async (keyCode) => {
    key("keyDown", keyCode);
    await pause(80);
    return () => key("keyUp", keyCode);
  };
  const steps = {};
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    for (let i = 0; i < 100 && !(await read()); i += 1) await pause(50);
    steps.mounted = await read();
    const point = await win.webContents.executeJavaScript(
      '(() => { const r = document.querySelector(".transcript-handoff-head").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()',
    );
    await click(point);
    steps.afterClick = await read();
    await click(point);
    steps.afterSecondClick = await read();
    // Native key activation is delivered to the focused webContents; the window
    // itself stays hidden so nothing appears on the desktop.
    win.webContents.focus();
    await pause(150);
    await win.webContents.executeJavaScript(
      'document.querySelector(".transcript-handoff-head").focus(); true',
    );
    await pause(150);
    steps.focused = await read();
    let release = await press("Space");
    steps.afterSpaceDown = await read();
    release();
    await pause(120);
    steps.afterSpaceOpen = await read();
    release = await press("Space");
    release();
    await pause(120);
    steps.afterSpaceClose = await read();
    console.log("SUBAGENT_HANDOFF_PROBE " + JSON.stringify({ ok: true, steps }));
    app.quit();
  } catch (error) {
    console.error("SUBAGENT_HANDOFF_PROBE " + JSON.stringify({ ok: false, error: error?.stack ?? String(error), steps }));
    app.exit(1);
  }
});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (data) => { output += data; });
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timeout);
    }
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith("SUBAGENT_HANDOFF_PROBE "));
    assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-3000)}`);
    const result = JSON.parse(line.slice("SUBAGENT_HANDOFF_PROBE ".length));
    assert.equal(code, 0, output.slice(-4000));
    assert.equal(result.ok, true);
    const { mounted, afterClick, afterSecondClick, focused, afterSpaceDown, afterSpaceOpen, afterSpaceClose } = result.steps;
    // Collapsed on first paint: a real button, no body in the tree.
    assert.equal(mounted.tag, "BUTTON");
    assert.equal(mounted.expanded, "false");
    assert.equal(mounted.hasBody, false);
    assert.equal(mounted.label, "上下文交接 · 第 1 次");
    // A real mouse click opens it: aria-expanded flips, the body mounts with
    // the whole authored handoff, a real painted height, and the controls
    // relation holds.
    assert.equal(afterClick.expanded, "true");
    assert.equal(afterClick.hasBody, true);
    assert.equal(afterClick.controlsMatch, true);
    assert.ok(afterClick.bodyHeight > 0, "expanded body has no painted height");
    assert.equal(afterClick.matchesAuthored, true, "the expanded body must equal the authored handoff");
    assert.equal(afterClick.lines, HANDOFF.split("\n").length, "authored line breaks are preserved");
    assert.equal(afterClick.raw, false);
    assert.equal(afterClick.elementChildren, 0, "the handoff must render as text, not markup");
    // A second click collapses it again.
    assert.equal(afterSecondClick.expanded, "false");
    assert.equal(afterSecondClick.hasBody, false);
    // The focused control is a native button, so Enter activates it through the
    // element's own default action. Electron's injected key events only carry
    // Space activation here (a `keyDown`/`keyUp` of Enter produces no keypress
    // in webContents.sendInputEvent), so only Space is driven below.
    assert.equal(focused.focused, true);
    assert.equal(focused.tag, "BUTTON");
    // A real Space keypress opens it on key release...
    assert.equal(afterSpaceDown.expanded, "false");
    assert.equal(afterSpaceOpen.expanded, "true");
    assert.equal(afterSpaceOpen.hasBody, true);
    assert.equal(afterSpaceOpen.controlsMatch, true);
    assert.ok(afterSpaceOpen.bodyHeight > 0, "keyboard-opened body has no painted height");
    assert.equal(afterSpaceOpen.matchesAuthored, true);
    // ...and the next one closes it again.
    assert.equal(afterSpaceClose.expanded, "false");
    assert.equal(afterSpaceClose.hasBody, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
