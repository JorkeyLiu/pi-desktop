import { type ReactNode } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { ReviewTab } from "../../apps/desktop/src/components/workpanel/ReviewTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/**
 * The large-file route of the inline review probe: a real 1.34 MB document
 * created by `Write`, changed by `Edit`, and read back by the session Review
 * panel. It lives on its own so the shared probe keeps one responsibility per
 * module; the harness supplies the mount/settle/check helpers so this section
 * adds no second rendering path.
 */

/** The real host payloads this route renders. */
export type LargeRoutePayloads = {
  largeWrite: Record<string, unknown>;
  largeEdit: Record<string, unknown>;
  largeSession: {
    sessionId: string;
    files: unknown[];
    truncated?: boolean;
  };
};

export type LargeRouteHarness = {
  /** Mount a node into the probe's column and return its host element. */
  mountRow: (node: ReactNode) => HTMLElement;
  settle: (ticks?: number) => Promise<void>;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  /** The header's +a/−d text, as the transcript reads it. */
  countsText: (host: HTMLElement) => string;
  /** Expand one row's body. */
  expand: (host: HTMLElement) => Promise<void>;
  /** The transcript's own tool message, unchanged. */
  toolMessage: (
    id: string,
    toolName: string,
    content: Record<string, unknown>,
    args?: Record<string, unknown>,
  ) => UiMessage;
};

