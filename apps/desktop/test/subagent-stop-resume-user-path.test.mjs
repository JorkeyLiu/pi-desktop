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
 * Stopped -> continued subagent chain, on the real renderer path.
 *
 * The user path under test: a `Task` delegation runs, the user stops it from
 * the main chat, then types a follow-up in the SAME delegation tab. From there
 * the tab must follow the chain's newest real run: the follow-up renders once,
 * the panel keeps its identity and draft while tool progress lands, the live
 * run exposes a working Stop for its own delegation id, and when the run
 * settles the composer returns to continue mode so the session is usable again.
 *
 * The harness mounts the real `SubagentTranscriptTab` and the real app store in
 * an isolated Electron window and drives the backend event contract
 * (`IPC.event.agentMessage`) that the host emits for a detached continuation,
 * including the double emission turn-events.ts produces for each tool row and
 * the whole-`Task`-row progress snapshot. Only `window.piDesktop` (the process
 * boundary) is a stub.
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
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const t = (key, options) => i18n.t(key, options);

const listeners = new Map();
const calls = [];
const emit = (channel, payload) => {
  for (const callback of listeners.get(channel) ?? []) callback(payload);
};
let continueCounter = 0;
let steerCounter = 0;
let sessionMessages = [];
let sessionRunning = false;
// The continue RPC is the process boundary the probe controls. A real send is
// in flight while the runtime's own chain-advance events already landed, and a
// rejected send must keep the text for retry.
let continueMode = "immediate";
let pendingContinue = null;

