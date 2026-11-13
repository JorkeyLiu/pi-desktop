# ADR 0333: Durable installed handoff checkpoints for delegation chains

- Status: Accepted for implementation
- Date: 2026-11-10
- Deciders: PI-Desktop core
- Extends: [ADR 0279](0279-resumable-subagent-delegations.md) ·
  [ADR 0299](0299-subagent-context-budget.md)
- Related: [03-runtime/02-agent-runtime.md](../spec/03-runtime/02-agent-runtime.md)
  §5f, §5.1
- Tracking: delegate self-handoff follow-up

## Context

A delegate's self-handoff (ADR 0299 §5f) replaces its in-memory model context at
a turn boundary with the immutable dispatch header, the user directions it was
given, and exactly one model-authored summary. The rollover is a context
operation only: the persisted transcript keeps every row, and nothing was written
that records where the replaced context ended.

`Task(resume)` (ADR 0279) rebuilds a delegate from that same complete
transcript: the original task plus every child row the chain produced. The two
paths therefore disagree about what a delegate continues from. After a handoff,
the live run works from the header, the directions, and the summary; a resume of
its chain replays all the execution history the handoff already absorbed, and
then puts the raw post-boundary rows back after them. The delegate is told its
absorbed history is gone, and the resume hands it back.

Nothing durable could describe a boundary either, because it did not exist. The
only in-memory record was the run's own `handoffHeader` and steering ledger,
which die with the run. A restart therefore had no way to know that a rollover
ever happened.

The pieces needed for a durable boundary already exist: child rows are persisted
with stable ids (the bare `toolCallId` for tool rows, the row's own UUID for
assistant rows — the same value the host writes and a `session.get` replay reads
back), the delivered directions are persisted as tagged child rows
(`steering: true`) with durable attachment refs, the delegation's `Task` row
details are open JSON that host-core already rewrites in place, and
`rebuildChainsFromTranscript` already reads those details at session launch.

## Decision

### 1. A checkpoint is written only for an installed context

A submission is accepted, held, and installed at the next boundary. The
checkpoint is written **after** the runtime has replaced the in-memory messages,
never when a submission is merely accepted. Nothing infers an installed boundary
from acceptance, from elapsed time, or from the segment counters: the record
describes a context that actually existed.

### 2. The record identifies lineage, source, generation, and boundary

```ts
type DelegationHandoffCheckpoint = {
  version: 1;
  delegateSessionId: string;   // chain identity, stable across resumes
  delegationId: string;        // the run that installed it
  sourceToolCallId: string;    // that run's `Task` call
  agentName: string;           // normalized, so matching stays exact
  generation: number;          // 1-based; continues across resumes
  throughRowId: string;        // last persisted child row absorbed
  summary: string;             // exactly as installed
  originalTask: string;        // chain's opening instruction
  directives: DelegationHandoffDirective[]; // delivered, in order
  installedAt: string;
};
type DelegationHandoffDirective = {
  toolCallId?: string;         // the `Task` call that delivered it, when one did
  rowId?: string;              // persisted child row that delivered it, when one exists
  text: string;                // kept even when the row is gone
  attachments?: MessageAttachment[]; // durable refs, never inline bytes
  opening?: boolean;           // the chain's task, which is not a child row
};
```

`throughRowId` is the boundary: an **identity over persisted child rows**, not a
timestamp. That is what makes a boundary placeable after a restart, a replay, or
a truncated branch — a timestamp comparison could not distinguish two rows
written in the same millisecond or survive a rewritten row. `toolCallId` is the
instruction's identity: a parent `Task(resume)` is delivered as the resumed run's
opening turn and has no child row of its own, so text alone could not keep two
identical resume directives apart.

Generations continue across resumes (`handoffGenerationBase`), so a newer
install always orders after the one it superseded and a chain never restarts its
numbering at 1.

### 3. Storage rides the delegation's `Task` row details

The checkpoint is stored as `toolResult.details.handoffCheckpoint` on the
delegating `Task` row. That value is open JSON: host-core already persists it
and rewrites it in place for progress snapshots and settlement, including the
newest-wins and still-running guards. The runtime writes it through the existing
`session.appendMessage` path, awaits the result, and only then records the
checkpoint on the live chain. Every later snapshot carries it through
`delegationSummary`, so settlement does not erase it.

That write is not ordered against the renderer's `PersistenceOutbox`: a progress
snapshot of the same `Task` row may be queued before it and reach host-core after
it, including across a window close whose outbox drains on the next boot. The
existing snapshot merge therefore treats the checkpoint as **monotonic** rather
than as ordinary newest-wins payload: a stored checkpoint survives an incoming
snapshot that carries none or an older generation, and only a higher generation
replaces it. The runtime only records a boundary after the append resolved, so
an acknowledged checkpoint can never be erased by an older queued snapshot, and
the live chain and the durable row stay in agreement.

