/*
  Electron main process for the native-wheel probe.

  The window is isolated: its own temporary profile, no preload, no host, no
  provider, and it is not the user's desktop. Wheel input is delivered as a real
  `mouseWheel` input event through Chromium's input pipeline, so native scroll
  chaining and `overscroll-behavior` decide what moves. `deltaY` is negated
  because Electron's wheel delta is inverted relative to the DOM's: the driver
  below asks for "positive is down" and passes that on.
*/
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const probeDir = process.env.PROBE_DIR;
if (!probeDir) throw new Error("PROBE_DIR is required");
app.setPath("userData", path.join(probeDir, "profile"));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 760,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const consoleLines = [];
  win.webContents.on("console-message", (event) => {
    consoleLines.push(event.message);
    console.error(event.message);
  });

  const result = { records: {}, steps: [], failures: [], console: consoleLines, environment: {} };
  const probe = (expression) =>
    win.webContents.executeJavaScript("window.transcriptToolWheelProbe." + expression);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wheel = async (point, deltaY, times = 1) => {
    win.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    for (let index = 0; index < times; index++) {
      win.webContents.sendInputEvent({
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX: 0,
        deltaY: -deltaY,
        wheelTicksX: 0,
        wheelTicksY: -Math.sign(deltaY),
        canScroll: true,
        hasPreciseScrollingDeltas: false,
        modifiers: [],
      });
      await wait(60);
    }
  };
  const check = (name, ok, detail) => {
    result.steps.push({ name, ok, detail });
    if (!ok) result.failures.push(name + " :: " + JSON.stringify(detail));
  };

  try {
    await win.loadFile(path.join(probeDir, "index.html"));
    const mounted = await probe("mount()");
    result.environment = {
      viewport: win.getContentSize(),
      outer: mounted.outer,
      cards: mounted.cards,
      todoLists: mounted.todoLists,
    };

    // ── Calibration: a wheel over the transcript's own gutter moves it ──
    await probe("place('short', 260, 'top')");
    let points = await probe("points('short')");
    let before = await probe("read()");
    await wheel(points.gutter, 120);
    let after = await probe("read()");
    result.records.calibration = { before, after };
    check(
      "calibration: a wheel on the transcript gutter scrolls the transcript",
      after.outer.scrollTop > before.outer.scrollTop,
      { before: before.outer.scrollTop, after: after.outer.scrollTop },
    );

    // ── The short checklist: three rows, pointer inside the list ──
    await probe("place('short', 260, 'top')");
    points = await probe("points('short')");
    before = await probe("read()");
    await wheel(points.topPadding, 120);
    after = await probe("read()");
    result.records.shortTopPadding = { point: points.topPadding, before, after };
    check(
      "short list: a wheel in the list's own top padding scrolls the transcript",
      after.outer.scrollTop > before.outer.scrollTop,
      {
        before: before.outer.scrollTop,
        after: after.outer.scrollTop,
        inner: after.cards.short.scrollTop,
      },
    );

    before = after;
    await wheel(points.bottomPadding, -120);
    after = await probe("read()");
    result.records.shortBottomPaddingUp = { point: points.bottomPadding, before, after };
    check(
      "short list: a wheel up in the list's bottom padding scrolls the transcript up",
      after.outer.scrollTop < before.outer.scrollTop,
      { before: before.outer.scrollTop, after: after.outer.scrollTop },
    );
    check("short list: an upward wheel over the card surfaces the jump control", after.jump === true, {
      jump: after.jump,
    });

    before = after;
    await wheel(points.progress, 120);
    after = await probe("read()");
    result.records.shortProgress = { point: points.progress, before, after };
    check(
      "short list: a wheel on the progress line scrolls the transcript",
      after.outer.scrollTop > before.outer.scrollTop,
      { before: before.outer.scrollTop, after: after.outer.scrollTop },
    );

    before = after;
    await wheel(points.gap, 120);
    after = await probe("read()");
    result.records.shortGap = { point: points.gap, before, after };
    check(
      "short list: a wheel in the gap under the progress line scrolls the transcript",
      after.outer.scrollTop > before.outer.scrollTop,
      { before: before.outer.scrollTop, after: after.outer.scrollTop },
    );

    before = after;
    await wheel(points.inner, 120);
    after = await probe("read()");
    result.records.shortInner = { point: points.inner, before, after };
    check(
      "short list: a wheel on a row of a list that cannot scroll scrolls the transcript",
      after.outer.scrollTop > before.outer.scrollTop,
      {
        before: before.outer.scrollTop,
        after: after.outer.scrollTop,
        inner: after.cards.short.scrollTop,
      },
    );
    check(
      "short list: the three-row list itself never scrolls",
      after.cards.short.scrollTop === 0 &&
        after.cards.short.scrollHeight <= after.cards.short.clientHeight + 1,
      after.cards.short,
    );

    // ── The long checklist: it scrolls inside, then hands over at its edges ──
    await probe("place('long', 200, 'top')");
    points = await probe("points('long')");
    before = await probe("read()");
    await wheel(points.inner, 120);
    after = await probe("read()");
    result.records.longInnerDown = { point: points.inner, before, after };
    check(
      "long list: a downward wheel over the list scrolls the list itself",
      after.cards.long.scrollTop > before.cards.long.scrollTop,
      { before: before.cards.long.scrollTop, after: after.cards.long.scrollTop },
    );
    check(
      "long list: the transcript does not move while the list consumes the wheel",
      after.outer.scrollTop === before.outer.scrollTop,
      { before: before.outer.scrollTop, after: after.outer.scrollTop },
    );

    await wheel(points.inner, 120, 12);
    const atBottom = await probe("read()");
    before = atBottom;
    await wheel(points.inner, 120, 3);
    after = await probe("read()");
    result.records.longBottomHandoff = { atBottom, before, after };
    check(
      "long list: the list reaches its own bottom before the transcript moves",
      atBottom.cards.long.scrollTop + atBottom.cards.long.clientHeight >=
        atBottom.cards.long.scrollHeight - 1,
      atBottom.cards.long,
    );
    check(
      "long list: at its bottom edge the gesture continues in the transcript",
      after.outer.scrollTop > before.outer.scrollTop,
      {
        before: before.outer.scrollTop,
        after: after.outer.scrollTop,
        inner: after.cards.long.scrollTop,
      },
    );

    await probe("place('long', 200, 'bottom')");
    points = await probe("points('long')");
    before = await probe("read()");
    await wheel(points.inner, -120);
    after = await probe("read()");
    result.records.longInnerUp = { point: points.inner, before, after };
    check(
      "long list: an upward wheel over the list scrolls the list itself",
      after.cards.long.scrollTop < before.cards.long.scrollTop,
      { before: before.cards.long.scrollTop, after: after.cards.long.scrollTop },
    );
    check(
      "long list: the transcript does not move while the list consumes the upward wheel",
      after.outer.scrollTop === before.outer.scrollTop,
      { before: before.outer.scrollTop, after: after.outer.scrollTop },
    );

    // The transcript is moved down first, so the upward handoff has somewhere
    // to go, then the list is parked at its own top edge.
    await wheel(points.gutter, 120, 3);
    await probe("place('long', 200, 'top')");
    points = await probe("points('long')");
    before = await probe("read()");
    await wheel(points.inner, -120, 2);
    after = await probe("read()");
    result.records.longTopHandoffUp = { point: points.inner, before, after };
    check(
      "long list: at its top edge an upward gesture continues in the transcript",
      after.outer.scrollTop < before.outer.scrollTop,
      {
        before: before.outer.scrollTop,
        after: after.outer.scrollTop,
        inner: after.cards.long.scrollTop,
      },
    );
    check(
      "long list: the chained upward gesture belongs to the transcript and surfaces the jump control",
      after.jump === true,
      { jump: after.jump },
    );

    // ── Ownership: a gesture the inner list consumes is not the transcript's ──
    // The transcript is read to its exact top with real wheel input, so follow is
    // released the way a reader releases it.
    for (let attempt = 0; attempt < 12; attempt++) {
      const state = await probe("read()");
      if (state.outer.scrollTop === 0) break;
      const gutter = (await probe("points('short')")).gutter;
      await wheel(gutter, -600);
    }
    const atTop = await probe("read()");
    await probe("resetOlderReads()");
    points = await probe("points('long')");
    before = await probe("read()");
    await wheel(points.inner, 120, 2);
    after = await probe("read()");
    result.records.ownership = { atTop, point: points.inner, before, after };
    check(
      "ownership: the transcript is at its own top boundary when the gesture starts",
      before.outer.scrollTop === 0,
      { outer: before.outer.scrollTop },
    );
    check(
      "ownership: the gesture reached the long list and scrolled it",
      after.cards.long.scrollTop > before.cards.long.scrollTop,
      { before: before.cards.long.scrollTop, after: after.cards.long.scrollTop },
    );
    check(
      "ownership: a gesture the inner list consumes does not ask the transcript for older history",
      after.olderReads === 0,
      { olderReads: after.olderReads },
    );

    // ── The other passive card surfaces the reader wheels over ──
    await probe("place('values', 260, 'top')");
    points = await probe("points('values')");
    before = await probe("read()");
    await wheel(points.topPadding, 120);
    after = await probe("read()");
    result.records.valuesTopPadding = { point: points.topPadding, before, after };
    check(
      "values list: a wheel in the list's own top padding scrolls the transcript",
      after.outer.scrollTop > before.outer.scrollTop,
      {
        before: before.outer.scrollTop,
        after: after.outer.scrollTop,
        inner: after.cards.values.scrollTop,
      },
    );

    await probe("place('document', 260, 'top')");
    points = await probe("points('document')");
    before = await probe("read()");
    await wheel(points.topPadding, 120);
    after = await probe("read()");
    result.records.documentTopPadding = { point: points.topPadding, before, after };
    check(
      "document body: a wheel in the body's own top padding scrolls the transcript",
      after.outer.scrollTop > before.outer.scrollTop,
      {
        before: before.outer.scrollTop,
        after: after.outer.scrollTop,
        inner: after.cards.document.scrollTop,
      },
    );

    await probe("place('fields', 260, 'top')");
    points = await probe("points('fields')");
    before = await probe("read()");
    await wheel(points.topPadding, 120);
    after = await probe("read()");
    result.records.fieldsTopPadding = { point: points.topPadding, before, after };
    check(
      "fields list: a wheel in the list's own top padding scrolls the transcript",
      after.outer.scrollTop > before.outer.scrollTop,
      {
        before: before.outer.scrollTop,
        after: after.outer.scrollTop,
        inner: after.cards.fields.scrollTop,
      },
    );
  } catch (error) {
    result.failures.push("probe error: " + (error && error.stack ? error.stack : String(error)));
  }

  console.log("TOOL_WHEEL_PROBE " + JSON.stringify(result));
  app.exit(result.failures.length === 0 ? 0 : 1);
});
