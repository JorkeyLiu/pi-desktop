import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui";
import { IconBot, IconChevronDown, IconChevronUp } from "./icons";
import { SubagentStopButton } from "../features/chat/transcript/SubagentStopButton";
import { formatToolDuration } from "../lib/tool-display";
import {
  dockSubagentDuration,
  type DockSubagent,
} from "../features/chat/composer/subagent-dock-model";
import {
  useSubagentDock,
  useSubagentDockExpansion,
} from "../features/chat/composer/hooks/useSubagentDock";
import {
  joinSubagentInfo,
  subagentMetricsParts,
  subagentStateParts,
} from "../lib/subagent-ui-metrics";
import { useChatSessionCapability } from "../hooks/use-chat-session-capability";
import { useAppStore } from "../stores/app-store";

/**
 * Session-wide running subagents, above the composer.
 *
 * It answers one question the transcript cannot answer while the user is
 * typing: which child agents of this session are still working, wherever the
 * turn that spawned them sits in the history. The list is the transcript's own
 * live set (`useSubagentDock`), so it appears and disappears with the same
 * evidence the transcript uses — no completed history, no second source of
 * truth, no placeholder between a delegation settling and the transcript
 * noticing.
 *
 * Collapsed it is one summary line behind the same disclosure caret the todo
 * dock uses; expanded it is one compact row per running child, laid out like
 * the child's own transcript card: the task title with that child's state and
 * live duration beside it, then the role and the figures the child reported for
 * itself on a line of their own. Each row is one open action with its own stop
 * beside it. There is no dock-wide stop: stopping belongs to the row of the
 * child it stops, where the user can see which child it is.
 */
export function SubagentDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const agents = useSubagentDock(sessionId);
  const [expanded, toggleExpanded] = useSubagentDockExpansion(sessionId);
  const now = useDockClock(agents.length > 0);
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const openSubagentTab = useAppStore((state) => state.openSubagentTab);
  if (agents.length === 0) return null;
  const head = agents[0]!;
  const headTitle = head.title || t("chat.subagentUnnamed");
  const summary = t("chat.subagentDock.summary", {
    count: agents.length,
    title: headTitle,
  });
  return (
    <div className={`subagent-dock${expanded ? " is-expanded" : ""}`}>
      <div className="subagent-dock-header">
        <Button
          type="button"
          variant="ghost"
          className="subagent-dock-toggle"
          aria-expanded={expanded}
          aria-label={t("chat.subagentDock.header", { summary })}
          onClick={toggleExpanded}
        >
          <span className="subagent-dock-header-symbol" aria-hidden>
            ◐
          </span>
          <span className="subagent-dock-header-text">{summary}</span>
          {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        </Button>
      </div>
      <div className="subagent-dock-content" aria-hidden={!expanded}>
        <div className="subagent-dock-clip">
          {/* One scrollport for every running row, keyboard reachable only
              while the disclosure is open — the same shape the todo dock
              uses, so a fan-out wider than the box never truncates. */}
          <div
            className="subagent-dock-list"
            role="list"
            tabIndex={expanded ? 0 : -1}
          >
            {agents.map((agent) => (
              <SubagentDockRow
                key={agent.key}
                agent={agent}
                now={now}
                canOpen={localToolsAllowed}
                onOpen={() => {
                  if (!agent.delegationId) return;
                  openSubagentTab(
                    agent.delegationId,
                    agent.title || undefined,
                  );
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SubagentDockRow({
  agent,
  now,
  canOpen,
  onOpen,
}: {
  agent: DockSubagent;
  now: number;
  canOpen: boolean;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const title = agent.title || t("chat.subagentUnnamed");
  const status = agent.creating
    ? t("chat.subagentCreating")
    : t("chat.subagentStatus.running");
  const elapsed = dockSubagentDuration(agent, now);
  const duration =
    elapsed !== undefined
      ? formatToolDuration(elapsed / 1000)
      : "";
  // The same presenter the child card uses: the row cannot state a different
  // figure, in a different order, than the card for the same child does. All
  // four figures are always stated — a reported zero as a zero, an unreported
  // figure as the labelled dash — so the row keeps one height whether or not
  // the child has reported yet.
  const metricsParts = subagentMetricsParts(agent.metrics, t, i18n.language);
  const metricsLine = joinSubagentInfo(metricsParts);
  const detail = joinSubagentInfo([
    title,
    agent.role,
    ...metricsParts,
    ...subagentStateParts({ status, duration }),
  ]);
  // Before the Task handle lands there is no delegation id: the row is real
  // work but neither action can target it yet.
  const actionable = Boolean(agent.delegationId);
  return (
    <div className="subagent-dock-row" role="listitem" title={detail}>
      {/* The row body is the open action itself: a native button, so a click
          anywhere on it — and Enter or Space — reaches the child's chain tab.
          The stop control is a sibling instead of a nested button, which keeps
          the DOM valid and makes stopping one child independent of opening
          it. */}
      <Button
        type="button"
        variant="ghost"
        className="subagent-dock-row-main"
        disabled={!actionable || !canOpen}
        onClick={onOpen}
      >
        <span className="subagent-dock-row-symbol" aria-hidden>
          <IconBot size={14} />
        </span>
        <span className="subagent-dock-row-copy">
          <span className="subagent-dock-row-title-row">
            <span className="subagent-dock-row-title">{title}</span>
            <span className="subagent-dock-row-state">
              <span className="subagent-dock-row-status">{status}</span>
              {duration ? (
                <>
                  <span className="subagent-sep" aria-hidden="true">{" · "}</span>
                  <span className="subagent-dock-row-duration">{duration}</span>
                </>
              ) : null}
            </span>
          </span>
          {/* The figures are never conditional: a child that has reported
              nothing holds the same four labelled slots as one that has. */}
          <span className="subagent-dock-row-info">
            {agent.role ? (
              <span className="subagent-dock-row-role">{agent.role}</span>
            ) : null}
            {agent.role ? (
              <span className="subagent-sep" aria-hidden="true">{" · "}</span>
            ) : null}
            <span className="subagent-dock-row-metrics" title={metricsLine}>
              {metricsLine}
            </span>
          </span>
        </span>
      </Button>
      <SubagentStopButton
        delegationId={agent.delegationId}
        running={actionable}
        name={agent.role || title}
        compact
      />
    </div>
  );
}

/**
 * One clock for every row while at least one child is running.
 *
 * The rows share a tick instead of each owning an interval, the interval
 * exists only while the dock has work, and it belongs to this dock rather
 * than the composer's module tree — the composer itself never polls.
 */
function useDockClock(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}
