/**
 * A failed tool call discloses why it failed.
 *
 * The pi-ai envelope carries two halves: `details`, the structured result, and
 * text blocks, the explanation the model read. A failure often puts the verdict
 * in `details` (`accepted: false`) and the reason in the text, so a row that
 * renders only the structured half opens on a JSON verdict the reader cannot
 * act on — and a failure that recorded no result at all opens on nothing.
 *
 * These tests drive the production `SubagentTranscriptTab` and its real
 * `ToolRow` through server rendering, seeded with the shapes the runtime
 * persists (a live refusal, a restored interrupted call, a call that recorded
 * no result). Each row is opened through the production disclosure path — the
 * transcript search reveal, which the disclosure treats as its first-paint
 * default — so the body under test is the one a reader expands to, and the
 * enabled/aria state is the one the header button really renders.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

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

/** One row the delegate produced inside this delegation. */
function childRow(id, extra) {
  return message(id, "tool", "", {
    parentToolCallId: "call-1",
    agentName: "explorer",
    toolStatus: "success",
    ...extra,
  });
}

const REFUSAL =
  "The handoff is empty: write what your future self needs to continue this task.";

/**
 * A submission the runtime refused, as it is persisted: the verdict in
 * `details`, the explanation in the text block the delegate's transcript read.
 */
function refusedHandoff(id = "h-error", callId = "c-err") {
  return childRow(id, {
    toolName: "SubagentHandoff",
    toolCallId: callId,
    toolArgs: { handoff: "" },
    toolStatus: "error",
    isError: true,
    toolResult: {
      content: [{ type: "text", text: REFUSAL }],
      details: { accepted: false },
      isError: true,
    },
  });
}

/** A call that ended in error without recording any result at all. */
function lostResult(id = "h-lost", callId = "c-lost") {
  return childRow(id, {
    toolName: "SubagentHandoff",
    toolCallId: callId,
    toolArgs: { handoff: "Summarized the migration, then the run stopped." },
    toolStatus: "error",
    isError: true,
  });
}

/**
 * A call restored from persisted history that never recorded a result; the
 * runtime stands in the interruption with its own sentence.
 */
function interruptedRestore(id = "h-int", callId = "c-int") {
  return childRow(id, {
    toolName: "Read",
    toolCallId: callId,
    toolArgs: { path: "src/cache/read.ts" },
    toolStatus: "error",
    isError: true,
    toolResult: {
      content: [
        { type: "text", text: "[tool call was interrupted before a result was recorded]" },
      ],
      isError: true,
    },
  });
}

/** A terminal failure whose structured error the runtime attached. */
function recordedError(id = "h-rec", callId = "c-rec") {
  return childRow(id, {
    toolName: "SubagentHandoff",
    toolCallId: callId,
    toolArgs: { handoff: "Written, then cancelled." },
    toolStatus: "error",
    isError: true,
    error: { code: "E_ABORTED", message: "The provider cancelled this call." },
  });
}

/** A call the user denied: no result, no recorded reason. */
function deniedCall(id = "h-den", callId = "c-den") {
  return childRow(id, {
    toolName: "SubagentHandoff",
    toolCallId: callId,
    toolArgs: { handoff: "Would have replaced the context." },
    toolStatus: "denied",
  });
}

/** A rejected `Read`: the envelope's text is the JSON echo of `details`. */
function refusedRead(id = "h-read", callId = "c-read") {
  const details = { error: "no such file", code: "ENOENT" };
  return childRow(id, {
    toolName: "Read",
    toolCallId: callId,
    toolArgs: { path: "missing.ts", limit: 20 },
    toolStatus: "error",
    isError: true,
    toolResult: {
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
      isError: true,
    },
  });
}

