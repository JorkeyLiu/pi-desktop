/**
 * Feed electron-builder the published checksums of the Electron artifacts so a
 * package run does not depend on GitHub being reachable.
 *
 * electron-builder resolves the Electron zip through `@electron/get` on every
 * package run. Even when the zip is already in the `@electron/get` download
 * cache, `@electron/get` re-reads the release `SHASUMS256.txt` before it
 * accepts the cached file — checksums are deliberately exempt from the cache.
 * When that request fails, the cached artifact is treated as unverifiable and
 * the build falls back to re-downloading the zip, so a GitHub outage (504,
 * proxy failure, offline runner) fails packaging on a machine that already
 * holds a valid Electron zip.
 *
 * `@electron/get` skips that request when the caller supplies `checksums`, and
 * the `electron` npm package ships the release manifest as `checksums.json`.
 * Handing those published values through keeps validation intact — the cached
 * zip is still verified against the official SHA-256 — while removing the
 * network dependency.
 *
 * electron-builder only forwards `checksums` in its `@electron/get` option
 * shape, which is selected by the presence of `force`/`mirrorOptions`/
 * `unsafelyDisableChecksums` and is read as a whole (`mirrorOptions` collapses
 * it to a bare mirror). The override therefore applies only when the desktop
 * config declares no `electronDownload` block or one that is already that
 * shape; every other shape makes electron-builder drop the checksums, so the
 * run keeps its own resolution and says so instead of pretending to verify.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Builder arguments that pin a different Electron source than the installed package. */
const ELECTRON_SOURCE_FLAGS = ["electronversion", "electrondist"];

/**
 * `electronDownload` keys electron-builder reads through its `@electron/get`
 * option shape without transforming them. Any other key selects the legacy
 * electron-download mapping, which rebuilds the download options and drops
 * `checksums`.
 */
const ELECTRON_GET_PASSTHROUGH_KEYS = new Set(["force", "unsafelyDisableChecksums", "checksums"]);

/**
 * Read the static electron-builder configuration of the desktop package. The
 * build script passes this snapshot back to electron-builder together with the
 * checksum override, because electron-builder merges a `--config` file below
 * the CLI options but cannot merge an extra object into the package config.
 */
export async function readDesktopBuilderConfig(desktopDir) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(desktopDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const config = metadata?.build;
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  return config;
}

/**
 * Read the Electron release that the installed `electron` package belongs to,
 * including the published SHA-256 of every artifact of that release.
 *
 * Returns null when Electron is not installed or the manifest carries no usable
 * checksum, so callers keep electron-builder's default behaviour instead of
 * packaging against an unverifiable artifact.
 */
export async function readInstalledElectronRelease(desktopDir) {
  const require = createRequire(path.join(desktopDir, "package.json"));
  let packagePath;
  try {
    packagePath = require.resolve("electron/package.json");
  } catch {
    return null;
  }

  let version;
  let manifest;
  try {
    version = JSON.parse(await readFile(packagePath, "utf8"))?.version;
    manifest = JSON.parse(
      await readFile(path.join(path.dirname(packagePath), "checksums.json"), "utf8"),
    );
  } catch {
    return null;
  }
  if (typeof version !== "string" || version.length === 0) {
    return null;
  }
  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }

  const checksums = {};
  for (const [name, checksum] of Object.entries(manifest)) {
    if (typeof checksum === "string" && SHA256_PATTERN.test(checksum)) {
      checksums[name] = checksum;
    }
  }
  if (Object.keys(checksums).length === 0) {
    return null;
  }
  return { version, checksums };
}

/**
 * Explain why an existing `electronDownload` block cannot carry the published
 * checksums, or return null when electron-builder forwards them unchanged.
 */
function describeElectronDownloadConflict(existing) {
  if (existing == null) {
    return null;
  }
  if (typeof existing !== "object" || Array.isArray(existing)) {
    return "electronDownload is not an options object";
  }
  if (Object.hasOwn(existing, "mirrorOptions")) {
    return "electronDownload.mirrorOptions makes electron-builder collapse the download options to a bare mirror and drop the checksums";
  }
  const unmappedKeys = Object.keys(existing).filter(
    (key) => !ELECTRON_GET_PASSTHROUGH_KEYS.has(key),
  );
  if (unmappedKeys.length > 0) {
    return `electronDownload sets ${unmappedKeys.join(", ")}, which electron-builder maps through the legacy electron-download options without the checksums`;
  }
  if (Object.hasOwn(existing, "checksums")) {
    return "electronDownload already declares its own checksums";
  }
  if (existing.force) {
    return "electronDownload.force requests a fresh download";
  }
  if (existing.unsafelyDisableChecksums) {
    return "electronDownload.unsafelyDisableChecksums turns validation off";
  }
  return null;
}

/**
 * Decide whether the desktop package can be packaged against the published
 * checksums of the installed Electron release.
 *
 * Returns `{ config, reason }`: `config` is the full electron-builder
 * configuration to run with, or null when electron-builder must keep its own
 * resolution, and `reason` explains the skip for the build log.
 */
export function planChecksumOverride({ config, release, forwardedArgs = [] }) {
  if (config == null) {
    return { config: null, reason: "the desktop package has no static electron-builder config" };
  }
  if (release == null) {
    return {
      config: null,
      reason: "no installed electron release with published artifact checksums was found",
    };
  }
  if (config.electronVersion != null && String(config.electronVersion) !== release.version) {
    return {
      config: null,
      reason: `the desktop config pins electronVersion ${config.electronVersion}, not the installed ${release.version}`,
    };
  }
  const pinnedArgument = forwardedArgs.find((argument) => {
    const normalized = String(argument).toLowerCase().replaceAll("_", "");
    return ELECTRON_SOURCE_FLAGS.some((flag) => normalized.includes(flag));
  });
  if (pinnedArgument != null) {
    return {
      config: null,
      reason: `the builder arguments pin the Electron source (${pinnedArgument})`,
    };
  }
  const conflict = describeElectronDownloadConflict(config.electronDownload);
  if (conflict != null) {
    return { config: null, reason: conflict };
  }
  return {
    config: {
      ...config,
      electronDownload: {
        ...(config.electronDownload ?? {}),
        force: false,
        checksums: release.checksums,
      },
    },
    reason: null,
  };
}

/**
 * Write the generated configuration to a private temporary directory.
 *
 * A failed write removes the directory it just created and rethrows the
 * original error, so a bad run never leaves a half-written config behind and
 * the failure that matters is the one the caller sees.
 */
export async function writeBuilderConfigFile(config) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-electron-builder-"));
  const file = path.join(directory, "electron-builder.generated.json");
  try {
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { file, directory };
}

/**
 * Remove the temporary directory created by {@link writeBuilderConfigFile}.
 *
 * Removal runs in a `finally` next to the builder result, so a cleanup failure
 * is reported as a warning instead of replacing the packaging outcome.
 */
export async function removeBuilderConfigFile(handle) {
  if (handle == null) {
    return;
  }
  try {
    await rm(handle.directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `  • electron artifacts  could not remove ${handle.directory}: ${error.message}`,
    );
  }
}

/** Builder arguments that apply the generated configuration. */
export function builderConfigArguments(handle) {
  return handle == null ? [] : ["--config", handle.file];
}
