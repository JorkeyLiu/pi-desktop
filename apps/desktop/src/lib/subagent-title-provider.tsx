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
import { subagentTaskAgents, subagentTaskTitles } from "./subagent-title";

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

/**
 * The requested agent of every delegation of the whole conversation, keyed by
 * delegation identity — the same authority as the titles above.
 *
 * A `TaskSteer` row carries only `delegationId` and `message`, never the
 * target's role, so it reads the recorded role here instead of its own
 * arguments. A surface without a provider resolves to no badge rather than a
 * routing id.
 */
const SubagentAgentContext =
  createContext<ReadonlyMap<string, string> | null>(null);

/** The conversation-wide delegation agents, or `null` outside a transcript surface. */
export function useSubagentTaskAgents(): ReadonlyMap<string, string> | null {
  return useContext(SubagentAgentContext);
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
  const rawAgents = useMemo(() => subagentTaskAgents(calls), [calls]);
  const agentsRef = useRef<ReadonlyMap<string, string>>(rawAgents);
  const agents = reuseReadonlyMap(agentsRef.current, rawAgents);
  agentsRef.current = agents;
  return (
    <SubagentTitleContext.Provider value={titles}>
      <SubagentAgentContext.Provider value={agents}>
        {children}
      </SubagentAgentContext.Provider>
    </SubagentTitleContext.Provider>
  );
}
