import { useTranslation } from "react-i18next";
import type { ToolBlock } from "../../lib/tool-presentation";
import { LargeTextPreview } from "../LargeTextPreview";
import { BlockHead, MoreNote } from "./BlockHead";

/*
 * Two generic payload shapes (D192 follow-up): a labeled list of scalar names,
 * and the raw payload as its own explicit disclosure. Both are what an
 * unrecognized tool's result now falls back to, so nothing has to be read out
 * of a stringified object.
 */

type ValuesBlock = Extract<ToolBlock, { kind: "values" }>;
type RawBlock = Extract<ToolBlock, { kind: "raw" }>;

/**
 * A labeled list of scalar names. The section frame that owns this body
 * already prints the label and its copy control, so the head is rendered only
 * where the frame is unlabeled (`showLabel`) — a run row suppresses section
 * headings and leaves each card to name itself.
 */
export function ToolValueList({
  block,
  showLabel = false,
}: {
  block: ValuesBlock;
  showLabel?: boolean;
}) {
  return (
    <div className="tool-values">
      {showLabel ? (
        <div className="tool-values-head" title={block.label}>
          {block.label}
        </div>
      ) : null}
      <ul className="tool-values-list">
        {block.items.map((item) => (
          <li className="tool-value-item" key={item} title={item}>
            {item}
          </li>
        ))}
      </ul>
      <MoreNote hidden={block.hidden} />
    </div>
  );
}

export function ToolRawPayload({ block }: { block: RawBlock }) {
  const { t } = useTranslation();
  return (
    <details className="tool-raw">
      <summary className="tool-raw-summary">{t("chat.toolRaw")}</summary>
      <div className="tool-raw-body">
        <BlockHead
          label={t("chat.toolRaw")}
          copy={block.text}
          showLabel={false}
        />
        <LargeTextPreview
          text={block.text}
          preClassName="tool-row-content tool-raw-content"
        />
      </div>
    </details>
  );
}