/** The accepted submission the checkpoint row owns, for the untouched path. */
function acceptedHandoff(id = "h1", callId = "c1") {
  return childRow(id, {
    toolName: "SubagentHandoff",
    toolCallId: callId,
    toolArgs: { handoff: "Migrated cache reads; rerun the full suite." },
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
    interpolation: { escapeValue: false },
  });
  const { SubagentTranscriptTab } = await vite.ssrLoadModule(
    "/src/components/workpanel/SubagentTranscriptTab.tsx",
  );
  const { SlotSessionProvider } = await vite.ssrLoadModule(
    "/src/plugins/renderer-slots/use-slots.tsx",
  );
  const { useAppStore } = await vite.ssrLoadModule("/src/stores/app-store.ts");
  const { TranscriptSearchContext } = await vite.ssrLoadModule(
    "/src/lib/transcript-search-context.ts",
  );
  /**
   * `openId` names the row the transcript search asked to reveal: the
   * disclosure hook derives its first-paint open state from that request, so
   * the row renders its real body without a synthetic DOM event.
   */
  const render = (messages, openId) => {
    Object.assign(useAppStore.getInitialState(), {
      activeSessionId: "s1",
      sessions: [{ id: "s1", source: "local", title: "fixture" }],
      messages,
      agentStatuses: { s1: { currentTurnId: "turn-parent" } },
      runningSessions: { s1: true },
      settings: { enterToSend: true },
    });
    const target = openId
      ? { sessionId: "s1", messageId: openId, query: "", requestId: 1 }
      : null;
    return renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          TranscriptSearchContext.Provider,
          { value: target },
          createElement(
            SlotSessionProvider,
            { sessionId: "s1" },
            createElement(SubagentTranscriptTab, { delegationId: "d1" }),
          ),
        ),
      ),
    );
  };
  return { vite, render };
}

/** The row's own markup, so an assertion cannot read a neighbouring row. */
function rowMarkup(html, id) {
  const start = html.indexOf(`data-message-id="${id}"`);
  assert.ok(start >= 0, `row ${id} is not rendered`);
  const next = html.indexOf("data-message-id=", start + 1);
  return next >= 0 ? html.slice(start, next) : html.slice(start);
}

/** The expanded body of a row, or null when none is mounted. */
function rowBody(html, id) {
  const markup = rowMarkup(html, id);
  const start = markup.indexOf('class="tool-row-body"');
  // The body is the row's last block; slicing from it keeps neighbouring rows
  // out of an assertion without parsing the markup.
  return start < 0 ? null : markup.slice(start);
}

test("a refused handoff opens to the delegate's failure reason, not its verdict alone", async () => {
  const { vite, render } = await setup();
  try {
    const html = render([taskCall(), refusedHandoff()], "h-error");
    const body = rowBody(html, "h-error");
    assert.ok(body, "the refused row's disclosure did not open");
    // The sentence the runtime refused the submission with is the body's
    // explanation, under the standard error section head.
    assert.ok(body.includes(REFUSAL), "the refusal does not state its reason");
    assert.match(body, /<span>Error<\/span>/);
    // Once: the row must not print the reason twice.
    assert.equal((body.match(/The handoff is empty/g) ?? []).length, 1);
    // The structured half is retained rather than discarded...
    assert.match(body, /<dt class="tool-field-label">accepted<\/dt>/);
    // ...and the untouched payload stays one disclosure away.
    assert.match(body, /class="tool-raw"/);
  } finally { await vite.close(); }
});

test("a failed call that recorded no result opens on an honest reason, never an empty body", async () => {
  const { vite, render } = await setup();
  try {
    const html = render([taskCall(), lostResult()], "h-lost");
    const body = rowBody(html, "h-lost");
    assert.ok(body, "the failed row rendered an enabled disclosure with no body");
    // Nothing was recorded, so the row says exactly that instead of inventing
    // a cause; the sentence is the localized one the renderer supplies.
    assert.ok(
      body.includes("The call failed without reporting a reason."),
      "the failed row states no reason at all",
    );
    // A denied call says it was denied, not that it failed.
    const denied = render([taskCall(), deniedCall()], "h-den");
    const deniedBody = rowBody(denied, "h-den");
    assert.ok(deniedBody, "the denied row rendered an enabled disclosure with no body");
    assert.ok(
      deniedBody.includes("The call was denied without reporting a reason."),
      "the denied row states no reason at all",
    );
  } finally { await vite.close(); }
});

test("a restored interruption keeps the runtime's own sentence", async () => {
  const { vite, render } = await setup();
  try {
    const html = render([taskCall(), interruptedRestore()], "h-int");
    const body = rowBody(html, "h-int");
    assert.ok(body, "the interrupted row's disclosure did not open");
    assert.ok(
      body.includes("tool call was interrupted before a result was recorded"),
      "the interruption the runtime recorded is not disclosed",
    );
  } finally { await vite.close(); }
});

test("a recorded structured error is the row's reason", async () => {
  const { vite, render } = await setup();
  try {
    const html = render([taskCall(), recordedError()], "h-rec");
    const body = rowBody(html, "h-rec");
    assert.ok(body, "the failed row's disclosure did not open");
    assert.ok(body.includes("The provider cancelled this call."));
    assert.ok(body.includes("E_ABORTED"), "the error code is dropped");
  } finally { await vite.close(); }
});

