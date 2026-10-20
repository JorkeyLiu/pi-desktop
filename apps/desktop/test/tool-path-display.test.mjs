import assert from "node:assert/strict";
import test from "node:test";
import {
  fitMiddleByWidth,
  fitToolPath,
  splitToolPath,
} from "../src/lib/tool-path-display.ts";

/**
 * The row's hint is painted in a monospace face. `--text-xs-plus` in the built
 * stylesheet measures ≈6.92px per character, which is why the 88-character hint
 * below needs 609px: the value is what the rendered probe reads.
 */
const GLYPH = 6.92;
const mono = (text) => text.length * GLYPH;
/** A measure with a wider glyph proves the fit follows widths, not characters. */
const WIDE_GLYPH = 11;
const wide = (text) => text.length * WIDE_GLYPH;

const EXTERNAL =
  "/Users/jorkeyliu/workspace/repos/pi-desktop-mw/apps/desktop/src/features/chat/transcript/hooks/use-transcript-scroll.ts";
const SIBLING =
  "/Users/jorkeyliu/workspace/repos/pi-desktop-mw/apps/desktop/src/features/chat/transcript/hooks/use-transcript-window.ts";
const WINDOWS =
  "C:\\Users\\jorkeyliu\\workspace\\repos\\pi-desktop-mw\\apps\\desktop\\src\\features\\hooks\\use-transcript-scroll.ts";
const RELATIVE = "src/features/chat/transcript/hooks/use-transcript-scroll.ts";

const join = (fit) => `${fit.dir}${fit.base}`;
/** The two halves of a middle omission, split at the only `…` it may contain. */
const omit = (text) => {
  const [head, tail, ...rest] = text.split("…");
  return { head, tail, count: rest.length + 1 };
};

test("a path splits into the boxes it is painted in, spelled exactly", () => {
  for (const path of [EXTERNAL, SIBLING, WINDOWS, RELATIVE]) {
    const fit = splitToolPath(path);
    // Nothing is rewritten: the two boxes spell the value the tool was called
    // with, absolute or relative, with its own separators.
    assert.equal(join(fit), path);
  }
  assert.deepEqual(splitToolPath(EXTERNAL), {
    dir: "/Users/jorkeyliu/workspace/repos/pi-desktop-mw/apps/desktop/src/features/chat/transcript/hooks/",
    base: "use-transcript-scroll.ts",
  });
  assert.equal(splitToolPath(SIBLING).base, "use-transcript-window.ts");
  // A Windows spelling keeps its backslashes in the directory box.
  assert.equal(
    splitToolPath(WINDOWS).dir,
    "C:\\Users\\jorkeyliu\\workspace\\repos\\pi-desktop-mw\\apps\\desktop\\src\\features\\hooks\\",
  );
  assert.equal(splitToolPath(WINDOWS).base, "use-transcript-scroll.ts");
  // A relative path gains no root, and a bare name has no directory at all.
  assert.equal(splitToolPath(RELATIVE).dir, "src/features/chat/transcript/hooks/");
  assert.deepEqual(splitToolPath("App.tsx"), { dir: "", base: "App.tsx" });
  // A value that names a directory stays whole.
  assert.deepEqual(splitToolPath("src/features/"), {
    dir: "src/features/",
    base: "",
  });
});

test("the file name keeps its width and the directory gives way", () => {
  const raw = splitToolPath(EXTERNAL);
  for (const budget of [280, 340, 700]) {
    const fit = fitToolPath(EXTERNAL, budget, mono);
    // The name a reader matches on is whole at every width...
    assert.equal(fit.base, raw.base);
    // ...the pair the row paints never exceeds the row...
    assert.ok(mono(join(fit)) <= budget, `${budget}: ${join(fit)}`);
    // ...and it is still spelled from the raw value: a prefix, an omission, a
    // suffix of the directory, in that order.
    const { head, tail, count } = omit(fit.dir);
    assert.equal(count, 1);
    assert.ok(raw.dir.startsWith(head), `${budget}: ${head}`);
    assert.ok(raw.dir.endsWith(tail), `${budget}: ${tail}`);
  }
  // Narrow: the directory omits its middle and still ends on the segment that
  // holds the file, so the hint never reads as a file in an unknown folder.
  const narrow = fitToolPath(EXTERNAL, 280, mono);
  assert.ok(narrow.dir.includes("…"));
  assert.ok(narrow.dir.startsWith("/Users/"));
  assert.ok(narrow.dir.endsWith("hooks/"));
  // Wide enough for both boxes whole: nothing is omitted at all.
  assert.equal(fitToolPath(EXTERNAL, Math.ceil(mono(EXTERNAL)), mono).dir, raw.dir);
  assert.equal(join(fitToolPath(EXTERNAL, 900, mono)), EXTERNAL);
});

