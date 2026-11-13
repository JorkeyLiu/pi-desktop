import { describe, expect, it } from "vitest";
import type { DelegationChain } from "./delegation-history.js";
import {
  buildContinueSpawnEmissions,
  buildContinueSyntheticMessages,
  continueEmissions,
  continueHydrationSource,
  decideContinueDelivery,
  isUserContinueTaskRow,
  mapContinueSpawnError,
  parseContinueSidecarParams,
  parseSteerSubagentParams,
  prepareSubagentContinue,
  validateSubagentContinue,
  type ContinueSourceState,
} from "./subagent-continue.js";

/** The `details` record a tool result carries, without assuming its shape. */
function toolDetailsOf(message: { toolResult?: unknown } | undefined): Record<string, unknown> | undefined {
  const result = message?.toolResult;
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
}

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
  it("rejects unknown chains and empty text", () => {
    expect(() =>
      validateSubagentContinue(undefined, { delegationId: "x", text: "hi" }, ownership(), new Set()),
    ).toThrow(expect.objectContaining({ errorCode: "DELEGATION_NOT_FOUND" }));
    expect(() =>
      validateSubagentContinue(chain(), { delegationId: "del-1", text: "  " }, ownership(), new Set()),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
  });

  /**
   * A continuation is user text: it is as long as the user wrote, and the new
   * run receives every character. Only structure — the chain identity, the
   * turn, the run — stays bounded.
   */
  it("carries any length of continuation text whole", () => {
    const authored = [
      "CONTINUE-HEAD: keep going from the settled run.",
      "follow-up detail with a path and a line number. ".repeat(1_000),
      "CONTINUE-MIDDLE: the constraint that still binds.",
      "astral marker \u{1F642} and CJK marker \u{4EA4}\u{63A5} ".repeat(500),
      "CONTINUE-TAIL: report when done.",
    ].join("\n");
    // Comfortably past the retired 20000-character bound.
    expect(authored.length).toBeGreaterThan(60_000);

    const out = validateSubagentContinue(
      chain(),
      { delegationId: "del-1", text: authored },
      ownership(),
      new Set(),
    );
    expect(out.outcome).toBe("continue");
    if (out.outcome !== "continue") return;
    expect(out.text).toBe(authored);
    expect(out.text.startsWith("CONTINUE-HEAD")).toBe(true);
    expect(out.text).toContain("CONTINUE-TAIL: report when done.");
    // The synthetic rows carry the same text, once each.
    expect(out.childMessage.content).toBe(authored);
    // The structural identities are untouched by the text.
    expect(out.toolCallId).toBeTruthy();
    expect(out.chain.delegationIds).toEqual(["del-1"]);
  });

  it("still bounds the identifiers", () => {
    expect(() =>
      validateSubagentContinue(
        chain(),
        { delegationId: "del-1", text: "go", messageId: "m".repeat(129) },
        ownership(),
        new Set(),
      ),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
    expect(() =>
      validateSubagentContinue(
        chain(),
        { delegationId: "del-1", text: "go" },
        ownership({ expectedParentTurnId: "t".repeat(129) }),
        new Set(),
      ),
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
    expect(
      mapContinueSpawnError("has no recorded history and cannot be continued"),
    ).toMatchObject({
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

  it("publishes the run's own execution turn on its Task marker", () => {
    // The marker is the row a reopened tab reads back, so it must name the
    // turn that owns the continuation's steering rather than leaving the
    // surface to infer one from parent state.
    const synthetic = buildContinueSyntheticMessages({
      chain: chain(),
      delegationId: "del-1",
      text: "go deeper",
      toolCallId: "invoke-1",
    });
    const built = buildContinueSpawnEmissions({
      sessionId: "s",
      executionTurnId: "exec-turn",
      agentName: "explorer",
      validated: {
        outcome: "continue",
        delegationId: "del-1",
        chain: chain(),
        text: "go deeper",
        images: [],
        toolCallId: "invoke-1",
        taskMessage: synthetic.taskMessage,
        childMessage: synthetic.childMessage,
      },
      newDelegationId: "del-2",
    });
    expect(toolDetailsOf(built.taskMessage)).toMatchObject({
      delegationId: "del-2",
      resumedFrom: "del-1",
      executionTurnId: "exec-turn",
    });
    expect(JSON.parse(built.taskMessage.content).details).toMatchObject({
      executionTurnId: "exec-turn",
    });
    // Both marker emissions carry it, so a message_start-only subscriber sees
    // the same identity as one that waits for message_end.
    for (const envelope of [built.markerStart, built.markerEnd]) {
      const message = (envelope.event as { message?: typeof built.taskMessage }).message;
      expect(toolDetailsOf(message)).toMatchObject({ executionTurnId: "exec-turn" });
    }
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
    // No text bound on the transport entry either: the whole continuation
    // crosses the sidecar and is revalidated by the runtime.
    const long = `${"x".repeat(20_001)}CONTINUE-TAIL`;
    expect(
      parseContinueSidecarParams({ sessionId: "s1", delegationId: "del-1", content: long }).content,
    ).toBe(long);
    // Identifiers stay bounded, and an image-only input keeps its own count.
    expect(() =>
      parseContinueSidecarParams({ sessionId: "s1", delegationId: "d".repeat(129), content: "go" }),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
    expect(() =>
      parseContinueSidecarParams({
        sessionId: "s1",
        delegationId: "del-1",
        expectedTurnId: "t".repeat(129),
        content: "go",
      }),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
    const image = { type: "image", data: "aGk=", mimeType: "image/png" };
    expect(() =>
      parseContinueSidecarParams({
        sessionId: "s1",
        delegationId: "del-1",
        content: "",
        images: Array.from({ length: 9 }, () => image),
      }),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
    expect(
      parseContinueSidecarParams({
        sessionId: "s1",
        delegationId: "del-1",
        content: "",
        images: Array.from({ length: 8 }, () => image),
      }).images,
    ).toHaveLength(8);
  });
});

describe("parseSteerSubagentParams", () => {
  it("passes a steer past the retired text bound whole", () => {
    const authored = [
      "STEER-HEAD: also check the escape handler in PermissionDialog.tsx.",
      "steer detail with a path and a line number. ".repeat(1_000),
      "STEER-MIDDLE: the props stay unchanged.",
      "astral marker \u{1F642} and CJK marker \u{4EA4}\u{63A5} ".repeat(500),
      "STEER-TAIL: report the exact line before you finish.",
    ].join("\n");
    // Comfortably past the retired 20000-character payload check.
    expect(authored.length).toBeGreaterThan(60_000);

    const parsed = parseSteerSubagentParams({
      delegationId: "del-1",
      expectedTurnId: "parent-turn",
      content: authored,
    });

    // Every authored character crosses the sidecar unchanged.
    expect(parsed.delegationId).toBe("del-1");
    expect(parsed.expectedTurnId).toBe("parent-turn");
    expect(parsed.content).toBe(authored);
    expect(parsed.content).toContain("STEER-MIDDLE");
    expect(parsed.content).toContain("STEER-TAIL: report the exact line before you finish.");
  });

  it("keeps the structural guards: identity, a non-empty input, image count", () => {
    expect(() =>
      parseSteerSubagentParams({ delegationId: "del-1", expectedTurnId: "parent-turn", content: "  " }),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
    expect(() =>
      parseSteerSubagentParams({ expectedTurnId: "parent-turn", content: "go" }),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
    expect(() =>
      parseSteerSubagentParams({ delegationId: "del-1", content: "go" }),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
    expect(() =>
      parseSteerSubagentParams({
        delegationId: "d".repeat(129),
        expectedTurnId: "parent-turn",
        content: "go",
      }),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
    expect(() =>
      parseSteerSubagentParams({
        delegationId: "del-1",
        expectedTurnId: "t".repeat(129),
        content: "go",
      }),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
    const image = { type: "image", data: "aGk=", mimeType: "image/png" };
    // An image-only steer is a real input, and the transport count still binds.
    const imageOnly = parseSteerSubagentParams({
      delegationId: "del-1",
      expectedTurnId: "parent-turn",
      content: "",
      images: [image],
    });
    expect(imageOnly.images).toHaveLength(1);
    expect(() =>
      parseSteerSubagentParams({
        delegationId: "del-1",
        expectedTurnId: "parent-turn",
        content: "",
        images: Array.from({ length: 9 }, () => image),
      }),
    ).toThrow(expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }));
    // The caller's retry id rides through trimmed, exactly once.
    expect(
      parseSteerSubagentParams({
        delegationId: "del-1",
        expectedTurnId: "parent-turn",
        content: "go",
        messageId: " mid-1 ",
      }).messageId,
    ).toBe("mid-1");
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