window.piDesktop = { platform: "darwin", channels: IPC,
  on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel)?.delete(callback);
  },
  async invoke(channel, input) {
    calls.push({ channel, input });
    let data = null;
    if (channel === IPC.invoke.agentContinueSubagent) {
      continueCounter += 1;
      // The host opens a child-only execution turn and returns its identity.
      const accepted = { accepted: true, delegationId: "d" + (continueCounter + 1), turnId: "turn-exec-" + continueCounter, delivery: "user" };
      if (continueMode === "deferred") {
        // Hold the reply open so the caller stays mid-dispatch while the
        // continuation's own chain events land, like a real accepted send.
        return new Promise((resolve) => {
          pendingContinue = (outcome) => resolve(outcome === "ok"
            ? { ok: true, data: accepted }
            : { ok: false, error: { code: "TURN_NOT_FOUND", message: outcome } });
        });
      }
      if (continueMode === "reject") {
        return { ok: false, error: { code: "TURN_NOT_FOUND", message: "Unknown delegation." } };
      }
      data = accepted;
    } else if (channel === IPC.invoke.agentSteerSubagent) {
      steerCounter += 1;
      data = { accepted: true, delegationId: input?.delegationId, turnId: input?.expectedTurnId };
    } else if (channel === IPC.invoke.agentStopSubagents) {
      data = { content: [{ type: "text", text: "stopping" }], details: { stopped: [], stopPending: (input?.delegationIds ?? []).map((id) => ({ delegationId: id, status: "running" })) } };
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
// The real app subscribes the store's own event reducer to the host stream.
window.piDesktop.on(IPC.event.agentMessage, (envelope) => store.getState().handleAgentEvent(envelope));

const iso = (seconds) => new Date(Date.parse("2026-05-01T10:00:00.000Z") + seconds * 1000).toISOString();
const envelope = (event, turnId, extra = {}) => ({ sessionId: "s1", turnId, ts: Date.now(), event, ...extra });

const taskRow = ({ id, callId, delegationId, status, extra = {}, taskArgs = { agent: "explorer", task: "Investigate the cache layer." }, at = 2, turnId = "turn-parent" }) => {
  const result = { content: [{ type: "text", text: "Delegation " + delegationId + ": " + status + "." }],
    details: { delegationId, agent: "explorer", status, startedAt: Date.parse("2026-05-01T10:00:00Z"),
      modelId: "test-model", thinkingLevel: "high", turns: 1, toolCalls: 2, ...(turnId ? { executionTurnId: turnId } : {}), ...extra } };
  return { id, role: "tool", content: JSON.stringify(result), createdAt: iso(at),
    toolCallId: callId, toolName: "Task", toolArgs: taskArgs, toolStatus: "success", toolResult: result,
    toolCompletedAt: iso(at + 1), toolDurationMs: 1000, status: "complete", isError: false };
};

const parentMessages = [
  { id: "u1", role: "user", content: "Investigate the cache layer.", createdAt: iso(0) },
  { id: "a1", role: "assistant", content: "Delegating this now.", createdAt: iso(1), status: "complete" },
  // The stopped first run of the chain, refreshed by the runtime to its
  // terminal snapshot after the user pressed Stop in the main chat.
  // The stopped first run reported the occupancy of its own window; the
  // continuation's marker carries no such report of its own.
  taskRow({ id: "call-task-1", callId: "call-task-1", delegationId: "d1", status: "stopped", at: 2, extra: { contextTokens: 12000 } }),
  { id: "child-a1", role: "assistant", content: "Reading the cache module.", createdAt: iso(4), parentToolCallId: "call-task-1", agentName: "explorer", status: "complete" },
  { id: "child-t1", role: "tool", content: JSON.stringify({ paths: ["src/cache.ts"] }), createdAt: iso(5),
    toolCallId: "child-t1", toolName: "Read", toolArgs: { path: "src/cache.ts" }, toolStatus: "success",
    toolResult: { paths: ["src/cache.ts"] }, status: "complete", parentToolCallId: "call-task-1", agentName: "explorer" },
  { id: "a2", role: "assistant", content: "The delegate was stopped.", createdAt: iso(6), status: "complete" },
];

const seed = () => {
  continueMode = "immediate";
  pendingContinue = null;
  continueCounter = 0;
  steerCounter = 0;
  sessionMessages = parentMessages;
  store.setState({
    activeSessionId: "s1",
    sessions: [{ id: "s1", title: "fixture", projectPath: "/tmp/fixture", source: "local" }],
    messages: parentMessages,
    retainedTranscripts: {},
    transcriptViews: {},
    sessionHistory: {},
    agentStatuses: {},
    runningSessions: {},
    isRunning: false,
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
  sessionRunning = false;
};

let view;
const mount = (delegationId) => {
  view = createRoot(document.getElementById("root"));
  flushSync(() => view.render(React.createElement(React.StrictMode, null,
    React.createElement(SlotSessionProvider, { sessionId: "s1" },
      React.createElement(SubagentTranscriptTab, { delegationId })))));
};
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const check = (value, message) => { if (!value) throw new Error(message); };
const tab = () => document.querySelector('[data-testid="subagent-transcript-tab"]');
const header = () => document.querySelector('[data-testid="subagent-panel-header"] [role="status"]');
// The header status span also carries the delivery-owner suffix while a run is
// live; the run state is the part before it.
const statusText = () => (header()?.textContent?.trim() ?? "").split("·")[0].trim();
// The header's own Context slot: the figure the reader sees under the state.
const contextMetric = () =>
  tab()?.querySelector('[data-testid="subagent-metrics-context"]')?.textContent?.trim() ?? null;
// The panel composer is the shared contenteditable: the draft is its text with
// BR line breaks mapped back to "\n", and "disabled" is the editor refusing
// input (aria-readonly / contentEditable="false").
const editor = () => tab()?.querySelector('[data-testid="subagent-panel-footer"] [role="textbox"]');
const readDraft = (node) =>
  [...node.childNodes].map((child) => (child.nodeName === "BR" ? "\n" : child.textContent ?? "")).join("");
const textarea = () => {
  const node = editor();
  if (!node) return null;
  return {
    value: readDraft(node),
    disabled: node.getAttribute("contenteditable") === "false",
    placeholder: node.getAttribute("aria-placeholder"),
  };
};
const controls = () => [...(tab()?.querySelectorAll(".subagent-transcript-composer-controls button") ?? [])];
const stopButton = () => controls().find((node) => node.className.includes("stop-btn"));
const sendButton = () => controls().find((node) => node.className.includes("send-btn"));
const userTexts = () => [...(tab()?.querySelectorAll(".message-row.user .message-user-text") ?? [])].map((node) => node.textContent.trim());
const composerSignature = () => {
  const field = textarea();
  const stop = stopButton();
  const send = sendButton();
  return {
    field: field ? "editor" : "none",
    disabled: field ? field.disabled : null,
    placeholder: field?.placeholder ?? null,
    draft: field ? field.value : null,
    action: stop ? "stop" : send ? "send" : "none",
    actionDisabled: stop ? stop.disabled : send ? send.disabled : null,
  };
};
const type = async (value) => {
  const node = editor();
  check(node, "composer editor missing");
  flushSync(() => {
    node.textContent = value;
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
  await frame();
};
const pushDraft = async (value) => {
  const node = editor();
  node.textContent = value;
  node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  await frame();
};

const continuationMarker = ({ callId, delegationId, text, status = "running", turnId, extra = {} }) => {
  const result = { content: [{ type: "text", text: "Delegation continued by the user." }],
    details: { delegationId, agent: "explorer", status, resumedFrom: "d1", ...(turnId ? { executionTurnId: turnId } : {}), ...extra } };
  return { id: callId, role: "tool", content: JSON.stringify(result), createdAt: iso(10),
    toolCallId: callId, toolName: "Task",
    toolArgs: { agent: "explorer", task: text, resume: "d1", source: "user" },
    toolStatus: "success", toolResult: result, toolCompletedAt: iso(10), toolDurationMs: 0,
    status: "complete", isError: false, steering: true };
};
const continuationUserRow = ({ callId, messageId, text }) => ({
  id: messageId, role: "user", content: text, createdAt: iso(10), status: "complete",
  steering: true, parentToolCallId: callId, agentName: "explorer" });

// The exact emission order runtime.continueSubagent produces for a detached
// continuation: marker pair, then the child user row, both under the adopted
// execution turn.
const continuationEnvelopes = ({ callId, messageId, delegationId, text, turnId }) => {
  const marker = continuationMarker({ callId, delegationId, text, turnId });
  const child = continuationUserRow({ callId, messageId, text });
  return [
    envelope({ type: "message_start", message: marker }, turnId),
    envelope({ type: "message_end", message: marker }, turnId),
    envelope({ type: "message_start", message: child }, turnId, { parentToolCallId: callId, agentName: "explorer" }),
    envelope({ type: "message_end", message: child }, turnId, { parentToolCallId: callId, agentName: "explorer" }),
  ];
};
// One delegate tool call: the tool pair, the persisted row replay turn-events
// emits, and the whole-Task-row progress snapshot.
const toolCallEnvelopes = ({ callId, turnId, toolCallId, index, delegationId, text }) => {
  const result = { paths: ["src/cache-" + index + ".ts"] };
  const row = { id: toolCallId, role: "tool", content: JSON.stringify(result), createdAt: iso(11),
    toolCallId, toolName: "Read", toolArgs: { path: "src/cache-" + index + ".ts" }, toolStatus: "success",
    toolResult: result, toolCompletedAt: iso(12), toolDurationMs: 500, status: "complete",
    parentToolCallId: callId, agentName: "explorer" };
  const snapshot = continuationMarker({ callId, delegationId, text, turnId,
    extra: { turns: index + 1, toolCalls: index + 1, lastToolName: "Read" } });
  return [
    envelope({ type: "tool_start", toolCallId, toolName: "Read", args: { path: "src/cache-" + index + ".ts" } }, turnId,
      { parentToolCallId: callId, agentName: "explorer" }),
    envelope({ type: "tool_end", toolCallId, toolName: "Read", result, isError: false }, turnId,
      { parentToolCallId: callId, agentName: "explorer" }),
    envelope({ type: "message_end", message: row }, turnId, { parentToolCallId: callId, agentName: "explorer" }),
    envelope({ type: "message_end", message: snapshot }, turnId),
  ];
};
const deliver = async (envelopes) => {
  for (const item of envelopes) {
    emit(IPC.event.agentMessage, item);
    await frame();
  }
};

const tabRoot = () => document.querySelector('[data-testid="subagent-transcript-tab"]');
const taskRows = () => store.getState().messages.filter((message) => message.role === "tool" && message.toolName === "Task");

const send = async (value) => {
  await type(value);
  const button = sendButton();
  check(button, "send action missing");
  check(!button.disabled, "send action disabled for " + JSON.stringify(composerSignature()));
  flushSync(() => button.click());
  await frame();
};

window.subagentStopResumeProbe = async () => {
  seed();
  mount("d1");
  await until(() => textarea(), "tab did not mount");

  // While the stopped chain is settled the tab is the continue surface.
  check(composerSignature().field === "editor" && !textarea().disabled,
    "settled original tab input is not usable: " + JSON.stringify(composerSignature()));
  check(userTexts().filter((text) => text === "Investigate the cache layer.").length === 1,
    "original run prompt is not rendered exactly once: " + JSON.stringify(userTexts()));

  const FOLLOWUP = "Continuing after the stop: check the eviction path.";
  const continueBefore = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).length;
  await send(FOLLOWUP);
  await until(() => calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).length > continueBefore,
    "continuing the chain issued no request");
  const continueCall = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).at(-1).input;
  check(continueCall.delegationId === "d1", "continuation did not target the chain the tab shows: " + JSON.stringify(continueCall));

  const turnId = "turn-exec-t1";
  // The Task marker keeps the real Task(resume) invocation id; the child user
  // row carries the renderer's idempotency id as its own message id.
  const callId = "call-continue-t1";
  await deliver(continuationEnvelopes({ callId, messageId: continueCall.messageId, delegationId: "d2", text: FOLLOWUP, turnId }));
  const dump = () => JSON.stringify({
    rows: store.getState().messages.map((message) => [message.id, message.role, message.toolName, message.parentToolCallId, message.content.slice(0, 30)]),
    users: userTexts(), status: statusText(), composer: composerSignature(),
  });
  // The follow-up is one user message, not the Task marker plus a child echo.
  check(userTexts().filter((text) => text === FOLLOWUP).length === 1,
    "follow-up rendered more than once: " + dump());
  const live = composerSignature();
  check(live.field === "editor" && live.disabled === false,
    "live continued run leaves the input disabled: " + JSON.stringify(live));
  check(statusText() === t("chat.subagentStatus.running"),
    "continued run is not reported running: " + JSON.stringify(statusText()));
  check(live.action === "stop",
    "live continued run offers no stop action: " + JSON.stringify(live));

  // Tool progress must not rebuild the panel, flip its state, or eat the draft.
  await pushDraft("draft typed while tools run");
  const rootBefore = tabRoot();
  const draftBefore = textarea().value;
  for (let index = 0; index < 4; index += 1) {
    await deliver(toolCallEnvelopes({ callId, turnId, toolCallId: "child-tool-" + index, index, delegationId: "d2", text: FOLLOWUP }));
    check(tabRoot() === rootBefore, "tool progress rebuilt the panel on event " + index);
    check(textarea()?.value === draftBefore, "tool progress dropped the draft on event " + index);
    const signature = composerSignature();
    check(signature.disabled === false, "tool progress disabled the input on event " + index + ": " + JSON.stringify(signature));
    check(statusText() === t("chat.subagentStatus.running"),
      "tool progress changed the run state on event " + index + ": " + JSON.stringify(statusText()));
    check(userTexts().filter((text) => text === FOLLOWUP).length === 1,
      "tool progress duplicated the follow-up on event " + index + ": " + JSON.stringify(userTexts()));
    check(taskRows().filter((message) => message.toolCallId === callId).length === 1,
      "tool progress changed the run identity on event " + index);
  }
  await pushDraft("");
  check(stopButton(), "stop disappeared after typing/clearing a draft");

  // Close and reopen the tab while the run is live: a real unmount/remount of
  // the production component, with no parent turn id in store state. A
  // detached continuation publishes no status event, and the previous terminal
  // cleared the entry, so nothing but the run's own persisted Task row carries
  // the execution turn.
  flushSync(() => view.unmount());
  check(store.getState().agentStatuses.s1 === undefined,
    "the reopened tab must not be rescued by a parent turn id: " + JSON.stringify(store.getState().agentStatuses));
  mount("d1");
  await until(() => textarea(), "reopened tab did not mount");
  const reopened = composerSignature();
  check(statusText() === t("chat.subagentStatus.running"),
    "reopened tab lost the live run: " + JSON.stringify(statusText()));
  check(reopened.field === "editor" && reopened.disabled === false,
    "reopened tab disabled the input of a live continued run: " + JSON.stringify(reopened));
  check(reopened.action === "stop", "reopened tab offers no stop action: " + JSON.stringify(reopened));
  const rootAfterRemount = tabRoot();
  check(userTexts().filter((text) => text === FOLLOWUP).length === 1,
    "reopened tab duplicated the follow-up: " + JSON.stringify(userTexts()));

  // A steer typed after the reopen reaches the same run and names its own
  // execution turn — never a parent turn.
  const steerBefore = calls.filter((call) => call.channel === IPC.invoke.agentSteerSubagent).length;
  await send("Steer the reopened tab.");
  await until(() => calls.filter((call) => call.channel === IPC.invoke.agentSteerSubagent).length > steerBefore,
    "reopened tab issued no steer");
  const steerCall = calls.filter((call) => call.channel === IPC.invoke.agentSteerSubagent).at(-1).input;
  check(steerCall.sessionId === "s1" && steerCall.delegationId === "d2",
    "steer did not target the chain-latest run: " + JSON.stringify(steerCall));
  check(steerCall.expectedTurnId === turnId,
    "steer did not name the run's execution turn: " + JSON.stringify(steerCall));
  check(steerCall.content === "Steer the reopened tab.", "steer lost its text: " + JSON.stringify(steerCall));
  // The dispatch is a store-level effect only; the panel survives it.
  await deliver(toolCallEnvelopes({ callId, turnId, toolCallId: "child-tool-after-remount", index: 5, delegationId: "d2", text: FOLLOWUP }));
  check(tabRoot() === rootAfterRemount, "a steer rebuilt the panel");
  check(composerSignature().disabled === false, "a steer left the reopened input disabled");

  // Stop targets the run the tab currently shows.
  const stopBefore = calls.filter((call) => call.channel === IPC.invoke.agentStopSubagents).length;
  flushSync(() => stopButton().click());
  await until(() => calls.filter((call) => call.channel === IPC.invoke.agentStopSubagents).length > stopBefore,
    "stop issued no request");
  const stopCall = calls.filter((call) => call.channel === IPC.invoke.agentStopSubagents).at(-1).input;
  check(stopCall.sessionId === "s1", "stop lost its session: " + JSON.stringify(stopCall));
  check(JSON.stringify(stopCall.delegationIds) === JSON.stringify(["d2"]),
    "stop did not target the live run: " + JSON.stringify(stopCall));

  // The runtime settles the stopped run: terminal Task snapshot, then the
  // detached execution turn's own terminal event.
  await deliver([
    envelope({ type: "message_end", message: continuationMarker({ callId, delegationId: "d2", text: FOLLOWUP, status: "stopped", turnId, extra: { turns: 4, toolCalls: 4 } }) }, turnId),
    envelope({ type: "error", error: { code: "TURN_ABORTED", message: "Delegation ended as stopped.", retriable: false } }, turnId),
  ]);
  const settled = composerSignature();
  check(settled.field === "editor" && settled.disabled === false,
    "settled continuation leaves the input disabled: " + JSON.stringify(settled));
  check(settled.action === "send", "settled continuation does not offer a send action: " + JSON.stringify(settled));
  check(statusText() === t("chat.subagentStatus.stopped"),
    "stopped continuation is not reported as stopped: " + JSON.stringify(statusText()));
  check(store.getState().runningSessions.s1 !== true && store.getState().isRunning === false,
    "stopped continuation leaked a running session");
  const statuses = store.getState().agentStatuses;
  check(!statuses.s1 || !statuses.s1.currentTurnId, "stopped continuation leaked its execution turn");

  // The same tab continues the chain again: no new card is required.
  const secondBefore = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).length;
  await send("Second follow-up after the stop.");
  await until(() => calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).length > secondBefore,
    "the settled original tab could not continue the chain again");
  const secondCall = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).at(-1).input;
  check(secondCall.delegationId === "d2", "the second continuation targeted a stale chain segment: " + JSON.stringify(secondCall));

  // The main chat is usable again once the child execution turn released.
  check(store.getState().runningSessions.s1 !== true, "main chat session stayed busy after the run settled");

  flushSync(() => view.unmount());
  return { passed: true };
};