test("a wider row buys more of the leading root", () => {
  const head = (budget) => omit(fitToolPath(EXTERNAL, budget, mono).dir).head;
  const narrow = head(280);
  const middle = head(340);
  const wideHead = head(700);
  // The root is context the reader uses, so both ends keep room: the head is
  // never starved down to a couple of characters by a greedy tail.
  assert.ok(narrow.startsWith("/Users/"));
  assert.ok(middle.length > narrow.length, `${narrow} → ${middle}`);
  assert.ok(wideHead.length > middle.length, `${middle} → ${wideHead}`);
  assert.ok(wideHead.startsWith("/Users/jorkeyliu/workspace/repos"));
});

test("two files under one prefix stay distinguishable", () => {
  const first = fitToolPath(EXTERNAL, 280, mono);
  const second = fitToolPath(SIBLING, 280, mono);
  assert.equal(first.base, "use-transcript-scroll.ts");
  assert.equal(second.base, "use-transcript-window.ts");
  assert.notEqual(join(first), join(second));
});

test("a file name that cannot fit alone omits its own middle, keeping the extension", () => {
  const name =
    "a-considerably-longer-name-for-one-row-of-the-transcript.spec.mjs";
  const path = `/Users/me/workspace/repos/pi-desktop/apps/desktop/src/${name}`;
  // The name alone is 66 characters: no width this row has fits it whole.
  assert.ok(mono(name) > 280);
  const fit = fitToolPath(path, 280, mono);
  // No room is spent on a directory box the name would push out again.
  assert.equal(fit.dir, "");
  assert.ok(fit.base.startsWith("a-considerably"));
  assert.ok(fit.base.endsWith(".spec.mjs"));
  assert.ok(fit.base.includes("…"));
  assert.ok(mono(fit.base) <= 280);
  // The same value fits whole once the row is wide enough for it.
  assert.equal(fitToolPath(path, mono(path), mono).base, name);
});

test("the width, not a character count, decides that the row is too narrow", () => {
  // A relative path of 57 characters: under any old character limit, and yet
  // wider than the 261px a 340px child transcript leaves for the hint — the
  // case where the row used to clip the file name away entirely.
  assert.ok(mono(RELATIVE) > 261);
  const fit = fitToolPath(RELATIVE, 261, mono);
  assert.ok(fit.dir.includes("…"));
  assert.equal(fit.base, "use-transcript-scroll.ts");
  assert.ok(mono(join(fit)) <= 261);
  // The same text fits whole when the row has the room for both boxes.
  assert.equal(
    fitToolPath(RELATIVE, Math.ceil(mono(RELATIVE)), mono).dir,
    "src/features/chat/transcript/hooks/",
  );
  assert.equal(join(fitToolPath(RELATIVE, 415, mono)), RELATIVE);
});

test("wide glyphs buy fewer characters, never the same count", () => {
  const budget = 320;
  const monoFit = fitToolPath(EXTERNAL, budget, mono);
  const wideFit = fitToolPath(EXTERNAL, budget, wide);
  assert.ok(wide(join(wideFit)) <= budget);
  // The same hint measured in the wider face would overflow: the fit follows
  // the measurement, not the character count it happened to be built from.
  assert.ok(wide(join(monoFit)) > budget);
  assert.ok(omit(wideFit.dir).head.length < omit(monoFit.dir).head.length);
  // The name survives either way.
  assert.equal(wideFit.base, "use-transcript-scroll.ts");
});

test("a path keeps its Windows spelling and its own separators", () => {
  const fit = fitToolPath(WINDOWS, 280, mono);
  assert.equal(fit.base, "use-transcript-scroll.ts");
  assert.ok(!fit.dir.includes("/"));
  assert.ok(WINDOWS.startsWith(omit(fit.dir).head));
  assert.ok(fit.dir.endsWith("hooks\\"));
});

test("a middle omission never exceeds the room it was given", () => {
  for (const budget of [0, 12, 40, 120, 300, 1200]) {
    const fitted = fitMiddleByWidth(EXTERNAL, budget, mono, /[/\\]/, "left");
    assert.ok(mono(fitted) <= budget, `${budget}: ${fitted}`);
  }
  assert.equal(fitMiddleByWidth(EXTERNAL, 0, mono, /[/\\]/), "");
  assert.equal(fitMiddleByWidth("App.tsx", 200, mono, /[._-]/, "right"), "App.tsx");
  // No room for a head beside a whole tail keeps the tail, which carries the
  // extension, rather than a run of leading characters.
  assert.equal(fitMiddleByWidth("App.tsx", 44, mono, /[._-]/, "right"), ".tsx");
});
