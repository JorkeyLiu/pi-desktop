import { useTranslation } from "react-i18next";
import type { ToolBlock } from "../../lib/tool-presentation";
import { Markdown } from "../Markdown";
import { BlockHead } from "./BlockHead";

/*
 * A loaded document (the `Skill` tool, D192 follow-up): its name, the metadata
 * the tool itself reported, and its body rendered as Markdown. The alternative
 * — printing the tool's answer as one raw text block — buries the document the
 * answer exists to deliver.
 */

type DocumentBlock = Extract<ToolBlock, { kind: "document" }>;

export function ToolDocumentCard({ block }: { block: DocumentBlock }) {
  const { t } = useTranslation();
  const heading = block.title || block.id;
  return (
    <div className="tool-document" data-document-id={block.id || undefined}>
      <div className="tool-document-head">
        <span className="tool-document-title" title={heading}>
          {heading}
        </span>
        {block.id && block.id !== heading ? (
          <span className="tool-document-id" title={block.id}>
            {block.id}
          </span>
        ) : null}
      </div>
      {block.fields.length > 0 ? (
        <dl className="tool-fields tool-document-meta">
          {block.fields.map((row) => (
            <div className="tool-field" key={row.label}>
              <dt className="tool-field-label">{row.label}</dt>
              <dd className="tool-field-value">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {block.body ? (
        <>
          <BlockHead label={t("chat.toolBlockContent")} copy={block.body} />
          <div className="tool-document-body">
            <Markdown source={block.body} />
          </div>
        </>
      ) : null}
    </div>
  );
}
