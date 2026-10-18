# ADR 0279: Resumable subagent delegations

- Status: Accepted for implementation
- Date: 2026-09-17
- Deciders: PI-Desktop core
- Related: [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  [ADR 0089](0089-proactive-background-subagent-delegation.md) ·
  [ADR 0119](0119-event-driven-subagent-timeouts.md) ·
  [ADR 0165](0165-withdraw-a2a-peer-stack.md) ·
  [03-runtime/02-agent-runtime.md](../spec/03-runtime/02-agent-runtime.md) §5f
- Amends: ADR 0062 (the `Task` tool contract) and ADR 0089 (the delegation
  lifecycle). Both are preserved — every existing boundary still holds; this
  adds one opt-in parameter and one piece of bookkeeping.
- Tracking: #513
- Amendment (2026-10, subagent controls): `interrupted` (app closed mid-run) is
  now resumable from retained chain history; `stopped` / `aborted` stay
  non-resumable. The §4 `interrupted` row and the §5 "Only `completed` and
  `failed` are resumable" heading below are superseded to that extent — their
  original wording is preserved and annotated in place.
- Amendment (2026-10, chain continuability): the settling outcome is no longer
  a permanent property of a chain. `stopped` / `aborted` (and the retired
  `timed_out`) join `completed` / `failed` / `interrupted`: **every
  instantiated settled chain may be explicitly continued**, whatever outcome its
  last run recorded, its next run seeded from the rows that remain or the
  original task brief alone. Stop still cancels the
  running execution and retires that run's waiting and delivery, but it no
  longer bars the chain. The §4 status row, the §5 heading and body, the §7
  least-recently-used eviction, the §8 read-budget admission stop, and the
  "Out of scope" revive exclusion below are superseded to that extent — their
  original wording is preserved and annotated in place, and §15 states the
  current contract. A `Task` call denied before it ever spawned a delegate
  instance creates no chain and is not continuable.

## Context

Delegation as built by ADR 0062 and ADR 0089 spawns one `SubagentRun` per `Task`
call. Each run starts with `messages: []` (`packages/agent-runtime/src/subagent.ts`)
and is single-use. A delegate's transcript rows are persisted — they carry
`parentToolCallId` and `agentName` and land in the session transcript — but
nothing ever reads them back into a delegate, and the session runtime skips them
when it rebuilds model context (`runtime.ts`, `if (m.parentToolCallId) continue;`).

That makes every `Task` call a cold start even when the parent delegates the
same subagent for the same files twice. The context the first run bought —
which files it read, what it found, what it already changed — is discarded, and
the second run pays for it again, or worse, works from a stale file version it
never re-reads.

The pieces to do better are already in place: the rows are persisted with
enough fidelity for a full rebuild (tool call/result pairs, thinking blocks, and
the original `Task` arguments on the tool row), and the session runtime already
contains a `UiMessage[] → AgentMessage[]` converter that produces well-formed
provider messages including synthesized carriers for orphan tool rows.

## Decision

Add an opt-in `resume` parameter to the `Task` tool. When present, the new
delegation is seeded with the prior delegation's reconstructed context instead
of starting empty.

### 1. `Task` gains `resume?: delegationId`

Resolution is by `delegationId` only — the id the `Task` result already returns
and `TaskWait` already accepts. A second, stable internal key
(`delegateSessionId`) exists solely to chain the runs; it never appears in a
tool parameter, tool result, or prompt. The runtime keeps a reverse map from
every `delegationId` issued on a live chain to that chain, so an id from the
middle of a chain resolves too.

### 2. Chains, not records, are the unit of resumability

A **chain** is one `delegateSessionId` plus the ordered `Task` toolCallIds that
belong to it. Each `resume` appends the new toolCallId. Child transcript rows
are keyed by `parentToolCallId`, so reconstructing a chain's context means
selecting every row whose `parentToolCallId` is in the chain and whose
`agentName` matches.

`DelegationRecord` gains `delegateSessionId`, plus `resumedFrom` and
`modelChangedFrom` on a run that continues a chain. Read tracking lives on the
chain, not the record: the registry keeps one entry per `delegateSessionId` and a
secondary index from every `delegationId` on that chain to it.

### 3. Context reconstruction is a pure function

A new module (`packages/agent-runtime/src/delegation-history.ts`) owns:

- selecting the chain's rows from the session transcript,
- synthesizing the original `task` as the first user message from the first
  `Task` tool row's persisted arguments,
- converting to `AgentMessage[]` with the delegate's own provider/model binding
  (a pinned delegation model is not the session model). Assistant transport
  identity is `model.provider` / `model.id` — the same values live requests
  use — not the account row id. When `vendorKey` is set, `model.provider`
  differs from `provider.id`; tagging restored history with the account id
  makes pi-ai treat same-model reasoning as foreign and empty
  `reasoning_content` on resume,
- a read-file / line-count budget gate.

`SubagentRun` gains `initialMessages?: AgentMessage[]`; when present it seeds
`initialState.messages` instead of `[]`. The run is otherwise a completely
normal run: it occupies a `MAX_SUBAGENT_CONCURRENCY` slot, inherits the
definition's permission scope, and settles through the existing
`settleDelegation` path with its own `delegationId`, report, and counters.

### 4. Validation is visible, never thrown

`resume` is validated before the run starts; every failure is a tool error the
model can act on:

| Condition | Error |
|---|---|
| unknown or evicted id | `Unknown delegation "<id>"` plus the current resumable list |
| still running | `Delegation <id> is still running`, call TaskWait first — a resume is never queued |
| `stopped` / `aborted` | ~~not resumable; a future revive path (out of scope here)~~ — superseded 2026-10 (chain continuability, §15): continuable like every other outcome; the new run is seeded from the rows that remain, or from the original task brief alone when none do. Stop retired that run, not the chain |
| `interrupted` (the app closed mid-run) | ~~not resumable; start a new delegation~~ — superseded 2026-10: continuable like `completed` / `failed`, seeded from the rows that remain or the original brief |
| `Task.agent` differs from the chain's agent | name mismatch, lists available |
| `Task.model` present on a resume | not allowed on a resumed run — start a new delegation to change models |
| chain exceeds the read budget | ~~`Delegation <id> has read too much to resume cheaply`~~ — superseded 2026-10 (§15): no read-admission stop; the seed is truncated to the delegate's context budget |
| the chain resolves but has no rows left to replay | ~~the chain is dropped and reported as having no recorded history; the same id is never listed as reusable~~ — superseded 2026-10 (§15): the chain still continues, seeded with the original task brief plus the new input; only a chain whose own `Task` rows are gone cannot be rebuilt at all and resolves as an unknown id |

No new error codes for "evicted" versus "never existed": both resolve to the
same unknown-id error, because the model's only correct action is identical.

A resume keeps the chain's own model binding. The `providerId/modelId` key the
chain recorded is preferred; a chain rebuilt from the transcript only knows the
model id, which is matched only against the current definition's pin/fallbacks,
the session binding, and currently authorized overrides. A remembered key whose
turn grant expired is reauthorized before use; a denied key cannot select another
account by model id. Other definitions' private pins are never candidates (#841). Changing the
parent's own session model therefore does not strand a chain, and a delegate never
swaps models by accident. If nothing resolves the recorded binding any more, the
run continues on the binding the definition resolves to now and records the
previous model id in the delegation's lifecycle details as `modelChangedFrom`:
refusing instead would strand the chain forever, and swapping silently would hand
the same conversation to a different model with no trace.

### 5. ~~Only `completed`, `failed`, `timed_out`, and `interrupted` are resumable~~ — every instantiated settled chain is continuable

> Amendment 2026-10: the original heading read "Only `completed` and `failed`
> are resumable" with `interrupted` excluded. `interrupted` (the app closed
> while the run still worked) is now resumable — resuming continues the chain,
> seeded from the rows that remain or, when none do, from its original brief.
> Only a chain whose own `Task` rows are gone cannot be rebuilt and resolves as
> an unknown id. ~~`stopped` and `aborted` still encode an explicit
> Stop or runtime disposal and stay non-resumable.~~ Amendment 2026-10 (chain
> continuability, §15): `stopped` and `aborted` are continuable too; the
> outcome of a run never permanently bars its chain. The paragraphs below are
> preserved; read the status exclusions as superseded by §15.

