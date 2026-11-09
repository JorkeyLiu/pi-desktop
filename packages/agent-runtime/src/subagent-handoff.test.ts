import { describe, expect, it, vi } from "vitest";
import type { ResolvedSubagentSelfHandoffSettings } from "@pi-desktop/shared";
import {
  HANDOFF_REARM_TOOL_CALLS,
  MAX_SUBAGENT_HANDOFF_CHARS,
  MAX_SUBAGENT_HANDOFF_FAILURES,
  MAX_SUBAGENT_HANDOFF_NO_PROGRESS,
  MAX_SUBAGENT_HANDOFF_UNANSWERED,
  SUBAGENT_HANDOFF_TOOL_NAME,
  buildSubagentHandoffContext,
  createSubagentHandoffState,
  createSubagentHandoffTool,
  decideSubagentHandoff,
  handoffSteeringMessages,
  normalizeHandoffPayload,
  renderSubagentHandoffRequest,
  renderSubagentHandoffSummary,
  type SubagentHandoffPayload,
} from "./subagent-handoff.js";

const NOW = 1_700_000_000_000;

function settings(
  kind: ResolvedSubagentSelfHandoffSettings["kind"],
  value?: number,
): ResolvedSubagentSelfHandoffSettings {
  return value === undefined ? { kind } : { kind, value };
}

function decision(
  trigger: ResolvedSubagentSelfHandoffSettings,
  state = createSubagentHandoffState(NOW),
  snapshot: {
    contextTokens?: number;
    segmentElapsedMs?: number;
    toolCalls?: number;
    turns?: number;
  } = {},
) {
  return decideSubagentHandoff({
    settings: trigger,
    state,
    snapshot: {
      segmentElapsedMs: snapshot.segmentElapsedMs ?? 0,
      toolCalls: snapshot.toolCalls ?? 0,
      turns: snapshot.turns ?? 0,
      ...(snapshot.contextTokens !== undefined
        ? { contextTokens: snapshot.contextTokens }
        : {}),
    },
  });
}

/**
 * A handoff as a delegate would actually write one: its own ordering, its own
 * formatting, no field names the runtime ever asked for.
 */
const AUTHORED = [
  "Cache reads are on Layer B now — apps/desktop/src/cache/read.ts holds the new path, and the eviction test is in evict.test.ts.",
  "Binding decisions: the legacy reader stays readable for one release, and the writer keeps using Layer A until the migration flag flips.",
  "Verified: `pnpm --filter cache test` passes (42 tests). `cargo test` skipped — no toolchain in this worktree.",
  "",
  "- Next: rewrite the writer's eviction path.",
  "- Then: delete the adapter and rerun the suite.",
  "",
  "Still running: a background typecheck; read its output before touching the writer.",
].join("\n");

const payload: SubagentHandoffPayload = { text: AUTHORED };