window.subagentCreatingTabProbe = async () => {
  // A delegation card is clickable the moment the model emits its Task call,
  // before the run's own result lands. The tab then follows the same run as its
  // identity arrives instead of going blank and needing a second card.
  seed();
  const creating = { id: "call-create-1", role: "tool", content: "", createdAt: iso(2),
    toolCallId: "call-create-1", toolName: "Task",
    toolArgs: { agent: "explorer", task: "Map the cache invalidation path." },
    toolStatus: "running", status: "streaming" };
  store.setState({ messages: [...parentMessages.slice(0, 2), creating],
    runningSessions: { s1: true }, isRunning: true, agentStatuses: { s1: { currentTurnId: "turn-parent" } } });
  mount("call-create-1");
  await until(() => textarea(), "creating tab did not mount");
  check(userTexts().filter((text) => text === "Map the cache invalidation path.").length === 1,
    "creating tab lost its own prompt: " + JSON.stringify(userTexts()));
  const rootBeforeIdentity = tabRoot();
  // The runtime's Task result lands: the row now names the run.
  // The refreshed row keeps the call's own arguments, like the runtime's.
  const createArgs = { agent: "explorer", task: "Map the cache invalidation path." };
  const landed = taskRow({ id: "call-create-1", callId: "call-create-1", delegationId: "d7", status: "running", at: 2, taskArgs: createArgs });
  await deliver([envelope({ type: "message_end", message: landed }, "turn-parent")]);
  check(tabRoot() === rootBeforeIdentity, "arriving Task identity rebuilt the tab");
  check(statusText() === t("chat.subagentStatus.running"),
    "the tab lost the run when its identity arrived: " + JSON.stringify(statusText()));
  check(userTexts().filter((text) => text === "Map the cache invalidation path.").length === 1,
    "the tab lost its prompt when the identity arrived: " + JSON.stringify(userTexts()));
  check(composerSignature().action === "stop",
    "the live run has no stop after its identity arrived: " + JSON.stringify(composerSignature()));
  // Settling keeps the same tab operable for the next continuation.
  await deliver([envelope({ type: "message_end", message: taskRow({ id: "call-create-1", callId: "call-create-1", delegationId: "d7", status: "completed", at: 2, taskArgs: createArgs }) }, "turn-parent")]);
  check(statusText() === t("chat.subagentStatus.completed"),
    "settled run is not reported completed: " + JSON.stringify(statusText()));
  check(!textarea()?.disabled, "settled run left the input disabled");
  flushSync(() => view.unmount());
  return { passed: true };
};

