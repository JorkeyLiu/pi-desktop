import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { loadStyles } from "./helpers/styles.mjs";

/**
 * Direct continuations never append cards to the main chat.
 *
 * The user path under test: a delegation is dispatched from the main chat and
 * stopped there, then the user continues that work twice from its own tab. The
 * runtime records each continuation as a `Task` row marked `source: "user"`,
 * which the parent's model context and this projection both exclude — the main
 * chat keeps the one card the work was dispatched from, with the state that run
 * ended in, and adds no card, activity group or turn.
 *
 * The harness mounts the production main-chat transcript component and the real
 * app store in an isolated Electron window, then drives the backend event
 * contract the host emits for a detached continuation. Only `window.piDesktop`
 * (the process boundary) is a stub.
 */
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useSyncExternalStore } from "react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { subagentChainLatestDelegationId } from "../../apps/desktop/src/lib/subagent-chain";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const t = (key, options) => i18n.t(key, options);

const listeners = new Map();
const emit = (channel, payload) => {
  for (const callback of listeners.get(channel) ?? []) callback(payload);
};

window.piDesktop = { platform: "darwin", channels: IPC,
  on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel)?.delete(callback);
  },
  async invoke(channel) {
    if (channel === IPC.invoke.sessionList) {
      return { ok: true, data: { sessions: [{ id: "s1", title: "fixture", projectPath: "/tmp/fixture", createdAt: "2026-05-01T09:00:00.000Z", updatedAt: "2026-05-01T10:00:00.000Z", source: "local" }] } };
    }
    if (channel === IPC.invoke.agentGetQueuedPrompts) return { ok: true, data: { entries: [] } };
    if (channel === IPC.invoke.agentGetStatus) return { ok: true, data: { sessionId: "s1", isRunning: false, pendingToolConfirmations: 0 } };
    return { ok: true, data: null };
  },
};

const store = useAppStore;
window.piDesktop.on(IPC.event.agentMessage, (envelope) => store.getState().handleAgentEvent(envelope));

const iso = (seconds) => new Date(Date.parse("2026-05-01T10:00:00.000Z") + seconds * 1000).toISOString();
const envelope = (event, turnId, extra = {}) => ({ sessionId: "s1", turnId, ts: Date.now(), event, ...extra });

const taskRow = ({ callId, delegationId, status, taskArgs = { agent: "explorer", task: "Investigate the cache layer." }, at = 2, turnId = "turn-parent" }) => {
  const result = { content: [{ type: "text", text: "Delegation " + delegationId + ": " + status + "." }],
    details: { delegationId, agent: "explorer", status, startedAt: Date.parse("2026-05-01T10:00:00Z"),
      modelId: "test-model", thinkingLevel: "high", turns: 1, toolCalls: 2, executionTurnId: turnId } };
  return { id: callId, role: "tool", content: JSON.stringify(result), createdAt: iso(at),
    toolCallId: callId, toolName: "Task", toolArgs: taskArgs, toolStatus: "success", toolResult: result,
    toolCompletedAt: iso(at + 1), toolDurationMs: 1000, status: "complete", isError: false };
};

// The conversation as the host persists it after the user stopped the run:
// one dispatch card that ended stopped, and the reply that reported it.
const parentMessages = [
  { id: "u1", role: "user", content: "Investigate the cache layer.", createdAt: iso(0) },
  { id: "a1", role: "assistant", content: "Delegating this now.", createdAt: iso(1), status: "complete" },
  taskRow({ callId: "call-task-1", delegationId: "d1", status: "stopped" }),
  { id: "child-a1", role: "assistant", content: "Reading the cache module.", createdAt: iso(4),
    parentToolCallId: "call-task-1", agentName: "explorer", status: "complete" },
  { id: "a2", role: "assistant", content: "The delegate was stopped.", createdAt: iso(6), status: "complete" },
];

