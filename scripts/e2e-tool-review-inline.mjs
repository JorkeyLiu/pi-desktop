#!/usr/bin/env node
/**
 * The inline review record a workspace mutation shows on its tool row, driven
 * end to end: an isolated host-core produces the real `tools.execute` result for
 * a workspace `Write` and `Edit`, that result becomes the tool message the
 * session stores, the production delegation conversion turns the delegate's
 * messages into rows, and the same `ToolRow` the transcript and the subagent tab
 * mount is rendered in a real Chromium renderer with the app's own stylesheet.
 *
 * Also covers the record as hosts persisted it before the contract casing
 * (`"operation":"Edit"`): already-stored messages must still state their
 * +a/−d and their diff, and a record whose operation is outside the contract
 * must state neither.
 *
 * No provider, no paid model, no desktop instance: the host runs over stdio on a
 * temporary data directory and workspace, and Electron only renders.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { assertToolSuccess, shortJson } from "./e2e/assert.mjs";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { withScenario } from "./e2e/fixture.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import { configureSession, createSession } from "./e2e/session.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const artifactDir = process.env.PI_TOOL_REVIEW_ARTIFACT_DIR ?? tmpdir();
const tempRoot = await mkdtemp(join(tmpdir(), "pi-tool-review-"));

/** One record's stored `meta.json`, in the session's own review directory. */
function metaPath(dataDir, sessionId, snapshotId) {
  return join(dataDir, "review-changes", sessionId, snapshotId, "meta.json");
}

async function rewriteMetaOperation(path, operation) {
  const meta = JSON.parse(await readFile(path, "utf8"));
  meta.operation = operation;
  await writeFile(path, JSON.stringify(meta), "utf8");
  return meta;
}

