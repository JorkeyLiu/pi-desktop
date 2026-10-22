import { readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TRANSCRIPT_INITIAL_MOUNT,
  TRANSCRIPT_WINDOW_MIN,
  TRANSCRIPT_WINDOW_STEP,
  growTranscriptWindow,
  planTopReach,
  reduceTranscriptWindow,
} from "../src/lib/transcript-window.ts";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { buildTranscriptEntries, transcriptEntryMessages } = await import(
  "../src/lib/assistant-turns.ts"
);

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [transcript, minimap, surface] = await Promise.all([
  readTranscriptSource(),
  read("../src/components/ConversationMinimap.tsx"),
  read("../src/components/ChatSurface.tsx"),
]);

function window(overrides = {}) {
  return reduceTranscriptWindow({
    historyLength: 400,
    windowSize: TRANSCRIPT_WINDOW_MIN,
    initialCommit: false,
    ...overrides,
  });
}

/* ---------- the mounted-history budget ---------- */

test("a long history mounts only the trailing window", () => {
  const result = window();

  assert.equal(result.mounted, TRANSCRIPT_WINDOW_MIN);
  assert.equal(result.hiddenAbove, 400 - TRANSCRIPT_WINDOW_MIN);
  assert.equal(result.bounded, true);
});

test("a history that fits the window mounts completely", () => {
  const result = window({ historyLength: 12 });

  assert.equal(result.mounted, 12);
  assert.equal(result.hiddenAbove, 0);
  assert.equal(result.bounded, false);
});

test("the first commit after a session switch mounts the initial budget", () => {
  const result = window({ initialCommit: true });

  assert.equal(result.mounted, TRANSCRIPT_INITIAL_MOUNT);
  assert.ok(
    TRANSCRIPT_INITIAL_MOUNT < TRANSCRIPT_WINDOW_MIN,
    "the first paint must be cheaper than the steady state",
  );
  assert.equal(result.bounded, true);
});

test("a short session switch is never bounded", () => {
  const result = window({ historyLength: 3, initialCommit: true });

  assert.equal(result.mounted, 3);
  assert.equal(result.bounded, false);
});

test("an empty history mounts nothing and reports no hidden rows", () => {
  const result = window({ historyLength: 0 });

  assert.equal(result.mounted, 0);
  assert.equal(result.hiddenAbove, 0);
  assert.equal(result.bounded, false);
});

test("a stale oversized window from a previous session cannot over-mount", () => {
  // `windowSize` is state, so a session switch can render one frame with the
  // previous session's grown budget before the reset effect runs.
  const result = window({ historyLength: 20, windowSize: 4_000 });

  assert.equal(result.mounted, 20);
  assert.equal(result.bounded, false);
});

test("the window budget never drops below the steady-state floor", () => {
  const result = window({ windowSize: 1 });

  assert.equal(result.mounted, TRANSCRIPT_WINDOW_MIN);
});

/* ---------- growing the window ---------- */

test("reaching the top grows the window by one step", () => {
  assert.equal(
    growTranscriptWindow(TRANSCRIPT_WINDOW_MIN, 400),
    TRANSCRIPT_WINDOW_MIN + TRANSCRIPT_WINDOW_STEP,
  );
});

test("growth stops once the window covers the loaded history", () => {
  // This is the handoff to `loadOlder`: the transcript only fetches an older
  // page when mounting more of what it already has cannot help.
  assert.equal(growTranscriptWindow(TRANSCRIPT_WINDOW_MIN, 30), TRANSCRIPT_WINDOW_MIN);
  assert.equal(growTranscriptWindow(200, 200), 200);
});

test("growth is clamped to the loaded history instead of overshooting", () => {
  const length = TRANSCRIPT_WINDOW_MIN + 5;

  assert.equal(growTranscriptWindow(TRANSCRIPT_WINDOW_MIN, length), length);
});

test("repeated growth reaches full history and then reports a fixed point", () => {
  let size = TRANSCRIPT_WINDOW_MIN;
  for (let step = 0; step < 50; step += 1) {
    size = growTranscriptWindow(size, 300);
  }

  assert.equal(size, 300);
  assert.equal(growTranscriptWindow(size, 300), size);
  assert.equal(reduceTranscriptWindow({
    historyLength: 300,
    windowSize: size,
    initialCommit: false,
  }).bounded, false);
});

/* ---------- what the mounted rows contain ---------- */

function assistant(id, content) {
  return { id, role: "assistant", content, createdAt: "2026-01-01T00:00:00Z" };
}

