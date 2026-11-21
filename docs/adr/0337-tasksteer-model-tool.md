# ADR 0337: TaskSteer model steering tool

- Status: Accepted for implementation (uncommitted feature branch
  `jorkey/feature/task-steer`: agent-runtime `subagent-steer.ts`,
  `runtime.ts` model entry, shared inherit-deny list, renderer
  tool-identity mapping, 9-locale strings; suites
  `subagent-steer` + `task-steer-loop` green)
- Date: 2026-11-21
- Deciders: PI-Desktop core
 - Related: [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
   [ADR 0279](0279-resumable-subagent-delegations.md) ·
  `03-runtime/02-agent-runtime.md` Task tooling ·
  `03-runtime/03-tools-and-permissions.md` delegation tool scope ·
  `04-ux/08-component-spec.md` delegation rows
- Supersedes: nothing. The user steer channel (`agent.steerSubagent`,
  transcript-tab sidecar path) is unchanged; this ADR adds the parent
  model's own channel beside it.

## Context

The user can steer a live child from its transcript tab through
`runtime.steerSubagent`. The parent model had no equivalent: `Task(resume)`
refuses a still-running delegation, so a model that spotted a problem
mid-run could only misuse `Task(resume)` against a live run. The shared
liveness machinery the user channel already uses (`validateSubagentSteer` /
`applyValidatedSteer` in `packages/agent-runtime/src/subagent-control.ts`)
decides whether a child loop can receive a message, but no model-facing
tool reached it.

## Decision

Add one Agent-mode tool, `TaskSteer({ delegationId, message })`, owned end
to end as follows:

- **One entry point, no payload or storage change.** The model calls the
  existing sequential `TaskSteer` declaration in the runtime's core tool
  set (`runtime.ts` `buildSubagentSteerTool`, executed via
  `executeModelSteer`). Authorization and queueing live in the new
  `subagent-steer.ts` (`validateModelSteer` + `applyModelSteer`), which
  are thin wrappers over the existing `validateSubagentSteer` /
  `applyValidatedSteer` control channel — no second steer path. The queued
  row keeps the existing `user` role and the existing steering table; the
  model provenance rides the tool-result receipt (`source: "model"`), never
  the persisted row. No migration, no schema version bump.
- **Permission is the entry, not the payload.** `TaskSteer` is Agent-only
  (Plan/Goal reject it without execution, same retained-declaration rule
  as `Task` / `TaskWait` / `TaskList` / `TaskStop`), parent-model only,
  current-runtime only, live-only. The lookup searches only this session's
  own registry: unknown, settled, stopping, loop-less, delegate-called, or
  user-controlled (`userOrigin`) targets fail with a coded tool error and
  no side effect. `expectedTurnId` is never consulted; a delegate's call
  is classified by its tool-call ownership and is never authorized, and
  the inherit-deny list keeps `TaskSteer` out of every delegate catalog so
  nested steering stays impossible by construction.
- **Receipt confirms queueing, never consumption.** A successful call
  returns `status: "queued"`, `delivery: "next_turn"`, `source: "model"`:
  the message reaches the child at its next turn boundary without
  interrupting its current tool batch. A run that settles in the race
  reads as `DELEGATION_NOT_RUNNING` with `Task(resume)` guidance, never
  as a silent drop. `Task(resume)` stays the settled-chain path and is
  never issued from here.
- **Renderer is unchanged.** `TaskSteer` shares the delegation presentation
  (`delegate` action) with its own fixed identity (`Task steer`,
  `chat.toolIdentityTaskSteer` in all 9 locales) but is deliberately not a
  lifecycle kind: lifecycle rows roll up rosters and chain state, while a
  steer row is one queued message into one live run.

## Consequences

- The parent model can redirect a running delegation it started itself
  without aborting the batch, misusing `Task(resume)`, or touching user
  state. Foreign, user-controlled, settled, and delegate-issued calls all
  fail closed with a correctable error.
- History, recovery, delivery receipts, and accounting are untouched: the
  receipt carries the only new structured fields, and readers intersect
  them the same way as other delegation metadata.
- This ADR records one additive Agent-mode tool over the existing steer
  control. It changes no frozen architecture (renderer / main / host-core /
  agent-runtime ownership untouched), no persisted format, and no plugin
  or protocol contract beyond the new tool declaration that old readers
  never see.
