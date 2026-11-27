import assert from "node:assert/strict";
import test from "node:test";
import {
  canSaveCopySelected,
  isLocallyStoredAttachmentRef,
} from "../src/lib/save-copy-gate.ts";

const BLOB = `attachments/${"a".repeat(64)}`;

test("only content-addressed attachment blobs count as locally stored", () => {
  assert.equal(isLocallyStoredAttachmentRef(BLOB), true);
  assert.equal(isLocallyStoredAttachmentRef(`attachments/${"A".repeat(64)}`), true);
  assert.equal(isLocallyStoredAttachmentRef("attachments/abc"), false);
  assert.equal(isLocallyStoredAttachmentRef("docs/photo.png"), false);
  assert.equal(isLocallyStoredAttachmentRef("/data/scratch/1/pasted/a.png"), false);
  assert.equal(isLocallyStoredAttachmentRef(""), false);
});

test("local sessions may save any selected path", () => {
  assert.equal(canSaveCopySelected(undefined, "docs/photo.png"), true);
  assert.equal(canSaveCopySelected(null, "docs/photo.png"), true);
  assert.equal(canSaveCopySelected(false, BLOB), true);
  assert.equal(canSaveCopySelected(undefined, null), false);
  assert.equal(canSaveCopySelected(undefined, ""), false);
});

test("remote sessions only keep save-a-copy for locally stored blobs", () => {
  const remote = { host: "remote" };
  assert.equal(canSaveCopySelected(remote, BLOB), true);
  assert.equal(canSaveCopySelected(remote, "docs/photo.png"), false);
  assert.equal(canSaveCopySelected(remote, "/data/scratch/1/pasted/a.png"), false);
  assert.equal(canSaveCopySelected(remote, null), false);
});