describe("decideSubagentHandoff", () => {
  it("never asks while the trigger is off", () => {
    expect(decision(settings("off"), createSubagentHandoffState(NOW), {
      contextTokens: 1_000_000,
      toolCalls: 100,
      segmentElapsedMs: 10_000_000,
    })).toEqual({ action: "wait", reason: "disabled" });
  });

  it("waits below the threshold and asks at it", () => {
    const off = (value: number) => settings("tool-calls", value);
    expect(decision(off(3), createSubagentHandoffState(NOW), { toolCalls: 2 })).toEqual({
      action: "wait",
      reason: "below-threshold",
    });
    expect(decision(off(3), createSubagentHandoffState(NOW), { toolCalls: 3 })).toEqual({
      action: "request",
    });
  });

  it("measures the runtime trigger in elapsed segment milliseconds", () => {
    const trigger = settings("runtime", 600);
    expect(decision(trigger, createSubagentHandoffState(NOW), {
      segmentElapsedMs: 599_000,
    })).toEqual({ action: "wait", reason: "below-threshold" });
    expect(decision(trigger, createSubagentHandoffState(NOW), {
      segmentElapsedMs: 600_000,
    })).toEqual({ action: "request" });
  });

  it("uses request occupancy, not spend, for the token trigger", () => {
    const trigger = settings("context-tokens", 20_000);
    expect(decision(trigger, createSubagentHandoffState(NOW), {
      contextTokens: 19_999,
    })).toEqual({ action: "wait", reason: "below-threshold" });
    expect(decision(trigger, createSubagentHandoffState(NOW), {
      contextTokens: 20_000,
    })).toEqual({ action: "request" });
    // No measurable occupancy means no crossing, never an inferred one.
    expect(decision(trigger, createSubagentHandoffState(NOW))).toEqual({
      action: "wait",
      reason: "below-threshold",
    });
  });

  it("repeats an unanswered request only after the delegate did more work", () => {
    const state = createSubagentHandoffState(NOW);
    state.requested = true;
    state.unanswered = 1;
    state.requestedAtToolCalls = 5;
    // Nothing new since the request: do not crowd the same boundary.
    expect(decision(settings("tool-calls", 1), state, { toolCalls: 5 })).toEqual({
      action: "wait",
      reason: "awaiting-submission",
    });
    // One more tool call is the re-ask.
    expect(decision(settings("tool-calls", 1), state, { toolCalls: 6 })).toEqual({
      action: "request",
    });
  });

  it("rearms a no-progress rollover only after real work", () => {
    const state = createSubagentHandoffState(NOW);
    state.noProgress = 1;
    state.handoffs = 1;
    expect(
      decision(settings("context-tokens", 1_000), state, {
        contextTokens: 5_000,
        toolCalls: HANDOFF_REARM_TOOL_CALLS - 1,
      }),
    ).toEqual({ action: "wait", reason: "rearm" });
    expect(
      decision(settings("context-tokens", 1_000), state, {
        contextTokens: 5_000,
        toolCalls: HANDOFF_REARM_TOOL_CALLS,
      }),
    ).toEqual({ action: "request" });
  });

  it("stops after the bounded number of no-progress rollovers", () => {
    const state = createSubagentHandoffState(NOW);
    state.noProgress = MAX_SUBAGENT_HANDOFF_NO_PROGRESS;
    expect(
      decision(settings("context-tokens", 1_000), state, {
        contextTokens: 50_000,
        toolCalls: 99,
      }),
    ).toEqual({ action: "wait", reason: "no-progress" });
  });

  it("never caps successful rollovers", () => {
    // A long autonomous task may roll over as often as its threshold asks; the
    // only counters with a ceiling are the consecutive failure streaks.
    const state = createSubagentHandoffState(NOW);
    state.handoffs = 1_000;
    expect(decision(settings("tool-calls", 1), state, { toolCalls: 9 })).toEqual({
      action: "request",
    });
  });

  it("stops asking after consecutive failed submissions", () => {
    const state = createSubagentHandoffState(NOW);
    state.failures = MAX_SUBAGENT_HANDOFF_FAILURES;
    expect(decision(settings("tool-calls", 1), state, { toolCalls: 9 })).toEqual({
      action: "wait",
      reason: "attempts",
    });
  });

  it("stops asking after consecutive unanswered requests", () => {
    const state = createSubagentHandoffState(NOW);
    state.unanswered = MAX_SUBAGENT_HANDOFF_UNANSWERED;
    expect(decision(settings("tool-calls", 1), state, { toolCalls: 9 })).toEqual({
      action: "wait",
      reason: "attempts",
    });
  });
});

describe("renderSubagentHandoffRequest", () => {
  it("names the crossing, the tool, and the continuity of the run", () => {
    const text = renderSubagentHandoffRequest({
      settings: settings("context-tokens", 20_000),
      snapshot: { contextTokens: 21_234, segmentElapsedMs: 0, toolCalls: 3, turns: 2 },
    });
    expect(text).toContain(SUBAGENT_HANDOFF_TOOL_NAME);
    expect(text).toContain("21234 of 20000 tokens");
    expect(text).toContain("The run continues with the same task");
    expect(text).toContain("Do not start new work before submitting it");
  });

  it("reports each trigger in its own unit", () => {
    expect(
      renderSubagentHandoffRequest({
        settings: settings("tool-calls", 5),
        snapshot: { segmentElapsedMs: 0, toolCalls: 5, turns: 1 },
      }),
    ).toContain("5 of 5 calls");
    expect(
      renderSubagentHandoffRequest({
        settings: settings("runtime", 1_800),
        snapshot: { segmentElapsedMs: 1_800_000, toolCalls: 0, turns: 1 },
      }),
    ).toContain("30 of 30 minutes");
  });

  it("asks for a free-form handoff, not a field checklist", () => {
    const text = renderSubagentHandoffRequest({
      settings: settings("tool-calls", 10),
      snapshot: { segmentElapsedMs: 0, toolCalls: 10, turns: 4 },
    });
    // Any organization and any length within the bound is accepted.
    expect(text).toContain(`up to ${MAX_SUBAGENT_HANDOFF_CHARS} characters`);
    expect(text).toContain("any structure");
    expect(text).toContain("There is no required outline");
    // Continuation facts are examples, not mandatory fields.
    expect(text).toContain("Facts that still matter");
    expect(text).toContain("decisions and constraints");
    expect(text).toContain("what you verified and how");
    expect(text).toContain("what is left to do");
    expect(text).toContain("still pending or running");
    expect(text).toContain("include only what this task actually needs");
    // The prompt must not claim that everything outside the handoff is lost:
    // the original task and the user's directions survive every rollover.
    expect(text).toContain(
      "The original task and every direction the user sent to this run are kept verbatim",
    );
    // The delegate checks its own handoff before submitting.
    expect(text).toContain("check your own handoff");
    expect(text).toContain("could you resume this task from it alone");
    // No field names, no template, no required sections.
    for (const field of ["nextStep", "sideEffects", "completed:", "checks:", "remaining:"]) {
      expect(text).not.toContain(field);
    }
    expect(text).not.toContain("structured");
  });
});

