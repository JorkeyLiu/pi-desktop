# 03. AI-Assisted Development Workflow

> Scope: AI agents and human collaborators working on PI-Desktop
> Status: Accepted
> Cross-references: [00-baseline](../00-baseline.md) · [decisions-log](../08-meta/decisions-log.md) · [acceptance-criteria](02-acceptance-criteria.md) · [e2e-test-plan](04-e2e-test-plan.md) · [change-checklist](05-change-checklist.md) · [ADR index](../../adr/README.md)

---

## 1. Core Immutable Rules

The rules below govern every change to the PI-Desktop codebase and documentation. R1–R4 and R7 restate the durable change-quality rules in `AGENTS.md` (spec-sync, small coherent changes, E2E coverage, verification records, and code-bearing E2E); R5 and R6 restate its GitHub issue and pull request handling sections. They cannot be relaxed by an agent without explicit human override.

### R1 — Spec-first / Spec-sync

> **No behavior change without updating the corresponding spec.**

- Every code, config, or UX change that alters observable behavior must update the relevant `docs/spec/` document before or alongside the change.
- Architectural boundary changes (process model, IPC contract, storage ownership, security boundary) also require an ADR — see `docs/adr/README.md`.
- Pure refactor that preserves behavior and API contracts does not require spec updates.

### R2 — Small, coherent changes

> **Prefer the smallest coherent change that fully addresses the task.**

- One logical concern per change. Avoid drive-by cleanup, mass formatting, unrelated dependency bumps, and big-bang rewrites.
- Keep the change reviewable and easy to roll back.
- Structural changes the task actually needs have the same priority as feature work (see `AGENTS.md` § 6).

### R3 — E2E coverage doc

> **Every feature/fix that affects user-visible or protocol-visible behavior must update e2e test documentation.**

- "User-visible": anything the end-user sees or interacts with (UI, CLI output, dialogs, notifications).
- "Protocol-visible": IPC messages, RPC methods, plugin API surfaces, event payloads.
- Document the scenario in `06-delivery/04-e2e-test-plan.md` — even before the automated test exists.
- Internal-only changes (logging format, internal variable rename) do not require e2e doc updates.

### R4 — Record verification evidence

> **State what was actually verified, against which source, with which result.**

- Record, in the delivery report or the relevant coverage document, the tested source, base, the checks and E2E suites run, the result, and the environment.
- A check or suite that could not run is recorded as `NOT RUN` with its reason, alternative validation, and remaining risk.
- Never report a skipped command as passing. An E2E result applies only to the source that actually ran; rerun the affected suites when the executable content changes afterward (later commits, conflict resolution, or review fixes).

### R5 — Verify linked GitHub issues before work, then reply and close

> **A linked GitHub issue is not a task until the reported problem is shown to exist. After the outcome is conclusive, reply on that issue and close it.**

This rule applies when the user prompt includes a GitHub issue URL or an
unambiguous issue number for this repository.

- Fetch the issue (title, body, labels, comments, and state) before changing
  files for the claimed problem.
- Independently verify the claim against the current codebase. For a bug,
  reproduce it or cite concrete code/spec evidence. For a feature or
  improvement, confirm the requested behavior is actually missing or incomplete
  and in scope.
- Do not start implementation until verification confirms the problem exists.
- If the problem does not exist (already fixed, invalid, or a
  misunderstanding): comment with the verification evidence and close the issue
  when that conclusion is clear. If verification is inconclusive, comment with
  what was tried and leave the issue open.
- If the problem exists: implement the smallest coherent change, and once the
  resolution has landed, comment with the resolution and close the issue.
- Write the GitHub comment in the language of the original issue title and
  body. Code, commits, specs, and other repository documentation stay English.
- An issue link authorizes commenting on and closing **that** issue only. It
  does not authorize publishing unrelated work.
- Do not comment on or close unrelated issues. Do not reopen a closed issue
  unless the user explicitly asks.

### R6 — Land a linked pull request only when it fixes the root cause with a minimal diff