A `failed` run's reads and findings still have value; its failed assistant row
is dropped by the converter like any other error row. ~~`stopped` and `aborted`
encode an explicit Stop or runtime disposal, and resuming it would contradict
the cancellation.~~ (Superseded 2026-10, §15: a Stop or disposal cancels that
run's execution and retires its waiting/delivery, but the chain is still
continuable; the next run is a new execution, not a contradiction of the old
cancellation — the settled outcome stays historical.) A terminal parent error still cancels active execution, but
its interrupted delegates settle as `failed` with `SUBAGENT_PARENT_FAILED`
instead: this system interruption preserves manual resume eligibility (#680).
`interrupted` (the app closed while the
run still worked) means the same thing for this purpose: the delegate never
settled, so there is nothing trustworthy to continue. (`timed_out` is a vestigial
status — ADR 0119's timeouts were withdrawn by D328 — and is treated as `failed`
for this purpose.)

### 6. One live record per chain, ever

There is no queuing and no message-append. A chain has at most one running
record at a time; a `resume` while the chain is running is rejected with the
TaskWait error above. This keeps the chain a strict straight line with no
forking successors.

### 7. ~~Resumable chains are bounded, LRU, per agent name~~ — the per-agent bound limits the listing, not retention

> Amendment 2026-10 (chain continuability, §15): the eviction described below
> is removed. `MAX_RESUMABLE_CHAINS_PER_AGENT = 2` now caps only how many of an
> agent's chains the parent's prompt listing shows (most recently active
> first); it never evicts, and every instantiated chain stays resolvable and
> continuable by id for the life of the session. Evicting a chain would lose a
> continuation the user is entitled to, so retention is bounded by the session
> transcript that already carries every `Task` row, not by this listing cap.
> The original wording is preserved and annotated in place.

~~`MAX_RESUMABLE_CHAINS_PER_AGENT = 2`. Chains are exempt from the existing
`pruneFinishedDelegations` oldest-first sweep. Exceeding the bound evicts the
least-recently-used whole chain when a delegation settles — registry entry and
every reverse-map entry together. A chain whose latest run is still working is
never evicted: dropping it would strand the delegate writing into it, so the
bound counts reusable chains and a live chain may momentarily push the group over
it.~~ Chains stay exempt from `pruneFinishedDelegations`. A chain whose latest
run is still working is never listed. No chain is dropped for age or count:
`delegationId` is a random UUID, so a stale id never collides with a future one,
and an unknown id means the chain was never created or its own `Task` rows are
gone from the transcript, never that it aged out of a cache.

### 8. ~~Read budget gates chain growth~~ — read volume is bounded at the seed, not admitted at the list

> Amendment 2026-10 (chain continuability, §15): the admission stop described
> below is removed. `MAX_RESUMABLE_READ_LINES` no longer removes a chain from
> the resumable list. Request safety is preserved by the existing model-context
> seed truncation instead: a resume seeds the new run through
> `seedDelegateMessages` under the delegate's context budget (ADR 0299 §7), so a
> large chain never produces an oversized first request — the seed keeps the
> original task brief and the recent turns and drops the oldest tool results
> first. Read metadata (the files a chain read) still displays in the listing
> and lifecycle details. The original wording is preserved and annotated in
> place.

~~A delegate has no compaction of its own, so an unbounded chain would eventually
overflow its own context window. Rather than trimming inside the chain, a chain
whose cumulative read volume exceeds `MAX_RESUMABLE_READ_LINES` (50,000) silently
leaves the resumable list — the next delegation for that work is a cold start,
which still works. The gate is checked when the resumable list is built, so it
costs nothing at delegation time.~~ Every instantiated chain stays continuable;
read volume only decides how much history can be replayed before the budget
truncation applies, never whether the chain is offered at all.

Reads are counted from the delegate's read-only tool rows (`Read`, `Glob`,
`Grep`, `BrowserPreview`), accumulated per chain; write-tool targets are not
counted and not listed.

