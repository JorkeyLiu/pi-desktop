/**
 * What a collapsed tool row prints for a path.
 *
 * A file row names its file: the hint is scanned, not read, and the last
 * segment is the part a reader matches on. The whole value is not lost — it
 * stays in the row's hover text, its file menu and its preview target — so the
 * hint itself is allowed to be one short, ellipsizable line instead of a fitted
 * fragment of the path.
 *
 * The value is never rewritten: a Windows spelling keeps its backslashes, a
 * relative one keeps its form, and no home or workspace form replaces what the
 * tool was called with.
 */

/** The last path separator, in either the POSIX or the Windows spelling. */
function lastSeparator(text: string): number {
  return Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
}

/**
 * The last segment of `path`, with the separator that names a directory.
 *
 * `a/b/file.ts` → `file.ts`, `C:\a\b\file.ts` → `file.ts`, `a/b/` → `b/`.
 * A value with no segment to name — a bare name, or a root like `/` or `C:\` —
 * is returned as written, because there is nothing narrower to show.
 */
export function toolPathName(path: string): string {
  if (!path) return "";
  const separator = lastSeparator(path);
  if (separator < 0) return path;
  // A value that ends in a separator names a directory, so its last segment is
  // the one before it, and the separator stays to say what the value is.
  const trails = separator === path.length - 1;
  const cut = trails ? separator : path.length;
  const name = path.slice(lastSeparator(path.slice(0, cut)) + 1, cut);
  if (!name) return path;
  return trails ? `${name}${path[separator]}` : name;
}
