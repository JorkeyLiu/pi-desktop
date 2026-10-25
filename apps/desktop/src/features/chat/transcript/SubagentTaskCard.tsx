import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import {
  IconBot,
  IconCheck,
  IconCircleAlert,
  IconStop,
} from "../../../components/icons";
import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { useAppStore } from "../../../stores/app-store";
import { formatToolDuration } from "../../../lib/tool-display";
import { toolResultPayload } from "../../../lib/tool-presentation";
import type { SubagentRun } from "../../../lib/assistant-turns";
import {
  delegationIsCreating,
  subagentOutcome,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import { parseSubagentMetrics } from "../../../lib/subagent-metrics";
import {
  joinSubagentInfo,
  subagentMetricsParts,
  subagentStateParts,
} from "../../../lib/subagent-ui-metrics";
import { delegationIdForMessage } from "../../../lib/subagent-panel";
import { delegateTaskTitle } from "../../../lib/subagent-title";
import { useSubagentTaskTitles } from "../../../lib/subagent-title-provider";
import { useSubagentChainMetrics } from "../../../lib/subagent-metrics-provider";
import { delegateAgentName } from "./model";
import { SubagentStopButton } from "./SubagentStopButton";

/**
 * One `Task` call, as the child's own card in the transcript.
 *
 * The card states the work the child was given — its delegation chain's
 * original task title — with its own outcome and runtime at the right of that
 * title. Beneath the title sit the role that ran it and the figures the child
 * reported for itself, each on its own line, every boundary a centred `·`. It
 * is not a disclosure: the brief, the report and the child's rows belong to the
 * child's transcript, which the card opens in the work panel. Nothing here
 * prints the delegate's resolved model or reasoning level; its transcript
 * states those once. Until the call's arguments are final the card holds that
 * shape as a skeleton instead of printing a name it does not have yet.
 */
export function SubagentTaskCard({
  message,
  delegate,
  delegationStatuses,
  delegationTimings,
  onUserInteraction,
}: {
  message: UiMessage;
  delegate?: SubagentRun;
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
  onUserInteraction?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const openSubagentTab = useAppStore((state) => state.openSubagentTab);
  const activeWorkPanelTabId = useAppStore((state) => state.activeWorkPanelTabId);
  const conversationTitles = useSubagentTaskTitles();
  const payload = toolResultPayload(message);
  const rawDelegationId =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { delegationId?: unknown }).delegationId
      : undefined;
  const delegationId =
    typeof rawDelegationId === "string" && rawDelegationId
      ? rawDelegationId
      : undefined;
  // A call that has not returned its handle yet has only its own call id: the
  // tab is keyed by whatever identity the transcript row is keyed by.
  const panelSelectionId = delegationId || message.toolCallId || message.id;
  const agentName = delegateAgentName(message, delegate);
  // A child is named by the task it was given, not by the role that ran it: the
  // title is the delegation chain's original short description, resolved over
  // the whole conversation, so a `Task(resume …)` continuation never renames the
  // work its chain already named (lib/subagent-title).
  const chainTitle =
    conversationTitles?.get(delegationIdForMessage(message)) ||
    delegateTaskTitle(message);
  // Without a description the role becomes the title — an older log carries no
  // other name for the work — and then the row's own localized label.
  const title = chainTitle || agentName || t("chat.subagentUnnamed");
  // The role reads on its own line under the title, where the child's step
  // count used to sit. A role that already names the card is not printed beside
  // itself, and the title keeps its whole width for the work's own name.
  const role = chainTitle ? agentName : "";
  const outcome = subagentOutcome(message, delegationStatuses);
  const preparing = message.toolStatus === "preparing";
  const pulsing = preparing && message.toolArgsComplete !== true;
  // The card's own text is not yet something a reader may rely on. Pi reports
  // the call's parsed `description` once, when the call first becomes
  // identifiable, so while the arguments are still being written that title can
  // be a half-written prefix that changes; without one the card would fall back
  // to the localized unnamed label. Neither is real text, so the whole card
  // waits as one skeleton — its own outline, avatar box and the three copy slots
  // its title, role and figures occupy — and states nothing in words. It takes
  // its real title, role and state at the same ready frame that stops the pulse.
  const skeleton = pulsing;
  // A bare `running` Task call is still being created: the delegate runtime is
  // spawning and no structured snapshot exists yet. That is not a delegation a
  // reader can act on, so the card says so instead of claiming it is running,
  // and it offers no stop handle before there is one to stop.
  const creating = outcome === "running" && delegationIsCreating(message);
  const running = outcome === "running" && !creating;
  const statusLabel = creating
    ? t("chat.subagentCreating")
    : t(`chat.subagentStatus.${outcome}`);
  const timing = delegationId
    ? delegationTimings?.get(delegationId)
    : undefined;
  const [now, setNow] = useState(Date.now);
  // While a delegation is still being created it has no `startedAt` in its
  // result, so the elapsed clock ticks from the call's own timestamp instead of
  // waiting for the handle — the card never reads as stalled.
  const startedAt =
    timing?.startedAt !== undefined
      ? timing.startedAt
      : creating && message.createdAt
        ? Date.parse(message.createdAt) || undefined
        : undefined;
  const durationMs =
    startedAt !== undefined
      ? Math.max(
          0,
          (timing?.completedAt ?? (outcome === "running" ? now : startedAt)) -
            startedAt,
        )
      : message.toolDurationMs;
  const duration =
    typeof durationMs === "number" && durationMs > 0
      ? formatToolDuration(durationMs / 1000)
      : "";
  useEffect(() => {
    // Nothing is ticking before the call runs: its duration begins with
    // execution, not with the model writing the arguments.
    if (outcome !== "running" || preparing) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [outcome, preparing]);
  // The child session's totals, read from the conversation-wide chain fold the
  // transcript supplies: a `Task(resume …)` continuation is one child session,
  // so this card states the same turns, tool calls, spend and latest occupancy
  // its child tab header states instead of its own segment's share. A surface
  // without the provider falls back to this call's own snapshot.
  const chainMetrics = useSubagentChainMetrics();
  const metrics =
    (message.toolCallId ? chainMetrics?.get(message.toolCallId) : undefined) ??
    parseSubagentMetrics(payload);
  const language = i18n.language;
  // All four figures are always stated — a reported zero as a zero, an
  // unreported figure as the labelled dash — so the card holds the same line
  // the dock row for the same child holds, and neither surface changes height
  // as a child's report arrives.
  const metricsParts = subagentMetricsParts(metrics, t, language);
  const metricsLine = joinSubagentInfo(metricsParts);
  const stateParts = subagentStateParts({
    status: statusLabel,
    duration,
  });
  const panelOpen = activeWorkPanelTabId === `subagent:${panelSelectionId}`;
  // There is nothing to read until the call reports the delegation it started.
  const canOpen =
    localToolsAllowed &&
    (Boolean(delegationId) || (delegate?.items.length ?? 0) > 0);
  const openPanel = useCallback(() => {
    if (!canOpen) return;
    onUserInteraction?.();
    openSubagentTab(panelSelectionId, title);
  }, [canOpen, onUserInteraction, openSubagentTab, panelSelectionId, title]);
  // Before execution the card names the work only: no child state, no clock,
  // and no metric placeholders, so hovering adds no status copy either. A card
  // that has no name yet states the wait instead, never the fallback or a
  // half-written title.
  const tooltip = preparing
    ? joinSubagentInfo([title, role])
    : joinSubagentInfo([title, role, ...metricsParts, ...stateParts]);

  return (
    <div
      className={`tool-row subagent-task${panelOpen ? " is-panel-open" : ""}${
        outcome === "running" ? " is-running" : ""
      }${creating ? " is-creating" : ""}${pulsing ? " is-preparing" : ""}`}
      data-message-id={message.id}
      data-outcome={outcome}
    >
      <button
        type="button"
        className="subagent-task-card"
        title={skeleton ? undefined : tooltip}
        aria-busy={skeleton ? true : undefined}
        aria-label={skeleton ? t("chat.subagentPreparing") : undefined}
        disabled={!canOpen}
        onClick={openPanel}
      >
        {skeleton ? (
          <span className="subagent-task-skeleton-avatar" aria-hidden="true" />
        ) : (
          <span className="subagent-task-avatar" aria-hidden>
            <IconBot size={15} />
            <span className="subagent-task-status-icon">
              {outcome === "completed" ? (
                <IconCheck size={8} />
              ) : outcome === "aborted" ? (
                <IconStop size={7} />
              ) : outcome === "running" ? (
                <span />
              ) : (
                <IconCircleAlert size={8} />
              )}
            </span>
          </span>
        )}
        <span className="subagent-task-copy">
          {skeleton ? (
            /* One bar in each of the three line slots the real card fills: the
               title's line box, then the role's, then the figures'. The slot
               takes its height from the same type tokens the real line does, so
               the waiting card is the height of the card that replaces it. The
               third slot is a generic line, never a metric placeholder. They are
               the whole of the card's pending copy, so they stay out of the
               accessibility tree: the card's own accessible name and busy state
               carry the wait. */
            <>
              <span
                className="subagent-task-skeleton-line is-title"
                aria-hidden="true"
              >
                <span className="subagent-task-skeleton-bar" />
              </span>
              <span
                className="subagent-task-skeleton-line is-role"
                aria-hidden="true"
              >
                <span className="subagent-task-skeleton-bar" />
              </span>
              <span
                className="subagent-task-skeleton-line is-metrics"
                aria-hidden="true"
              >
                <span className="subagent-task-skeleton-bar" />
              </span>
            </>
          ) : (
            <>
              <span className="subagent-task-title-row">
                <span className="subagent-task-title" title={title}>
                  {title}
                </span>
                {/* The child's state sits inline at the right of the title: the
                    running mark, then the localized outcome, then its runtime,
                    every boundary the shared separator. The mark keeps its slot
                    in every state, so the status text never shifts as a child
                    starts or settles. A call whose arguments are still being
                    written, or that has not started yet, states no child state
                    at all. */}
                {preparing ? null : (
                  <span className="subagent-task-state">
                    <span
                      className="subagent-task-spinner"
                      data-active={running ? "true" : "false"}
                      aria-hidden="true"
                    />
                    <span
                      className="subagent-task-status"
                      role="status"
                      aria-live="polite"
                    >
                      {statusLabel}
                    </span>
                    {duration ? (
                      <>
                        <span className="subagent-sep" aria-hidden="true">
                          {" · "}
                        </span>
                        <span className="subagent-task-duration">{duration}</span>
                      </>
                    ) : null}
                  </span>
                )}
              </span>
              {role ? (
                <span
                  className="subagent-task-role"
                  title={t("chat.subagentAgent")}
                >
                  {role}
                </span>
              ) : null}
            </>
          )}
          {preparing ? null : (
            <span
              className="subagent-task-metrics"
              title={metricsLine}
              aria-label={t("chat.subagentMetricsLabel")}
            >
              {metricsLine}
            </span>
          )}
        </span>
      </button>
      {/* A sibling of the card, never a button inside it: opening the child's
          transcript and stopping the child it is running are two actions, and
          stopping one delegation never reaches the card's own click. */}
      {delegationId ? (
        <SubagentStopButton
          delegationId={delegationId}
          running={running}
          name={agentName}
        />
      ) : null}
    </div>
  );
}
