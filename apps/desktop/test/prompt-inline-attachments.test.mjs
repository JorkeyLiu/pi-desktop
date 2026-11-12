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
    true,
    content,
  );
  assert.equal(prepared.message.kind, "image");
  assert.equal(prepared.message.inlinePath, `@${path}`);
  assert.ok(prepared.inlineData);
  // The prompt already names the path where the user put it, so no copy follows.
  assert.equal(appendPromptFallbackPaths(content, [prepared]), content);
});

test("an image the prompt does not name inline keeps the trailing position", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    false,
    "look at this",
  );
  assert.equal(prepared.message.inlinePath, undefined);
  assert.equal(prepared.inlineData, undefined);
  const text = appendPromptFallbackPaths("look at this", [prepared]);
  assert.ok(text.startsWith("look at this"));
  assert.ok(text.includes(path));
});

test("a replayed copy still travels for the path the prompt names", async (t) => {
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
    false,
    content,
  );
  assert.equal(prepared.message.inlinePath, `@${ref}`);
  const text = appendPromptFallbackPaths(content, [prepared]);
  assert.ok(text.startsWith(content));
  // The stored blob is replayed into scratch, so that working path is added.
  assert.notEqual(prepared.fallbackPath, ref);
  assert.ok(text.includes(prepared.fallbackPath));
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
  const [first] = await preparePromptAttachments(data, sessionId, undefined, [draft], true, content);
  assert.match(first.message.ref, /^attachments\/[0-9a-f]{64}$/);
  // The durable user row main persists for this turn.
  const durable = [first.message];
  const resent = promptAttachmentsFromMessage(durable);
  assert.equal(resent[0].path, first.message.ref);
  assert.equal(resent[0].inlinePath, `@${path}`);
  const [again] = await preparePromptAttachments(data, sessionId, undefined, resent, true, content);
  assert.equal(again.message.ref, first.message.ref, "the stored blob keeps identifying the image");
  assert.equal(again.message.inlinePath, `@${path}`, "the original marker stays the placement");
  assert.ok(again.inlineData);
  assert.equal(appendPromptFallbackPaths(content, [again]), content);
});

test("a resend on a non-vision model keeps one placement and one readable copy", async (t) => {
  const { data, path } = await fixture(t);
  const content = `compare @${path} with the rest`;
  const draft = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const [first] = await preparePromptAttachments(data, sessionId, undefined, [draft], false, content);
  const resent = promptAttachmentsFromMessage([first.message]);
  const [again] = await preparePromptAttachments(data, sessionId, undefined, resent, false, content);
  assert.equal(again.message.inlinePath, `@${path}`);
  assert.equal(again.inlineData, undefined);
  const text = appendPromptFallbackPaths(content, [again]);
  assert.ok(text.startsWith(content));
  assert.equal(text.split(again.fallbackPath).length - 1, 1, "the replayed copy travels once");
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
    true,
    `compare @${path} with the rest`,
  );
  const resent = promptAttachmentsFromMessage([first.message]);
  const [again] = await preparePromptAttachments(data, sessionId, undefined, resent, true, "compare the rest");
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
    true,
    `compare @${path} with the rest`,
  );
  const resent = promptAttachmentsFromMessage([{ ...first.message, inlinePath: "with the rest" }]);
  const [again] = await preparePromptAttachments(data, sessionId, undefined, resent, true, `compare @${path} with the rest`);
  assert.equal(again.message.inlinePath, undefined);
});
