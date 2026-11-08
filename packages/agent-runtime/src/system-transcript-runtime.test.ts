import { describe, expect, it } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "", authKind: "none",
  baseUrl: "https://fixture.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"],
};
const skill = { id: "fixture/notes", name: "First catalog", description: "Summarize notes" };
function answer(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" = "stop"): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now() + 10, stopReason, content,
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
/** A skill document the fixture host serves; `{ error }` fails the load. */
type FixtureDocument = string | { error: string };
function fixture(
  history: UiMessage[] = [],
  skills = [skill],
  documents: Record<string, FixtureDocument> = {},
  compaction?: ContextCompactionRecord,
) {
  const rows = [...history];
  const requests: Message[][] = [];
  const executions: string[] = [];
  const errors: unknown[] = [];
  let persistenceFailure: Error | undefined;
  let respond = () => answer([{ type: "text", text: "Done." }]);
  const runtime = new DesktopAgentRuntime({
    sessionId: "fixture", mode: "agent", provider, thinkingLevel: "off", history, pluginSkills: skills,
    ...(compaction ? { compaction } : {}),
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "session.appendMessage") {
        if (persistenceFailure) throw persistenceFailure;
        rows.push((params as { message: UiMessage }).message);
      }
      else if (method === "tools.execute") {
        const call = params as { toolName: string; args?: { id?: unknown } };
        if (call.toolName !== "Skill") throw new Error(`Unexpected tool: ${call.toolName}`);
        const id = String(call.args?.id ?? "");
        executions.push(id);
        const document = documents[id];
        if (document === undefined) throw new Error(`No fixture document for ${id}`);
        return (typeof document === "string"
          ? { ok: true, content: document }
          : { ok: false, isError: true, content: document.error }) as T;
      }
      else throw new Error(`Unexpected host method: ${method}`);
      return undefined as T;
    } },
    onEvent: ({ event }) => {
      if (event.type === "error") errors.push(event.error);
      if (event.type === "tool_start") rows.push({
        id: event.toolCallId, role: "tool", content: "", toolCallId: event.toolCallId,
        toolName: event.toolName, toolArgs: event.args, createdAt: new Date().toISOString(),
      });
      if (event.type === "tool_end") {
        const row = rows.find((row) => row.id === event.toolCallId)!;
        row.toolResult = event.result; row.isError = event.isError; row.toolStatus = "success";
      }
      if (event.type === "message_end") {
        const index = rows.findIndex((row) => row.id === event.message.id);
        if (index < 0) rows.push(event.message); else rows[index] = event.message;
      }
    },
  });
  const agent = (runtime as unknown as { agent: Agent }).agent;
  agent.streamFunction = async (_model, context) => {
    requests.push(structuredClone(context.messages));
    const message = respond();
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  return {
    runtime, agent, rows, requests, errors, executions,
    failPersistence: () => { persistenceFailure = new Error("disk full"); },
    respond: (next: () => AssistantMessage) => { respond = next; },
    prompt: async (id: string) => {
      rows.push({ id, role: "user", content: "Continue", createdAt: new Date().toISOString() });
      await runtime.prompt("Continue", id, `turn-${id}`);
    },
  };
}

