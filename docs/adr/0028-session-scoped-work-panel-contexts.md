# ADR 0028: Scope work-panel runtime contexts to conversations

- Status: Accepted
- Date: 2026-07-27
- Amended in part by: [ADR 0108](0108-remove-built-in-interactive-terminal.md),
  [ADR 0330](0330-work-panel-visibility-is-shell-state.md) (a context keeps its
  resources; whether the panel is on screen is shell state)
- Relaunch clause superseded by: D662 (each conversation's ordered tabs and
  active tab now restore from one renderer preference; see the amendment below)

## Context

The renderer previously owned one global work-panel tab set. Selecting another
conversation or workspace closed the panel and destroyed every tab, as required
by D128. That prevented relative resources from leaking into another workspace,
but it also discarded useful tools when the operator returned to a conversation.

Permission-gated tools exposed a race in that model. A tool could finish after
approval while another conversation was loading. If completion arrived before
the selection committed, its artifact briefly opened the global panel and was
then cleared, causing a visible resize flash. If it arrived afterward, the
background-session guard dropped the artifact entirely. BrowserPreview also
lost its originating session identity before reaching the renderer and could
resolve a relative path against the visible workspace.

## Decision

Each conversation owns a renderer-memory work-panel context containing its open
state, ordered tabs, active tab, file request, and Browser resource.

- Selecting a conversation saves the current projection and atomically restores
  the destination context. Switching away never deletes either context.
- New and forked conversations begin with an empty context. Deleting a
  conversation removes its retained context.
- Review and BrowserPreview artifacts are recorded against their originating
  `sessionId`, including while that conversation is in the background.
- Background artifacts update retained state only. They do not open, activate,
  navigate, resize, or focus the visible panel.
- BrowserPreview events carry `sessionId`. Electron Main resolves local preview
  paths from that durable session's `projectPath`, and navigation occurs only
  when the originating conversation's Browser tab is visible.
- Selecting a workspace without an active conversation hides the current panel
  projection while retaining the prior conversation's state.
- Work-panel contexts were transient in the running renderer: relaunch discarded
  them and only panel width remained persisted. *(Superseded by D662 — relaunch
  now restores each conversation's ordered tabs and active tab from one
  versioned renderer preference; see the amendment below.)*

This adopts D142 and supersedes only D128's requirement to close and clear tabs
on visible session/workspace changes. D128's artifact triggers, deduplication,
and close/collapse rules remain unchanged; its no-launcher rule is amended by
ADR 0068. Electron Main, preload IPC, and renderer ownership boundaries remain
unchanged.

## Consequences

- Returning to a conversation restores its tools without reinterpreting paths
  against another workspace.
- Permission completion and asynchronous navigation no longer produce a
  transient panel open/close cycle or lose the resulting artifact.
- The renderer retains bounded per-session UI state until deletion or relaunch;
  it adds no host storage or schema migration. *(Amended by D662: that state now
  also survives relaunch through one bounded renderer preference — renderer-local
  preference data, still no host schema, migration, or cleanup service.)*
- The embedded browser remains one hardened Main-process WebContentsView. Its
  visible resource follows the selected conversation rather than allowing a
  background preview to navigate the foreground view.
- The former interactive terminal process/cache is no longer part of the
  work-panel runtime; Browser remains the Main-owned native resource.

## Alternatives

### Keep clearing tabs on every context change

Rejected because it loses task continuity and cannot avoid both permission
completion flashes and dropped background artifacts.

### Persist panel contexts in host storage

Rejected because tabs and Browser resources are transient presentation state.
Durability would require schema, cleanup, and stale-resource policies without
improving the reported in-process workflow.

*(D662 revisits durability only as renderer-local preference data: no host
schema, cleanup service, or stale-resource policy was added, so rejecting host
storage still holds.)*

### Key every backend panel subsystem by conversation

Rejected for this change. Conversation ownership is required for the visible
tab context and BrowserPreview routing; it does not make every backend resource
durable.

## Amendment (2026-10-22): relaunch restoration

D662 supersedes this record's transient-context clause without changing who owns
a context. A conversation still owns its work-panel resources in the renderer,
selection still projects them without deleting the source, background artifacts
still never open, activate, navigate, resize, or focus the visible panel, and
deletion still removes a context. What changes is durability: relaunch restores
each conversation's ordered tabs and active tab from one versioned renderer
preference (`pi.desktop.workPanel`), written best effort and bounded to 60
conversations with 40 tabs each, and the conversation on screen is written first
so the bound never drops it. Runtime handles stay out: a file tab's request, the
Browser page, and any delegation or plugin execution are never stored and never
resume. Ownership of whether the dock is on screen remains shell state
(ADR 0330).

## References

- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/03-permission-ux.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D142)
