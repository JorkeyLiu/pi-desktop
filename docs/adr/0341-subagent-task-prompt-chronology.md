# ADR 0341: The subagent Task prompt is a chronological opening

- Status: Accepted and implemented on
  `jorkey/fix/subagent-history-paging-continuity` (commit `c1459c2d0`: additive
  host/shared scoped-history metadata, desktop renderer projection, host-unit
  and rendered/real-host E2E evidence). The page cadence and the commit shape
  the renderer now uses for a loaded page are stated in
  `04-ux/08-component-spec.md` §5.7 and E2E-207g; neither changes this
  decision's claim about where a prompt may appear.
- Date: 2026-11-26
- Deciders: PI-Desktop core
- Related: [ADR 0335](0335-scoped-session-history-reads.md) ·
  [ADR 0279](0279-resumable-subagent-delegations.md) ·
  [ADR 0299](0299-subagent-context-budget.md) ·
  [ADR 0130](0130-bounded-mounted-transcript-window.md) ·
  `03-runtime/01-ipc-protocol.md` §7, `03-runtime/06-host-rpc-protocol.md`
  §Sessions, `04-ux/08-component-spec.md` §5.7 / §7
- Supersedes: the ADR 0335 "one Task brief at the page head" rendering clause
  only. The scoped-read selection, cursor, context, and contiguity decisions of
  ADR 0335 stay in force.

## Context

ADR 0335 introduced delegation-scoped history reads: the host selects a
chain's direct child rows across all of its resume runs, pages by physical
cursor, and returns every `Task` / `Task(resume)` message of the chain as
`historyContext` outside the page budget.

The first renderer design treated that context as a page header: each chain
`Task` row was drawn as a synthetic user row at the head of the page,
followed by that call's children. With one chain that was tolerable; with
resume runs and upward paging it was wrong in a way users observed directly:

- every older prepend re-drew the root prompt above the children the window
  already held, so the prompt flashed repeatedly while the reader paged
  toward an older row;
- a latest or search-focused window cut in the middle of a run showed the
  prompt for that run even though the run's opening was not inside the
  window, which reads as a sticky header and misstates chronology;
- the synthetic row carried no stable identity, so the anchor hold had no
  fragment to measure on the prompt itself.

The user-visible contract is that a Task prompt is an event in the
conversation, like the dispatch it belongs to: it is drawn once, where the run
actually begins.

## Problem

The renderer cannot derive run openings from what it had:

- `SessionDetail.historyContext` is a flat `UiMessage[]`; it strips the
  physical identities the host already knows.
- `messageStart` / `messageEnd` / `hasMoreBefore` describe the *scope*, not a
  run. `hasMoreBefore === false` proves the chain head, never the head of a
  later resume run.
- `createdAt` cannot establish a physical head (a completion event can restamp
  a row), and prompt text is not a stable instruction identity.
- "Hide every prompt while the chain has older rows" is also wrong: a later
  resume run opens inside a window whose chain still has older rows.

## Decision

The host states each run's physical opening, the renderer decides visibility
from the window it actually retains.

1. Additive response metadata. A delegation-scoped `session.get` answer adds
   `historyRuns: [{ callId, taskMessageId, taskIndex, firstChildIndex? }]`
   (camelCase on the wire), derived from the physical selection the host
   already computes: `taskIndex` is the chain `Task` row's physical index,
   `firstChildIndex` the smallest *selected* child index of that call.
   `firstChildIndex` is omitted when the call has no selected child (an
   unknown cut or a not-yet-durable run) — no position is fabricated. `main` /
   unscoped / legacy answers omit the field; empty answers omit it too.
2. Renderer projection. The retained contiguous window is the union of the
   pages the reader holds. A run's prompt is drawn only when
   `windowStart <= firstChildIndex < windowEnd`; a run whose `firstChildIndex`
   is unknown is visible only at the scope tail (empty or live opening), which
   is also how live-only Task rows behave. Prompts keep the Task row's source
   message id as their DOM identity and the call id as their React key.
3. Everything else stays out of band. Every chain `Task` row remains available
   as `historyContext` for chain identity, tab naming, and metrics; ownership
   never implies prompt visibility.
4. Fallbacks are explicit, never guessed. The legacy unscoped read holds
   every row, so its prompts are visible. A scoped answer without
   `historyRuns` is an older backend: a partial window draws no prompt, and
   only a window that reaches the chain head (`hasMoreBefore === false`) may
   draw them.

No persistence format, database migration, frozen process boundary, or public
plugin API changes. The wire addition is internal and additive, so a host that
does not emit it still answers a valid response.

## Consequences

- A latest, focused, or mid-run older window draws children only; the page
  that reaches a run's first child introduces its prompt once, and the
  existing visible-fragment hold keeps the reader's offset across the
  insertion.
- Resume runs open at their own chain position even while the chain has older
  rows, and every prompt is drawn exactly once per retained window.
- The answer carries one extra array per scoped read (linear in the number of
  runs in the chain, not in rows).
- Chain/call ownership and metrics still resolve for windows that draw no
  prompt, because context is unchanged.
- Remaining risk: run ordering across runs still follows the existing
  `orderedRows` chronological ordering of the rendered messages; only
  visibility is physical. A host that omits `historyRuns` degrades to the
  conservative whole-chain rule above.