Consequences: no new table, no schema-version change, no migration, no new event
type, no IPC/Plugin SDK change, and no effect on the parent's model context —
`parentToolCallId` rows are still skipped when the parent rebuilds.

### 4. A resume restores the installed context, in order

With a valid checkpoint, a `Task(resume)` seed is:

1. the runtime-owned system prompt (composition is unchanged; it is not part of
   the seeded messages),
2. the chain's original task,
3. the delivered directions recorded before `throughRowId`, in delivery order,
   each exactly once, with their hydrated images,
4. the installed summary,
5. only the persisted rows **after** `throughRowId`,

and then the new `Task(resume)` directive is appended by the run itself. The
rows the handoff absorbed are not replayed.

Directives are selected by **identity** — `toolCallId` for a `Task` invocation,
otherwise the persisted row id — so two intentionally identical instructions
stay two rows. A parent `Task(resume)` directive has no child row of its own: its
text is recorded in the checkpoint (and reconstructed from the persisted `Task`
argument while the row exists), and a user continuation's child echo is paired to
its `Task` invocation by `parentToolCallId`, never by text. A direction whose row
is missing degrades to the text the checkpoint recorded; a direction whose row
sits after the boundary is left to the tail so it is never delivered twice.

### 4a. The rollover header is the delivered instructions, not the replay seed

A run's seeded context is **replay only**: a checkpoint seed may begin with an
older summary and the execution tail after its boundary, and a legacy seed is the
whole history. Both are replayed for the run's first request. The fixed handoff
header is a separate, typed list (`SubagentRunOptions.handoffDirectives`) built
from the chain's delivered instructions — the original task plus every `Task`
and child-steering direction before this run — and the run appends its own
opening directive. A rollover therefore installs exactly:

1. the runtime-owned system prompt (unchanged, never a message row),
2. the chain's original task and every delivered direction, in delivery order,
3. the new summary.

It never pins the summary it replaced or any execution history, including the
history a legacy seed replayed. The current `Task(resume)` task and every earlier
resume directive survive the next rollover too, because each is a recorded
instruction with its own identity, not part of the absorbed segment.

### 5. Validity is decided against the transcript, and failure falls back

- The newest checkpoint whose `throughRowId` still exists in the chain's rows is
  used; an older generation is tried next.
- No checkpoint, an unreadable record (unknown version, missing cursor, empty
  summary, malformed directive), or an unplaceable boundary all fall back to the
  pre-checkpoint full-history seed, unchanged. Old data keeps working without any
  conversion.
- If the checkpoint write fails after the context was installed, the delegate
  keeps working on the installed context, the run result carries
  `handoffCheckpointError` (`SUBAGENT_HANDOFF_CHECKPOINT_FAILED`), and the live
  record carries the same value so the running `Task` row's summary/details and
  the `TaskWait` result name it before the run settles. The chain keeps its
  previous checkpoint (or none). A later resume then falls back instead of
  claiming a boundary that was never saved. The in-memory context and the
  durable record are allowed to differ; silently claiming the write is not.

### 6. Context replacement precedes persistence

The boundary write is attempted only after `state.messages` has been replaced,
and it never rolls the rollover back. A crash between the two leaves the
transcript as it was: the resume falls back to the previous checkpoint or the
full history, which retains more information than the handoff promised and never
invents a missing boundary.

## Consequences

- `Task(resume)` and a self-handoff now agree on what a delegate continues from:
  the durable boundary is the same one the run installed.
- A resumed delegate after a rollover starts smaller — the absorbed execution
  history is gone by design — and its first request is still bounded by ADR 0299
  §7 truncation, which protects the head and summary and reduces only the
  replayed tail.
- The `Task` row's details grow by the summary (the delegate's own free-form
  text, which carries no length bound of its own), the original task, and the
  delivered directions' text and refs. Images are refs only; bytes stay in the
  attachment store and are hydrated on replay like any other row. The request
  that replays the summary stays bounded by ADR 0299 §7, not by a handoff
  character count.
- Older sessions have no `handoffCheckpoint` in their `Task` details and behave
  exactly as before. No conversion is required, and there is no downlevel
  reader: a build that does not know the field ignores it.
- The parent's context, permissions, tools, concurrency accounting, delivery,
  and settlement are untouched.

## Out of scope

- Cross-session resumption (still ADR 0279 §10).
- Compaction checkpoints of the session (`CompactionRecord`): delegate handoffs
  stay off that chain so the parent's model context cannot install one.
- Resuming a run that is still live: unchanged, a resume never queues.
- Deleting or compacting old checkpoint records: a chain keeps every generation
  it installed, and only the newest placeable one is restored.
