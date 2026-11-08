/**
 * Package the desktop app for one platform without publishing.
 *
 * The run hands electron-builder a generated configuration carrying the
 * published Electron checksums of the installed Electron release, so packaging
 * validates the Electron artifact without downloading the release manifest.
 * See `electron-artifact-checksums.mjs` for why that request decides whether a
 * cached Electron zip can be used at all.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import {
  builderConfigArguments,
  planChecksumOverride,
  readDesktopBuilderConfig,
  readInstalledElectronRelease,
  removeBuilderConfigFile,
  writeBuilderConfigFile,
} from "./electron-artifact-checksums.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop");
const forwardedArgs = process.argv.slice(2);

const hostTarget =
  process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : "linux";
const requestedTarget = ["linux", "mac", "win"].includes(forwardedArgs[0])
  ? forwardedArgs.shift()
  : undefined;
const target = requestedTarget ?? hostTarget;

if (!["linux", "mac", "win"].includes(target)) {
  throw new Error(`Unsupported desktop release target: ${target}`);
}

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const electronRelease = await readInstalledElectronRelease(desktopDir);
const checksumPlan = planChecksumOverride({
  config: await readDesktopBuilderConfig(desktopDir),
  release: electronRelease,
  forwardedArgs,
});
const builderConfig =
  checksumPlan.config == null ? null : await writeBuilderConfigFile(checksumPlan.config);
if (builderConfig != null) {
  console.log(
    `  • electron artifacts  verifying against the published ${electronRelease.version} checksums (no release manifest download)`,
  );
} else {
  console.log(
    `  • electron artifacts  using electron-builder's own resolution: ${checksumPlan.reason}`,
  );
}

const builderConfigArgs = builderConfigArguments(builderConfig);
if (process.platform === "win32" && builderConfigArgs.length > 0) {
  // Windows runs pnpm through the shell, which joins arguments unquoted; the
  // temporary config path can contain spaces (a user profile with a space).
  builderConfigArgs[builderConfigArgs.length - 1] =
    `"${builderConfigArgs[builderConfigArgs.length - 1]}"`;
}

function runBuilder(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pnpmCommand,
      ["exec", "electron-builder", ...builderConfigArgs, ...args],
      {
        // electron-builder reads the desktop package as its project, so pin the
        // working directory instead of inheriting whatever launched this script.
        cwd: desktopDir,
        // Windows exposes pnpm as a .cmd shim. Launch it through the shell so
        // Node can start the shim consistently on the hosted Windows runner.
        shell: process.platform === "win32",
        stdio: "inherit",
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `electron-builder ${target} target failed with ${
            code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`
          }`,
        ),
      );
    });
  });
}

try {
  if (target === "win") {
    await runBuilder([
      "--win",
      "nsis",
      "--publish",
      "never",
      ...forwardedArgs,
      "-c.extraMetadata.piDistribution=installed",
    ]);
    await runBuilder([
      "--win",
      "zip",
      "--publish",
      "never",
      ...forwardedArgs,
      "-c.extraMetadata.piDistribution=zip",
    ]);
    await runBuilder([
      "--win",
      "portable",
      "--publish",
      "never",
      ...forwardedArgs,
      "-c.extraMetadata.piDistribution=portable",
    ]);
  } else {
    await runBuilder([
      `--${target}`,
      "--publish",
      "never",
      ...forwardedArgs,
    ]);
  }
} finally {
  await removeBuilderConfigFile(builderConfig);
}
