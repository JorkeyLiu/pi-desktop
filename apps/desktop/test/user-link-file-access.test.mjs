import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/src/protocol.ts";
import { isAbsoluteFilePath } from "../src/lib/chat-links.ts";
import { guardRemoteInvocation } from "../src/lib/remote-ipc-safety.ts";
import {
  createWorkPanelFileRequest,
  fileWorkPanelTab,
  isWindowsAbsolutePath,
  normalizeWorkPanelFilePath,
} from "../src/lib/work-panel-tabs.ts";
import {
  assertLocalUserLinkSession,
  readUserLink,
  resolveUserLinkCopyTarget,
} from "../electron/main/user-link-file.ts";
import { readMainModule } from "./helpers/main-source.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [api, panel, hook, filesTab, pluginPanel, remoteSafety, persistence] = await Promise.all([
  read("../src/lib/api.ts"),
  readMainModule("ipc/workspace-ipc.ts"),
  read("../src/hooks/use-preview-target.ts"),
  read("../src/components/workpanel/FilesTab.tsx"),
  readMainModule("plugin-panel-host.ts"),
  read("../src/lib/remote-ipc-safety.ts"),
  read("../src/lib/work-panel-persistence.ts"),
]);

const READ_CHANNEL = "pi-desktop/fs/readUserLink";
const SAVE_COPY_CHANNEL = "pi-desktop/fs/saveCopyUserLink";

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && path.endsWith(".ts") ? [path] : [];
      }),
  );
  return nested.flat();
}

async function assertNoUserLinkReferences(directories, label) {
  const hits = [];
  for (const directory of directories) {
    for (const path of await sourceFiles(fileURLToPath(new URL(directory, import.meta.url)))) {
      if (path.endsWith(".test.ts")) continue;
      const source = await readFile(path, "utf8");
      for (const token of [
        "fsReadUserLink",
        "fsSaveCopyUserLink",
        "readUserLinkFile",
        "resolveUserLinkTarget",
        "resolveUserLinkCopyTarget",
        "fs/readUserLink",
        "fs/saveCopyUserLink",
      ]) {
        if (source.includes(token)) hits.push(`${path}: ${token}`);
      }
    }
  }
  assert.deepEqual(hits, [], `${label} must never reference the user-link capability`);
}

test("protocol exposes a dedicated user-link capability beside the contained channels", () => {
  assert.equal(IPC.invoke.fsReadUserLink, READ_CHANNEL);
  assert.equal(IPC.invoke.fsSaveCopyUserLink, SAVE_COPY_CHANNEL);
  assert.notEqual(IPC.invoke.fsReadUserLink, IPC.invoke.fsRead);
  assert.notEqual(IPC.invoke.fsSaveCopyUserLink, IPC.invoke.fsSaveCopy);
  // The preload gates every invoke through the whitelist, which covers all
  // registered invoke channels — no separate generic channel is exposed.
  assert.equal(IPC_WHITELIST.has(READ_CHANNEL), true);
  assert.equal(IPC_WHITELIST.has(SAVE_COPY_CHANNEL), true);
});

test("renderer reaches outside-root files only through the user-link channels", () => {
  assert.match(api, /fsReadUserLink: \(path: string[^)]*\) =>/);
  assert.match(api, /IPC\.invoke\.fsReadUserLink/);
  assert.match(api, /fsSaveCopyUserLink: \(path: string[^)]*\) =>/);
  assert.match(api, /IPC\.invoke\.fsSaveCopyUserLink/);
  for (const name of ["fsReadUserLink", "fsSaveCopyUserLink"]) {
    assert.equal(remoteSafety.includes(`IPC.invoke.${name}`), true);
  }
});