async function runHost() {
  return withScenario(
    "E2E-tool-review-inline",
    async ({ host, workspace, dataDir }) => {
      const session = await createSession(host, workspace, "Inline review");
      await configureSession(host, session, "agent", "auto");
      await writeFile(join(workspace, "source.txt"), "one\ntwo\n", "utf8");

      const read = await host.call(
        "tools.execute",
        {
          sessionId: session.id,
          toolCallId: "read-source",
          toolName: "Read",
          args: { path: "source.txt" },
          mode: "agent",
        },
        20_000,
      );
      assertToolSuccess(read, "read-source");

      // A real Edit through the host's own tool, on the host's own workspace.
      const edited = await host.call(
        "tools.execute",
        {
          sessionId: session.id,
          toolCallId: "edit-source",
          toolName: "Edit",
          args: { path: "source.txt", tag: read.content.tag, ops: "PUT 2.=2:\n+TWO\n" },
          mode: "agent",
        },
        20_000,
      );
      assertToolSuccess(edited, "edit-source");

      // A real Write that creates its file, so the other mutating tool's record
      // is covered by the same contract.
      const written = await host.call(
        "tools.execute",
        {
          sessionId: session.id,
          toolCallId: "write-created",
          toolName: "Write",
          args: { path: "created.txt", content: "one\ntwo\n" },
          mode: "agent",
        },
        20_000,
      );
      assertToolSuccess(written, "write-created");
      assert.equal(
        await readFile(join(workspace, "created.txt"), "utf8"),
        "one\ntwo\n",
      );


      const editReview = edited.content?.review;
      const writeReview = written.content?.review;
      assert(
        edited.content?.root === "workspace" &&
          editReview?.operation === "edit" &&
          editReview.additions === 1 &&
          editReview.deletions === 1 &&
          Array.isArray(editReview.hunks) &&
          editReview.hunks.length > 0,
        "the real Edit record is not contract-cased: " + shortJson(edited.content),
      );
      assert(
        written.content?.root === "workspace" &&
          writeReview?.operation === "write" &&
          writeReview.status === "added" &&
          writeReview.additions === 2 &&
          writeReview.deletions === 0,
        "the real Write record is not contract-cased: " +
          shortJson(written.content),
      );

      // What the host stores next to the record uses the same vocabulary.
      const editMeta = metaPath(dataDir, session.id, editReview.snapshotId);
      const writeMeta = metaPath(dataDir, session.id, writeReview.snapshotId);
      for (const [label, path] of [
        ["edit", editMeta],
        ["write", writeMeta],
      ]) {
        const meta = JSON.parse(await readFile(path, "utf8"));
        assert.equal(meta.operation, label, `${label} meta.json operation`);
      }

      // A record written before the contract casing must still be read by the
      // host: the Review panel's per-file row is built from these meta files.
      await rewriteMetaOperation(writeMeta, "Edit");
      const legacyFiles = await host.call("review.files", {
        sessionId: session.id,
      });
      const legacyRow = (legacyFiles.files ?? []).find(
        (file) => file.path === "created.txt",
      );
      assert(
        legacyRow && legacyRow.additions === 2 && legacyRow.status === "added",
        "the host dropped a record with the pre-contract operation spelling: " +
          shortJson(legacyFiles),
      );
      // A value outside the vocabulary is not a record the host may interpret.
      await rewriteMetaOperation(writeMeta, "wipe");
      const unknownFiles = await host.call("review.files", {
        sessionId: session.id,
      });
      assert.equal(
        unknownFiles.unreadableRecords,
        1,
        "an unknown operation must leave the record unreadable: " +
          shortJson(unknownFiles),
      );
      assert.equal(
        (unknownFiles.files ?? []).some((file) => file.path === "created.txt"),
        false,
        "an unknown operation must not become a row: " + shortJson(unknownFiles),
      );

      // The remaining mutation shapes a workspace `Edit` can take,
      // after the pre-contract record checks above have read the files they need.
      // A second edit against the tag the first one superseded. The host
      // applies it at a stable position and reports the stale tag as a
      // warning; that warning is the one thing a reviewed row still has to say.
      const warned = await host.call(
        "tools.execute",
        {
          sessionId: session.id,
          toolCallId: "edit-stale-tag",
          toolName: "Edit",
          args: {
            path: "source.txt",
            tag: read.content.tag,
            ops: "PUT >$:\n+TAIL\n",
          },
          mode: "agent",
        },
        20_000,
      );
      assertToolSuccess(warned, "edit-stale-tag");
      assert(
        Array.isArray(warned.content?.warnings) && warned.content.warnings.length > 0,
        "the stale-tag edit reported no warning: " + shortJson(warned.content),
      );

      // A real move (`MV`) and a real delete (`REM`), so every mutation shape a
      // workspace Edit can take is displayed from the host's own record.
      const moved = await host.call(
        "tools.execute",
        {
          sessionId: session.id,
          toolCallId: "edit-move",
          toolName: "Edit",
          args: {
            path: "source.txt",
            tag: warned.content.tag,
            ops: 'MV "moved.txt"\n',
          },
          mode: "agent",
        },
        20_000,
      );
      assertToolSuccess(moved, "edit-move");
      const removed = await host.call(
        "tools.execute",
        {
          sessionId: session.id,
          toolCallId: "edit-remove",
          toolName: "Edit",
          args: { path: "created.txt", tag: written.content.tag, ops: "REM\n" },
          mode: "agent",
        },
        20_000,
      );
      assertToolSuccess(removed, "edit-remove");
      assert.equal(
        await readFile(join(workspace, "moved.txt"), "utf8"),
        "one\nTWO\nTAIL\n",
      );

      // The `REM` edit removed the file the Write created.
      await assert.rejects(readFile(join(workspace, "created.txt"), "utf8"));
      assert.equal(removed.content?.deleted, true, shortJson(removed.content));
      assert(
        removed.content?.review?.status === "deleted",
        "the delete record is not a deletion: " + shortJson(removed.content?.review),
      );
      assert(
        moved.content?.movedFrom === "source.txt" &&
          moved.content?.review?.path === "source.txt",
        "the move record lost its source: " + shortJson(moved.content),
      );

      const withOperation = (operation) => ({
        ...edited.content,
        review: { ...editReview, operation },
      });
      return {
        edit: edited.content,
        write: written.content,
        warned: warned.content,
        moved: moved.content,
        removed: removed.content,
        // The same real record as hosts persisted it before the contract.
        legacyEdit: withOperation("Edit"),
        // The same real record with an operation no contract names.
        unknownOperation: withOperation("wipe"),
      };
    },
    resolveHostBinary(),
    tempRoot,
    PROTOCOL_VERSION,
  );
}

