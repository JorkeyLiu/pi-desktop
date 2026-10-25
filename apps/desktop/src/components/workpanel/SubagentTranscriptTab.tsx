import { toolResultPayload } from "../../lib/tool-presentation";
import { SubagentStopButton } from "../../features/chat/transcript/SubagentStopButton";
import {
  collectDelegationStatuses,
  subagentOutcome,
  type SubagentOutcome,
} from "../../lib/subagent-topology";
import { aggregateChainMetricsFromMessages } from "../../lib/subagent-metrics";
import {
  captureContinueIdentity,
  captureSteerIdentity,
  resolveSteerOwnerTurn,
  shouldClearSteerDraft,
  shouldShowSubagentContinue,
  subagentSteerBlockedReason,
} from "../../lib/subagent-actions";
import {
  subagentChainDeliveryOwner,
  subagentChainExecutionTurnId,
  subagentChainInstantiated,
  subagentChainLatestDelegationId,
  subagentChainCallIds,
} from "../../lib/subagent-chain";
import { sessionAllows } from "../../lib/remote-session-safety";
import { aggregateSubagentThroughput } from "../../lib/subagent-throughput";
import { api } from "../../lib/api";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { useChatSessionCapability } from "../../hooks/use-chat-session-capability";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { useTranscriptSearchFocus } from "../../hooks/use-transcript-search-focus";
import { IconArrowDown, IconBot, IconImage } from "../icons";
import { HelpIcon, TooltipButton } from "../ui";
import { ComposerInput } from "../../features/chat/composer/ComposerInput";
import { ComposerShell } from "../../features/chat/composer/ComposerShell";
import { useComposerAutosize } from "../../features/chat/composer/hooks/useComposerAutosize";
import { useComposerTextDraft } from "../../features/chat/composer/hooks/useComposerTextDraft";
import { useComposerImageAttachments } from "../../features/chat/composer/hooks/useComposerImageAttachments";
import { useComposerImagePreview } from "../../features/chat/composer/hooks/useComposerImagePreview";
import { ComposerImageStrip } from "../../features/chat/composer/ComposerImageStrip";
import {
  ComposerSendButton,
  composerPrimaryAction,
} from "../../features/chat/composer/ComposerPrimaryAction";
import { DisclosureAnchorContext } from "../../lib/disclosure-anchor-context";
import { TranscriptDisclosureProvider } from "../../features/chat/transcript/disclosure";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import {
  AssistantErrorMessage,
  MessageAttachmentImage,
  ThinkingRow,
} from "../../features/chat/transcript/shared";
import { useOpenChatFileRef } from "../../hooks/use-preview-target";
import { ToolRow } from "../../features/chat/transcript/ToolRow";
import { WorkingIndicator } from "../../features/chat/transcript/ActivityGroup";
import { Markdown } from "../Markdown";
import type { MessageAttachment } from "@pi-desktop/shared";
import { delegateModelId, delegateThinkingLevel } from "../../features/chat/transcript/model";

/**
 * The work-panel tab showing one delegation as a conversation (issue #917).
 *
 * Every `Task` call of the delegation chain opens a turn: the prompt the
 * parent sent renders as a user row, and the rows the delegate produced under
 * that call render with the main transcript's own message-list language.
 * One unified composer serves both states: a live delegate steers text into
 * the child via `agent.steerSubagent` (never into the parent context), and a
 * settled instantiated delegate continues directly via
 * `agent.continueSubagent`. Every instantiated settled child continues, no
 * matter how it ended — outcome labels stay as history, never a permanent
 * cannot-continue state. There is no parent `Task(resume)` text prompt and no
 * ask-parent/follow-up distinction.
 *
 * The tab is its whole chain, not one run of it: status, transcript, Stop and
 * Send all resolve the chain's newest run, so a continuation opened elsewhere
 * (a new card, another tab) never strands this one. A user continuation owns
 * its own execution turn and therefore reads `running` while the parent is
 * idle — the parent's idleness is not evidence that the child ended.
 */
export function SubagentTranscriptTab({ delegationId }: { delegationId: string }) {
  return (
    <TranscriptDisclosureProvider key={delegationId}>
      <SubagentTranscriptSurface delegationId={delegationId} />
    </TranscriptDisclosureProvider>
  );
}

