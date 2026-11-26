/**
 * Progressive mounting of a delegate transcript's loaded rows.
 *
 * A 500-row scoped page used to reach the DOM as one React commit. These cases
 * pin the commit shape that replaces it: a bounded first run near the tail, one
 * batch per following frame, every loaded row mounted at the end, and no row
 * that the reader can already see dropped when an older page or a live row
 * arrives mid-hydration. The pump is driven by a controlled clock, so the batch
 * boundaries are assertions rather than timing guesses.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  EMPTY_SUBAGENT_HYDRATION,
  SUBAGENT_HYDRATION_FIRST_ROWS,
  SUBAGENT_HYDRATION_STEP_ROWS,
  buildSubagentTranscriptUnits,
  classifySubagentRowChange,
  createSubagentHydrationPump,
  initialSubagentHydration,
  reduceSubagentHydration,
  stabilizeSubagentTranscriptUnits,
  subagentHydrationPending,
  subagentPaneVisible,
  subagentRowMounted,
  subagentVisibleCount,
  subagentVisibleRows,
} = await import("../src/lib/subagent-hydration.ts");

const { buildSubagentTranscript } = await import("../src/lib/subagent-transcript.ts");

const POLICY = { firstRows: SUBAGENT_HYDRATION_FIRST_ROWS, stepRows: SUBAGENT_HYDRATION_STEP_ROWS };
/** A state that mounts the trailing `mounted` rows of `rowCount`, for these cases. */
const windowOf = (rowCount, mounted) => ({ rowCount, start: rowCount - mounted, end: rowCount });

const keysOf = (ids) => ids.map((id) => `answer-${id}`);
const ids = (count, from = 0, prefix = "row") =>
  Array.from({ length: count }, (_, offset) => `${prefix}-${from + offset}`);

/** Drive the reducer to the end of its batches, recording every commit. */
function drain(state, policy = POLICY) {
  const commits = [subagentVisibleCount(state)];
  let guard = 0;
  while (subagentHydrationPending(state)) {
    state = reduceSubagentHydration(state, { kind: "step" }, policy);
    commits.push(subagentVisibleCount(state));
    guard += 1;
    assert.ok(guard < 10_000, "the batches terminate");
  }
  return { state, commits };
}

/* ---------- the first commit and the batches that follow ---------- */

test("a replaced interval mounts a bounded run near the tail first", () => {
  const state = initialSubagentHydration(500, POLICY);
  assert.equal(state.rowCount, 500);
  assert.equal(subagentVisibleCount(state), SUBAGENT_HYDRATION_FIRST_ROWS);
  const rows = ids(500);
  const visible = subagentVisibleRows(rows, state);
  assert.equal(visible.length, SUBAGENT_HYDRATION_FIRST_ROWS);
  assert.equal(
    visible[0],
    "row-468",
    "the first commit is the newest rows, not the head of the page",
  );
  assert.equal(visible.at(-1), "row-499");
  assert.equal(subagentRowMounted(state, 468), true);
  assert.equal(subagentRowMounted(state, 467), false);
});

test("each following frame mounts one more bounded batch, and every row lands", () => {
  const rows = ids(500);
  const start = initialSubagentHydration(rows.length, POLICY);
  const { state, commits } = drain(start);
  assert.equal(subagentVisibleCount(state), rows.length, "every loaded row ends up mounted");
  assert.equal(subagentHydrationPending(state), false);
  for (let index = 1; index < commits.length; index += 1) {
    const grew = commits[index] - commits[index - 1];
    assert.ok(grew > 0, `batch ${index} mounts rows`);
    assert.ok(
      grew <= SUBAGENT_HYDRATION_STEP_ROWS,
      `batch ${index} stays inside one batch (${grew} rows)`,
    );
  }
  assert.equal(
    commits.length,
    1 + Math.ceil((rows.length - SUBAGENT_HYDRATION_FIRST_ROWS) / SUBAGENT_HYDRATION_STEP_ROWS),
    "a page costs one bounded first commit plus one batch per frame",
  );
  assert.deepEqual(subagentVisibleRows(rows, state), rows, "the projection is the whole interval");
});