export async function probeLargeRoutes(
  payloads: LargeRoutePayloads,
  h: LargeRouteHarness,
) {
  // ── 3b. A real 1.34 MB file through the same tools ──
  // Far above the old 512 KiB gate and below the 16 MiB side ceiling: the row
  // states the real counts and keeps its hunk instead of refusing the file.
  const largeEditHost = h.mountRow(
    <ToolRow
      message={h.toolMessage("edit-big", "Edit", payloads.largeEdit, {
        path: "big.txt",
        tag: "0000",
        ops: "PUT 20001.=20001:\n+long line 20000 edited\n",
      })}
    />,
  );
  await h.settle();
  const largeEditCounts = h.countsText(largeEditHost);
  h.check(
    "the real 1.34 MB Edit row states +a and −d",
    largeEditCounts.includes("+1") && largeEditCounts.includes("−1"),
    largeEditCounts,
  );
  await h.expand(largeEditHost);
  const largeEditAdds = largeEditHost.querySelectorAll(
    ".review-change-diff .diff-line.add",
  ).length;
  const largeEditDels = largeEditHost.querySelectorAll(
    ".review-change-diff .diff-line.del",
  ).length;
  h.check(
    "expanding the real 1.34 MB Edit row shows its one-line diff",
    largeEditAdds === 1 && largeEditDels === 1,
    { largeEditAdds, largeEditDels },
  );
  const largeEditBody =
    largeEditHost.querySelector(".tool-row-body")?.textContent ?? "";
  h.check(
    "the real 1.34 MB Edit row claims no size or limit",
    !largeEditBody.includes("This file is too large to compare here") &&
      !largeEditBody.includes("Diff is too large to show here") &&
      !largeEditBody.includes("too many large files"),
    largeEditBody.slice(0, 300),
  );

  // A 40,000-line creation exceeds the record's hunk body cap, so the row
  // keeps the exact +40,000 and says the body is too large to show — never
  // that the file was too large to compare. The Write's own argument is the
  // same 40,000-line document the host wrote, so the row carries exactly the
  // message a real tool call produces.
  const bigDoc = Array.from(
    { length: 40_000 },
    (_, index) => `long line ${index} with some payload\n`,
  ).join("");
  const largeWriteHost = h.mountRow(
    <ToolRow
      message={h.toolMessage("write-big", "Write", payloads.largeWrite, {
        path: "big.txt",
        content: bigDoc,
      })}
    />,
  );
  await h.settle();
  const largeWriteCounts = h.countsText(largeWriteHost);
  h.check(
    "the real 1.34 MB Write row states its +additions",
    largeWriteCounts.includes("+40000"),
    largeWriteCounts,
  );
  await h.expand(largeWriteHost);
  const largeWriteBody =
    largeWriteHost.querySelector(".tool-row-body")?.textContent ?? "";
  h.check(
    "expanding the real 1.34 MB Write row states the body cap, not a size gate",
    largeWriteBody.includes("Diff is too large to show here") &&
      !largeWriteBody.includes("This file is too large to compare here"),
    largeWriteBody.slice(0, 300),
  );
  h.check(
    "the capped 1.34 MB Write row invents no diff lines",
    largeWriteHost.querySelectorAll(".review-change-diff .diff-line").length ===
      0,
    largeWriteHost.querySelectorAll(".review-change-diff .diff-line").length,
  );

  // ── 3c. The session Review panel reads the same 1.34 MB session ──
  // Only the IPC transport is replaced at its boundary: the panel is the
  // production one and the rows are the host's real `review.files` answer.
  Object.defineProperty(window, "piDesktop", {
    configurable: true,
    value: {
      platform: "darwin",
      invoke: async (channel: string) => {
        if (channel === "pi-desktop/workspace/review/files") {
          return {
            ok: true,
            data: {
              files: payloads.largeSession.files,
              truncated: payloads.largeSession.truncated === true,
            },
          };
        }
        return {
          ok: false,
          error: {
            code: "INVALID_PARAMS",
            message: `unexpected channel ${channel}`,
          },
        };
      },
    },
  });
  useAppStore.setState({
    messages: [],
    activeSessionId: payloads.largeSession.sessionId,
    sessions: [],
  });
  const reviewHost = h.mountRow(<ReviewTab />);
  await h.settle(8);
  const reviewRows = () => [
    ...reviewHost.querySelectorAll<HTMLElement>('[data-scope="file"]'),
  ];
  const reviewRowFor = (name: string) =>
    reviewRows().find((row) => {
      const shown =
        row.querySelector(".review-change-card-path")?.textContent ?? "";
      return shown === name || shown.endsWith(`/${name}`);
    });
  const bigRow = reviewRowFor("big.txt");
  const overRow = reviewRowFor("big-over.txt");
  h.check(
    "the review panel lists both 1.34 MB files with their earlier neighbours",
    Boolean(bigRow && overRow) && reviewRows().length > 2,
    reviewRows().map((row) => row.textContent?.slice(0, 80)),
  );
  const rowCountsText = (row: HTMLElement | undefined) =>
    row?.querySelector(".review-change-card-counts")?.textContent ?? "";
  h.check(
    "the review panel states the 1.34 MB creation's real counts",
    rowCountsText(bigRow).includes("+40000"),
    rowCountsText(bigRow),
  );
  h.check(
    "the review panel states the 1.34 MB overwrite's real counts",
    rowCountsText(overRow).includes("+2") && rowCountsText(overRow).includes("−2"),
    rowCountsText(overRow),
  );
  bigRow?.querySelector<HTMLElement>(".review-change-card-header")?.click();
  overRow?.querySelector<HTMLElement>(".review-change-card-header")?.click();
  await h.settle();
  const bigRowText = bigRow?.textContent ?? "";
  h.check(
    "the creation row says its diff body is too large, not that the file is",
    bigRowText.includes("Diff is too large to show here") &&
      !bigRowText.includes("This file is too large to compare here"),
    bigRowText.slice(0, 200),
  );
  const overRowText = overRow?.textContent ?? "";
  h.check(
    "the overwrite row never claims missing line details",
    !overRowText.includes("Line details are unavailable for this change") &&
      !overRowText.includes("Diff is too large to show here"),
    overRowText.slice(0, 200),
  );
  const overAdds = overRow?.querySelectorAll(
    ".review-change-diff .diff-line.add",
  ).length;
  const overDels = overRow?.querySelectorAll(
    ".review-change-diff .diff-line.del",
  ).length;
  h.check(
    "expanding the 1.34 MB overwrite row shows its real diff lines",
    overAdds === 2 && overDels === 2,
    { overAdds, overDels },
  );
}
