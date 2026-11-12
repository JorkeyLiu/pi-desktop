import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendPromptFallbackPaths, preparePromptAttachments } from "../electron/main/prompt-attachments.ts";

// The renderer mapper is the other half of a resend; its module graph uses the
// repository's extensionless TS imports, so the shared test resolver registers it.
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { promptAttachmentsFromMessage } = await import(
  "../src/stores/helpers/store-helpers.ts"
);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=",
  "base64",
);
const sessionId = "inline-placement";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-inline-attachments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const pasted = join(data, "scratch", sessionId, "pasted");
  await mkdir(pasted, { recursive: true });
  const path = join(pasted, "pasted-a.png");
  await writeFile(path, png);
  return { data, path };
}

test("an image the draft named inline records that text and keeps its place", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const content = `compare @${path} with the rest`;
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    content,
  );
  assert.equal(prepared.message.kind, "image");
  assert.equal(prepared.message.inlinePath, `@${path}`);
  assert.ok(prepared.inlineData);
  // The prompt already names the path where the user put it, so no copy follows.
  assert.equal(appendPromptFallbackPaths(content, [prepared]), content);
});

test("an image the prompt does not name inline is carried without a path", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    "look at this",
  );
  assert.equal(prepared.message.inlinePath, undefined);
  assert.deepEqual(Buffer.from(prepared.inlineData, "base64"), png);
  assert.equal(appendPromptFallbackPaths("look at this", [prepared]), "look at this");
});

test("a replayed copy is no longer appended for an inline image", async (t) => {
  const { data } = await fixture(t);
  const ref = `attachments/${"a".repeat(64)}`;
  await mkdir(join(data, "attachments"), { recursive: true });
  await writeFile(join(data, ref), png);
  const attachment = { path: ref, name: "a.png", kind: "image", mimeType: "image/png" };
  const content = `look @${ref}`;
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    content,
  );
  assert.equal(prepared.message.inlinePath, `@${ref}`);
  assert.deepEqual(Buffer.from(prepared.inlineData, "base64"), png);
  // The picture is an image block now, so the prompt keeps only the user's
  // text and never gains a second path copy.
  assert.equal(appendPromptFallbackPaths(content, [prepared]), content);
});

/**
 * The renderer half of a resend: a durable row is mapped back into prompt
 * attachment input. Placement is recorded metadata, so it survives the mapping
 * while the canonical blob ref keeps identifying the stored bytes.
 */
test("a resent message keeps its recorded inline placement and the canonical blob ref", async (t) => {
  const { data, path } = await fixture(t);
  const content = `compare @${path} with the rest`;
  const draft = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const [first] = await preparePromptAttachments(data, sessionId, undefined, [draft], content);
  assert.match(first.message.ref, /^attachments\/[0-9a-f]{64}$/);
  // The durable user row main persists for this turn.
  const durable = [first.message];
  const resent = promptAttachmentsFromMessage(durable);
  assert.equal(resent[0].path, first.message.ref);
  assert.equal(resent[0].inlinePath, `@${path}`);
  const [again] = await preparePromptAttachments(data, sessionId, undefined, resent, content);
  assert.equal(again.message.ref, first.message.ref, "the stored blob keeps identifying the image");
  assert.equal(again.message.inlinePath, `@${path}`, "the original marker stays the placement");
  assert.deepEqual(Buffer.from(again.inlineData, "base64"), png);
  assert.equal(appendPromptFallbackPaths(content, [again]), content);
});

test("a resent message carries its image once and never the blob ref as text", async (t) => {
  const { data, path } = await fixture(t);
  const content = `compare @${path} with the rest`;
  const draft = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const [first] = await preparePromptAttachments(data, sessionId, undefined, [draft], content);
  const resent = promptAttachmentsFromMessage([first.message]);
  const [again] = await preparePromptAttachments(data, sessionId, undefined, resent, content);
  const text = appendPromptFallbackPaths(content, [again]);
  assert.equal(again.message.inlinePath, `@${path}`);
  assert.deepEqual(Buffer.from(again.inlineData, "base64"), png);
  assert.ok(text.startsWith(content));
  assert.ok(!text.includes(again.message.ref), "the blob ref is not offered to the model");
});

test("an edit that removes the marker keeps the image trailing", async (t) => {
  const { data, path } = await fixture(t);
  const draft = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const [first] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [draft],
    `compare @${path} with the rest`,
  );
  const resent = promptAttachmentsFromMessage([first.message]);
  const [again] = await preparePromptAttachments(data, sessionId, undefined, resent, "compare the rest");
  assert.equal(again.message.inlinePath, undefined, "a prompt that no longer names it cannot place it");
  assert.equal(again.message.ref, first.message.ref, "the image still travels with the edited prompt");
});

test("a placement that is not one @path chip cannot claim prompt text", async (t) => {
  const { data, path } = await fixture(t);
  const [first] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [{ path, name: "pasted-a.png", kind: "image", mimeType: "image/png" }],
    `compare @${path} with the rest`,
  );
  const resent = promptAttachmentsFromMessage([{ ...first.message, inlinePath: "with the rest" }]);
  const [again] = await preparePromptAttachments(data, sessionId, undefined, resent, `compare @${path} with the rest`);
  assert.equal(again.message.inlinePath, undefined);
});
