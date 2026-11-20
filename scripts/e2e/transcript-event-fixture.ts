/**
 * Synthetic fixtures and event envelopes for the long-history transcript
 * workload probe.
 *
 * Kept separate from `transcript-event-workload.tsx` so the comparison input
 * (fixture shape, envelope order, scenario list) is one file that both the
 * baseline and the changed implementation replay verbatim. Everything here is
 * pure data construction: no store, no renderer, no timers.
 */
import type { AgentEventEnvelope, SessionSummary, UiMessage } from "@pi-desktop/shared";

export const AT = "2026-09-01T00:00:00.000Z";
export const AT_MS = Date.parse(AT);

export type Fixture = {
  summary: SessionSummary;
  messages: UiMessage[];
  tailId: string;
  chains: string[];
};

let sequence = 0;
/** Unique ids for rows the probe adds on top of a fixture. */
export const nextId = (prefix: string) => `${prefix}-${++sequence}`;

function backgroundRow(sessionId: string, index: number): UiMessage {
  const role = index % 2 === 0 ? "user" : "assistant";
  return {
    id: `${sessionId}-h${index}`,
    role,
    content: `${sessionId} row ${index}. ${"Synthetic history line. ".repeat(8)}`,
    createdAt: AT,
    status: "complete",
  };
}

/**
 * One long conversation with `chains` delegation resume chains. Every chain is
 * three `Task` segments (an original plus two continuations), one `TaskWait`
 * roster row, and one child assistant usage row per segment, and its latest
 * segment is still running so the composer dock lists it.
 */
export function fixture(historyRows: number, chains: number): Fixture {
  const sessionId = `workload-${historyRows}-${chains}`;
  const messages: UiMessage[] = [];
  for (let index = 0; index < historyRows; index += 1) {
    messages.push(backgroundRow(sessionId, index));
  }
  const chainIds: string[] = [];
  for (let chain = 0; chain < chains; chain += 1) {
    const root = `${sessionId}-del-${chain}`;
    chainIds.push(root);
    let resume = "";
    for (let segment = 0; segment < 3; segment += 1) {
      const callId = `${sessionId}-task-${chain}-${segment}`;
      const delegation = segment === 0 ? root : `${root}-${segment}`;
      messages.push({
        id: callId,
        role: "tool",
        content: "",
        createdAt: AT,
        toolName: "Task",
        toolCallId: callId,
        toolStatus: "success",
        toolArgs: {
          agent: "explorer",
          description: segment === 0 ? `Chain ${chain} audit` : `Continuation ${chain}.${segment}`,
          task: "a long brief that is never a title",
          ...(segment === 0 ? {} : { resume }),
        },
        toolResult: {
          details: {
            delegationId: delegation,
            agent: "explorer",
            status: segment === 2 ? "running" : "completed",
            startedAt: AT_MS + chain * 1_000,
            turns: 7 + segment,
            toolCalls: 9 + segment,
            contextTokens: 51_200 + chain,
            usage: { inputTokens: 3_000, outputTokens: 1_500, totalTokens: 4_500 + chain },
          },
        },
      });
      messages.push({
        id: `${callId}-child`,
        role: "assistant",
        content: "Child progress",
        createdAt: AT,
        parentToolCallId: callId,
        agentName: "explorer",
        status: "complete",
        usage: { inputTokens: 1_200, outputTokens: 400, totalTokens: 1_600 },
      });
      resume = delegation;
    }
    messages.push({
      id: `${sessionId}-wait-${chain}`,
      role: "tool",
      content: "",
      createdAt: AT,
      toolName: "TaskWait",
      toolCallId: `${sessionId}-wait-${chain}`,
      toolStatus: "success",
      toolArgs: {},
      toolResult: {
        details: {
          delegations: [{
            delegationId: resume,
            turns: 9,
            toolCalls: 12,
            contextTokens: 60_000 + chain,
            usage: { inputTokens: 4_000, outputTokens: 900, totalTokens: 4_900 + chain },
          }],
        },
      },
    });
  }
  const tailId = `${sessionId}-tail`;
  messages.push({
    id: tailId,
    role: "assistant",
    content: "",
    createdAt: AT,
    status: "streaming",
  });
  return {
    summary: {
      id: sessionId,
      title: `Workload ${historyRows}/${chains}`,
      mode: "agent",
      permissionMode: "ask",
      thinkingLevel: "off",
      providerId: "fixture",
      modelId: "fixture",
      createdAt: AT,
      updatedAt: AT,
      messageCount: messages.length,
    },
    messages,
    tailId,
    chains: chainIds,
  };
}

export type Replay = {
  sessionId: string;
  turnId: string;
  event: AgentEventEnvelope["event"];
};

export function envelope(
  item: Fixture,
  event: AgentEventEnvelope["event"],
  turn = "turn-1",
): Replay {
  return { sessionId: item.summary.id, turnId: turn, event };
}

export function delta(
  item: Fixture,
  text: string,
  id = item.tailId,
  extra: Partial<UiMessage> = {},
): Replay {
  return envelope(item, {
    type: "message_update",
    stream: "delta",
    deltaText: text,
    message: { id, role: "assistant", content: "", createdAt: AT, status: "streaming", ...extra },
  });
}

export function toolStart(
  item: Fixture,
  toolCallId: string,
  toolName: string,
  args: unknown,
): Replay {
  return envelope(item, { type: "tool_start", toolCallId, toolName, args });
}

export function toolEnd(item: Fixture, toolCallId: string, result: unknown): Replay {
  return envelope(item, { type: "tool_end", toolCallId, result });
}

export type Scenario = {
  name: string;
  historyRows: number;
  chains: number;
  deltas: number;
  lifecycleRounds: number;
};

/**
 * Fixed replay list. The order matters: each scenario measures the same shape
 * in both directions, and the scale rows isolate history length from chain
 * count.
 */
export const scenarios: Scenario[] = [
  { name: "delta-only", historyRows: 1_200, chains: 0, deltas: 240, lifecycleRounds: 0 },
  { name: "delta-chains-8", historyRows: 1_200, chains: 8, deltas: 240, lifecycleRounds: 0 },
  { name: "delta-chains-32", historyRows: 1_200, chains: 32, deltas: 240, lifecycleRounds: 0 },
  { name: "lifecycle-chains-8", historyRows: 1_200, chains: 8, deltas: 0, lifecycleRounds: 40 },
  { name: "lifecycle-chains-32", historyRows: 1_200, chains: 32, deltas: 0, lifecycleRounds: 40 },
  { name: "scale-n200-c1", historyRows: 200, chains: 1, deltas: 60, lifecycleRounds: 6 },
  { name: "scale-n600-c1", historyRows: 600, chains: 1, deltas: 60, lifecycleRounds: 6 },
  { name: "scale-n1800-c1", historyRows: 1_800, chains: 1, deltas: 60, lifecycleRounds: 6 },
  { name: "scale-n600-c8", historyRows: 600, chains: 8, deltas: 60, lifecycleRounds: 6 },
  { name: "scale-n1800-c8", historyRows: 1_800, chains: 8, deltas: 60, lifecycleRounds: 6 },
  { name: "scale-n1800-c32", historyRows: 1_800, chains: 32, deltas: 60, lifecycleRounds: 6 },
];
