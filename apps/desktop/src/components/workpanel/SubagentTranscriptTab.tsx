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
  isStaleSubagentTab,
  subagentChainDeliveryOwner,
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
import { IconArrowDown, IconBot } from "../icons";
import { HelpIcon, Textarea, TooltipButton } from "../ui";
import {
  ComposerSendButton,
  composerPrimaryAction,
} from "../../features/chat/composer/ComposerPrimaryAction";
import { DisclosureAnchorContext } from "../../lib/disclosure-anchor-context";
import { TranscriptDisclosureProvider } from "../../features/chat/transcript/disclosure";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import {
  AssistantErrorMessage,
  ThinkingRow,
} from "../../features/chat/transcript/shared";
import { ToolRow } from "../../features/chat/transcript/ToolRow";
import { WorkingIndicator } from "../../features/chat/transcript/ActivityGroup";
import { Markdown } from "../Markdown";
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
  const staleTab = useMemo(
    () => isStaleSubagentTab(messages, delegationId),
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
  // The chain-latest tab owns the action so a stale tab never duplicates it.
  const continuable = shouldShowSubagentContinue({
    outcome,
    hasInstance: instantiated,
    canPromptParent,
    readOnlySession,
    isStaleTab: staleTab,
  });

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  // Latest chain target as of the most recent render: a d1 -> d2 continuation
  // arriving mid-dispatch moves the composer to d2, so the await below must
  // not clear a draft that no longer belongs to the delegation it sent to.
  const activeDelegationRef = useRef(activeDelegationId);
  activeDelegationRef.current = activeDelegationId;
  const showToast = useAppStore((state) => state.showToast);

  // Stale identity/draft guards: a tab/session switch never carries the old
  // draft or error into the new context.
  useEffect(() => {
    sendingRef.current = false;
    setSending(false);
    setDraft("");
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
  const ownerTurnId = resolveSteerOwnerTurn({
    keptTurnId: ownerTurnRef.current.get(activeDelegationId),
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

  const sendSteer = async () => {
    const content = draft.trim();
    if (!content || sendingRef.current) return;
    // Capture turn identity, session, and the chain-latest delegation before
    // the await so a tab/session switch during dispatch never steers the
    // wrong child and never clears the new context's draft. The owner turn
    // is the kept execution turn when this run detached, else the status's
    // current turn; the backend validates it either way.
    const capturedSessionId = useAppStore.getState().activeSessionId;
    const capturedDelegationId = activeDelegationId;
    const liveTurnId = capturedSessionId
      ? useAppStore.getState().agentStatuses[capturedSessionId]?.currentTurnId
      : undefined;
    const capturedOwnerTurn = resolveSteerOwnerTurn({
      keptTurnId: ownerTurnRef.current.get(capturedDelegationId),
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
        messageId,
      });
      // Keep the owning turn for the next steer of this run: for a detached
      // run it is the execution turn the status row may not show yet.
      keepOwnerTurn(capturedDelegationId, response.turnId);
      // Echo is persisted backend and rendered in the chain; clear only on
      // success and only when the composer still targets the same session
      // and chain-latest delegation. A tab/session switch or a d1 -> d2
      // continuation during dispatch moves the target, so the draft is
      // preserved. Failures preserve it.
      if (
        shouldClearSteerDraft({
          sendSucceeded: true,
          capturedSessionId: sessionId,
          currentSessionId: useAppStore.getState().activeSessionId,
          capturedDelegationId,
          currentDelegationId: activeDelegationRef.current,
        })
      ) {
        setDraft("");
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
    const content = draft.trim();
    if (!content || sendingRef.current) return;
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
        messageId,
        ...(captured.turnId ? { expectedTurnId: captured.turnId } : {}),
      });
      // The continued run arrives backend-side as a new chain segment under
      // the returned delegation id; keep its owning turn (present for both
      // attached and detached runs) so a prompt steer of the new run names
      // the right owner before the status row catches up.
      keepOwnerTurn(response.delegationId, response.turnId);
      // The continued run arrives backend-side as a new chain segment; clear
      // only on success and only when the composer still targets the same
      // session and chain-latest delegation. Failures preserve the draft.
      if (
        shouldClearSteerDraft({
          sendSucceeded: true,
          capturedSessionId: captured.sessionId,
          currentSessionId: useAppStore.getState().activeSessionId,
          capturedDelegationId,
          currentDelegationId: activeDelegationRef.current,
        })
      ) {
        setDraft("");
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
  // without exposing harness internals. Stale tabs never duplicate the
  // chain-latest action. A delegation with no backend instance — a denied
  // never-started call, or a tab whose Task chain is missing — names that
  // instead of a cannot-continue line, because an instantiated settled child
  // always continues; remote, native, and permission blocks keep their copy.
  const readonlyReason = !running && !continuable
    ? staleTab
      ? t("panel.subagentStale")
      : !instantiated
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
  const sendDisabled = running
    ? !steerEnabled || !draft.trim()
    : !continueEnabled || !draft.trim();

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
                        <div className="message-user-text selectable">
                          {turn.task || t("panel.subagentTaskEmpty")}
                        </div>
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
                            <div className="message-user-text selectable">
                              {row.message.content}
                            </div>
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
        <footer className="subagent-transcript-composer" data-testid="subagent-panel-footer">
          {running || continuable ? (
            <>
              <Textarea
                rows={2}
                value={draft}
                disabled={running ? !steerEnabled : sending}
                aria-label={composerPlaceholder}
                placeholder={composerPlaceholder}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    (enterToSend || event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    sendComposer();
                  }
                }}
              />
              {sendError ? (
                <div className="subagent-transcript-error" role="alert">
                  {sendError}
                </div>
              ) : null}
              {!running ? (
                <div className="subagent-transcript-helper">
                  {t("chat.subagentContinueHelp")}
                </div>
              ) : null}
              <div className="subagent-transcript-composer-controls">
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
                {composerPrimaryAction(running, draft.trim().length > 0) === "stop" ? (
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
            </>
          ) : (
            <Textarea
              disabled
              rows={2}
              aria-label={readonlyReason ?? t("panel.subagentReadOnly")}
              placeholder={readonlyReason ?? t("panel.subagentReadOnly")}
              title={readonlyReason ?? undefined}
            />
          )}
        </footer>
      </div>
    </DisclosureAnchorContext.Provider>
  );
}
