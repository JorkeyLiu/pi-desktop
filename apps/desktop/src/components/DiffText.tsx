import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  takeDiffDisplayLine,
  type DiffDisplayBudget,
  type DiffTextSegment,
} from "../lib/diff-display";

function segmentsToNodes(segments: readonly DiffTextSegment[]): ReactNode[] {
  return segments.map((segment, index) =>
    segment.escaped ? (
      <span
        className="diff-control-escape"
        key={index}
        title={`U+${segment.text.slice(-4)}`}
        aria-label={`U+${segment.text.slice(-4)}`}
      >
        {segment.text}
      </span>
    ) : (
      segment.text
    ),
  );
}

/**
 * One rendered diff line: the view's literal prefix (sign and any newline it
 * paints) plus the raw wire text through the shared tokenizer. The shared
 * budget is spent while the parent walks its lines, so a consumer stops
 * creating DOM as soon as its post-escape ceiling is exhausted; `null` means
 * this line cannot be shown.
 */
export function renderDiffLine(
  prefix: string,
  text: string,
  budget: DiffDisplayBudget,
): { prefix: ReactNode | null; text: ReactNode[] } | null {
  const line = takeDiffDisplayLine(prefix, text, budget);
  if (!line) return null;
  return {
    prefix: line.prefix ? line.prefix.text : null,
    text: segmentsToNodes(line.text),
  };
}

/** Existing review limit copy, also used when only the display budget expires. */
export function DiffDisplayLimit({ budget }: { budget: DiffDisplayBudget }) {
  const { t } = useTranslation();
  if (!budget.truncated) return null;
  return <div className="review-change-note">{t("panel.review.tooLarge")}</div>;
}