test("the mounted run is contiguous at every batch boundary", () => {
  const rows = ids(500);
  let state = initialSubagentHydration(rows.length, POLICY);
  const seen = [subagentVisibleRows(rows, state)];
  while (subagentHydrationPending(state)) {
    state = reduceSubagentHydration(state, { kind: "step" }, POLICY);
    seen.push(subagentVisibleRows(rows, state));
  }
  for (const [index, visible] of seen.entries()) {
    assert.ok(visible.length > 0, `batch ${index} mounts something`);
    assert.equal(
      visible.at(-1),
      rows.at(-1),
      `batch ${index} keeps the newest row mounted, so the tail never moves`,
    );
    const start = rows.length - visible.length;
    assert.deepEqual(visible, rows.slice(start), `batch ${index} is one contiguous trailing run`);
  }
});

/* ---------- growth underneath the batches ---------- */

test("an older page keeps the mounted rows and hides only the rows above them", () => {
  const tail = keysOf(ids(500));
  const older = keysOf(ids(500, -500));
  const grown = [...older, ...tail];
  const state = windowOf(tail.length, tail.length);
  const change = classifySubagentRowChange(tail, grown);
  assert.deepEqual(change, { kind: "growth", rowCount: 1000, hiddenAbove: 500, retained: 500 });
  const next = reduceSubagentHydration(state, { kind: "rows", change });
  assert.equal(subagentVisibleCount(next), 500, "the page the reader was reading stays mounted");
  assert.equal(next.rowCount, 1000);

  let current = next;
  const previousVisible = subagentVisibleRows(grown, current);
  assert.equal(
    previousVisible[0],
    "answer-row-0",
    "the first already-mounted row is still the oldest visible row",
  );
  // Every batch of the page adds rows above the ones already mounted, so the
  // oldest visible row moves upward through the page and nothing is dropped.
  let lastVisible = subagentVisibleCount(current);
  while (subagentHydrationPending(current)) {
    current = reduceSubagentHydration(current, { kind: "step" }, POLICY);
    assert.ok(subagentVisibleCount(current) > lastVisible, "a batch mounts more of the loaded page");
    assert.equal(subagentVisibleRows(grown, current).at(-1), "answer-row-499");
    lastVisible = subagentVisibleCount(current);
  }
  assert.deepEqual(
    subagentVisibleRows(grown, current),
    grown,
    "the whole loaded interval is mounted once the batches finish, the page's head included",
  );
});

test("a live row appended mid-hydration mounts immediately and drops nothing", () => {
  const tail = keysOf(ids(500));
  const older = keysOf(ids(500, -500));
  const grown = [...older, ...tail];
  const live = "answer-live-1";
  let state = reduceSubagentHydration(
    windowOf(500, 500),
    { kind: "rows", change: classifySubagentRowChange(tail, grown) },
  );
  state = reduceSubagentHydration(state, { kind: "step" }, POLICY);
  const visibleBefore = subagentVisibleRows(grown, state);
  assert.equal(subagentVisibleCount(state), 628);
  state = reduceSubagentHydration(state, {
    kind: "rows",
    change: classifySubagentRowChange(grown, [...grown, live]),
  });
  const visibleAfter = subagentVisibleRows([...grown, live], state);
  assert.equal(subagentVisibleCount(state), 629, "the live row is mounted without waiting for a batch");
  assert.equal(visibleAfter.at(-1), live, "the newest row is drawn");
  assert.equal(
    visibleBefore.length + 1,
    visibleAfter.length,
    "exactly the live row was added to the mounted run",
  );
  assert.deepEqual(
    visibleAfter.slice(0, -1),
    visibleBefore,
    "no row the reader could see was dropped by the append",
  );
});

