import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { UiMessage } from "@pi-desktop/shared";
import { reuseReadonlyMap } from "./assistant-turns";
import { reuseReferences } from "./transcript-summary";
import { isDelegationStartTool } from "./tool-display";
import { subagentTaskTitles } from "./subagent-title";

/**
 * The task titles of the whole conversation, keyed by delegation identity.
 *
 * A delegation card is rendered by the activity group it happens to sit in,
 * but its title belongs to the delegation chain, not to that group: a
 * `Task(resume …)` continuation usually lands in a later group than the call
 * whose description named the work. Resolving over the group's own calls alone
 * would let a continuation rename the work on its card while the tab it opens
 * still reads the original. The transcript surface therefore resolves titles
 * once over its messages and hands the result down through this context; a
 * surface without a provider falls back to the group's own calls.
 */
const SubagentTitleContext =
  createContext<ReadonlyMap<string, string> | null>(null);

/** The conversation-wide task titles, or `null` outside a transcript surface. */
export function useSubagentTaskTitles(): ReadonlyMap<string, string> | null {
  return useContext(SubagentTitleContext);
}

export function SubagentTitleProvider({
  messages,
  children,
}: {
  messages: readonly UiMessage[];
  children: ReactNode;
}) {
  // Only a `Task` call can change a resolved title, so the projection keeps its
  // identity across ordinary streaming updates and the memo below does not run
  // per token. The map itself is reused while its entries are unchanged, which
  // keeps every card's render boundary intact.
  const rawCalls = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.role === "tool" &&
          isDelegationStartTool(message.toolName) &&
          Boolean(message.toolCallId),
      ),
    [messages],
  );
  const callsRef = useRef<UiMessage[]>([]);
  const calls = reuseReferences(callsRef.current, rawCalls);
  callsRef.current = calls;
  const rawTitles = useMemo(() => subagentTaskTitles(calls), [calls]);
  const titlesRef = useRef<ReadonlyMap<string, string>>(rawTitles);
  const titles = reuseReadonlyMap(titlesRef.current, rawTitles);
  titlesRef.current = titles;
  return (
    <SubagentTitleContext.Provider value={titles}>
      {children}
    </SubagentTitleContext.Provider>
  );
}
