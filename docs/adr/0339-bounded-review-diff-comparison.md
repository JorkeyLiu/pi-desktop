# ADR 0339: Bounded line comparison for review diffs

- Status: Accepted
- Date: 2026-11-24
- Related: `docs/spec/03-runtime/03-tools-and-permissions.md` §4c,
  `docs/spec/03-runtime/01-ipc-protocol.md` §13a,
  `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-REVIEW rows), ADR 0043

## Context

The review diff compared two file sides with an own last-common-subsequence
table. The table was quadratic in the number of lines, so the shipped engine
refused ordinary files: a 1.34 MB document with a single edited line reported
`fileTooLarge` without counting anything, and a whole-file rewrite was treated
as `diffTooComplex`. The guard was a *size* proxy, not a bounded computation:
above the size gate nothing ran at all, below it the work was unbounded in
line count and could stall the RPC worker hosting `review.files` and the
per-call `Edit`/`Write` preview.

A durable record (`ReviewChange`) was also recomputed independently of the
per-call preview that the same tool call had already produced, so one mutation
compared the same bytes twice, and `prepare_change` read the old file twice
(hash, then copy), which let a concurrent write make the record describe a
baseline it had never retained.

## Decision

The comparison is `similar` 3.2.1's Myers implementation with a cooperative
deadline, owned by `crates/host-core/src/review/diff.rs`. Limits are layered
and each layer owns one unit of work:

| Layer | Limit | Owner |
|---|---:|---|
| One side, bytes | 16 MiB | `read_diff_side` / durable-record side read |
| One side, lines | 500,000 | `make_preview`, before any per-line token is allocated |
| One file comparison | 200 ms | `DiffWork::file` |
| One `review.files` request | 1 s, 64 MiB input, 2,000,000 input lines | `DiffRequest` ledger |
| Hunk body per record | 8,000 lines / 48 KiB chars | `collect_entries` (counts first) and `make_hunks` |
| Engine edit script | output cap only | `similar` Myers |

- Every file admitted by a request charges its two sides' bytes and lines
  exactly once, before the engine runs, and its deadline is
  `min(now + 200 ms, request deadline)`. A file the ledger cannot afford
  reports `requestBudgetExceeded`; one whose own clipped deadline passed
  reports `diffTooComplex`. Both withhold counts rather than guess.
- The engine deadline is cooperative, not real time: `similar` returns a
  complete coarse script when time runs out. The host reads the clock before
  tokenization, before the engine call, and after it returns, and discards
  the whole result (counts and hunks) when the deadline has passed. No coarse
  script is trusted as evidence.
- Counts are the engine edit script's lengths. A coarse (non-minimal) but
  complete script is still a valid description of the change, so its counts
  and its replayable hunks are accepted; the contract does not claim global
  minimality.
- All heavy snapshot, hash, and comparison work runs on `spawn_blocking`
  (`prepare_change`, `finalize_change`, `discard_change`, `review.files`,
  `review.rollbackChange`), so a pathological diff cannot starve the async RPC
  workers.
- `prepare_change` hashes and copies the old file from one read. The tool call
  may pass an internal `FileMutationEvidence` (never serialized, no IPC or
  `ToolsExecuteResult` field) to `finalize_change`, which reuses that
  comparison only when the evidence's before/after hashes equal the record's
  own captured hashes *and* the hunk cap matches. Otherwise — no evidence, a
  concurrent edit between snapshot and tool, or a changed retained copy — the
  record recomputes from its own read-once sides. A retained copy whose hash no
  longer matches the recorded baseline reports `baselineUnavailable`. Workspace
  mutations only: scratch and approved external writes keep their per-call
  preview and carry no review evidence.
- Line semantics are unchanged: `str::lines()` (trailing-newline and CRLF
  behavior), binary detection on NUL or invalid UTF-8, deterministic hunk
  headers and ordering, unchanged output caps for the rendered patch.

## Alternatives

- **Keep the LCS table and raise the size gate.** The cost stays quadratic and
  unbounded below the gate, and the reported reason stays a size proxy instead
  of a measured work bound. Rejected: it cannot answer "the file is large but
  the change is small", which is the common case.
- **`imara-diff` histogram.** Fastest on whole-file rewrites, but its
  `repeat_cycle` pathology measured 207.69 ms — over the per-file budget — and
  the crate would have to be a permanent second engine to keep a candidate path
  alive. Rejected: one engine, one measurement, one contract.
- **`similar` histogram.** Same asymptotics as Myers on this pipeline, and a
  rewrite collapses to one whole-file replace. Rejected: the candidate
  measurements over the long-document fixtures showed no advantage large enough
  to give up Myers' finer hunks for dense edits.
- **Deadline only as a watchdog.** Leaving the engine running after the caller
  returned would leak work into the next request. Rejected: the deadline is
  cooperative and the host discards the tail.

## Measurements

Release build, median of 7 runs per fixture, over the shipped pipeline
(decode → tokenize → compare → count → render) rather than a bare engine. The
fixtures are the ones the module generates, so the table regenerates exactly:

```bash
cargo test -p host-core --release measured_diff_fixtures -- --ignored --nocapture
```

Environment: Apple M1, macOS 15.7.3, rustc 1.94.1, arm64; wall-clock figures
from one workstation are a reference point, not a universal guarantee.

| Fixture | Bytes/side | Lines/side | Pipeline median | Additions | Deletions | Reported |
|---|---:|---:|---:|---:|---:|---|
| `small_edit` | 1,910 | 60 | 0.009 ms | 1 | 1 | complete |
| `sparse_edits` | 173,890 | 5,000 | 1.022 ms | 4 | 4 | complete |
| `repeat_lines` | 40,000 | 20,000 | 1.186 ms | 1 | 1 | complete |
| `all_rewrite` | 142,890 | 4,000 | 0.832 ms | 4,000 | 4,000 | `diffTooLarge` (body cap; counts exact) |
| `doc_1_34mb` | 1,348,890 | 40,000 | 3.145 ms | 1 | 1 | complete |
| `crlf_only` | 20 | 3 | 0.000 ms | 0 | 0 | no line change |

The 1.34 MB single-edit case, which used to be refused without counting
anything, completes in 3.145 ms and keeps a real hunk; the repeated-line
pathology the old engine refused completes in 1.186 ms. The engine choice
itself was made at design time from a wider candidate comparison (shipped LCS
table, `imara-diff` histogram, `similar` Myers). Those candidate runs used an
older ad-hoc fixture set that included sides above the production 16 MiB gate,
so their figures are neither reproducible from the shipped generator nor
descriptions of what production accepts; they are not restated here as shipped
measurements. All engines agreed on counts and hunk bodies for the fixtures
they all ran, so the choice changes whether a result is produced at all, not
what a user sees.

## Consequences

- Behavior change: files between the old gate and 16 MiB / 500,000 lines are
  now compared and counted, whole-file rewrites report exact script lengths
  instead of `diffTooComplex`, and a comparison that runs out of its own or the
  request's budget reports `diffTooComplex` / `requestBudgetExceeded` with
  absent counts.
- Compatible: no IPC frame, persisted record shape, or `ToolsExecuteResult`
  field changed. `countsKnown` on `WorkspaceDiff` rows is the only additive
  contract, and it belongs to the remote/Git channel: old consumers keep the
  required numeric fields, new consumers treat `countsKnown: false` as unknown.
- Resource ownership stays host-local: limits live beside the comparison, not in
  the renderer, and `similar` is a normal dependency (`features = ["std"]`;
  without it the crate swaps `Instant` for `()` and the deadline silently never
  fires). No frozen architecture, data ownership, or permission boundary moved.
- The per-file 200 ms and per-request 1 s budgets are pragmatic defaults chosen
  from these measurements, not a real-time guarantee. They exist to bound a
  pathological file or a starved host, not as the expected cost of an ordinary
  long file: when a comparison's deadline has passed, the row states its limit
  instead of keeping counts it cannot vouch for.
- A request checks its deadline, remaining bytes, and remaining lines before it
  hashes or reads the next file, and reserves each side's expected size from
  metadata before reading, so an exhausted request stops instead of starting
  one more full read; a read whose file grew past its reservation is reconciled
  against the same ledger.