test("a rejected payload echo is not printed as a second error", async () => {
  const { vite, render } = await setup();
  try {
    const html = render([taskCall(), refusedRead()], "h-read");
    const body = rowBody(html, "h-read");
    assert.ok(body, "the failed read did not open");
    // The host's own error speaks once, with its code.
    assert.equal(
      (body.match(/no such file/g) ?? []).length,
      1,
      "the error is restated",
    );
    assert.match(body, /no such file \(ENOENT\)/);
    // The envelope's text is that payload serialized again, not a reason.
    assert.ok(
      !body.includes("&quot;error&quot;"),
      "the payload echo is printed as the failure reason",
    );
  } finally { await vite.close(); }
});

test("an accepted handoff and a successful call keep their presentation", async () => {
  const { vite, render } = await setup();
  try {
    // A successful tool whose payload needs no dedicated card: the file list
    // it matched, unchanged by the failure paths above.
    const glob = childRow("glob-1", {
      toolName: "Glob",
      toolCallId: "c-glob-ok",
      toolArgs: { pattern: "src/cache/*.ts" },
      toolResult: {
        content: [
          { type: "text", text: JSON.stringify({ matches: ["src/cache/read.ts"] }) },
        ],
        details: { matches: ["src/cache/read.ts"] },
      },
    });
    const html = render([taskCall(), acceptedHandoff(), glob], "glob-1");
    // The accepted submission is still a context checkpoint.
    assert.match(html, /transcript-handoff-row/);
    assert.doesNotMatch(html, /data-message-id="h1"/);
    // The successful call's body is its payload, with no failure note added.
    const body = rowBody(html, "glob-1");
    assert.ok(body, "the successful row's disclosure did not open");
    assert.ok(body.includes("src/cache/read.ts"));
    assert.doesNotMatch(body, /without reporting a reason|>Error</);
    // Its envelope text is the payload echo, so no second copy of it either.
    assert.equal((body.match(/src\/cache\/read\.ts/g) ?? []).length, 1);
  } finally { await vite.close(); }
});

/**
 * The disclosure's *activation* — what static markup cannot prove.
 *
 * A real Chromium renderer is the lightest harness in this repository that
 * answers a mouse click: an esbuild bundle of production sources mounted in a
 * hidden window, real `sendInputEvent` input, no user desktop instance. It
 * mounts the production `ToolRow` inside the disclosure provider the transcript
 * wraps it in, so the enabled/disabled state, the expansion and the body are the
 * ones a reader gets, and it presses each failed row's header for real.
 */