test("an older page and a live row that land together keep both", () => {
  const tail = keysOf(ids(500));
  const older = keysOf(ids(500, -500));
  const live = "answer-live-1";
  const grown = [...older, ...tail, live];
  const change = classifySubagentRowChange(tail, grown);
  assert.deepEqual(change, { kind: "growth", rowCount: 1001, hiddenAbove: 500, retained: 500 });
  const next = reduceSubagentHydration(windowOf(500, 500), { kind: "rows", change });
  assert.equal(subagentVisibleCount(next), 501, "the tail keeps its live row while the page hydrates");
  assert.equal(subagentVisibleRows(grown, next).at(-1), live);
});

test("a live tail row the durable page no longer names is growth, not a replacement", () => {
  // The interval a latest read leaves behind can name a live row that the
  // older page, merged from the durable store, does not: the loaded list
  // shrinks at the tail while a page prepends above it. That is still the same
  // interval, so the reader keeps every surviving row instead of being reset
  // to the bounded tail.
  const live = "answer-live-tail";
  const loaded = [...keysOf(ids(3000)), live];
  const durableOlder = keysOf(ids(500, -500));
  const durableTail = keysOf(ids(3000));
  const merged = [...durableOlder, ...durableTail];
  const change = classifySubagentRowChange(loaded, merged);
  assert.deepEqual(change, {
    kind: "growth",
    rowCount: 3500,
    hiddenAbove: 500,
    retained: 3000,
  });
  const next = reduceSubagentHydration(
    windowOf(loaded.length, loaded.length),
    { kind: "rows", change },
  );
  assert.equal(subagentVisibleCount(next), 3000, "the surviving rows stay mounted");
  assert.deepEqual(
    subagentVisibleRows(merged, next),
    durableTail,
    "the run still ends at the last surviving row, with nothing dropped below it",
  );
  // The page above the reader is hydrated as usual, one batch per frame.
  let current = next;
  while (subagentHydrationPending(current)) {
    current = reduceSubagentHydration(current, { kind: "step" }, POLICY);
  }
  assert.deepEqual(subagentVisibleRows(merged, current), merged, "the whole merged interval mounts");
});

test("a forward page appended below the mounted run mounts in bounded batches", () => {
  // A focus window inside a chain has rows on both sides, so continuing to the
  // later boundary appends a whole page below the run the reader is reading.
  // That page has to arrive the way an older one does - one batch per commit -
  // and no row the reader can already see may be dropped while it does.
  const window = keysOf(ids(500));
  const newer = keysOf(ids(500, 500));
  const grown = [...window, ...newer];
  let state = initialSubagentHydration(window.length, POLICY);
  while (subagentHydrationPending(state)) {
    state = reduceSubagentHydration(state, { kind: "step" }, POLICY);
  }
  const before = subagentVisibleRows(window, state);
  assert.equal(before.length, window.length, "the focus window is fully mounted first");

  const change = classifySubagentRowChange(window, grown);
  assert.deepEqual(change, { kind: "growth", rowCount: 1000, hiddenAbove: 0, retained: 500 });
  const first = reduceSubagentHydration(state, { kind: "rows", change });
  const firstRows = subagentVisibleRows(grown, first);
  assert.equal(
    firstRows.length - before.length,
    SUBAGENT_HYDRATION_STEP_ROWS,
    "the appended page's first commit is one batch, not the whole page",
  );
  assert.deepEqual(
    firstRows.slice(0, before.length),
    before,
    "no row the reader could see was dropped by the append",
  );
  assert.equal(
    subagentHydrationPending(first),
    true,
    "the rest of the appended page waits for its batches",
  );

  let current = first;
  let lastVisible = firstRows.length;
  let guard = 0;
  while (subagentHydrationPending(current)) {
    current = reduceSubagentHydration(current, { kind: "step" }, POLICY);
    const visible = subagentVisibleRows(grown, current);
    const grew = visible.length - lastVisible;
    assert.ok(grew > 0, "a batch mounts more of the appended page");
    assert.ok(grew <= SUBAGENT_HYDRATION_STEP_ROWS, `a batch stays inside one batch (${grew} rows)`);
    assert.deepEqual(visible, grown.slice(0, visible.length), "the run stays contiguous from the reader's rows");
    lastVisible = visible.length;
    guard += 1;
    assert.ok(guard < 100, "the batches terminate");
  }
  assert.deepEqual(subagentVisibleRows(grown, current), grown, "every loaded row ends up mounted");
});

