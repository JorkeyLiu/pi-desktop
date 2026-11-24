import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { loadStyles } from "./helpers/styles.mjs";

/**
 * A rejected `Task(resume …)` never reaches the dock or the tab's stop path.
 *
 * The user path under test: two live delegates (`d1` and a parallel `d2`)
 * are running when the parent model issues `Task(resume d1)` and the runtime
 * rejects it — no new run, no new child rows, `TaskList` still reporting both
 * delegations running. The dock must still list two running children including
 * `d1`, the open `d1` tab must keep its `Running` header with the original
 * prompt rendered once (the rejected brief is never a delivered user row),
 * and stopping the `d1` row must invoke `agentStopSubagents` with `d1` — not
 * the failed request's call id.
 *
 * The harness mounts the real `SubagentDock` and the real
 * `SubagentTranscriptTab` with the real app store in an isolated Electron
 * window. Only `window.piDesktop` (the process boundary) is a stub, so the
 * stop click exercises the production invoke path up to the IPC edge.
 */
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { SubagentDock } from "../../apps/desktop/src/components/SubagentDock";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });

const listeners = new Map();
const calls = [];
const emit = (channel, payload) => {
  for (const callback of listeners.get(channel) ?? []) callback(payload);
};

window.piDesktop = { platform: "darwin", channels: IPC,
  on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel)?.delete(callback);
  },
  async invoke(channel, input) {
    calls.push({ channel, input });
    let data = null;
    if (channel === IPC.invoke.agentStopSubagents) {
      data = { content: [{ type: "text", text: "stopping" }],
        details: { stopped: [], stopPending: (input?.delegationIds ?? []).map((id) => ({ delegationId: id, status: "running" })) } };
    } else if (channel === IPC.invoke.sessionList) {
      data = { sessions: [{ id: "s1", title: "fixture", projectPath: "/tmp/fixture", createdAt: "2026-05-01T09:00:00.000Z", updatedAt: "2026-05-01T10:00:00.000Z", source: "local" }] };
    } else if (channel === IPC.invoke.sessionGet) {
      data = { session: { id: "s1", title: "fixture", projectPath: "/tmp/fixture", source: "local", messages: sessionMessages } };
    } else if (channel === IPC.invoke.agentGetQueuedPrompts) {
      data = { entries: [] };
    } else if (channel === IPC.invoke.agentGetStatus) {
      data = { sessionId: "s1", isRunning: sessionRunning, pendingToolConfirmations: 0 };
    }
    return { ok: true, data };
  },
};

const store = useAppStore;
window.piDesktop.on(IPC.event.agentMessage, (envelope) => store.getState().handleAgentEvent(envelope));

const iso = (seconds) => new Date(Date.parse("2026-05-01T10:00:00.000Z") + seconds * 1000).toISOString();
const ORIG = "Map the cache invalidation path.";
const SECOND = "Second parallel brief.";
const REJECTED_BRIEF = "Supplemental brief: re-check the figures against source B and report deltas.";
const LATER_ROW = "Found the mismatch in source B.";

const usage = (op) => ({ inputTokens: 100, outputTokens: 50, totalTokens: 150, operationId: op, aggregation: "operation" });

const dispatchRow = ({ id, callId, delegationId, description, task, at }) => {
  const result = { content: [{ type: "text", text: "Delegation " + delegationId + ": running." }],
    details: { delegationId, agent: "explorer", status: "running",
      startedAt: Date.parse("2026-05-01T10:00:00Z"), modelId: "test-model", thinkingLevel: "high",
      turns: 1, toolCalls: 1, executionTurnId: "turn-parent", usage: usage("op-" + callId) } };
  return { id, role: "tool", content: JSON.stringify(result), createdAt: iso(at),
    toolCallId: callId, toolName: "Task", toolArgs: { agent: "explorer", description, task },
    toolStatus: "success", toolResult: result,
    toolCompletedAt: iso(at + 1), toolDurationMs: 1000, status: "complete", isError: false };
};

const rejectedRow = (resume) => ({
  id: "m-call-rejected", role: "tool", content: "", createdAt: iso(7),
  toolCallId: "tc-resume-2", toolName: "Task",
  toolArgs: { agent: "explorer", description: "Research X", task: REJECTED_BRIEF, resume },
  toolStatus: "error",
  toolResult: { error: { code: "RESUME_REJECTED", message: "delegation d1 is still running" } },
  error: { code: "RESUME_REJECTED", message: "delegation d1 is still running" },
  status: "error", isError: true,
});

const messagesFor = (resume) => ([
  { id: "u1", role: "user", content: "Research X.", createdAt: iso(0) },
  { id: "a1", role: "assistant", content: "Dispatching two parallel runs.", createdAt: iso(1), status: "complete" },
  dispatchRow({ id: "m-call-1", callId: "tc-orig-1", delegationId: "d1", description: "Research X", task: ORIG, at: 2 }),
  dispatchRow({ id: "m-call-2", callId: "tc-parallel-2", delegationId: "d2", description: "Manifestor fix", task: SECOND, at: 3 }),
  { id: "child-a1", role: "assistant", content: "Working on the figures.", createdAt: iso(4),
    parentToolCallId: "tc-orig-1", agentName: "explorer", status: "complete", usage: usage("op-a1") },
  { id: "m-list-1", role: "tool", content: "", createdAt: iso(6),
    toolName: "TaskList", toolCallId: "tc-list-9", toolStatus: "success", toolArgs: {},
    toolResult: { details: { delegations: [
      { delegationId: "d1", agent: "explorer", status: "running" },
      { delegationId: "d2", agent: "explorer", status: "running" },
    ] } }, status: "complete" },
  rejectedRow(resume),
  { id: "child-a2", role: "assistant", content: LATER_ROW, createdAt: iso(9),
    parentToolCallId: "tc-orig-1", agentName: "explorer", status: "complete", usage: usage("op-a2") },
]);