const continuationMarker = ({ callId, delegationId, resume, text, status = "running", turnId, extra = {} }) => {
  const result = { content: [{ type: "text", text: "Delegation continued by the user." }],
    details: { delegationId, agent: "explorer", status, resumedFrom: resume, executionTurnId: turnId, ...extra } };
  return { id: callId, role: "tool", content: JSON.stringify(result), createdAt: iso(10),
    toolCallId: callId, toolName: "Task",
    toolArgs: { agent: "explorer", task: text, resume, source: "user" },
    toolStatus: "success", toolResult: result, toolCompletedAt: iso(10), toolDurationMs: 0,
    status: "complete", isError: false, steering: true };
};
const continuationUserRow = ({ callId, messageId, text }) => ({ id: messageId, role: "user", content: text,
  createdAt: iso(10), status: "complete", steering: true, parentToolCallId: callId, agentName: "explorer" });

// The exact emission order runtime.continueSubagent produces for a detached
// continuation: the marker pair, then the child user row, under its own turn.
const continuationEnvelopes = ({ callId, messageId, delegationId, resume, text, turnId }) => {
  const marker = continuationMarker({ callId, delegationId, resume, text, turnId });
  const child = continuationUserRow({ callId, messageId, text });
  return [
    envelope({ type: "message_start", message: marker }, turnId),
    envelope({ type: "message_end", message: marker }, turnId),
    envelope({ type: "message_start", message: child }, turnId, { parentToolCallId: callId, agentName: "explorer" }),
    envelope({ type: "message_end", message: child }, turnId, { parentToolCallId: callId, agentName: "explorer" }),
  ];
};

const seed = () => {
  store.setState({
    activeSessionId: "s1",
    sessions: [{ id: "s1", title: "fixture", projectPath: "/tmp/fixture", source: "local" }],
    messages: parentMessages,
    retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {},
    agentStatuses: {}, runningSessions: {}, isRunning: false,
    pendingPermissions: {}, pendingAsks: {}, pendingPlans: {}, planCheckpoints: {}, planningStates: {},
    workPanelTabs: [], activeWorkPanelTabId: undefined, workPanelOpen: false,
    settings: { enterToSend: true, thinkingDisplayMode: "detailed" },
    page: "chat",
    workspace: { path: "/tmp/fixture" },
  });
};

// The production pane reads the live store projection; this mount does the same.
function App() {
  const messages = useSyncExternalStore(store.subscribe, () => store.getState().messages);
  const running = useSyncExternalStore(store.subscribe, () => store.getState().runningSessions.s1 === true);
  return React.createElement(ChatTranscript, { sessionId: "s1", messages, isRunning: running });
}

const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const check = (value, message) => { if (!value) throw new Error(message); };
const deliver = async (envelopes) => {
  for (const item of envelopes) { emit(IPC.event.agentMessage, item); await frame(); }
};

const cards = () => [...document.querySelectorAll(".subagent-task")];
const cardState = () => cards().map((card) => ({
  id: card.getAttribute("data-message-id"),
  outcome: card.getAttribute("data-outcome"),
  state: card.querySelector(".subagent-task-status")?.textContent.trim() ?? null,
  title: card.querySelector(".subagent-task-title")?.textContent.trim() ?? null,
}));
const turns = () => document.querySelectorAll(".assistant-turn").length;
const processGroups = () => document.querySelectorAll(".turn-process").length;
const toolCountLabel = () => document.querySelector(".tool-activity-count")?.textContent.trim() ?? null;
const dump = () => JSON.stringify({ cards: cardState(), turns: turns(), groups: processGroups(), count: toolCountLabel() });