### 9. The parent sees a resumable list in its system prompt

Each prompt composes the current resumable chains into the parent's system
prompt: agent name, delegation id, the one-line objective, and the files the
chain has read (capped at 8, truncated). Only settled, in-budget chains appear —
a running chain is never listed, so the parent is not lured into resuming one.

The `resume` parameter's own schema description carries the rule that reuse
requires the id; prose alone does not resume anything.

### 10. Same session only

`resume` resolves only against the current session's transcript. There is no
cross-session addressing; sharing facts between conversations stays in the
prompt, as ADR 0165 concluded when it withdrew the peer stack.

### 11. Definition edits take effect on resume, with a diagnostic

A definition edited between two delegations is applied as-is on resume — the
same "editing takes effect on the next prompt" semantics the catalog already
has — and the change is recorded in the delegation's lifecycle details. No
definition snapshot is stored; snapshots would need new persistent state and
would contradict the existing semantics.

### 12. Chain index is rebuilt from the transcript on startup

The chain registry is in memory, but the chain relationship is recoverable:
`Task` tool rows are persisted with their arguments, including `resume`. At
session launch the runtime scans the transcript's `Task` rows, groups them by
their `resume` links into chains, and rehydrates the secondary index. Restart
does not lose resumability.

Two details make a rebuilt chain behave like a live one. Agent names are
normalized on rebuild (`Explorer` and `explorer.md` both mean `explorer`), so the
rebuilt chain still selects its own rows and still matches `Task.agent`. And each
call carries the status its own `Task` row recorded: the settlement projection
rewrites that row in place, so a chain knows whether its last run was `completed`
or `failed`. A run the app closed while it still worked never settled: its row
still says `running`, which rebuilds as `interrupted` — ~~not resumable~~ (superseded
2026-10, §15: `interrupted`, and likewise a rebuilt `stopped` or `aborted` run, is
continuable, seeded from the rows that remain or its original brief) rather than staying open forever. A row that records no status at all is trusted as
settled, because every `Task` row this app writes carries one. The model binding
itself is not persisted as a key, so a rebuilt chain is matched to a configured
binding by model id; two accounts offering the same model id are
indistinguishable at that point.