describe("system state through the Desktop user path", () => {
  it("activates ToolSearch through Pi, retains its prefix, and restores the declarations after restart", async () => {
    const f = fixture();
    let requests = 0;
    f.respond(() => ++requests === 1
      ? answer([{ type: "toolCall", id: "search-call", name: "ToolSearch", arguments: { query: "BrowserPreview" } }], "toolUse")
      : answer([{ type: "text", text: "Ready." }]));
    try {
      await f.prompt("user-1");
      expect(f.requests).toHaveLength(2);
      const [before, after] = f.requests;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(getCurrentTools(before).some((tool) => tool.name === "BrowserPreview")).toBe(false);
      expect(getCurrentTools(after).some((tool) => tool.name === "BrowserPreview")).toBe(true);
      const activation = after.findIndex((message) => message.role === "toolResult" && message.toolName === "ToolSearch");
      expect(after.slice(activation + 1)).toContainEqual(expect.objectContaining({ role: "system", toolsAdded: expect.arrayContaining([expect.objectContaining({ name: "BrowserPreview" })]) }));
      expect(f.rows.filter((row) => row.modelSystem)).toHaveLength(2);
      await f.prompt("same-runtime-user");
      expect(getCurrentTools(f.requests[2]).some((tool) => tool.name === "BrowserPreview")).toBe(true);
      expect(f.rows.filter((row) => row.modelSystem)).toHaveLength(2);
      const restored = fixture(structuredClone(f.rows));
      try {
        await restored.prompt("user-2");
        const replay = restored.requests[0];
        expect(replay.filter((message) => message.role === "system")).toEqual(after.filter((message) => message.role === "system"));
        const resultIndex = replay.findIndex((message) => message.role === "toolResult" && message.toolName === "ToolSearch");
        expect(resultIndex).toBeGreaterThan(0);
        expect(replay.slice(resultIndex + 1)).toContainEqual(after.at(-1));
        expect(getCurrentTools(restored.requests[0]).some((tool) => tool.name === "BrowserPreview")).toBe(true);
        expect(restored.rows.filter((row) => row.modelSystem)).toHaveLength(2);
      } finally { await restored.runtime.dispose(); }
    } finally { await f.runtime.dispose(); }
  });

  it("stops before provider dispatch when the Host cannot save system state", async () => {
    const f = fixture();
    f.failPersistence();
    try {
      await f.prompt("user-1");
      expect(f.requests).toHaveLength(0);
      expect(f.errors).toContainEqual(expect.objectContaining({
        code: "INTERNAL", retriable: false, details: expect.objectContaining({ origin: "local", phase: "request-preparation" }),
      }));
    } finally { await f.runtime.dispose(); }
  });

  it("updates and revokes a skill catalog on the same runtime without rewriting previous requests", async () => {
    const otherSkill = { id: "fixture/other", name: "Unchanged entry", description: "Keep this instruction" };
    const f = fixture([], [skill, otherSkill]);
    try {
      await f.prompt("user-1");
      const before = f.requests[0];
      f.runtime.setPluginSkills([{ ...skill, name: "Updated catalog" }, otherSkill]);
      await f.prompt("user-2");
      const after = f.requests[1];
      expect(after.slice(0, before.length)).toEqual(before);
      expect(getCurrentSystemPrompt(after)).toContain("Updated catalog");
      expect(getCurrentSystemPrompt(after)).not.toContain("First catalog");
      expect(after.filter((message) => message.role === "system")).toHaveLength(2);
      const updates = after.filter((message) => message.role === "system");
      expect(updates.at(-1)?.sections).toEqual({ "skill:fixture/notes": "- `fixture/notes` — Updated catalog: Summarize notes" });
      expect(getCurrentSystemPrompt(after)).toContain("Unchanged entry");
      const restored = fixture(structuredClone(f.rows), [{ ...skill, name: "Updated catalog" }, otherSkill]);
      try {
        await restored.prompt("restored-user");
        expect(restored.requests[0].filter((message) => message.role === "system")).toEqual(updates);
      } finally { await restored.runtime.dispose(); }
      f.runtime.setPluginSkills([]);
      await f.prompt("user-3");
      expect(getCurrentSystemPrompt(f.requests[2])).not.toContain("Updated catalog");
      // Revocation includes a section delta and Pi's executable-tool removal.
      expect(f.rows.filter((row) => row.modelSystem)).toHaveLength(4);
      expect(getCurrentTools(f.requests[2]).some((tool) => tool.name === "Skill")).toBe(false);
    } finally { await f.runtime.dispose(); }
  });
});