window.subagentStopResumeCompletedProbe = async () => {
  // A continuation that finishes on its own reports completion and returns the
  // composer to continue mode without any Stop request.
  seed();
  mount("d1");
  await until(() => textarea(), "tab did not mount");
  const FOLLOWUP = "Finishing this run on my own.";
  await send(FOLLOWUP);
  await until(() => calls.some((call) => call.channel === IPC.invoke.agentContinueSubagent), "no continuation request");
  const continueCall = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).at(-1).input;
  const callId = "call-continue-c1";
  const turnId = "turn-exec-c1";
  await deliver(continuationEnvelopes({ callId, messageId: continueCall.messageId, delegationId: "d2", text: FOLLOWUP, turnId }));
  await deliver(toolCallEnvelopes({ callId, turnId, toolCallId: "child-tool-c1", index: 0, delegationId: "d2", text: FOLLOWUP }));
  check(statusText() === t("chat.subagentStatus.running"), "completed run never reported running");
  await deliver([
    envelope({ type: "message_end", message: continuationMarker({ callId, delegationId: "d2", text: FOLLOWUP, status: "completed", turnId, extra: { turns: 2, toolCalls: 1 } }) }, turnId),
    envelope({ type: "agent_end", messageIds: [] }, turnId),
  ]);
  const settled = composerSignature();
  check(settled.disabled === false && settled.action === "send",
    "completed continuation did not return the composer: " + JSON.stringify(settled));
  check(statusText() === t("chat.subagentStatus.completed"),
    "completed continuation reported the wrong state: " + JSON.stringify(statusText()));
  check(userTexts().filter((text) => text === FOLLOWUP).length === 1,
    "completed follow-up rendered more than once: " + JSON.stringify(userTexts()));
  flushSync(() => view.unmount());
  return { passed: true };
};

