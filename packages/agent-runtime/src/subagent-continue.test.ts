import { describe, expect, it } from "vitest";
import type { DelegationChain } from "./delegation-history.js";
import {
  buildContinueSyntheticMessages,
  continueEmissions,
  continueHydrationSource,
  decideContinueDelivery,
  isUserContinueTaskRow,
  mapContinueSpawnError,
  parseContinueSidecarParams,
  prepareSubagentContinue,
  validateSubagentContinue,
  type ContinueSourceState,
} from "./subagent-continue.js";

function chain(overrides: Partial<DelegationChain> = {}): DelegationChain {
  return {
    delegateSessionId: "chain-1",
    toolCallIds: ["task-1"],
    delegationIds: ["del-1"],
    agentName: "explorer",
    readFiles: [],
    readLineCount: 0,
    latestDelegationId: "del-1",
    latestStatus: "completed",
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

function ownership(overrides = {}) {
  return {
    expectedParentTurnId: undefined,
    currentTurnId: "parent-turn",
    turnAlive: false,
    runtimeRunning: false,
    ...overrides,
  };
}

describe("validateSubagentContinue", () => {
  it("rejects unknown chains, empty text, and oversized payloads", () => {
    expect(() =>
      validateSubagentContinue(undefined, { delegationId: "x", text: "hi" }, ownership(), new Set()),
    ).toThrow(expect.objectContaining({ errorCode: "DELEGATION_NOT_FOUND" }));
    expect(() =>
      validateSubagentContinue(chain(), { delegationId: "del-1", text: "  " }, ownership(), new Set()),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
  });

  it("steers running chains instead of forking a second run", () => {
    expect(() =>
      validateSubagentContinue(
        chain(),
        { delegationId: "del-1", text: "more" },
        ownership(),
        new Set(["del-1"]),
      ),
    ).toThrow(expect.objectContaining({ errorCode: "CHAIN_BUSY" }));
  });

  it("refuses a stale expected turn and demands one when busy", () => {
    expect(() =>
      validateSubagentContinue(
        chain(),
        { delegationId: "del-1", text: "more", messageId: undefined },
        ownership({ expectedParentTurnId: "other-turn", turnAlive: true, runtimeRunning: true }),
        new Set(),
      ),
    ).toThrow(expect.objectContaining({ errorCode: "TURN_NOT_FOUND" }));
    expect(() =>
      validateSubagentContinue(
        chain(),
        { delegationId: "del-1", text: "more" },
        ownership({ runtimeRunning: true, turnAlive: true }),
        new Set(),
      ),
    ).toThrow(expect.objectContaining({ errorCode: "AGENT_BUSY" }));
  });

  it("dedups a retried caller message id", () => {
    const seen = new Map([["mid-1", "del-2"]]);
    const out = validateSubagentContinue(
      chain(),
      { delegationId: "del-1", text: "more", messageId: "mid-1" },
      ownership(),
      new Set(),
      seen,
    );
    expect(out).toEqual({ outcome: "already-applied", delegationId: "del-1", newDelegationId: "del-2" });
  });
});

describe("decideContinueDelivery", () => {
  const pending: ContinueSourceState = {
    delegationId: "del-1",
    delivery: "parent",
    startedEpoch: 3,
    reportDelivered: false,
    status: "completed",
  };

  it("attaches a pending settled source the parent still expects", () => {
    expect(decideContinueDelivery(pending, 3, true, true)).toEqual({ delivery: "parent" });
  });

  it("detaches delivered, stopped, stale-epoch, and dead-turn sources when idle", () => {
    expect(decideContinueDelivery({ ...pending, reportDelivered: true }, 3, false, false)).toEqual({
      delivery: "user",
    });
    expect(decideContinueDelivery({ ...pending, status: "stopped" }, 3, false, false)).toEqual({
      delivery: "user",
    });
    expect(decideContinueDelivery(pending, 4, false, false)).toEqual({ delivery: "user" });
    expect(decideContinueDelivery(pending, 3, false, false)).toEqual({ delivery: "user" });
    expect(decideContinueDelivery({ ...pending, delivery: "user" }, 3, false, false)).toEqual({
      delivery: "user",
    });
    expect(decideContinueDelivery(undefined, 3, false, false)).toEqual({ delivery: "user" });
  });

  it("rejects busy instead of attaching a detached source to a live parent", () => {
    expect(decideContinueDelivery({ ...pending, reportDelivered: true }, 3, true, true)).toEqual({
      rejected: "AGENT_BUSY",
    });
    expect(decideContinueDelivery(undefined, 3, true, true)).toEqual({ rejected: "AGENT_BUSY" });
  });
});

describe("mapContinueSpawnError", () => {
  it("preserves coded identities across the spawn race", () => {
    expect(mapContinueSpawnError("Delegation x is still running")).toMatchObject({
      errorCode: "CHAIN_BUSY"
    });
    expect(mapContinueSpawnError("Unknown delegation")).toMatchObject({
      errorCode: "DELEGATION_NOT_FOUND"
    });
    expect(mapContinueSpawnError('ended as "stopped" and cannot be resumed')).toMatchObject({
      errorCode: "NOT_RESUMABLE"
    });
    expect(mapContinueSpawnError("no recorded history")).toMatchObject({
      errorCode: "NOT_RESUMABLE"
    });
    expect(mapContinueSpawnError("The parent turn ended before delegation")).toMatchObject({
      errorCode: "TURN_NOT_FOUND"
    });
    expect(mapContinueSpawnError("something else broke")).toMatchObject({
      errorCode: "AGENT_UNAVAILABLE"
    });
  });
});

describe("continue synthetic rows", () => {
  it("pairs the marker with the real invocation and tags user origin", () => {
    const { taskMessage, childMessage, toolCallId } = buildContinueSyntheticMessages({
      chain: chain(),
      delegationId: "del-1",
      text: "go deeper",
      toolCallId: "invoke-1",
    });
    expect(toolCallId).toBe("invoke-1");
    expect(taskMessage.toolCallId).toBe("invoke-1");
    expect(taskMessage.id).toBe("invoke-1");
    expect(taskMessage.toolArgs).toMatchObject({
      agent: "explorer",
      resume: "del-1",
      source: "user",
    });
    expect(taskMessage.parentToolCallId).toBeUndefined();
    expect(childMessage.parentToolCallId).toBe("invoke-1");
    expect(childMessage.agentName).toBe("explorer");
    expect(isUserContinueTaskRow(taskMessage)).toBe(true);
    expect(
      isUserContinueTaskRow({ ...taskMessage, toolArgs: { agent: "explorer", task: "x" } }),
    ).toBe(false);
  });

  it("emits the marker as a parent row and the followup tagged", () => {
    const built = buildContinueSyntheticMessages({
      chain: chain(),
      delegationId: "del-1",
      text: "go deeper",
      toolCallId: "invoke-1",
    });
    const emissions = continueEmissions({
      sessionId: "s",
      turnId: "exec-turn",
      agentName: "explorer",
      toolCallId: "invoke-1",
      taskMessage: built.taskMessage,
      childMessage: built.childMessage,
    });
    expect(emissions.marker.parentToolCallId).toBeUndefined();
    expect(emissions.marker.turnId).toBe("exec-turn");
    expect(emissions.followup.parentToolCallId).toBe("invoke-1");
    expect(emissions.followup.agentName).toBe("explorer");
  });
});

describe("parseContinueSidecarParams", () => {
  it("parses the sidecar call and rejects malformed payloads", () => {
    expect(
      parseContinueSidecarParams({
        sessionId: " s1 ",
        delegationId: "del-1",
        expectedTurnId: "exec-1",
        content: "go",
        messageId: "mid-1",
      }),
    ).toEqual({
      sessionId: "s1",
      delegationId: "del-1",
      expectedTurnId: "exec-1",
      content: "go",
      messageId: "mid-1",
    });
    expect(parseContinueSidecarParams({ sessionId: "s1", delegationId: "del-1", content: "go" })).toEqual({
      sessionId: "s1",
      delegationId: "del-1",
      content: "go",
    });
    expect(() => parseContinueSidecarParams({ sessionId: "s1", content: "go" })).toThrow(
      expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }),
    );
    expect(() =>
      parseContinueSidecarParams({ sessionId: "s1", delegationId: "del-1", content: "x".repeat(20_001) }),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
  });
});

describe("prepareSubagentContinue", () => {
  function state(overrides = {}) {
    const adopted: string[] = [];
    return {
      adopted,
      turnId: "parent-turn",
      turnEpoch: 3,
      disposed: false,
      runCancelled: false,
      turnHadError: false,
      isRunning: false,
      lookupChain: () => chain(),
      lookupRecord: () => undefined,
      runningDelegationIds: new Set<string>(),
      seenContinuations: new Map<string, string>(),
      adoptExecutionTurn: (id: string) => {
        adopted.push(id);
      },
      mintTurnId: () => "minted-exec",
      ...overrides,
    };
  }

  it("mints and adopts an execution turn for a detached source when idle", () => {
    const host = state();
    const out = prepareSubagentContinue({ delegationId: "del-1", text: "more" }, host as never);
    expect(out).toMatchObject({ outcome: "ready", delivery: "user", executionTurnId: "minted-exec" });
    expect(host.adopted).toEqual(["minted-exec"]);
  });

  it("adopts a host-begun execution turn instead of minting", () => {
    const host = state();
    const out = prepareSubagentContinue(
      { delegationId: "del-1", text: "more", expectedParentTurnId: "exec-9" },
      host as never,
    );
    expect(out).toMatchObject({ outcome: "ready", delivery: "user", executionTurnId: "exec-9" });
    expect(host.adopted).toEqual(["exec-9"]);
  });

  it("keeps the live parent turn for an attached source", () => {
    const source: ContinueSourceState = {
      delegationId: "del-1",
      delivery: "parent",
      startedEpoch: 3,
      reportDelivered: false,
      status: "completed",
    };
    const host = state({
      isRunning: true,
      lookupRecord: () => source,
    });
    const out = prepareSubagentContinue(
      { delegationId: "del-1", text: "more", expectedParentTurnId: "parent-turn" },
      host as never,
    );
    expect(out).toMatchObject({ outcome: "ready", delivery: "parent", executionTurnId: "parent-turn" });
    expect(host.adopted).toEqual([]);
  });
});

describe("continueHydrationSource", () => {
  const launch = {
    sessionId: "s1",
    mode: "agent",
    provider: { id: "p1", modelId: "m1" },
    commandShell: { id: "bash", available: true },
  };
  it("passes the launch payload through for post-restart hydration", () => {
    expect(
      continueHydrationSource({
        ...launch,
        delegationId: "del-1",
        expectedTurnId: "turn-1",
        content: "After restart.",
      }),
    ).toMatchObject({ mode: "agent" });
  });
  it("keeps the bare continuation on TURN_NOT_FOUND without a launch", () => {
    expect(
      continueHydrationSource({ sessionId: "s1", delegationId: "del-1", content: "hi" }),
    ).toBeUndefined();
    expect(
      continueHydrationSource({ ...launch, commandShell: { id: "bash", available: false } }),
    ).toBeUndefined();
  });
});