describe("normalizeHandoffPayload", () => {
  it("accepts arbitrary prose with its own formatting intact", () => {
    const result = normalizeHandoffPayload({ handoff: `  ${AUTHORED}  ` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Outer whitespace is dropped; the author's line breaks, blank line, and
    // bullet markers are the handoff.
    expect(result.payload.text).toBe(AUTHORED);
    expect(result.payload.text).toContain("\n- Next: rewrite the writer's eviction path.");
  });

  it("imposes no fields: a one-line handoff is enough", () => {
    const result = normalizeHandoffPayload({
      handoff: "Keep going at apps/desktop/src/cache/write.ts; the suite is green.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.text).toContain("Keep going");
  });

  it("rejects an empty or missing handoff", () => {
    expect(normalizeHandoffPayload({ handoff: "   \n  " })).toEqual({
      ok: false,
      error:
        "The handoff is empty: write what your future self needs to continue this task.",
    });
    expect(normalizeHandoffPayload({})).toEqual({
      ok: false,
      error: "The handoff is missing: put the continuation text in the `handoff` field.",
    });
    expect(normalizeHandoffPayload(null)).toEqual({
      ok: false,
      error: "The handoff must be submitted as the `handoff` text field.",
    });
    expect(normalizeHandoffPayload(["nope"]).ok).toBe(false);
    expect(normalizeHandoffPayload({ handoff: 42 }).ok).toBe(false);
  });

  it("bounds the text and rejects rather than truncating it", () => {
    const atLimit = normalizeHandoffPayload({
      handoff: "x".repeat(MAX_SUBAGENT_HANDOFF_CHARS),
    });
    expect(atLimit.ok).toBe(true);

    const over = normalizeHandoffPayload({
      handoff: "x".repeat(MAX_SUBAGENT_HANDOFF_CHARS + 1),
    });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    // The reason the delegate gets back names the limit, so it can shorten the
    // handoff instead of losing the detail a cut would have removed.
    expect(over.error).toContain(`${MAX_SUBAGENT_HANDOFF_CHARS}`);
    expect(over.error).toContain("resubmit");
    // The bound leaves room for genuine technical continuation.
    expect(MAX_SUBAGENT_HANDOFF_CHARS).toBeGreaterThanOrEqual(8_000);
  });
});

describe("renderSubagentHandoffSummary", () => {
  it("carries the authored text verbatim, plus the generation", () => {
    const text = renderSubagentHandoffSummary({ payload, generation: 2 });
    expect(text).toContain("[Delegated-task handoff 2]");
    // The delegate's own words, unedited and contiguous.
    expect(text).toContain(AUTHORED);
    expect(text).toContain("which you wrote");
    expect(text).toContain("The task, the tools, and the permissions are unchanged");
    // The rebuilt context carries the user's own directions ahead of it, and a
    // later generation says so instead of claiming the handoff is all that is
    // left of the user's instruction.
    expect(text).toContain("the directions the user sent to this run are kept above it");
  });

  it("adds no field headings of its own", () => {
    const text = renderSubagentHandoffSummary({ payload, generation: 1 });
    for (const heading of [
      "Completed:",
      "Files:",
      "Checks:",
      "Next step:",
      "Remaining work:",
      "Pending or background operations",
      "Non-repeatable side effects",
    ]) {
      expect(text).not.toContain(heading);
    }
  });
});

describe("buildSubagentHandoffContext", () => {
  it("returns the header verbatim followed by exactly one summary row", () => {
    const header = [
      { role: "user" as const, content: "dispatch task", timestamp: 1 },
    ];
    const context = buildSubagentHandoffContext({
      header,
      summary: "summary",
      now: NOW,
    });
    expect(context).toHaveLength(2);
    expect(context[0]).toBe(header[0]);
    expect(context[1]).toMatchObject({ role: "user", content: "summary", timestamp: NOW });
  });
});

describe("createSubagentHandoffTool", () => {
  it("reports a rejected submission as a tool error without throwing", async () => {
    const onSubmit = vi.fn(() => ({ ok: false as const, error: "not now" }));
    const tool = createSubagentHandoffTool({ onSubmit });
    const result = await tool.execute("call-1", { handoff: "go" });
    expect(onSubmit).toHaveBeenCalledWith({ handoff: "go" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "not now" });
    expect(result.details).toEqual({ accepted: false });
  });

  it("accepts a valid submission and tells the model the run continues", async () => {
    const tool = createSubagentHandoffTool({ onSubmit: () => ({ ok: true as const }) });
    const result = await tool.execute("call-1", { handoff: AUTHORED });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Continue the task"),
    });
    // Acceptance is the only thing the result records: the text itself stays in
    // the call's arguments, and no lifecycle state is written into it.
    expect(result.details).toEqual({ accepted: true });
    expect(tool.name).toBe(SUBAGENT_HANDOFF_TOOL_NAME);
    expect(tool.description).toContain("Call it only when the runtime asks for one");
    expect(tool.description).toContain("write everything you would need to finish");
  });

  it("declares one required, bounded string parameter", () => {
    const tool = createSubagentHandoffTool({ onSubmit: () => ({ ok: true as const }) });
    const parameters = tool.parameters as {
      type: string;
      required?: string[];
      properties: Record<string, { type: string; maxLength?: number; minLength?: number }>;
    };
    expect(Object.keys(parameters.properties)).toEqual(["handoff"]);
    expect(parameters.required).toEqual(["handoff"]);
    expect(parameters.properties.handoff).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: MAX_SUBAGENT_HANDOFF_CHARS,
    });
  });
});

