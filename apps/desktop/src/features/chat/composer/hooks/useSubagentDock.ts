import { useCallback, useMemo, useState } from "react";
import { useAppStore } from "../../../../stores/app-store";
import { getTranscriptProjection } from "../../../../lib/transcript-projection";
import {
  collectDockSubagents,
  type DockSubagent,
} from "../subagent-dock-model";

const EMPTY_EXPANSION: Record<string, boolean> = {};

/**
 * The running child agents of one session, read from the chat's own projection.
 *
 * `getTranscriptProjection` is the projection the transcript renders, and
 * `isRunning` is the same session run flag the transcript's liveness trace
 * uses, so the dock can never disagree with the transcript about which
 * delegation is still live.
 */
export function useSubagentDock(sessionId: string | undefined): DockSubagent[] {
  const messages = useAppStore((state) => state.messages);
  const running = useAppStore((state) => state.isRunning);
  const compactions = useAppStore((state) =>
    sessionId ? state.sessionCompactions[sessionId] : undefined,
  );
  const projection = useMemo(
    () => getTranscriptProjection(messages, compactions),
    [messages, compactions],
  );
  return useMemo(
    () =>
      collectDockSubagents({
        messages,
        history: projection.history,
        tail: projection.entries.at(-1),
        running,
      }),
    [messages, projection, running],
  );
}

/**
 * The disclosure choice of one session, kept while the composer stays mounted.
 *
 * The composer is mounted once for the chat surface, so a single local boolean
 * would carry one session's choice into the next. The record is per session and
 * in memory only: no persisted store, no cross-restart state, and the choice
 * survives live updates and a switch back to the session.
 */
export function useSubagentDockExpansion(
  sessionId: string | undefined,
): [expanded: boolean, toggle: () => void] {
  const [bySession, setBySession] = useState(EMPTY_EXPANSION);
  const expanded = Boolean(sessionId && bySession[sessionId]);
  const toggle = useCallback(() => {
    if (!sessionId) return;
    setBySession((current) => ({
      ...current,
      [sessionId]: current[sessionId] !== true,
    }));
  }, [sessionId]);
  return [expanded, toggle];
}