test("user-link channels are main-window-only and remote sessions stay local", async (t) => {
  for (const channel of ["IPC.invoke.fsReadUserLink", "IPC.invoke.fsSaveCopyUserLink"]) {
    const at = panel.indexOf(`handleWithEvent(\n    ${channel},`);
    assert.notEqual(at, -1, `${channel} must register with handleWithEvent`);
    const block = panel.slice(at, at + 900);
    assert.match(block, /assertMainWindowSender\(event\)/);
  }
  // The contained handlers never touch the user-link capability: no old
  // channel grows a bypass around containment.
  assert.doesNotMatch(panel, /readUserLinkFile/);
  assert.doesNotMatch(panel, /resolveUserLinkTarget/);

  const fixture = await mkdtemp(join(tmpdir(), "pi-user-link-main-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(join(fixture, "note.md"), "hello user link\n");
  const local = { remoteFileWorkspace: async () => null };

  const result = await readUserLink(join(fixture, "note.md"), undefined, local);
  assert.equal(result.kind, "text");

  const remote = { remoteFileWorkspace: async () => ({ host: "remote" }) };
  await assert.rejects(() => readUserLink(join(fixture, "note.md"), "remote:1", remote), /remote/);
  await assert.rejects(
    () => assertLocalUserLinkSession("remote:1", remote),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  const refused = await resolveUserLinkCopyTarget(join(fixture, "note.md"), "remote:1", remote);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /remote/);
});

test("save-a-copy re-validates the user-link source instead of trusting bytes", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-user-link-copy-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const local = { remoteFileWorkspace: async () => null };

  await writeFile(join(fixture, "note.md"), "copy me\n");
  const kept = await resolveUserLinkCopyTarget(join(fixture, "note.md"), undefined, local);
  assert.equal(kept.ok, true);
  assert.equal(kept.target, await realpath(join(fixture, "note.md")));

  await mkdir(join(fixture, "dir"));
  assert.equal((await resolveUserLinkCopyTarget(join(fixture, "dir"), undefined, local)).ok, false);
  assert.equal(
    (await resolveUserLinkCopyTarget(join(fixture, "absent.md"), undefined, local)).ok,
    false,
  );
  assert.equal((await resolveUserLinkCopyTarget("", undefined, local)).ok, false);
  assert.equal(
    (await resolveUserLinkCopyTarget("relative/note.md", undefined, local)).ok,
    false,
  );
});

test("remote renderers cannot invoke the user-link channels", () => {
  for (const channel of [READ_CHANNEL, SAVE_COPY_CHANNEL]) {
    assert.throws(
      () => guardRemoteInvocation(channel, { sessionId: "remote:1" }),
      (error) => error.code === "CAPABILITY_UNAVAILABLE",
    );
    assert.doesNotThrow(() => guardRemoteInvocation(channel, { sessionId: "local:1" }));
  }
});

test("chat absolute paths resolve as user links, never as guessed references", () => {
  assert.equal(isAbsoluteFilePath("/tmp/outside/note.md"), true);
  assert.equal(isAbsoluteFilePath("C:\\Users\\x\\note.md"), true);
  assert.equal(isAbsoluteFilePath("\\\\host\\share\\note.md"), true);
  assert.equal(isAbsoluteFilePath("relative/note.md"), false);
  assert.equal(isAbsoluteFilePath("~/note.md"), false);
  assert.equal(isAbsoluteFilePath(""), false);

  // An absolute path outside every allowed root becomes a user-link target
  // with no restriction report; other misses keep their existing copy.
  assert.match(hook, /result\.reason === "outside-allowed-roots"/);
  assert.match(hook, /\{ kind: "userLink"/);
  assert.match(hook, /openFile\(target\.path, mimeType, \{ line, column \}, \{ userLink: true \}\)/);
  assert.match(hook, /chat\.fileRefRestricted/);
});

test("tool entries keep the access limit for outside-root paths", () => {
  // Tool rows name agent-chosen paths: the tool opener disables the chat
  // user-link route, so the same outside path keeps the restriction report.
  assert.match(hook, /openFileRef\(/);
  assert.match(hook, /\{ allowUserLink: false \}/);
  assert.match(hook, /options\?: \{ allowUserLink\?: boolean \}/);
  assert.match(hook, /allowUserLink === false/);
  const guard = hook.slice(hook.indexOf("allowUserLink === false"));
  assert.match(guard, /chat\.fileRefRestricted/);
  assert.equal(hook.match(/allowUserLink: false/g)?.length, 1);
});

test("file tabs carry and restore user-link mode", () => {
  const tab = fileWorkPanelTab("/tmp/outside/note.md", "text/markdown", undefined, { userLink: true });
  assert.equal(tab.userLink, true);
  const request = createWorkPanelFileRequest(tab, 7);
  assert.equal(request?.userLink, true);

  const plain = fileWorkPanelTab("/tmp/outside/note.md");
  assert.equal(plain.userLink, undefined);
  assert.equal("userLink" in (createWorkPanelFileRequest(plain, 8) ?? {}), false);

  // Restart restoration keeps the mode so a refocused tab re-opens through
  // the user-link channels exactly as before the restart.
  assert.equal(persistence.includes("raw.userLink === true"), true);
  assert.equal(persistence.includes("userLink: true as const"), true);
});

test("user-link failures report the accurate cause in every locale", async () => {
  assert.match(filesTab, /fsReadUserLink/);
  assert.match(filesTab, /fsSaveCopyUserLink/);
  assert.match(filesTab, /chat\.fileUserLinkMissing/);
  assert.match(filesTab, /chat\.fileUserLinkNotFile/);
  assert.match(filesTab, /chat\.fileUserLinkFailed/);

  for (const locale of ["en", "de", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"]) {
    const catalog = await read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    for (const key of ["fileUserLinkMissing", "fileUserLinkNotFile", "fileUserLinkFailed"]) {
      assert.match(catalog, new RegExp(`"?${key}"?:[^\\n]*\\{\\{name\\}\\}`), `${locale} must translate ${key}`);
    }
  }
});

test("plugins and agents cannot reach the user-link capability", async () => {
  assert.doesNotMatch(pluginPanel, /readUserLink/);
  assert.doesNotMatch(pluginPanel, /fs\/readUserLink/);
  assert.doesNotMatch(pluginPanel, /fs\/saveCopyUserLink/);
  await assertNoUserLinkReferences(
    [
      "../../../packages/agent-runtime/src/",
      "../../../packages/plugin-sdk/src/",
    ],
    "agent and plugin SDK sources",
  );
  const mainRoot = fileURLToPath(new URL("../electron/main/", import.meta.url));
  const hits = [];
  for (const path of await sourceFiles(mainRoot)) {
    if (
      path.endsWith("user-link-file.ts") ||
      path.endsWith("workspace-ipc.ts") ||
      path.endsWith(".test.ts")
    ) {
      continue;
    }
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!/^(plugin|agent)-/.test(name) && name !== "plugin-panel-host.ts") continue;
    const source = await readFile(path, "utf8");
    for (const token of ["fsReadUserLink", "fsSaveCopyUserLink", "readUserLinkFile", "user-link-file"]) {
      if (source.includes(token)) hits.push(`${path}: ${token}`);
    }
  }
  assert.deepEqual(hits, [], "agent and plugin main sources must never reference the user-link capability");
});

test("user-link tabs keep Windows-absolute spellings verbatim (F-01)", () => {
  // A UNC prefix must survive: segment normalization folds `\\` into `/host`
  // and produces an address the host can never resolve.
  const unc = String.raw`\\host\share\docs\note.md`;
  assert.equal(isWindowsAbsolutePath(unc), true);
  const tab = fileWorkPanelTab(unc, "text/plain", undefined, { userLink: true });
  assert.equal(tab.resource, unc);
  assert.equal(tab.id, `file:${unc}`);
  assert.equal(tab.userLink, true);

  for (const drive of [String.raw`C:\Users\x\note.md`, "C:/Users/x/note.md"]) {
    assert.equal(isWindowsAbsolutePath(drive), true);
    const driveTab = fileWorkPanelTab(drive, "text/plain", undefined, { userLink: true });
    assert.equal(driveTab.resource, drive);
    assert.equal(driveTab.userLink, true);
  }

  // An already slash-folded UNC spelling is still Windows-absolute.
  const slashUnc = "//host/share/docs/note.md";
  assert.equal(isWindowsAbsolutePath(slashUnc), true);
  assert.equal(fileWorkPanelTab(slashUnc, undefined, undefined, { userLink: true }).resource, slashUnc);

  // POSIX user-link paths still normalize segments.
  assert.equal(isWindowsAbsolutePath("/tmp/outside/note.md"), false);
  assert.equal(
    fileWorkPanelTab("/tmp/../tmp/outside/./note.md", undefined, undefined, { userLink: true }).resource,
    "/tmp/outside/note.md",
  );

  // Relative paths normalize identically with and without the user-link flag.
  assert.equal(fileWorkPanelTab("docs/../note.md").resource, "note.md");
  assert.equal(fileWorkPanelTab("docs/../note.md", undefined, undefined, { userLink: true }).resource, "note.md");

  // The bypass is user-link-scoped: other Windows spellings normalize as before.
  assert.equal(
    fileWorkPanelTab(String.raw`C:\Users\x\..\y\note.md`).resource,
    normalizeWorkPanelFilePath(String.raw`C:\Users\x\..\y\note.md`),
  );
});

/**
 * True persist-restore round-trip through the real persistence module.
 * The persistence module imports its siblings with extensionless ids, so it
 * is transpiled to CJS and evaluated against the real transpiled siblings
 * (same pattern as tool-row-file-refs.test.mjs).
 */
function loadCjsModule(relative, imports) {
  const url = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const workPanelPersistence = loadCjsModule("../src/lib/work-panel-persistence.ts", {
  "./work-panel-tabs": loadCjsModule("../src/lib/work-panel-tabs.ts", {}),
  "./work-panel-resize": loadCjsModule("../src/lib/work-panel-resize.ts", {}),
});

test("user-link UNC tabs survive persist-restore verbatim (F-01)", () => {
  const unc = String.raw`\\host\share\docs\note.md`;
  const restored = workPanelPersistence.restoreWorkPanelTab({
    id: `file:${unc}`,
    kind: "file",
    resource: unc,
    userLink: true,
  });
  assert.equal(restored?.resource, unc);
  assert.equal(restored?.id, `file:${unc}`);
  assert.equal(restored?.userLink, true);

  // A legacy mangled record (single-slash prefix, surviving backslashes)
  // fails the predicate and normalizes exactly as before the fix.
  const legacy = "/host\\share\\note.md";
  assert.equal(isWindowsAbsolutePath(legacy), false);
  const restoredLegacy = workPanelPersistence.restoreWorkPanelTab({
    id: `file:${legacy}`,
    kind: "file",
    resource: legacy,
    userLink: true,
  });
  assert.equal(restoredLegacy?.resource, normalizeWorkPanelFilePath(legacy));
  assert.equal(restoredLegacy?.userLink, true);
});