> **A linked GitHub pull request lands only when it actually removes the reported failure mode at the root, with the smallest coherent change. A sound direction is not enough. Completeness nits may follow after merge; an incomplete fix may not.**

This rule applies when the user prompt includes a GitHub pull request URL or
an unambiguous pull request number for this repository.

- Fetch the pull request (title, body, files, commits, comments, checks, draft
  state, base/head, and linked issues) before creating a replacement
  implementation or requesting a rewrite.
- Independently verify all of:
  1. The reported problem is real and in scope (same bar as R5).
  2. The change must fix the reported root cause with the smallest coherent
     change — not a nearby symptom, a docs-only restatement, a config
     contract test, or a partial workaround that leaves the original path
     intact.
  3. Extra files, refactors, and spec theater do not compensate for an
     incomplete fix. The approach must still be compatible with the
     baseline, security boundaries, and architecture (or be a justified
     spec-backed amendment).
- Do not reimplement the pull request as a replacement, close it for nits, or
  ask the contributor to start over when (1)–(3) hold.
- If (1)–(3) hold:
  1. Land **that** pull request first, preserving the contributor's commits
     and authorship.
  2. Missing additional test coverage, documentation, naming cleanup,
     formatting, and other non-blocking polish are follow-up work **only
     when they are not required to prove the root-cause fix**. Build,
     typecheck, relevant existing test, required E2E, security, data-safety,
     protocol-compatibility, and merge-conflict failures remain landing
     blockers.
  3. Landing blockers that would break the integration target (the change does
     not compile, fails existing tests for the changed area, or has merge
     conflicts) may receive the smallest additional commits **on top of** the
     author's work so the change can land. Do not discard the author. Do not
     rewrite the design. Do not expand the diff beyond the root-cause fix.
  4. Further improvements are ordinary follow-up work.
  5. Comment on the pull request in its language: acknowledge the
     contribution, state what was merged, and list follow-up if any.
- If (1)–(3) fail, or a harm blocker exists (secrets, sandbox or privilege
  bypass, malicious or clearly destructive changes, out-of-scope reversal of
  a frozen decision, unrelated drive-by payload): do not merge, do not
  approve as "direction is fine, follow up later", and comment with the
  evidence in the pull request's language. Prefer a minimal completion of
  the author's approach when that approach can actually reach the root
  cause. Do not silently reimplement the same idea as if the pull request
  never existed unless the user asks to take the work over.
- Do not merge a draft pull request the author has not marked ready, unless
  the user explicitly asks to merge the draft. Comment with the review and
  wait until it is ready.
- A pull request link authorizes reviewing, commenting on, and merging
  **that** pull request when this rule applies. It does not authorize
  publishing unrelated branches.
- Do not comment on or merge unrelated pull requests. An already-merged pull
  request is not reopened; remaining gaps become ordinary follow-up.
- When both an issue and a pull request are linked, R6 applies to the pull
  request and R5 still applies to the issue after the merged outcome.

#### R6.1 — Temporary pull-request type restriction

> **While this subsection is in force, outside contributions are limited to
> `perf` and `fix` pull requests; maintainer-planned work keeps every type.**

- Effective 2026-09-26 until a maintainer removes this subsection.
- The restriction governs outside contributions. Maintainers — accounts with
  write access to this repository, plus the branches and automated agent work
  they direct — keep every change type, including `feat`.
- An outside pull request of any other change type — `feat`, `refactor`,
  `docs`, `test`, `chore`, `build`, or `ci` — is not a landing candidate.
  Comment with this policy in the pull request's language, then close it
  without merging, and do not reimplement it as a replacement while the
  restriction is in force. The type is read from the pull request's title and
  commits; relabelling other work as `fix` or `perf` does not qualify it.
- Feature intent goes to a feature request issue, not to a pull request.
- `fix` and `perf` pull requests still carry the full R6 bar: the real root
  cause, the smallest coherent change, and no harm blockers.
- Closing a pull request whose type is out of scope does not violate R6's "do
  not discard contributor work" clause; that clause protects an in-scope
  root-cause fix.
