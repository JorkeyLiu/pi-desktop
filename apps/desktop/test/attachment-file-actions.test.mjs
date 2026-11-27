import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readMainModule } from "./helpers/main-source.mjs";
import { resolveSaveCopyTarget } from "../electron/main/save-copy-target.ts";
import {
  isAttachmentBlobRef,
  resolveRealOpenablePath,
} from "../../../packages/host-runtime/src/workspace-files.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [protocol, api, panel, filesTab, enCatalog] = await Promise.all([
  read("../../../packages/shared/src/protocol.ts"),
  read("../src/lib/api.ts"),
  readMainModule("ipc/workspace-ipc.ts"),
  read("../src/components/workpanel/FilesTab.tsx"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
]);

test("renderer and main share a contained save-a-copy channel", () => {
  assert.match(protocol, /fsSaveCopy: "pi-desktop\/fs\/saveCopy"/);
  assert.match(api, /fsSaveCopy: \(path: string[^)]*\) =>/);
  assert.match(api, /IPC\.invoke\.fsSaveCopy/);
  assert.match(panel, /handle\(IPC\.invoke\.fsSaveCopy/);
  assert.match(panel, /dialog\.showSaveDialog\(/);
  assert.match(panel, /copyFile\(/);
});

test("save-a-copy never executes the file and stays inside allowed roots", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-save-copy-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "workspace");
  const stores = [join(fixture, "scratch"), join(fixture, "attachments")];
  await Promise.all([mkdir(root, { recursive: true }), ...stores.map((dir) => mkdir(dir, { recursive: true }))]);
  await writeFile(join(root, "note.md"), "hello\n");
  const deps = {
    isLocalStoredFile: async (ref) => isAttachmentBlobRef(ref),
    remoteFileWorkspace: async () => null,
    optionalWorkspaceRoot: async () => root,
    fsExtraRoots: async () => stores,
    resolveRealOpenablePath,
  };

  const kept = await resolveSaveCopyTarget("note.md", undefined, deps);
  assert.equal(kept.ok, true);
  assert.equal(kept.target, await realpath(join(root, "note.md")));

  const escaped = await resolveSaveCopyTarget("../outside.md", undefined, deps);
  assert.equal(escaped.ok, false);
  assert.match(escaped.reason, /allowed roots/);

  const missing = await resolveSaveCopyTarget("absent.md", undefined, deps);
  assert.equal(missing.ok, false);

  await writeFile(join(fixture, "outside.md"), "outside\n");
  const absolute = await resolveSaveCopyTarget(join(fixture, "outside.md"), undefined, deps);
  assert.equal(absolute.ok, false);

  const remoteDeps = { ...deps, remoteFileWorkspace: async () => ({ host: "remote" }) };
  const remoteBlocked = await resolveSaveCopyTarget("note.md", "remote:1", remoteDeps);
  assert.equal(remoteBlocked.ok, false);
  assert.match(remoteBlocked.reason, /remote/);

  await writeFile(join(stores[1], "b".repeat(64)), "blob\n");
  const blobKept = await resolveSaveCopyTarget(`attachments/${"b".repeat(64)}`, "remote:1", {
    ...remoteDeps,
    optionalWorkspaceRoot: async () => null,
  });
  assert.equal(blobKept.ok, true);

  const handler = panel.slice(panel.indexOf("handle(IPC.invoke.fsSaveCopy"));
  assert.doesNotMatch(handler.slice(0, handler.indexOf("});") + 3), /shell\.openPath/);
});

test("binary, oversized, and failed previews offer download and external open", () => {
  assert.match(filesTab, /canSaveCopySelected\(remote, selected\)/);
  assert.match(filesTab, /api\.fsSaveCopy\(/);
  assert.match(filesTab, /canSaveCopy \? \(\s*\n?\s*<Button type="button" onClick=\{\(\) => void saveCopy\(\)\}>/);
  assert.match(filesTab, /remote && !canSaveCopy/);
  assert.match(filesTab, /\.tooLarge/);
  assert.match(filesTab, /fileError \?/);
  // External open stays local-only and allowlisted; remote never reaches shell.
  assert.match(filesTab, /!remote/);
  assert.match(filesTab, /api\.fsOpen\(/);
  assert.match(filesTab, /panel\.files\.remoteUnavailable/);
  assert.match(enCatalog, /download: "/);
  assert.match(enCatalog, /saveFailed: "/);
  assert.match(enCatalog, /remoteUnavailable: "/);
});
