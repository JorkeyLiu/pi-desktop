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
 * Images on a subagent's own input, on the real renderer path.
 *
 * The user path under test: in a delegation tab the user picks or pastes a
 * PNG, sees it as a staged tile, removes one, and sends an image-only steer or
 * continuation — no text at all. The request that reaches the process boundary
 * carries `attachments` with the child's own owner identity, a successful send
 * clears exactly the images it carried, a failed one keeps them, an image
 * staged while the send is in flight survives, and a session switch never
 * stages the old session's image into the new one. The transcript then renders
 * the child's user image through the main transcript's own attachment chip.
 *
 * The probe also measures the composer surface: the panel keeps the dock's own
 * filled-field tone (rgb(46,46,46) in the dark theme) with editor and toolbar
 * on that same plate, and the box never overflows at 320px or 760px.
 *
 * The harness mounts the real `SubagentTranscriptTab` and the real app store in
 * an isolated Electron window; only `window.piDesktop` (the process boundary)
 * is a stub.
 */
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

const PNG = "__PNG__";
const listeners = new Map();
const calls = [];
const emit = (channel, payload) => {
  for (const callback of listeners.get(channel) ?? []) callback(payload);
};
let steerMode = "immediate";
let pendingSteer = null;
let importGate = null;
let pastedFiles = [{ path: "attachments/pasted.png", name: "pasted.png", kind: "image", mimeType: "image/png", size: 68 }];
let pickedFiles = [{ path: "attachments/picked.png", name: "picked.png", kind: "image", mimeType: "image/png", size: 68 }];

window.piDesktop = { platform: "darwin", channels: IPC,
  on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel)?.delete(callback);
  },
  async invoke(channel, input) {
    calls.push({ channel, input });
    let data = null;
    if (channel === IPC.invoke.agentSteerSubagent) {
      const accepted = { accepted: true, delegationId: input?.delegationId, turnId: input?.expectedTurnId };
      if (steerMode === "deferred") {
        return new Promise((resolve) => {
          pendingSteer = (outcome) => resolve(outcome === "ok"
            ? { ok: true, data: accepted }
            : { ok: false, error: { code: "INVALID_ARGUMENT", message: outcome } });
        });
      }
      if (steerMode === "reject") {
        return { ok: false, error: { code: "INVALID_ARGUMENT", message: "The child refused the image." } };
      }
      data = accepted;
    } else if (channel === IPC.invoke.agentContinueSubagent) {
      data = { accepted: true, delegationId: "d-new", turnId: "turn-exec-c1", delivery: "user" };
    } else if (channel === IPC.invoke.agentStopSubagents) {
      data = { content: [{ type: "text", text: "stopping" }], details: { stopped: [], stopPending: [] } };
    } else if (channel === IPC.invoke.composerPickPhotos) {
      data = { token: "pick-token" };
    } else if (channel === IPC.invoke.composerImportFiles) {
      if (importGate) {
        const gate = importGate;
        importGate = null;
        await new Promise((resolve) => gate(resolve));
      }
      data = { files: pickedFiles };
    } else if (channel === IPC.invoke.composerPasteFiles) {
      // The host classifies from MIME/extension, like composer-paste.ts does.
      const imageInputs = (input?.files ?? []).filter((file) => String(file.mimeType || "").startsWith("image/"));
      data = { files: imageInputs.length
        ? pastedFiles
        : (input?.files ?? []).map((file, index) => ({ path: "attachments/pasted-" + index + ".txt",
            name: file.name || "pasted.txt", kind: "file", mimeType: file.mimeType || "text/plain",
            size: file.data?.byteLength ?? 0 })) };
    } else if (channel === IPC.invoke.fsReadImageDataUrl) {
      data = { kind: "image", dataUrl: PNG, size: 68 };
    } else if (channel === IPC.invoke.sessionList) {
      data = { sessions: [{ id: "s1", title: "fixture", projectPath: "/tmp/fixture", createdAt: "2026-05-01T09:00:00.000Z", updatedAt: "2026-05-01T10:00:00.000Z", source: "local" }] };
    } else if (channel === IPC.invoke.sessionGet) {
      data = { session: { id: "s1", title: "fixture", projectPath: "/tmp/fixture", source: "local", messages: [] } };
    } else if (channel === IPC.invoke.agentGetQueuedPrompts) {
      data = { entries: [] };
    } else if (channel === IPC.invoke.agentGetStatus) {
      data = { sessionId: "s1", isRunning: false, pendingToolConfirmations: 0 };
    }
    return { ok: true, data };
  },
};