/* ---------- replacements, shrinks, reveals ---------- */

test("a replaced interval restarts at the bounded tail", () => {
  const previous = keysOf(ids(1500));
  const replaced = keysOf(ids(500, 4000));
  const change = classifySubagentRowChange(previous, replaced);
  assert.deepEqual(change, { kind: "replace", rowCount: 500 });
  const next = reduceSubagentHydration(
    windowOf(previous.length, previous.length),
    { kind: "rows", change },
  );
  assert.equal(subagentVisibleCount(next), SUBAGENT_HYDRATION_FIRST_ROWS, "a latest/focus read starts bounded");
  assert.equal(next.rowCount, 500);
});

test("an interval that no longer contains the mounted rows is a replacement, not growth", () => {
  const previous = keysOf(ids(500));
  // Same head, different interval: a shifted window is not a prepend.
  const shifted = keysOf(ids(500, 200));
  assert.deepEqual(classifySubagentRowChange(previous, shifted), {
    kind: "replace",
    rowCount: 500,
  });
  // A shrink that keeps no previous row.
  const shrunk = keysOf(ids(50, 900));
  assert.deepEqual(classifySubagentRowChange(previous, shrunk), {
    kind: "replace",
    rowCount: 50,
  });
});

test("an empty list or an unknown row identity never reads as growth", () => {
  assert.deepEqual(classifySubagentRowChange([], keysOf(ids(3))), { kind: "replace", rowCount: 3 });
  assert.deepEqual(classifySubagentRowChange(keysOf(ids(3)), []), { kind: "replace", rowCount: 0 });
  const next = reduceSubagentHydration(
    EMPTY_SUBAGENT_HYDRATION,
    { kind: "rows", change: classifySubagentRowChange(keysOf(ids(3)), keysOf(ids(3)) ) },
  );
  assert.equal(subagentVisibleCount(next), 3, "an unchanged short list is mounted whole");
});

test("no event can mount a page in one commit: a reach only continues the batches", () => {
  // The reducer has exactly two events: rows, and one bounded step. There is no
  // event that mounts the whole loaded interval, so no gesture (a boundary
  // reach, a search hit, a page entry) can turn a page into one heavy commit.
  const rows = ids(3500);
  let state = initialSubagentHydration(rows.length, POLICY);
  const { state: done, commits } = drain(state);
  assert.equal(subagentVisibleCount(done), rows.length, "the batches reach every loaded row");
  for (const [index, mounted] of commits.entries()) {
    const previous = index === 0 ? SUBAGENT_HYDRATION_FIRST_ROWS : commits[index - 1];
    assert.ok(
      mounted - previous <= SUBAGENT_HYDRATION_STEP_ROWS,
      `commit ${index} adds at most one batch (${mounted - previous} rows)`,
    );
  }
});

test("a completed state is a fixed point", () => {
  const done = windowOf(12, 12);
  assert.deepEqual(reduceSubagentHydration(done, { kind: "step" }), done);
  assert.deepEqual(reduceSubagentHydration(done, { kind: "step" }), done);
  assert.deepEqual(reduceSubagentHydration(EMPTY_SUBAGENT_HYDRATION, { kind: "step" }), EMPTY_SUBAGENT_HYDRATION);
});