- Removing this subsection lifts the restriction. It is not a permanent
  narrowing of the contribution scope.

### R7 — Code-bearing changes require relevant E2E

> **Every code-bearing change must run the relevant E2E suites against the
> built change.**

This rule applies to changes that modify executable or runtime-affecting
content, including `apps/`, `packages/`, `crates/`, runtime scripts, build or
CI configuration, packaging behavior, protocol behavior, and persisted data.
Documentation-only changes are exempt when they do not alter executable
behavior.

E2E execution is mandatory for code-bearing changes. Select suites using the
regression-surface guidance in `04-e2e-test-plan.md`; build, typecheck,
lint, unit tests, integration tests, manual review, and source inspection do
not replace relevant E2E.

Required validation is part of implementation and does not require a separate
user request to run tests.

If a required suite cannot run in the current environment, record the suite,
reason, alternative validation, and remaining risk as `NOT RUN`. Delivery
remains incomplete until the suite passes. A failed required suite blocks
declaring the change delivered until the failure is classified and fixed.

Rerun the affected suites when the executable content changes after the gate
ran (later commits, conflict resolution, or review fixes). Otherwise the
recorded result stands. Always state the source the recorded E2E evidence
applies to.

### GitHub issue templates

`.github/ISSUE_TEMPLATE` is the only public intake path (`blank_issues_enabled:
false`). English is the source label language; Chinese remains on the same
fields.

- **Bug report** requires: description, reproduction steps, expected behavior,
  actual behavior, app version, and OS. Logs, extra environment, and
  screenshots are optional. Settings → Info prefills version, OS, and
  environment when opened from the app (D313).
- **Feature request** requires: problem and proposed change. Alternatives and
  extra context are optional.

Do not weaken these required fields. Blank issues stay disabled.

---

## 2. Development Loop

Every change follows this sequence. Steps may be iterated if the implementation reveals new requirements. If the prompt includes a GitHub issue, complete R5 verification before step 1. If the prompt includes a GitHub pull request, complete the R6 root-cause review (and merge only when the change actually fixes the problem with a minimal diff) before starting a replacement or follow-up implementation.

```
0. If a GitHub issue is linked: verify the claim (R5) before any implementation
0b. If a GitHub pull request is linked: review root cause and minimality (R6); merge only when it actually fixes the problem before starting follow-up
1. Prepare: confirm the workspace state and preserve unrelated work
2. Read baseline + relevant specs
3. Plan change + list impacted specs and necessary validation
4. Implement
5. Spec-sync: update specs / ADR / decisions-log if needed
6. E2E doc: update or add e2e scenarios when R3 applies
7. Validate: run targeted checks necessary for the change's risk; for a code-bearing change run the relevant E2E suites (R7)
8. Record evidence: tested source, base, suites, result, environment (R4)
9. BOARD: update if milestone-related
10. Deliver: integrate through the integration flow the operator uses
11. Verify: confirm the delivered change matches the validated one; rerun affected suites when the executable content changed
12. Launch: if requested, build and start the app
```

### Step-by-step

