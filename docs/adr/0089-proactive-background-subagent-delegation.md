# ADR 0089: Proactive Background Subagent Delegation

- Status: Accepted for implementation (resumable delegations amended by
  ADR 0279)
- Date: 2026-08-16
- Deciders: PI-Desktop core
- Related: D201, D202, ADR 0062, ADR 0063, ADR 0048, ADR 0100, ADR 0279, E2E-142
- Amendment (2026-10, subagent controls): the turn-end abort rule in §1 and the
  matching Consequences / Alternatives passages below are superseded by the
  parent-judged lifetime (D328 / ADR 0166, fatal-error path ADR 0189) and the
  program-owned coordinator (`AppSettings.subagentWakeup` in
  `03-runtime/02-agent-runtime.md` §5f). Running delegates are no longer aborted when
  the parent stops calling tools: the runtime keeps the durable turn open, the program
  coordinator carries the single user-selected cadence into `TaskWait`, `TaskList`, and
  the idle resume, and only `TaskStop` (cancel obsolete work), user Stop,
  disposal, or a terminal parent error ends them. The model carries no timing:
  `Task` / `TaskWait` / `TaskList` accept no `timeoutSeconds` or per-call wake override
  (legacy args ignored safely). Original wording is preserved and annotated in place.

## Context

ADR 0062 shipped delegation as context economy: `Task` runs one delegate to
completion and returns its report, and the tool description tells the model to
delegate only when a wide search or long survey would otherwise fill the parent
context. In practice the main agent almost never delegates:

- The system prompt says nothing about delegation, so the model only ever sees
  the tool's defensive description ("do not delegate what you can finish in a
  couple of tool calls") with no positive trigger patterns to act on.
- `Task` blocks the parent's tool loop until the delegate finishes, so from
  the model's perspective delegation trades one long job for another; there is
  no way to keep working while a delegate runs.
- All builtin delegates are read-only report machines, so there is nothing to
  delegate implementation work to, and a write-capable delegate would hit the
  session's permission prompts for every file it touches.
- The concurrency cap (4) and the fire-and-forget contract leave no room for
  orchestration patterns like "review my change before I commit" or "explore
  three directions in parallel, then converge".

## Decision

Make delegation a first-class, proactive orchestration capability while
keeping every containment boundary ADR 0062 established.

### 1. The delegate lifecycle is non-blocking and tool-driven

`Task` starts a delegate in the background and returns immediately with a
`delegationId`. Three new Agent-mode tools drive the lifecycle, all in the core
tool set beside `Task`:

- `TaskWait(delegationIds?, mode?, minCompleted?)` converges (result-dependency
  selector only — no `timeoutSeconds`; superseded 2026-10: the model carries no timing,
  the program coordinator owns the single cadence)
  on running delegations (all by default) and returns their reports;
  `mode: "any"` + `minCompleted` converges as soon as the first N finish, and
  settled delegations return immediately so reports can be re-read by id.
- `TaskList()` reports the session's delegations with status.
- `TaskStop(delegationIds?)` stops running delegations; stopped reads as
  `stopped`.

