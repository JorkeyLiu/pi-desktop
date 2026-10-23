import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createOneShotCompletionService } = await import(
  "../electron/main/services/one-shot-completion-service.ts"
);

function dependencies(overrides = {}) {
  const calls = [];
  const launch = {
    providerId: "provider",
    modelId: "org/model",
    sidecarParams: {
      provider: { id: "provider", authKind: "oauth", apiKey: "resolved-in-launch" },
      thinkingLevel: "high",
    },
  };
  return {
    calls,
    service: createOneShotCompletionService({
      getHost: () => ({
        call: async (method, input) => {
          calls.push(["host", method, input]);
          return method === "settings.get" ? { settings: true } : { session: { id: "session" } };
        },
      }),
      resolveAgentRuntimeLaunch: async (...args) => {
        calls.push(["launch", ...args]);
        return launch;
      },
      vendorOAuth: { resolveAuth: (providerId) => ({ token: `auth:${providerId}` }) },
      complete: async (...args) => {
        calls.push(["complete", ...args]);
        return { text: "done", usage: { input: 1, output: 2 } };
      },
      ...overrides,
    }),
  };
}

test("one-shot service resolves selected model credentials and routes OAuth auth", async () => {
  const { service, calls } = dependencies();
  const signal = new AbortController().signal;
  const result = await service({
    sessionId: "session",
    providerId: "provider",
    modelId: "org/model",
    context: { systemPrompt: "system", messages: [] },
    thinkingLevel: "high",
    signal,
  });
  assert.equal(calls[0][1], "settings.get");
  assert.equal(calls[1][1], "session.get");
  assert.deepEqual(calls[2].slice(1, 4), ["session", { id: "session" }, { settings: true }]);
  const [provider, , , options] = calls[3].slice(1);
  assert.deepEqual(provider.resolveAuth(), { token: "auth:provider" });
  assert.equal(options.signal, signal);
  assert.deepEqual(result, {
    text: "done",
    usage: { input: 1, output: 2 },
    modelKey: "provider/org/model",
    thinkingLevel: "high",
  });
});

test("one-shot service preserves cancellation and provider errors", async () => {
  const failure = Object.assign(new Error("cancelled"), { errorCode: "ABORTED" });
  const { service } = dependencies({ complete: async () => { throw failure; } });
  const controller = new AbortController();
  await assert.rejects(
    service({
      sessionId: "internal-session",
      providerId: "provider",
      modelId: "model",
      context: { messages: [] },
      signal: controller.signal,
    }),
    (error) => error === failure && error.errorCode === "ABORTED",
  );
});
