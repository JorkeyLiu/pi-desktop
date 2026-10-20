/**
 * How a file path is fitted into a single-line tool-row hint.
 *
 * A path is recognized by its last segment, so the file name keeps its whole
 * width and only the directory gives way; when the name alone still cannot fit,
 * it omits its own middle and keeps its extension. Both decisions are measured
 * in pixels, never derived from a character count: the same value fits a wide
 * transcript and overflows a 280px sidebar, and the row clips on the right,
 * which is exactly where the file name sits.
 *
 * Nothing here rewrites the value. An absolute path stays absolute, a relative
 * one stays relative, a Windows spelling keeps its backslashes, and no home or
 * workspace form is substituted for the path the tool was called with.
 */

/** Width of `text` in the font the row paints it with. */
export type PathMeasure = (text: string) => number;

/** The two boxes a row's path hint is painted in. Their order is the original
 * order, and the directory keeps its trailing separator so joining them spells
 * the raw value exactly. */
export type ToolPathParts = { dir: string; base: string };

const ELLIPSIS = "…";

/** Path separators, in both the POSIX and the Windows spelling. */
const DIR_SEPARATOR = /[/\\]/;
/** The chunks a file name may be split at when it must omit its own middle. */
const NAME_SEPARATOR = /[._-]/;

/**
 * The directory (with its trailing separator) and the file name of a path, as
 * written. A value that names a directory — it ends with a separator, or holds
 * none — stays whole.
 */
export function splitToolPath(path: string): ToolPathParts {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return { dir: "", base: path };
  if (index === path.length - 1) return { dir: path, base: "" };
  return { dir: path.slice(0, index + 1), base: path.slice(index + 1) };
}

/**
 * `text` split at `separator`, keeping the separator attached to the chunk it
 * belongs to: a directory segment keeps its trailing slash (`"a/b"` →
 * `["a/", "b"]`), a file name its leading dot (`"a.spec.mjs"` →
 * `["a", ".spec", ".mjs"]`), so a tail taken whole never ends or begins with a
 * fragment of the separator that identifies it.
 */
function chunks(
  text: string,
  separator: RegExp,
  attach: "left" | "right",
): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!separator.test(text[index])) continue;
    const cut = attach === "left" ? index + 1 : index;
    if (cut > start) parts.push(text.slice(start, cut));
    start = cut;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

/** The longest leading character run that fits `budget`. */
function leadingRun(text: string, budget: number, measure: PathMeasure): string {
  return text.slice(0, runLength(text, budget, measure, "start"));
}

/** The longest trailing character run that fits `budget`. */
function trailingRun(text: string, budget: number, measure: PathMeasure): string {
  return text.slice(text.length - runLength(text, budget, measure, "end"));
}

/** How many characters of `text` fit `budget`, counted from either end. */
function runLength(
  text: string,
  budget: number,
  measure: PathMeasure,
  from: "start" | "end",
): number {
  const run = (length: number) =>
    from === "start" ? text.slice(0, length) : text.slice(text.length - length);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(run(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * `text` with its middle omitted to fit `budget`: the value itself when it
 * fits, otherwise whole chunks from both ends, an `…` between them.
 *
 * Neither end wins the whole row. The tail is taken in whole chunks — a half
 * segment would hide the name a reader matches on — but never more than half
 * the room, so the leading root stays readable beside it instead of collapsing
 * to its first characters.
 */
export function fitMiddleByWidth(
  text: string,
  budget: number,
  measure: PathMeasure,
  separator: RegExp,
  attach: "left" | "right" = "left",
): string {
  if (budget <= 0) return "";
  if (measure(text) <= budget) return text;
  const ellipsisWidth = measure(ELLIPSIS);
  if (budget <= ellipsisWidth) return ELLIPSIS;
  const room = budget - ellipsisWidth;
  const parts = chunks(text, separator, attach);
  let tail = "";
  for (let take = 1; take <= parts.length; take += 1) {
    const candidate = parts.slice(-take).join("");
    if (measure(candidate) > room / 2) break;
    tail = candidate;
  }
  // Not one whole chunk fits in half the room: the longest suffix that does is
  // still the extension or the last segment, which identifies the value best.
  // Not one whole chunk fits the balanced half, so the last chunk takes the
  // room instead and the head is dropped rather than cut: the extension names
  // the value better than a run of its characters does.
  if (!tail) {
    for (let take = parts.length; take >= 1; take -= 1) {
      const candidate = parts.slice(-take).join("");
      if (measure(candidate) <= room) return candidate;
    }
    tail = trailingRun(text, room / 2, measure);
  }
  // The head may not reach the tail: that would be no omission at all.
  const limit = Math.max(0, text.length - tail.length - 1);
  const head = leadingRun(text, room - measure(tail), measure)
    .slice(0, limit)
    .trimEnd();
  if (!head) return tail;
  return `${head}${ELLIPSIS}${tail}`;
}

/**
 * Fit `path` into `budget` with the file name taking priority: the directory
 * gives way first, its middle omitted, and the name only when it cannot fit
 * alone — then keeping the suffix that tells two nearby files apart.
 */
export function fitToolPath(
  path: string,
  budget: number,
  measure: PathMeasure,
): ToolPathParts {
  if (budget <= 0) return { dir: "", base: "" };
  const { dir, base } = splitToolPath(path);
  const baseWidth = measure(base);
  if (!dir || baseWidth >= budget) {
    return {
      dir: "",
      base: fitMiddleByWidth(base, budget, measure, NAME_SEPARATOR, "right"),
    };
  }
  const dirBudget = budget - baseWidth;
  if (measure(dir) <= dirBudget) return { dir, base };
  // Room too small to name any part of the directory is better left unused than
  // filled with a bare `…` beside the name.
  if (dirBudget <= measure(ELLIPSIS)) return { dir: "", base };
  return {
    dir: fitMiddleByWidth(dir, dirBudget, measure, DIR_SEPARATOR, "left"),
    base,
  };
}