function user(id, content) {
  return { id, role: "user", content, createdAt: "2026-01-01T00:00:00Z" };
}

test("mounted rows expose their user and assistant messages in order", () => {
  const { entries } = buildTranscriptEntries([
    user("u1", "first"),
    assistant("a1", "answer"),
    user("u2", "second"),
    assistant("a2", "answer two"),
  ]);

  const ids = transcriptEntryMessages(entries).map((message) => message.id);

  assert.deepEqual(ids, ["u1", "a1", "u2", "a2"]);
});

test("mounted rows exclude tool rows and delegate rows", () => {
  const { entries } = buildTranscriptEntries([
    user("u1", "go"),
    {
      id: "t1",
      role: "tool",
      content: "output",
      createdAt: "2026-01-01T00:00:00Z",
      toolCallId: "t1",
      toolName: "Bash",
    },
    {
      id: "d1",
      role: "assistant",
      content: "delegate said",
      createdAt: "2026-01-01T00:00:00Z",
      parentToolCallId: "t1",
    },
    assistant("a1", "done"),
  ]);

  const ids = transcriptEntryMessages(entries).map((message) => message.id);

  assert.deepEqual(ids, ["u1", "a1"]);
});

test("a windowed slice reports only the rows it mounts", () => {
  const messages = [];
  for (let index = 0; index < 10; index += 1) {
    messages.push(user(`u${index}`, `ask ${index}`));
    messages.push(assistant(`a${index}`, `answer ${index}`));
  }
  const { entries } = buildTranscriptEntries(messages);

  const mounted = transcriptEntryMessages(entries.slice(-4));
  const ids = mounted.map((message) => message.id);

  assert.ok(ids.length > 0);
  assert.ok(!ids.includes("u0"), "withheld rows must not be reported");
  assert.ok(ids.includes("a9"), "the newest row is always mounted");
});

/* ---------- renderer wiring ---------- */

