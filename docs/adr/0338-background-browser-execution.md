# ADR 0338: Background browser execution without revealing

- Status: Accepted
- Date: 2026-11-22
- Amends: retained-browser-pages-per-tab (queued background navigation intent)
- Related: ADR 0170 (host-owned guest + debugger), ADR 0211 (plan-safe actions),
  ADR 0330 (work-panel visibility is shell state),
  `docs/spec/07-plugins/03-plugin-api.md` §browser

## Context

Agent browser calls ran only while the Browser view was visible: page
operations gated on the visible view, and background-session navigation was
queued as an intent consumed when the session became visible. The bundled
Browser agent tool called `reveal()` before every operation, stealing the
work panel to the calling session even when the user was watching another
session. Visibility (a shell/UX concern per ADR 0330) was coupled to
execution (a host-routing concern).

## Decision

Execution and visibility are split:

- Every `BrowserHost` page operation (`navigate`, `action`, `getStateForPlugin`,
  `openExternal`, `snapshot`, `screenshot`, `click`, `fill`, `evaluate`,
  `console`, `cdpCommand`) takes the caller's `(sessionId, tabId)` and binds
  that session's own page at entry. Navigation lazily creates the caller's
  page; reads never create one (`getStateForPlugin` returns `null` for a
  session without a page). Calls with neither a runtime session nor chrome
  context fail with `UNAVAILABLE` instead of touching the foreground page.
- Presentation never moves as a side effect of execution: no reveal is
  requested, the active page is untouched, and a foreground switch mid-flight
  cannot redirect an in-flight navigation (the page is bound at entry).
- `reveal()` stays as the explicit, optional UI affordance with unchanged
  semantics: it activates the calling session's tab and resolves only after
  that session's view is visible, failing with `UNAVAILABLE` otherwise. The
  bundled Browser agent tool no longer calls `reveal()` per operation; it
  runs in the background and reveals only on explicit user request.
- Plugin-runtime routing (`browserTarget`) prefers the in-band tool-call
  context, then the in-flight tool session; an in-flight call with an empty
  session fails with `INVALID_ARGUMENT` rather than falling back to the
  foreground page.

## Alternatives

Keeping per-operation `reveal()` preserves the old failure mode: background
agents hijack the visible session. Keeping the queued-intent model leaves
background navigation latent and ordering-sensitive. A "navigate the visible
page when the caller has none" fallback would let background agents corrupt
the foreground session; it was rejected in favor of an explicit
`UNAVAILABLE`.

## Consequences

- Back-compat: public `pi.browser.*` signatures are unchanged; the SDK
  `reveal` doc now marks it optional. Behavior change: operations that used
  to fail while hidden now succeed on the caller's page, and the bundled
  tool no longer reveals per action.
- No frozen-ownership move: the guest page and debugger stay host-owned in
  Electron Main; the renderer still owns only presentation. SQLite, IPC, and
  plugin permission boundaries are untouched.
- Detached pages receive a stable layout viewport without being attached, so
  capture and CDP geometry stay sane while hidden. Detached
  `WebContentsView` capture fidelity is validated separately at the
  Electron E2E layer.
- `click` is a uid-targeted in-page activation: the snapshotted element is
  scrolled into view, must have a layout box, and is then activated in-page
  with a user gesture (hover/press/release pointer sequence plus the
  element's activation behavior, so links navigate, checkboxes toggle, and
  forms submit). Native CDP pointer injection is not used: it returns
  success for a guest without a composited view while the renderer drops
  the input. The same path runs visible or hidden and never reveals,
  focuses, or attaches any page. Targeting is uid-based rather than point
  hit-testing, so an overlapping element does not intercept the activation.