describe("handoffSteeringMessages", () => {
  const header = [{ role: "user" as const, content: "dispatch task", timestamp: 1 }];

  it("keeps the delivered directions in delivery order, once each", () => {
    const first = { role: "user" as const, content: "first direction", timestamp: 2 };
    const second = { role: "user" as const, content: "second direction", timestamp: 3 };
    // The ledger is in delivery order; the context also holds rows the
    // runtime did not author (assistant turns, tool results).
    const messages = [
      { role: "system" as const, content: "prompt", timestamp: 0 },
      header[0]!,
      first,
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "working" }],
        timestamp: 4,
      },
      second,
    ] as never[];

    expect(
      handoffSteeringMessages({ ledger: [first, second], messages, header }),
    ).toEqual([first, second]);
  });

  it("keeps two identical directions as two distinct rows", () => {
    const repeated = "Run the suite twice.";
    const first = { role: "user" as const, content: repeated, timestamp: 2 };
    const second = { role: "user" as const, content: repeated, timestamp: 3 };
    const messages = [header[0]!, first, second] as never[];

    expect(
      handoffSteeringMessages({
        ledger: [first, second],
        messages,
        header,
      }),
    ).toEqual([first, second]);
  });

  it("drops a direction the context does not hold", () => {
    // Queued-but-not-yet-delivered steering, and a direction a lossy
    // protection pass absorbed, are both absent from the context: the
    // replacement must not invent them.
    const delivered = { role: "user" as const, content: "delivered", timestamp: 2 };
    const queued = { role: "user" as const, content: "queued", timestamp: 3 };
    const messages = [header[0]!, delivered] as never[];

    expect(
      handoffSteeringMessages({
        ledger: [delivered, queued],
        messages,
        header,
      }),
    ).toEqual([delivered]);
  });

  it("never repeats a row that is already part of the header", () => {
    // A resumed chain can seed the same object the ledger holds.
    const row = { role: "user" as const, content: "earlier direction", timestamp: 2 };
    const messages = [
      row,
      { role: "assistant" as const, content: [], timestamp: 3 },
    ] as never[];

    expect(
      handoffSteeringMessages({ ledger: [row], messages, header: [row] }),
    ).toEqual([]);
  });
});
