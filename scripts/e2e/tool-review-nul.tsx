import type { ReactNode } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import {
  ReviewDiffView,
  ReviewFileChangeCard,
} from "../../apps/desktop/src/components/ReviewChangeCard";
import { RemoteDiffHunks } from "../../apps/desktop/src/components/remote/RemoteWorkspace";
import { MAX_ESCAPED_DIFF_CHARS } from "../../apps/desktop/src/lib/diff-display";

type HostContent = Record<string, unknown>;
type NulPayloads = {
  edit: HostContent;
  session: { sessionId: string; files: Array<Record<string, unknown>> };
};
type ProbeContext = {
  mount: (container: HTMLElement, node: ReactNode) => HTMLElement;
  settle: (ticks?: number) => Promise<void>;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  countsText: (host: HTMLElement) => string;
  expand: (host: HTMLElement) => Promise<void>;
  toolMessage: (
    id: string,
    toolName: string,
    content: HostContent,
    args?: Record<string, unknown>,
  ) => UiMessage;
};

function checkEscaped(
  host: HTMLElement,
  label: string,
  check: ProbeContext["check"],
) {
  const text = host.textContent ?? "";
  const escapeNode = host.querySelector<HTMLElement>(".diff-control-escape");
  check(
    `${label} renders NUL as an accessible escape`,
    text.includes("first\\u0000changed") && escapeNode !== null,
    text.slice(0, 160),
  );
  const style = escapeNode ? window.getComputedStyle(escapeNode) : null;
  const parentColor = escapeNode?.parentElement
    ? window.getComputedStyle(escapeNode.parentElement).color
    : null;
  check(
    `${label} paints the generated escape as its own chip`,
    Boolean(
      style &&
        style.backgroundColor !== "transparent" &&
        !style.backgroundColor.includes("rgba(0, 0, 0, 0)") &&
        parseFloat(style.borderTopLeftRadius) > 0 &&
        style.color !== parentColor,
    ),
    style && {
      background: style.backgroundColor,
      radius: style.borderTopLeftRadius,
      color: style.color,
      parentColor,
    },
  );
  check(
    `${label} puts no raw control in the DOM`,
    !text.includes("\0") && !text.includes("\u007f") && !text.includes("\u0085"),
  );
}
/** Runtime DOM evidence for the real host NUL record and remote wire hunks. */
export async function probeNulRoutes(
  payloads: NulPayloads,
  context: ProbeContext,
  column: HTMLElement,
) {
  const { mount, settle, check, countsText, expand, toolMessage } = context;
  const row = payloads.session.files.find((file) => file.path === "nul.txt");
  check("the real NUL session row is present", Boolean(row));
  if (!row) return;

  const inlineHost = mount(
    column,
    <ToolRow
      message={toolMessage("edit-nul", "Edit", payloads.edit, { path: "nul.txt" })}
    />,
  );
  await settle();
  check(
    "the real NUL Edit states exact +1/-1",
    countsText(inlineHost).includes("+1") && countsText(inlineHost).includes("−1"),
    countsText(inlineHost),
  );
  await expand(inlineHost);
  checkEscaped(inlineHost, "the inline NUL Edit", check);

  const reviewHost = mount(
    column,
    <ReviewFileChangeCard
      file={row as never}
      sessionId={payloads.session.sessionId}
      onRolledBack={() => undefined}
    />,
  );
  await settle();
  const header = reviewHost.querySelector<HTMLElement>(".review-change-card-header");
  check("the session NUL Review row renders", Boolean(header));
  header?.click();
  await settle();
  const reviewCounts =
    reviewHost.querySelector(".review-change-card-counts")?.textContent ?? "";
  check(
    "the session NUL Review states exact +1/-1",
    reviewCounts.includes("+1") && reviewCounts.includes("−1"),
    reviewCounts,
  );
  checkEscaped(reviewHost, "the session NUL Review", check);

  const remoteHost = mount(
    column,
    <RemoteDiffHunks hunks={(row.hunks ?? []) as never} />,
  );
  await settle();
  checkEscaped(remoteHost, "the remote NUL hunk group", check);

  // A raw 11 KiB NUL line expands sixfold. The runtime DOM must stop at the
  // same post-escape ceiling and state the existing review limit.
  const capHost = mount(
    column,
    <ReviewDiffView
      hunks={[
        {
          header: "@@ -0,0 +1 @@",
          lines: [
            { type: "add", text: "\0".repeat(11_000) },
            ...Array.from({ length: 100 }, () => ({
              type: "context" as const,
              text: "",
            })),
          ],
        },
      ]}
    />,
  );
  await settle();
  const escapes = capHost.querySelectorAll(".diff-control-escape").length;
  check(
    "the runtime NUL display cap applies after escaping",
    escapes > 10_000 && escapes * 6 <= MAX_ESCAPED_DIFF_CHARS,
    { escapes, escapedCharacters: escapes * 6 },
  );
  check(
    "the runtime NUL display cap shows the limit marker",
    (capHost.querySelector(".review-change-note")?.textContent ?? "").includes(
      "Diff is too large to show here",
    ),
    capHost.querySelector(".review-change-note")?.textContent,
  );
  const rows = capHost.querySelectorAll(".diff-line").length;
  check(
    "the capped runtime DOM keeps only a bounded tail",
    rows <= 20 && rows < 102,
    rows,
  );
  check(
    "the capped runtime DOM contains no raw NUL",
    !(capHost.textContent ?? "").includes("\0"),
  );

  const literalHost = mount(
    column,
    <ReviewDiffView
      hunks={[
        {
          header: "@@ -1 +1 @@",
          lines: [{ type: "context", text: "\\u0000" }],
        },
      ]}
    />,
  );
  await settle();
  check(
    "literal backslash-u source stays unmarked",
    (literalHost.textContent ?? "").includes("\\u0000") &&
      literalHost.querySelectorAll(".diff-control-escape").length === 0,
    literalHost.textContent,
  );
}
