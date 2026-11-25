# ADR 0340: Parallel same-turn tool batches

- Status: Accepted
- Date: 2026-11-25
- Related: ADR 0062 (delegation bounds and mutation ordering),
  `docs/spec/03-runtime/02-agent-runtime.md` §8,
  `docs/spec/03-runtime/03-tools-and-permissions.md` §4d,
  E2E-TOOL-BATCH-PARALLEL

## Context

ADR 0062 made delegation concurrent by assigning `Task` the upstream
`parallel` execution mode and making every other catalog tool `sequential`.
Because pi-agent-core runs an entire assistant batch sequentially when any
tool in it is sequential, an ordinary tool mixed with `Task` accidentally
serialized the whole batch. Delegates inherited the same sequential flags
through the shared catalog, so a child's own independent calls also ran one
at a time.

This policy treated tool names as a proxy for resource safety. It duplicated
the parent's scheduling policy in catalog construction, individual tool
factories, extension registration, and the child `Agent` constructor. A new
tool could silently serialize unrelated work, while the policy said nothing
about the actual resources shared by two calls. The pinned
pi-agent-core 1.1.0 default is already parallel and starts every admitted call
in a batch before awaiting settlement; no tool-group API or explicit parallel
wrapper is needed.

## Decision

Independent tool calls emitted in one assistant response execute in parallel
by default in both the parent session and delegated `SubagentRun`. A model
expresses a dependency by issuing the dependent call in a subsequent model
turn, after the prior results return.

- The runtime does not assign blanket `executionMode` overrides to its catalog,
  builtins, mode tools, `Task` tools, or extension tools. An extension's
  explicitly declared execution mode remains supported; it is not replaced
  by a runtime default.
- Parent and child use the same pinned pi-agent-core default. Tool schemas,
  scoped selection, deferred activation, `beforeToolCall`, mode guards, and
  per-call host permission admission stay unchanged. Delegates receive no new
  tools or privileges.
- Concrete resource owners keep concrete constraints: the runtime-owned
  `PathMutex` serializes `Write`/`Edit` calls on the same normalized path,
  while different paths may overlap. Host-core retains its per-session
  mutation permit for actual mutation admission.
- Existing delegate concurrency caps, cancellation, result identities,
  structured usage, and error mapping remain in force.
- Tool execution events may arrive in completion order, but pi's next model
  request carries `toolResult` messages in the assistant's source call order,
  matched by tool-call id. No runtime reordering layer is added.
- A plan/goal transition remains illegal in a mixed assistant batch.
  `beforeToolCall` rejects the whole batch before either the transition or an
  ordinary sibling executes.

This supersedes ADR 0062 §4's execution-mode policy. Its delegation bounds,
scoped tools, permission queue, `PathMutex`, host mutation admission, and
report-delivery decisions remain in force.

## Alternatives considered

- **A shared PI-Desktop scheduler.** It could offer explicit dependencies and
  tool groups, but would duplicate pi's execution and cancellation lifecycle
  and create another scheduling truth. Rejected: the requested dependency
  model is subsequent model turns, and upstream already executes batches.
- **A shared runtime factory that forces parallel.** It would reduce repeated
  literals but still duplicate the upstream default in two constructors and
  invite future drift. Rejected: relying on the pinned, documented default is
  the smaller contract.
- **Keep sequential flags on stateful tools.** A tool name does not identify a
  shared resource, and one sequential tool still serializes every sibling.
  Rejected: constraints belong at their resource or admission boundary.
- **Let the model declare explicit same-turn dependencies.** This requires a
  new provider-facing protocol with uneven support and changes result
  assembly. Rejected: later-turn dependencies preserve the existing contract.

## Consequences

- Independent reads, searches, shell commands, writes to different paths, and
  subagent tasks can overlap, including mixed `Task`/ordinary batches.
- A model that needs one call's output must wait for the next turn rather than
  emit an implicitly ordered same-turn chain.
- Cancellation reaches every in-flight sibling; settled results still retain
  source order for the next provider request.
- Real-loop regression coverage must test both parent and child execution.
  Catalog-only assertions cannot prove that inherited flags no longer hide
  parallel behavior.
