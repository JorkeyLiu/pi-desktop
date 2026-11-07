import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import {
  AUTO_PASTED_TEXT_DIR,
  MAX_AUTO_PASTED_TEXT_BYTES,
  serializeInlineComposerFileReferences,
} from "@pi-desktop/shared";
import {
  importComposerFiles,
  saveComposerPasteFiles,
} from "../electron/main/composer-paste.ts";
import { assembleTurnPrompt } from "../electron/main/prompt-attachments.ts";

// One whole user path, at the boundary the provider request is built on: the
// Composer's oversized-paste conversion, the draft chip it inserts, the
// serialization the send performs, the attachment list the store derives, and
// the prompt Electron main hands the model. Only the filesystem is real; no
// provider, no Electron, no renderer DOM.
//
// The paste is the user's own words, not a document to open, so the turn must
// carry its text even though the draft, the transcript, and the persisted
// message keep one compact chip. Provenance is the owned paste directory, never
// the file name: a picked, dropped, or pasted file keeps its own name one level
// up and stays a reference.

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(here);
const sessionId = "paste-context";

/** Everything the user pasted: head, middle, tail, and non-ASCII scripts. */
const longPaste = [
  "first line of the pasted report",
  "",
  "  indented middle section with\ttabs and trailing spaces   ",
  "中文段落：粘貼的內容必須完整進入模型上下文。",
  "emoji 🧪🚀 and combining é (e + U+0301) and RTL العربية עברית",
  "```ts",
  "const answer = 42; // the model must see this without a Read call",
  "```",
  "last line of the pasted report",
].join("\r\n");

async function fixture(t, rootName = "pi-auto-pasted-") {
  const root = await mkdtemp(join(rootName.startsWith("/") ? rootName : join(tmpdir(), rootName)));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const projectPath = join(root, "project");
  await mkdir(projectPath, { recursive: true });
  return { root, dataRoot, projectPath };
}