window.mainChatContinuationProbe = async () => {
  seed();
  let view;
  view = createRoot(document.getElementById("root"));
  flushSync(() => view.render(React.createElement(App)));
  await until(() => cards().length > 0, "the dispatch card never rendered");

  const before = {
    cards: cardState(), turns: turns(), groups: processGroups(), count: toolCountLabel(),
  };
  check(before.cards.length === 1, "seeded dispatch did not render exactly one card: " + dump());
  check(before.cards[0].id === "call-task-1", "the card is not the dispatch: " + dump());
  check(before.cards[0].state.startsWith(t("chat.subagentStatus.stopped")),
    "the card does not state the state its run ended in: " + dump());
  check(before.count === t("chat.processTools", { count: 1 }),
    "the process line does not count one tool: " + dump());

  // First continuation, from the delegation's own tab.
  const FIRST = "Continuing after the stop: check the eviction path.";
  await deliver(continuationEnvelopes({ callId: "call-continue-1", messageId: "child-u1",
    delegationId: "d2", resume: "d1", text: FIRST, turnId: "turn-exec-1" }));
  check(cards().length === 1, "the first continuation added a main-chat card: " + dump());
  check(JSON.stringify(cardState()) === JSON.stringify(before.cards),
    "the dispatch card stopped reporting its own run: " + dump());
  check(turns() === before.turns, "the first continuation added an assistant turn: " + dump());
  check(processGroups() === before.groups, "the first continuation added an activity group: " + dump());
  check(toolCountLabel() === before.count, "the first continuation inflated the tool count: " + dump());

  // Terminal snapshot of that run, then a second continuation.
  await deliver([
    envelope({ type: "message_end", message: continuationMarker({ callId: "call-continue-1",
      delegationId: "d2", resume: "d1", text: FIRST, status: "completed", turnId: "turn-exec-1",
      extra: { turns: 2, toolCalls: 1 } }) }, "turn-exec-1"),
    envelope({ type: "agent_end", messageIds: [] }, "turn-exec-1"),
  ]);
  const SECOND = "Second follow-up after the stop.";
  await deliver(continuationEnvelopes({ callId: "call-continue-2", messageId: "child-u2",
    delegationId: "d3", resume: "d2", text: SECOND, turnId: "turn-exec-2" }));
  await deliver([
    envelope({ type: "message_end", message: continuationMarker({ callId: "call-continue-2",
      delegationId: "d3", resume: "d2", text: SECOND, status: "stopped", turnId: "turn-exec-2",
      extra: { turns: 3, toolCalls: 2 } }) }, "turn-exec-2"),
    envelope({ type: "error", error: { code: "TURN_ABORTED", message: "Delegation ended as stopped.", retriable: false } }, "turn-exec-2"),
  ]);

  check(cards().length === 1, "the second continuation added a main-chat card: " + dump());
  check(JSON.stringify(cardState()) === JSON.stringify(before.cards),
    "the second continuation rewrote the dispatch card: " + dump());
  check(turns() === before.turns && processGroups() === before.groups,
    "the second continuation added a turn or an activity group: " + dump());
  check(toolCountLabel() === before.count, "the second continuation inflated the tool count: " + dump());
  // No empty group and no marker row leaked into the transcript as a tool row.
  for (const group of document.querySelectorAll(".turn-process-body")) {
    check(group.textContent.trim().length > 0, "an empty activity group is rendered");
  }

  // The rows are ledger, not display: the session still carries them, and the
  // chain still names its newest run, which the dispatch card's tab opens.
  const messages = store.getState().messages;
  const markers = messages.filter((message) =>
    message.role === "tool" && message.toolName === "Task" &&
    message.toolArgs?.source === "user" && typeof message.toolArgs?.resume === "string");
  check(markers.length === 2, "the continuation rows left the session messages: " + JSON.stringify(messages.map((m) => m.id)));
  check(subagentChainLatestDelegationId(messages, "d1") === "d3",
    "the chain no longer names its newest run");

  // Opening the dispatch card still opens that chain, not a stale segment.
  const button = cards()[0].querySelector("button.subagent-task-card");
  check(button && !button.disabled, "the dispatch card cannot be opened");
  flushSync(() => button.click());
  await frame();
  const activeTab = store.getState().activeWorkPanelTabId;
  check(activeTab === "subagent:d1", "the dispatch card opened the wrong tab: " + String(activeTab));

  flushSync(() => view.unmount());
  return { passed: true };
};
`;

test("a continued subagent chain never appends cards to the main chat", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "main-chat-continuation-"));
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
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.webContents.on("console-message", (_event, _level, message) => console.log("RENDERER " + message));
    console.log("MAIN_CHAT_CONTINUATION_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.mainChatContinuationProbe()")));
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
    assert.match(output, /MAIN_CHAT_CONTINUATION_PROBE \{"passed":true\}/, output.slice(-6000));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
