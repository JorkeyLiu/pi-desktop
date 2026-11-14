# ADR 0335: Scoped session history reads

- Status: Accepted for implementation (implemented and verified in the
  uncommitted feature branch: host read contract, Rust host, agent-runtime, and
  desktop renderer; the four desktop scenarios and the restart-recovery scenario
  passed as host-unit plus real rendered evidence, `node scripts/e2e-scoped-history-real-host.mjs`
  exit 0 at base `2d5f6f893`)
- Date: 2026-11-14
- Deciders: PI-Desktop core
- Related: [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  [ADR 0127](0127-transcript-layout-index-and-identity-truncation.md) ·
  [ADR 0130](0130-bounded-mounted-transcript-window.md) ·
  [ADR 0137](0137-retained-session-panes.md) ·
  [ADR 0279](0279-resumable-subagent-delegations.md) ·
  [ADR 0299](0299-subagent-context-budget.md) ·
  [ADR 0333](0333-durable-installed-delegation-handoff-checkpoint.md) ·
  [ADR session-content-search](session-content-search.md) ·
  `03-runtime/01-ipc-protocol.md` §7, `03-runtime/04-data-storage.md` §4.7a,
  `03-runtime/06-host-rpc-protocol.md` §Sessions,
  `04-ux/08-component-spec.md` §5.7 / §7
- Supersedes: the window-selection clauses of [ADR 0120](0120-bounded-session-history-windows.md)
  (what a page counts, and therefore which rows a newest page contains).
  ADR 0120's bounded payload, display-only truncation, lossless transcript, and
  unscoped-caller decisions stay in force — this is not a replacement. Also
  supersedes the E2E-207a selection contract, which required the main transcript
  to open *backwards* until a top-level row entered its window.
- Amendment (2026-11, restart delegation reads): `TaskList` / `TaskWait` also
  answer from a read-only catalog rebuilt from the history the runtime launched
  with — the union of live records and at most the 100 newest recovered
  delegations — so a restarted session keeps listing the work it ran and can
  re-read stored reports (§9; ADR 0089). Reading stays a projection over
  persisted rows: no execution, no new storage, and no delivery boundary for
  history-only entries.

## Context

ADR 0120 bounded the transcript page that crosses the IPC boundary by physical
message-line position. A delegate's rows are persisted in the same transcript
file as the parent's and marked with `parentToolCallId` (§4.7a, ADR 0062),
which is why the main transcript can nest them under their `Task` card. The two
facts collide as soon as a session delegates heavily:

- A newest page of 100 physical rows can be 100 delegate rows. The main
  transcript then has nothing of its own to draw, so E2E-207a made opening a
  session walk further back until one top-level row entered the window. That
  walk is bounded only by the size of a delegation, not by the page contract.
- The delegation panel had no read of its own. `04-ux/08-component-spec.md` §5.7
  told it to store `(sessionId, delegation id)` and re-find the `Task` row and
  its `parentToolCallId` rows in the *live/retained main transcript*. So an open
  panel existed only for as long as the main window happened to hold its rows:
  collapsing the main window, replacing its page, paging away from the
  delegation, or restoring a bounded tail could make an open panel lose its
  identity, go unavailable, or drop rows it had already shown.
- A `Task` chain (ADR 0279) is several runs of one child session, and both the
  panel and the parent's card need the chain's whole child history, including
  runs whose `Task` row sits outside the page the main transcript is holding.
- Progress checkpoints and the final delegate report were appended to the
  historical `Task` row's details, which rewrites an old transcript line on
  every snapshot and makes a row's value depend on when it was last read.

The renderer therefore had one source for two surfaces that must remain
independent, and its page unit was "rows in the file" rather than "rows this
surface reads".

## Decision

### 1. A read names its scope, additively

`session.get` gains one optional `historyScope`:

```ts
type SessionHistoryScope =
  | { kind: "main" }
  | { kind: "delegation"; id: string };
```

Absence keeps every existing contract exactly: the complete unfiltered UI
projection, the same physical offsets, and the full model context for sidecar
and mutation callers. A bounded read without a scope is unchanged. This is an
additive field: no protocol version bump, no new RPC method, no JSONL body
schema rewrite, and no paid model call — a scoped read is still a projection
over the transcript file.

### 2. `main` budgets top-level records

With `{ kind: "main" }`, a page selects physical message records and skips any
row carrying `parentToolCallId`. The page budget counts **selected distinct
top-level records**, so a delegation of any size cannot consume — or force
additional reads out of — the main transcript's page.

"Top-level record" is a persisted-row property, not a rendered one: internal
model-state rows and empty visible rows still occupy a page, and the renderer
keeps deciding what it draws. The host does not guess which records a surface
will render, because a renderability rule would belong to the renderer and
would make the page depend on UI state.

### 3. `delegation` selects one chain

With `{ kind: "delegation", id }`, `id` accepts the stable delegation id of any
run on the chain or, for older callers, the legacy `Task` tool-call id. Both
resolve to the same chain: the root dispatch and every `Task(resume)`
continuation connected to it (ADR 0279 §1–§2, ADR 0333). The page selects that
chain's **direct child rows** across all of its runs, in transcript order, and
never includes rows a nested delegation the delegate itself started produced
(those belong to their own chain). An unresolved id yields no session at all,
like a missing `messageAround` target, so a panel can tell "this chain is gone"
apart from "this chain has produced no row yet".

The response may also carry `historyContext`: every `Task` and `Task(resume)`
message of the chain — the root dispatch that carries the task brief and the
chain's original description, plus each continuation — returned outside the
page budget because those rows can sit far above any physical page. It is
display context, in the same class as `navigationParent` — not an extra history
line, not persisted, and never model evidence.

The echoed `historyScope` is canonical, not the id the caller sent: a
`delegation` page answers with the earliest root dispatch's stable
`delegationId`, falling back to that root's `Task` tool-call id when the newest
build never recorded one, so entering a chain by any run id, any `Task(resume)`
id, or a legacy call id always comes back as one identity. `messageStart` /
`messageEnd` stay physical, `messageBefore` stays a physical exclusive cursor
over the selection, and `hasMoreBefore` / `hasMoreAfter` are computed over the
selected records of that scope so a page that answered a scope the renderer no
longer wants can be discarded.

### 4. Coordinates stay physical

`messageBefore`, `messageStart`, and `messageEnd` remain physical transcript
message-line positions, and a scoped page still begins at the requested physical
position and selects the nearest records of its scope from there. There is no
second offset space: the layout index, its versioned cache, the renderer's
scroll anchoring, message ids, copy actions, and truncation-by-identity all
address the same physical transcript they addressed before. Skipped rows inside
a span are simply not selected and not charged to the budget.

### 5. Search keeps its physical address

`session/searchContext` remains a location function over physical message ids.
It may still return `navigationParent` for a nested target, whose owning `Task`
may be read before any child history exists. Search does not become a history
source, and neither surface waits for the other's read. A nested hit stays a
physical location: the `main` scope centres its page on the owning top-level
dispatch's neighborhood and still returns `navigationParent`, the direct
parent `Task` call. Presenting the child itself means opening that chain's
`delegation` surface: search never widens the main page to include a child row.
The search read stays the physical `messageAround` read, so the caller's existing
main range is restored untouched rather than retargeted, and the dock opens or
reuses the chain's tab. The focus then follows the tab key the request landed in
— the chain's root `delegationId`, not the call id that asked — because the tab
mounts its history under that identity, and a focus written under the asking id
would land in a cache entry no open tab reads.

### 6. Two surfaces, two sources

The main transcript and the delegation panel keep independent reads and
independent holdings. The panel's identity is the persisted chain identity plus
the run it was opened for, resolved from its own scoped read rather than from
the main transcript's current page. Consequently an open panel's identity,
availability, and already-loaded rows must not change because the main window
grew, shrank, fetched a page, replaced its page, or restored its retained tail —
and the main transcript must not depend on an open panel either.

The three states a child surface can be in — loading, unavailable (error, or an
id that no longer resolves), and empty (a chain that produced no row yet) —
remain distinguishable; an unavailable panel is not an empty one.

### 7. Chain state is an append-only overlay

A chain's recorded state — its progress checkpoints and its final report — is
served from the host-owned, append-only `<sessionId>.snapshots.jsonl` sidecar
beside the session transcript, one `type: "snapshot"` line per accepted update
with `schema: 1`, `sessionId`, `savedAt`, `callId`, `delegationId`, and the full
`message`. Lines are appended, never rewritten in place, and reading a chain
does not rewrite the historical root `Task` line: that line stays the record of
the dispatch, which is also why a settled chain is never reopened by reading it.
The overlay is the sibling `<sessionId>.snapshots.jsonl` (`schema: 1`), one
`type: "snapshot"` line per accepted update naming `sessionId`, `savedAt`,
`callId`, `delegationId`, and the full `message`. A line is applied only to a
base row that is still `running`, whose message id, `callId`, and
`delegationId` all match, and whose installed handoff checkpoint generation the
line does not move backwards; a line identical to the row it would produce is
not written at all. The newest accepted line for a `(callId, delegationId)` pair
wins, so a later progress snapshot cannot reopen or regress a settled
delegation, and an older build that spliced its settlement into the transcript
line in place still wins over a stale sidecar.

The final report is stored verbatim — never AI-summarized, never truncated by
the overlay writer — and the structural fields a card needs (state, outcome,
owner, per-chain figures) come from the same overlay.

The overlay is derived state and reconciled, never orphaned. Session deletion
removes the whole file. A transcript rewrite folds the accepted overlay of every
`Task` row it keeps into the rows it is about to write, materializes those
effective rows before the atomic swap, and prunes the sidecar only afterwards;
a failed prune is a warning, because the rewritten transcript is already the
authority and a harmless settled overlay remains. A row an explicit edit already
changed is not overridden — the caller's content is the authority and the entry
is dropped with that rewrite — while entries whose launch row the rewrite drops
are kept for a later revision restore until the row is seen again or the session
is deleted. There is no time-based sweep. A torn tail, another session's line,
or a `schema` this build cannot interpret is skipped on read and copied back
verbatim by that prune, so a newer build still finds its data; those lines are
never presented as a recovered delegation. Legacy sessions with no overlay read
exactly as today, and a database table is not involved and would need its own
migration and tests before one is introduced.

### 8. Renderer live state is per surface and bounded

Each surface owns its loaded rows, its paging cursor, and its in-flight read.
None of these are shared through the other surface, and each keeps the existing
bounded-window discipline (ADR 0130 / ADR 0137): the delegation panel holds a
bounded set of its own rows rather than an unbounded copy per open tab.

### 9. Restart delegation reads rebuild a projection

After a restart the live registry is gone, so `TaskList` / `TaskWait` read a
catalog rebuilt from the transcript the runtime launched with, bounded to the
100 newest parent-owned delegations. It is a projection, not a registry:
`TaskList` answers the union of live records and recovered entries with the
live record winning for the same id, and a recovered entry carries
`recovered: true` with wording that claims no execution. `TaskWait` with an
explicit recovered id answers that entry's stored report verbatim and names
those ids in the additive `recoveredDelegationIds` detail; a mixed call
delivers only the live batch. Recovered entries never become wait targets,
never join the delivery receipt, and never reach `markReportDelivered`.
A persisted `Task` row still `running` after the restart reads as
`interrupted` and resumes only through an explicit `Task(resume)`; nothing
runs in its name. `source: "user"` rows stay out of the parent's listing and
waits, and unknown ids answer unchanged.

### 10. The renderer keeps a bounded, owned cache per chain

One entry per session and chain holds the child rows, the root `Task` context
rows, the canonical identity together with the identities it was addressed by,
the page cursors and flags, and the read state. Live child rows are routed into
the entry when they are published, so a main read, a window replacement,
reduction, restore, or paging cannot take them out of the panel — only the
panel's own read changes its content. A live row after the last durable read
marks the entry stale; reopening it refreshes the tail and merges that page over
rows it already holds instead of resetting them, and a failed read keeps its
loaded rows as a retryable detail (only an entry with nothing to show becomes an
error).

The cache is bounded by resource limits, not by a promise that every row ever
loaded stays resident. One chain keeps 400 rows — oldest non-focus rows trimmed
first, with its older cursor left in place so paging can re-read what was
trimmed, and a trim that leaves the search focus as an island states the gap —
and one session keeps its 12 most recently read chains. Eviction or trimming can
drop loaded rows; only the main reading window's own changes are guaranteed not
to.

A tail synchronization reads the newest page, then bridges backwards over the
physical `messageBefore` cursor until its range joins the rows the entry holds
or reaches the chain's head, merging the walked pages oldest first. The walk is
finite: at most 20 pages, 2000 selected rows, and every answer must move the
cursor toward the entry or the read stops with a retryable error that leaves the
loaded rows intact. A wider gap keeps a contiguous newest window plus the
retained focus island, states the omission where adjacency breaks, sets
`hasMoreBefore` true and its older cursor to the window's real first page, so
every omitted row stays reachable through ordinary "show earlier" paging rather
than vanishing.

## Consequences

- A restarted session still lists the delegations it ran and can re-read their
  stored reports, without a new table and without replay: the catalog is a
  projection over persisted rows, so it starts, resumes, and delivers nothing.
- A delegation panel and the main transcript can be read, paged, and restored
  independently. Changing the main reading window cannot swap which chain a
  panel shows, make it unavailable, or discard rows it already displayed.
- The panel owns its rows: the chain's entry, not the main viewport, is what a
  tab renders, and a main read, window replacement, reduction, restore, or paging
  cannot remove a child row the panel already holds.
- The cached rows are bounded, not promised: 400 rows per chain and 12 chains
  per session, with the older cursor kept so paging re-reads a trimmed range. A
  trim or eviction drops rows; only a main reading-window change is guaranteed
  not to.
- A tail synchronization is finite and honest about its bound: 20 pages of a
  100-row scope (2000 selected rows) either join the loaded range or replace it
  with a contiguous newest window, a retained focus row, a stated omission, and
  an older cursor that still pages every omitted row back in.
- A resumed chain reads as one child conversation from its root dispatch, even
  when the reader opened it by the newest run's id or by a legacy call id.
- A chain's recorded state becomes stable to read: checkpoints and the final
  result are appended to `<sessionId>.snapshots.jsonl` rather than
  re-snapshotted into the historical line, so a repeated history read returns
  the same value and leaves the transcript as it was. The root `Task` line, the
  transcript prefix, and every physical coordinate derived from it stay
  byte-identical.
- The layout cache moves to a new format version that also carries row ownership
  (each row's `parentToolCallId` pool index), the top-level row list, and the
  `Task` call index with its `Task(resume)` argument, so a scoped read needs no
  extra scan and a delegation chain resolves from the cache alone. An older
  version is ignored and rebuilt from the JSONL source; no migration is
  involved.
- Two read shapes now exist. Callers that need the whole unfiltered transcript
  (mutation, fork, model context, full-history rehydrate) keep the unscoped
  path, and the scopes describe surfaces, not storage.

## Alternatives considered

- **Filter the parent's rows out in the renderer after one physical page:**
  rejected. It still transfers the delegate rows, and a newest page that lands
  entirely inside a large delegation still hands the renderer nothing to draw,
  so the walk-until-renderable rule has to stay.
- **A second offset space per scope:** rejected. Physical offsets are the one
  coordinate system shared by the layout index, the scroll anchor, copy actions,
  search targets, and identity-based truncation; a second one would need a
  second index and would make a page mean different things per caller.
- **Keep deriving the panel from the live main transcript:** rejected. It
  couples a panel's existence to the main reading window, which is exactly the
  invariant this record has to protect, and it cannot survive a restart in which
  the panel's rows were never loaded.
- **Retain every row a panel ever loaded:** rejected. A chain can grow without
  bound while the app runs, so the panel keeps a bounded cache with an older
  cursor and an explicit omission marker — paging is the way back, and no view
  claims the whole chain is resident.
- **Re-snapshot the `Task` row for every checkpoint:** rejected. Every snapshot
  would rewrite a historical line and make the row's value depend on the last
  reader; the overlay carries the same information while leaving the prefix
  untouched, and keeps the monotonic-generation discipline ADR 0333 introduced
  for delegation checkpoints.
- **Add a results table to SQLite:** deferred. It would buy query support
  nothing asks for, at the cost of a schema migration, an orphan sweep, and
  upgrade compatibility for every existing session.