The session runtime owns a delegation registry (id, agent, status, timings,
result, completion promise, abort handle). Settled records are retained for the
session (capped at 100) so `TaskWait` can re-read a report without re-running
the delegate. ~~Running delegates are aborted when the run ends (`agent_end`),
when the parent aborts, or when the runtime is disposed; the system prompt
instructs the model to converge or stop before ending a turn.~~ (Superseded
2026-10 by D328 / ADR 0166: parent idle keeps the durable turn open and does
not abort running delegates; only `TaskStop`, user Stop, disposal, or a
terminal parent error — ADR 0189 — ends them. The idle resume delivers reports
and honors the session's configured progress wake.)

### 2. The system prompt names positive trigger patterns

The base prompt gains a `## Delegation` section (only when the catalog is
non-empty) listing concrete situations: parallel exploration of independent
directions, adversarial review before commit, multi-file implementation via
`fixer`, context-economy searches, and batch sharding — plus the convergence
rules (continue working after `Task`, fill `description` for the user, never
end the turn with running delegates). The `Task` description is rewritten to
lead with these triggers and keep the old "do not" list as a single boundary
line.

### 3. New builtins: a faster `explorer` and a write-capable `fixer`

`explorer` is rewritten in the style of the omo-slim explorer prompts: tool
selection guidance (Grep for patterns, Glob for discovery, Read for files),
parallel searches, and a structured `<files>` / `<answer>` report shape.

A fourth builtin, `fixer`, implements multi-file changes from a complete spec:
`tools: [Read, Glob, Grep, Edit, Write, Bash]`, `maxTurns: 40`, with a
`<summary>` / `<changes>` / `<verification>` report shape. It is the only
write-capable builtin; the other three stay read-only.

### 4. Definitions may declare a permission scope

Frontmatter gains `permission: inherit | ask | accept-edits | auto` (default
`inherit`). A definition with an explicit non-`inherit` scope causes the
sidecar to attach that scope to the delegate's `tools.execute` calls, and
host-core resolves each call under that mode instead of the session's effective
permission mode. An omitted or `inherit` scope carries no override, so the
call uses the parent session's effective mode. The override is a permission-mode
override only: the contract modes' hard deny and the external-path gate stay in
force, so `accept-edits` auto-allows `Write`/`Edit` inside the workspace and
scratch roots while Bash and external paths keep the session's behavior. The
builtin `fixer` uses the default `inherit` scope; explicit scopes remain
available to eligible builtin and user definitions.

### 5. Concurrency

`MAX_SUBAGENT_CONCURRENCY` becomes a per-session running cap of 10 (was a
per-batch cap of 4). `Task` fails with a tool error when the session already
runs 10 delegates, telling the model to wait or stop first.

## Consequences

- Delegation stops being "a long tool call" and becomes background
  orchestration: the parent can implement while `explorer` searches and
  `code-reviewer` reviews, then converge with `TaskWait`.
- Models receive positive trigger patterns in the system prompt and a full
  lifecycle vocabulary, which is what makes delegation proactive rather than
  permitted-but-unused.
- A write-capable delegate is bounded by its definition's `permission` scope,
  not by the session's prompts; host-core stays the authority and the external
  path gate is untouched.
- Old transcripts keep rendering: `Task` rows keep their delegation grouping,
  and the new tools map to the same delegate presentation.
- ~~A delegate that outlives its turn is stopped, not left running; the prompt
  rule plus the turn-end abort make that the exception rather than the policy.~~
  (Superseded 2026-10: a delegate that outlives the parent's tool calls keeps
  running under the parent-judged lifetime; the runtime keeps the durable turn
  open and delivers its report.)

## Alternatives considered

- **Background tasks across turns (Proma-style).** Delegates that keep running
  after the parent turn ends, with the UI showing pending background work,
  would maximize parallelism but requires reworking Electron main's turn
  lifecycle, completion semantics and the renderer's session-idle handling.
  Within-turn background delegation delivers the parent-continues-its-mainline
  behavior the pattern exists for, with the existing turn model unchanged.
  (Note 2026-10: D328 / ADR 0166 has since kept the durable turn open across
  parent idle with idle-resume delivery, narrowing but not removing this gap —
  there is still no cross-turn background work after the durable turn itself
  settles.)
- **Let delegates inherit the session permission mode.** Rejected: a delegate
  that needs `auto` would silently re-enable prompting or force the whole
  session to `auto`; the per-definition scope keeps the relaxation explicit and
  reviewable in the definition document.
- **Keep `Task` blocking and add a `wait` flag.** Rejected: a flag the model
  must remember to set is a flag it forgets; a lifecycle with distinct tools
  makes "start, work, converge" a sequence the model can follow and the prompt
  can teach.
