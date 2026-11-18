# ADR 0336: Transient block-level thinking phase

- Status: Accepted for implementation (uncommitted feature branch
  `jorkey/fix-transcript-order-thinking`: shared transport, agent-runtime
  producers, desktop renderer, host ingress proof; unit suites
  `thinking-phase`, `thinking-status`, `message-stream`, `turn-process` green)
- Date: 2026-11-18
- Deciders: PI-Desktop core
- Related: [ADR 0018](0018-end-to-end-thinking-mode.md) ·
  [ADR 0335](0335-scoped-session-history-reads.md) ·
  `03-runtime/01-ipc-protocol.md` UiMessage contract ·
  `03-runtime/02-agent-runtime.md` thinking-block mapping ·
  `04-ux/08-component-spec.md` thinking indicator ·
  `04-ux/09-interaction-patterns.md` turn/delegate activity
- Supersedes: the "latest thinking activity decides the indicator" reading of
  the thinking-row contract only insofar as renderer position (later tools,
  text, or thoughts) no longer stands in for the phase. The documented
  streaming-and-content-free fallback for rows without the phase field stays.

## Context

`UiMessage.status = "streaming"` is the state of a whole assistant message,
not of one thinking block: the message keeps streaming while tools run and
reply text arrives. The runtime previously stopped the thinking indicator by
looking at what came *after* the thought (later tool or text activity), so a
thought followed by nothing kept breathing, and a thought followed by tool
arguments stopped for the wrong reason. The pi-ai / pi-agent-core 1.1.0
contract already carries the missing signal — per-block `thinking_start` /
`thinking_delta` / `thinking_end` frames — but the producers only emitted an
update when the thinking *text* grew, and the shared stream/slimming path
dropped any field it did not know, so a `thinking_end` with no content delta
never reached the renderer. There was also nowhere to put the phase:
`UiMessage` had no thinking sub-state.

## Decision

Add one optional, transient field, `UiMessage.thinkingStatus:
"streaming" | "complete"`, owned end to end as follows:

- Both producers (main runtime, subagent runtime) fold typed thinking frames
  through one shared helper (`packages/agent-runtime/src/thinking-phase.ts`).
  `thinking_start` reports `streaming`, `thinking_end` reports `complete`,
  each emitted even when the frame carries no content delta. A duplicate or
  stray end for a block that is not open is ignored so it can never clear a
  newer block; text and tool-call frames never move the phase. Streams that
  settle without `thinking_end` (including upstream `done` frames that omit
  it) complete the phase at the terminal boundary (`message_end`, abort,
  error, run teardown); a fresh bubble resets it. Real thinking deltas that
  arrive without typed frames still report `streaming` for compatibility.
- The shared transport (`streamingMessageIdentity`, delta detection, merge,
  apply) preserves an explicit phase with `!== undefined` checks, so slimming
  and coalescing keep `complete` as well as `streaming`.
- The renderer treats the phase as authoritative: `complete` always stops the
  indicator (detailed, compact, turn label, delegate rows alike), `streaming`
  breathes while the turn is active, and rows without the field keep the old
  streaming-and-content-free fallback. Later transcript activity never decides
  the phase.
- The host ignores `thinkingStatus` on ingress and never persists it: no
  storage schema, no migration, no protocol version bump. Proven by
  `transient_thinking_status_is_ignored_and_never_persisted` in
  `crates/host-core/src/sessions.rs`.

## Consequences

- The indicator now stops exactly when thinking stops, including the
  thinking-then-nothing case, and restarts exactly on a newer
  `thinking_start`, without inferring anything from later tools or text.
- History rows restored from storage carry no phase and behave exactly as
  before via the documented fallback.
- This ADR records an internal transient convention only. It changes no frozen
  architecture (renderer / main / host-core / agent-runtime ownership is
  untouched), no persisted format, and no public plugin or protocol contract
  beyond one additive optional field that old readers safely ignore.
