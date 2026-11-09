import { useTranslation } from "react-i18next";
import { useId } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import { IconChevronRight } from "../../../components/icons";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { disclosureKey, useAutomaticDisclosure } from "./disclosure";

/**
 * The delegate-visible tool a subagent rolls its own context over through.
 * The runtime owns the name (`SUBAGENT_HANDOFF_TOOL_NAME`); the renderer only
 * reads the persisted result, so the string is duplicated here rather than
 * crossing the process boundary for it.
 */
const HANDOFF_TOOL_NAME = "SubagentHandoff";

/** One accepted handoff: the text its author wrote for its future self. */
export type HandoffCheckpointView = {
  /** The whole authored handoff, exactly as submitted. */
  text: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The checkpoint one tool row is, or null when it is not one.
 *
 * Only a *persisted acceptance* is a checkpoint: the runtime records
 * `details.accepted: true` on the result of a submission it installed, and a
 * rejected submission comes back as an error. A call that is still preparing,
 * executing, or was refused therefore stays the ordinary tool row with its own
 * lifecycle status; nothing about pending/running/error is inferred from the
 * submitted text.
 *
 * The submitted text never reaches the result — `details` carries only
 * acceptance — so the body reads the call's own free-form `handoff` argument.
 * A row whose argument is missing or blank is left to the ordinary tool row as
 * well.
 */
export function handoffCheckpoint(message: UiMessage): HandoffCheckpointView | null {
  if (message.role !== "tool" || message.toolName !== HANDOFF_TOOL_NAME) return null;
  if (message.isError || message.toolStatus !== "success") return null;
  const details = record(toolResultPayload(message));
  if (details?.accepted !== true) return null;
  const submitted = record(message.toolArgs);
  const text = typeof submitted?.handoff === "string" ? submitted.handoff.trim() : "";
  if (!text) return null;
  return { text };
}

/**
 * One accepted context rollover in a delegate's transcript, drawn in the
 * context-compaction row's visual pattern: a centred muted label between the
 * rows it separates.
 *
 * It is not `role="separator"` like the compaction row: this row carries a
 * disclosure, and a separator makes its content presentational — the expand
 * button would disappear from the accessibility tree. The row is therefore a
 * labelled group whose only control states `aria-expanded`/`aria-controls` and
 * is reachable and activatable from the keyboard.
 *
 * The row carries no tool arguments and no result text: the collapsed line
 * says only which checkpoint it is — its title and its position among the
 * tab's accepted handoffs — and the body is the authored handoff in full.
 * Nothing here is editable, and the row owns no actions.
 */
export function SubagentHandoffCheckpointRow({
  message,
  times,
}: {
  message: UiMessage;
  /** Position of this checkpoint among the transcript's accepted handoffs. */
  times?: number;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const view = handoffCheckpoint(message);
  const disclosure = useAutomaticDisclosure(
    false,
    undefined,
    disclosureKey("handoff", message.id),
  );
  if (!view) return null;
  const { open, toggle, bodyRef, titleRef, bodyEvents } = disclosure;
  const title =
    times === undefined
      ? t("chat.subagentHandoffCheckpoint")
      : t("chat.subagentHandoffCheckpointCount", { times });
  return (
    <div className="transcript-handoff-row" role="group" aria-label={title}>
      <button
        ref={titleRef}
        type="button"
        className="transcript-handoff-head"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={toggle}
      >
        <span className="transcript-handoff-label">{title}</span>
        <span className="transcript-handoff-caret" aria-hidden="true">
          <IconChevronRight size={12} />
        </span>
      </button>
      {open ? (
        <div
          className="transcript-handoff-body"
          id={detailsId}
          ref={bodyRef}
          {...bodyEvents}
        >
          <HandoffCheckpointBody text={view.text} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The whole authored handoff, as plain text.
 *
 * The text was written by a model, so it is untrusted input: it reaches the
 * reader as a React text node, never as HTML or as parsed markdown. Authored
 * line breaks, indentation, and list markers are preserved by CSS
 * (`white-space: pre-wrap`) instead of being interpreted, so a handoff that is
 * organized as bullets still reads as the author wrote it.
 */
export function HandoffCheckpointBody({ text }: { text: string }) {
  return <div className="transcript-handoff-prose selectable">{text}</div>;
}
