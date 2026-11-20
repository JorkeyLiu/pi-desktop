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
import { subagentTranscriptIndex } from "./subagent-index";

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
 * `messages` only has to contain `Task` calls. The conversation's index
 * resolves each chain once, so the map is a lookup over an analysis that is
 * already cached for this messages snapshot rather than another walk of it.
 */
export function subagentChainKeysByIdentity(
  messages: readonly UiMessage[],
): ReadonlyMap<string, string> {
  return subagentTranscriptIndex(messages).chainKeys;
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
  // across ordinary streaming updates and the index below is not re-read per
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