/** The composer modules the send path really uses, loaded from source. */
async function loadComposer(t) {
  const server = await createServer({
    root: appRoot,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const editor = await server.ssrLoadModule("/src/features/chat/composer/editor.ts");
  const storeHelpers = await server.ssrLoadModule("/src/stores/helpers/store-helpers.ts");
  return { editor, storeHelpers };
}

/** What `useComposerSubmit` sends: chips serialized back to `@path` in place. */
function serializedPrompt(draftText, references) {
  return serializeInlineComposerFileReferences(draftText, references);
}

/** The draft reference + chip the renderer builds from one stored file. */
function chipFor(composer, sessionId, file, token) {
  const reference = composer.editor.createFileReference(file.path, file.name, sessionId, {
    kind: file.kind,
    mimeType: file.mimeType,
    token,
  });
  return {
    reference,
    draft: { path: reference.path, name: reference.name, kind: reference.kind, mimeType: reference.mimeType, token: reference.token },
  };
}

/**
 * One oversized text paste, exactly as `useComposerAttachments` performs it:
 * the Composer marks the payload `auto-text`, main files it in the session's
 * owned directory, and the draft gets one sentinel chip.
 */
async function pasteThroughComposer({ composer, dataRoot, sessionId, text, before = "", after = "" }) {
  const [saved] = await saveComposerPasteFiles(dataRoot, sessionId, [
    {
      name: "pasted-text-0f1e2d3c.txt",
      mimeType: "text/plain",
      recordHistory: true,
      origin: "auto-text",
      data: new TextEncoder().encode(text),
    },
  ]);
  const chip = chipFor(composer, sessionId, saved, composer.editor.nextChipToken());
  return {
    saved,
    reference: chip.reference,
    draftText: `${before}${chip.draft.token}${after}`,
    fileReferences: [chip.draft],
  };
}

/** A picked or dropped file, which always keeps its own name and origin. */
async function manualThroughComposer({
  root,
  composer,
  dataRoot,
  sessionId,
  name,
  text,
  before = "",
  after = "",
}) {
  const sourceDir = join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  const source = join(sourceDir, name);
  await writeFile(source, text);
  const [saved] = await importComposerFiles(dataRoot, sessionId, [source]);
  const chip = chipFor(composer, sessionId, saved, composer.editor.nextChipToken());
  return {
    saved,
    reference: chip.reference,
    draftText: `${before}${chip.draft.token}${after}`,
    fileReferences: [chip.draft],
  };
}

async function send({ dataRoot, projectPath, promptContent, attachments }) {
  return assembleTurnPrompt({
    dataRoot,
    sessionId,
    projectPath,
    promptContent,
    attachments,
    supportsVision: false,
  });
}

/** The full composer → store → send path for one reference list. */
async function sendDraft({ composer, dataRoot, projectPath, draftText, fileReferences }) {
  return send({
    dataRoot,
    projectPath,
    promptContent: serializedPrompt(draftText, fileReferences),
    attachments: composer.storeHelpers.promptAttachmentsFromDraft(fileReferences),
  });
}

test("a long paste reaches the model as its exact text, and the draft keeps one chip", async (t) => {
  const { dataRoot, projectPath } = await fixture(t);
  const composer = await loadComposer(t);
  const paste = await pasteThroughComposer({
    composer,
    dataRoot,
    sessionId,
    text: longPaste,
    before: "summarize ",
    after: " please",
  });

  // The store's attachment list drops a tokenized non-image chip: the prompt
  // text is the only place this paste survives, so hydration must work from it.
  assert.deepEqual(
    composer.storeHelpers.promptAttachmentsFromDraft(paste.fileReferences),
    [],
  );
  assert.match(
    paste.saved.path,
    new RegExp(`scratch/${sessionId}/${AUTO_PASTED_TEXT_DIR}/`),
    "the store files an automatic paste in the owned directory",
  );

  const promptContent = serializedPrompt(paste.draftText, paste.fileReferences);
  assert.ok(promptContent.includes(`@${paste.saved.path}`), "the sent text keeps the compact @path");
  assert.ok(!promptContent.includes("first line of the pasted report"));

  const { modelContent } = await sendDraft({
    composer,
    dataRoot,
    projectPath,
    draftText: paste.draftText,
    fileReferences: paste.fileReferences,
  });

  // The model sees the user's words at the chip's position, byte for byte.
  assert.equal(modelContent, `summarize ${longPaste} please`);
  assert.ok(!modelContent.includes(paste.saved.path), "no path the model would have to Read");
  for (const part of [
    "first line of the pasted report",
    "indented middle section with\ttabs and trailing spaces   ",
    "中文段落：粘貼的內容必須完整進入模型上下文。",
    "emoji 🧪🚀 and combining é (e + U+0301) and RTL العربية עברית",
    "last line of the pasted report",
  ]) {
    assert.ok(modelContent.includes(part), `missing pasted segment: ${part}`);
  }

  // The persisted message keeps what the renderer sent: one compact chip, no
  // paste body, so history and the transcript do not turn into a blob.
  assert.equal(promptContent, `summarize @${paste.saved.path} please`);
});

test("the pasted body keeps its own leading and trailing whitespace at either edge", async (t) => {
  const { dataRoot, projectPath } = await fixture(t);
  const composer = await loadComposer(t);
  const indented = "\n\n    first indented line\n  second line\n\n";
  const plain = "note before";

  // Paste only: the prompt is exactly the paste, newlines and indentation kept.
  const alone = await pasteThroughComposer({ composer, dataRoot, sessionId, text: indented });
  assert.equal(
    (await sendDraft({ composer, dataRoot, projectPath, ...alone })).modelContent,
    indented,
  );

  // Paste at the start, then at the end: only the user's own text around the
  // chip is trimmed, never the pasted bytes.
  const leading = await pasteThroughComposer({
    composer,
    dataRoot,
    sessionId,
    text: indented,
    after: " trailing words",
  });
  assert.equal(
    (await sendDraft({ composer, dataRoot, projectPath, ...leading })).modelContent,
    `${indented} trailing words`,
  );

  const trailing = await pasteThroughComposer({
    composer,
    dataRoot,
    sessionId,
    text: indented,
    before: "summary follows\n",
  });
  assert.equal(
    (await sendDraft({ composer, dataRoot, projectPath, ...trailing })).modelContent,
    `summary follows\n${indented}`,
  );

  // The established treatment of what the user typed still applies around it.
  const padded = await pasteThroughComposer({
    composer,
    dataRoot,
    sessionId,
    text: plain,
    before: "\n  ",
    after: "  ",
  });
  assert.equal(
    (await sendDraft({ composer, dataRoot, projectPath, ...padded })).modelContent,
    plain,
  );
});

test("a pasted body is never rescanned for @ references", async (t) => {
  const { dataRoot, projectPath } = await fixture(t);
  const composer = await loadComposer(t);
  const body = "read @/etc/hostname yourself, then @pasted.txt twice";
  const paste = await pasteThroughComposer({
    composer,
    dataRoot,
    sessionId,
    text: body,
    before: "verbatim:\n",
  });
  assert.equal(
    (await sendDraft({ composer, dataRoot, projectPath, ...paste })).modelContent,
    `verbatim:\n${body}`,
  );
});

test("queued delivery and retry re-derive the same text without duplicating it", async (t) => {
  const { dataRoot, projectPath } = await fixture(t);
  const composer = await loadComposer(t);
  const paste = await pasteThroughComposer({
    composer,
    dataRoot,
    sessionId,
    text: longPaste,
    before: "queued ",
  });
  const promptContent = serializedPrompt(paste.draftText, paste.fileReferences);
  const first = (await sendDraft({ composer, dataRoot, projectPath, ...paste })).modelContent;

  // A queued prompt stores the same serialized content and derives its
  // attachments again when it is delivered.
  const queuedDraft = { text: promptContent, fileReferences: paste.fileReferences };
  const queued = await send({
    dataRoot,
    projectPath,
    promptContent: queuedDraft.text,
    attachments: composer.storeHelpers.promptAttachmentsFromDraft(queuedDraft.fileReferences),
  });
  assert.equal(queued.modelContent, first);

  // Retry/edit re-sends the persisted row: compact content, no attachments.
  const retried = await send({
    dataRoot,
    projectPath,
    promptContent,
    attachments: composer.storeHelpers.promptAttachmentsFromMessage(undefined),
  });
  assert.equal(retried.modelContent, first);
  const occurrences = retried.modelContent.split("first line of the pasted report").length - 1;
  assert.equal(occurrences, 1, "the paste is inserted once, never twice");
});

test("short text and several pastes keep their own positions", async (t) => {
  const { dataRoot, projectPath } = await fixture(t);
  const composer = await loadComposer(t);
  const first = await pasteThroughComposer({
    composer,
    dataRoot,
    sessionId,
    text: "alpha pasted body",
    before: "compare ",
    after: " with ",
  });
  const [second] = await saveComposerPasteFiles(dataRoot, sessionId, [
    {
      name: "pasted-text-9f8e7d6c.txt",
      mimeType: "text/plain",
      recordHistory: true,
      origin: "auto-text",
      data: new TextEncoder().encode("beta pasted body"),
    },
  ]);
  const secondChip = chipFor(composer, sessionId, second, composer.editor.nextChipToken());
  const draftText = `${first.draftText}${secondChip.draft.token}!`;
  const fileReferences = [...first.fileReferences, secondChip.draft];
  const promptContent = serializedPrompt(draftText, fileReferences);
  const { modelContent } = await send({
    dataRoot,
    projectPath,
    promptContent,
    attachments: composer.storeHelpers.promptAttachmentsFromDraft(fileReferences),
  });
  // Each chip is replaced by its own paste, in the order the user placed them.
  const expected = promptContent
    .replace(`@${first.saved.path}`, "alpha pasted body")
    .replace(`@${second.path}`, "beta pasted body");
  assert.equal(modelContent, expected);
  const alpha = modelContent.indexOf("alpha pasted body");
  const beta = modelContent.indexOf("beta pasted body");
  assert.ok(alpha >= 0 && beta >= 0, "both pastes reach the model");
  assert.ok(alpha < beta, "the pastes keep the order the user typed");
});

test("the owned directory, not the file name, is the provenance", async (t) => {
  const { dataRoot, projectPath } = await fixture(t);
  const composer = await loadComposer(t);
  // The store's contract is origin-based: an automatic text paste is read back
  // whatever leaf name it carries.
  const [saved] = await saveComposerPasteFiles(dataRoot, sessionId, [
    {
      name: "report.txt",
      mimeType: "text/plain",
      origin: "auto-text",
      data: new TextEncoder().encode("renamed paste body"),
    },
  ]);
  const chip = chipFor(composer, sessionId, saved, composer.editor.nextChipToken());
  assert.equal(
    (
      await sendDraft({
        composer,
        dataRoot,
        projectPath,
        draftText: chip.draft.token,
        fileReferences: [chip.draft],
      })
    ).modelContent,
    "renamed paste body",
  );
});

test("a file the user picked keeps its own name and stays a reference", async (t) => {
  const { root, dataRoot, projectPath } = await fixture(t);
  const composer = await loadComposer(t);

  // The user's own file is literally named like an auto paste. The import keeps
  // its name and files it above the owned directory, so it is not read back.
  const manual = await manualThroughComposer({
    root,
    composer,
    dataRoot,
    sessionId,
    name: "pasted-text-abc.txt",
    text: "the user's own file",
  });
  assert.ok(
    !manual.saved.path.includes(`/${AUTO_PASTED_TEXT_DIR}/`),
    "a picked file never lands in the owned auto-text directory",
  );

  const auto = await pasteThroughComposer({
    composer,
    dataRoot,
    sessionId,
    text: "auto pasted body",
    before: "and ",
  });
  const draftText = `${manual.draftText}${auto.draftText}`;
  const fileReferences = [...manual.fileReferences, ...auto.fileReferences];
  const promptContent = serializedPrompt(draftText, fileReferences);
  const { modelContent } = await send({
    dataRoot,
    projectPath,
    promptContent,
    attachments: composer.storeHelpers.promptAttachmentsFromDraft(fileReferences),
  });

  // The picked file stays the `@path` the model may open itself; the automatic
  // paste beside it still arrives as text.
  assert.equal(
    modelContent,
    `@${manual.saved.path} and auto pasted body`,
  );

  // Sent on its own, the picked file is untouched.
  assert.equal(
    (await sendDraft({ composer, dataRoot, projectPath, ...manual })).modelContent,
    `@${manual.saved.path}`,
  );
});

test("a data root with @ or a space still resolves its paste", async (t) => {
  // `@` is an ordinary path character to the serializer, which quotes only on
  // whitespace; both shapes must survive marker parsing.
  for (const rootName of ["user@example.com", "user name"]) {
    const { dataRoot, projectPath } = await fixture(
      t,
      join(tmpdir(), `pi-auto-pasted-${rootName}-`),
    );
    const composer = await loadComposer(t);
    const paste = await pasteThroughComposer({
      composer,
      dataRoot,
      sessionId,
      text: `pasted under ${rootName}`,
    });
    assert.ok(
      paste.saved.path.includes(rootName),
      "the fixture path carries the character under test",
    );
    const promptContent = serializedPrompt(paste.draftText, paste.fileReferences);
    const { modelContent } = await send({
      dataRoot,
      projectPath,
      promptContent,
      attachments: composer.storeHelpers.promptAttachmentsFromDraft(paste.fileReferences),
    });
    assert.equal(modelContent, `pasted under ${rootName}`, rootName);
  }
});

test("a paste this turn cannot carry is reported, never silently dropped", async (t) => {
  const { dataRoot, projectPath } = await fixture(t);
  const pastedRoot = join(dataRoot, "scratch", sessionId, AUTO_PASTED_TEXT_DIR);
  await mkdir(pastedRoot, { recursive: true });
  const missing = join(pastedRoot, "pasted-missing.txt");

  // A file a scratch sweep or the user removed: the marker is a promise this
  // prompt carries the paste, so the send fails visibly instead of sending a
  // path the model would have to open.
  await assert.rejects(
    send({ dataRoot, projectPath, promptContent: `look @${missing}`, attachments: [] }),
    (error) => error.errorCode === "NOT_FOUND",
  );

  const oversized = join(pastedRoot, "pasted-huge.txt");
  await writeFile(oversized, "");
  await truncate(oversized, MAX_AUTO_PASTED_TEXT_BYTES + 1);
  await assert.rejects(
    send({ dataRoot, projectPath, promptContent: `look @${oversized}`, attachments: [] }),
    (error) => error.errorCode === "PAYLOAD_TOO_LARGE",
    "an over-limit paste is never truncated into a false prompt",
  );

  // The whole directory gone (a swept session) is the same failure, not a
  // silent fall back to the path.
  const sweptDataRoot = join(dataRoot, "swept");
  const sweptPath = join(
    sweptDataRoot,
    "scratch",
    sessionId,
    AUTO_PASTED_TEXT_DIR,
    "pasted-gone.txt",
  );
  await assert.rejects(
    send({ dataRoot: sweptDataRoot, projectPath, promptContent: `look @${sweptPath}`, attachments: [] }),
    (error) => {
      assert.equal(error.errorCode, "NOT_FOUND");
      assert.match(error.message, /paste directory is gone/);
      return true;
    },
  );
});

test("only this session's owned paste directory is read back", async (t) => {
  const { root, dataRoot, projectPath } = await fixture(t);
  const pastedRoot = join(dataRoot, "scratch", sessionId, AUTO_PASTED_TEXT_DIR);
  await mkdir(pastedRoot, { recursive: true });

  // A workspace file whose name merely looks like an auto paste.
  const workspaceCopy = join(
    projectPath,
    "pasted-0f1e2d3c-9f8e-7d6c-b5a4-3210fedcba98-pasted-text-0f1e2d3c.txt",
  );
  await writeFile(workspaceCopy, "workspace copy text");
  // A manual attachment in the paste store, one level above the owned directory.
  const manualCopy = join(dataRoot, "scratch", sessionId, "pasted", "pasted-text-abc.txt");
  await writeFile(manualCopy, "manual attachment text");
  // A paste file of another session.
  const otherSession = join(
    dataRoot,
    "scratch",
    "someone-else",
    AUTO_PASTED_TEXT_DIR,
    "pasted-0f1e2d3c-9f8e-7d6c-b5a4-3210fedcba98-pasted-text-0f1e2d3c.txt",
  );
  await mkdir(dirname(otherSession), { recursive: true });
  await writeFile(otherSession, "another session text");

  for (const path of [workspaceCopy, manualCopy, otherSession]) {
    const promptContent = `keep @${path} as a reference`;
    const { modelContent } = await send({
      dataRoot,
      projectPath,
      promptContent,
      attachments: [],
    });
    assert.equal(modelContent, promptContent, `must not read ${path}`);
  }

  // A symlink that leaves the owned directory is refused, not followed.
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside the session root");
  const escaping = join(pastedRoot, "pasted-escaping.txt");
  await symlink(outside, escaping);
  await assert.rejects(
    send({
      dataRoot,
      projectPath,
      promptContent: `look @${escaping}`,
      attachments: [],
    }),
    (error) => error.errorCode === "PATH_OUTSIDE_WORKSPACE",
    "a symlink out of the owned directory must never be read",
  );
});
