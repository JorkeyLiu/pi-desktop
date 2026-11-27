import { toolResultPayload } from "../../lib/tool-presentation";
import { SubagentStopButton } from "../../features/chat/transcript/SubagentStopButton";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
  subagentOutcome,
  type SubagentOutcome,
} from "../../lib/subagent-topology";
import { aggregateChainMetricsFromMessages } from "../../lib/subagent-metrics";
import {
  formatThroughputRate,
  throughputPerSecond,
} from "../../lib/generation-throughput";
import {
  captureContinueIdentity,
  captureSteerIdentity,
  shouldClearSteerDraft,
  shouldShowSubagentContinue,
  subagentSteerBlockedReason,
} from "../../lib/subagent-actions";
import {
  subagentChainInstantiated,
  subagentChainLatestDelegationId,
} from "../../lib/subagent-chain";
import { sessionAllows } from "../../lib/remote-session-safety";
import { api } from "../../lib/api";
import {
  isHistoryRevealPosition,
  isLaterRevealPosition,
  isReaderForwardReach,
  transcriptHasLayout,
} from "../../lib/transcript-scroll";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEventHandler,
  type WheelEventHandler,
} from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { useChatSessionCapability } from "../../hooks/use-chat-session-capability";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useSubagentHistory } from "../../hooks/use-subagent-history";
import { useTranscriptSearchFocus } from "../../hooks/use-transcript-search-focus";
import { IconArrowDown, IconBot, IconImage } from "../icons";
import { TooltipButton } from "../ui";
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
import {
  buildSubagentTranscript,
  subagentLatestReplyStartedAt,
} from "../../lib/subagent-transcript";
import { subagentHistoryRunPromptVisible } from "../../lib/subagent-history";
import { handoffCheckpoint } from "../../features/chat/transcript/SubagentHandoffCheckpoint";
import { WorkingIndicator } from "../../features/chat/transcript/ActivityGroup";
import { SubagentTranscriptRows } from "../../features/chat/transcript/SubagentTranscriptRows";
import {
  useSubagentPaneVisible,
  useSubagentRowHydration,
} from "../../features/chat/transcript/hooks/use-subagent-row-hydration";
import {
  buildSubagentTranscriptUnits,
  stabilizeSubagentTranscriptUnits,
  subagentVisibleRows,
  type SubagentTranscriptUnit,
} from "../../lib/subagent-hydration";
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

