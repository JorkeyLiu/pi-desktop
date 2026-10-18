import { TooltipButton } from "../../../components/ui";
import { IconArrowUp } from "../../../components/icons";

/** Which half of the composer's single action slot is showing. */
export type ComposerPrimaryActionKind = "stop" | "send";

/**
 * The composer's single submit slot: Stop while a run is active with an empty
 * draft, Send otherwise. Shared by the main composer and the subagent panel
 * composer so the switching policy is defined once instead of forked.
 */
export function composerPrimaryAction(
  running: boolean,
  hasDraft: boolean,
): ComposerPrimaryActionKind {
  return running && !hasDraft ? "stop" : "send";
}

export type ComposerSendAction = {
  /** Localized tooltip shown on hover/focus. */
  tooltip: string;
  /** Localized accessible name. */
  ariaLabel: string;
  disabled?: boolean;
  onClick: () => void;
};

/**
 * The Send half of the action slot, in the composer's round icon-button style.
 * The Stop half stays surface-owned: the subagent panel reuses the shared,
 * deduplicated `SubagentStopButton`.
 */
export function ComposerSendButton({
  tooltip,
  ariaLabel,
  disabled = false,
  onClick,
}: ComposerSendAction) {
  return (
    <TooltipButton
      type="button"
      className="send-btn"
      tooltip={tooltip}
      ariaLabel={ariaLabel}
      disabled={disabled}
      onClick={onClick}
    >
      <IconArrowUp size={15} />
    </TooltipButton>
  );
}