test("500 and 3500 rows complete with bounded commits and no row budget", () => {
  for (const total of [500, 3500]) {
    const rows = ids(total);
    const { state, commits } = drain(initialSubagentHydration(total, POLICY));
    assert.equal(subagentVisibleCount(state), total);
    assert.equal(subagentVisibleRows(rows, state).length, total, `${total} rows all mount`);
    assert.ok(
      commits.length <= 1 + Math.ceil(total / SUBAGENT_HYDRATION_STEP_ROWS),
      `${total} rows need at most one batch per frame`,
    );
  }
});

/* ---------- the frame pump ---------- */

function controlledClock() {
  const queued = new Map();
  let handle = 0;
  return {
    clock: {
      request: (callback) => {
        handle += 1;
        queued.set(handle, callback);
        return handle;
      },
      cancel: (id) => queued.delete(id),
    },
    /** Run every frame that is queued now, exactly once, in order. */
    frame() {
      const run = [...queued.entries()];
      queued.clear();
      for (const [, callback] of run) callback();
    },
    pending: () => queued.size,
  };
}

test("the pump commits one batch per frame and captures the reading position before each", () => {
  const clock = controlledClock();
  const log = [];
  let state = EMPTY_SUBAGENT_HYDRATION;
  const pump = createSubagentHydrationPump({
    clock: clock.clock,
    policy: POLICY,
    publish: (next) => {
      state = next;
      log.push({ kind: "commit", mounted: subagentVisibleCount(next), rowCount: next.rowCount });
    },
    beforeBatch: () => log.push({ kind: "before", mounted: subagentVisibleCount(state) }),
  });
  pump.observe(keysOf(ids(500)));
  assert.deepEqual(state, windowOf(500, SUBAGENT_HYDRATION_FIRST_ROWS));
  let guard = 0;
  while (clock.pending()) {
    clock.frame();
    guard += 1;
    assert.ok(guard < 10, "the pump stops scheduling once the rows are mounted");
  }
  assert.equal(subagentVisibleCount(state), 500);
  assert.equal(clock.pending(), 0, "a hydrated pump leaves no frame queued");
  const batches = log.filter((entry) => entry.kind === "commit");
  assert.equal(
    batches.at(-1).mounted,
    500,
    "the last commit mounts the rows the batches did not reach",
  );
  // One capture per batch, always immediately before that batch's commit, and
  // it sees the run the previous commit published.
  const captures = [];
  for (const [index, entry] of log.entries()) {
    if (entry.kind !== "before") continue;
    assert.equal(log[index + 1]?.kind, "commit", "the capture runs just before its commit");
    captures.push(entry.mounted);
  }
  assert.deepEqual(
    captures,
    batches.slice(0, -1).map((entry) => entry.mounted),
    "each batch captures the run its predecessor published",
  );
});

test("a replaced interval cancels the batch that belonged to the old one", () => {
  const clock = controlledClock();
  const commits = [];
  const pump = createSubagentHydrationPump({
    clock: clock.clock,
    policy: POLICY,
    publish: (next) => commits.push(next),
  });
  pump.observe(keysOf(ids(500)));
  assert.equal(clock.pending(), 1);
  pump.observe(keysOf(ids(500, 9000)));
  assert.deepEqual(commits.at(-1), windowOf(500, SUBAGENT_HYDRATION_FIRST_ROWS));
  assert.equal(clock.pending(), 1, "the replaced interval queues its own batch, not the old one");
  const before = commits.length;
  clock.frame();
  assert.deepEqual(
    commits.slice(before),
    [windowOf(500, SUBAGENT_HYDRATION_FIRST_ROWS + SUBAGENT_HYDRATION_STEP_ROWS)],
    "the frame that runs mounts the new interval's next batch",
  );
  pump.dispose();
  assert.equal(clock.pending(), 0, "a disposed pump holds no frame");
});

