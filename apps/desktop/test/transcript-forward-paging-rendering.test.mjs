import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { catalogs, listedLocales } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
  Reading forward has no control. The transcript keeps a status row at the
  bottom of the loaded window so a fetch in flight is visible and a failed page
  can be retried once, but the window itself never asks the reader to press
  anything to see the next page.

  The rendering harness resolves copy through the component's own i18n graph, so
  these checks assert structure and the shipped catalogs separately.
*/
async function renderTranscript(props) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { ChatTranscript } = await server.ssrLoadModule(
      "/src/features/chat/transcript/ChatTranscript.tsx",
    );
    return renderToStaticMarkup(createElement(ChatTranscript, {
      sessionId: "s",
      isRunning: false,
      messages: [{
        id: "m1", role: "user", content: "hello",
        createdAt: "2026-09-13T00:00:00Z", status: "complete",
      }],
      ...props,
    }));
  } finally {
    await server.close();
  }
}

test("a window with a later page renders a status boundary, not a control", async () => {
  const markup = await renderTranscript({ hasMoreAfter: true, onLoadNewer: async () => {} });
  assert.match(markup, /class="transcript-later-boundary"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(markup, /transcript-load-later/);
  assert.doesNotMatch(markup, /<button[^>]*>Load later messages<\/button>/);
});

test("a later page in flight reports itself on the boundary row", async () => {
  const markup = await renderTranscript({ hasMoreAfter: true, loadingLater: true });
  assert.match(markup, /class="transcript-later-boundary"[^>]*aria-hidden="false"/);
  assert.match(markup, /class="transcript-later-boundary"[^>]*role="status"/);
  assert.doesNotMatch(markup, /transcript-load-later/);
});

test("a failed later page offers exactly one explicit retry", async () => {
  const markup = await renderTranscript({
    hasMoreAfter: true, laterFailed: true, onLoadNewer: async () => {},
  });
  assert.equal((markup.match(/class="transcript-load-later"/g) ?? []).length, 1);
  const retry = markup.match(/class="transcript-load-later">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.equal((retry.match(/<button/g) ?? []).length, 1, retry);
});

test("every shipped catalog carries the later-page copy and drops the manual control", () => {
  const english = catalogs.en.chat;
  assert.equal(typeof english.loadingLaterMessages, "string");
  assert.equal(typeof english.laterFailedRetry, "string");
  assert.equal("loadLaterMessages" in english, false,
    "the manual load-later control copy must not survive");
  for (const locale of listedLocales()) {
    const chat = catalogs[locale.id].chat;
    for (const key of ["loadingLaterMessages", "laterFailedRetry"]) {
      assert.equal(typeof chat[key], "string", `${locale.id}: ${key}`);
      assert.ok(chat[key].trim(), `${locale.id}: ${key} must not be blank`);
      assert.equal("loadLaterMessages" in chat, false, `${locale.id}: ${key} replaced the control`);
      if (locale.id !== "en") {
        assert.notEqual(chat[key], english[key], `${locale.id}: ${key} is translated`);
      }
    }
  }
});
