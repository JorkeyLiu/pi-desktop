#!/usr/bin/env node
/**
 * Agent policy single-source check.
 *
 * `AGENTS.md` is the one authoritative AI-agent policy. `CLAUDE.md` exists only
 * as a Claude Code / Cowork compatibility entry: it must resolve to
 * `AGENTS.md` instead of carrying a second copy of the rules.
 *
 * Usage:
 *   node scripts/check-agent-policy-sync.mjs
 *   pnpm check:agent-policy
 *
 * Enforced:
 *   1. AGENTS.md exists and declares a `Policy-Sync: <token>` revision.
 *   2. CLAUDE.md is a relative symlink to AGENTS.md. A checkout that cannot
 *      hold symlinks may carry a short English pointer file instead; it must
 *      name AGENTS.md as the single source, carry no `Policy-Sync:` token, and
 *      copy no rules.
 *   3. CLAUDE.md never duplicates the policy text or a second revision token.
 *   4. Every shared non-negotiable anchor appears in AGENTS.md.
 *
 * When policy changes: edit AGENTS.md only, bump its `Policy-Sync:` token, and
 * run `pnpm check:agent-policy`. Never copy rules into CLAUDE.md.
 */
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const AGENTS_PATH = path.join(root, "AGENTS.md");
const CLAUDE_PATH = path.join(root, "CLAUDE.md");

const normalize = (text) =>
  text
    .replace(/[→↓]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const SYNC_TOKEN = /policy-sync:\s*`?([^\s`]+)`?/i;

/**
 * Longest accepted pointer file. A pointer names the canonical policy file and
 * nothing else, so any real rule text exceeds this.
 */
export const MAX_POINTER_BYTES = 512;

/**
 * Shared non-negotiables. Each anchor is a distinctive phrase (or alternate
 * phrases) that must stay true in the authoritative policy file. Prefer stable
 * wording over section titles.
 */
/** @type {{ id: string, anyOf: string[] }[]} */
export const REQUIRED_ANCHORS = [
  {
    id: "process-model",
    anyOf: [
      "renderer preload ipc electron main rust host core / node agent runtime",
    ],
  },
  {
    id: "sqlite-host-core-only",
    anyOf: [
      "sqlite remains owned exclusively by rust host-core",
      "sqlite is owned exclusively by rust host-core",
      "sqlite remains owned exclusively by rust `host-core`",
      "sqlite is owned exclusively by rust `host-core`",
    ],
  },
  {
    id: "main-thin-orchestrator",
    anyOf: ["electron main must remain a thin orchestrator", "electron main stays a thin orchestrator"],
  },
  {
    id: "preserve-unrelated-work",
    anyOf: [
      "preserve changes from the user and other agents",
      "preserve unrelated work",
    ],
  },
  {
    id: "host-e2e-environment",
    anyOf: [
      "do not run `pnpm install`, `npm install`, or create a second dependency or runtime environment solely to execute e2e",
      "never run `pnpm install` or `npm install`, or create a second dependency or runtime environment, solely for e2e",
    ],
  },
  {
    id: "code-bearing-e2e",
    anyOf: ["every code-bearing change must run the relevant e2e suites"],
  },
  {
    id: "architecture-ratchet-hotspots",
    anyOf: [
      "apps/desktop/src/stores/app-store.ts",
      "crates/host-core/src/db.rs",
    ],
  },
  {
    id: "preserve-behavior-default",
    anyOf: [
      "unless the task explicitly requires",
      "unless the task explicitly requires behavior to change",
    ],
  },
  {
    id: "never-weaken-security",
    anyOf: [
      "never fix functionality by weakening",
      "never “fix” a feature by weakening",
      'never "fix" a feature by weakening',
      "never fix a feature by weakening",
    ],
  },
  {
    id: "adr-for-frozen-boundaries",
    anyOf: [
      "changing a frozen architecture, public interface, data ownership model, or security boundary requires an adr",
      "requires an adr under `docs/adr/`",
    ],
  },
  {
    id: "specs-stay-synchronized",
    anyOf: ["observable behavior changes must update the relevant spec"],
  },
  {
    id: "pr-root-cause-minimal",
    anyOf: [
      "must fix the reported root cause with the smallest coherent change",
    ],
  },
];

/** @param {string} text */
export function findSyncToken(text) {
  return text.match(SYNC_TOKEN)?.[1];
}

const isAbsoluteTarget = (target) =>
  path.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target);

const normalizeLinkTarget = (target) =>
  target.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/**
 * Pure policy evaluation over the canonical file and the recorded CLAUDE.md
 * entry. Filesystem resolution (does the link actually land on AGENTS.md) is
 * checked by the caller, which has the paths.
 *
 * @param {object} input
 * @param {string | null} input.agentsText
 * @param {{ kind: "missing" } | { kind: "link", target: string } | { kind: "file", text: string }} input.claudeEntry
 * @returns {string[]} failures
 */
export function evaluateAgentPolicy({ agentsText, claudeEntry }) {
  const failures = [];

  if (agentsText === null || agentsText === undefined) {
    failures.push("AGENTS.md: file is missing");
    return failures;
  }

  const agents = normalize(agentsText);

  if (!findSyncToken(agentsText)) {
    failures.push(
      "AGENTS.md: missing `Policy-Sync: <token>` (for example `Policy-Sync: 2026-02-14.1`)",
    );
  }
  if (!agents.includes("claude.md")) {
    failures.push("AGENTS.md: must name CLAUDE.md as the Claude Code compatibility entry");
  }
  if (!agents.includes("single source of truth") && !agents.includes("single source")) {
    failures.push("AGENTS.md: must state that it is the single source of truth for agent policy");
  }

  for (const anchor of REQUIRED_ANCHORS) {
    const present = anchor.anyOf.some((phrase) => agents.includes(normalize(phrase)));
    if (!present) {
      failures.push(
        `policy anchor \`${anchor.id}\`: missing from AGENTS.md (looked for: ${anchor.anyOf
          .map((p) => `"${p}"`)
          .join(" | ")})`,
      );
    }
  }

  if (claudeEntry.kind === "missing") {
    failures.push(
      "CLAUDE.md: file is missing; add the compatibility link with `ln -sfn AGENTS.md CLAUDE.md`",
    );
    return failures;
  }

  if (claudeEntry.kind === "link") {
    if (isAbsoluteTarget(claudeEntry.target)) {
      failures.push(
        `CLAUDE.md: symlink target \`${claudeEntry.target}\` must be relative so every checkout resolves it`,
      );
    } else if (normalizeLinkTarget(claudeEntry.target) !== "agents.md") {
      failures.push(
        `CLAUDE.md: symlink must point at AGENTS.md, found \`${claudeEntry.target}\``,
      );
    }
    return failures;
  }

  // A symlink checked out on a filesystem without link support becomes a file
  // whose whole content is the raw link target. Diagnose that instead of
  // reporting a missing cross-reference.
  const text = claudeEntry.text;
  const bytes = Buffer.byteLength(text, "utf8");
  if (!text.trim()) {
    failures.push(
      "CLAUDE.md: empty pointer file; link it instead with `ln -sfn AGENTS.md CLAUDE.md`",
    );
    return failures;
  }
  if (!text.trim().includes("\n") && normalizeLinkTarget(text.trim()) === "agents.md") {
    failures.push(
      "CLAUDE.md: this checkout wrote the symlink target as file content, so links are unsupported here; enable `git config core.symlinks true` or check out on a platform that supports symlinks",
    );
    return failures;
  }
  if (findSyncToken(text)) {
    failures.push(
      "CLAUDE.md: must not declare its own `Policy-Sync:` token; AGENTS.md is the single source of the policy revision",
    );
  }
  if (bytes > MAX_POINTER_BYTES) {
    failures.push(
      `CLAUDE.md: ${bytes} bytes exceeds the ${MAX_POINTER_BYTES}-byte pointer limit; CLAUDE.md must not copy the policy — link it instead with \`ln -sfn AGENTS.md CLAUDE.md\``,
    );
  }
  const claude = normalize(text);
  if (!claude.includes("agents.md")) {
    failures.push("CLAUDE.md: must name AGENTS.md as the file it points at");
  }
  if (!claude.includes("single source") && !claude.includes("authoritative")) {
    failures.push("CLAUDE.md: must state that AGENTS.md is the authoritative single source");
  }
  for (const anchor of REQUIRED_ANCHORS) {
    if (anchor.anyOf.some((phrase) => claude.includes(normalize(phrase)))) {
      failures.push(
        `CLAUDE.md: copies policy anchor \`${anchor.id}\`; replace the copied rules with a pointer to AGENTS.md`,
      );
    }
  }

  return failures;
}