test("stop keeps what is mounted and cancel is immediate", () => {
  const clock = controlledClock();
  const commits = [];
  const pump = createSubagentHydrationPump({
    clock: clock.clock,
    policy: POLICY,
    publish: (next) => commits.push(next),
  });
  pump.observe(keysOf(ids(3500)));
  clock.frame();
  assert.equal(
    subagentVisibleCount(pump.snapshot()),
    SUBAGENT_HYDRATION_FIRST_ROWS + SUBAGENT_HYDRATION_STEP_ROWS,
  );
  pump.stop();
  assert.equal(clock.pending(), 0, "stop cancels the queued batch");
  assert.equal(
    subagentVisibleCount(commits.at(-1)),
    SUBAGENT_HYDRATION_FIRST_ROWS + SUBAGENT_HYDRATION_STEP_ROWS,
    "stop does not drop the rows that are already mounted",
  );

  pump.observe(keysOf(ids(3500, 0, "later")));
  assert.equal(clock.pending(), 1);
  pump.stop();
  assert.equal(clock.pending(), 0, "a superseded read stops scheduling");
  assert.equal(subagentVisibleCount(pump.snapshot()), SUBAGENT_HYDRATION_FIRST_ROWS);
});

test("a pane with no visible box pauses its batches and resumes them bounded", () => {
  const clock = controlledClock();
  const commits = [];
  const pump = createSubagentHydrationPump({
    clock: clock.clock,
    policy: POLICY,
    publish: (next) => commits.push(next),
  });
  pump.observe(keysOf(ids(2000)));
  assert.equal(clock.pending(), 1, "a visible pane arms its next batch");
  clock.frame();
  assert.equal(
    subagentVisibleCount(commits.at(-1)),
    SUBAGENT_HYDRATION_FIRST_ROWS + SUBAGENT_HYDRATION_STEP_ROWS,
  );

  // The pane is hidden: the queued batch is cancelled, and nothing else is
  // scheduled however long the rows stay loaded.
  pump.setActive(false);
  assert.equal(clock.pending(), 0, "an invisible pane cancels its queued batch");
  for (let frame = 0; frame < 5; frame += 1) clock.frame();
  assert.equal(
    subagentVisibleCount(commits.at(-1)),
    SUBAGENT_HYDRATION_FIRST_ROWS + SUBAGENT_HYDRATION_STEP_ROWS,
  );
  assert.equal(clock.pending(), 0);

  // A list that changes while the pane is hidden re-founds the window but
  // still schedules nothing.
  pump.observe(keysOf(ids(2400, 6000)));
  assert.equal(clock.pending(), 0, "a replaced interval in a hidden pane schedules nothing");
  assert.equal(commits.at(-1).rowCount, 2400, "the replacement is still committed bounded");
  assert.equal(subagentVisibleCount(commits.at(-1)), SUBAGENT_HYDRATION_FIRST_ROWS);

  // Visible again: the batches resume from the commit state, one per frame.
  pump.setActive(true);
  assert.equal(clock.pending(), 1);
  clock.frame();
  assert.equal(
    subagentVisibleCount(commits.at(-1)),
    SUBAGENT_HYDRATION_FIRST_ROWS + SUBAGENT_HYDRATION_STEP_ROWS,
    "resuming spends one batch, not the page",
  );
  pump.setActive(false);
  assert.equal(clock.pending(), 0, "hiding again cancels the next batch");
  pump.dispose();
  assert.equal(clock.pending(), 0);
});

test("pane visibility needs both the window and the pane's own box", () => {
  assert.equal(subagentPaneVisible({ windowVisible: true, width: 420, height: 640 }), true);
  assert.equal(
    subagentPaneVisible({ windowVisible: false, width: 420, height: 640 }),
    false,
    "a hidden window pauses the pane whatever its box says",
  );
  assert.equal(
    subagentPaneVisible({ windowVisible: true, width: 0, height: 0 }),
    false,
    "a pane without layout pauses even in a visible window",
  );
});