test("the transcript bounds mounted history and escalates at the top", () => {
  assert.match(transcript, /reduceTranscriptWindow/);
  assert.match(transcript, /planTopReach/);
  assert.match(
    transcript,
    /const \[windowSize, setWindowSize\] = useState\(savedReadingPosition\?\.windowSize \?\? TRANSCRIPT_WINDOW_MIN\)/,
  );
  // Reaching the top mounts more of what is loaded first, and only fetches an
  // older page once the window already covers it. The trigger is the shared
  // continuation rule, so a pane still establishing its first position cannot
  // page history on mounting geometry alone.
  assert.match(
    transcript,
    /shouldContinueEarlierHistory\(\{\n\s+geometry: el,\n\s+pinned: pinnedRef\.current && !gesturing,/,
  );
  const reachTop = transcript.match(
    /const reachTop = useCallback\(\((?:readerOwnsViewport = false)?\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/,
  )?.[1];
  assert.ok(reachTop, "reachTop must exist with a stable identity");
  assert.match(reachTop, /planTopReach\(\{/);
  assert.match(reachTop, /setWindowSize\(plan\.windowSize\)/);
  assert.match(reachTop, /loadOlder\(\)/);
  // Both escalation stages add height above the reading position, and this
  // trigger measures nothing: it takes the reader's visible fragment as a hold
  // before the commit, and the commit itself resolves it in one layout phase.
  // No captured height, no pre-paint delta, and no writer in the decision.
  assert.doesNotMatch(reachTop, /scrollHeight/);
  assert.match(reachTop, /capturePrependAnchor\(/);
  assert.doesNotMatch(transcript, /prependHeightRef/);
  assert.doesNotMatch(transcript, /el\.scrollTop \+= delta/);
  assert.doesNotMatch(transcript, /\[messages\.length, windowSize\]\)/);
});

test("one visible-fragment hold covers the states native anchoring cannot", () => {
  // Native anchoring performs no adjustment at `scrollTop === 0`, and inside a
  // turn a page boundary cuts it anchors on a box other than the fragment in
  // view. One hold covers both: the fragment plus its viewport offset, applied
  // once in the layout phase of the commit that added the height, against the
  // layout the browser already produced (so it never compensates twice).
  assert.match(transcript, /const prependAnchorRef = useRef<VisibleFragmentAnchor \| null>\(null\)/);
  assert.match(transcript, /captureVisibleFragment\(el\)/);
  assert.match(transcript, /remeasureVisibleFragment\(el, held\.messageId\)/);
  assert.match(transcript, /resolvePrependAnchor\(held, current, el\)/);
  // One write, then the hold is gone: never a correction loop, and never a
  // second writer over the same commit.
  const writes = transcript.match(/el\.scrollTop = resolution\.target;/g) ?? [];
  assert.equal(writes.length, 1);
  assert.doesNotMatch(transcript, /requestAnimationFrame\([^)]*resolvePrependAnchor/);
  // A reader who scrolls while a page is in flight is answered with where they
  // are: the hold is re-read on their scroll events, not frozen at request time.
  assert.match(
    transcript,
    /if \(prependAnchorRef\.current\) \{\s*const held = captureVisibleFragment\(el\);\s*if \(held\) prependAnchorRef\.current = held;/,
  );
  // The hold belongs to one pane's layout: it is dropped when the pane hides,
  // when a turn re-bottoms, and on every navigation. The two refs are one
  // state, so every drop goes through the helper that clears both - a hold
  // left behind without its settle flag keeps a stale correction armed.
  const release = transcript.match(
    /const releasePrependAnchor = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[\]\);/,
  )?.[1];
  assert.ok(release, "releasePrependAnchor must clear the paired refs");
  assert.match(release, /prependAnchorRef\.current = null;/);
  assert.match(release, /prependAnchorSettledRef\.current = false;/);
  assert.match(transcript, /if \(becameHidden\) \{[\s\S]*?releasePrependAnchor\(\);/);
  assert.doesNotMatch(
    transcript,
    /if \(becameHidden\) \{[\s\S]{0,400}?prependAnchorRef\.current = null;/,
  );
  assert.match(transcript, /releasePrependAnchor\(\);\s*pinnedRef\.current = true;/);
  assert.match(transcript, /releasePrependAnchor\(\);\s*\n\s*pinnedRef\.current = false;/);
});

test("a reach at the top with nothing left to load arms no hold", () => {
  // Fully loaded history with every row mounted: neither escalation stage has
  // anything to ask for, so a reach at the top has no commit coming and must
  // take no hold. An armed hold there never resolves - the read that would
  // settle it never starts - and keeps re-reading the reading line on every
  // later scroll and every later commit for the rest of the session.
  assert.equal(
    planTopReach({ windowSize: 400, historyLength: 400, canLoadOlder: false }),
    null,
  );
  assert.equal(
    planTopReach({ windowSize: 4_000, historyLength: 400, canLoadOlder: false }),
    null,
  );
  // The two stages that do add height above the reading position still plan,
  // and only they carry a hold.
  assert.deepEqual(
    planTopReach({ windowSize: TRANSCRIPT_WINDOW_MIN, historyLength: 400, canLoadOlder: false }),
    { kind: "grow", windowSize: TRANSCRIPT_WINDOW_MIN + TRANSCRIPT_WINDOW_STEP },
  );
  assert.deepEqual(
    planTopReach({ windowSize: 400, historyLength: 400, canLoadOlder: true }),
    { kind: "page" },
  );

  // Source contract for the same rule: the hold is taken after the plan, so a
  // reach that plans nothing returns before it can arm one, and the page stage
  // is gated on a read this pane can actually dispatch.
  const reachTop = transcript.match(
    /const reachTop = useCallback\(\((?:readerOwnsViewport = false)?\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/,
  )?.[1];
  assert.ok(reachTop, "reachTop must exist with a stable identity");
  assert.match(reachTop, /canLoadOlder: canLoadOlder\(\),/);
  const planAt = reachTop.indexOf("const plan = planTopReach({");
  const bailAt = reachTop.indexOf("if (!plan) return;");
  const captureAt = reachTop.indexOf("capturePrependAnchor(readerOwnsViewport)");
  assert.ok(planAt >= 0, "the reach must decide through the plan");
  assert.ok(bailAt > planAt, "a reach with nothing to ask for must return before it holds");
  assert.ok(captureAt > bailAt, "the hold is armed only for a commit that will happen");
  assert.equal(
    (reachTop.match(/capturePrependAnchor\(/g) ?? []).length,
    1,
    "one hold site, entered from one gate",
  );
  // The gate itself refuses a hidden pane, a finished range and a read already
  // in flight, so the plan is never asked to page a pane that cannot.
  const canLoadOlder = transcript.match(
    /const canLoadOlder = useCallback\(\n\s+\(\): boolean =>\n([\s\S]*?)\n    \[[^\]]*\],\n  \);/,
  )?.[1];
  assert.ok(canLoadOlder, "canLoadOlder must exist");
  assert.match(canLoadOlder, /paneVisibleRef\.current &&/);
  assert.match(canLoadOlder, /hasMoreBefore &&/);
  assert.match(canLoadOlder, /!loadingOlder &&/);
  assert.match(canLoadOlder, /onLoadOlder !== undefined/);
  assert.match(transcript, /if \(!canLoadOlder\(\) \|\| !onLoadOlder\) return;/);
});

test("upward height is absorbed by native anchoring, with one bounded hold", async () => {
  // The reader's row is the anchor: the browser keeps it where it is while an
  // older page or a grown mounted window adds height above it, and keeps it
  // there through the frames in which rows resolve their own heights.
  const [shell, messages] = await Promise.all([
    read("../src/styles/chat-shell.css"),
    read("../src/styles/messages.css"),
  ]);
  const threadScroll = shell.match(/\.thread-scroll \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(threadScroll, ".thread-scroll must be declared");
  assert.match(threadScroll, /overflow-anchor: auto/);
  assert.doesNotMatch(threadScroll, /overflow-anchor: none/);
  // Furniture is not a reading position. None of these boxes may be chosen as
  // the row to hold, or the rows behind them would move with them.
  const furniture = shell.match(
    /\.transcript-history-loading,\n\.transcript-later-boundary,\n\.transcript-hydration-spacer,\n\.transcript-runtime-status,\n\.transcript-load-later \{\n  overflow-anchor: none;/,
  );
  assert.ok(furniture, "the sentinels, spacer, status lane and retry row must be excluded");
  // Mounted rows carry their real height: an intrinsic estimate would make the
  // scroller's height wrong until the row was measured, which is what moved the
  // content during upward scrolling.
  for (const selector of [".message-row", ".tool-activity-group"]) {
    const rule = messages.match(new RegExp(`\\${selector} \\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(rule, `${selector} must be declared`);
    const declarations = rule.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(declarations, /content-visibility/);
    assert.doesNotMatch(declarations, /contain-intrinsic-size/);
  }
  // The history status row sits above the rows the reader is reading, so its
  // height must not change with the label: mounting and unmounting the text
  // moved the whole transcript by its own line box on every page (ADR 0331).
  assert.match(
    shell,
    /\.transcript-history-loading\[aria-hidden="true"\] \.transcript-history-loading-label \{\n  visibility: hidden;/,
  );
  // The retained hidden pane still skips its rendering.
  assert.match(shell, /\.session-pane\[data-visible="false"\] \{[\s\S]*?content-visibility: hidden;/);
});

test("the window is owned per session pane, so no switch can inherit a budget", () => {
  // With one retained pane per session (ADR 0137) the budget is per-instance
  // state, which is what makes it session-scoped. The reset effect that used to
  // unwind it on `sessionId` change must be gone: a pane that reset its own
  // window would throw away the history the user had already paged in.
  assert.match(transcript, /const \[windowSize, setWindowSize\] = useState\(savedReadingPosition\?\.windowSize \?\? TRANSCRIPT_WINDOW_MIN\)/);
  assert.doesNotMatch(
    transcript,
    /setWindowSize\(TRANSCRIPT_WINDOW_MIN\);\s*\}, \[sessionId\]\)/,
  );
  assert.match(surface, /<SessionPane\s*key=\{id\}/);
});

test("the minimap keeps message dashes reachable and represents withheld history explicitly", () => {
  // Message dashes still resolve to mounted DOM nodes. Older loaded/unloaded
  // history is one honest continuation control, never a phantom message dash.
  assert.match(minimap, /querySelectorAll<HTMLElement>\("\[data-minimap-id\]"\)/);
  assert.match(transcript, /messages=\{minimapMessages\}/);
  assert.match(transcript, /hasEarlier=\{hasEarlierHistory\}/);
  assert.match(transcript, /onRevealEarlier=\{revealEarlierHistory\}/);
  assert.match(
    transcript,
    /transcriptWindow\.bounded\s*\?\s*transcriptEntryMessages\(/,
  );
  assert.match(
    transcript,
    /const hasEarlierHistory = transcriptWindow\.hiddenAbove > 0 \|\| hasMoreBefore/,
  );
});

test("a visible history boundary advances without waiting for a scroll event", () => {
  assert.match(transcript, /ref=\{historyBoundaryRef\}/);
  // The boundary's visibility transition is one owner, and that observer keeps
  // its identity across pages: a rebuilt IntersectionObserver reports the
  // boundary's current visibility as its first record, so a landed page would
  // look like a fresh reach and page the whole conversation in.
  assert.match(transcript, /new IntersectionObserver\(/);
  assert.match(
    transcript,
    /if \(records\.some\(\(record\) => record\.isIntersecting\)\) \{\n\s+scheduleContinueEarlierHistory\(\);/,
  );
  const observerEffect = transcript.match(
    /observer\.observe\(boundary\);\n\s+return \(\) => observer\.disconnect\(\);\n  \}, \[([^\]]*)\]\);/,
  )?.[1];
  assert.ok(observerEffect, "the boundary observer must be its own effect");
  assert.match(observerEffect, /^hasEarlierHistory, paneVisible, scheduleContinueEarlierHistory, sessionId$/);
  assert.doesNotMatch(observerEffect, /messages\.length|hiddenAbove|reachTop|windowSize/);
  // The pane's own content change is not a reader reach: it continues only
  // while the pane still owes the viewport content (loaded rows it has not
  // mounted, or a transcript that does not fill the viewport). Otherwise a
  // reader resting at the top would be handed page after page.
  assert.match(
    transcript,
    /const owesViewportContent =\n\s+transcriptWindow\.hiddenAbove > 0 \|\|\n\s+root\.scrollHeight <= root\.clientHeight \+ HISTORY_REVEAL_THRESHOLD_PX;/,
  );
  assert.match(transcript, /if \(!owesViewportContent\) return;/);
  // Window growth and paging share one continuation gate, which re-checks the
  // initial-position rule, so a pane whose first position has not settled is
  // never paged from its own mounting geometry.
  assert.match(
    transcript,
    /const continueEarlierHistory = useCallback\(\((?:readerOwnsViewport = false)?\) => \{[\s\S]*?shouldContinueEarlierHistory\(\{[\s\S]*?geometry: el,\n\s+pinned: pinnedRef\.current,\n\s+positioned: positionedRef\.current,\n\s+covered: coveredRef\.current,[\s\S]*?reachTopRef\.current\?\.\(readerOwnsViewport\);/,
  );
  // A gesture at the top is a reach even though the browser has no offset left
  // to move and therefore emits no scroll event.
  assert.match(
    transcript,
    /if \(event\.type === "wheel" \|\| event\.type === "touchmove"\) \{\n\s+continueEarlierHistory\(true\);/,
  );
});

test("the cold-open initial fill is one page, asked for behind the veil", () => {
  // A pane that presents no row has no reading position: an empty scroller never
  // overflows and never fills, so continuing from its geometry is meaningless.
  // It asks for exactly one fill while the settle veil covers it, and every later
  // page is a reader reach.
  assert.match(
    transcript,
    /const requestInitialFill = useCallback\(\(\) => \{\n\s+if \(initialFillRequestedRef\.current\) return;\n\s+initialFillRequestedRef\.current = true;\n\s+loadOlderRef\.current\(\);/,
  );
  assert.match(transcript, /const initialFillRequestedRef = useRef\(false\);/);
  // The continuation gate refuses a pane that presents nothing, so the fill
  // cannot be re-entered through the observer, a gesture or a content commit.
  const gate = transcript.match(
    /const continueEarlierHistory = useCallback\(\((?:readerOwnsViewport = false)?\) => \{([\s\S]*?)\n  \}, \[\]\);/,
  )?.[1];
  assert.ok(gate, "continueEarlierHistory must exist");
  assert.match(gate, /if \(!presentedRef\.current\) return;/);
  assert.match(gate, /reachTopRef\.current\?\.\(readerOwnsViewport\);/);
  // The content commit is the only caller of the fill, and only while covered and
  // unpresented; a presented pane continues only while it owes the viewport.
  assert.match(
    transcript,
    /if \(!presentedRef\.current\) \{\n\s+if \(coveredRef\.current\) requestInitialFill\(\);\n\s+return;\n    \}/,
  );
  assert.match(
    transcript,
    /const owesViewportContent =\n\s+transcriptWindow\.hiddenAbove > 0 \|\|\n\s+root\.scrollHeight <= root\.clientHeight \+ HISTORY_REVEAL_THRESHOLD_PX;\n    if \(!owesViewportContent\) return;\n    scheduleContinueEarlierHistory\(\);/,
  );
});

test("the hydration spacer stays scoped to the first commit", () => {
  // A permanent spacer under the steady-state window would make the user scroll
  // through a blank viewport before reaching the growth trigger.
  assert.match(
    transcript,
    /\{hydrationBounded \? \([\s\S]*?transcript-hydration-spacer/,
  );
  assert.doesNotMatch(
    transcript,
    /transcriptWindow\.bounded \? \([\s\S]{0,200}transcript-hydration-spacer/,
  );
});