function SubagentTranscriptSurface({ delegationId }: { delegationId: string }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language || "en";
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  // The delegate detail is its own source: the chain's scoped page plus the
  // root `Task` records that identify it. It never reads the main conversation's
  // window, so the parent browsing around cannot empty this panel.
  const history = useSubagentHistory(activeSessionId ?? "", delegationId);
  const messages = history.messages;
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
  const delegationTimings = useMemo(
    () => collectDelegationTimings(toolItems),
    [toolItems],
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
    () =>
      buildSubagentTranscript(messages, activeDelegationId, {
        promptVisible: (call) => subagentHistoryRunPromptVisible(history.entry, call),
      }),
    [messages, activeDelegationId, history.entry],
  );
  // The turns are the data; the flat unit list is what the pane mounts, so a
  // hydration batch is a row offset inside it rather than a second projection.
  // Units of rows that did not change are reused, which lets the memoized row
  // components bail out of a batch commit.
  const unitCacheRef = useRef<readonly SubagentTranscriptUnit[] | null>(null);
  const transcriptUnits = useMemo(() => {
    const built = buildSubagentTranscriptUnits(transcriptResult?.turns);
    const stable = stabilizeSubagentTranscriptUnits(unitCacheRef.current, built);
    unitCacheRef.current = stable;
    return stable;
  }, [transcriptResult]);
  const transcriptKeys = useMemo(
    () => transcriptUnits.map((unit) => unit.key),
    [transcriptUnits],
  );
  // A handoff checkpoint is numbered by its place among this tab's accepted
  // checkpoints: the runtime persists no generation number, and the row must
  // not invent one. The order of the rows the reader is looking at is the only
  // stable index available.
  const handoffOrdinals = useMemo(() => {
    const ordinals = new Map<string, number>();
    for (const turn of transcriptResult?.turns ?? []) {
      for (const row of turn.rows) {
        if (row.kind !== "tool" || !handoffCheckpoint(row.message)) continue;
        ordinals.set(row.message.id, ordinals.size + 1);
      }
    }
    return ordinals;
  }, [transcriptResult]);

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
  // The working baseline is the chain's newest child reply: a new reply id
  // resets it, streaming tokens keep it, and the same transcript restores it
  // after unmount. Only before the first reply does the delegation's own
  // timing stand in.
  const workingStartedAt = useMemo(
    () =>
      subagentLatestReplyStartedAt(messages, activeDelegationId) ??
      delegationTimings.get(activeDelegationId)?.startedAt,
    [messages, activeDelegationId, delegationTimings],
  );
  const chainMetrics = useMemo(
    () => aggregateChainMetricsFromMessages(messages, activeDelegationId),
    [messages, activeDelegationId],
  );
  // One session average from the chain's canonical per-run totals: exact
  // provider output over summed first-content-to-end spans. Failed, aborted,
  // in-flight, and usage-less turns never contributed; `—` when the chain
  // reported no usable figure.
  const throughputRate = throughputPerSecond(chainMetrics?.throughput);
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

  // A steer targets the live child itself: only the delegate's own liveness
  // and the session's permission matrix gate it, never a parent turn id.
  const steerBlock = subagentSteerBlockedReason({
    readOnlySession,
    canSteerParent,
    running,
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
    // wrong child and never clears the new context's draft. The turn id is
    // informational; steering targets the live child, so it is optional.
    const capturedSessionId = useAppStore.getState().activeSessionId;
    const capturedDelegationId = activeDelegationId;
    const capturedRevision = draftRevisionRef.current;
    const liveTurnId = capturedSessionId
      ? useAppStore.getState().agentStatuses[capturedSessionId]?.currentTurnId
      : undefined;
    const target = useAppStore.getState().sessions.find((item) => item.id === capturedSessionId);
    const captured = captureSteerIdentity({
      sessionId: capturedSessionId ?? undefined,
      turnId: liveTurnId,
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
        ...(turnId ? { expectedTurnId: turnId } : {}),
        content,
        ...(outgoing.length ? { attachments: outgoing } : {}),
        messageId,
      });
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

  // The forward boundary and follow's own re-pin both ask whether the range
  // this pane ends at is the chain's newest row. The reader's window can sit
  // anywhere in the chain, so its bottom is the tail only while no later page
  // remains; both questions read the same fact through this ref, updated on
  // every render, instead of a second copy of the entry's state.
  const hasMoreAfterRef = useRef(history.hasMoreAfter);
  hasMoreAfterRef.current = history.hasMoreAfter;
  const loadedEndIsLatest = useCallback(() => !hasMoreAfterRef.current, []);
  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll: followScroll,
    jumpToLatest,
    scheduleFollowScroll,
    releaseFollow,
    holdReadingPosition,
    settleReadingPosition,
    isPinned,
    readerIntentAt,
    disclosureAnchorNotifier,
  } = useFollowScroll({
    repinRequiresGesture: true,
    loadedEndIsLatest,
  });
  /*
    Boundary paging, the main transcript's direction and its own gates:
    approaching the visible top continues the interval one page earlier and
    holds the fragment in view while the rows above it mount, approaching the
    visible bottom continues one page later. Neither stage is a control, and a
    page already in flight is never requested again by a scroll event. A pane's
    first frames are not a reading position, and a box without layout is at no
    position at all — the same reading the main transcript pages by. A forward
    page that cannot move the window stops asking; the explicit latest control
    is the way back to the tail from there.
  */
  const olderInFlight = useRef(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const latestInFlight = useRef(false);
  /** Rows mounted when the older read was requested; the hold settles on more. */
  const olderRowsBefore = useRef(0);
  /** This pane has presented a row, so its geometry is a reading position. */
  const presented = useRef(false);
  const atOlderBoundary = useRef(false);
  const atNewerBoundary = useRef(false);
  /**
   * A hydration batch is about to add rows above the reader.
   *
   * The reading position is captured synchronously before that commit and
   * applied once the rows are laid out, so every batch of a page keeps the same
   * visible fragment instead of only the page's last commit doing it.
   */
  const batchHoldRef = useRef(false);
  /**
   * A top reach that found the loaded rows still mounting.
   *
   * The reach is not dropped, and it is not answered by mounting the page in
   * one commit either: the batches the pane is already spending keep running,
   * each one holding the reader's fragment, and the older page is asked for
   * only once every loaded row is laid out. A gesture therefore changes the
   * order of work, never the size of a commit.
   */
  const readAfterReveal = useRef(false);
  /** Whether the pane has a visible box: a hidden pane schedules no batches. */
  const paneVisible = useSubagentPaneVisible(scrollRef);
  const hydration = useSubagentRowHydration({
    keys: transcriptKeys,
    visible: paneVisible,
    beforeBatch: () => {
      if (!olderInFlight.current && !readAfterReveal.current) return;
      holdReadingPosition();
      batchHoldRef.current = true;
    },
  });
  /** The rows of the loaded transcript that are mounted right now. */
  const visibleUnits = subagentVisibleRows(transcriptUnits, hydration);
  /**
   * Whether this commit is still presenting the rows it has loaded.
   *
   * Derived from the rows the commit actually mounts rather than from the
   * pump's last published state: a response and the batch that mounts it land
   * in different commits, so the state is one commit behind the list it
   * describes. The pane's own status attribute, the loading hold, and the
   * deferred top read all ask this question, so they all read this answer.
   */
  const hydrationPending = visibleUnits.length < transcriptUnits.length;
  useLayoutEffect(() => {
    if (history.messages.length) presented.current = true;
  }, [history.messages]);
  /**
   * Ask the host for the older page this pane has already reached for.
   *
   * The label, the reading hold, and the row count the page commits against are
   * all captured in the same task as the reach, so only the page's own answer
   * can settle it.
   */
  const beginOlderRead = () => {
    olderInFlight.current = true;
    setOlderLoading(true);
    /** Rows loaded when the read was requested; the read is the page's commit. */
    olderRowsBefore.current = transcriptUnits.length;
    holdReadingPosition();
    history.loadOlder();
  };
  /**
   * The deferred reach reads through this holder so the effect that flushes it
   * never captures a stale row count from an earlier commit.
   */
  const beginOlderReadRef = useRef(beginOlderRead);
  const requestOlder = () => {
    if (olderInFlight.current) return;
    if (!history.hasMoreBefore || history.refreshing || history.status === "loading") return;
    // A reach at the top while the rows this pane already loaded are still
    // arriving mounts them first. The top of a partly mounted page is not a
    // page boundary, so asking the host for more from there would read ahead of
    // rows the reader cannot see yet. The reach stays armed and the pane's own
    // batches keep running - one batch per frame, never the whole page in one
    // commit - and the boundary reads its older page once they are laid out.
    if (hydrationPending) {
      holdReadingPosition();
      readAfterReveal.current = true;
      return;
    }
    beginOlderRead();
  };
  /**
   * The commit's own hydration state, for event handlers.
   *
   * A scroll handler runs after a commit, so it must not read the render it was
   * closed over: a window whose rows are still mounting is not a page boundary.
   * A latch armed by that transient clamp would page forward from a half-built
   * window - a replaced focus window mounts its rows above the viewport and
   * then sits at the bottom for a moment, which is not a reader reach.
   */
  const hydrationPendingRef = useRef(hydrationPending);
  useLayoutEffect(() => {
    hydrationPendingRef.current = hydrationPending;
  });
  const requestNewer = () => {
    if (hydrationPendingRef.current) return;
    if (history.refreshing || history.status === "loading") return;
    if (!history.hasMoreAfter || history.laterStalled) return;
    history.loadNewer();
  };
  // The read's own state finishes before the rows it asked for are drawn, so
  // the hold settles on the commits that mount them: the page's height above
  // the reading position is measured from the rows, not from the answer.
  // Live rows can grow the loaded list while that same read is still pending;
  // they are not the older-page commit and must not release its hold or label.
  // The read finishing is a precondition, not the whole condition: a page that
  // arrived still has to mount every row it added, and the label says so until
  // the last batch lands.
  useLayoutEffect(() => {
    if (!olderInFlight.current || history.refreshing || hydrationPending) return;
    if (transcriptUnits.length <= olderRowsBefore.current) return;
    olderInFlight.current = false;
    setOlderLoading(false);
    settleReadingPosition();
  }, [
    history.messages,
    history.refreshing,
    hydrationPending,
    transcriptUnits.length,
    settleReadingPosition,
  ]);
  // A batch adds rows above the reader without the read publishing again, so
  // the reading position is applied once per batch: the same fragment keeps the
  // same viewport offset across every commit of the page, not only its last.
  useLayoutEffect(() => {
    if (!batchHoldRef.current) return;
    batchHoldRef.current = false;
    settleReadingPosition();
  }, [visibleUnits.length, settleReadingPosition]);
  // A reach that arrived while the loaded rows were still mounting revealed
  // them first; the older page it pointed at is read now, after those rows are
  // laid out, so a partly mounted page is never skipped by a host read.
  useLayoutEffect(() => {
    beginOlderReadRef.current = beginOlderRead;
    if (!readAfterReveal.current || hydrationPending) return;
    readAfterReveal.current = false;
    if (olderInFlight.current || !atOlderBoundary.current) return;
    if (!history.hasMoreBefore || history.refreshing || history.status === "loading") return;
    beginOlderReadRef.current();
  }, [
    beginOlderRead,
    hydrationPending,
    history.hasMoreBefore,
    history.refreshing,
    history.status,
  ]);
  // A read that moves nothing - an overlapping page, or the head - has no rows
  // to settle on, so its own finish releases the hold and the next reach.
  useEffect(() => {
    if (!olderInFlight.current || history.refreshing || hydrationPending) return;
    const timer = window.setTimeout(() => {
      if (!olderInFlight.current || hydrationPending) return;
      olderInFlight.current = false;
      setOlderLoading(false);
      settleReadingPosition();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [history.messages, history.refreshing, hydrationPending, settleReadingPosition]);
  /**
   * The one explicit return to the tail: it reads the scope's newest page and
   * scrolls to the rows that read selected, so a pressed control never lands on
   * the bottom of a stale window.
   *
   * The read supersedes any page still in flight (a boundary reach that was
   * already armed), and the control stays armed until that read publishes: the
   * effect below jumps once the answer is in the entry and mounted, which is
   * what keeps button state and jump state the same transition.
   */
  const requestLatest = () => {
    if (latestInFlight.current) return;
    if (!history.hasMoreAfter) {
      jumpToLatest();
      return;
    }
    latestInFlight.current = true;
    // The explicit tail read supersedes both the older page still in flight and
    // the batches that page queued: neither may land in the window the read
    // replaces, and the reader must not be scrolled to a stale bottom.
    olderInFlight.current = false;
    setOlderLoading(false);
    batchHoldRef.current = false;
    readAfterReveal.current = false;
    hydration.stop();
    releaseFollow();
    history.loadLatest();
  };
  useLayoutEffect(() => {
    if (!latestInFlight.current || history.refreshing) return;
    latestInFlight.current = false;
    jumpToLatest();
  }, [history.messages, history.refreshing, jumpToLatest]);
  const handleScroll: UIEventHandler<HTMLDivElement> = (event) => {
    followScroll(event);
    const el = scrollRef.current;
    // No reading position before this pane has presented a row, and none in a
    // pane whose box has no layout.
    if (!el || !presented.current || !transcriptHasLayout(el)) return;
    const atTop = isHistoryRevealPosition(el, isPinned());
    if (atTop && !atOlderBoundary.current) {
      atOlderBoundary.current = true;
      requestOlder();
    } else if (!atTop) {
      atOlderBoundary.current = false;
    }
    // The newer boundary is only a boundary once the window is built: every
    // row the read loaded has to be laid out before a bottom reach means the
    // reader reached the window's end rather than a half-mounted run.
    // It is also only a boundary for a reader who drove it here. This pane
    // grows its own rows above a released reader, the browser compensates by
    // moving the offset down, and the last compensation lands on the window's
    // bottom - a clamp that looks exactly like a reach. Reading forward
    // therefore needs the reader's own gesture - a wheel, a touch scroll, a
    // scrollbar drag, or a native scrolling key, every one of which the follow
    // hook records.
    //
    // The window's bottom is not the chain's newest row while later pages
    // remain: a reader who reaches it continues the window and a local pin
    // cannot veto that read. The jump control follows its own rule and stays
    // available whenever later rows exist.
    const atBottom = isReaderForwardReach({
      now: performance.now(),
      lastReaderInputAt: readerIntentAt(),
      pinned: isPinned(),
      hydrationPending: hydrationPendingRef.current,
      atRangeBottom: isLaterRevealPosition(el),
      hasMoreAfter: hasMoreAfterRef.current,
    });
    if (atBottom && !atNewerBoundary.current) {
      atNewerBoundary.current = true;
      requestNewer();
    } else if (!atBottom) {
      atNewerBoundary.current = false;
    }
  };
  const handleWheel: WheelEventHandler<HTMLDivElement> = (event) => {
    const el = scrollRef.current;
    // The wheel's own direction only says whether this is a top reach; the
    // follow hook has already recorded the gesture itself, whichever way it
    // points, because a downward wheel is what makes the window's end a reach
    // instead of a clamp.
    if (
      !el ||
      event.deltaY >= 0 ||
      !presented.current ||
      !transcriptHasLayout(el) ||
      !isHistoryRevealPosition(el, isPinned())
    ) return;
    // A tall Task brief can remain the visible anchor while older children
    // prepend after it. The scroller then stays at the top and emits no second
    // scroll event for another wheel reach, so the boundary latch must not
    // suppress the next explicit upward gesture. Defer the read until after
    // the wheel's native scroll so the hold captures the reader's final offset.
    atOlderBoundary.current = true;
    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current || !isHistoryRevealPosition(current, isPinned())) return;
      requestOlder();
    });
  };

  // Several delegation tabs can be open at once, so an explicit search hit
  // is claimed only by the tab whose own conversation contains the message;
  // the other tabs stay where the reader left them.
  const searchTarget = useMemo(() => {
    const focus = history.focus;
    if (!focus) return null;
    // A search hit is claimed once the row is really here: an entry opened for
    // the target reads the page that contains it, so the highlight never lands
    // on a row this tab does not own.
    const present = messages.some((message) => message.id === focus.messageId);
    return present ? { ...focus, sessionId: activeSessionId ?? "" } : null;
  }, [activeSessionId, history.focus, messages]);

  // A search hit is mounted before it is aligned: the focus effect can only
  // find a row that is in the DOM, so the pane's own batches bring the row it
  // names into the mounted run (bounded, one batch per frame, exactly like the
  // rest of the page), and the aligned install happens on the commit where that
  // row is actually mounted. A hit is never answered by mounting the page in one
  // commit.
  // The focus effect re-installs when the mounted rows change as well as when
  // the loaded ones do: a batch that mounts the target is the commit that can
  // align it.
  const transcriptContentVersion = useMemo(
    () => ({ units: transcriptUnits, mounted: visibleUnits.length }),
    [transcriptUnits, visibleUnits],
  );
  useTranscriptSearchFocus({
    target: searchTarget,
    source:
      messages.find((message) => message.id === searchTarget?.messageId)?.content ?? "",
    scrollRef,
    contentRef,
    contentVersion: transcriptContentVersion,
    // Only a fresh hit owns the viewport: the same hit re-installs on every
    // content commit and must not release follow (or drop a page's reading
    // position hold) each time the window grows.
    onNavigate: (fresh: boolean) => {
      if (fresh) releaseFollow();
    },
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
  // The metrics group's slots are fixed: a figure no segment of the chain
  // reported keeps its labelled dash, so the header never grows a slot as a
  // run starts reporting and never explains the dash with a helper.
  const spendTokens = chainMetrics?.usage?.totalTokens;
  const spendValue =
    typeof spendTokens === "number" && Number.isFinite(spendTokens)
      ? formatCompactTokens(spendTokens, language)
      : "—";
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
              <span className="subagent-transcript-metric">
                <span className="subagent-transcript-metric-label">
                  {t("chat.subagentMetricsSpendLabel")}
                </span>
                <span className="subagent-transcript-metric-value" data-testid="subagent-metrics-spend">
                  {spendValue}
                </span>
              </span>
              {activityLabel ? (
                <span className="subagent-transcript-metric">
                  <span className="subagent-transcript-metric-value" data-testid="subagent-metrics-activity">
                    {activityLabel}
                  </span>
                </span>
              ) : null}
              <span
                className="subagent-transcript-metric"
                data-testid="subagent-metrics-throughput"
              >
                <span className="subagent-transcript-metric-label">
                  {t("chat.subagentThroughputLabel")}
                </span>
                <span className="subagent-transcript-metric-value">
                  {throughputRate === null ? "—" : formatThroughputRate(throughputRate, language)}
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
            onWheel={handleWheel}
            role="log"
            aria-live="polite"
            aria-label={t("panel.subagent")}
            tabIndex={0}
          >
            {/* The loaded rows arrive in batches; the attribute states whether
              every row of the loaded window is mounted yet, so a reader (and
              the rendered tests) can tell "still mounting" from "at the head". */}
            <div
              ref={contentRef}
              className="subagent-transcript-list"
              data-hydration-state={hydrationPending ? "pending" : "ready"}
              data-hydration-loaded={transcriptUnits.length}
              data-hydration-mounted={visibleUnits.length}
            >
              {/* Boundary paging has no control of its own: reaching the top
                reads the previous page and holds the fragment in view, exactly
                like the main transcript. The line only states the read. */}
              <div
                className="subagent-transcript-earlier transcript-history-loading"
                role="status"
                aria-live="polite"
                aria-hidden={!olderLoading}
                data-testid="subagent-history-older-loading"
              >
                <span className="subagent-transcript-earlier-label transcript-history-loading-label">
                  {t("chat.loadingEarlierMessages")}
                </span>
              </div>
              {history.status === "loading" && !transcriptResult ? (
                <div className="subagent-transcript-loading" role="status" data-testid="subagent-history-loading">
                  {t("chat.loadingSession")}
                </div>
              ) : null}
              {history.error ? (
                <div className="subagent-transcript-error" role="alert" data-testid="subagent-history-error">
                  <span>{t("chat.subagentHistoryFailed")}</span>
                  <TooltipButton
                    type="button"
                    className="link-btn"
                    tooltip={t("chat.subagentHistoryRetry")}
                    ariaLabel={t("chat.subagentHistoryRetry")}
                    onClick={history.retry}
                  >
                    {t("chat.subagentHistoryRetry")}
                  </TooltipButton>
                </div>
              ) : null}
              {transcriptResult ? (
                <SubagentTranscriptRows
                  units={visibleUnits}
                  handoffOrdinals={handoffOrdinals}
                  running={isRunning}
                />
              ) : history.status === "empty" ? (
                <div className="subagent-transcript-empty" role="status" data-testid="subagent-history-empty">
                  {t("panel.subagentHistoryEmpty")}
                </div>
              ) : history.status === "loading" || history.status === "error" ? null : (
                <div className="subagent-transcript-empty" role="status">
                  {t("panel.subagentEmpty")}
                </div>
              )}

              {showWorking ? <WorkingIndicator startedAt={workingStartedAt} /> : null}
            </div>
          </div>
          {/*
            The transcript's own jump control. A bounded range whose newer rows
            are not loaded keeps it for the same reason the main transcript
            does: its bottom is not the live tail. Pressing it reads the tail
            and scrolls to the rows that read selected, never to the bottom of
            the range the reader has left.
          */}
          {showJump || history.hasMoreAfter ? (
            <TooltipButton
              type="button"
              className="jump-latest-btn subagent-transcript-jump"
              tooltip={t("chat.scrollToBottom")}
              ariaLabel={t("chat.scrollToBottom")}
              onClick={requestLatest}
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
