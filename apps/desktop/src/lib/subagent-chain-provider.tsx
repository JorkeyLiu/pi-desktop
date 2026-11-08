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
import { delegationIdForMessage } from "./subagent-panel";
import { subagentResumeLinks } from "./subagent-chain";

/**
 * The canonical chain of every delegation identity in the conversation, keyed
 * by each identity a transcript row or work-panel tab can name it by: every
 * `Task` call id and the delegation id its own result carries.
 *
 * One child session is several `Task` rows — the dispatch, each resume
 * continuation — so a card cannot recognise the panel its child opened by
 * comparing the identity it would open with the tab's stored identity: the two
 * legitimately differ across a resume. This map answers the question both
 * sides can agree on, the chain's earliest call id, so every card of an open
 * chain reports that panel as open and no other card does.
 *
 * `messages` only has to contain `Task` calls. Each resume edge points a
 * continuation at the call it continues, so a chain is the connected component
 * those edges form and walking to the earliest ancestor names it without
 * re-reading the conversation once per call.
 */
export function subagentChainKeysByIdentity(
  messages: readonly UiMessage[],
): ReadonlyMap<string, string> {
  const calls = messages.filter(
    (message) =>
      message.role === "tool" &&
      isDelegationStartTool(message.toolName) &&
      Boolean(message.toolCallId),
  );
  const keys = new Map<string, string>();
  if (calls.length === 0) return keys;
  const { resumeLink } = subagentResumeLinks(calls);
  const parentOf = new Map<string, string>();
  for (const [prior, next] of resumeLink) {
    if (!parentOf.has(next)) parentOf.set(next, prior);
  }
  const rootOf = (callId: string): string => {
    let root = callId;
    for (let guard = 0; guard <= calls.length; guard += 1) {
      const parent = parentOf.get(root);
      if (!parent || parent === root) break;
      root = parent;
    }
    return root;
  };
  for (const call of calls) {
    const callId = call.toolCallId as string;
    const key = rootOf(callId);
    keys.set(callId, key);
    const delegationId = delegationIdForMessage(call);
    if (!keys.has(delegationId)) keys.set(delegationId, key);
  }
  return keys;
}

const SubagentChainKeyContext =
  createContext<ReadonlyMap<string, string> | null>(null);

/** The conversation's chain keys by delegation identity, or `null` outside a transcript. */
export function useSubagentChainKeys(): ReadonlyMap<string, string> | null {
  return useContext(SubagentChainKeyContext);
}

export function SubagentChainKeyProvider({
  messages,
  children,
}: {
  messages: readonly UiMessage[];
  children: ReactNode;
}) {
  // Only a `Task` call can change a chain, so the projection keeps its identity
  // across ordinary streaming updates and the fold below does not run per
  // token. The map itself is reused while its entries are unchanged, which
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
  const rawKeys = useMemo(() => subagentChainKeysByIdentity(calls), [calls]);
  const keysRef = useRef<ReadonlyMap<string, string>>(rawKeys);
  const keys = reuseReadonlyMap(keysRef.current, rawKeys);
  keysRef.current = keys;
  return (
    <SubagentChainKeyContext.Provider value={keys}>
      {children}
    </SubagentChainKeyContext.Provider>
  );
}
