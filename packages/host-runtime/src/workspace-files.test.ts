import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  readOpenableImage,
  readUserLinkFile,
  resolveOpenablePath,
  resolveRealOpenablePath,
  resolveUserLinkTarget,
} from "./workspace-files.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const temps: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Creating links is not always permitted; callers skip then. */
async function linkOrSkip(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return false;
    throw error;
  }
}

it("opens a canonicalized path under a root that is still an alias", async (ctx) => {
  if (process.platform === "win32") ctx.skip();
  const base = await tempDir("pi-ws-alias-");
  const realRoot = join(base, "real");
  const aliasRoot = join(base, "alias");
  await mkdir(realRoot);
  await writeFile(join(realRoot, "generated.png"), PNG);
  await writeFile(join(realRoot, "notes.txt"), "hello");
  if (!(await linkOrSkip(realRoot, aliasRoot))) {
    ctx.skip();
    return;
  }

  // Writers canonicalize before recording the path (`image-generation-service`
  // realpaths its output dir), so the transcript can carry `/private/var/...`
  // while the allowed root is still spelled `/var/...`.
  const canonicalFile = await realpath(join(realRoot, "generated.png"));
  expect(resolveOpenablePath(canonicalFile, aliasRoot, [])).toBeNull();
  expect(await resolveRealOpenablePath(canonicalFile, aliasRoot, [])).toBe(canonicalFile);
  expect(await resolveRealOpenablePath(canonicalFile, null, [aliasRoot])).toBe(canonicalFile);
  expect(await resolveRealOpenablePath(canonicalFile, aliasRoot, [realRoot])).toBe(
    canonicalFile,
  );

  // Absolute paths and attachment blobs keep working through the alias too.
  const canonicalAlias = await realpath(join(aliasRoot, "notes.txt"));
  expect(await resolveRealOpenablePath(canonicalAlias, aliasRoot, [])).toBe(
    canonicalAlias,
  );
});

it("stores a generated image reference that the reader can open", async (ctx) => {
  if (process.platform === "win32") ctx.skip();
  const base = await tempDir("pi-ws-scratch-");
  const dataDir = join(base, "data");
  const scratch = join(dataDir, "scratch");
  const workspace = join(base, "workspace");
  await mkdir(scratch, { recursive: true });
  await mkdir(workspace);
  await writeFile(join(scratch, "generated-1.png"), PNG);
  if (!(await linkOrSkip(dataDir, join(base, "data-alias")))) {
    ctx.skip();
    return;
  }

  // Exactly what `image-generation-service` writes into the transcript.
  const stored = await realpath(join(scratch, "generated-1.png"));
  const result = await readOpenableImage(stored, workspace, [scratch]);
  expect(result).toMatchObject({ kind: "image", size: PNG.length });
  expect(String((result as { dataUrl?: string }).dataUrl)).toMatch(
    /^data:image\/png;base64,/,
  );

  // The alias spelling was always accepted and must keep working.
  const alias = await readOpenableImage(join(scratch, "generated-1.png"), workspace, [
    scratch,
  ]);
  expect(alias.kind).toBe("image");
});

it("still refuses a link inside an allowed root that points outside it", async (ctx) => {
  if (process.platform === "win32") ctx.skip();
  const base = await tempDir("pi-ws-escape-");
  const root = join(base, "root");
  const outside = join(base, "outside");
  const other = join(base, "other");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(other);
  await writeFile(join(outside, "leak.png"), PNG);
  const link = join(root, "leak.png");
  if (!(await linkOrSkip(join(outside, "leak.png"), link))) {
    ctx.skip();
    return;
  }

  const canonicalOutside = await realpath(join(outside, "leak.png"));
  expect(await resolveRealOpenablePath(link, root, [])).toBeNull();
  expect(await resolveRealOpenablePath(canonicalOutside, root, [])).toBeNull();
  expect(await resolveRealOpenablePath(link, other, [root])).toBeNull();
  expect(await resolveRealOpenablePath(canonicalOutside, other, [root])).toBeNull();

  const result = await readOpenableImage(link, root, [], "image/png");
  expect(result).toMatchObject({
    kind: "missing",
    errorCode: "PATH_OUTSIDE_ALLOWED_ROOT",
  });
});

it("keeps relative, absolute and workspace-boundary behavior", async () => {
  const base = await tempDir("pi-ws-bounds-");
  const root = join(base, "workspace");
  const scratch = join(base, "scratch");
  const attachments = join(base, "attachments");
  const hash = "a".repeat(64);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(scratch);
  await mkdir(attachments);
  await writeFile(join(root, "src", "a.ts"), "x");
  await writeFile(join(scratch, "pasted.png"), PNG);
  await writeFile(join(attachments, hash), PNG);
  await writeFile(join(base, "outside.png"), PNG);

  const workspaceFile = join(root, "src", "a.ts");
  expect(await resolveRealOpenablePath("src/a.ts", root, [scratch])).toBe(
    await realpath(workspaceFile),
  );
  expect(await resolveRealOpenablePath(workspaceFile, root, [scratch])).toBe(
    await realpath(workspaceFile),
  );
  expect(await resolveRealOpenablePath(join(scratch, "pasted.png"), root, [scratch])).toBe(
    await realpath(join(scratch, "pasted.png")),
  );
  expect(await resolveRealOpenablePath(`attachments/${hash}`, root, [attachments])).toBe(
    await realpath(join(attachments, hash)),
  );

  expect(await resolveRealOpenablePath("../outside.png", root, [scratch])).toBeNull();
  expect(await resolveRealOpenablePath("src/a.ts", null, [scratch])).toBeNull();
  expect(await resolveRealOpenablePath("~/secret.png", root, [scratch])).toBeNull();
  expect(await resolveRealOpenablePath(join(base, "outside.png"), root, [scratch])).toBeNull();
  expect(await resolveRealOpenablePath(`attachments/notes.png`, root, [attachments])).toBeNull();
  expect(await resolveRealOpenablePath(`attachments/${hash}`, root, [])).toBeNull();
  expect(await resolveRealOpenablePath("", root, [scratch])).toBeNull();
  if (process.platform !== "win32") {
    expect(await resolveRealOpenablePath("/etc/passwd", root, [scratch])).toBeNull();
  }
});

