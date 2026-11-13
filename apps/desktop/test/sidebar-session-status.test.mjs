import {
  readStoreModuleSync,
  readMainSourceSync,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  latestSessionOutcomes,
  sidebarSessionStatus,
  sidebarSessionStatusIsTogglable,
} from "../src/lib/sidebar-session-status.ts";
import { loadStylesSync } from "./helpers/styles.mjs";

function notification(overrides) {
  return {
    id: "notification-1",
    kind: "task.completed",
    sessionId: "session-1",
    sessionTitle: "Session",
    turnId: "turn-1",
    createdAt: "2026-07-27T10:00:00.000Z",
    readAt: null,
    ...overrides,
  };
}

test("keeps the newest unread completed or failed outcome for each session", () => {
  const outcomes = latestSessionOutcomes([
    notification({ id: "latest", kind: "task.completed" }),
    notification({ id: "older", kind: "task.failed" }),
    notification({
      id: "other",
      kind: "task.failed",
      sessionId: "session-2",
    }),
  ]);

  assert.deepEqual(outcomes, {
    "session-1": "completed",
    "session-2": "failed",
  });
});

test("read task notifications leave no sidebar indicator", () => {
  const outcomes = latestSessionOutcomes([
    notification({ id: "latest", readAt: "2026-07-27T10:05:00.000Z" }),
    notification({ id: "older", kind: "task.failed" }),
  ]);

  assert.deepEqual(outcomes, {});
});

test("permission, in-progress work, and unread outcomes outrank the manual mark", () => {
  assert.equal(
    sidebarSessionStatus({
      running: true,
      outcome: "failed",
      pending: true,
      hasPendingPermission: true,
    }),
    "permission",
  );
  assert.equal(
    sidebarSessionStatus({ running: true, outcome: "failed", pending: true }),
    "running",
  );
  assert.equal(
    sidebarSessionStatus({ running: false, outcome: "failed", pending: true }),
    "failed",
  );
  assert.equal(
    sidebarSessionStatus({ running: false, outcome: "completed" }),
    "completed",
  );
  assert.equal(sidebarSessionStatus({ running: false, pending: true }), "pending");
  // A selected idle row keeps its hollow mark: selection never blanks it.
  assert.equal(sidebarSessionStatus({ running: false }), "idle");
});

test("only the manual idle mark toggles; every reported state stays informational", () => {
  for (const status of ["permission", "running", "completed", "failed"]) {
    assert.equal(sidebarSessionStatusIsTogglable(status), false, status);
  }
  assert.equal(sidebarSessionStatusIsTogglable("pending"), true);
  assert.equal(sidebarSessionStatusIsTogglable("idle"), true);
});

test("opening a conversation acknowledges its outcome badge before loading details", () => {
  const sessionSource = readStoreModuleSync("slices/session-slice.ts");
  const catalogSource = readStoreModuleSync("slices/catalog-slice.ts");
  const selectBlock = sessionSource.match(/selectSession: async[\s\S]*?\n    newSession:/)?.[0] ?? "";
  const acknowledgementStart = selectBlock.indexOf(
    "const outcomeAcknowledgement = get().acknowledgeSessionOutcome(id);",
  );
  const detailLoadStart = selectBlock.indexOf(
    "const detailPromise = runtime.loadSessionDetail(id",
  );
  assert.ok(acknowledgementStart >= 0);
  assert.ok(detailLoadStart >= 0);
  assert.ok(
    acknowledgementStart < detailLoadStart,
    "session outcome acknowledgement must start before detail loading",
  );
  assert.match(selectBlock, /await outcomeAcknowledgement/);

  const ackBlock = catalogSource.slice(
    catalogSource.indexOf("acknowledgeSessionOutcome: async"),
  );
  assert.match(ackBlock, /withoutRecordKey\(state\.sessionOutcomes, sessionId\)/);
  assert.match(ackBlock, /markNotificationRead\(item\.id\)/);
});

test("renders semantic, shape-distinct sidebar status indicators", () => {
  const mark = fs.readFileSync(
    new URL("../src/features/sessions/SessionStatusMark.tsx", import.meta.url),
    "utf8",
  );
  const sidebar = fs.readFileSync(
    new URL("../src/components/Sidebar.tsx", import.meta.url),
    "utf8",
  );
  const styles = loadStylesSync();
  // The status fixture lives in the capture rig, which App only loads lazily
  // behind __PI_CAPTURE__.
  const app = fs.readFileSync(
    new URL("../src/capture/capture-rig.ts", import.meta.url),
    "utf8",
  );
  const main = readMainSourceSync();

  assert.match(sidebar, /<SessionStatusMark/);
  assert.doesNotMatch(sidebar, /nav\.sessionSelected/);
  // The idle mark is the toggle: a shared button primitive, a pressed state,
  // and a localized name, so it is reachable by pointer and keyboard.
  assert.match(mark, /TooltipButton/);
  assert.match(mark, /aria-pressed={marked}/);
  assert.match(mark, /nav\.sessionPendingMarker/);
  assert.match(mark, /nav\.sessionMarkPending/);
  assert.match(mark, /nav\.sessionClearPending/);
  assert.match(mark, /IconCheck[\s\S]*IconCircleAlert/);
  assert.match(mark, /onDragStart[\s\S]*preventDefault\(\)[\s\S]*stopPropagation\(\)/);
  assert.match(styles, /thread-item-status\.running::before[\s\S]*--ds-warning/);
  assert.match(styles, /thread-item-status\.idle::before[\s\S]*--ds-accent/);
  assert.match(styles, /thread-item-status\.pending::before[\s\S]*--ds-warning/);
  assert.match(styles, /thread-item-status\.completed[\s\S]*--ds-success/);
  assert.match(styles, /thread-item-status\.failed[\s\S]*--ds-error/);
  // The manual mark carries no halo and no animation.
  const pendingBlock = styles.match(
    /\.thread-item-status\.pending::before {[\s\S]*?\n}/,
  )?.[0] ?? "";
  assert.doesNotMatch(pendingBlock, /animation|box-shadow/);
  assert.match(
    styles,
    /prefers-reduced-motion: reduce[\s\S]*thread-item-status\.running::after[\s\S]*animation: none/,
  );
  assert.match(
    app,
    /seedSidebarStatuses[\s\S]*runningSessions[\s\S]*sessionOutcomes/,
  );
  assert.match(
    main,
    /PI_DESKTOP_CAPTURE_STATUS_ONLY[\s\S]*prefers-reduced-motion[\s\S]*SIDEBAR_STATUS_PROBE[\s\S]*pi-sidebar-status-/,
  );
});
