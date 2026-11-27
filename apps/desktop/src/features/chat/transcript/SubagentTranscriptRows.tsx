import { memo } from "react";
import { useTranslation } from "react-i18next";
import { isViewableImageAttachment, type MessageAttachment } from "@pi-desktop/shared";
import { isThinkingActive } from "../../../lib/turn-process";
import type {
  SubagentPromptUnit,
  SubagentRowUnit,
  SubagentTranscriptUnit,
} from "../../../lib/subagent-hydration";
import { useOpenChatFileRef } from "../../../hooks/use-preview-target";
import { AssistantErrorMessage, MessageAttachmentImage, ThinkingRow } from "./shared";
import { ImageViewer } from "../../../components/ImageViewer";
import { useMessageImageViewer } from "./useMessageImageViewer";
import { openRoutedAttachment } from "./attachment-open-routing";
import { ToolRow } from "./ToolRow";
import { SubagentHandoffCheckpointRow, handoffCheckpoint } from "./SubagentHandoffCheckpoint";
import { Markdown } from "../../../components/Markdown";

/**
 * The rows of a delegate transcript, one memoized unit per source row.
 *
 * These rows used to be rendered inline by the panel's surface, which meant
 * every commit rebuilt all of them. A hydration batch adds rows above the
 * mounted run without changing any row that is already there, so each unit is
 * rendered by a memoized component and the panel reuses the units of unchanged
 * rows: a batch commit then costs the batch, not the page.
 *
 * The rendering language is the main transcript's own - the same tool row, the
 * same Markdown, the same reasoning row, the same checkpoint divider - so a
 * delegate's conversation keeps the exact presentation it had inline, including
 * the fragment identities (`data-message-id`) that prepend anchoring, search
 * focus, and the disclosures resolve against.
 */

/** The images a user sent to the child, in the transcript's attachment language. */
function SubagentUserAttachments({ attachments }: { attachments?: MessageAttachment[] }) {
  const { t } = useTranslation();
  const openFile = useOpenChatFileRef();
  const imageViewer = useMessageImageViewer();
  const images = (attachments ?? []).filter((attachment) =>
    attachment.kind === "image" || isViewableImageAttachment(attachment.mimeType, attachment.name),
  );
  if (!images.length) return null;
  const openAttachmentRef = (
    path: string,
    baseDir?: string,
    mimeType?: string,
    position?: { line?: number; column?: number },
  ) => {
    openRoutedAttachment({
      viewable: images,
      path,
      baseDir,
      mimeType,
      position,
      openViewer: (attachments, index) => imageViewer.open(attachments, index),
      openInFilesTab: (ref, dir, type, pos) => openFile(ref, dir, type, pos),
    });
  };
  return (
    <span
      className="message-attachments"
      role="list"
      aria-label={t("chat.messageAttachments")}
    >
      {images.map((attachment) => (
        <MessageAttachmentImage
          key={`${attachment.ref}:${attachment.name}`}
          attachment={attachment}
          onOpenFile={openAttachmentRef}
        />
      ))}
      {imageViewer.dialog ? (
        <ImageViewer
          items={imageViewer.dialog.items}
          index={imageViewer.dialog.index}
          source={imageViewer.dialog.source}
          onSelect={imageViewer.select}
          onClose={imageViewer.close}
          onRetry={imageViewer.retry}
          restoreFocus={imageViewer.restoreFocus}
        />
      ) : null}
    </span>
  );
}

/** A run's opening: the `Task` call's own user row, at its physical position. */
const SubagentPromptRow = memo(function SubagentPromptRow({
  unit,
}: {
  unit: SubagentPromptUnit;
}) {
  const { t } = useTranslation();
  return (
    <div className="message-row user" data-message-id={unit.messageId}>
      <div className="message-col">
        <div className="message-bubble">
          {unit.task || !unit.attachments?.length ? (
            <div className="message-user-text selectable">
              {unit.task || t("panel.subagentTaskEmpty")}
            </div>
          ) : null}
          <SubagentUserAttachments attachments={unit.attachments} />
        </div>
      </div>
    </div>
  );
});

/** One row the delegate produced: a tool call, reasoning, or its own output. */
const SubagentUnitRow = memo(function SubagentUnitRow({
  unit,
  ordinal,
  running,
}: {
  unit: SubagentRowUnit;
  ordinal: number | undefined;
  running: boolean;
}) {
  const message = unit.message;
  if (unit.kind === "tool") {
    // An accepted self-handoff is a context checkpoint, not an ordinary tool
    // invocation: it renders as the transcript's own divider row. A pending,
    // running, or refused call keeps the tool row and its lifecycle.
    return handoffCheckpoint(message) ? (
      <SubagentHandoffCheckpointRow message={message} times={ordinal} />
    ) : (
      <ToolRow message={message} />
    );
  }
  if (unit.kind === "thinking") {
    return (
      <ThinkingRow
        message={message}
        streaming={isThinkingActive(message, running)}
        anchorId={(message.content || "").trim() || message.error ? undefined : message.id}
      />
    );
  }
  if (unit.kind === "steering-user") {
    return (
      <div className="message-row user" data-message-id={message.id}>
        <div className="message-col">
          <div className="message-bubble">
            {message.content ? (
              <div className="message-user-text selectable">{message.content}</div>
            ) : null}
            <SubagentUserAttachments attachments={message.attachments} />
            {message.error ? <AssistantErrorMessage message={message} /> : null}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="message-row assistant" data-message-id={message.id}>
      <div className="message-col">
        <div className="message-bubble">
          {message.content ? (
            <div className="prose-chat selectable">
              <Markdown source={message.content} />
            </div>
          ) : null}
          {message.error ? <AssistantErrorMessage message={message} /> : null}
        </div>
      </div>
    </div>
  );
});

export type SubagentTranscriptRowsProps = {
  /** The units inside the mounted run, in transcript order. */
  units: readonly SubagentTranscriptUnit[];
  /** Handoff checkpoint numbers, by source message id. */
  handoffOrdinals: ReadonlyMap<string, number>;
  /** A live delegate turn: reasoning rows stream. */
  running: boolean;
};

/** Every mounted row of the delegate's conversation, in physical order. */
export const SubagentTranscriptRows = memo(function SubagentTranscriptRows({
  units,
  handoffOrdinals,
  running,
}: SubagentTranscriptRowsProps) {
  return (
    <>
      {units.map((unit) =>
        unit.kind === "prompt" ? (
          <SubagentPromptRow key={unit.key} unit={unit} />
        ) : (
          <SubagentUnitRow
            key={unit.key}
            unit={unit}
            ordinal={handoffOrdinals.get(unit.messageId)}
            running={running}
          />
        ),
      )}
    </>
  );
});
