import { useTranslation } from "react-i18next";
import { useCopy } from "../Markdown";
import { IconCheck, IconCopy } from "../icons";
import { TooltipButton, cx } from "../ui";

/*
 * The chrome a labeled tool detail section shares: a translated heading and a
 * copy control. Extracted from the row renderer so the terminal panes, the
 * document card and the generic sections all read the same way (D192).
 *
 * A card that names itself elsewhere — the raw payload's own disclosure
 * summary, for one — takes the copy control without a second heading, so the
 * same words never appear twice above the same bytes.
 */

export function BlockHead({
  label,
  copy,
  showLabel = true,
}: {
  label?: string;
  copy?: string;
  showLabel?: boolean;
}) {
  const { copied, copy: run } = useCopy();
  const { t } = useTranslation();
  return (
    <div className="tool-row-section-head">
      {showLabel && label ? <span>{label}</span> : null}
      {copy ? (
        <TooltipButton
          className={cx("tool-row-copy", copied && "copied")}
          tooltip={copied ? t("chat.copied") : t("chat.copy")}
          ariaLabel={label ? `${t("chat.copy")} ${label}` : t("chat.copy")}
          onClick={() => run(copy)}
        >
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        </TooltipButton>
      ) : null}
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
