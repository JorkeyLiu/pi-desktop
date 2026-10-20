# ADR 0312: Session-scoped Todo checklist

- Status: Accepted for implementation
- Date: 2026-09-29
- Amended: 2026-10-19
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

The tool call is authorized against the calling session and its running turn
inside that transaction. The host emits `todos.changed` only after commit and
serves the complete committed snapshot through `todos.get`. Electron Main
forwards the notification through the existing IPC bridge, and the renderer
keeps snapshots keyed by session id while rejecting stale revisions.

The Composer TodoDock is a non-focusing, session-aware presentation surface.
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
Renderer type checks and TodoDock interaction tests cover revision filtering,
remote-session degradation, session switching, expansion, and full-list display
through the dock's own scrollport.

## Current status (amendment, 2026-10-19)

The persistence contract above is unchanged. The Composer dock surface is no
longer mounted in the product: the checklist is read in the `TodoWrite` row that
wrote it, which opens with the turn and keeps the reader's collapse choice across
later streaming updates, and no Composer surface renders a checklist. `TodoDock`
remains in the renderer only as the surface the legacy `pnpm test:e2e:todos`
fixture mounts directly; it no longer stands for a product route.
