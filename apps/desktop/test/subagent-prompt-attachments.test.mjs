import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_SUBAGENT_INLINE_ATTACHMENTS,
  prepareSubagentPromptAttachments,
} from "../electron/main/prompt-attachments.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=",
  "base64",
);
const sessionId = "subagent-attachments";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-attachments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const scratch = join(data, "scratch", sessionId);
  await mkdir(scratch, { recursive: true });
  return { root, data, scratch };
}

function image(path, overrides = {}) {
  return { path, name: "shot.png", kind: "image", mimeType: "image/png", ...overrides };
}

async function rejectsWith(promise, errorCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.errorCode, errorCode, error.message);
    return true;
  });
}

test("stores a validated child input image as a content-addressed ref", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "shot.png");
  await writeFile(path, png);
  const [prepared] = await prepareSubagentPromptAttachments(
    data,
    sessionId,
    undefined,
    [image(path)],
    "",
  );
  assert.equal(prepared.message.kind, "image");
  assert.equal(prepared.message.mimeType, "image/png");
  assert.match(prepared.message.ref, /^attachments\/[0-9a-f]{64}$/);
  assert.equal(prepared.message.size, png.length);
  assert.equal(prepared.data, png.toString("base64"));
  // No inline placement when the prompt never named the path.
  assert.equal(prepared.message.inlinePath, undefined);
});

test("refuses a path outside the session roots", async (t) => {
  const { root, data } = await fixture(t);
  const outside = join(root, "outside.png");
  await writeFile(outside, png);
  await rejectsWith(
    prepareSubagentPromptAttachments(data, sessionId, undefined, [image(outside)], ""),
    "PATH_OUTSIDE_WORKSPACE",
  );
});

test("refuses a file whose bytes are not an image even when it claims .png", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "renamed.png");
  await writeFile(path, "this is not an image");
  await rejectsWith(
    prepareSubagentPromptAttachments(data, sessionId, undefined, [image(path)], ""),
    "UNSUPPORTED",
  );
});

test("refuses a non-image attachment kind", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "notes.txt");
  await writeFile(path, "hello");
  await rejectsWith(
    prepareSubagentPromptAttachments(
      data,
      sessionId,
      undefined,
      [{ path, name: "notes.txt", kind: "file", mimeType: "text/plain" }],
      "",
    ),
    "UNSUPPORTED",
  );
});

test(`refuses more than ${MAX_SUBAGENT_INLINE_ATTACHMENTS} images in one input`, async (t) => {
  const { data, scratch } = await fixture(t);
  const attachments = [];
  for (let index = 0; index <= MAX_SUBAGENT_INLINE_ATTACHMENTS; index++) {
    const path = join(scratch, `shot-${index}.png`);
    await writeFile(path, png);
    attachments.push(image(path));
  }
  await rejectsWith(
    prepareSubagentPromptAttachments(data, sessionId, undefined, attachments, ""),
    "INVALID_ARGUMENT",
  );
});

test("refuses one image above the 10 MB inline bound", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "huge.png");
  await writeFile(path, "");
  await truncate(path, 10_000_001);
  await rejectsWith(
    prepareSubagentPromptAttachments(data, sessionId, undefined, [image(path)], ""),
    "PAYLOAD_TOO_LARGE",
  );
});

test("refuses a total above the 30 MB inline budget", async (t) => {
  const { data, scratch } = await fixture(t);
  const attachments = [];
  // Four ~8 MB images: each is under the per-image bound, together over total.
  // Real PNG headers on an 8 MB body: the per-file checks pass, so only the
  // aggregate budget can refuse this input.
  const bigPng = Buffer.alloc(8_000_000);
  png.copy(bigPng, 0);
  for (let index = 0; index < 4; index++) {
    const path = join(scratch, `big-${index}.png`);
    await writeFile(path, bigPng);
    attachments.push(image(path));
  }
  await rejectsWith(
    prepareSubagentPromptAttachments(data, sessionId, undefined, attachments, ""),
    "PAYLOAD_TOO_LARGE",
  );
});