window.subagentContinueDraftProbe = async () => {
  // The user path under test: type a follow-up in a settled subagent tab, press
  // send, and watch the composer while the send is in flight and after it is
  // accepted. The transcript shows the echo; the composer must not keep the
  // text that was already sent, must not eat text typed during the dispatch,
  // must keep the text on failure, and must not resurrect it later.
  seed();
  mount("d1");
  await until(() => textarea(), "tab did not mount");

  // The composer states itself through its placeholder and send action only.
  check(!tab().textContent.includes("Continues this subagent"),
    "the settled composer added a helper line: " + JSON.stringify(tab().textContent.slice(0, 200)));

  // A real continuation emits its marker and follow-up rows before the RPC
  // reply lands, so the chain advances to the new run mid-dispatch.
  const SENT = "谢谢 — recheck the eviction path.";
  continueMode = "deferred";
  await send(SENT);
  await until(() => pendingContinue, "the continuation request never left the composer");
  const continueCall = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).at(-1).input;
  check(continueCall.content === SENT, "the send lost its text: " + JSON.stringify(continueCall));
  const advance = continuationEnvelopes({ callId: "call-draft-1", messageId: continueCall.messageId, delegationId: "d2", text: SENT, turnId: "turn-exec-draft" });
  await deliver(advance);
  check(statusText() === t("chat.subagentStatus.running"),
    "the continued run is not reported running: " + JSON.stringify(statusText()));
  // Still in flight: the text stays, so a failure can be retried unchanged.
  check(textarea()?.value === SENT,
    "the composer dropped the text before the send resolved: " + JSON.stringify(composerSignature()));
  pendingContinue("ok");
  pendingContinue = null;
  await until(() => textarea()?.value === "",
    "an accepted continuation kept the sent text in the composer: " + JSON.stringify(composerSignature()));
  check(userTexts().filter((text) => text === SENT).length === 1,
    "the accepted follow-up rendered more than once: " + JSON.stringify(userTexts()));
  check(textarea()?.disabled === false,
    "the cleared composer is not usable for the next message: " + JSON.stringify(composerSignature()));

  // Text typed while the dispatch is in flight is the user's next message and
  // must survive the accepted send of the previous one.
  await deliver([
    envelope({ type: "message_end", message: continuationMarker({ callId: "call-draft-1", delegationId: "d2", text: SENT, status: "completed", turnId: "turn-exec-draft", extra: { turns: 2, toolCalls: 1 } }) }, "turn-exec-draft"),
    envelope({ type: "agent_end", messageIds: [] }, "turn-exec-draft"),
  ]);
  check(statusText() === t("chat.subagentStatus.completed"),
    "the finished continuation is not reported completed: " + JSON.stringify(statusText()));
  const NEXT = "Now also check the write path.";
  const TYPED = "and the metrics endpoint.";
  continueMode = "deferred";
  await send(NEXT);
  await until(() => pendingContinue, "the second continuation never left the composer");
  const secondCall = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).at(-1).input;
  await deliver(continuationEnvelopes({ callId: "call-draft-2", messageId: secondCall.messageId, delegationId: "d3", text: NEXT, turnId: "turn-exec-draft-2" }));
  await pushDraft(TYPED);
  pendingContinue("ok");
  pendingContinue = null;
  await until(() => textarea()?.disabled === false,
    "the accepted send left the composer disabled: " + JSON.stringify(composerSignature()));
  check(textarea()?.value === TYPED,
    "an accepted send wiped text typed during the dispatch: " + JSON.stringify(composerSignature()));
  check(userTexts().filter((text) => text === NEXT).length === 1,
    "the second follow-up rendered more than once: " + JSON.stringify(userTexts()));
  await pushDraft("");

  // A rejected send keeps the text for a retry and says why.
  await deliver([
    envelope({ type: "message_end", message: continuationMarker({ callId: "call-draft-2", delegationId: "d3", text: NEXT, status: "stopped", turnId: "turn-exec-draft-2" }) }, "turn-exec-draft-2"),
    envelope({ type: "error", error: { code: "TURN_ABORTED", message: "Delegation ended as stopped.", retriable: false } }, "turn-exec-draft-2"),
  ]);
  check(statusText() === t("chat.subagentStatus.stopped"),
    "the stopped continuation is not reported stopped: " + JSON.stringify(statusText()));
  const RETRY = "Keep this text for a retry.";
  continueMode = "reject";
  await type(RETRY);
  flushSync(() => sendButton().click());
  await until(() => tab()?.querySelector(".subagent-transcript-error"),
    "a rejected continuation reported nothing: " + JSON.stringify(composerSignature()));
  check(textarea()?.value === RETRY,
    "a rejected continuation dropped the text: " + JSON.stringify(composerSignature()));
  check(sendButton()?.disabled === false,
    "a rejected continuation left the composer unusable: " + JSON.stringify(composerSignature()));
  await pushDraft("");
  continueMode = "immediate";

  // The tab sends and clears, then unmounts and comes back: no sent text
  // returns, and a fresh tab starts empty.
  continueMode = "immediate";
  const AGAIN = "One more check of the same run.";
  const beforeAgain = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).length;
  await send(AGAIN);
  await until(() => calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).length > beforeAgain,
    "the third continuation never left the composer");
  const againCall = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).at(-1).input;
  await deliver(continuationEnvelopes({ callId: "call-draft-3", messageId: againCall.messageId, delegationId: "d4", text: AGAIN, turnId: "turn-exec-draft-3" }));
  await until(() => textarea()?.value === "",
    "the third accepted continuation kept its text: " + JSON.stringify(composerSignature()));
  flushSync(() => view.unmount());
  mount("d1");
  await until(() => textarea(), "the reopened tab did not mount");
  check(textarea()?.value === "",
    "reopening the tab resurrected sent text: " + JSON.stringify(composerSignature()));
  flushSync(() => view.unmount());
  mount("d4");
  await until(() => textarea(), "the chain-latest tab did not mount");
  check(textarea()?.value === "",
    "opening the latest run's tab resurrected sent text: " + JSON.stringify(composerSignature()));
  flushSync(() => view.unmount());
  return { passed: true };
};
// One keystroke on the shared editor. keyCode is a legacy property, so it is
// defined on the event the way a Windows Chinese IME reports its confirm key.
const press = (init) => {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  editor().dispatchEvent(event);
  return event.defaultPrevented;
};
const placeCaretAtEnd = () => {
  const node = editor();
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};
const composingInput = async (value, isComposing) => {
  const node = editor();
  flushSync(() => {
    node.textContent = value;
    placeCaretAtEnd();
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value, isComposing }));
  });
  await frame();
};
const sendRequests = () => calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent || call.channel === IPC.invoke.agentSteerSubagent);