const store = useAppStore;
window.piDesktop.on(IPC.event.agentMessage, (envelope) => store.getState().handleAgentEvent(envelope));
const iso = (seconds) => new Date(Date.parse("2026-05-01T10:00:00.000Z") + seconds * 1000).toISOString();

function task(id, callId, delegationId, status, extra = {}, owner = "parent") {
  return { id, role: "tool", content: "", createdAt: iso(2),
    toolName: "Task", toolCallId: callId, toolStatus: status === "running" ? "running" : "success",
    toolArgs: { agent: "explorer", task: "Investigate the cache layer.", resume: "d1", ...(owner === "user" ? { source: "user" } : {}) },
    toolResult: { details: { delegationId, agent: "explorer", status, delivery: owner,
      startedAt: Date.parse("2026-05-01T10:00:00Z"), modelId: "test-model", thinkingLevel: "high",
      toolCalls: 1, turns: 1, ...extra } } };
}
function childAnswer(id, callId) {
  return { id, role: "assistant", content: "done", createdAt: iso(3),
    parentToolCallId: callId, agentName: "explorer", status: "complete" };
}
const runningMessages = [task("t1", "call-1", "d1", "running", { executionTurnId: "turn-exec-t1" }), childAnswer("a1", "call-1")];
const settledMessages = [task("t1", "call-1", "d1", "completed"), childAnswer("a1", "call-1")];
const baseSessions = [
  { id: "s1", source: "local", title: "fixture", projectPath: "/tmp/fixture" },
  { id: "s2", source: "local", title: "other", projectPath: "/tmp/fixture" },
];

function seed(messages, running, activeSessionId = "s1") {
  store.setState({ activeSessionId, sessions: baseSessions,
    agentStatuses: running ? { s1: { currentTurnId: "turn-parent" } } : {},
    runningSessions: running ? { s1: true } : {},
    retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {},
    settings: { enterToSend: true }, showToast() {}, page: "chat",
    workspace: { path: "/tmp/fixture" } });
  store.setState({ messages });
}

// The tab sits on the panel's own dock surface, exactly as in the work panel.
let host = null;
const createHost = () => {
  const node = document.createElement("div");
  node.style.background = "var(--ds-bg-dock)";
  node.style.width = "760px";
  node.style.height = "620px";
  node.style.display = "flex";
  node.style.flexDirection = "column";
  document.getElementById("root").appendChild(node);
  host = node;
  return node;
};
createHost();

let view;
const mount = (delegationId) => {
  if (host) host.remove();
  createHost();
  view = createRoot(host);
  try {
    flushSync(() => view.render(React.createElement(SlotSessionProvider, { sessionId: "s1" },
      React.createElement(SubagentTranscriptTab, { delegationId }))));
  } catch (error) {
    throw new Error("render failed: " + (error && error.message || error));
  }
};
const unmount = () => { if (view) flushSync(() => view.unmount()); view = null; if (host) { host.remove(); host = null; } };
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const check = (value, message) => { if (!value) throw new Error(message); };
// The label keeps a deliberate step of air before the action. The band accepts
// any spacing the panel might pick inside it, so a token or value change that
// still reads as separated passes; only a flush or oversized gap fails.
const LABEL_ACTION_GAP_RANGE = [7, 16];
const checkGap = (gap, where) => {
  const [min, max] = LABEL_ACTION_GAP_RANGE;
  check(gap >= min && gap <= max,
    "the model/thinking label sits " + gap + "px from Send/Stop at " + where
      + " (expected " + min + "-" + max + "px)");
};
const tab = () => document.querySelector('[data-testid="subagent-transcript-tab"]');
const editor = () => tab()?.querySelector('[data-testid="subagent-panel-footer"] [role="textbox"]');
const footer = () => tab()?.querySelector('[data-testid="subagent-panel-footer"]');
const tiles = () => [...(footer()?.querySelectorAll(".composer-attachment-tile") ?? [])];
const tileImages = () => [...(footer()?.querySelectorAll(".composer-attachment-image") ?? [])];
const attachButton = () => [...(footer()?.querySelectorAll(".composer-toolbar button") ?? [])]
  .find((node) => (node.getAttribute("aria-label") || "").startsWith("Add images"));