### 13. The transcript renders a chain as one continuous conversation

A resumed delegation's card shows the whole chain's rows as consecutive turns
(task → reply → task → reply) with no special "resumed" badge. The new run's
counters start at zero; `details.resumedFrom` keeps the link auditable.

### 14. Direct user continuation carries explicit delivery ownership

A user may continue a settled chain without the parent model emitting
`Task(resume)`. The new run records `delivery: "parent" | "user"` (parent
default): `parent` only while the parent still expects this chain
(startedEpoch == turnEpoch, undelivered, not stopped/aborted, owning turn
alive); otherwise `user`, which never auto-delivers, never enters parent
context or parent accounting, and executes under a child-only
execution-accounting turn opened with the existing durable-turn owner. Only an
explicit parent `Task(resume)` reattaches the chain. No new session, schema,
or event type; the user-origin marker is a `Task` row the parent rebuild
skips.

> Clarification 2026-10 (original wording above preserved): steering a running
> delegate keeps it attached — a program wake, `any` threshold, or
> progress checkpoint never detaches unfinished delegates (no model timeout exists).
> A detached source against
> an unrelated live parent fails with `AGENT_BUSY` with the draft preserved;
> the session holds a single active turn, the detached run steers through its
> execution owner, `expectedTurnId` stays a stale guard with `messageId`
> idempotency, post-restart hydration rebuilds from history, and the detached
> terminal silently closes only its own row.

> Amendment 2026-10 (chain continuability, §15): because stop/disposal and a
> terminal parent error cancel the parent's expectation of a chain, a direct
> user continuation of a `stopped` or `aborted` source is always `user`-owned —
> isolated, with no parent provider request, parent context, parent accounting,
> or parent wake, and it cannot resurrect the original parent's waiting or
> delivery. Only an explicit parent `Task(resume)` starts a new parent-owned run.

### 15. Chain continuability is not a function of the last outcome

This section states the current contract and supersedes the outcome, eviction,
and read-budget exclusions in §5, §7, and §8.

- **Instantiated chains only.** A chain exists once its first `Task` call has
  actually spawned a delegate instance. A `Task` call denied before spawn — an
  unknown `agent`, an empty `task`, an unresolvable model pin, a definition whose
  tools are all unavailable, or the `MAX_SUBAGENT_CONCURRENCY` cap — creates no
  child instance and therefore no chain: it is never continuable, never listed,
  and its id never resolves.
- **Outcome is historical, not terminal.** Every instantiated chain whose run
  has settled may be explicitly continued, whatever the run recorded:
  `completed`, `failed`, `timed_out`, `interrupted`, `stopped`, `aborted`. The
  settling outcome describes what happened to that execution; it never makes the
  chain permanently uncontinuable.
