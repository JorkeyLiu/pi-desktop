# Message Durability Recovery Runbook

> Status: **plan only — no data has been recovered, replayed, cleared, or otherwise
> touched by any code change.** Nothing in this repository currently provides a
> replay or restore command; see §6.

This runbook covers a profile that an older build left behind: queued transcript
appends that the Host refused, plus quarantined ("dead letter") appends. It does
not change product behavior or persistence schema. Fixed-code behavior is
described by the outbox durability paragraphs in
`docs/spec/03-runtime/04-data-storage.md` (`## Active-turn steering transcript
reservations`, "The outbox likewise keeps…") and `docs/spec/03-runtime/02-agent-runtime.md`.

## 1. What the fixed build already does on its own

- The Host accepts the runtime's real fractional `durationMs` (`f64`, finite and
  non-negative; legacy integers still load) on append, inflight, revision,
  replace and import. The old `i64` type refused the fraction with
  `INVALID_PARAMS`, which is exactly how pending rows accumulated.
- `session-message-outbox.json` drains automatically after a normal launch: the
  queue is ordered per enqueue and drains in order once the Host is reachable.
- A payload the fixed Host still refuses (`INVALID_PARAMS`) is quarantined on the
  first refusal and no longer blocks other sessions or rows.
- `session-message-outbox.dead-letter.json` is **never replayed automatically.**
  No retry, timer, boot path, or shutdown path re-enqueues a dead letter.
- At the 1024-entry cap a new append is rejected and logged
  (`session persistence outbox is full`, with key/session); it is not reported as
  saved. Dead letters keep the newest 256 payloads (oldest discarded first). Ids
  rejected at enqueue were only logged, so **the complete set of rejected messages
  is not fully retained** — inventory in §5 cannot promise completeness.

Two Main processes sharing one data directory are a last-writer-wins risk
(outbox JSON rewrite is whole-file), but no overwrite has been confirmed. Treat
it as a precondition (§2), not as a proven cause of loss.

### 1a. Transcripts that are already interleaved are not repaired

An older build could append a new turn's user row before the previous turn's
queued rows reached the host, leaving a finished older reply physically after
the user's next message in the same session. The admission fence described in
`03-runtime/04-data-storage.md` (`## 5. Write paths`) prevents new interleavings;
it **does not** repair a profile that already contains one.

The fence runs twice: a preflight before the turn row exists, and an admission
check immediately before the direct user-row append, so a row the previous
turn settles while a prompt is in its launch/`beginTurn` window is written
ahead of the user row or refuses the prompt. It closes that normal reply race;
it does not promise ordering against every background stream that may enqueue
after admission.

An existing interleaved turn is therefore a recovery case, not a display bug:

- Never reorder, rewrite, or "sort" transcript lines or `seq` values in place,
  and never edit `pi.sqlite` to match the expected order — the transcript file
  is the source of truth and the index is derived, so an in-place edit
  desynchronizes both. The renderer keeps the physical order it reads.
- Diagnose on the offline §3 backup copy only: identify the later turn's rows
  (their own `createdAt`/message ids) and the older turn's rows that landed
  after them. Count both classes before deciding anything (§4).
- Any repair is a replay-class operation and needs the §6 preconditions: verified
  tooling that reads the backup, an ordered plan, per-item host outcomes, and
  explicit user approval. A message is never reported saved, moved, or recovered
  by a tool that has not produced that evidence.
- If a repair cannot be planned without inventing ids, rewriting payloads, or
  guessing turn ownership, stop (§8) and leave the originals untouched.


## 2. Prerequisites (all mandatory, user-coordinated)

1. Quiesce every writer, coordinated with the user: stop the Desktop app and any
   second Main/host process, agent runtime, or script pointed at the same data
   directory. Do not kill processes by guessed PID; identify each one first by its
   command line, data directory (`~/.pi-desktop`, a selected `data/` directory, or
   `PI_DESKTOP_DATA_DIR`), and its child `pi-desktop-host-core`.
2. Confirm exactly one profile / one writer remains, and that it is stopped.
3. Agree a backup destination with the user: a secure, user-approved location
   outside the repository and outside the session scratch directory.

## 3. Consistent backup before any inspection or edit

Back up as one consistent set — the SQLite file alone is not a restore unit:

```text
<profile>/pi.sqlite (+ -wal / -shm)
<profile>/sessions/<sessionId>.jsonl
<profile>/sessions/<sessionId>.revisions.jsonl
<profile>/sessions/<sessionId>.snapshots.jsonl
<profile>/sessions/<sessionId>.inflight.json
<profile>/session-message-outbox.json
<profile>/session-message-outbox.dead-letter.json
```

