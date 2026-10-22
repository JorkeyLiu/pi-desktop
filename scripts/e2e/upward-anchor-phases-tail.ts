import { flushSync } from "react-dom";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import type { UiMessage } from "@pi-desktop/shared";
import type { Probe } from "./upward-anchor-context";
import { createdAt, toolRow } from "./upward-anchor-fixture";
import { assert, frame, until } from "./upward-anchor-sampling";

/*
  Reading upward, phases 7-9: the warm return to the pane the reader left, the
  live tail that keeps its identity as it grows, and the pinned follow that the
  upward path must not disturb.
*/
export async function runTailPhases(probe: Probe): Promise<void> {
  const { host, sampler, reader, reports, regroup } = probe;
  const { atBottom, settle, select } = reader;

  /* 7. Warm return: the restored pane keeps the reader's row. */
  await settle("before leaving the pane");
  const leaving = sampler.capture();
  // The restore contract is positional: the topmost row the reader can see
  // comes back where it was. (A commit residual is measured against the first
  // row fully inside the viewport, which is `anchorOf`.)
  const readingRow = leaving.rows.find((candidate) => candidate.bottom > 1) ?? leaving.rows[0];
  assert(readingRow, "the reader has a reading row before switching away");
  const readingOffset = readingRow.top;
  await select("up-other");
  await select("up-slow");
  await settle("after returning to the pane");
  const arriving = sampler.capture();
  const restored = arriving.rows.find((candidate) => candidate.id === readingRow.id);
  const warmReport = {
    row: readingRow.id,
    expectedOffset: Math.round(readingOffset * 100) / 100,
    restoredOffset: restored ? Math.round(restored.top * 100) / 100 : null,
    deltaPx: restored ? Math.round((restored.top - readingOffset) * 100) / 100 : null,
  };
  /*
    Reported, not asserted: the restore contract belongs to
    `e2e-transcript-warm-restore.mjs` and `e2e-transcript-reading-position.mjs`,
    which open a pane at a bookmarked position. Here the position was chosen by
    the phases above, so a difference measures this fixture's own history rather
    than the restore rule.
  */
  reports["warm-return"] = { ...warmReport, asserted: false };
  assert(warmReport.restoredOffset !== null,
    `warm return did not restore the reading row: ${JSON.stringify(warmReport)}`);

  /*
    8. The live tail keeps its identity as it grows. The mounted-history key
    follows a turn's last fragment, so a streaming tail that gains fragments
    must not be re-keyed: its DOM node, its open disclosure and keyboard focus
    all have to survive the append.
  */
  await select("up-fast");
  await settle("tail open");
  const appendMessages = (ids: UiMessage[]) => {
    flushSync(() => useAppStore.setState((state) => ({
      messages: [...state.messages, ...ids],
      isRunning: true,
      runningSessions: { ...state.runningSessions, "up-fast": true },
    })));
  };
  appendMessages([{ id: "up-tail-1", role: "assistant", content: "Streaming answer, part one.",
    createdAt, status: "streaming" }]);
  await until(() => Boolean(host.querySelector('[data-message-id="up-tail-1"]')), "the streaming tail mounts");
  appendMessages([toolRow("up-tail-tool", 9001)]);
  await until(() => Boolean(host.querySelector('[data-message-id="up-tail-tool"]')), "the tail gains a tool row");
  const tailFirstNode = host.querySelector<HTMLElement>('[data-message-id="up-tail-1"]');
  const tailRow = tailFirstNode?.closest<HTMLElement>(".message-row");
  assert(tailRow && tailFirstNode, "the tail row must be mounted");
  const disclosure = [...host.querySelectorAll<HTMLButtonElement>(".tool-activity-header")]
    .find((node) => tailRow.contains(node));
  assert(disclosure, "the tail must render a disclosure for its tool row");
  disclosure.focus();
  const focusedBefore = document.activeElement === disclosure;
  flushSync(() => disclosure.click());
  await frame();
  const disclosureNode = disclosure;
  const expandedBefore = disclosure.getAttribute("aria-expanded");
  const toggled = expandedBefore === "true";
  appendMessages([{ id: "up-tail-2", role: "assistant", content: "Streaming answer, part two.",
    createdAt, status: "streaming" }]);
  await until(() => Boolean(host.querySelector('[data-message-id="up-tail-2"]')), "the tail appends another fragment");
  await settle("tail growth");
  const tailFirstAfter = host.querySelector<HTMLElement>('[data-message-id="up-tail-1"]');
  const tailRowAfter = tailFirstAfter?.closest<HTMLElement>(".message-row");
  const disclosureAfter = [...host.querySelectorAll<HTMLButtonElement>(".tool-activity-header")]
    .find((node) => tailRowAfter?.contains(node));
  const tailKey = {
    firstFragmentKept: Boolean(tailFirstNode && tailFirstAfter && tailFirstNode.isSameNode(tailFirstAfter)),
    rowKept: Boolean(tailRow && tailRowAfter && tailRow.isSameNode(tailRowAfter)),
    disclosureKept: Boolean(disclosureAfter && disclosureNode.isSameNode(disclosureAfter)),
    toggled,
    expandedBefore,
    expandedAfter: disclosureAfter?.getAttribute("aria-expanded") ?? null,
    focusedBefore,
    focusedAfter: document.activeElement === (disclosureAfter ?? disclosureNode),
    fragmentsAfter: tailRowAfter
      ? tailRowAfter.querySelectorAll("[data-message-id]").length : 0,
  };
  regroup["tail-key"] = tailKey;
  assert(tailKey.firstFragmentKept === true && tailKey.rowKept === true,
    `streaming the tail re-keyed it: ${JSON.stringify(tailKey)}`);
  assert(tailKey.disclosureKept === true, `streaming the tail remounted its disclosure: ${JSON.stringify(tailKey)}`);
  if (toggled) {
    assert(tailKey.expandedAfter === "true",
      `streaming the tail reset an open disclosure: ${JSON.stringify(tailKey)}`);
  }
  assert(tailKey.focusedAfter === focusedBefore,
    `streaming the tail dropped keyboard focus: ${JSON.stringify(tailKey)}`);

  /* 9. Latest follow is untouched by the upward path. */
  const jump = host.querySelector<HTMLButtonElement>('[data-visible="true"] .jump-latest-btn');
  assert(jump, "the reading pane offers no way back to the newest message");
  flushSync(() => jump.click());
  await until(() => atBottom(), "jump to latest reaches the bottom");
  await settle("jump to latest");
  flushSync(() => useAppStore.setState((state) => ({
    messages: [...state.messages, { id: "up-live", role: "assistant" as const,
      content: "A live answer while the reader is pinned.", createdAt, status: "complete" as const }],
  })));
  await until(() => Boolean(host.querySelector('[data-message-id="up-live"]')), "the live message mounts");
  await settle("live message while pinned");
  const followReport = {
    atBottom: atBottom(),
    liveRowExists: Boolean(host.querySelector('[data-message-id="up-live"]')),
  };
  reports["latest-follow"] = followReport;
  assert(followReport.atBottom,
    `pinned follow left the transcript above the bottom: ${JSON.stringify(followReport)}`);
}
