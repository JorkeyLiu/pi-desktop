import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { loadedSkillDocumentDigests, repeatedSkillNotice } from "./skill-context.js";

const body = [
  "# Skill: Notes (fixture/notes)",
  "Location: /fixtures/notes/SKILL.md",
  "References are relative to /fixtures/notes.",
  "",
  "# Notes",
  "",
  "STEP-ONE-FULL-BODY",
].join("\n");

function textResult(
  text: string,
  extra: { toolName?: string; isError?: boolean; toolCallId?: string } = {},
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: extra.toolCallId ?? "call-1",
    toolName: extra.toolName ?? "Skill",
    content: [{ type: "text", text }],
    isError: extra.isError ?? false,
    timestamp: 1,
  } as AgentMessage;
}
describe("repeatedSkillNotice", () => {
  it("returns the body when the context has never carried it", () => {
    expect(repeatedSkillNotice([], body, "fixture/notes")).toBeUndefined();
  });

  it("suppresses an identical document that is fully visible", () => {
    const notice = repeatedSkillNotice([textResult(body)], body, "fixture/notes");
    expect(notice).toBeDefined();
    expect(notice).toContain("already loaded");
    expect(notice).toContain("fixture/notes");
    expect(notice).not.toContain("STEP-ONE-FULL-BODY");
  });

  it("reloads a partially retained document", () => {
    expect(
      repeatedSkillNotice([textResult(body.slice(0, 80))], body, "fixture/notes"),
    ).toBeUndefined();
  });

  it("does not treat a failed Skill result as availability", () => {
    expect(
      repeatedSkillNotice(
        [textResult(body, { isError: true })],
        body,
        "fixture/notes",
      ),
    ).toBeUndefined();
  });

  it("counts only Skill tool results", () => {
    const lookalikes: AgentMessage[] = [
      { role: "user", content: body, timestamp: 1 } as AgentMessage,
      { role: "system", content: body, timestamp: 1 } as AgentMessage,
      textResult(body, { toolName: "Read" }),
      textResult(body, { toolName: "Grep" }),
    ];
    expect(repeatedSkillNotice(lookalikes, body, "fixture/notes")).toBeUndefined();
    expect(loadedSkillDocumentDigests(lookalikes).size).toBe(0);
  });

  it("ignores a document result that also carries an image", () => {
    const withImage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Skill",
      content: [
        { type: "text", text: body },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 1,
    } as AgentMessage;
    expect(repeatedSkillNotice([withImage], body, "fixture/notes")).toBeUndefined();
  });

  it("treats a revised document as a different document", () => {
    const revised = body.replace("STEP-ONE-FULL-BODY", "STEP-TWO-REVISED-BODY");
    expect(repeatedSkillNotice([textResult(body)], revised, "fixture/notes")).toBeUndefined();
  });

  it("counts a result split across text blocks by its rendered text", () => {
    const split = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Skill",
      content: [
        { type: "text", text: "# Skill: Notes (fixture/notes)" },
        { type: "text", text: body.slice("# Skill: Notes (fixture/notes)\n".length) },
      ],
      isError: false,
      timestamp: 1,
    } as AgentMessage;
    expect(repeatedSkillNotice([split], body, "fixture/notes")).toBeDefined();
  });
});