| Step | Action | Output |
|---|---|---|
| **0. Issue verify** | When a GitHub issue is linked, fetch it and independently verify that the reported problem exists. Stop here (comment, and close only if conclusive) when it does not. | Verified issue, or a comment and close/leave-open decision. |
| **0b. PR review** | When a GitHub pull request is linked, fetch it and independently verify that it fixes the reported root cause with the smallest coherent change. Merge only when it does; start follow-up only after it lands. Stop (comment, do not rewrite) when it does not. | Merged contributor PR plus follow-up plan, or a comment and no merge. |
| **1. Prepare** | Confirm the workspace state, preserve unrelated work, and set up the change. | A scoped workspace for the task. |
| **2. Read** | Read `00-baseline.md` and any specs relevant to the change area. | Mental model of constraints. |
| **3. Plan** | Describe the intended change. List every spec, ADR, and e2e scenario that will need updates, and assess whether validation is necessary. | Change plan + impact and validation list. |
| **4. Implement** | Write code, config, or assets. | Changed files. |
| **5. Spec-sync** | Update specs per the impact list. Add ADR if architectural. Update `decisions-log.md` if an implementation default changes. | Updated docs/spec/\* and/or docs/adr/\*. |
| **6. E2E doc** | When R3 applies, add or update scenario entries in `04-e2e-test-plan.md` and link to acceptance criteria IDs (A–H). Otherwise, confirm no scenario update is needed. | Updated e2e test plan, or confirmed not applicable. |
| **7. Validate** | Use change risk and regression scope to select the smallest useful checks. For a code-bearing change run the relevant E2E suites; a suite that cannot run is recorded as `NOT RUN` and keeps delivery incomplete. | Targeted check and E2E results, or an explicit environment limitation. |
| **8. Record evidence** | Record the tested source, base, checks, E2E suites, result, and environment (R4). | Verification evidence. |
| **9. BOARD** | If the change completes a milestone deliverable, update `docs/project/BOARD.md`. | Updated board. |
| **10. Deliver** | Deliver the change through whatever integration flow the operator uses. | Integrated change, or a recorded blocker. |
| **11. Verify** | Confirm the delivered change is the one that was validated; rerun affected suites when the executable content changed after the gate ran. | Delivered change matching its recorded evidence. |
| **12. Launch** | When requested, build and start the app. | Running app includes the delivered change. |

### Local Validation and E2E Execution Policy

- Local validation is risk-based rather than an automatic prerequisite.
  Documentation-only changes and low-risk mechanical edits normally require no
  local tests or checks. No separate approval or waiver is needed to skip
  unnecessary checks; the relevant E2E requirement still applies to
  code-bearing changes.
- Changes with material regression risk, including security boundaries,
  protocol contracts, data migrations, build configuration, or widely shared
  behavior, normally require the smallest targeted non-E2E validation that can
  address that risk. A full local suite is not the default.
- E2E scenario documentation and E2E execution are separate concerns. R3 still
  requires scenario updates for user-visible or protocol-visible behavior.
- Every code-bearing change must run the union of E2E suites required by the
  affected regression surfaces. The available commands are defined by the root
  `package.json` and the selection matrix in `04-e2e-test-plan.md`.
- E2E may use the working checkout's source, but it must reuse the host
  dependency/runtime environment. Do not reinstall the repository environment
  for each run; only missing or incompatible host dependencies justify
  installation or rebuild, and that reason must be recorded. Temporary
  profiles, data, sockets, ports, logs, and artifacts remain isolated from the
  host's mutable runtime state.
- If the environment cannot run a required suite, record the suite, reason,
  alternative validation, and remaining risk as `NOT RUN`. Delivery remains
  incomplete until the suite passes.
- Hosting-platform E2E jobs are observed and reported; rerun the affected
  suites when the executable content changes after the gate ran. Otherwise the
  recorded result stands.

### Marketplace/update diagnosis gate

Plugin update incidents require an evidence-first prompt flow before code
changes:

1. Capture the exact plugin ID, installed version, displayed version, expected
   release, catalog URL, and observation time.
2. Fetch the live catalog and inspect the exact entry, then inspect the local
   catalog cache and installed registry independently.
3. Classify the failure boundary: publisher/catalog data, fetch/cache fallback,
   host version comparison, IPC propagation, or renderer presentation.
4. Run `pnpm check:marketplace -- --url <catalog-url> --plugin <id>`. Missing
   `shasum`, `url`, positive `sizeBytes`, or `permissions`, or a catalog
   `author` that is not a string (for example `{ name, url }` copied from a
   plugin manifest), is a release-data failure, not evidence of a stale
   renderer. Incomplete releases remain non-installable.
5. Reproduce with a fixture containing unsorted versions and incomplete
   metadata before changing host or renderer code.

The agent must state which boundary failed and what evidence rules out the
other boundaries. A client-side fallback may preserve safe discovery, but it
must not be used to conceal an invalid marketplace release.

---

## 3. Spec Update Matrix

Which change types require which doc updates.