function formatCompactTokens(value: number, language: string): string {
  try {
    return new Intl.NumberFormat(language || undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return `${value}`;
  }
}

function formatCount(value: number, language: string): string {
  try {
    return new Intl.NumberFormat(language || undefined).format(value);
  } catch {
    return `${value}`;
  }
}
/**
 * The images a user sent to the child, rendered in the transcript's own
 * attachment language (chip + hover preview + click-to-open), so an
 * image-only steer still shows what actually reached the delegate.
 */
function SubagentUserAttachments({ attachments }: { attachments?: MessageAttachment[] }) {
  const { t } = useTranslation();
  const openFile = useOpenChatFileRef();
  const images = (attachments ?? []).filter((attachment) => attachment.kind === "image");
  if (!images.length) return null;
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
          onOpenFile={openFile}
        />
      ))}
    </span>
  );
}


function formatRate(value: number, language: string): string {
  try {
    return new Intl.NumberFormat(language || undefined, {
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return `${Math.round(value * 10) / 10}`;
  }
}

function SubagentTranscriptSurface({ delegationId }: { delegationId: string }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language || "en";
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  // A tab only renders inside a presented panel, which always has a session;
  // the empty key keeps the hook's contract while nothing is active.
  const transcript = useTranscriptView(activeSessionId ?? "");
  const { messages } = transcript;
  const session = useAppStore((state) =>
    state.sessions.find((item) => item.id === state.activeSessionId),
  );
  const source = session?.source;
  const isRemote = source === "remote" || (activeSessionId?.startsWith("remote:") ?? false);
  const isNative = source === "pi-native" || (activeSessionId?.startsWith("native-pi:") ?? false);
  const readOnlySession = isRemote || isNative;
  const canSteerParent = useChatSessionCapability("canSteer");
  const canPromptParent = useChatSessionCapability("canPrompt");
  const enterToSend = useAppStore((state) => state.settings?.enterToSend ?? true);
  const expectedTurnId = useAppStore((state) =>
    state.activeSessionId ? state.agentStatuses[state.activeSessionId]?.currentTurnId : undefined,
  );
  const isRunning = useAppStore(
    (state) => (activeSessionId ? state.runningSessions[activeSessionId] ?? false : false),
  );

  const toolItems = useMemo(
    () =>
      messages
        .filter((message) => message.role === "tool")
        .map((message) => ({ kind: "tool" as const, message })),
    [messages],
  );
  const statuses = useMemo(
    () => collectDelegationStatuses(toolItems, { turnLive: isRunning }),
    [toolItems, isRunning],
  );
  // Chain-latest active delegation (F5): after d1 -> d2 the old tab follows
  // the same chain, so status/send/stop/continue all target the latest id.
  const activeDelegationId = useMemo(
    () => subagentChainLatestDelegationId(messages, delegationId),
    [messages, delegationId],
  );
  const outcome = useMemo<SubagentOutcome>(() => {
    const chain = messages.filter(
      (message) => message.role === "tool" && toolResultPayload(message) &&
        typeof toolResultPayload(message) === "object" &&
        (toolResultPayload(message) as { delegationId?: unknown }).delegationId === activeDelegationId,
    );
    const last = chain.at(-1);
    if (last) return subagentOutcome(last, statuses);
    const direct = statuses.get(activeDelegationId);
    return direct ?? "aborted";
  }, [messages, activeDelegationId, statuses]);
  const running = outcome === "running";

  // Backend-owned report routing for the chain-latest run: `parent` when the
  // parent still expects this delegate, `user` once the user took over the
  // chain. Read from persisted Task fields, never from parent UI state.
  const deliveryOwner = useMemo(
    () => subagentChainDeliveryOwner(messages, activeDelegationId),
    [messages, activeDelegationId],
  );

  const delegateSettings = useMemo(() => {
    const result = messages.find((message) => {
      if (message.role !== "tool") return false;
      const payload = toolResultPayload(message);
      return payload && typeof payload === "object" && !Array.isArray(payload) &&
        "delegationId" in payload && payload.delegationId === activeDelegationId;
    });
    return {
      modelId: result ? delegateModelId(result) : "",
      thinkingLevel: result ? delegateThinkingLevel(result) : undefined,
    };
  }, [messages, activeDelegationId]);
  const transcriptResult = useMemo(
    () => buildSubagentTranscript(messages, activeDelegationId),
    [messages, activeDelegationId],
  );

  // A child that is genuinely working shows the transcript's own working
  // indicator at the end of its rows. It is suppressed while the child waits on
  // the user — a permission card or a question elsewhere in the app owns that
  // state, and claiming the child is working would hide the wait.
  const pendingPermissions = useAppStore((state) => state.pendingPermissions);
  const pendingAsks = useAppStore((state) => state.pendingAsks);
  const childToolCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const turn of transcriptResult?.turns ?? []) {
      for (const row of turn.rows) {
        if (row.kind === "tool" && row.message.toolCallId) {
          ids.add(row.message.toolCallId);
        }
      }
    }
    return ids;
  }, [transcriptResult]);
  const waitingOnUser = useMemo(() => {
    if (!activeSessionId || childToolCallIds.size === 0) return false;
    for (const permission of pendingPermissions[activeSessionId] ?? []) {
      if (childToolCallIds.has(permission.toolCallId)) return true;
    }
    for (const ask of pendingAsks[activeSessionId] ?? []) {
      if (childToolCallIds.has(ask.toolCallId)) return true;
    }
    return false;
  }, [activeSessionId, childToolCallIds, pendingAsks, pendingPermissions]);
  const showWorking = running && !waitingOnUser;
  const chainMetrics = useMemo(
    () => aggregateChainMetricsFromMessages(messages, activeDelegationId),
    [messages, activeDelegationId],
  );
  const throughput = useMemo(
    () => aggregateSubagentThroughput(messages, subagentChainCallIds(messages, activeDelegationId)),
    [messages, activeDelegationId],
  );
  // A backend instance exists once a `Task` call of the chain carries a
  // delegationId. Every instantiated settled child continues regardless of how
  // it ended — a child stopped before its first transcript event included —
  // while a denied never-started call or a missing Task chain has no instance.
  const instantiated = useMemo(
    () => subagentChainInstantiated(messages, activeDelegationId),
    [messages, activeDelegationId],
  );
  // Every tab of a chain continues it: the action always targets the
  // chain-latest run, so an older tab stays usable without opening a new card.
  const continuable = shouldShowSubagentContinue({
    outcome,
    hasInstance: instantiated,
    canPromptParent,
    readOnlySession,
  });
  // The shared editor owns typing and caret; this surface owns submission.
  const text = useComposerTextDraft();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  // Every user edit bumps the revision. A send captures it, so a reply that
  // lands after the user started the next message never wipes that message as
  // if it were the text that was sent.
  const draftRevisionRef = useRef(0);
  const editDraft = (next: string) => {
    draftRevisionRef.current += 1;
    text.handleInput(next);
  };
  // Latest chain target as of the most recent render: a d1 -> d2 continuation
  // arriving mid-dispatch moves the composer to d2, so the await below must
  // not clear a draft that no longer belongs to the delegation it sent to.
  const activeDelegationRef = useRef(activeDelegationId);
  activeDelegationRef.current = activeDelegationId;
  const showToast = useAppStore((state) => state.showToast);
  // The main composer's attach gate, on this surface's session: reaching a
  // remote or read-only conversation never offers a picker, and no model
  // capability label is consulted — an image is either stageable here or not.
  const attachmentsAllowed = useAppStore((state) =>
    sessionAllows(
      state.sessions.find((item) => item.id === state.activeSessionId) ??
        (state.activeSessionId?.startsWith("remote:") ? { id: state.activeSessionId } : undefined),
      "canAttach",
    ),
  );
  // Images staged for this tab, and the same controller the main composer
  // uses for its preview dialog: one safe data-URL read per staged image.
  const images = useComposerImageAttachments({
    sessionId: activeSessionId ?? null,
    blocked: readOnlySession || !attachmentsAllowed,
  });
  const imagePreview = useComposerImagePreview({
    references: images.references,
    value: text.value,
    sessionId: activeSessionId ?? "",
    editorRef: text.ref,
  });

  // Stale identity/draft guards: a tab/session switch never carries the old
  // draft, staged images, or error into the new context.
  useEffect(() => {
    sendingRef.current = false;
    setSending(false);
    draftRevisionRef.current += 1;
    text.setValue("");
    images.reset();
    setSendError(null);
  }, [delegationId, activeSessionId]);

  // Owner turn kept from accepted steer/continue responses, keyed by the run
  // they own. It covers the status-lag window after a detached continuation:
  // the host has adopted the execution turn before the status row catches up.
  // Entries are keyed per delegation so a d1 -> d2 continuation never steers
  // the new run with the old run's turn; a mismatch is the backend's
  // rejection to make, with the draft preserved.
  const ownerTurnRef = useRef(new Map<string, string>());
  const keepOwnerTurn = (id: string, turnId: string | undefined) => {
    if (!id || !turnId?.trim()) return;
    if (ownerTurnRef.current.size > 200) ownerTurnRef.current.clear();
    ownerTurnRef.current.set(id, turnId.trim());
  };
  // The turn owning a steer of this delegate: a kept execution turn first,
  // else the status's current turn (the live parent turn when attached, the
  // adopted execution turn when detached). Never the parent session's
  // generic running flag: a running child may outlive parent UI idleness.
  // The run's own execution turn, read from its persisted `Task` row: the
  // authority a reopened tab or a rebuilt renderer still has after the
  // in-memory kept turn is gone.
  const runTurnId = useMemo(
    () => subagentChainExecutionTurnId(messages, activeDelegationId),
    [messages, activeDelegationId],
  );
  const ownerTurnId = resolveSteerOwnerTurn({
    keptTurnId: ownerTurnRef.current.get(activeDelegationId),
    runTurnId,
    currentTurnId: expectedTurnId,
  });

  const steerBlock = subagentSteerBlockedReason({
    readOnlySession,
    canSteerParent,
    running,
    expectedTurnId: ownerTurnId,
  });
  const steerBlockedReason =
    steerBlock === "read-only"
      ? t("chat.subagentSteerReadOnly")
      : steerBlock === "unavailable"
        ? t("chat.subagentSteerUnavailable")
        : null;
  const steerEnabled = running && !steerBlockedReason && !sending;
  // Settled send needs only local prompt rights, never a running parent turn;
  // a live parent additionally guards with its current turn id.
  const continueEnabled = !running && continuable && !sending;

  // A send carries the text and the images staged for it. An image needs no
  // words: the child model receives it as an image, so an empty draft is a
  // complete request as long as one image is attached.
  const sendSteer = async () => {
    const content = text.value.trim();
    const outgoing = images.attachments;
    if ((!content && !outgoing.length) || sendingRef.current) return;
    // Only the images this send carries may clear afterwards: an image staged
    // while the request is in flight belongs to the next one.
    const outgoingIds = images.references.map((reference) => reference.id);
    // Capture turn identity, session, and the chain-latest delegation before
    // the await so a tab/session switch during dispatch never steers the
    // wrong child and never clears the new context's draft. The owner turn
    // is the kept execution turn when this run detached, else the status's
    // current turn; the backend validates it either way.
    const capturedSessionId = useAppStore.getState().activeSessionId;
    const capturedDelegationId = activeDelegationId;
    const capturedRevision = draftRevisionRef.current;
    const liveTurnId = capturedSessionId
      ? useAppStore.getState().agentStatuses[capturedSessionId]?.currentTurnId
      : undefined;
    const capturedRunTurn = subagentChainExecutionTurnId(
      useAppStore.getState().messages,
      capturedDelegationId,
    );
    const capturedOwnerTurn = resolveSteerOwnerTurn({
      keptTurnId: ownerTurnRef.current.get(capturedDelegationId),
      runTurnId: capturedRunTurn,
      currentTurnId: liveTurnId,
    });
    const target = useAppStore.getState().sessions.find((item) => item.id === capturedSessionId);
    const captured = captureSteerIdentity({
      sessionId: capturedSessionId ?? undefined,
      turnId: capturedOwnerTurn,
      source: target?.source,
      sessionStartsWithRemote: capturedSessionId?.startsWith("remote:") ?? false,
      sessionStartsWithNative: capturedSessionId?.startsWith("native-pi:") ?? false,
      canSteer: sessionAllows(target ?? { id: capturedSessionId ?? "" }, "canSteer"),
    });
    if (!captured.ok) {
      setSendError(
        captured.reason === "read-only"
          ? t("chat.subagentSteerReadOnly")
          : t("chat.subagentSteerUnavailable"),
      );
      return;
    }
    const { sessionId, turnId } = captured;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    const messageId = crypto.randomUUID();
    try {
      const response = await api.steerSubagent({
        sessionId,
        delegationId: capturedDelegationId,
        expectedTurnId: turnId,
        content,
        ...(outgoing.length ? { attachments: outgoing } : {}),
        messageId,
      });
      // Keep the owning turn for the next steer of this run: for a detached
      // run it is the execution turn the status row may not show yet.
      keepOwnerTurn(capturedDelegationId, response.turnId);
      // Echo is persisted backend and rendered in the chain; clear only on
      // success, only while the composer still belongs to this session and
      // still holds the text that was sent. A tab/session switch or text typed
      // after the capture preserves the draft, and a failure always does.
      if (
        shouldClearSteerDraft({
          sendSucceeded: true,
          capturedSessionId: sessionId,
          currentSessionId: useAppStore.getState().activeSessionId,
          capturedDelegationId,
          currentDelegationId: activeDelegationRef.current,
          sendDelegationId: response.delegationId,
          draftUnchanged: draftRevisionRef.current === capturedRevision,
        })
      ) {
        text.setValue("");
        // The images this steer carried are now the child's; an image staged
        // during the flight stays in the composer for the next send.
        images.discard(outgoingIds);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSendError(detail);
      showToast(detail, { variant: "error" });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const sendContinue = async () => {
    const content = text.value.trim();
    const outgoing = images.attachments;
    if ((!content && !outgoing.length) || sendingRef.current) return;
    const outgoingIds = images.references.map((reference) => reference.id);
    // Capture session, live parent turn (when any), and the chain-latest
    // delegation before the await so a tab/session switch or a d1 -> d2
    // continuation during dispatch never continues the wrong delegate and
    // never clears the new context's draft.
    const capturedSessionId = useAppStore.getState().activeSessionId;
    const liveTurnId = capturedSessionId
      ? useAppStore.getState().agentStatuses[capturedSessionId]?.currentTurnId
      : undefined;
    const parentLive = capturedSessionId
      ? (useAppStore.getState().runningSessions[capturedSessionId] ?? false)
      : false;
    const capturedDelegationId = activeDelegationId;
    const capturedRevision = draftRevisionRef.current;
    const target = useAppStore.getState().sessions.find((item) => item.id === capturedSessionId);
    const captured = captureContinueIdentity({
      sessionId: capturedSessionId ?? undefined,
      // A live parent guards with its current turn; an idle parent omits it.
      turnId: parentLive ? liveTurnId : undefined,
      source: target?.source,
      sessionStartsWithRemote: capturedSessionId?.startsWith("remote:") ?? false,
      sessionStartsWithNative: capturedSessionId?.startsWith("native-pi:") ?? false,
      canPrompt: sessionAllows(target ?? { id: capturedSessionId ?? "" }, "canPrompt"),
    });
    if (!captured.ok) {
      setSendError(
        captured.reason === "read-only"
          ? t("chat.subagentSteerReadOnly")
          : t("chat.subagentSteerUnavailable"),
      );
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    // One idempotent id per send attempt; a retry after failure mints its own.
    const messageId = crypto.randomUUID();
    try {
      const response = await api.continueSubagent({
        sessionId: captured.sessionId,
        delegationId: capturedDelegationId,
        content,
        ...(outgoing.length ? { attachments: outgoing } : {}),
        messageId,
        ...(captured.turnId ? { expectedTurnId: captured.turnId } : {}),
      });
      // The continued run arrives backend-side as a new chain segment under
      // the returned delegation id; keep its owning turn (present for both
      // attached and detached runs) so a prompt steer of the new run names
      // the right owner before the status row catches up.
      keepOwnerTurn(response.delegationId, response.turnId);
      // The continued run arrives backend-side as a new chain segment, so the
      // composer's chain target moves to the delegation this send just opened:
      // the accepted text clears there. A tab/session switch, text typed after
      // the capture, or a failure preserves the draft.
      if (
        shouldClearSteerDraft({
          sendSucceeded: true,
          capturedSessionId: captured.sessionId,
          currentSessionId: useAppStore.getState().activeSessionId,
          capturedDelegationId,
          currentDelegationId: activeDelegationRef.current,
          sendDelegationId: response.delegationId,
          draftUnchanged: draftRevisionRef.current === capturedRevision,
        })
      ) {
        text.setValue("");
        images.discard(outgoingIds);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSendError(detail);
      showToast(detail, { variant: "error" });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const sendComposer = () => {
    if (running) void sendSteer();
    else void sendContinue();
  };

  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
    releaseFollow,
    disclosureAnchorNotifier,
  } = useFollowScroll();

  // Several delegation tabs can be open at once, so an explicit search hit
  // is claimed only by the tab whose own conversation contains the message;
  // the other tabs stay where the reader left them.
  const searchTarget = useMemo(() => {
    const focus = transcript.focus;
    if (!focus) return null;
    const claimed = transcriptResult?.turns.some((turn) =>
      turn.rows.some((row) => row.message.id === focus.messageId),
    );
    return claimed ? focus : null;
  }, [transcript.focus, transcriptResult]);

  useTranscriptSearchFocus({
    target: searchTarget,
    source:
      messages.find((message) => message.id === searchTarget?.messageId)?.content ?? "",
    scrollRef,
    contentRef,
    contentVersion: messages,
    onNavigate: releaseFollow,
  });

  useLayoutEffect(() => {
    if (!searchTarget) jumpToLatest();
  }, [jumpToLatest, searchTarget]);

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [messages, scheduleFollowScroll]);

  const contextKnown =
    typeof chainMetrics?.contextTokens === "number" &&
    Number.isFinite(chainMetrics.contextTokens);
  const contextValue = contextKnown
    ? formatCompactTokens(chainMetrics.contextTokens as number, language)
    : "—";
  const spendTokens = chainMetrics?.usage?.totalTokens;
  const spendValue =
    typeof spendTokens === "number" && Number.isFinite(spendTokens)
      ? formatCompactTokens(spendTokens, language)
      : null;
  // Only counters the chain actually reported are stated: a Task result that
  // carried context/spend alone states no activity figure at all instead of
  // inventing `0 turns · 0 calls`, while a reported zero is stated as zero.
  const activityLabel = [
    typeof chainMetrics?.turns === "number"
      ? `${formatCount(chainMetrics.turns, language)} ${t("chat.subagentMetricsTurnsUnit", { count: chainMetrics.turns })}`
      : null,
    typeof chainMetrics?.toolCalls === "number"
      ? `${formatCount(chainMetrics.toolCalls, language)} ${t("chat.subagentMetricsCallsUnit", { count: chainMetrics.toolCalls })}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ") || null;
  const modelLabel = [delegateSettings.modelId, delegateSettings.thinkingLevel]
    .filter(Boolean)
    .join(" · ");
  // Concise report routing while live: who receives this run's report — the
  // parent model (`parent`, still expected by the program) or only the user
  // (`user`, taken over after the parent stopped expecting the chain, e.g. a
  // detached continuation owning its own execution turn). Settled runs omit
  // it; their report already landed where it belongs.
  const ownerLabel = running
    ? t(deliveryOwner === "user" ? "chat.subagentDeliveryUser" : "chat.subagentDeliveryParent")
    : null;
  const ownerTitle =
    deliveryOwner === "user"
      ? t("chat.subagentDeliveryUserHelp")
      : t("chat.subagentDeliveryParentHelp");
  // Explicit capability reasons: every blocked composer names its own cause
  // without exposing harness internals. A delegation with no backend instance
  // — a denied never-started call, or a tab whose Task chain is missing —
  // names that instead of a cannot-continue line, because an instantiated
  // settled child always continues; remote, native, and permission blocks keep
  // their copy.
  const readonlyReason = !running && !continuable
    ? !instantiated
      ? t("panel.subagentNoInstance")
      : readOnlySession
        ? t("chat.subagentSteerReadOnly")
        : t("panel.subagentReadOnly")
    : null;
  const composerPlaceholder = running
    ? (steerBlockedReason ?? t("chat.subagentSteerPlaceholder"))
    : t("chat.subagentContinuePlaceholder");
  const sendLabel = sending
    ? running
      ? t("chat.subagentSteerSending")
      : t("chat.subagentContinueSending")
    : running
      ? t("chat.subagentSteerSend")
      : t("chat.subagentContinueSend");
  // An image-only request is a complete request: `hasContent` counts the text
  // or a staged image, and nothing here consults the child model's declared
  // vision support — the host delivers what the user attached.
  const hasContent = text.value.trim().length > 0 || images.references.length > 0;
  const sendDisabled = running
    ? !steerEnabled || !hasContent
    : !continueEnabled || !hasContent;
  // A live run is stoppable even when its steer path is unavailable (no owner
  // turn yet, or a read-only session): the Stop must not disappear behind a
  // disabled send button.
  const primaryAction = composerPrimaryAction(running, hasContent, !running || steerEnabled);
  // A delegation that is neither live nor continuable has no submission path:
  // its editor stays readable but frozen and names its own cause.
  const readOnlyComposer = !running && !continuable;
  const editorBlocked = readOnlyComposer ? true : running ? !steerEnabled : sending;
  // The shared editor grows like the main composer instead of a fixed 2 rows.
  useComposerAutosize(text.ref, text.value, "subagent-panel");
  // A refusal from the attach path is the surface's own: a non-image pick, a
  // blocked session, or the host's rejection reason.
  const attachError = images.error
    ? images.error.code === "not-an-image"
      ? t("chat.subagentImagesOnly")
      : images.error.code === "unavailable"
        ? t("chat.subagentAttachUnavailable")
        : (images.error.detail ?? null)
    : null;

  return (
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
      <div className="subagent-transcript-tab" data-testid="subagent-transcript-tab">
        <div className="subagent-transcript-header" data-testid="subagent-panel-header">
          <span className="subagent-transcript-status" role="status">
            {t(`chat.subagentStatus.${outcome}`)}
            {ownerLabel ? (
              <span
                className="subagent-transcript-owner"
                data-testid="subagent-delivery-owner"
                title={ownerTitle}
              >
                {" · "}
                {ownerLabel}
              </span>
            ) : null}
          </span>
          {chainMetrics ? (
            <div
              className="subagent-transcript-metrics"
              role="group"
              aria-label={t("chat.subagentMetricsLabel")}
              title={activityLabel ?? undefined}
            >
              <span className="subagent-transcript-metric">
                <span className="subagent-transcript-metric-label">
                  {t("chat.subagentMetricsContextLabel")}
                </span>
                <span className="subagent-transcript-metric-value" data-testid="subagent-metrics-context">
                  {contextValue}
                </span>
              </span>
              {spendValue !== null ? (
                <span className="subagent-transcript-metric">
                  <span className="subagent-transcript-metric-label">
                    {t("chat.subagentMetricsSpendLabel")}
                  </span>
                  <span className="subagent-transcript-metric-value" data-testid="subagent-metrics-spend">
                    {spendValue}
                  </span>
                </span>
              ) : null}
              {activityLabel ? (
                <span className="subagent-transcript-metric">
                  <span className="subagent-transcript-metric-value" data-testid="subagent-metrics-activity">
                    {activityLabel}
                  </span>
                </span>
              ) : null}
              {!contextKnown ? (
                <HelpIcon label={t("chat.subagentMetricsContextUnknownHelp")} />
              ) : null}
              <span
                className="subagent-transcript-metric"
                data-testid="subagent-metrics-throughput"
                title={t("chat.subagentThroughputHelp", { samples: throughput.samples })}
              >
                <span className="subagent-transcript-metric-label">
                  {t("chat.subagentThroughputLabel")}
                </span>
                <span className="subagent-transcript-metric-value">
                  {throughput.tokensPerSecond === null
                    ? "—"
                    : `${throughput.estimated ? "≈" : ""}${formatRate(throughput.tokensPerSecond, language)}`}
                </span>
              </span>
            </div>
          ) : null}
        </div>
        {/* The scroll area and its jump control share one containing block:
          the control anchors to this transcript viewport, so it sits just
          above the composer at any composer height instead of guessing it. */}
        <div className="subagent-transcript-viewport">
          <div
            data-scroll-owner="follow"
            ref={scrollRef}
            className="subagent-transcript-scroll"
            onScroll={handleScroll}
            role="log"
            aria-live="polite"
            aria-label={t("panel.subagent")}
            tabIndex={0}
          >
            <div ref={contentRef} className="subagent-transcript-list">
              {transcriptResult ? (
                transcriptResult.turns.map((turn, turnIndex) => (
                  <Fragment key={`turn-${turnIndex}`}>
                    <div className="message-row user">
                      <div className="message-col">
                        <div className="message-bubble">
                          {turn.task || !turn.attachments?.length ? (
                            <div className="message-user-text selectable">
                              {turn.task || t("panel.subagentTaskEmpty")}
                            </div>
                          ) : null}
                          <SubagentUserAttachments attachments={turn.attachments} />
                        </div>
                      </div>
                    </div>
                    {turn.rows.map((row) =>
                      row.kind === "tool" ? (
                        <ToolRow key={row.message.id} message={row.message} />
                      ) : row.kind === "thinking" ? (
                        <ThinkingRow
                          key={`thinking-${row.message.id}`}
                          message={row.message}
                          streaming={isRunning && row.message.status === "streaming"}
                        />
                      ) : row.kind === "steering-user" ? (
                        <div
                          className="message-row user"
                          data-message-id={row.message.id}
                          key={`steering-${row.message.id}`}
                        >
                          <div className="message-col">
                            <div className="message-bubble">
                              {row.message.content ? (
                                <div className="message-user-text selectable">
                                  {row.message.content}
                                </div>
                              ) : null}
                              <SubagentUserAttachments attachments={row.message.attachments} />
                              {row.message.error ? (
                                <AssistantErrorMessage message={row.message} />
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div
                          className="message-row assistant"
                          data-message-id={row.message.id}
                          key={`answer-${row.message.id}`}
                        >
                          <div className="message-col">
                            <div className="message-bubble">
                              {row.message.content ? (
                                <div className="prose-chat selectable">
                                  <Markdown source={row.message.content} />
                                </div>
                              ) : null}
                              {row.message.error ? (
                                <AssistantErrorMessage message={row.message} />
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ),
                    )}
                  </Fragment>
                ))
              ) : (
                <div className="subagent-transcript-empty" role="status">
                  {t("panel.subagentEmpty")}
                </div>
              )}
              {showWorking ? <WorkingIndicator /> : null}
            </div>
          </div>
          {showJump ? (
            <TooltipButton
              type="button"
              className="jump-latest-btn subagent-transcript-jump"
              tooltip={t("chat.scrollToBottom")}
              ariaLabel={t("chat.scrollToBottom")}
              onClick={jumpToLatest}
            >
              <IconArrowDown size={14} />
            </TooltipButton>
          ) : null}
        </div>
        <footer className="subagent-transcript-composer" data-testid="subagent-panel-footer">
          {/* The panel reuses the main composer's editor, box, and tokens; it
            only owns what the panel decides, which is what to send. */}
          <ComposerShell className="subagent-transcript-shell" gated={editorBlocked}>
            <ComposerImageStrip
              references={images.references}
              sources={imagePreview.sources}
              onOpen={(reference) => imagePreview.open(reference)}
              onRemove={(id) => images.remove(id)}
              onPreview={t("chat.imagePreview.title")}
              onRemoveLabel={(name) => t("chat.removeFileReference", { name })}
              failedLabel={t("chat.imagePreview.error")}
            />
            <ComposerInput
              imagePreview={imagePreview}
              inputRef={text.ref}
              value={text.value}
              placeholderText={
                readOnlyComposer
                  ? (readonlyReason ?? t("panel.subagentReadOnly"))
                  : composerPlaceholder
              }
              placeholderKey={`subagent-${outcome}`}
              inputBlocked={editorBlocked}
              pasting={images.busy}
              enterToSend={enterToSend}
              runActive={running}
              title={readOnlyComposer ? (readonlyReason ?? undefined) : undefined}
              // Clipboard images are staged for the child; any other clipboard
              // content falls through to the editor's own paste.
              onPaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (!files.length) return;
                event.preventDefault();
                void images.paste(files);
              }}
              onSubmit={() => sendComposer()}
              onInsertNewline={() => text.insertNewline()}
              onInput={editDraft}
              onCompositionStart={() => undefined}
              onCompositionEnd={() => undefined}
              onSettledInput={() => undefined}
              onFocus={() => undefined}
              onBlur={() => undefined}
            />
            {readOnlyComposer ? null : (
              <div className="subagent-transcript-composer-controls composer-toolbar">
                <div className="composer-left">
                  {/* The panel's picker is image-only: a delegate input can
                    carry images and nothing else, so the native dialog states
                    that before a file is chosen. */}
                  <TooltipButton
                    type="button"
                    className="icon-btn icon-btn-square"
                    tooltip={t("chat.addImages")}
                    ariaLabel={t("chat.addImages")}
                    disabled={images.busy || !attachmentsAllowed || readOnlySession}
                    onClick={() => void images.pick()}
                  >
                    <IconImage size={15} aria-hidden="true" />
                  </TooltipButton>
                </div>
                {/* The static label describes what the next send will run as,
                  so it sits with the action instead of the picker. */}
                <div className="composer-right">
                  <span
                    className="subagent-transcript-model-static"
                    aria-label={`${t("chat.model")}: ${delegateSettings.modelId || "—"}. ${t("chat.reasoningLevel")}: ${delegateSettings.thinkingLevel || "—"}`}
                    title={modelLabel || undefined}
                  >
                    <span className="composer-model-thinking-icon" aria-hidden="true"><IconBot size={14} /></span>
                    <span className="composer-model-thinking-model">{delegateSettings.modelId || "—"}</span>
                    <span className="composer-model-thinking-dot" aria-hidden="true">·</span>
                    <span className="composer-model-thinking-level">{delegateSettings.thinkingLevel || "—"}</span>
                  </span>
                  {primaryAction === "stop" ? (
                    <SubagentStopButton delegationId={activeDelegationId} running compact />
                  ) : (
                    <ComposerSendButton
                      tooltip={sendLabel}
                      ariaLabel={sendLabel}
                      disabled={sendDisabled}
                      onClick={sendComposer}
                    />
                  )}
                </div>
              </div>
            )}
          </ComposerShell>
          {attachError ? (
            <div className="subagent-transcript-error" role="alert">
              {attachError}
            </div>
          ) : null}
          {readOnlyComposer || !sendError ? null : (
            <div className="subagent-transcript-error" role="alert">
              {sendError}
            </div>
          )}
        </footer>
      </div>
    </DisclosureAnchorContext.Provider>
  );
}