test("a pump with no frame source commits the first bounded run and stops", () => {
  const clock = controlledClock();
  const pump = createSubagentHydrationPump({
    clock: { request: () => 0, cancel: () => undefined },
    policy: POLICY,
    publish: () => undefined,
  });
  pump.observe(keysOf(ids(500)));
  assert.deepEqual(pump.snapshot(), windowOf(500, SUBAGENT_HYDRATION_FIRST_ROWS));
  assert.equal(clock.pending(), 0);
});

/* ---------- the flat projection ---------- */

function message(id, content, extra = {}) {
  return { id, content, ...extra };
}

function taskCall(id, task, extra = {}) {
  return message(id, "", {
    role: "tool",
    toolName: "Task",
    toolCallId: id,
    toolArgs: { task },
    ...extra,
  });
}

test("the flat projection is the turn list, prompt rows included once", () => {
  const messages = [
    taskCall("call-1", "first run", { toolResult: { delegationId: "del-1" } }),
    message("child-1-a", "answer one", { role: "assistant", parentToolCallId: "call-1" }),
    taskCall("call-2", "resume run", {
      toolArgs: { task: "resume run", resume: "call-1" },
      toolResult: { delegationId: "del-1" },
    }),
    message("child-2-a", "answer two", { role: "assistant", parentToolCallId: "call-2" }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1", { promptVisible: () => true });
  const units = buildSubagentTranscriptUnits(transcript.turns);
  assert.deepEqual(
    units.map((unit) => [unit.kind, unit.messageId]),
    [
      ["prompt", "call-1"],
      ["answer", "child-1-a"],
      ["prompt", "call-2"],
      ["answer", "child-2-a"],
    ],
    "each run opens once at its own position, then its rows",
  );
  assert.equal(new Set(units.map((unit) => unit.key)).size, units.length, "keys are unique");
  assert.deepEqual(
    units.map((unit) => unit.key),
    ["prompt-call-1", "answer-child-1-a", "prompt-call-2", "answer-child-2-a"],
    "a row's key is its stable source identity",
  );

  assert.deepEqual(
    buildSubagentTranscriptUnits(
      buildSubagentTranscript(messages, "del-1", { promptVisible: () => false }).turns,
    ).map((unit) => unit.messageId),
    ["child-1-a", "child-2-a"],
    "a window that has not reached a run's opening draws only its rows",
  );
});

test("stabilization reuses unchanged row units and replaces changed ones", () => {
  const turns = [
    {
      callId: "call-1",
      messageId: "call-1",
      task: "first run",
      showPrompt: true,
      rows: [
        { kind: "answer", message: message("child-1", "answer one") },
        { kind: "thinking", message: message("child-2", "reasoning") },
      ],
    },
  ];
  const first = buildSubagentTranscriptUnits(turns);
  const rebuilt = buildSubagentTranscriptUnits(turns);
  const stabilized = stabilizeSubagentTranscriptUnits(first, rebuilt);
  assert.equal(stabilized[0], first[0], "the prompt unit is reused when nothing changed");
  assert.equal(stabilized[1], first[1], "the answer unit is reused when nothing changed");
  assert.equal(stabilized[2], first[2]);

  const edited = [
    {
      ...turns[0],
      rows: [
        { kind: "answer", message: message("child-1", "answer one, restated") },
        turns[0].rows[1],
      ],
    },
  ];
  const next = buildSubagentTranscriptUnits(edited);
  const mixed = stabilizeSubagentTranscriptUnits(stabilized, next);
  assert.notEqual(mixed[1], stabilized[1], "a message that changed gets a fresh unit");
  assert.equal(mixed[2], stabilized[2], "a message that did not change keeps its unit");
});
