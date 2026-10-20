import { cachedVisibleActivityItems } from "../../../lib/transcript-activity-summary";
import { reuseReferences } from "../../../lib/transcript-summary";
import { ActivityItems } from "./ActivityItems";
import { ProcessActivityGroup } from "./ProcessActivityGroup";
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentActivity,
  AgentActivityAgent,
  ProposalKind,
} from "@pi-desktop/shared";
import {
  PROVIDER_RETRY_MAX_RETRIES,
} from "@pi-desktop/shared";
import type {
  AssistantActivityItem,
} from "../../../lib/assistant-turns";
import {
  messageThinking as thinkingText,
  subagentRunsEqual,
} from "../../../lib/assistant-turns";
import {
  delegationRoster,
  delegationRosterSummary,
  collectDelegationStatuses,
  collectDelegationTimings,
  isDelegationActivityItem,
  lifecycleKindOf,
  subagentOutcome,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import {
  formatToolDuration,
  getToolAction,
  getToolSummary,
} from "../../../lib/tool-display";
import { IconCircleAlert } from "../../../components/icons";
import { TOOL_RUNNING_KEYS } from "./shared";
import { useAppStore } from "../../../stores/app-store";
import { resolveThinkingDisplayMode } from "../../../lib/turn-process";

type Translate = (key: string, options?: Record<string, unknown>) => string;

type ActivityItem = AssistantActivityItem;

/** Nothing to claim: a segment has no disclosure of its own any more. */
const claimNoop = () => {};

export function activityItemDetail(item: ActivityItem): string {
  if (item.kind === "hostedSearch") return item.round.query ?? "";
  if (item.kind === "thinking") {
    // Latest thought line, so a collapsed header reads like a live ticker.
    const lines = thinkingText(item.message)
      .split("\n")
      .map((line) => line.replace(/^#+\s*|\*\*/g, "").trim())
      .filter(Boolean);
    return lines[lines.length - 1] || "";
  }
  if (lifecycleKindOf(item.message)) {
    return delegationRosterSummary(delegationRoster(item.message));
  }
  return getToolSummary(item.message.toolName, item.message.toolArgs);
}


function waitingSubagentActionLabel(
  agent: AgentActivityAgent,
  t: Translate,
): string {
  if (agent.lastPhase === "thinking") return t("chat.thinking");
  if (agent.lastPhase === "waiting-model") return t("chat.waitingForModel");
  if (agent.lastToolName) {
    return t(TOOL_RUNNING_KEYS[getToolAction(agent.lastToolName)]);
  }
  return "";
}

function waitingSubagentsLabel(
  activity: Extract<AgentActivity, { phase: "waiting-subagents" }>,
  t: Translate,
): string {
  const agents = activity.agents ?? [];
  if (agents.length === 1) {
    const action = waitingSubagentActionLabel(agents[0], t);
    const named = t("chat.waitingForSubagentNamed", { name: agents[0].name });
    return action ? `${named} · ${action}` : named;
  }
  const base = t("chat.waitingForSubagents", { count: activity.subagentCount });
  if (agents.length === 0) return base;
  const details = agents
    .map((agent) => {
      const action = waitingSubagentActionLabel(agent, t);
      return action ? `${agent.name} ${action}` : agent.name;
    })
    .join(", ");
  return `${base} · ${details}`;
}

function retryDelaySeconds(
  activity: Extract<AgentActivity, { phase: "retrying" }>,
  now: number,
): number {
  const delayMs = activity.retryDelayMs ?? 0;
  const elapsedMs = Math.max(0, now - activity.since);
  return Math.max(0, Math.ceil((delayMs - elapsedMs) / 1000));
}

export function runActivityLabel(
  activity: AgentActivity,
  t: Translate,
  now = Date.now(),
): string {
  switch (activity.phase) {
    case "starting":
      return t("chat.startingTurn");
    case "waiting-model":
      return t("chat.waitingForModel");
    case "preparing":
      return t("chat.preparingNextRequest");
    case "compacting":
      return t("chat.compactingContext");
    case "recovering":
      return t("chat.recoveringTurn");
    case "retrying":
      return t("chat.retryingModel", {
        delaySeconds: retryDelaySeconds(activity, now),
        attempt: activity.attempt,
        maxAttempts: activity.infinite ? "∞" : PROVIDER_RETRY_MAX_RETRIES,
      });
    case "waiting-subagents":
      return waitingSubagentsLabel(activity, t);
  }
}

type ActivityGroupProps = {
  items: ActivityItem[];
  embedded?: boolean;
  isActive: boolean;
  endedAt?: string;
  /** Current runtime wait phase, when the group owns the live turn tail. */
  runtimeActivity?: AgentActivity;
  /** Delegation statuses from the entire assistant turn (cross-activity-part). */
  turnDelegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  /** Delegation timings from the entire assistant turn (cross-activity-part). */
  turnDelegationTimings?: ReadonlyMap<string, SubagentTiming>;
};

/** Whether two activity items render identically, delegate rows included. */
export function activityItemsEqual(
  previous: ActivityItem,
  next: ActivityItem,
): boolean {
  if (previous === next) return true;
  if (previous.kind !== next.kind || previous.message !== next.message) {
    return false;
  }
  if (previous.kind === "tool" && next.kind === "tool") {
    return subagentRunsEqual(previous.delegate, next.delegate);
  }
  if (previous.kind === "hostedSearch" && next.kind === "hostedSearch") {
    return previous.round === next.round;
  }
  return true;
}

function activityGroupPropsEqual(
  previous: ActivityGroupProps,
  next: ActivityGroupProps,
) {
  if (
    previous.embedded !== next.embedded ||
    previous.isActive !== next.isActive ||
    previous.endedAt !== next.endedAt ||
    previous.runtimeActivity !== next.runtimeActivity ||
    previous.items.length !== next.items.length
  ) {
    return false;
  }
  if (
    previous.items !== next.items &&
    !previous.items.every((item, index) =>
      activityItemsEqual(item, next.items[index]),
    )
  ) {
    return false;
  }
  // Only Task groups consume the turn-wide delegation maps. Ordinary completed
  // work must retain its render boundary when another group's tools update.
  return (
    (previous.turnDelegationStatuses === next.turnDelegationStatuses &&
      previous.turnDelegationTimings === next.turnDelegationTimings) ||
    !previous.items.some(isDelegationActivityItem)
  );
}

export const ActivityGroup = memo(function ActivityGroup({
  items,
  embedded: _embedded = false,
  isActive,
  turnDelegationStatuses,
  turnDelegationTimings,
}: ActivityGroupProps) {
  const compact = useAppStore(
    (state) => resolveThinkingDisplayMode(state.settings?.thinkingDisplayMode) === "compact",
  );
  const rawDelegateItems = useMemo(() => items.filter(isDelegationActivityItem), [items]);
  const delegatesRef = useRef(rawDelegateItems);
  const delegateItems = reuseReferences(delegatesRef.current, rawDelegateItems);
  delegatesRef.current = delegateItems;
  const rawTools = useMemo(() => items.flatMap((item) => item.kind === "tool" ? [item.message] : []), [items]);
  const toolsRef = useRef(rawTools);
  const tools = reuseReferences(toolsRef.current, rawTools);
  toolsRef.current = tools;
  const delegationItems = useMemo(() => tools.map((message) => ({ kind: "tool" as const, message })), [tools]);
  // `Task` rows only ever say "running"; the turn's TaskWait/TaskList/TaskStop
  // rows carry how each delegate actually ended (ADR 0089). When the lifecycle
  // tool is in a different activity part (the agent emitted text between Task
  // and TaskWait), the turn-level statuses computed by the parent give us the
  // cross-part view we need. Each `Task` call reads its own delegation out of
  // these maps, so the group itself draws no subagent chrome: the card is the
  // only subagent surface in the transcript.
  const delegationStatuses = useMemo(() => turnDelegationStatuses ?? collectDelegationStatuses(delegationItems), [turnDelegationStatuses, delegationItems]);
  const delegationTimings = useMemo(() => turnDelegationTimings ?? collectDelegationTimings(delegationItems), [turnDelegationTimings, delegationItems]);
  // A delegation still running keeps its group live after the parent stopped
  // being the turn's tail, so its card keeps counting and stays reachable.
  const delegationLive = useMemo(
    () => delegateItems.some((item) => subagentOutcome(item.message, delegationStatuses) === "running"),
    [delegateItems, delegationStatuses],
  );
  const live = isActive || delegationLive;
  const visibleItems = useMemo(() => cachedVisibleActivityItems(items, compact, isActive), [items, compact, isActive]);

  const renderedItems = <ActivityItems
    items={items}
    isActive={isActive}
    live={live}
    delegationStatuses={delegationStatuses}
    delegationTimings={delegationTimings}
    onUserInteraction={claimNoop}
  />;

  // The segment's container draws no fold: the turn's process header is the only
  // disclosure above a row, so the segment is visible the moment that header is
  // open and every row keeps its own disclosure.
  return (
    <ProcessActivityGroup items={visibleItems}>
      {renderedItems}
    </ProcessActivityGroup>
  );
}, activityGroupPropsEqual);

/** Keep the running turn visible when no more specific runtime phase is known. */
export function WorkingIndicator({ startedAt }: { startedAt?: number } = {}) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef(startedAt ?? Date.now());

  useEffect(() => {
    startedAtRef.current = startedAt ?? Date.now();
    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div
      className="working-indicator"
      data-testid="working-indicator"
      role="status"
      aria-live="polite"
    >
      <span className="working-indicator-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="working-indicator-label">{t("chat.running")}</span>
      {elapsed > 0 ? (
        <span className="working-elapsed" aria-hidden="true">
          {formatToolDuration(elapsed)}
        </span>
      ) : null}
    </div>
  );
}

export function RunActivityIndicator({ activity }: { activity: AgentActivity }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const retryErrorDetailsId = useId();
  const retryReasonRef = useRef<HTMLSpanElement | null>(null);
  const retryPlateRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity.since]);

  const elapsed = formatToolDuration(
    Math.max(0, Math.floor((now - activity.since) / 1000)),
  );
  const label = runActivityLabel(activity, t as Translate, now);
  const retryError = activity.phase === "retrying" ? activity.error : undefined;

  // The plate hangs off the tail row inside `.thread-scroll`, whose
  // `overflow: auto` clips it, and the conversation bar paints over the same
  // band from a higher stacking level. The room depends on where the row sits
  // in the viewport, which no window-based rule can know: a short transcript
  // leaves the row mid-window, and a long provider message still lost its first
  // lines (ADR 0196). Measure the room the row actually leaves - the plate is
  // anchored 8px above the trigger, so its own bottom edge starts that room -
  // and let the remainder scroll.
  useEffect(() => {
    if (!retryError) return;
    const reason = retryReasonRef.current;
    const plate = retryPlateRef.current;
    if (!reason || !plate) return;
    const measure = () => {
      const toolbarHeight =
        Number.parseFloat(
          getComputedStyle(reason).getPropertyValue("--ds-toolbar-height"),
        ) || 0;
      // The plate is anchored 8px above the trigger, so its own bottom edge
      // starts the room - but the resting state carries a 4px downward
      // translate the revealed state drops. Measure the settled edge, or the
      // cap comes out 4px too generous and the top slides under the bar.
      const resting = getComputedStyle(plate).transform;
      const offset = resting === "none" ? 0 : new DOMMatrixReadOnly(resting).m42;
      const settledBottom = plate.getBoundingClientRect().bottom - offset;
      const room = Math.floor(settledBottom - toolbarHeight);
      // The heading stays readable: only the message body scrolls inside the
      // plate, which keeps the plate's own rounded corner away from a
      // scrollbar (Chromium does not clip one to the radius).
      const bodyText = plate.querySelector<HTMLElement>(
        ".run-activity-error-message",
      );
      const chrome = bodyText
        ? bodyText.getBoundingClientRect().top -
          plate.getBoundingClientRect().top +
          (Number.parseFloat(getComputedStyle(plate).paddingBottom) || 0)
        : 0;
      plate.style.setProperty(
        "--run-activity-error-max-height",
        `${Math.max(0, room)}px`,
      );
      plate.style.setProperty(
        "--run-activity-error-body-max-height",
        `${Math.max(0, Math.floor(room - chrome))}px`,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    const scroller = reason.closest(".thread-scroll");
    scroller?.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", measure);
      scroller?.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [retryError]);
  // A parent-side wait on child agents is not this row's status to draw: the
  // running-subagent dock above the composer already lists every live child
  // with its own elapsed time, and the turn keeps its `Task` / `TaskWait` rows
  // as the wait trace. An aggregate copy here would be the second statement of
  // the same state. Every other phase - the parent's own model wait, starting,
  // preparation, compaction, recovery and retry - still renders in full.
  if (activity.phase === "waiting-subagents") return null;
  const retryErrorSummary = retryError
    ? (() => {
        const key = `errors.${retryError.code}`;
        const localized = t(key);
        return localized === key ? t("chat.responseFailed") : localized;
      })()
    : undefined;
  const retryLabel = retryError
    ? `${label}: ${retryErrorSummary}: ${retryError.message}`
    : label;
  const labelContent = retryError ? (
    <span
      ref={retryReasonRef}
      className="run-activity-retry-reason"
      tabIndex={0}
      aria-describedby={retryErrorDetailsId}
      aria-label={retryLabel}
    >
      <span className="working-indicator-label">{label}</span>
      <span
        id={retryErrorDetailsId}
        ref={retryPlateRef}
        className="run-activity-error-popover message-error"
        role="tooltip"
      >
        <span className="message-error-heading">
          <span className="message-error-icon" aria-hidden>
            <IconCircleAlert size={16} />
          </span>
          <span className="message-error-copy">
            <strong>{retryErrorSummary}</strong>
            <code>
              {retryError.code}
              {/* The transport errno names the failing layer (ENOTFOUND, a
                  TLS code, a dropped socket) while the localized summary
                  cannot; it is a technical token in the same style as the
                  code beside it, so it needs no translation (issue #234). */}
              {retryError.networkCode ? ` · ${retryError.networkCode}` : ""}
              {retryError.providerStatus !== undefined
                ? ` · HTTP ${retryError.providerStatus}`
                : ""}
            </code>
          </span>
        </span>
        <span className="run-activity-error-message selectable">
          {retryError.message}
        </span>
      </span>
    </span>
  ) : (
    <span className="working-indicator-label">{label}</span>
  );

  return (
    <div
      className="working-indicator run-activity-indicator"
      data-phase={activity.phase}
      data-testid="run-activity-indicator"
      role="status"
      aria-live="polite"
    >
      <span className="working-indicator-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {labelContent}
      <span className="working-elapsed" aria-hidden="true">
        {elapsed}
      </span>
    </div>
  );
}

export function PlanningIndicator({ kind }: { kind: ProposalKind }) {
  const { t } = useTranslation();
  return (
    <div
      className="planning-state-indicator"
      role="status"
      aria-live="polite"
      data-kind={kind}
      data-testid="planning-indicator"
    >
      <span className="working-indicator-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{t(`${kind}.planning`)}</span>
    </div>
  );
}
