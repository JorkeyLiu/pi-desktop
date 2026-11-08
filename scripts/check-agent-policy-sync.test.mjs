import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_POINTER_BYTES,
  REQUIRED_ANCHORS,
  evaluateAgentPolicy,
  findSyncToken,
} from "./check-agent-policy-sync.mjs";

const POINTER = [
  "# CLAUDE.md",
  "",
  "This file is a pointer: the authoritative agent policy is [`AGENTS.md`](AGENTS.md),",
  "the single source of truth. Read it before any change.",
  "",
].join("\n");

function agentsFixture(overrides = {}) {
  const anchors = REQUIRED_ANCHORS.map((anchor) => anchor.anyOf[0]).join("\n");
  const base = {
    token: "Policy-Sync: 2026-01-01.1",
    pointerRule: "`CLAUDE.md` is a relative symlink to this file. This file is the single source of truth.",
    anchors,
  };
  const parts = { ...base, ...overrides };
  return ["# AGENTS.md", "", parts.token, "", "Mandatory rules.", parts.pointerRule, "", parts.anchors, ""]
    .filter((line) => line !== undefined)
    .join("\n");
}

const link = (target) => ({ kind: "link", target });
const file = (text) => ({ kind: "file", text });

test("accepts a relative symlink to AGENTS.md", () => {
  assert.deepEqual(
    evaluateAgentPolicy({ agentsText: agentsFixture(), claudeEntry: link("AGENTS.md") }),
    [],
  );
  assert.deepEqual(
    evaluateAgentPolicy({ agentsText: agentsFixture(), claudeEntry: link("./AGENTS.md") }),
    [],
  );
});

test("rejects an absolute symlink target", () => {
  const failures = evaluateAgentPolicy({
    agentsText: agentsFixture(),
    claudeEntry: link("/Users/someone/repo/AGENTS.md"),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /must be relative/);
});

test("rejects a symlink that points somewhere other than AGENTS.md", () => {
  const failures = evaluateAgentPolicy({
    agentsText: agentsFixture(),
    claudeEntry: link("docs/AGENTS.md"),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /must point at AGENTS\.md/);
});

test("rejects a missing CLAUDE.md", () => {
  const failures = evaluateAgentPolicy({
    agentsText: agentsFixture(),
    claudeEntry: { kind: "missing" },
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /file is missing/);
});

test("accepts a short pointer file that names AGENTS.md as the single source", () => {
  assert.deepEqual(
    evaluateAgentPolicy({ agentsText: agentsFixture(), claudeEntry: file(POINTER) }),
    [],
  );
});
test("diagnoses a symlink checked out without link support", () => {
  const failures = evaluateAgentPolicy({
    agentsText: agentsFixture(),
    claudeEntry: file("AGENTS.md\n"),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /links are unsupported here/);
});

test("rejects a pointer file carrying its own Policy-Sync token", () => {
  const failures = evaluateAgentPolicy({
    agentsText: agentsFixture(),
    claudeEntry: file(`Policy-Sync: 2026-01-01.1\n\n${POINTER}`),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /must not declare its own `Policy-Sync:` token/);
});

test("rejects a CLAUDE.md that copies the policy text", () => {
  const failures = evaluateAgentPolicy({
    agentsText: agentsFixture(),
    claudeEntry: file(agentsFixture()),
  });
  assert.ok(failures.some((failure) => /exceeds the .* pointer limit/.test(failure)));
});

test("rejects a pointer file that copies a shared non-negotiable anchor", () => {
  const copied = `${POINTER}\nSQLite is owned exclusively by Rust host-core.\n`;
  assert.ok(Buffer.byteLength(copied, "utf8") <= MAX_POINTER_BYTES);
  const failures = evaluateAgentPolicy({ agentsText: agentsFixture(), claudeEntry: file(copied) });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /copies policy anchor `sqlite-host-core-only`/);
});

test("rejects an AGENTS.md without a Policy-Sync token", () => {
  const failures = evaluateAgentPolicy({
    agentsText: agentsFixture({ token: "No revision here." }),
    claudeEntry: link("AGENTS.md"),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /missing `Policy-Sync: <token>`/);
});

test("rejects an AGENTS.md that does not name CLAUDE.md", () => {
  const failures = evaluateAgentPolicy({
    agentsText: agentsFixture({ pointerRule: "This file is the single source of truth." }),
    claudeEntry: link("AGENTS.md"),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /must name CLAUDE\.md/);
});

test("rejects an AGENTS.md missing a shared anchor", () => {
  const anchors = REQUIRED_ANCHORS.slice(1)
    .map((anchor) => anchor.anyOf[0])
    .join("\n");
  const failures = evaluateAgentPolicy({
    agentsText: agentsFixture({ anchors }),
    claudeEntry: link("AGENTS.md"),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /policy anchor `process-model`: missing from AGENTS\.md/);
});

test("reports a missing AGENTS.md on its own", () => {
  assert.deepEqual(evaluateAgentPolicy({ agentsText: null, claudeEntry: link("AGENTS.md") }), [
    "AGENTS.md: file is missing",
  ]);
});

test("reads the revision token once, from AGENTS.md", () => {
  assert.equal(findSyncToken("Policy-Sync: 2026-10-18.3\n"), "2026-10-18.3");
  assert.equal(findSyncToken("Policy-Sync: `2026-10-18.3`\n"), "2026-10-18.3");
  assert.equal(findSyncToken("Policy-Sync: 2026-10-18.3 and Policy-Sync: 2026-10-19.1"), "2026-10-18.3");
  assert.equal(findSyncToken("no token"), undefined);
});