function readAgentsText() {
  try {
    return readFileSync(AGENTS_PATH, "utf8");
  } catch {
    return null;
  }
}

/** @returns {{ kind: "missing" } | { kind: "link", target: string } | { kind: "file", text: string }} */
function readClaudeEntry() {
  try {
    const info = lstatSync(CLAUDE_PATH);
    if (info.isSymbolicLink()) {
      return { kind: "link", target: readlinkSync(CLAUDE_PATH) };
    }
    if (info.isFile()) {
      return { kind: "file", text: readFileSync(CLAUDE_PATH, "utf8") };
    }
    return { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }
}

function main() {
  const agentsText = readAgentsText();
  const claudeEntry = readClaudeEntry();
  const failures = evaluateAgentPolicy({ agentsText, claudeEntry });

  if (claudeEntry.kind === "link" && agentsText !== null) {
    try {
      const resolved = realpathSync(CLAUDE_PATH);
      if (resolved !== realpathSync(AGENTS_PATH)) {
        failures.push("CLAUDE.md: symlink resolves to a different file than AGENTS.md");
      }
    } catch {
      failures.push("CLAUDE.md: symlink target does not exist in this checkout");
    }
  }

  if (failures.length > 0) {
    console.error("Agent policy check failed:\n");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      "\nAGENTS.md is the single policy file. Edit it, bump `Policy-Sync`, keep CLAUDE.md",
    );
    console.error("a relative symlink to it (`ln -sfn AGENTS.md CLAUDE.md`), then re-run:");
    console.error("  pnpm check:agent-policy");
    process.exit(1);
  }

  console.log("Agent policy check passed (AGENTS.md is the single source; CLAUDE.md → AGENTS.md).");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