- Preferred: copy with the app closed, preserving file metadata.
- Alternative while readers exist: take the database through the SQLite online
  backup API (`.backup` / `VACUUM INTO`) opened **read-only** on the source, so a
  WAL checkpoint cannot tear the copy.
- Record an offline ledger next to the copy: per-file size, SHA-256, and row/message
  counts. The ledger is the reference for every later count comparison (§8).
- Never commit profile files, transcripts, or the ledger into the repository; never
  dump outbox/dead-letter contents into shared logs (payloads contain user text).

## 4. Fixed writer, then offline inspection

1. Upgrade to a build containing the `f64` throughput contract, then start it once
   against the single confirmed profile so queued pending rows drain. This is the
   only step that writes to the profile, and it writes through normal host paths.
2. Inspect offline against the **backup copy**, never the live profile: classify
   each outstanding item as

   | Class | Evidence |
   | --- | --- |
   | durable | message id present in `sessions/<id>.jsonl` and indexed in `pi.sqlite` |
   | pending | still only in `session-message-outbox.json` |
   | dead letter | present in `session-message-outbox.dead-letter.json` |
   | checkpoint | only in `<sessionId>.inflight.json` |
   | not found | claimed only by logs or runtime state |

   Report counts per class before deciding anything.
3. Validate candidate payloads through the fixed Host against an **isolated copy**
   of the backup (§7), never against the live profile.

## 5. Rejected-newest inventory

Ids that the cap rejected appear in application logs; correlate them with
`pi.sqlite`, the JSONL transcripts, and runtime checkpoints:

- Use exact keys only — `sessionId` + `messageId` — and never invent or rewrite ids.
- The host treats `session.appendMessage` as an idempotent update keyed by id;
  it does not compare stored content, so a same-id row with different content is a
  silent collision. Compare content for every replayed id before replay.
- `usage` entries are not replayed without their ledger; verify turn/usage
  idempotence from the host records rather than assume it.
- Idempotence for append does not repair a message that exists with the wrong
  payload: such ids need an explicit decision by the user, not a forced overwrite.

## 6. Replay: what is allowed, and what does not exist yet

No replay, restore, or compaction command exists in this repository (`scripts/`
has no replay entry point; `session-message-outbox.dead-letter.json` has no
consumer other than `session.delete`). Do not hand-edit the JSON queues: the files
are whole-file rewrites with ordering, newest-256 truncation, and dedupe rules that
editing corrupts.

A production replay is therefore **not authorized by this document**. It requires
first: verified tooling that reads the backup, plans an ordered list, and reports
per-item outcomes; then reconciliation of those outcomes against the durable
classes; then explicit user approval. Replay must preserve:

- enqueue order, parent before child (user → assistant → tool result → later turn);
- per-session ordering within that order;
- valid `sessionId`/`turnId`; a missing or cross-session turn is omitted by the
  host, which changes what the user sees, so it must be reported, not assumed.

## 7. Dry run

Restore the §3 backup into a temporary directory, run the fixed Host against that
copy only, and produce the plan with counts. A dry run must leave the production
profile byte-identical (verify via the §3 ledger). Nothing in a dry run may be
reported as a recovered message.

## 8. Stop conditions

Stop and return to the user when any of these hold:

- backup ledger counts do not match the live profile, or a file hash changed after
  the backup was taken (writer was not actually quiesced);
- any ordering violation or same-id content collision is found;
- an old writer or a second Main process reappears on the same data directory;
- the fixed Host refuses a payload class that the ledger classified as recoverable;
- a replay path would need an invented id, or would drop throughput/usage stats to
  force acceptance. A message is never reported saved when its stats were stripped.

## 9. Immutable quarantine and audit

The dead-letter file and the backup are immutable originals: copy, never edit or
truncate in place, and never delete before the user signs off. Keep, alongside the
originals, the hash/count ledger, the dry-run plan, and a replay ledger (what was
replayed, host outcome, where it landed). `session.delete` also drops that
session's quarantined appends, so deleting a session discards its recovery source.

## 10. Rollback

Rollback restores the §3 consistent set while every writer is quiesced. Never
restore `pi.sqlite` alone: a database restored without matching transcripts and
queues rebuilds the index from the wrong source. After restore, verify per-session
message counts, one `session.get` scoped read, no new rejection in the logs, and no
persistence error surfaced in the UI.

## 11. Verification reference

The contract this recovery depends on can be re-checked without any live instance,
provider, or network — temporary data directory only:

```bash
PI_DESKTOP_HOST_BIN=target/debug/pi-desktop-host-core \
  node scripts/e2e-message-durability-contract.mjs
```

It proves a real fractional `durationMs` survives append and replace, and that
negative / fractional-count / non-numeric throughput payloads are refused with
`INVALID_PARAMS` rather than stored with stripped stats
(`docs/spec/06-delivery/04-e2e-test-plan.md`).
