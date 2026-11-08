import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  builderConfigArguments,
  planChecksumOverride,
  readDesktopBuilderConfig,
  readInstalledElectronRelease,
  removeBuilderConfigFile,
  writeBuilderConfigFile,
} from "../../../scripts/electron-artifact-checksums.mjs";

const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
const ZIP_SHA256 = "5183a2b15d013517386edd9f1ea8e3402755f6c3ea17893f92acb20052f3a2e7";
const RELEASE = {
  version: "43.6.0",
  checksums: { "electron-v43.6.0-darwin-arm64.zip": ZIP_SHA256 },
};

async function makeDesktopDir({ version = "43.6.0", manifest = {}, installed = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-electron-release-"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "fake-desktop", devDependencies: { electron: `^${version}` } }),
  );
  if (installed) {
    const electronDir = path.join(directory, "node_modules", "electron");
    await mkdir(electronDir, { recursive: true });
    await writeFile(
      path.join(electronDir, "package.json"),
      JSON.stringify({ name: "electron", version }),
    );
    await writeFile(path.join(electronDir, "checksums.json"), JSON.stringify(manifest));
  }
  return directory;
}

test("reads the published checksums of the installed Electron release", async () => {
  const directory = await makeDesktopDir({
    manifest: {
      "electron-v43.6.0-darwin-arm64.zip": ZIP_SHA256,
      "ffmpeg-v43.6.0-darwin-arm64.zip": "not-a-checksum",
      "electron-api.json": "1".repeat(64),
    },
  });
  try {
    const release = await readInstalledElectronRelease(directory);
    assert.equal(release.version, "43.6.0");
    assert.deepEqual(Object.keys(release.checksums).sort(), [
      "electron-api.json",
      "electron-v43.6.0-darwin-arm64.zip",
    ]);
    assert.equal(release.checksums["electron-v43.6.0-darwin-arm64.zip"], ZIP_SHA256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stays out of the way when Electron is not installed", async () => {
  const directory = await makeDesktopDir({ installed: false });
  try {
    assert.equal(await readInstalledElectronRelease(directory), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stays out of the way when the manifest carries no usable checksum", async () => {
  const directory = await makeDesktopDir({
    manifest: { "electron-v43.6.0-darwin-arm64.zip": "nope" },
  });
  try {
    assert.equal(await readInstalledElectronRelease(directory), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adds the published checksums when the config declares no electronDownload", () => {
  const config = { appId: "net.aiuo.pi-desktop", directories: { output: "release" } };
  const plan = planChecksumOverride({ config, release: RELEASE });

  assert.equal(plan.reason, null);
  assert.equal(plan.config.appId, config.appId);
  assert.deepEqual(plan.config.directories, config.directories);
  assert.deepEqual(plan.config.electronDownload, {
    force: false,
    checksums: RELEASE.checksums,
  });
  // A truthy `force` would make @electron/get write-only and discard the cache.
  assert.equal(plan.config.electronDownload.force, false);
});

test("adds the published checksums to an electronDownload that already uses the get shape", () => {
  const plan = planChecksumOverride({
    config: { appId: "net.aiuo.pi-desktop", electronDownload: { unsafelyDisableChecksums: false } },
    release: RELEASE,
  });

  assert.equal(plan.reason, null);
  assert.deepEqual(plan.config.electronDownload, {
    unsafelyDisableChecksums: false,
    force: false,
    checksums: RELEASE.checksums,
  });
});

test("keeps builder's own resolution and explains why for incompatible electronDownload shapes", () => {
  const cases = [
    {
      electronDownload: { mirrorOptions: { mirror: "https://example.test/electron/" } },
      reason: /mirrorOptions.*drop the checksums/,
    },
    { electronDownload: { cache: "/tmp/electron-cache" }, reason: /legacy electron-download/ },
    {
      electronDownload: { customDir: "v43.6.0", customFilename: "electron.zip" },
      reason: /customDir, customFilename/,
    },
    { electronDownload: { mirror: "https://example.test/electron/" }, reason: /legacy/ },
    { electronDownload: { checksums: { "other.zip": ZIP_SHA256 } }, reason: /own checksums/ },
    { electronDownload: { force: true }, reason: /fresh download/ },
    { electronDownload: { unsafelyDisableChecksums: true }, reason: /turns validation off/ },
    { electronDownload: "https://example.test/", reason: /not an options object/ },
  ];

  for (const { electronDownload, reason } of cases) {
    const plan = planChecksumOverride({
      config: { appId: "net.aiuo.pi-desktop", electronDownload },
      release: RELEASE,
    });
    assert.equal(plan.config, null, `expected a skip for ${JSON.stringify(electronDownload)}`);
    assert.match(plan.reason, reason);
  }
});

test("keeps builder's own resolution when Electron sources are pinned elsewhere", () => {
  const config = { appId: "net.aiuo.pi-desktop" };

  const missingConfig = planChecksumOverride({ config: null, release: RELEASE });
  assert.equal(missingConfig.config, null);
  assert.match(missingConfig.reason, /no static electron-builder config/);

  const missingRelease = planChecksumOverride({ config, release: null });
  assert.equal(missingRelease.config, null);
  assert.match(missingRelease.reason, /no installed electron release/);

  const pinnedVersion = planChecksumOverride({
    config: { ...config, electronVersion: "43.4.1" },
    release: RELEASE,
  });
  assert.equal(pinnedVersion.config, null);
  assert.match(pinnedVersion.reason, /pins electronVersion 43\.4\.1/);

  const pinnedArgument = planChecksumOverride({
    config,
    release: RELEASE,
    forwardedArgs: ["-c.electronVersion=43.4.1"],
  });
  assert.equal(pinnedArgument.config, null);
  assert.match(pinnedArgument.reason, /pin the Electron source/);

  const pinnedDist = planChecksumOverride({
    config,
    release: RELEASE,
    forwardedArgs: ["--arm64", "-c.electronDist=/tmp/electron"],
  });
  assert.equal(pinnedDist.config, null);
  assert.match(pinnedDist.reason, /electronDist/);

  const ordinaryTarget = planChecksumOverride({
    config,
    release: RELEASE,
    forwardedArgs: ["--arm64", "--universal"],
  });
  assert.notEqual(ordinaryTarget.config, null);
  assert.equal(ordinaryTarget.reason, null);
});

test("writes, exposes, and removes the generated builder config", async () => {
  const config = { appId: "net.aiuo.pi-desktop", electronDownload: { force: false, checksums: {} } };
  const handle = await writeBuilderConfigFile(config);
  try {
    assert.deepEqual(JSON.parse(await readFile(handle.file, "utf8")), config);
    assert.deepEqual(builderConfigArguments(handle), ["--config", handle.file]);
    assert.deepEqual(builderConfigArguments(null), []);
  } finally {
    await removeBuilderConfigFile(handle);
  }
  await assert.rejects(stat(handle.directory), { code: "ENOENT" });
});

test("a failed config write removes its temporary directory and rethrows", async () => {
  const before = new Set(await readdir(tmpdir()));
  // A BigInt value makes JSON.stringify throw before any bytes are written.
  const unserializable = { appId: "net.aiuo.pi-desktop", value: 1n };
  await assert.rejects(
    () => writeBuilderConfigFile(unserializable),
    (error) => error instanceof TypeError,
  );

  const created = (await readdir(tmpdir())).filter(
    (name) => name.startsWith("pi-electron-builder-") && !before.has(name),
  );
  assert.deepEqual(created, []);
});

test("a failing cleanup is reported as a warning instead of replacing the outcome", async (t) => {
  const handle = await writeBuilderConfigFile({ appId: "net.aiuo.pi-desktop" });
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));

  // A path `rm` cannot take stands in for a removal failure during cleanup.
  const removed = await removeBuilderConfigFile({ directory: "\u0000", file: handle.file });
  assert.equal(removed, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not remove/);

  await removeBuilderConfigFile(handle);
  await assert.rejects(stat(handle.directory), { code: "ENOENT" });
});

test("reads the desktop package's static builder config", async () => {
  const config = await readDesktopBuilderConfig(DESKTOP_DIR);
  assert.equal(config.appId, "net.aiuo.pi-desktop");
  assert.equal(config.directories.output, "release");
});

test("the release script logs both the applied and the skipped path", async () => {
  const source = await readFile(
    new URL("../../../scripts/build-desktop-release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /planChecksumOverride/);
  assert.match(source, /verifying against the published \$\{electronRelease\.version\} checksums/);
  assert.match(source, /using electron-builder's own resolution: \$\{checksumPlan\.reason\}/);
  assert.match(source, /builderConfigArguments\(builderConfig\)/);
  assert.match(source, /removeBuilderConfigFile\(builderConfig\)/);
});