const sendButton = () => [...(footer()?.querySelectorAll(".composer-toolbar button") ?? [])]
  .find((node) => /^Send/.test(node.getAttribute("aria-label") || "") || node.className.includes("send-btn"));
const alerts = () => [...(footer()?.querySelectorAll('[role="alert"]') ?? [])].map((node) => node.textContent.trim());
const steerCalls = () => calls.filter((call) => call.channel === IPC.invoke.agentSteerSubagent);
const continueCalls = () => calls.filter((call) => call.channel === IPC.invoke.agentContinueSubagent);
const click = (node) => flushSync(() => node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const pngFile = (name = "shot.png") => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
const pasteFiles = async (files) => {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
  flushSync(() => editor().dispatchEvent(event));
  await frame(); await frame();
};

window.subagentImageStageProbe = async () => {
  seed(runningMessages, true);
  mount("d1");
  await until(() => editor(), "tab did not mount");
  check(tiles().length === 0, "a fresh tab staged an image");

  // Picker: the host stages the picked photo and the panel shows the image.
  click(attachButton());
  await until(() => tiles().length === 1, "picking an image did not stage a tile");
  const imported = calls.filter((call) => call.channel === IPC.invoke.composerImportFiles).at(-1);
  check(imported?.input?.token === "pick-token", "the picker token never reached the importer: " + JSON.stringify(imported?.input));
  check(imported?.input?.sessionId === "s1", "the import was not bound to the tab's session: " + JSON.stringify(imported?.input));
  await until(() => tileImages().length === 1, "the staged image never loaded its preview source");
  const source = tileImages()[0].getAttribute("src") || "";
  check(source.startsWith("data:image/png"), "the tile did not render the host-resolved image: " + source.slice(0, 32));
  check(editor().getAttribute("aria-busy") !== "true", "the editor stayed marked busy after staging");

  // Remove: the corner control drops exactly that image.
  click(tiles()[0].querySelector(".composer-attachment-remove"));
  await until(() => tiles().length === 0, "removing the staged image left its tile");

  // Paste: a clipboard image is staged through the host's paste channel.
  await pasteFiles([pngFile()]);
  await until(() => tiles().length === 1, "pasting an image did not stage a tile");
  const pasted = calls.filter((call) => call.channel === IPC.invoke.composerPasteFiles).at(-1);
  check(pasted?.input?.sessionId === "s1", "the paste was not bound to the tab's session: " + JSON.stringify(pasted?.input));
  check(pasted?.input?.files?.[0]?.mimeType === "image/png", "the pasted image lost its MIME type: " + JSON.stringify(pasted?.input?.files?.[0]?.mimeType));
  check((pasted?.input?.files?.[0]?.data?.byteLength ?? 0) > 0, "the pasted image carried no bytes");

  // A non-image paste refuses visibly instead of silently dropping the file.
  const before = tiles().length;
  await pasteFiles([new File(["hello"], "notes.txt", { type: "text/plain" })]);
  check(tiles().length === before, "a non-image paste staged a tile");
  check(alerts().some((text) => /Only images/i.test(text)), "a non-image paste was dropped silently: " + JSON.stringify(alerts()));
  unmount();
  return { passed: true };
};

window.subagentImageOnlySteerProbe = async () => {
  seed(runningMessages, true);
  mount("d1");
  await until(() => editor(), "tab did not mount");
  await until(() => footer()?.querySelector(".composer-toolbar button"), "composer controls missing");

  // Image only: no text at all, and the send is enabled by the image itself.
  click(attachButton());
  await until(() => tiles().length === 1, "picking an image did not stage a tile");
  check(sendButton()?.disabled !== true, "an image-only steer could not be sent: the send stayed disabled");
  click(sendButton());
  await until(() => steerCalls().length === 1, "the image-only steer never reached the child channel");
  const steer = steerCalls()[0];
  check(steer.input.content === "", "an image-only steer invented text: " + JSON.stringify(steer.input.content));
  check(steer.input.delegationId === "d1", "the steer named the wrong delegation: " + JSON.stringify(steer.input.delegationId));
  check(steer.input.expectedTurnId === "turn-exec-t1", "the steer named the wrong owner turn: " + JSON.stringify(steer.input.expectedTurnId));
  check(Array.isArray(steer.input.attachments) && steer.input.attachments.length === 1,
    "the steer carried no structured attachment: " + JSON.stringify(steer.input.attachments));
  check(JSON.stringify(steer.input.attachments[0]) === JSON.stringify(
    { path: "attachments/picked.png", name: "picked.png", kind: "image", mimeType: "image/png" }),
    "the attachment was not the host's own path/MIME shape: " + JSON.stringify(steer.input.attachments[0]));
  await until(() => tiles().length === 0, "the accepted steer kept its image staged");

  // Failure keeps the image for a retry and says why.
  steerMode = "reject";
  click(attachButton());
  await until(() => tiles().length === 1, "the retry image was not staged");
  click(sendButton());
  await until(() => steerCalls().length === 2, "the failing steer never reached the child channel");
  await until(() => alerts().some((text) => /refused the image/i.test(text)), "the refusal was not shown: " + JSON.stringify(alerts()));
  check(tiles().length === 1, "a rejected steer dropped the image instead of keeping it");
  steerMode = "immediate";

  // An image staged while the send is in flight belongs to the next send.
  steerMode = "deferred";
  click(attachButton());
  await until(() => tiles().length === 1, "the in-flight probe image was not staged");
  click(sendButton());
  await until(() => steerCalls().length === 3, "the deferred steer never reached the child channel");
  await pasteFiles([pngFile("later.png")]);
  await until(() => tiles().length === 2, "an image pasted during the send was not staged");
  pendingSteer("ok");
  await until(() => tiles().length === 1, "the accepted send did not clear exactly its own image");
  check(tileImages()[0]?.getAttribute("src")?.startsWith("data:image"), "the surviving tile is not the newly staged image");
  steerMode = "immediate";

  // A session switch during the send never stages the old image into the new one.
  steerMode = "deferred";
  click(tiles()[0].querySelector(".composer-attachment-remove"));
  await until(() => tiles().length === 0, "the tile could not be removed");
  click(attachButton());
  await until(() => tiles().length === 1, "the drift probe image was not staged");
  click(sendButton());
  await until(() => steerCalls().length === 4, "the drift steer never reached the child channel");
  flushSync(() => store.setState({ activeSessionId: "s2" }));
  await frame();
  pendingSteer("ok");
  await frame(); await frame();
  check(tiles().length === 0, "a session switch resurrected the old session's image");
  const afterSwitch = calls.filter((call) => call.input?.sessionId === "s2"
    && (call.channel === IPC.invoke.agentSteerSubagent || call.channel === IPC.invoke.agentContinueSubagent));
  check(afterSwitch.length === 0, "the drift send leaked into the new session: " + JSON.stringify(afterSwitch.map((call) => call.channel)));
  steerMode = "immediate";
  unmount();
  return { passed: true };
};

window.subagentImageContinueProbe = async () => {
  seed(settledMessages, false);
  mount("d1");
  // The preview source is the host's safe data URL on an <img>, never text:
  // no image bytes land in copyable content or in a tool result.
  check(!document.body.innerText.includes("iVBORw0KGgo"), "base64 bytes leaked into rendered text");
  await until(() => editor(), "tab did not mount");
  await until(() => footer()?.querySelector(".composer-toolbar button"), "composer controls missing");
  click(attachButton());
  await until(() => tiles().length === 1, "picking an image did not stage a tile");
  check(sendButton()?.disabled !== true, "an image-only continuation could not be sent");
  click(sendButton());
  await until(() => continueCalls().length === 1, "the image-only continuation never reached the child channel");
  const continuation = continueCalls()[0];
  check(continuation.input.content === "", "an image-only continuation invented text");
  check(continuation.input.delegationId === "d1", "the continuation named the wrong delegation");
  check(continuation.input.attachments?.length === 1, "the continuation carried no attachment: " + JSON.stringify(continuation.input));
  check(continuation.input.attachments[0].path === "attachments/picked.png", "the continuation carried the wrong path");
  await until(() => tiles().length === 0, "the accepted continuation kept its image staged");
  unmount();
  return { passed: true };
};

window.subagentImageTranscriptProbe = async () => {
  const steerImage = { kind: "image", name: "pasted.png", ref: "attachments/pasted.png", mimeType: "image/png", size: 68 };
  const seedImage = { kind: "image", name: "picked.png", ref: "attachments/picked.png", mimeType: "image/png", size: 68 };
  // One parent-owned running turn with an image-only steer, and one user-owned
  // continuation whose seed row carries the follow-up text plus an image.
  const messages = [
    task("t1", "call-1", "d1", "running", { executionTurnId: "turn-exec-t1" }),
    { id: "child-u1", role: "user", content: "", createdAt: iso(6), parentToolCallId: "call-1",
      attachments: [steerImage] },
    childAnswer("a1", "call-1"),
    task("t2", "call-2", "d2", "running", { executionTurnId: "turn-exec-t2", resumedFrom: "d1" }, "user"),
    { id: "child-u2", role: "user", content: "Now check the write path.", createdAt: iso(8), parentToolCallId: "call-2",
      attachments: [seedImage] },
    childAnswer("a2", "call-2"),
  ];
  seed(messages, true);
  mount("d1");
  await until(() => tab()?.querySelector(".subagent-transcript-list"), "tab did not mount");
  await until(() => tab().querySelectorAll(".message-attachment-image-chip").length >= 2,
    "the child's user images did not render: " + JSON.stringify(
      [...tab().querySelectorAll(".message-row.user")].map((row) => row.textContent.trim())));
  const chips = [...tab().querySelectorAll(".message-attachment-image-chip")];
  check(chips.length === 2, "expected one attachment chip per user image, got " + chips.length);
  const imageRow = [...tab().querySelectorAll(".message-row.user")]
    .find((row) => row.querySelector(".message-attachment-image-chip"));
  check(imageRow, "no user row rendered its image");
  check(!imageRow.textContent.includes("task has no description"),
    "an image-only user row fell back to the empty-task label: " + imageRow.textContent);
  unmount();
  return { passed: true };
};

window.subagentComposerSurfaceProbe = async () => {
  const rgbOf = (value) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext("2d");
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]];
  };
  const composite = (over, base) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = base;
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = over;
    context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]];
  };

  const shell = () => footer()?.querySelector(".subagent-transcript-shell");
  const shellRgb = () => composite(getComputedStyle(shell()).backgroundColor, "rgb(" + dockRgb.join(",") + ")");
  const surface = () => {
    check(shell(), "composer shell missing");
    const element = shell();
    const computed = getComputedStyle(element);
    const editorStyle = getComputedStyle(editor());
    const toolbar = footer().querySelector(".subagent-transcript-composer-controls");
    const toolbarStyle = toolbar ? getComputedStyle(toolbar) : null;
    const shellRect = element.getBoundingClientRect();
    const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null;
    const tabNode = tab();
    // Toolbar arrangement: the image picker alone on the left, the static
    // model/thinking label immediately left of the Send/Stop slot on the right.
    const rectOf = (node) => (node ? node.getBoundingClientRect() : null);
    const leftRect = rectOf(footer().querySelector(".subagent-transcript-composer-controls > .composer-left"));
    const rightGroup = footer().querySelector(".subagent-transcript-composer-controls > .composer-right");
    const rightRect = rectOf(rightGroup);
    const model = footer().querySelector(".subagent-transcript-model-static");
    const modelName = model?.querySelector(".composer-model-thinking-model");
    const modelRect = rectOf(model);
    const action = rightGroup
      ? [...rightGroup.children].find((node) => node.matches(".send-btn, .stop-btn"))
      : null;
    const actionRect = rectOf(action);
    const attachRect = rectOf(attachButton());
    const sameRow = (a, b) => !!a && !!b && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
    return {
      shellFill: shellRgb(),
      shellShadow: computed.boxShadow,
      editorFill: editorStyle.backgroundColor,
      toolbarFill: toolbarStyle ? toolbarStyle.backgroundColor : "absent",
      toolbarInsideShell: toolbarRect
        ? toolbarRect.left >= shellRect.left - 0.5 && toolbarRect.right <= shellRect.right + 0.5
        : false,
      clipped: tabNode.scrollWidth - tabNode.clientWidth,
      gated: element.classList.contains("is-gated"),
      editorReadOnly: editor().getAttribute("aria-readonly"),
      pickerAloneOnLeft: !!attachRect && !!leftRect
        && attachRect.left >= leftRect.left - 0.5 && attachRect.right <= leftRect.right + 0.5
        && footer().querySelector(".composer-left .subagent-transcript-model-static") === null,
      labelLeftOfAction: !!modelRect && !!actionRect && modelRect.right <= actionRect.left + 0.5,
      labelBesideAction: sameRow(modelRect, actionRect),
      // Breathing room between the static label and the action: read from the
      // rendered boxes so it follows whatever spacing the panel declares, and
      // asserted as a comfortable band rather than one exact value.
      labelActionGap: modelRect && actionRect
        ? Math.round((actionRect.left - modelRect.right) * 10) / 10
        : -1,
      actionInRightGroup: !!actionRect && !!rightRect
        && actionRect.left >= rightRect.left - 0.5 && actionRect.right <= rightRect.right + 0.5,
      // The toolbar owns inline padding, so flushness is measured against its
      // content-box right edge, not its border box.
      rightGroupFlushRight: !!rightRect && !!toolbarRect
        && Math.abs((toolbarRect.right - (parseFloat(toolbarStyle?.paddingRight ?? "0") || 0))
          - rightRect.right) <= 1,
      toolbarOverflow: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : 0,
      labelTruncated: !!modelName && modelName.scrollWidth > modelName.clientWidth + 1,
      labelWidth: modelRect ? Math.round(modelRect.width) : -1,
      actionWidth: actionRect ? Math.round(actionRect.width) : -1,
    };
  };

  document.documentElement.setAttribute("data-theme", "dark");
  seed(runningMessages, true);
  mount("d1");
  await until(() => editor(), "tab did not mount");
  const dockRgb = rgbOf(getComputedStyle(host).backgroundColor);
  const rest = surface();
  check(rest.shellFill.join(",") === "46,46,46", "the panel composer is not the dock's field tone: " + rest.shellFill.join(","));
  check(rest.shellShadow === "none", "the panel composer lifted off the pane: " + rest.shellShadow);
  check(rest.editorFill === "rgba(0, 0, 0, 0)", "the editor painted a second plate: " + rest.editorFill);
  check(rest.toolbarFill === "rgba(0, 0, 0, 0)", "the toolbar painted a second plate: " + rest.toolbarFill);
  check(rest.toolbarInsideShell, "the toolbar escaped the composer box");
  check(rest.clipped <= 1, "the tab clips horizontally at 760px: " + rest.clipped);
  // The action row reads left-to-right: picker, then the static label and the
  // single Send/Stop slot as one right-hand group.
  check(rest.pickerAloneOnLeft, "the image picker is not alone on the toolbar's left side");
  check(rest.labelLeftOfAction, "the model/thinking label is not left-adjacent to Send/Stop");
  check(rest.labelBesideAction, "the model/thinking label is not on the action's row");
  checkGap(rest.labelActionGap, "760px");
  check(rest.actionInRightGroup, "Send/Stop left the toolbar's right-hand group");
  check(rest.rightGroupFlushRight, "the action group is not flush with the toolbar's right edge");
  check(rest.toolbarOverflow <= 1, "the toolbar overflows at 760px: " + rest.toolbarOverflow);
  check(rest.actionWidth === 26, "Send/Stop lost its compact geometry: " + rest.actionWidth);

  flushSync(() => editor().focus());
  await frame();
  // Focus adds the accent ring to the same plate: the user's chosen 46 surface
  // is never deepened on focus, so only the ring may appear. A hidden fixture
  // window has no document focus, so Blink does not restyle :focus-within
  // (document.hasFocus() === false); the focused plate is therefore verified
  // from the declared rules, and the rendered focus state is reported as not
  // observable in this environment.
  const styleRules = [...document.styleSheets].flatMap((sheet) => {
    try { return [...sheet.cssRules]; } catch { return []; }
  });
  const restRule = styleRules.find((rule) => rule.selectorText
    === ".subagent-transcript-tab .subagent-transcript-composer .composer-shell.subagent-transcript-shell");
  const focusRule = styleRules.find((rule) => rule.selectorText
    && rule.selectorText.includes(".subagent-transcript-shell:focus-within"));
  check(focusRule, "the focused panel plate has no rule");
  check(restRule, "the resting panel plate has no rule");
  check(focusRule.style.background === restRule.style.background,
    "focus changed the surface instead of only adding its ring: rest "
      + restRule.style.background + " vs focus " + focusRule.style.background);
  check(focusRule.selectorText.startsWith(".subagent-transcript-tab .subagent-transcript-composer"),
    "the focused plate is not anchored on the panel: " + focusRule.selectorText);
  check(/0 0 0 2px/.test(focusRule.style.boxShadow),
    "focus lost its accent ring: " + focusRule.style.boxShadow);
  check(document.activeElement === editor(), "the editor did not take focus at all");
  check(shell().matches(":focus-within"), "the focused editor did not sit inside the composer box");

  // Narrow panel: the toolbar and the box keep their geometry, and the label
  // truncates inside its own slot instead of displacing the action.
  const narrowLayouts = {};
  for (const width of [320, 400]) {
    host.style.width = width + "px";
    await frame(); await frame();
    const narrow = surface();
    check(narrow.clipped <= 1, "the tab clips horizontally at " + width + "px: " + narrow.clipped);
    check(narrow.toolbarInsideShell, "the toolbar escaped the composer box at " + width + "px");
    check(attachButton(), "the image picker disappeared at " + width + "px");
    check(narrow.pickerAloneOnLeft, "the image picker left the toolbar's left side at " + width + "px");
    check(narrow.labelLeftOfAction && narrow.labelBesideAction,
      "the model/thinking label is not left-adjacent to Send/Stop at " + width + "px");
    checkGap(narrow.labelActionGap, width + "px");
    check(narrow.actionInRightGroup && narrow.rightGroupFlushRight,
      "Send/Stop is not the right-most control at " + width + "px");
    check(narrow.toolbarOverflow <= 1, "the toolbar overflows at " + width + "px: " + narrow.toolbarOverflow);
    check(narrow.actionWidth === 26, "Send/Stop lost its compact geometry at " + width + "px: " + narrow.actionWidth);
    narrowLayouts[width] = { label: narrow.labelWidth, action: narrow.actionWidth,
      gap: narrow.labelActionGap, overflow: narrow.toolbarOverflow };
  }

  // A long model id ellipsizes inside its own slot instead of pushing the
  // action out of the composer.
  unmount();
  seed([task("t1", "call-1", "d1", "running",
    { executionTurnId: "turn-exec-t1", modelId: "provider/" + "x".repeat(64) + "-long-model-name" })], true);
  mount("d1");
  await until(() => editor(), "long-label tab did not mount");
  host.style.width = "320px";
  await frame(); await frame();
  const long = surface();
  check(long.clipped <= 1, "a long model label clips the tab at 320px: " + long.clipped);
  check(long.toolbarOverflow <= 1, "a long model label overflows the toolbar at 320px: " + long.toolbarOverflow);
  check(long.labelLeftOfAction && long.actionInRightGroup,
    "a long model label pushed Send/Stop out of its group");
  checkGap(long.labelActionGap, "long label at 320px");
  check(long.labelTruncated, "a long model label did not ellipsize: " + long.labelWidth + "px");
  check(long.actionWidth === 26, "a long model label squeezed Send/Stop: " + long.actionWidth);
  host.style.width = "760px";
  await frame();

  // Light theme moves the same token pair, never a literal.
  document.documentElement.setAttribute("data-theme", "light");
  // The shell animates its fill, so let that transition settle before reading.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const lightDock = rgbOf(getComputedStyle(host).backgroundColor);
  const lightFill = composite(getComputedStyle(shell()).backgroundColor, "rgb(" + lightDock.join(",") + ")");
  check(lightFill.join(",") !== "46,46,46", "the light theme kept the dark plate: " + lightFill.join(","));
  check(lightFill.every((channel) => channel > 200), "the light plate is not a light surface: " + lightFill.join(","));
  document.documentElement.setAttribute("data-theme", "dark");
  await new Promise((resolve) => setTimeout(resolve, 400));

  // A blocked surface keeps the same plate and refuses input, so "disabled"
  // never becomes a separate grey box.
  flushSync(() => store.setState({ activeSessionId: "s1",
    sessions: [{ id: "remote:s9", source: "remote", title: "remote fixture" }] }));
  unmount();
  seed(runningMessages, true, "remote:s9");
  mount("d1");
  await until(() => editor(), "blocked tab did not mount");
  const gated = surface();
  check(gated.gated, "a read-only surface did not mark its composer");
  check(gated.editorReadOnly === "true", "a read-only surface left its editor writable");
  check(gated.shellFill.join(",") === "46,46,46", "the blocked composer painted a different plate: " + gated.shellFill.join(","));
  check(!attachButton() || attachButton().disabled, "a remote surface still offers the image picker");
  unmount();
  return { passed: true, rest: rest.shellFill, focusToken: focusRule.style.background,
    layout: { wide: { label: rest.labelWidth, action: rest.actionWidth,
        gap: rest.labelActionGap, overflow: rest.toolbarOverflow },
      narrow: narrowLayouts,
      longLabel: { label: long.labelWidth, truncated: long.labelTruncated,
        action: long.actionWidth, overflow: long.toolbarOverflow } } };
};
`;

const probes = [
  ["subagentImageStageProbe", "IMAGE_STAGE_PROBE"],
  ["subagentImageOnlySteerProbe", "IMAGE_STEER_PROBE"],
  ["subagentImageContinueProbe", "IMAGE_CONTINUE_PROBE"],
  ["subagentImageTranscriptProbe", "IMAGE_TRANSCRIPT_PROBE"],
  ["subagentComposerSurfaceProbe", "COMPOSER_SURFACE_PROBE"],
];

test("a subagent input carries images through pick, paste, send, and the transcript", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "subagent-images-"));
  try {
    await build({
      stdin: { contents: fixture.replace("__PNG__", PNG), resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
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
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    const probeScript = probes
      .map(([name, label]) => `    try { console.log("${label} " + JSON.stringify(await win.webContents.executeJavaScript("window.${name}()"))); }
    catch (probeError) { console.log("${label}_ERROR " + String(probeError && probeError.message || probeError).split("\\n")[0]); }`)
      .join("\n");
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.webContents.focus();
    win.webContents.on("console-message", (_event, _level, message) => console.log("RENDERER " + message));
${probeScript}
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
    for (const [, label] of probes) {
      assert.match(output, new RegExp(`${label} \\{"passed":true`), output.slice(-6000));
    }
    console.log(output.split("\n").filter((line) => /_PROBE /.test(line)).join("\n"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