let sessionMessages = [];
let sessionRunning = false;

const seed = (resume) => {
  sessionMessages = messagesFor(resume);
  store.setState({
    activeSessionId: "s1",
    sessions: [{ id: "s1", title: "fixture", projectPath: "/tmp/fixture", source: "local" }],
    messages: sessionMessages,
    retainedTranscripts: {},
    transcriptViews: {},
    sessionHistory: {},
    subagentHistory: {},
    agentStatuses: {},
    runningSessions: { s1: true },
    isRunning: true,
    pendingPermissions: {},
    pendingAsks: {},
    pendingPlans: {},
    planCheckpoints: {},
    planningStates: {},
    sessionsMeta: undefined,
    settings: { enterToSend: true },
    page: "chat",
    workspace: { path: "/tmp/fixture" },
  });
  sessionRunning = true;
  calls.length = 0;
};

let view = null;
const mount = () => {
  if (view) view.unmount();
  view = createRoot(document.getElementById("root"));
  flushSync(() => view.render(React.createElement(React.StrictMode, null,
    React.createElement("div", null,
      React.createElement(SubagentDock, { sessionId: "s1" }),
      React.createElement(SlotSessionProvider, { sessionId: "s1" },
        React.createElement(SubagentTranscriptTab, { delegationId: "d1" }))))));
};
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 15000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const check = (value, message) => { if (!value) throw new Error(message); };
const tab = () => document.querySelector('[data-testid="subagent-transcript-tab"]');
const headerStatus = () => document.querySelector('[data-testid="subagent-panel-header"] [role="status"]')?.textContent?.trim() ?? null;
const dockRows = () => [...document.querySelectorAll(".subagent-dock-list [role=\"listitem\"]")];
const dockTitles = () => dockRows().map((row) => row.querySelector(".subagent-dock-row-title")?.textContent?.trim() ?? "");
const userTexts = () => [...(tab()?.querySelectorAll(".message-row.user .message-user-text") ?? [])].map((node) => node.textContent.trim());
const tabStopButton = () => tab()?.querySelector(".subagent-transcript-composer-controls .stop-btn");
const stopCalls = () => calls.filter((call) => call.channel === IPC.invoke.agentStopSubagents);

window.subagentRejectedDockProbe = async (resume) => {
  seed(resume);
  mount();
  await until(() => tab() && dockRows().length > 0, "tab and dock did not mount for resume " + resume);

  // Both live children stay in the dock: the rejected resume adds no entry and
  // removes none.
  await until(() => dockRows().length === 2, "dock does not list both running children: " + JSON.stringify(dockTitles()));
  const titles = dockTitles();
  check(titles.some((title) => title.includes("Research X")), "d1 missing from dock: " + JSON.stringify(titles));
  check(titles.some((title) => title.includes("Manifestor fix")), "d2 missing from dock: " + JSON.stringify(titles));

  // The open tab stays on the original run: Running header, original prompt
  // exactly once, later child row present, rejected brief never a user row.
  check(headerStatus() === "Running", "tab header is not Running: " + JSON.stringify(headerStatus()));
  const texts = userTexts();
  check(texts.filter((text) => text === ORIG).length === 1, "original prompt not rendered exactly once: " + JSON.stringify(texts));
  check(!texts.some((text) => text.includes("Supplemental brief")), "rejected brief rendered as a user row: " + JSON.stringify(texts));
  const later = tab()?.textContent ?? "";
  check(later.includes(LATER_ROW), "later child row missing from the tab");

  // Stopping the d1 dock row targets d1, never the failed request's call id.
  check(tabStopButton(), "tab stop action missing while d1 runs");
  const d1Row = dockRows().find((row) =>
    row.querySelector(".subagent-dock-row-title")?.textContent?.includes("Research X"));
  check(d1Row, "d1 dock row missing");
  const stopButton = d1Row.querySelector(".stop-btn");
  check(stopButton && !stopButton.disabled, "d1 dock row has no usable stop");
  flushSync(() => stopButton.click());
  await until(() => stopCalls().length > 0, "stop click issued no request");
  const stopInput = stopCalls().at(-1).input;
  check(JSON.stringify(stopInput?.delegationIds) === JSON.stringify(["d1"]),
    "stop did not target d1: " + JSON.stringify(stopInput));

  return { passed: true, resume, dockTitles: titles, header: headerStatus(), stopInput };
};
`;

test("a rejected Task(resume) keeps both live children in the dock and stop on d1", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "subagent-rejected-dock-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      loader: { ".woff": "empty", ".woff2": "empty", ".ttf": "empty", ".css": "empty", ".svg": "empty", ".png": "empty" },
    });
    await writeFile(join(temp, "styles.css"), (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.webContents.on("console-message", (_event, _level, message) => console.log("RENDERER " + message));
    for (const resume of ["d1", "tc-orig-1"]) {
      console.log("REJECTED_DOCK_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.subagentRejectedDockProbe(" + JSON.stringify(resume) + ")")));
    }
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    // Both resume spellings (delegation id and bare call id) keep the dock at
    // two entries and route stop to d1. Title membership is asserted inside
    // the probe; here the passing probe plus the stop target carry the regression.
    assert.match(output, /REJECTED_DOCK_PROBE \{"passed":true,"resume":"d1"/);
    assert.match(output, /"stopInput":\{"sessionId":"s1","delegationIds":\["d1"\]\}/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