- **Stop still cancels the execution.** `TaskStop`, user Stop, and runtime
  disposal keep their full effect on the *running* execution: they abort the
  in-flight run, release its resources, settle it with its historical
  `stopped` / `aborted` outcome, and retire that run's pending waiting and
  report delivery. What changed is only that the abort no longer bars the chain;
  the next continuation is a new run with its own lifecycle, identity, and
  counters.
- **Continuation always spawns a new run.** A continuation is a new
  `SubagentRun` with a new `delegationId` on the same chain, seeded — when any
  history remains — with the chain's retained rows through the model-context seed
  truncation (ADR 0299 §7), so the first request stays within the delegate's
  context budget regardless of chain size. A chain that still resolves but has
  no child rows left is seeded with the original task brief instead, which is
  why an immediately cancelled run (zero child rows, original `Task` args
  retained) can still start a new run from that brief plus the new input. Only a
  chain whose own `Task` rows are gone from the transcript cannot be rebuilt and
  resolves as an unknown id, exactly like an id that never existed.
- **Retention is by identity; the per-agent bound is a listing cap.**
  `MAX_RESUMABLE_CHAINS_PER_AGENT` (2) caps only how many of an agent's chains
  the parent's prompt listing shows. No chain is evicted for age or count, and
  running chains are never listed; every instantiated chain stays resolvable by
  id for the session.
- **Read volume is bounded at the seed, not at the door.**
  `MAX_RESUMABLE_READ_LINES` (50,000) no longer drops a chain from the list.
  Read metadata (up to `MAX_RESUMABLE_LISTED_FILES` files per chain) still shows
  in the listing and lifecycle details; the seed truncation is what keeps the
  resumed request safe.
- **Delivery ownership follows the source record.** A *direct* continuation
  (`agent.continueSubagent`) is `parent`-owned only while the parent still
  expects that chain (source parent-owned, current parent epoch, undelivered,
  owning turn alive). A source that settled `stopped` / `aborted`, or whose
  owning turn ended, yields a `user`-owned run: no parent provider request, parent
  context, parent accounting, or parent wake, and it cannot revive the original
  parent's waiting or delivery. An explicit parent `Task(resume)` is different:
  the parent is asking, so it always produces a new `parent`-owned run whose
  report is delivered back to the parent.
- **Busy guard, identity, auth, and prerequisites are unchanged.** One live
  record per chain, the same-session restriction, `Task.agent` matching, the
  model-binding reauthorization rules, and the no-`model`-with-`resume` rule all
  still apply; only the outcome gate is gone.
- **Retained work is reused.** In an isolated session, a continued chain reuses
  the worktree keyed by its chain id (ADR 0329): a stopped or aborted run keeps
  its partial files, and they are reused on continuation rather than recomputed.
  Only a completed run's work is merged back, under the existing
  `worktree.delegate.settle` semantics; continuing a partial run never merges it.
- **No persistence or protocol change.** Chain continuability rides the
  transcript and lifecycle details already persisted; there is no database
  migration, schema-version change, new event type, or Plugin SDK / IPC protocol
  change.

## Consequences

- `Task`'s parameter schema widens by one optional field. Every existing call is
  unchanged: `resume` omitted is exactly today's behavior.
- The delegate→parent context boundary is untouched. Reconstructed rows seed the
  delegate's own context only; the parent still receives nothing but reports
  through `TaskWait`, and `parentToolCallId` rows are still skipped when the
  parent's context is rebuilt.
- No new storage schema, tables, or event types. Chain identity, read tracking,
  and the model binding live on the in-memory chain; `resumedFrom` and
  `modelChangedFrom` ride the existing lifecycle details projection.
- A resumed run is billed and bounded exactly like a fresh one — same concurrency
  slot, same permission scope, same fallback models, same abort sources.
- Read volume degrades gracefully to a bounded seed, never a broken or oversized
  request and never a dropped chain; a chain with no replayable rows still
  continues from its original task brief.

## Out of scope (二期)

- ~~Reviving a `stopped` / `aborted` delegation.~~ (Removed 2026-10: chain
  continuability now covers every settled outcome — see §15.)
- In-chain compaction or placeholder substitution for old tool results.
- Task queuing / work append on a running delegation.
- Cross-session resumption.
- User-visible settings for the bounds; they stay code constants.
