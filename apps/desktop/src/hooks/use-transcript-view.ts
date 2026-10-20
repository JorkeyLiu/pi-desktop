import { useMemo } from "react";
import { EMPTY_TRANSCRIPT, transcriptViewMessages } from "../lib/transcript-reading";
import { useAppStore } from "../stores/app-store";

/** Main transcript and subagent details consume the same renderer reading range. */
export function useTranscriptView(sessionId: string) {
  const live = useAppStore((state) =>
    state.activeSessionId === sessionId
      ? state.messages
      : (state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT),
  );
  const history = useAppStore((state) => state.sessionHistory[sessionId]);
  const view = useAppStore((state) => state.transcriptViews[sessionId]);
  const messages = useMemo(() => transcriptViewMessages(live, view), [live, view]);
  return {
    messages,
    hasMoreBefore: view?.hasMoreBefore ?? history?.hasMoreBefore ?? false,
    hasMoreAfter: view?.hasMoreAfter ?? false,
    focus: view?.focus ?? null,
    parentMessage: view?.parentMessage,
    historical: Boolean(view?.focus || view?.restored),
    loading: Boolean(view?.loading),
    /** A later page is in flight; the transcript shows it as a tail status. */
    loadingLater: view?.loading === "after",
    /** The last later page failed and waits for an explicit retry. */
    laterFailed: view?.laterFailed === true,
    /** Only a target read covers the conversation; paging keeps its own status. */
    loadingTarget: view?.loading === "target",
  };
}