/**
 * A Skill body is the largest single result the model can ask for, so the same
 * document must reach the provider's context once, not once per load. These
 * tests read the provider-facing messages the fixture captures, so they assert
 * what the model actually receives rather than what an internal flag records.
 */
describe("Skill documents stay loaded once per model context", () => {
  const marker = "STEP-ONE-FULL-BODY";
  const fullBody = [
    "# Skill: Notes (fixture/notes)",
    "Location: /fixtures/notes/SKILL.md",
    "References are relative to /fixtures/notes.",
    "",
    "# Notes",
    "",
    marker,
  ].join("\n");
  const revision = "STEP-TWO-REVISED-BODY";
  const documents = (): Record<string, FixtureDocument> => ({ "fixture/notes": fullBody });
  const skillCall = (id: string) => ({
    type: "toolCall" as const,
    id,
    name: "Skill",
    arguments: { id: skill.id },
  });
  const loadScript = (first: string, second: string) => [
    () => answer([skillCall(first)], "toolUse"),
    () => answer([{ type: "text", text: "Loaded." }]),
    () => answer([skillCall(second)], "toolUse"),
    () => answer([{ type: "text", text: "Done." }]),
  ];
  const runScript = async (f: ReturnType<typeof fixture>, script: Array<() => AssistantMessage>, ids: string[]) => {
    let step = 0;
    f.respond(() => script[Math.min(step++, script.length - 1)]!());
    for (const id of ids) await f.prompt(id);
  };
  /** The one result for a call id: a restored context already holds earlier ones. */
  const skillResultFor = (request: Message[], toolCallId: string): Message => {
    const message = request.find(
      (entry) => entry.role === "toolResult" && entry.toolCallId === toolCallId,
    );
    if (!message) throw new Error(`no tool result for ${toolCallId}`);
    return message;
  };
  const textOf = (message: Message): string => {
    const content: unknown = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block): block is { type: "text"; text: string } => {
        const candidate = block as { type?: unknown; text?: unknown };
        return candidate.type === "text" && typeof candidate.text === "string";
      })
      .map((block) => block.text)
      .join("\n");
  };
  // Count only what a provider payload would carry: pi keeps `details` beside
  // the content for the transcript, so counting whole messages would also see
  // transcript-only text the model never reads.
  const occurrences = (request: Message[], needle: string) =>
    JSON.stringify(
      request.map((message) => (message as { content?: unknown }).content),
    ).split(needle).length - 1;

  it("serves the body once and reuses it on the next turn", async () => {
    const f = fixture([], [skill], documents());
    try {
      await runScript(f, loadScript("call-1", "call-2"), ["user-1", "user-2"]);
      // Both loads still read the document: suppression happens at the model
      // boundary, so availability never depends on a local cache.
      expect(f.executions).toEqual([skill.id, skill.id]);
      expect(f.requests).toHaveLength(4);
      expect(textOf(skillResultFor(f.requests[3]!, "call-1"))).toBe(fullBody);
      const reused = skillResultFor(f.requests[3]!, "call-2");
      expect(textOf(reused)).toContain("already loaded");
      expect(textOf(reused)).not.toContain(marker);
      expect(occurrences(f.requests[3]!, marker)).toBe(1);
      // The persisted row carries what the model saw, so the expanded Skill row
      // and a restored context agree instead of replaying a body the model
      // never received.
      const row = f.rows.find((entry) => entry.toolCallId === "call-2")!;
      expect(row.toolResult).toMatchObject({
        content: [{ type: "text", text: textOf(reused) }],
      });
      expect(row.isError).toBe(false);
    } finally { await f.runtime.dispose(); }
  });

  it("keeps one body when one assistant message loads the same skill twice", async () => {
    const f = fixture([], [skill], documents());
    try {
      await runScript(f, [
        () => answer([skillCall("call-a"), skillCall("call-b")], "toolUse"),
        () => answer([{ type: "text", text: "Done." }]),
      ], ["user-batch"]);
      expect(textOf(skillResultFor(f.requests[1]!, "call-a"))).toBe(fullBody);
      expect(textOf(skillResultFor(f.requests[1]!, "call-b"))).toContain("already loaded");
      expect(occurrences(f.requests[1]!, marker)).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  it("reuses a restored body and still loads it in a fresh context", async () => {
    const docs = documents();
    const f = fixture([], [skill], docs);
    let restored: ReturnType<typeof fixture> | undefined;
    let fresh: ReturnType<typeof fixture> | undefined;
    try {
      await runScript(f, [
        () => answer([skillCall("call-1")], "toolUse"),
        () => answer([{ type: "text", text: "Loaded." }]),
      ], ["user-1"]);
      // A restarted session replays the complete body, so it must not pay for
      // it again.
      restored = fixture(structuredClone(f.rows), [skill], docs);
      await runScript(restored, [
        () => answer([skillCall("call-2")], "toolUse"),
        () => answer([{ type: "text", text: "Done." }]),
      ], ["user-2"]);
      expect(occurrences(restored.requests[0]!, marker)).toBe(1);
      expect(textOf(skillResultFor(restored.requests[1]!, "call-2"))).toContain("already loaded");
      // An independent agent context never saw the body, so it loads in full.
      fresh = fixture([], [skill], docs);
      await runScript(fresh, [
        () => answer([skillCall("call-fresh")], "toolUse"),
        () => answer([{ type: "text", text: "Done." }]),
      ], ["user-fresh"]);
      expect(textOf(skillResultFor(fresh.requests[1]!, "call-fresh"))).toBe(fullBody);
    } finally {
      await restored?.runtime.dispose();
      await fresh?.runtime.dispose();
      await f.runtime.dispose();
    }
  });

  it("loads the body again when the document changed", async () => {
    const docs = documents();
    const f = fixture([], [skill], docs);
    try {
      let step = 0;
      const script = loadScript("call-1", "call-2");
      f.respond(() => script[Math.min(step++, script.length - 1)]!());
      await f.prompt("user-1");
      docs["fixture/notes"] = fullBody.replace(marker, revision);
      await f.prompt("user-2");
      expect(textOf(skillResultFor(f.requests[3]!, "call-2"))).toBe(
        fullBody.replace(marker, revision),
      );
      // The superseded body stays where the model read it; the revision is the
      // one fresh copy.
      expect(occurrences(f.requests[3]!, marker)).toBe(1);
      expect(occurrences(f.requests[3]!, revision)).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  it("does not treat a failed load as availability", async () => {
    const docs = documents();
    docs["fixture/notes"] = { error: "Skill: unknown skill `fixture/notes`." };
    const f = fixture([], [skill], docs);
    try {
      let step = 0;
      const script = loadScript("call-1", "call-2");
      f.respond(() => script[Math.min(step++, script.length - 1)]!());
      await f.prompt("user-1");
      expect(textOf(skillResultFor(f.requests[1]!, "call-1"))).toContain("unknown skill");
      expect(f.rows.find((entry) => entry.toolCallId === "call-1")!.isError).toBe(true);
      docs["fixture/notes"] = fullBody;
      await f.prompt("user-2");
      expect(textOf(skillResultFor(f.requests[3]!, "call-2"))).toBe(fullBody);
    } finally { await f.runtime.dispose(); }
  });

  it("reloads after compaction drops the body", async () => {
    const rows: UiMessage[] = [
      { id: "u1", role: "user", content: "First ask", createdAt: "2026-09-01T00:00:00Z" },
      { id: "a1", role: "assistant", content: "", createdAt: "2026-09-01T00:00:01Z" },
      {
        id: "t1", role: "tool", content: fullBody, createdAt: "2026-09-01T00:00:02Z",
        toolCallId: "old-call", toolName: "Skill", toolResult: fullBody, toolStatus: "success",
      },
      { id: "u2", role: "user", content: "Continue", createdAt: "2026-09-01T00:00:03Z" },
    ];
    const checkpoint: ContextCompactionRecord = {
      id: "cp-1",
      summary: "Earlier work happened.",
      throughMessageId: "u2",
      tokensBefore: 900,
      retainedTail: [{ role: "user", content: "Continue", timestamp: 4 }],
      createdAt: "2026-09-01T00:00:04Z",
    };
    const f = fixture(rows, [skill], documents(), checkpoint);
    try {
      await runScript(f, [
        () => answer([skillCall("call-1")], "toolUse"),
        () => answer([{ type: "text", text: "Done." }]),
      ], ["user-3"]);
      // The body sits behind the checkpoint boundary: the model cannot read it.
      expect(occurrences(f.requests[0]!, marker)).toBe(0);
      expect(textOf(skillResultFor(f.requests[1]!, "call-1"))).toBe(fullBody);
    } finally { await f.runtime.dispose(); }
  });

  it("suppresses a complete retained window and reloads a truncated one", async () => {
    const windowCheckpoint = (retained: string): ContextCompactionRecord => {
      const assistant = answer([{
        type: "toolCall", id: "kept-call", name: "Skill", arguments: { id: skill.id },
      }], "toolUse");
      return {
        id: "cp-window",
        summary: "Earlier work happened.",
        throughMessageId: "u1",
        tokensBefore: 900,
        retainedTail: [
          assistant,
          {
            role: "toolResult", toolCallId: "kept-call", toolName: "Skill",
            content: [{ type: "text", text: retained }], isError: false,
            timestamp: Date.now() + 11,
          },
          { role: "user", content: "Continue from the window", timestamp: Date.now() + 12 },
        ],
        details: { retainedTailShape: "recent_window" },
        createdAt: "2026-09-01T00:00:04Z",
      };
    };
    const rows: UiMessage[] = [
      { id: "u1", role: "user", content: "First ask", createdAt: "2026-09-01T00:00:00Z" },
    ];
    const complete = fixture(rows, [skill], documents(), windowCheckpoint(fullBody));
    const truncated = fixture(rows, [skill], documents(), windowCheckpoint(fullBody.slice(0, 80)));
    try {
      await runScript(complete, [
        () => answer([skillCall("call-1")], "toolUse"),
        () => answer([{ type: "text", text: "Done." }]),
      ], ["user-2"]);
      expect(occurrences(complete.requests[0]!, marker)).toBe(1);
      expect(textOf(skillResultFor(complete.requests[1]!, "call-1"))).toContain("already loaded");
      await runScript(truncated, [
        () => answer([skillCall("call-1")], "toolUse"),
        () => answer([{ type: "text", text: "Done." }]),
      ], ["user-2"]);
      // A partial body is not availability: the model gets the whole document.
      expect(textOf(skillResultFor(truncated.requests[1]!, "call-1"))).toBe(fullBody);
    } finally {
      await complete.runtime.dispose();
      await truncated.runtime.dispose();
    }
  });

  it("ignores user text and other tools that happen to contain the body", async () => {
    const rows: UiMessage[] = [
      {
        id: "u1", role: "user", content: `Here it is:\n${fullBody}`,
        createdAt: "2026-09-01T00:00:00Z",
      },
      { id: "a1", role: "assistant", content: "", createdAt: "2026-09-01T00:00:01Z" },
      {
        id: "t-read", role: "tool", content: fullBody, createdAt: "2026-09-01T00:00:02Z",
        toolCallId: "read-call", toolName: "Read", toolResult: fullBody, toolStatus: "success",
      },
    ];
    const f = fixture(rows, [skill], documents());
    try {
      await runScript(f, [
        () => answer([skillCall("call-1")], "toolUse"),
        () => answer([{ type: "text", text: "Done." }]),
      ], ["user-2"]);
      expect(textOf(skillResultFor(f.requests[1]!, "call-1"))).toBe(fullBody);
    } finally { await f.runtime.dispose(); }
  });
});
