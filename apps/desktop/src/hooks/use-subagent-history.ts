import { useEffect, useMemo } from "react";
import { findSubagentHistoryEntry, subagentHistoryMessages } from "../lib/subagent-history";
import { EMPTY_TRANSCRIPT } from "../lib/transcript-reading";
import { useAppStore } from "../stores/app-store";

/**
 * One delegate tab's own history source.
 *
 * The tab reads the chain's scoped page, its root `Task` context, and the live
 * rows the parent stream produced for the chain — all of it owned by the
 * entry, none of it derived from the main transcript window. Availability,
 * identity, and content therefore survive the parent replacing, reducing,
 * paginating, or restoring its own range.
 *
 * Opening the tab asks for the entry once. An entry a durable read already
 * finished returns immediately, so the effect cannot loop; an entry that live
 * rows touched since then refreshes its tail once instead of trusting a stale
 * page; a failed one stays an inline error until the reader asks to retry.
 */
export function useSubagentHistory(sessionId: string, tabKey: string) {
  const entry = useAppStore((state) =>
    findSubagentHistoryEntry(state.subagentHistory, sessionId, tabKey),
  );
  // Only the delegate's own session may contribute live rows. A tab keeps its
  // cached page while another conversation is on screen; the store already
  // routes those rows into the entry, so this array is only the current
  // publication's tail.
  const live = useAppStore((state) =>
    state.activeSessionId === sessionId ? state.messages : EMPTY_TRANSCRIPT,
  );
  const ensureSubagentHistory = useAppStore((state) => state.ensureSubagentHistory);
  const loadOlderSubagentHistory = useAppStore((state) => state.loadOlderSubagentHistory);
  const loadLatestSubagentHistory = useAppStore((state) => state.loadLatestSubagentHistory);
  const retrySubagentHistory = useAppStore((state) => state.retrySubagentHistory);

  useEffect(() => {
    if (!sessionId || !tabKey) return;
    void ensureSubagentHistory({ sessionId, tabKey });
  }, [ensureSubagentHistory, sessionId, tabKey]);

  const messages = useMemo(() => subagentHistoryMessages(entry, live), [entry, live]);
  return {
    entry,
    messages,
    status: entry?.status ?? "loading",
    /** A read of already loaded rows is in flight; the rows stay rendered. */
    refreshing: entry?.refreshing === true,
    hasMoreBefore: entry?.hasMoreBefore === true,
    hasMoreAfter: entry?.hasMoreAfter === true,
    focus: entry?.focus ?? null,
    /** The retained row after which rows were omitted, when any were. */
    omittedAfterId: entry?.omittedAfterId,
    error: entry?.error,
    loadOlder: () => {
      if (!sessionId || !tabKey) return;
      void loadOlderSubagentHistory({ sessionId, tabKey });
    },
    loadLatest: () => {
      if (!sessionId || !tabKey) return;
      void loadLatestSubagentHistory({ sessionId, tabKey });
    },
    retry: () => {
      if (!sessionId || !tabKey) return;
      void retrySubagentHistory({ sessionId, tabKey });
    },
  };
}
