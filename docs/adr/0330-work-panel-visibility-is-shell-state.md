# ADR 0330: Work-panel visibility is shell state

- Status: Accepted
- Date: 2026-10-21
- Amends: [ADR 0028](0028-session-scoped-work-panel-contexts.md) (session contexts
  keep their resources, not their visibility)
- Related: D142, D661, ADR 0068 (no launcher on reveal), ADR 0195 (viewport-fixed
  toggle), `docs/spec/04-ux/09-interaction-patterns.md` §1.8

## Context

ADR 0028 scoped the work panel's runtime state to conversations so a
background artifact could not overwrite the visible one, and D142 recorded that
context as "open state, ordered tabs, active tab, and Browser resource".
Selection projected the whole context, including its open flag.

That made a navigation action rewrite the user's visibility choice in both
directions. Selecting a conversation that had never opened the panel collapsed
a dock the user was reading in; returning to an earlier conversation reopened a
dock the user had closed. The resources genuinely belong to a conversation — a
file opened in one topic should not appear in another — but whether the dock is
on screen is a property of the window, not of the topic being read.

## Decision

1. `workPanelOpen` is shell UI state beside `workPanelWidth`. It starts closed
   on every launch and is never persisted.
2. A conversation's work-panel context holds only its resources: ordered tabs,
   active tab, pending file request, and Browser resource. It has no visibility
   field.
3. Selecting a conversation, creating one, forking into one, activating a
   project, and resetting the visible content project the destination
   conversation's content and change nothing about visibility. The result is
   symmetric: an open panel stays open, and a closed panel stays closed even
   when the destination's retained context was open when the user last read it.
4. Only an explicit action changes visibility: the viewport-fixed toggle,
   `Cmd/Ctrl + J`, the panel header's collapse action, or an artifact that
   targets the visible conversation. Background artifacts keep updating retained
   content only.
5. Because visibility no longer depends on a conversation, collapsing works
   during the transitional no-conversation phase a select/new/fork/delete
   passes through. Revealing keeps its documented no-op without an active
   conversation.
6. Resources stay isolated per conversation: no global tab set is merged, no
   visibility is persisted, and no per-session open flag is written. Renderer
   only: no Plugin SDK, IPC, host protocol, or storage change.

## Consequences

- The dock is stable across topic changes: the user's open/closed choice is
  never re-decided by reading a different conversation.
- A conversation's retained resources are still restored exactly when it
  becomes visible, and are revealed by the next explicit toggle.
- Collapsing a panel that outlived its conversation is now possible; previously
  the action was ignored because there was no active session to write to.
- A background artifact for an inactive conversation cannot reveal the dock,
  and a visible-conversation artifact still reveals it, as before.

## Alternatives

- Keep per-conversation visibility and add a global override: two sources of
  truth for one question, and the override would still need a rule for which
  one wins on each transition.
- Reveal the destination's retained open state on switch: that is the behavior
  this record replaces; it cannot honor a close, which has no owner after the
  conversation changes.