window.subagentComposerImeProbe = async () => {
  seed();
  mount("d1");
  await until(() => editor(), "tab did not mount");
  // Earlier probes in this window already sent; measure this probe's own deltas.
  const baseline = sendRequests().length;

  // A Chinese IME confirm Enter commits a candidate. It must reach neither the
  // child channel nor the draft: the tab's own keydown used to send here.
  editor().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await composingInput("你好", true);
  check(textarea().value === "你好", "composing input was not mirrored: " + textarea().value);
  check(press({ isComposing: true }) === false, "an IME confirm Enter was consumed as a send");
  await frame();
  check(sendRequests().length === baseline, "the IME confirm Enter sent the draft: " + JSON.stringify(sendRequests().slice(baseline)));
  // keyCode 229 is what Chromium reports for an IME-processed key even when it
  // does not mark the event as composing.
  check(press({ keyCode: 229 }) === false, "a keyCode 229 Enter was consumed as a send");
  await frame();
  check(sendRequests().length === baseline, "the keyCode 229 Enter sent the draft: " + JSON.stringify(sendRequests().slice(baseline)));
  check(textarea().value === "你好", "an IME confirm Enter cleared or changed the draft: " + textarea().value);
  editor().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
  await frame();

  // The composition ended, so the next Enter is a real send: exactly one, and
  // only after the accepted reply lands does the draft clear.
  const before = sendRequests().length;
  check(press({}) === true, "Enter after compositionend did not act as a send");
  await until(() => sendRequests().length === before + 1,
    "Enter after compositionend did not send exactly once: " + JSON.stringify(sendRequests()));
  const sent = sendRequests().at(-1);
  check(sent.input.content === "你好", "the sent text lost the composed characters: " + JSON.stringify(sent.input));
  await until(() => textarea().value === "", "the accepted send kept its text: " + textarea().value);

  // Shift+Enter is a newline, never a send — before and after the composition.
  const afterComposition = sendRequests().length;
  await type("multi line");
  check(press({ shiftKey: true }) === false, "Shift+Enter was consumed as a send");
  check(sendRequests().length === afterComposition, "Shift+Enter sent the draft");
  // The browser inserts a Shift+Enter break itself; the editor must read it
  // back as a newline instead of an unreadable block, and the send must keep it.
  flushSync(() => {
    const node = editor();
    node.appendChild(document.createElement("br"));
    node.appendChild(document.createTextNode("second line"));
    placeCaretAtEnd();
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }));
  });
  await frame();
  check(textarea().value === "multi line\nsecond line",
    "the editor lost a browser line break: " + JSON.stringify(textarea().value));
  const beforeMultiline = sendRequests().length;
  check(press({}) === true, "Enter on a multi-line draft did not act as a send");
  await until(() => sendRequests().length === beforeMultiline + 1,
    "the multi-line draft did not send exactly once: " + JSON.stringify(sendRequests()));
  check(sendRequests().at(-1).input.content === "multi line\nsecond line",
    "the sent draft lost its line break: " + JSON.stringify(sendRequests().at(-1).input));
  await until(() => textarea().value === "", "the accepted multi-line send kept its text: " + textarea().value);

  // With Enter-to-send off, a bare Enter never sends and a modifier Enter does.
  await pushDraft("");
  store.setState({ settings: { enterToSend: false } });
  await frame();
  const beforePreference = sendRequests().length;
  await type("prefer newline");
  check(press({}) === false, "Enter sent while enter-to-send was off");
  await frame();
  check(sendRequests().length === beforePreference, "Enter sent while enter-to-send was off");
  check(press({ metaKey: true }) === true, "modifier Enter did not send with enter-to-send off");
  await until(() => sendRequests().length === beforePreference + 1,
    "modifier Enter did not send exactly once with enter-to-send off: " + JSON.stringify(sendRequests()));
  store.setState({ settings: { enterToSend: true } });
  flushSync(() => view.unmount());
  return { passed: true };
};