| Change type | Spec update | ADR | Decisions-log | E2E doc | BOARD |
|---|---|---|---|---|---|
| New feature (user-visible) | Related domain spec | If architectural boundary | — | New scenario | If milestone deliverable |
| Bug fix (user-visible) | Related spec if behavior clarified | — | — | New or updated scenario | — |
| Bug fix (internal) | — | — | — | — | — |
| Refactor (behavior preserved) | — | — | — | — | — |
| Architectural change | Related specs + baseline | **New ADR** | Update entry if default changes | Update affected scenarios | — |
| New IPC/RPC method | `03-runtime/01-ipc-protocol.md` or `06-host-rpc-protocol.md` | If contract boundary | — | New protocol scenario | — |
| Plugin API addition | `07-plugins/03-plugin-api.md` | If boundary change | — | New plugin scenario | If M4 deliverable |
| Security change | `05-security/01-security.md` | If boundary change | Update if D001–D010 touched | New security scenario | — |
| UX change | Related `04-ux/` spec | — | — | New UI scenario | — |
| Spec-only update | The spec itself | — | — | — | — |
| Chore (deps, tooling) | — | — | If tooling decision | — | — |
| **App version release / stable tag** | `06-delivery/06-release-runbook.md` (mandatory version-surface gate before tag: shipped-locale `packages/shared/src/changelog.ts`, its test list, all workspace/Cargo/`APP_VERSION` versions, and the release line in `README.md` + `README.zh-CN.md`) | — | If release policy changes | Confirm E2E-067B still accurate | If milestone ship |

---

## 4. Change Hygiene

- Keep changes small, focused, and reviewable (R2). One logical concern per
  change; no drive-by cleanup.
- Never include secrets, API keys, tokens, passwords, local-only data (user
  configs, session data, logs), `node_modules/`, build artifacts, release
  packages, or generated files that should be rebuilt.
- Repository documentation, specs, and ADRs stay in English.
- Review the complete diff before finishing; `git diff --stat` and
  `git diff --check` catch unexpected files and whitespace problems.

---

## 5. Git Usage

Git layout, branching, commits, pushes, and integration are the operator's
choice. No repository rule requires a particular branch, worktree, ancestry,
rebase, merge, or push flow. Use whatever layout is convenient for the task
and the hosting platform's equivalent tools as needed.

Two rules still apply regardless of layout:

- Keep unrelated work out of the change (R2).
- Never discard work you did not produce (see `AGENTS.md` § 5).

---

## 6. Definition of Done

A change is **Done** when all applicable conditions are true:

1. Code (or doc) implements the planned change as a small, coherent change (R2).
2. All impacted specs are updated (R1).
3. E2E scenarios are documented, or confirmed not needed per §3 (R3).
4. Necessary targeted validation passes.
5. For a code-bearing change, the relevant E2E gate has run, or the
   environment limitation is recorded as `NOT RUN` and delivery remains
   incomplete until that suite passes (R7).
6. Verification evidence is recorded honestly: the tested source, base,
   suites, result, and environment; what ran, what did not, and residual risk
   (R4).
7. BOARD is updated if a milestone deliverable completed.
8. No secrets or local data are present in the change.
9. If a GitHub issue was linked: the claim was verified before implementation;
   the issue received a comment in its language; and the issue was closed when
   the outcome was conclusive (R5).
10. If a GitHub pull request was linked: the root-cause bar was reviewed; the
    pull request was accepted only when it actually fixed the problem with a
    minimal diff; the contributor's work was not discarded (R6).
11. If launch was requested after delivery: the app was built and started.

### Release / version-tag gate