/** Machine-readable refusal from a user-link entry point. */
async function userLinkCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { errorCode?: string }).errorCode ?? "NO_CODE";
  }
  throw new Error("expected the user-link access to reject");
}

it("reads a user-clicked absolute file outside every allowed root", async () => {
  const base = await tempDir("pi-user-link-");
  const outside = join(base, "outside");
  const root = join(base, "workspace");
  await mkdir(outside);
  await mkdir(root);
  await writeFile(join(outside, "note.md"), "hello user link\n");

  const target = join(outside, "note.md");
  // Containment still refuses the same path: the user-link read is a
  // separate capability, not a relaxation of the roots.
  expect(await resolveRealOpenablePath(target, root, [])).toBeNull();
  expect(await readOpenableImage(target, root, [])).toMatchObject({
    kind: "missing",
    errorCode: "PATH_OUTSIDE_ALLOWED_ROOT",
  });

  // The click itself authorizes exactly this file, with no root consulted.
  expect(await resolveUserLinkTarget(target)).toBe(await realpath(target));
  const result = await readUserLinkFile(target);
  expect(result).toMatchObject({ kind: "text", content: "hello user link\n" });
});

it("reads a user-clicked image outside every root as a data url", async () => {
  const base = await tempDir("pi-user-link-image-");
  const photo = join(base, "photo.png");
  await writeFile(photo, PNG);
  const result = await readUserLinkFile(photo);
  expect(result.kind).toBe("image");
  expect(String(result.dataUrl)).toMatch(/^data:image\/png;base64,/);
  expect(result.size).toBe(PNG.length);
});

it("reports binary and oversized user-link files without content filtering", async () => {
  const base = await tempDir("pi-user-link-caps-");
  const binary = join(base, "blob.bin");
  await writeFile(binary, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x41]));
  expect(await readUserLinkFile(binary)).toMatchObject({ kind: "binary" });

  const bigText = join(base, "big.txt");
  await writeFile(bigText, Buffer.alloc(600 * 1024, "a"));
  expect(await readUserLinkFile(bigText)).toMatchObject({ kind: "tooLarge" });

  const bigImage = join(base, "big.png");
  await writeFile(bigImage, Buffer.alloc(6 * 1024 * 1024, 0));
  expect(await readUserLinkFile(bigImage)).toMatchObject({ kind: "tooLarge" });
});

it("rejects user-link paths that are not absolute regular files", async () => {
  const base = await tempDir("pi-user-link-invalid-");
  const file = join(base, "note.txt");
  await writeFile(file, "x");

  // A directory names something, but is not a file to view.
  expect(await userLinkCode(readUserLinkFile(base))).toBe("INVALID_ARGUMENT");

  if (process.platform !== "win32") {
    // A character device opens but is never a regular file.
    expect(await userLinkCode(readUserLinkFile("/dev/null"))).toBe("INVALID_ARGUMENT");

    // A FIFO must not stall the reader waiting for a writer.
    const fifo = join(base, "pipe");
    let hasFifo = false;
    try {
      execFileSync("mkfifo", [fifo]);
      hasFifo = true;
    } catch {
      hasFifo = false;
    }
    if (hasFifo) {
      expect(await userLinkCode(readUserLinkFile(fifo))).toBe("INVALID_ARGUMENT");
    }

    // A bound unix socket refuses `open` and still reports "not a file".
    const sockPath = join(base, "s.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => resolve());
    });
    try {
      expect(await userLinkCode(readUserLinkFile(sockPath))).toBe("INVALID_ARGUMENT");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  // Shorthands are never guessed: relative, home, empty, and NUL paths fail.
  for (const bad of ["", "relative/note.txt", "~/note.txt", "note.txt\0", file.slice(1)]) {
    expect(await userLinkCode(readUserLinkFile(bad))).toBe("INVALID_ARGUMENT");
    expect(await userLinkCode(resolveUserLinkTarget(bad))).toBe("INVALID_ARGUMENT");
  }

  // A path that names nothing reports "missing", not "not a file".
  const missing = join(base, "absent.txt");
  expect(await userLinkCode(readUserLinkFile(missing))).toBe("NOT_FOUND");
  expect(await userLinkCode(resolveUserLinkTarget(missing))).toBe("NOT_FOUND");
});

it("follows a user-clicked symlink to the real file it names", async (ctx) => {
  if (process.platform === "win32") ctx.skip();
  const base = await tempDir("pi-user-link-symlink-");
  const outside = join(base, "outside");
  await mkdir(outside);
  const real = join(outside, "real.md");
  await writeFile(real, "through the link\n");
  const link = join(base, "linked.md");
  if (!(await linkOrSkip(real, link))) {
    ctx.skip();
    return;
  }

  expect(await resolveUserLinkTarget(link)).toBe(await realpath(real));
  const result = await readUserLinkFile(link);
  expect(result).toMatchObject({ kind: "text", content: "through the link\n" });
});
