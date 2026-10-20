import { useTranslation } from "react-i18next";
import { useCopy } from "../Markdown";
import { IconCheck, IconCopy } from "../icons";
import { TooltipButton, cx } from "../ui";

/*
 * The chrome every tool detail section shares: a translated heading and a copy
 * control. Extracted from the row renderer so the terminal panes, the document
 * card and the generic sections all read the same way (D192).
 */

export function BlockHead({ label, copy }: { label: string; copy: string }) {
  const { copied, copy: run } = useCopy();
  const { t } = useTranslation();
  return (
    <div className="tool-row-section-head">
      <span>{label}</span>
      <TooltipButton
        className={cx("tool-row-copy", copied && "copied")}
        tooltip={copied ? t("chat.copied") : t("chat.copy")}
        ariaLabel={`${t("chat.copy")} ${label}`}
        onClick={() => run(copy)}
      >
        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
      </TooltipButton>
    </div>
  );
}

/** How many rendered entries a bounded list left out. */
export function MoreNote({ hidden }: { hidden: number }) {
  const { t } = useTranslation();
  if (hidden <= 0) return null;
  return (
    <div className="tool-block-more">
      {t("chat.toolBlockMore", { count: hidden })}
    </div>
  );
}