When the change is a **stable app version release** (version bump + tag),
Definition of Done also requires, **before** the tag, that every
version-bearing surface describes the new version: the shipped-locale in-app
changelog entries in `packages/shared/src/changelog.ts` (English and every
shipped product locale, with aligned highlight counts) with its `changelog.test.ts` list, every workspace
`package.json` (including `docs/package.json`), the Cargo workspace version and
`host-core` lockfile entry, `APP_VERSION`, and the release line stated in
`README.md` + `README.zh-CN.md`. `node scripts/check-release-docs.mjs` must
pass; `scripts/release.mjs` runs it and refuses to tag otherwise. See
[06-release-runbook.md §4.1](06-release-runbook.md#41-mandatory-release-version-surface-gate-d164--d260),
D164, and D260. GitHub release notes are not a substitute.

---

## 7. Forbidden Practices

| Practice | Why |
|---|---|
| Committing secrets | Security violation |
| Changing behavior without a spec update | Violates R1; specs become unreliable |
| Skipping e2e doc for user-visible changes | Violates R3; traceability gap |
| Declaring a code-bearing change complete without running the relevant E2E | Violates R7; cross-process behavior stays unverified |
| Treating the full local test/check suite as an automatic prerequisite | Ignores risk-based validation and delays delivery without evidence of need |
| Discarding, moving, or overwriting unrelated work | Destroys another task's work |
| Mixing unrelated changes into the same change | Blurs scope and weakens review |
| Modifying baseline frozen decisions without ADR + version bump | Baseline is frozen; changes need formal process |
| Including generated artifacts that should be rebuilt | Repo bloat, merge conflicts |
| Reporting a skipped or unrun command as passing | Dishonest evidence; hides unverified behavior |
| Implementing a linked GitHub issue without verifying the problem exists | Violates R5; wastes work on invalid or already-fixed claims |
| Closing a linked GitHub issue without a comment in the issue language | Violates R5; leaves no public record of the outcome |
| Closing, rewriting, or requesting a restart of a linked pull request that already fixes the root cause with a minimal diff, solely for nits | Violates R6; discards the contributor's work |
| Blocking merge of a root-cause-complete linked pull request solely for missing specs, extra tests, style, or agent-workflow completeness | Violates R6; those are follow-up after merge |
| Merging a linked pull request that only has a sound direction, leaves the original failure mode, or is larger than the smallest coherent fix without a stated reason | Violates R6; direction is not enough |
| Merging a linked pull request that introduces a harm blocker | Violates R6 |
| Discarding a contributor's work to land a linked pull request | Violates R6; landing fixes go on top of the author's commits |
| Tagging a stable app release without updating `packages/shared/src/changelog.ts` for every shipped locale | Violates D164 / D345 / release runbook; in-app What's new is empty for that locale and version |
| Tagging a stable app release while `README.md` / `README.zh-CN.md` still state an older release line, or bypassing `scripts/check-release-docs.mjs` with `--skip-docs-check` | Violates D260 / release runbook; published documentation advertises a version the release no longer matches |

---

## 8. Acceptance Criteria for This Workflow

This workflow spec itself is accepted when:

- [ ] R1–R7 are stated clearly and cross-linked to relevant specs.
- [ ] Development loop is documented and referenced by `AGENTS.md`.
- [ ] Spec update matrix covers all change types in the baseline.
- [ ] Change hygiene keeps secrets, local data, and generated artifacts out of
      the change.
- [ ] Verification evidence records the tested source, base, suites, result,
      and environment; skipped checks are recorded, never reported as passing.
- [ ] Relevant E2E execution is mandatory for code-bearing changes, without a
      separate test request; E2E documentation remains mandatory under R3.
- [ ] Local validation is risk-based; unnecessary checks may be skipped.
- [ ] Unrelated work and other agents' work are never discarded.
- [ ] Definition of Done is complete and actionable.
- [ ] Forbidden practices list covers known risk areas.
- [ ] `AGENTS.md` points to this doc, `04-e2e-test-plan.md`, and `05-change-checklist.md`.
- [ ] Linked GitHub issues are verified before implementation, then commented
      on in the issue language and closed when conclusive.
- [ ] Linked GitHub pull requests land only when they fix the reported root
      cause with a minimal diff; contributor work is not discarded for nits.
- [ ] Outside contributions are limited to `perf` and `fix` pull requests while
      the temporary type restriction in R6.1 is in force.

- [ ] All indexes updated (NAV, delivery README, spec README, docs README, BOARD).
