import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { SubagentTaskCard } from "./SubagentTaskCard";
import { PlanHistoryCard } from "./PlanHistoryCard";
import { planSubmission } from "../../../lib/plan-history";
import { GeneratedImages } from "./GeneratedImages";
import "../../../styles/generated-images.css";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { useOpenPreviewTarget } from "../../../hooks/use-preview-target";
import { useChatFileMenu } from "../../../hooks/use-chat-file-menu";
import { ContextMenu } from "../../../components/ContextMenu";
import { useFollowScroll } from "../../../hooks/use-follow-scroll";
import { getToolPreviewTarget } from "../../../lib/chat-links";
import { disclosureKey } from "./disclosure";
import {
  getToolAction,
  getToolDisplayName,
  getToolIdentityKey,
  getToolSummary,
  getToolSummaryKey,
  isToolPathSummary,
} from "../../../lib/tool-display";
import { ToolPathSummary } from "./ToolPathSummary";
import {
  buildToolPresentation,
  hasToolDetails,
  runOutcome,
  toolResultChips,
  toolResultPayload,
} from "../../../lib/tool-presentation";
import {
  subagentRunsEqual,
  type SubagentRun,
  type SubagentRunItem,
} from "../../../lib/assistant-turns";
import {
  delegationRoster,
  delegationRosterOutcome,
  delegationRosterSummary,
  lifecycleKindOf,
  taskWaitLifecycle,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import {
  ReviewChangeBody,
  ReviewChangeCounts,
} from "../../../components/ReviewChangeCard";
import { reviewChangeFromMessage } from "../../../lib/workspace-review";
import { ToolChips, ToolDetailBlocks } from "../../../components/ToolDetails";
import {
  IconArrowDown,
  IconBot,
  IconChevronRight,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { DisclosureAnchorContext } from "../../../lib/disclosure-anchor-context";
import {
  AssistantErrorMessage,
  DisclosureCollapseRail,
  LIFECYCLE_LABEL_KEYS,
  LIFECYCLE_RUNNING_KEYS,
  PREVIEWABLE_ACTIONS,
  ThinkingRow,
  ToolActionIcon,
  WAIT_PROGRESS_LABEL_KEYS,
  WAIT_SETTLED_LABEL_KEYS,
  useAutomaticDisclosure,
  useMessageRevealRequest,
} from "./shared";
import { delegateAgentName } from "./model";
import { PluginToolCard } from "./PluginToolCard";
import { useSlotEntryForKey } from "../../../plugins/renderer-slots/use-slots";

type ToolRowProps = {
  message: UiMessage;
  /** Rows the delegate produced, when this row is a `Task` call (ADR 0062). */
  delegate?: SubagentRun;
  /** How a delegation start presents: the child's own Task row. */
  variant?: "default" | "task";
  /** The containing turn renders image results outside its process disclosure. */
  imagesInTurn?: boolean;
  /** Claims the containing activity group when this row is manually used. */
  onUserInteraction?: () => void;
  /** Live delegation statuses read from the turn's lifecycle-tool rows. */
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  /** Runtime timings read from the turn's delegation lifecycle rows. */
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
};

/**
 * A date for the host's weekday index (`Monday = 0`, matching its schedule
 * schema). 2024-01-01 was a Monday, so the formatter names the right day
 * without a locale-specific table of its own.
 */
function weekdayAnchor(weekday: number): Date {
  return new Date(Date.UTC(2024, 0, 1 + weekday));
}

function toolRowDelegationId(message: UiMessage): string | undefined {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const delegationId = (payload as { delegationId?: unknown }).delegationId;
  return typeof delegationId === "string" ? delegationId : undefined;
}

/**
 * Streaming updates replace one message object at a time. Regular rows only
 * depend on that message and their nested run; a Task row additionally depends
 * on the status/timing for its own delegation, not on Map identity.
 */
function toolRowPropsEqual(
  previous: ToolRowProps,
  next: ToolRowProps,
): boolean {
  if (
    previous.message !== next.message ||
    previous.variant !== next.variant ||
    previous.imagesInTurn !== next.imagesInTurn ||
    previous.onUserInteraction !== next.onUserInteraction ||
    !subagentRunsEqual(previous.delegate, next.delegate)
  ) {
    return false;
  }
  if (previous.variant !== "task") return true;
  const previousId = toolRowDelegationId(previous.message);
  const nextId = toolRowDelegationId(next.message);
  if (previousId !== nextId) return false;
  if (!previousId || !nextId) return true;
  const previousTiming = previous.delegationTimings?.get(previousId);
  const nextTiming = next.delegationTimings?.get(nextId);
  return (
    previous.delegationStatuses?.get(previousId) ===
      next.delegationStatuses?.get(nextId) &&
    previousTiming?.startedAt === nextTiming?.startedAt &&
    previousTiming?.completedAt === nextTiming?.completedAt
  );
}

/**
 * One tool call. A call of a plugin's own tool renders the card that plugin
 * registered for it (the `toolCard` slot); the host card below is its
 * fallback, and the only card for every other call. A denied row always keeps
 * the host card.
 *
 * A `Task` call that starts a delegation is not a tool row at all: it is the
 * child's own card, which states the work and opens the child's transcript
 * (<SubagentTaskCard>). The host row below therefore never has to branch on it.
 */
export const ToolRow = memo(function ToolRow(props: ToolRowProps) {
  const { message, variant } = props;
  const cardEntry = useSlotEntryForKey(
    "toolCard",
    !variant && message.toolStatus !== "denied" ? message.toolName : undefined,
  );
  if (variant === "task") return <SubagentTaskCard {...props} />;
  const proposal = planSubmission(message);
  if (proposal && message.toolStatus !== "denied") {
    return <PlanHistoryCard message={message} proposal={proposal} onUserInteraction={props.onUserInteraction} />;
  }
  const hostRow = <HostToolRow {...props} />;
  return cardEntry ? (
    <PluginToolCard key={cardEntry.id} entry={cardEntry} message={message} fallback={hostRow} />
  ) : (
    hostRow
  );
}, toolRowPropsEqual);

function HostToolRow({
  message,
  delegate,
  imagesInTurn = false,
  onUserInteraction,
  delegationTimings,
}: ToolRowProps) {
  const { t, i18n } = useTranslation();
  // Schedule rows name their weekly days in the session language: the host
  // numbers them from Monday = 0, and a bare index is not a schedule a reader
  // can picture. `2024-01-01` is a Monday, so it anchors the mapping.
  const weekdayNames = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        weekday: "short",
        timeZone: "UTC",
      }),
    [i18n.language],
  );
  const detailsId = useId();
  // The row shows a file name; the whole path is its description, so a reader
  // who needs the directory hears it without it taking the hint's line.
  const pathId = useId();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const root = useAppStore((s) => localToolsAllowed ? s.workspace?.path : undefined);
  const openTarget = useOpenPreviewTarget();
  const { fileMenu, openFileMenu, closeFileMenu } = useChatFileMenu();
  const status = message.toolStatus;
  const action = getToolAction(message.toolName);
  // A numeric exit code means Bash returned normally; only invocation errors
  // without a normal exit, or explicit error payloads, mark the row as failed.
  const run = action === "run" ? runOutcome(message) : null;
  const failed = run ? run === "failed" : status === "error";
  // A tool call never opens itself — except a checklist, which is the work the
  // user is watching live, and whose own body is what shows that progress. That
  // default is a derived default: once the user collapses the row, their choice
  // is what survives, so a streaming update never reopens it.
  const revealRequest = useMessageRevealRequest(message.id);
  const disclosure = useAutomaticDisclosure(
    action === "todo",
    revealRequest,
    disclosureKey("tool", message.id),
  );
  const { open, toggle: toggleDisclosure, collapse: collapseDisclosure } = disclosure;
  const titleRef = disclosure.titleRef;
  const toggleRow = useCallback(() => {
    onUserInteraction?.();
    toggleDisclosure();
  }, [onUserInteraction, toggleDisclosure]);
  const collapseRow = useCallback(() => {
    onUserInteraction?.();
    collapseDisclosure();
  }, [collapseDisclosure, onUserInteraction]);
  const argSummary = getToolSummary(message.toolName, message.toolArgs);
  // A path stays whole in `title`, in the copy menu and in its preview target;
  // only what the row prints omits its middle.
  const summaryIsPath = isToolPathSummary(message.toolName, message.toolArgs);
  const summaryIsCode = getToolSummaryKey(message.toolName, message.toolArgs) === "command";
  // A workspace mutation carries its own durable review record (D192): the row
  // ends with its +a/−d and hosts the diff, so the transcript never grows a
  // second collapsed row naming the same file.
  const review = reviewChangeFromMessage(message);
  const previewTarget = PREVIEWABLE_ACTIONS.has(action)
    ? getToolPreviewTarget(message.toolArgs, root)
    : null;
  // A run row keeps its command in the head and only its output in the body.
  const runHead = action === "run";
  // A delegation is always expandable: its brief, report and the delegate's
  // own rows all live in the body.
  const hasDetails =
    hasToolDetails(message) || Boolean(delegate) || Boolean(review);
  const chips = toolResultChips(message);
  // A lifecycle row (ADR 0089) is about subagents, so it is presented as one:
  // the agent names it reports on replace the bare delegation ids it was
  // called with, and its badge rolls up their statuses (D268). A settled
  // `TaskWait` names its own outcome from backend-owned wait fields
  // (`details.status`/`wakeReason`): only a `completed` wait delivered
  // results; a `wakeup` wait is an interim progress checkpoint on
  // still-running delegates, never a result.
  const lifecycle = action === "delegate" ? lifecycleKindOf(message) : null;
  const bareName = (message.toolName ?? "").split(/[._-]/).at(-1)?.toLowerCase();
  const identityKey =
    bareName === "taskwait"
      ? "chat.toolIdentityTaskWait"
      : bareName === "tasklist"
        ? "chat.toolIdentityTaskList"
        : bareName === "taskstop"
          ? "chat.toolIdentityTaskStop"
          : getToolIdentityKey(message.toolName);
  const rawName = identityKey
    ? t(identityKey)
    : getToolDisplayName(message.toolName) || t("chat.tool");
  const roster = lifecycle ? delegationRoster(message) : [];
  const rosterSummary = lifecycle ? delegationRosterSummary(roster) : "";
  const rosterOutcome = lifecycle ? delegationRosterOutcome(roster) : null;
  // A `TaskWait`, and a `TaskList` that blocked on the program coordinator,
  // both carry backend-owned wait fields; a cheap `TaskList` snapshot does not
  // and stays a roster check.
  const waitLifecycle =
    lifecycle === "wait" || lifecycle === "list"
      ? taskWaitLifecycle(message)
      : null;
  // A settled wait names its backend-owned outcome (results arrived, timeout,
  // interrupted) or, for a checkpoint that woke on progress, the reason it
  // woke; a `TaskStop` and a cheap `TaskList` snapshot have neither and keep
  // their own settled label.
  const waitLabelKey =
    waitLifecycle?.kind === "completed"
      ? WAIT_SETTLED_LABEL_KEYS.completed
      : waitLifecycle?.kind === "timeout"
        ? WAIT_SETTLED_LABEL_KEYS.timeout
        : waitLifecycle?.kind === "interrupted"
          ? WAIT_SETTLED_LABEL_KEYS.interrupted
          : waitLifecycle?.kind === "progress"
            ? WAIT_PROGRESS_LABEL_KEYS[waitLifecycle.reason]
            : null;
  // History stays inspectable: a folded checkpoint's tooltip names the
  // actual wait outcome, so repeated waits on the same live delegation read
  // as one ongoing state without losing what each row did.
  const waitTitle = waitLabelKey
    ? [t(waitLabelKey), rosterSummary].filter(Boolean).join(" · ")
    : undefined;
  const agentName =
    action === "delegate" && !lifecycle
      ? delegateAgentName(message, delegate)
      : "";
  // The delegate's last answer row is its report, so the body must not print
  // the same text a second time.
  const nestedReport = delegate?.items.some((item) => item.kind === "answer");
  // Keep mounted output and its reading position while an ancestor is folded,
  // but defer formatting hidden streaming updates until it becomes visible.
  const presentation = useRef<{
    message: UiMessage;
    nestedReport: boolean | undefined;
    language: string;
    blocks: ReturnType<typeof buildToolPresentation>;
  } | null>(null);
  if (open && hasDetails && disclosure.parentVisible &&
    (presentation.current?.message !== message ||
      presentation.current?.nestedReport !== nestedReport ||
      presentation.current?.language !== i18n.language)) {
    presentation.current = {
      message,
      nestedReport,
      language: i18n.language,
      blocks: buildToolPresentation(message, {
        hideSummaryArg: true,
        weekdayName: (weekday) => weekdayNames.format(weekdayAnchor(weekday)),
        ...(nestedReport ? { hideDelegateReport: true } : {}),
      }),
    };
  }
  const blocks = open && hasDetails ? presentation.current?.blocks : null;
  const runLabel =
    run === "running"
      ? t("chat.running")
      : run === "failed"
        ? t("chat.toolFailed")
        : run === "denied"
          ? t("chat.toolDenied")
          : run === "ok"
            ? t("chat.toolCompleted")
            : "";
  // A lifecycle row never falls back to its arguments: while it is still
  // running it has no roster yet, and `delegationIds` would otherwise reach the
  // head as a JSON blob of UUIDs (D268).
  const summary = lifecycle ? rosterSummary : argSummary;
  // A delegate control row states its own wait state on the right: which kind
  // of check it is making while it runs, the backend-owned outcome once it
  // settles. Its name stays the fixed tool identity.
  const lifecycleLabel = lifecycle
    ? status === "running"
      ? t(LIFECYCLE_RUNNING_KEYS[lifecycle])
      : t(waitLabelKey ?? LIFECYCLE_LABEL_KEYS[lifecycle])
    : null;
  const statusLabel =
    lifecycleLabel ??
    (run
      ? runLabel
      : status === "running"
        ? t("chat.running")
        : status === "error"
          ? t("chat.toolFailed")
          : status === "denied"
            ? t("chat.toolDenied")
            : t("chat.toolCompleted"));

  // Auto-scroll the nested `.tool-row-content` containers to their bottom
  // while the tool is still running. These elements have `max-height: 260px`
  // and `overflow: auto`, creating a nested scroll area that the transcript-
  // level follow scroll cannot reach once the height cap is hit. Only scroll
  // when the container is already near the bottom so a manual scroll-up by
  // the user is not overridden.
  useLayoutEffect(() => {
    if (status !== "running" || !open) return;
    const body = disclosure.bodyRef.current;
    if (!body) return;
    const containers = body.querySelectorAll<HTMLElement>(".tool-row-content");
    for (const el of containers) {
      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (nearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [status, open, message, disclosure.bodyRef]);


  const statusTone =
    run === "running" || (!run && status === "running")
      ? "is-running"
      : failed || rosterOutcome === "failed"
        ? "is-error"
        : run === "denied" ||
            (!run && status === "denied") ||
            rosterOutcome === "denied"
          ? "is-denied"
          : "is-done";
  const caret = hasDetails ? <IconChevronRight size={12} /> : null;
  // Lifecycle is stated once, at the row's right edge: a live row spins, a
  // settled row names its state. The identity on the left never changes with
  // it, so a reader can tell which tool ran without reading its status. A
  // delegate control row names its wait even while it runs, because which
  // check is in flight is the whole content of that row.
  const statusBadge =
    !runHead && !lifecycle && status === "running" ? (
      <span className="tool-spinner" aria-label={t("chat.running")} />
    ) : runHead || lifecycle || status === "error" || status === "denied" ? (
      <span className={`tool-row-state ${statusTone}`} role="status" aria-live="polite">
        <span className="tool-row-state-dot" aria-hidden />
        {statusLabel}
      </span>
    ) : null;

  return (
    <div
      className={`tool-row ${
        open ? "open" : ""
      } status-${run === "failed" ? "error" : status || "success"}`}
      role="region"
      data-message-id={message.id}
      data-tool-name={message.toolName ?? ""}
      aria-label={`${t("chat.toolCall")}: ${rawName}${agentName ? `, ${agentName}` : ""}${statusLabel ? `, ${statusLabel}` : ""}`}
    >
        <div className={`tool-row-head${runHead ? " is-run" : ""}`}>
          <button
            ref={titleRef}
            className="tool-row-header"
            aria-expanded={open}
            aria-controls={hasDetails ? detailsId : undefined}
            aria-describedby={summaryIsPath && summary ? pathId : undefined}
            disabled={!hasDetails}
            title={summary || rawName}
            onClick={() => hasDetails && toggleRow()}
          >
            <span className={`tool-row-icon${action === "delegate" ? " is-subagent" : ""}`}>
              <ToolActionIcon action={action} />
            </span>
            <span className="tool-row-name" title={waitTitle}>
              {rawName}
            </span>
            {agentName ? (
              <span className="tool-row-agent" title={t("chat.subagentAgent")}>
                {agentName}
              </span>
            ) : null}
            {summary ? (
              <span
                className={`tool-row-summary${summaryIsCode ? " is-code" : ""}${previewTarget && localToolsAllowed ? " linked" : ""}${summaryIsPath ? " is-path" : ""}`}
                title={summary}
                onClick={
                  previewTarget && localToolsAllowed
                    ? (e) => {
                        e.stopPropagation();
                        openTarget(previewTarget);
                      }
                    : undefined
                }
                onContextMenu={
                  localToolsAllowed && previewTarget?.kind === "file"
                    ? (event) => openFileMenu(event, { path: previewTarget.path })
                    : undefined
                }
              >
                {summaryIsPath ? <ToolPathSummary path={summary} /> : summary}
              </span>
            ) : null}
            <ToolChips chips={chips} />
            {review ? <ReviewChangeCounts change={review} /> : null}
            {lifecycle && roster.length > 0 ? (
              <span className="tool-row-lifecycle">
                <span className="tool-row-agent is-count">
                  {t("chat.subagentCount", { count: roster.length })}
                </span>
                {statusBadge}
              </span>
            ) : (
              statusBadge
            )}
            {caret ? (
              <span className="tool-row-caret" aria-hidden="true">
                {caret}
              </span>
            ) : null}
          </button>
        </div>
      {summaryIsPath && summary ? (
        // Outside the header button on purpose: it describes the row without
        // joining the name that button is read by.
        <span id={pathId} className="sr-only">
          {summary}
        </span>
      ) : null}
      {open && (Boolean(blocks && blocks.length > 0) || Boolean(review)) ? (
        <div className="tool-row-body" id={detailsId} ref={disclosure.bodyRef} {...disclosure.bodyEvents}>
          <DisclosureCollapseRail
            label={t("chat.collapseToolOutput")}
            onCollapse={collapseRow}
          />
          {blocks && blocks.length > 0 ? (
            <ToolDetailBlocks blocks={blocks} plain={runHead} streaming={status === "running"} />
          ) : null}
          {review ? (
            <div className="tool-row-review">
              <ReviewChangeBody message={message} />
            </div>
          ) : null}
        </div>
      ) : null}
      {!imagesInTurn && <GeneratedImages message={message} />}
      {open && delegate ? (
        <SubagentRunRows
          run={delegate}
          agentName={agentName}
          onCollapse={collapseRow}
        />
      ) : null}
      <ContextMenu state={fileMenu} onClose={closeFileMenu} />
    </div>
  );
}

/**
 * Earlier wait checkpoints folded into one ongoing state, still reachable.
 *
 * Repeated Program wait checkpoints on the same live delegation are suppressed
 * as separate top-level rows so the active interval reads as one state. They
 * are not deleted: this small disclosure keeps every earlier checkpoint one
 * click away, with each row's own outcome label and payload intact.
 */
export const FoldedWaitCheckpoints = memo(function FoldedWaitCheckpoints({
  messages,
  onUserInteraction,
}: {
  messages: readonly UiMessage[];
  onUserInteraction?: () => void;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const disclosure = useAutomaticDisclosure(
    false,
    undefined,
    disclosureKey("folded-waits", messages[0]?.id ?? ""),
  );
  const { open, toggle: toggleDisclosure, collapse: collapseDisclosure } = disclosure;
  if (messages.length === 0) return null;
  const toggle = () => {
    onUserInteraction?.();
    toggleDisclosure();
  };
  return (
    <div
      className={`tool-row folded-waits ${open ? "open" : ""}`}
      role="region"
      aria-label={t("chat.showEarlierMessages")}
    >
      <div className="tool-row-head">
        <button
          ref={disclosure.titleRef}
          className="tool-row-header"
          aria-expanded={open}
          aria-controls={detailsId}
          title={t("chat.showEarlierMessages")}
          onClick={toggle}
        >
          <span className="tool-row-icon" aria-hidden>
            <IconBot size={15} />
          </span>
          <span className="tool-row-name">
            {t("chat.processingSteps", { count: messages.length })}
          </span>
          <span className="tool-row-caret" aria-hidden>
            <IconChevronRight size={12} />
          </span>
        </button>
      </div>
      {open ? (
        <div className="tool-row-body" id={detailsId} ref={disclosure.bodyRef} {...disclosure.bodyEvents}>
          <DisclosureCollapseRail
            label={t("chat.collapseDetails")}
            onCollapse={() => {
              onUserInteraction?.();
              collapseDisclosure();
            }}
          />
          {messages.map((message) => (
            <ToolRow key={message.id} message={message} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

/**
 * What a delegate did, nested under the `Task` call that spawned it.
 *
 * The rows are the delegate's context, not the parent's, so they are visibly
 * one level in and stay collapsed with the call. Only one level is possible: a
 * delegate has no `Task` tool of its own (ADR 0062).
 */
export const SubagentRunRows = memo(function SubagentRunRows({
  run,
  agentName,
  onCollapse,
  scrollable = true,
  variant = "inline",
}: {
  run: SubagentRun;
  agentName: string;
  onCollapse?: () => void;
  /** Side-panel mode lets the parent panel own the only scrollbar. */
  scrollable?: boolean;
  /** Dock headings are section labels; inline headings name the delegate. */
  variant?: "inline" | "dock";
}) {
  const { t } = useTranslation();
  const headingId = useId();
  if (run.items.length === 0) return null;
  const dock = variant === "dock";
  return (
    <div className={dock ? "subagent-run is-dock" : "subagent-run"}>
      {onCollapse ? (
        <DisclosureCollapseRail
          label={t("chat.collapseDetails")}
          onCollapse={onCollapse}
        />
      ) : null}
      <div
        className={dock ? "subagent-run-heading is-dock" : "subagent-run-heading"}
        id={headingId}
      >
        {dock ? null : <IconBot size={13} aria-hidden />}
        <span>
          {dock
            ? t("chat.subagentProcess")
            : agentName
              ? t("chat.subagentWork", { agent: agentName })
              : t("chat.subagentWorkUnnamed")}
        </span>
        <span className="subagent-run-count">
          {t("chat.processingSteps", { count: run.items.length })}
        </span>
      </div>
      <SubagentRunFollow
        headingId={headingId}
        items={run.items}
        scrollable={scrollable}
      />
    </div>
  );
});

/**
 * Nested follow-scroll for one expanded delegate (D302). Mounted only once
 * the run has rows, so the first layout pins to the latest output instead of
 * to an empty scroller.
 */
function SubagentRunFollow({
  headingId,
  items,
  scrollable = true,
}: {
  headingId: string;
  items: SubagentRunItem[];
  scrollable?: boolean;
}) {
  const { t } = useTranslation();
  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
    disclosureAnchorNotifier,
  } = useFollowScroll();

  useLayoutEffect(() => {
    if (!scrollable) return;
    scheduleFollowScroll();
  }, [items, scheduleFollowScroll, scrollable]);

  return (
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
      <div className="subagent-run-follow">
        {/* The rows scroll inside the run rather than growing the transcript
          * (D271). Follow sticks to the latest output while pinned (D302).
          * Labelled and focusable so a keyboard reader can reach the scroll
          * area the pointer can already use. */}
        <div
          ref={scrollRef}
          data-scroll-owner="follow"
          className={`subagent-run-rows${scrollable ? "" : " is-panel-flow"}`}
          role="group"
          tabIndex={scrollable ? 0 : undefined}
          aria-labelledby={headingId}
          onScroll={scrollable ? handleScroll : undefined}
        >
          <div ref={contentRef}>
            {items.map((item) =>
              item.kind === "tool" ? (
                <ToolRow key={item.message.id} message={item.message} />
              ) : item.kind === "thinking" ? (
                <ThinkingRow
                  key={`thinking-${item.message.id}`}
                  message={item.message}
                  streaming={item.message.status === "streaming"}
                />
              ) : item.kind === "steering-user" ? (
                <div
                  className="subagent-steering-user"
                  data-message-id={item.message.id}
                  key={`steering-${item.message.id}`}
                >
                  {item.message.content ? (
                    <div className="prose-chat selectable">
                      <Markdown source={item.message.content} />
                    </div>
                  ) : null}
                  {item.message.error ? (
                    <AssistantErrorMessage message={item.message} />
                  ) : null}
                </div>
              ) : (
                <div
                  className="subagent-answer"
                  data-message-id={item.message.id}
                  key={`answer-${item.message.id}`}
                >
                  {item.message.content ? (
                    <div className="prose-chat">
                      <Markdown source={item.message.content} />
                    </div>
                  ) : null}
                  {item.message.error ? (
                    <AssistantErrorMessage message={item.message} />
                  ) : null}
                </div>
              ),
            )}
          </div>
        </div>
        {scrollable && showJump ? (
          <TooltipButton
            type="button"
            className="jump-latest-btn"
            ariaLabel={t("chat.scrollToBottom")}
            tooltip={t("chat.scrollToBottom")}
            onClick={jumpToLatest}
          >
            <IconArrowDown size={14} />
          </TooltipButton>
        ) : null}
      </div>
    </DisclosureAnchorContext.Provider>
  );
}

/** The task text sent to the delegate, shown as the conversation-like body. */