window.subagentContextGaugeProbe = async () => {
  // The chain's context figure as the reader sees it: the stopped first run
  // reported its window, the continuation's marker reports none, and the reply
  // reports its own. The header must never drop to a dash in between — an
  // absent report is not a measurement of an empty window.
  seed();
  mount("d1");
  await until(() => textarea(), "tab did not mount");
  const lastKnown = contextMetric();
  check(lastKnown === "12K",
    "the stopped run's known context is not stated: " + JSON.stringify(lastKnown));

  const FOLLOWUP = "Continuing: what is the window now?";
  const beforeContinue = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).length;
  await send(FOLLOWUP);
  await until(() => calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).length > beforeContinue,
    "continuing the chain issued no request");
  const continueCall = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).at(-1).input;
  const callId = "call-continue-g1";
  const turnId = "turn-exec-g1";
  // The marker and the child user row carry no contextTokens anywhere.
  await deliver(continuationEnvelopes({ callId, messageId: continueCall.messageId, delegationId: "d2", text: FOLLOWUP, turnId }));
  check(statusText() === t("chat.subagentStatus.running"),
    "the continued run is not reported running: " + JSON.stringify(statusText()));
  const afterMarker = contextMetric();
  check(afterMarker === "12K",
    "the resumed marker blanked the chain's known context: " + JSON.stringify(afterMarker));

  // Progress snapshots repeat the counters only: the figure stands.
  for (let index = 0; index < 3; index += 1) {
    await deliver(toolCallEnvelopes({ callId, turnId, toolCallId: "child-tool-g" + index, index, delegationId: "d2", text: FOLLOWUP }));
    check(contextMetric() === "12K",
      "a progress snapshot without a window blanked the known context on event " + index + ": " + JSON.stringify(contextMetric()));
  }
  const afterProgress = contextMetric();
  check(afterProgress === "12K",
    "repeated progress blanked the chain's known context: " + JSON.stringify(afterProgress));

  // The reply's own snapshot reports the window: it replaces the figure.
  await deliver([
    envelope({ type: "message_end", message: continuationMarker({ callId, delegationId: "d2", text: FOLLOWUP, status: "completed", turnId, extra: { turns: 5, toolCalls: 3, contextTokens: 14000 } }) }, turnId),
    envelope({ type: "agent_end", messageIds: [] }, turnId),
  ]);
  const afterReply = contextMetric();
  check(afterReply === "14K",
    "the reply's own window did not replace the chain's figure: " + JSON.stringify(afterReply));
  check(statusText() === t("chat.subagentStatus.completed"),
    "the completed continuation is not reported completed: " + JSON.stringify(statusText()));

  // A later marker without a window keeps the newer figure, not the older one.
  const againBefore = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).length;
  await send("And now?");
  await until(() => calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).length > againBefore,
    "the chain could not continue again");
  const againCall = calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent).at(-1).input;
  await deliver(continuationEnvelopes({ callId: "call-continue-g2", messageId: againCall.messageId, delegationId: "d3", text: "And now?", turnId: "turn-exec-g2" }));
  const afterAgain = contextMetric();
  check(afterAgain === "14K",
    "the second resumed marker blanked the chain's known context: " + JSON.stringify(afterAgain));

  flushSync(() => view.unmount());
  // The observed figures travel back with the verdict, so the run states what
  // the reader saw at each step rather than only that nothing threw.
  return { passed: true, seen: [lastKnown, afterMarker, afterProgress, afterReply, afterAgain] };
};
`;

test("a stopped subagent chain follows its continued run in the original tab", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "subagent-stop-resume-"));
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
    console.log("STOP_RESUME_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.subagentStopResumeProbe()")));
    console.log("STOP_RESUME_COMPLETED_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.subagentStopResumeCompletedProbe()")));
    console.log("CREATING_TAB_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.subagentCreatingTabProbe()")));
    console.log("CONTINUE_DRAFT_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.subagentContinueDraftProbe()")));
    console.log("COMPOSER_IME_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.subagentComposerImeProbe()")));
    console.log("CONTEXT_GAUGE_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.subagentContextGaugeProbe()")));
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
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
    assert.match(output, /STOP_RESUME_PROBE \{"passed":true\}/);
    assert.match(output, /STOP_RESUME_COMPLETED_PROBE \{"passed":true\}/);
    assert.match(output, /CONTINUE_DRAFT_PROBE \{"passed":true\}/);
    assert.match(output, /COMPOSER_IME_PROBE \{"passed":true\}/);
    // The observed figure at each step: the known one survives the resumed
    // marker and repeated progress, the reply's own window replaces it, and a
    // later marker keeps the newer figure.
    assert.match(output, /CONTEXT_GAUGE_PROBE \{"passed":true,"seen":\["12K","12K","12K","14K","14K"\]\}/);
    assert.match(output, /CREATING_TAB_PROBE \{"passed":true\}/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