test("a failed row opens on its reason by a real click, never on an empty body", async (t) => {
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
  const repoRoot = join(root, "..", "..");
  const { build } = createRequire(join(repoRoot, "packages/agent-runtime/package.json"))("esbuild");
  const temp = await mkdtemp(join(tmpdir(), "pi-tool-error-disclosure-"));
  try {
    await writeFile(
      join(temp, "probe.tsx"),
      `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { TranscriptDisclosureProvider } from ${JSON.stringify(join(root, "src/features/chat/transcript/disclosure.tsx"))};
import { SlotSessionProvider } from ${JSON.stringify(join(root, "src/plugins/renderer-slots/use-slots.tsx"))};
import { useAppStore } from ${JSON.stringify(join(root, "src/stores/app-store.ts"))};
import { ToolRow } from ${JSON.stringify(join(root, "src/features/chat/transcript/ToolRow.tsx"))};

const refused = ${JSON.stringify(refusedHandoff("h-error", "c-err"))};
const lost = ${JSON.stringify(lostResult("h-lost", "c-lost"))};
Object.assign(useAppStore.getInitialState(), {
  activeSessionId: "s1",
  sessions: [{ id: "s1", source: "local", title: "fixture" }],
  messages: [refused, lost],
  agentStatuses: {},
  runningSessions: {},
  settings: { enterToSend: true },
});
const i18n = createInstance();
void i18n
  .init({
    lng: "en",
    resources: { en: { translation: flattenCatalog(catalogs.en) } },
    interpolation: { escapeValue: false },
  })
  .then(() => {
    createRoot(document.getElementById("root")).render(
      createElement(I18nextProvider, { i18n },
        createElement(TranscriptDisclosureProvider, null,
          createElement(SlotSessionProvider, { sessionId: "s1" },
            createElement("div", null,
              createElement(ToolRow, { message: refused }),
              createElement(ToolRow, { message: lost }),
            ))),
      ),
    );
  });
`,
    );
    await build({
      entryPoints: [join(temp, "probe.tsx")],
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".css": "empty" },
      logLevel: "silent",
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
      `<!doctype html><meta charset="utf-8"><title>failed tool rows</title><div id="root"></div><script src="renderer.js"></script>`,
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const READ = ${JSON.stringify(`(() => {
  const rows = [...document.querySelectorAll(".tool-row")];
  return rows.map((row) => {
    const head = row.querySelector(".tool-row-header");
    const body = row.querySelector(".tool-row-body");
    return {
      id: row.getAttribute("data-message-id"),
      expanded: head ? head.getAttribute("aria-expanded") : null,
      disabled: head ? head.disabled : null,
      hasBody: Boolean(body),
      bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : 0,
      bodyText: body ? body.innerText : null,
      errorNote: body ? Boolean(body.querySelector(".tool-note.is-error")) : false,
    };
  });
})()`)}
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 720,
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on("console-message", (event) => console.error("[renderer] " + event.message));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = () => win.webContents.executeJavaScript(READ);
  const rowFor = (rows, id) => rows.find((row) => row.id === id);
  const clickHead = async (id) => {
    const point = await win.webContents.executeJavaScript(
      "((id) => { const row = [...document.querySelectorAll('.tool-row')].find((entry) => entry.dataset.messageId === id); const head = row.querySelector('.tool-row-header'); const r = head.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })(" + JSON.stringify(id) + ")",
    );
    win.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await pause(150);
  };
  const steps = {};
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    for (let i = 0; i < 100 && (await read()).length < 2; i += 1) await pause(50);
    steps.mounted = await read();
    await clickHead("h-error");
    steps.afterRefused = await read();
    await clickHead("h-lost");
    steps.afterLost = await read();
    console.log("TOOL_ERROR_DISCLOSURE_PROBE " + JSON.stringify({ ok: true, steps }));
    app.quit();
  } catch (error) {
    console.error("TOOL_ERROR_DISCLOSURE_PROBE " + JSON.stringify({ ok: false, error: error?.stack ?? String(error), steps }));
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
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timeout);
    }
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith("TOOL_ERROR_DISCLOSURE_PROBE "));
    assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-3000)}`);
    const result = JSON.parse(line.slice("TOOL_ERROR_DISCLOSURE_PROBE ".length));
    assert.equal(code, 0, output.slice(-4000));
    assert.equal(result.ok, true);
    const mounted = result.steps.mounted;
    const rowFor = (rows, id) => rows.find((row) => row.id === id);
    assert.equal(mounted.length, 2, "both failed rows rendered");
    // Collapsed on first paint, but each carries a real, enabled control: the
    // reader sees the caret, and no empty body is mounted yet.
    for (const row of mounted) {
      assert.equal(row.expanded, "false");
      assert.equal(row.disabled, false);
      assert.equal(row.hasBody, false);
    }
    const refused = rowFor(result.steps.afterRefused, "h-error");
    assert.ok(refused, "the refused row disappeared");
    // A real click opens it onto the reason the runtime refused it with.
    assert.equal(refused.expanded, "true");
    assert.equal(refused.hasBody, true);
    assert.ok(refused.bodyHeight > 0, "the expanded body has no painted height");
    assert.equal(refused.errorNote, true);
    assert.ok(refused.bodyText.includes(REFUSAL), "the opened body drops the refusal reason");
    assert.equal((refused.bodyText.match(/The handoff is empty/g) ?? []).length, 1);
    // The other failed row was not opened along with it.
    assert.equal(rowFor(result.steps.afterRefused, "h-lost").expanded, "false");
    const lost = rowFor(result.steps.afterLost, "h-lost");
    assert.equal(lost.expanded, "true");
    assert.equal(lost.hasBody, true);
    assert.ok(lost.bodyHeight > 0, "the expanded body has no painted height");
    assert.equal(lost.errorNote, true);
    assert.ok(lost.bodyText.includes("The call failed without reporting a reason."));
  } finally {
    if (!process.env.KEEP_PROBE_TEMP) await rm(temp, { recursive: true, force: true });
    else console.error("probe temp kept at " + temp);
  }
});
