import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useEffect } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../../components/ui";
import { IconStop } from "../../../components/icons";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";

// Shared by topology cards and the detail panel to prevent duplicate requests.
const useStops = create<{
  busy: Record<string, { delegationId?: string } | undefined>;
  pending: Record<string, string[]>;
}>(() => ({ busy: {}, pending: {} }));

export function SubagentStopButton({
  delegationId,
  running,
  name,
  compact = false,
}: {
  delegationId?: string;
  running: boolean;
  name?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const paneSessionId = useSlotSessionId();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const sessionId = useAppStore(state => paneSessionId || state.activeSessionId);
  const source = useAppStore(state => state.sessions.find(session => session.id === state.activeSessionId)?.source);
  const busy = useStops(state => sessionId ? state.busy[sessionId] : undefined);
  const pending = useStops(state => sessionId ? state.pending[sessionId] : undefined);
  const stopping = delegationId ? pending?.includes(delegationId) : false;
  const stoppingRequest = busy && (!delegationId || !busy.delegationId || busy.delegationId === delegationId);
  useEffect(() => {
    if (running || !sessionId || !delegationId || !stopping) return;
    useStops.setState(state => ({ pending: {
      ...state.pending,
      [sessionId]: (state.pending[sessionId] ?? []).filter(id => id !== delegationId),
    } }));
  }, [running, sessionId, delegationId, stopping]);
  if (!running || !localToolsAllowed || !sessionId || source === "remote" || source === "pi-native") return null;

  const stop = async () => {
    if (useStops.getState().busy[sessionId]) return;
    useStops.setState(state => ({ busy: { ...state.busy, [sessionId]: { delegationId } } }));
    try {
      const result = await api.stopSubagents({ sessionId, ...(delegationId ? { delegationIds: [delegationId] } : {}) });
      if (result.pending.length > 0) {
        useStops.setState(state => ({ pending: {
          ...state.pending,
          [sessionId]: [...new Set([...(state.pending[sessionId] ?? []), ...result.pending])],
        } }));
      }
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      useStops.setState(state => {
        const busy = { ...state.busy };
        delete busy[sessionId];
        return { busy };
      });
    }
  };
  const label = stoppingRequest || stopping
    ? t("chat.stoppingSubagents")
    : delegationId
      ? t("chat.stopSubagentNamed", { name: name ?? t("chat.subagentUnnamed") })
      : t("chat.stopAllSubagents");
  if (compact) {
    return (
      <TooltipButton
        type="button"
        className="stop-btn"
        tooltip={label}
        ariaLabel={label}
        disabled={!!busy || stopping}
        onClick={() => void stop()}
      >
        {stoppingRequest || stopping ? <span className="tool-spinner" aria-hidden /> : <IconStop size={13} />}
      </TooltipButton>
    );
  }
  // Non-compact card/node slot: icon-only with a tooltip, per the renderer
  // icon-only-action policy. `subagent-stop-button` keeps its 26px box while
  // the shared `stop-btn` supplies the round icon-button look.
  return (
    <TooltipButton
      type="button"
      className="subagent-stop-button stop-btn"
      tooltip={label}
      ariaLabel={label}
      disabled={!!busy || stopping}
      onClick={() => void stop()}
    >
      {stoppingRequest || stopping ? <span className="tool-spinner" aria-hidden /> : <IconStop size={13} />}
    </TooltipButton>
  );
}
