/**
 * Repeated Skill loads.
 *
 * A skill document is the largest single result the model can ask for, and the
 * catalog already tells it to load each skill once per task — yet a model that
 * loads the same skill on two turns pays for the whole body twice, because
 * every prior turn is still in its context.
 *
 * Suppression is therefore derived from the agent's own context, never from a
 * loaded flag: a fresh successful result is replaced with a short reuse notice
 * only when the identical full document is currently visible there as a
 * successful Skill result. That single rule keeps every other case honest by
 * construction. A new or delegated context has not seen the body, so it loads.
 * A content revision no longer matches, so it loads. A body dropped by
 * compaction, retained only in part, or never successfully delivered is not
 * equal to the fresh text, so it loads. Nothing outlives the context that
 * justified it, so cancellation, reset, and restart cannot leave a stale
 * "already loaded" state behind.
 *
 * Deliberately dependency-light: it reads pi messages and hashes text, so this
 * module can never form a cycle with `runtime.ts`.
 */

import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SKILL_TOOL_NAME } from "./plugin-skills-prompt.js";

/**
 * The text one tool result carries, or undefined when it is not text-only.
 * A result with images is not a skill document, so it can never authorize a
 * suppression.
 */
function textBlocks(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) return undefined;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type !== "text" || typeof candidate.text !== "string") {
      return undefined;
    }
    parts.push(candidate.text);
  }
  return parts.join("\n");
}

/** Document identity: exact full text equality, without storing the text twice. */
export function skillDocumentDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Digests of the skill documents this agent context actually holds in full.
 *
 * Only a successful (`isError !== true`) `Skill` tool result counts. A catalog
 * line, a user message, a summary, or another tool returning the same text
 * never counts, and neither does an error result.
 */
export function loadedSkillDocumentDigests(
  messages: readonly AgentMessage[],
): Set<string> {
  const digests = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    if (message.toolName !== SKILL_TOOL_NAME) continue;
    if (message.isError === true) continue;
    const text = textBlocks((message as { content?: unknown }).content);
    if (text) digests.add(skillDocumentDigest(text));
  }
  return digests;
}

/**
 * The result a repeated load returns instead of the body, or undefined when the
 * caller must receive the document.
 *
 * `fullText` is the result the host just read, so this compares the document
 * the model would receive now against what its context already shows — the
 * formatted header carries the resolved canonical id, which makes two caller
 * ids that resolve to the same document compare equal without inventing any
 * alias the resolver does not support.
 */
export function repeatedSkillNotice(
  messages: readonly AgentMessage[],
  fullText: string,
  requestedId: string,
): string | undefined {
  if (!fullText) return undefined;
  if (!loadedSkillDocumentDigests(messages).has(skillDocumentDigest(fullText))) {
    return undefined;
  }
  const id = requestedId.trim();
  const label = id ? `\`${id}\`` : "The requested skill";
  return (
    `Skill ${label} is already loaded: its complete document appears in an earlier successful ` +
    "Skill result in this context, with identical content. Reuse that text instead of loading it again."
  );
}
