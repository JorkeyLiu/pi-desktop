#!/usr/bin/env node
// Real desktop, preload, Host SQLite, agent sidecar and first-prompt auto-title
// flow; only the OpenAI-compatible model endpoint is a local SSE fixture.
// Scenario: a configured global fast model replaces the first-prompt fallback
// title with the model's generated title, persisted and visible in the sidebar.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";

const generatedTitle = "Login flow fix";
const root = mkdtempSync(join(tmpdir(), "pi-auto-title-e2e-"));
const dataDir = join(root, "data");
const project = join(root, "project");
mkdirSync(project);
const evidence = process.env.PI_AUTO_TITLE_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });

const titleRequests = [];
const chatRequests = [];
const failures = [];
const modelServer = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fixture", object: "model" }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const system = payload.messages?.find((message) => message.role === "system");
    const content = String(system?.content ?? "");
    const isTitle = content.includes("Return only a short title");
    (isTitle ? titleRequests : chatRequests).push(payload);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `auto-title-${isTitle ? "title" : "chat"}`, object: "chat.completion.chunk", created: 1, model: payload.model };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: isTitle ? generatedTitle : "Login flow is ready." }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) {
    failures.push(String(error));
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
await new Promise((done) => modelServer.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;

const host = new Host(resolveHostBinary(), dataDir);
await host.start();
await host.call("workspace.set", { path: project });
const { provider } = await host.call("providers.create", {
  name: "Automatic title fixture",
  vendorKey: "custom",
  type: "openai_compatible",
  protocol: "openai_compatible",
  baseUrl,
  authKind: "none",
  defaultModelId: "fixture",
  apiStyle: "chat_completions",
});
await host.call("settings.set", {
  language: "en",
  defaultProviderId: provider.id,
  defaultModelId: "fixture",
  defaultMode: "agent",
  defaultPermissionMode: "auto",
  fastModelProviderId: provider.id,
  fastModelId: "fixture",
});
await host.stop();

const { appDir, electronBinary } = resolveElectronBinary();
const port = Number(process.env.PI_AUTO_TITLE_CDP_PORT || 9399);
const env = { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_START_MAXIMIZED: "0", ELECTRON_RENDERER_URL: "" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(root, "profile")}`, "."], {
  cwd: appDir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
const childClose = new Promise((done) => child.once("close", done));
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

let ws;
let primaryError;
try {
  let target;
  await waitFor(async () => {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (entry) => entry.type === "page" && entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"),
      );
      return !!target;
    } catch {
      return false;
    }
  }, 30_000, "desktop CDP target");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const invoke = (name, ...args) =>
    evaluate(`(async () => { const r = await window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(name)}], ...${JSON.stringify(args)}); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.data; })()`);
  const screenshot = async (name) => {
    if (!evidence) return;
    const result = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(evidence, name), Buffer.from(result.data, "base64"));
  };

  await waitFor(() => evaluate(`!!document.querySelector('[data-nav="settings"]') && !document.querySelector('.startup-splash')`), 30_000, "desktop ready");
  // The user path: the New task action starts an untitled draft, and its first
  // prompt must reach the fast model. Nothing is pre-seeded through Host RPC.
  await waitFor(() => evaluate(`!!document.querySelector('button[aria-label="New task"]')`), 10_000, "new task action");
  await evaluate(`document.querySelector('button[aria-label="New task"]').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('.composer-input[contenteditable="true"]')`), 10_000, "composer ready");
  await evaluate(`document.querySelector('.composer-input').focus()`);
  await send("Input.insertText", { text: "Fix the login flow" });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

  await waitFor(() => titleRequests.length > 0, 20_000, `fast-model title request (chat requests ${chatRequests.length}, output ${output.slice(-1200)})`);
  assert.equal(titleRequests[0].model, "fixture", "title request reaches the configured fast model binding");
  await waitFor(
    () => evaluate(`[...document.querySelectorAll('.thread-item-title')].some((element) => element.textContent.trim() === ${JSON.stringify(generatedTitle)})`),
    20_000,
    "generated title visible in the sidebar",
  );
  const { sessions } = await invoke("sessionList");
  const titled = sessions.find((session) => session.title === generatedTitle);
  assert.ok(titled, `generated title persisted: ${JSON.stringify(sessions.map((session) => session.title))}`);
  assert.equal(sessions.length, 1, "the prompt created exactly one session from the UI draft");
  assert.equal(titleRequests.length, 1, "exactly one completion per first prompt");
  await screenshot("automatic-session-title.png");
  console.log(`PASS automatic session title: first prompt produced "${generatedTitle}" through the fast model, persisted and visible`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try { ws?.close(); } catch {}
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([childClose, new Promise((done) => setTimeout(done, 5000))]);
  }
  if (!primaryError) {
    await host.stop().catch(() => undefined);
    await new Promise((done) => modelServer.close(done));
    rmSync(root, { recursive: true, force: true });
  }
  if (failures.length) console.error("model fixture failures:", failures);
}
