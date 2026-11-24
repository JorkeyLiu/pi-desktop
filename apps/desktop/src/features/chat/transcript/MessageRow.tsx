import {
  memo,
  useMemo,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { MessageAttachment, UiMessage } from "@pi-desktop/shared";
import { splitInlineContent } from "@pi-desktop/shared";
import { useOpenChatFileRef } from "../../../hooks/use-preview-target";
import { sessionAllows } from "../../../lib/remote-session-safety";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import {
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconTrash,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { ActionSlotSide } from "./ActionBarSlots";
import { UserMessageEditor } from "./UserMessageEditor";
import { slotMessage } from "../../../plugins/renderer-slots/slot-message";
import { SessionMessageOrigin } from "./SessionMessageOrigin";
import {
  CopyButton,
  FileRefChip,
  LinkifiedText,
  MessageAttachmentImage,
  MessageTimestamp,
} from "./shared";
import { useTranscriptMenu } from "./TranscriptMenu";
import { getExtraMessageAttachments } from "./extra-attachments";

function SkillInvocationText({ message }: { message: UiMessage }) {
  const command = message.command ?? "";
  const mentions = message.skillMentions ?? [];
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (
      !Number.isInteger(mention.start) ||
      !Number.isInteger(mention.end) ||
      mention.start < cursor ||
      mention.end > command.length ||
      !command.slice(mention.start, mention.end).startsWith("/")
    ) {
      return <LinkifiedText text={command} attachments={message.attachments} />;
    }
    if (mention.start > cursor) {
      parts.push(<LinkifiedText key={`text-${cursor}`} text={command.slice(cursor, mention.start)} attachments={message.attachments} />);
    }
    parts.push(
      <code key={`skill-${mention.start}`} className="chat-command-chip" title={mention.id}>
        {command.slice(mention.start, mention.end)}
      </code>,
    );
    cursor = mention.end;
  }
  if (cursor < command.length) {
    parts.push(<LinkifiedText key={`text-${cursor}`} text={command.slice(cursor)} attachments={message.attachments} />);
  }
  return <>{parts}</>;
}

export const MessageRow = memo(function MessageRow({
  message,
  isRunning,
}: {
  message: UiMessage;
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  const openSelectedTextMenu = useTranscriptMenu();
  const prepareUserMessageEdit = useAppStore((s) => s.prepareUserMessageEdit);
  const editUserMessage = useAppStore((s) => s.editUserMessage);
  const activateMessageRevision = useAppStore((s) => s.activateMessageRevision);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const paneSessionId = useSlotSessionId();
  const session = useAppStore((s) => s.sessions.find((item) => item.id === paneSessionId));
  const canEditMessages = sessionAllows(session ?? (paneSessionId.startsWith("remote:") ? { id: paneSessionId } : undefined), "canEditMessages");
  const isUser = message.role === "user";
  const isSessionMessage = Boolean(message.sessionMessage);
  const editableUserMessage = isUser && !isSessionMessage && canEditMessages;
  const localWorkspaceRoot = useAppStore((s) => s.workspace?.path);
  const workspaceRoot = sessionAllows(session, "canUseLocalTools") ? localWorkspaceRoot : undefined;
  const openFileRef = useOpenChatFileRef();
  // userAction belongs to user cards; other rows keep a plugin-free bar.
  const slotUser = isUser ? slotMessage("user", message) : undefined;
  const [editing, setEditing] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const editRequest = useRef<AbortController | null>(null);
  useEffect(() => () => editRequest.current?.abort(), []);
  // The canonical full message hydration seeds; never clipped display text.
  const [editFull, setEditFull] = useState<UiMessage | null>(null);
  const [retryingEdit, setRetryingEdit] = useState(false);
  const copyLabel = t("chat.copy");
  const editLabel = t("chat.editMessage");
  const deleteLabel = t("chat.deleteMessage");
  // Runtime chunks are already progressive. Rendering that source directly
  // avoids a second per-frame state loop while Markdown memoizes stable blocks.
  const displayed = message.content || "";
  const hasAnswer = Boolean((message.content || "").trim());
  const revisionCount = message.revisionCount ?? 0;
  const activeRevision = message.activeRevision ?? revisionCount;
  const showRevisionPager = editableUserMessage && revisionCount > 1;
  const extraAttachments = useMemo(() => {
    return getExtraMessageAttachments(
      String(message.content || ""),
      message.attachments,
      workspaceRoot,
    );
  }, [message.attachments, message.content, workspaceRoot]);
  // The user's own order: an image chip the draft named inline renders between
  // the text runs it sat between, exactly where the Composer showed it.
  const userContentParts = useMemo(
    () => splitInlineContent(String(message.content || ""), message.attachments ?? []).parts,
    [message.attachments, message.content],
  );
  const renderContentPart = (
    part: (typeof userContentParts)[number],
    index: number,
    keyPrefix: string,
  ) =>
    part.kind === "text" ? (
      <LinkifiedText
        key={`${keyPrefix}-${index}`}
        text={part.text}
        attachments={message.attachments}
        sourceOffset={part.start}
      />
    ) : (
      <MessageAttachmentImage
        key={`${keyPrefix}-${index}`}
        attachment={part.attachment}
        onOpenFile={openFileRef}
        inline
      />
    );
  // An attachment the body does not already name inline continues the body
  // text instead of taking a line of its own above it.
  const attachmentChips = extraAttachments.length ? (
    <span
      className="message-attachments"
      role="list"
      aria-label={t("chat.messageAttachments")}
    >
      {extraAttachments.map((attachment) =>
        attachment.kind === "image" ? (
          <MessageAttachmentImage
            key={`${attachment.ref}:${attachment.name}`}
            attachment={attachment}
            onOpenFile={openFileRef}
          />
        ) : (
          <span key={`${attachment.ref}:${attachment.name}`} role="listitem">
            <FileRefChip
              name={attachment.name}
              path={attachment.ref}
              kind={attachment.kind}
              mimeType={attachment.mimeType}
              onOpen={openFileRef}
            />
          </span>
        ),
      )}
    </span>
  ) : null;
  const beginEdit = async () => {
    if (!editableUserMessage || isRunning || loadingEdit) return;
    const request = new AbortController();
    editRequest.current?.abort();
    editRequest.current = request;
    setLoadingEdit(true);
    // Subscribe synchronously: React can batch A→B→A into a single render.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.activeSessionId !== previous.activeSessionId ||
        state.selectingSessionId !== previous.selectingSessionId) request.abort();
    });
    request.signal.addEventListener("abort", () => {
      unsubscribe();
      if (editRequest.current === request) setLoadingEdit(false);
    }, { once: true });
    try {
      const full = await prepareUserMessageEdit(message.id, request.signal);
      if (!full || request.signal.aborted || editRequest.current !== request) return;
      setEditFull(full);
      setEditing(true);
    } finally {
      unsubscribe();
      if (editRequest.current === request) {
        editRequest.current = null;
        setLoadingEdit(false);
      }
    }
  };
  const cancelEdit = () => {
    // The draft is local to the editor: cancelling drops it without touching
    // the main composer draft or the session.
    setEditFull(null);
    setEditing(false);
  };
  const retryEdit = async (content: string, attachments: MessageAttachment[]) => {
    const next = content.trim();
    if (!editableUserMessage || retryingEdit || (!next && !attachments.length)) return;
    setRetryingEdit(true);
    const saved = await editUserMessage(message.id, next, attachments);
    setRetryingEdit(false);
    if (saved) {
      setEditFull(null);
      setEditing(false);
    }
  };
  /*
    A human turn opens the shared selected-text menu: a selection in the bubble
    — or in the edit draft while editing — offers Copy and Quote, and anything
    else opens nothing. An assistant answer belongs to its turn, so this row
    keeps answering for user turns only. Edit, Delete, and revision paging
    stay on the toolbar.
  */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!isUser) return;
    openSelectedTextMenu(event);
  };
  return (
    <div
      className={`message-row ${isSessionMessage ? "session-message" : isUser ? "user" : message.role}`}
      data-minimap-id={message.id}
      data-message-id={message.id}
      data-row-role={isSessionMessage ? undefined : "user"}
      onContextMenu={onContextMenu}
      role="article"
      aria-label={isSessionMessage ? t("sessionCollaboration.agentMessage") : isUser ? t("chat.userMessage") : t("chat.assistantMessage")}
    >
      <div className="message-col">
        {message.sessionMessage ? <SessionMessageOrigin origin={message.sessionMessage} /> : null}
        {isUser || displayed ? (
          <div className="message-bubble">
            {editing && editableUserMessage && editFull ? (
              <UserMessageEditor
                message={editFull}
                sessionId={paneSessionId}
                attachmentsAllowed={sessionAllows(
                  session ?? (paneSessionId.startsWith("remote:") ? { id: paneSessionId } : undefined),
                  "canAttach",
                )}
                busy={retryingEdit}
                onCancel={cancelEdit}
                onSubmit={(content, attachments) => void retryEdit(content, attachments)}
              />
            ) : isUser ? (
              <>
                {message.content ? (
                  <div className="message-user-text selectable">
                    {editableUserMessage && message.command ? (
                      <>
                        {message.skillMentions?.length ? (
                          <SkillInvocationText message={message} />
                        ) : (
                          // Templates retain the existing whole-invocation chip.
                          <code
                            className="chat-command-chip"
                            data-source-start={0}
                            data-source-end={message.content.length}
                            title={String(message.content || "")}
                          >
                            {message.command}
                          </code>
                        )}
                        {userContentParts
                          .filter((part) => part.kind === "attachment")
                          .map((part, index) => renderContentPart(part, index, "inline"))}
                      </>
                    ) : (
                      userContentParts.map((part, index) =>
                        renderContentPart(part, index, "content"),
                      )
                    )}
                    {attachmentChips}
                  </div>
                ) : attachmentChips}
              </>
            ) : (
              <div className="prose-chat">
                <Markdown source={displayed} />
              </div>
            )}
          </div>
        ) : null}
        {!editing && (hasAnswer || showRevisionPager) ? (
          <div className="message-actions">
            <MessageTimestamp createdAt={message.createdAt} />
            <ActionSlotSide slot="userAction" side="left" message={slotUser} />
            {showRevisionPager ? (
              <div className="message-revision-pager" role="group" aria-label={t("chat.revisions")}>
                <TooltipButton
                  className="copy-btn icon revision-nav"
                  tooltip={t("chat.revisionPrev")}
                  ariaLabel={t("chat.revisionPrev")}
                  disabled={isRunning || activeRevision <= 1}
                  onClick={() =>
                    void activateMessageRevision(message.id, Math.max(1, activeRevision - 1))
                  }
                >
                  <IconChevronLeft size={13} />
                </TooltipButton>
                <span className="message-revision-label">
                  {t("chat.revisionPager", {
                    current: activeRevision,
                    total: revisionCount,
                  })}
                </span>
                <TooltipButton
                  className="copy-btn icon revision-nav"
                  tooltip={t("chat.revisionNext")}
                  ariaLabel={t("chat.revisionNext")}
                  disabled={isRunning || activeRevision >= revisionCount}
                  onClick={() =>
                    void activateMessageRevision(
                      message.id,
                      Math.min(revisionCount, activeRevision + 1),
                    )
                  }
                >
                  <IconChevronRight size={13} />
                </TooltipButton>
              </div>
            ) : null}
            {hasAnswer ? <CopyButton text={message.content} label={copyLabel} /> : null}
            {editableUserMessage ? (
              <TooltipButton
                className="copy-btn icon"
                tooltip={editLabel}
                ariaLabel={editLabel}
                disabled={isRunning || loadingEdit}
                onClick={() => void beginEdit()}
              >
                <IconPencil size={13} />
              </TooltipButton>
            ) : null}
            {editableUserMessage ? (
              <TooltipButton
                className="copy-btn icon danger"
                tooltip={deleteLabel}
                ariaLabel={deleteLabel}
                disabled={isRunning}
                onClick={() => void deleteMessage(message.id)}
              >
                <IconTrash size={13} />
              </TooltipButton>
            ) : null}
            <ActionSlotSide slot="userAction" side="right" message={slotUser} />
          </div>
        ) : null}
      </div>
    </div>
  );
});
