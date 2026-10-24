# ADR 0312: Session-scoped Todo checklist

- Status: Accepted for implementation
- Date: 2026-09-29
- Amended: 2026-10-23
- Deciders: PI-Desktop maintainers
- Related: Issue #1177

## Context

Multi-step Agent work needs a durable, session-scoped progress checklist that can
be shown to the user without making the renderer a second source of truth. The
checklist must remain ordered, survive restart, and be isolated from Plan/Goal
contract negotiation and delegated subagent calls.

## Decision

`TodoWrite` is an Agent-only builtin tool. Its arguments contain the complete
ordered checklist and are validated by host-core. The host owns persistence in
SQLite schema v21: `session_todo` stores the rows, while `sessions.todo_revision`
and `sessions.todo_updated_at` order both populated and empty snapshots. Each
write replaces the rows and increments the revision in one transaction.

The tool call is authorized against the calling session and the ownership of its
turn inside that transaction. The host emits `todos.changed` only after commit and
serves the complete committed snapshot through `todos.get`. Electron Main
forwards the notification through the existing IPC bridge, and the renderer
keeps snapshots keyed by session id while rejecting stale revisions.

Amended (2026-10-23): the turn's own state is not part of that authorization. A
call that was valid when the model issued it may still be in flight when the
round ends, and the checklist describes the session rather than the turn, so a
settled turn of the same session — completed, aborted, or left `aborted` by a
restart — still writes. That write does not reopen, re-settle, or create a turn.
Missing, unknown, and foreign turns stay refused, as do Plan/Goal, delegated,
plugin, and MCP calls.

The original Composer TodoDock was a non-focusing, session-aware presentation
surface (since retired; see Current status).
It shows bounded progress and the complete ordered list: the expanded dock
scrolls inside its own box instead of truncating, so a long checklist stays
readable without growing the Composer stack. Remote RACP sessions remain
local-only for this vertical slice because RACP v1 has no Todo snapshot
operation; the renderer skips local recovery for those session ids rather than
reading the local database.

## Consequences

- Empty checklist writes remain observable through revision advancement.
- Session deletion cascades checklist rows; forks start with an empty checklist.
- Plan, Goal, delegated, plugin, and MCP execution paths cannot write the
  checklist through this contract.
- Context-compaction injection is deliberately deferred to a follow-up change.
- Remote Todo parity requires an additive RACP contract in a later change.

## Verification

Host-core tests cover migration, validation, transaction rollback, restart,
revision ordering, fork isolation, cascade deletion, and RPC authorization.
Renderer contract and component tests cover the checklist card's states, the
revision fence on pushed snapshots, and the committed list surviving the
runtime's result mapping.

## Current status (amendment, 2026-10-20)

The persistence contract above is unchanged. The Composer dock surface is no
longer mounted in the product: the checklist is read in the `TodoWrite` row that
wrote it, which opens with the turn and keeps the reader's collapse choice across
later streaming updates, and no Composer surface renders a checklist.

The retired surfaces are gone rather than kept for a fixture. `TodoDock` and its
snapshot-recovery hook had no product consumer left, so both were removed
together with their tests; the renderer still keeps committed snapshots by
session id and ignores stale revisions, but no surface reads them back. The row
renders the list the host committed, which the successful tool result now
carries as `todos`, so a card never re-derives a checklist from the argument a
model sent and a later write cannot rewrite an earlier card. `pnpm test:e2e:todos`
drives that production row in an isolated Electron renderer against a real host.