async function runRenderer(payloads) {
  const temp = await mkdtemp(join(tempRoot, "renderer-"));
  try {
    await build({
      entryPoints: [join(root, "scripts/e2e/tool-review-inline.tsx")],
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.env": '{"DEV":false,"MODE":"production"}',
      },
      loader: { ".css": "empty" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });

    const renderer = join(root, "apps/desktop/out/renderer");
    const appHtml = await readFile(join(renderer, "index.html"), "utf8");
    const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map(
      (match) => match[1],
    );
    assert(
      css.length,
      "Build the app with pnpm build:js before running this check",
    );
    await cp(join(renderer, "assets"), join(temp, "assets"), {
      recursive: true,
    });

    // The row's evidence is styled by the app's own stylesheet, so a stale build
    // fails here instead of passing against older CSS.
    const builtCss = (
      await Promise.all(css.map((path) => readFile(join(renderer, path), "utf8")))
    )
      .join("\n")
      .replace(/\s+/g, "");
    for (const rule of [
      // Whitespace is stripped from the stylesheet before the check, so a
      // descendant selector appears without its space.
      ".review-change-diff.diff-line.add{",
      ".review-change-diff.diff-line.del{",
      ".review-change-card-counts{",
      ".subagent-transcript-list{",
    ]) {
      assert(
        builtCss.includes(rule),
        `the built stylesheet is stale (missing ${rule}); build with pnpm build:js`,
      );
    }

    await writeFile(
      join(temp, "index.html"),
      `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Inline review</title>${css
        .map((path) => `<link rel="stylesheet" href="${path}">`)
        .join("")}<script src="renderer.js"></script>`,
    );
    const payloadScript =
      "globalThis.__toolReviewPayloads = " + JSON.stringify(payloads) + ";";
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 980, height: 1400, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    await window.webContents.executeJavaScript(${JSON.stringify(payloadScript)});
    const result = await window.webContents.executeJavaScript("globalThis.toolReviewProbe(globalThis.__toolReviewPayloads)");
    const image = await window.webContents.capturePage();
    await writeFile(path.join(${JSON.stringify(artifactDir)}, "tool-review-inline.png"), image.toPNG());
    console.log("TOOL_REVIEW_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error("TOOL_REVIEW_PROBE " + JSON.stringify({ ok: false, failures: [error?.stack ?? String(error)] }));
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
      stream.on("data", (data) => {
        output += data;
      });
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
    const line = output
      .split(/\r?\n/)
      .find((entry) => entry.startsWith("TOOL_REVIEW_PROBE "));
    assert(
      line,
      `renderer returned no probe result (exit=${code}): ${output.slice(-3000)}`,
    );
    const result = JSON.parse(line.slice("TOOL_REVIEW_PROBE ".length));
    console.log("TOOL_REVIEW_PROBE " + JSON.stringify(result));
    assert.equal(code, 0, output.slice(-6000));
    assert.deepEqual(result.failures ?? [], [], "inline review checks failed");
    assert.equal(result.ok, true);
    console.log(
      "TOOL_REVIEW_PROBE screenshot " + join(artifactDir, "tool-review-inline.png"),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

try {
  const payloads = await runHost();
  await runRenderer(payloads);
  console.log(
    "PASS E2E-tool-review-inline: real tools.execute Write/Edit records render their +a/−d and diff on the main and delegate rows, including pre-contract records",
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
