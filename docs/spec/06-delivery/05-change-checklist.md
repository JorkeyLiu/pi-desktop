# 05. Change Checklist

> A practical checklist agents must run before finishing work.  
> Cross-references: [ai-development-workflow](03-ai-development-workflow.md) · [e2e-test-plan](04-e2e-test-plan.md) · [decisions-log](../08-meta/decisions-log.md) · [ADR index](../../adr/README.md) · [BOARD](../../project/BOARD.md)

---

## 0. GitHub Issue Intake

When the prompt includes a GitHub issue URL or an unambiguous issue number for
this repository, complete this gate before the request-start checklist:

- [ ] Issue title, body, labels, comments, and state were fetched.
- [ ] The reported problem was independently verified (reproduced or evidenced
  for a bug; confirmed missing or incomplete and in scope for a feature).
- [ ] Implementation started only after the problem was confirmed to exist.
- [ ] If the problem does not exist: the issue received a verification comment
  and was closed when the conclusion was clear, or left open when inconclusive.
- [ ] After a confirmed fix was merged: the issue received a resolution comment
  and was closed.
- [ ] The comment uses the issue's language.
- [ ] No unrelated issue was commented on or closed.
- [ ] Git push was not inferred from the issue link.

See [R5 — Verify linked GitHub issues](03-ai-development-workflow.md#r5-—-verify-linked-github-issues-before-work-then-reply-and-close).

---

## 0.1 GitHub Pull Request Intake

When the prompt includes a GitHub pull request URL or an unambiguous pull
request number for this repository, complete this gate before rewriting the
change or starting follow-up:

- [ ] Pull request title, body, files, commits, comments, checks, draft
  state, base/head, and linked issues were fetched.
- [ ] The **root-cause bar** was independently judged: real in-scope problem;
  the change actually removes that failure mode at the root; the diff is the
  smallest coherent fix; approach compatible with baseline, security, and
  architecture.
- [ ] Completeness gaps (specs, extra tests, i18n, e2e docs, style, naming)
  were not treated as merge blockers **unless** they are required to prove
  the root-cause fix.
- [ ] If the root-cause bar holds: the pull request was landed first,
  preserving the contributor's commits and authorship.
- [ ] Follow-up started only after the pull request landed.
- [ ] If the root-cause bar fails or a harm blocker exists: the pull
  request was not merged, was not approved as "direction is fine", and a
  comment recorded the evidence. The idea was not silently reimplemented.
- [ ] A draft pull request was not merged unless the user explicitly asked.
- [ ] The comment uses the pull request's language.
- [ ] No unrelated pull request was commented on or merged.
- [ ] The contributor's work was not rewritten or discarded. Unrelated
  publishing was not inferred from the pull request link.

See [R6 — Land a linked pull request only when it fixes the root cause with a minimal diff](03-ai-development-workflow.md#r6-—-land-a-linked-pull-request-only-when-it-fixes-the-root-cause-with-a-minimal-diff).

---

## 1. Request Start Checklist

Before editing any file for a new request:

- [ ] The workspace state is understood and existing uncommitted work is
  identified and preserved.
- [ ] The change is scoped to one logical concern.
- [ ] The delivery scope is noted: what the user asked to change, and whether
  remote publishing was requested.
- [ ] Unrelated work — from the user or other agents — is left untouched.

---

## 2. Impact Analysis

Before starting implementation, answer these questions:

- [ ] What behavior changes does this change introduce?
- [ ] Which specs are affected? (list file paths)
- [ ] Does this change touch an architectural boundary? (process model, IPC, storage, security, plugin API)
- [ ] Does this change affect user-visible or protocol-visible behavior?
- [ ] Is local validation necessary for this change's risk and regression
  scope? If so, what is the smallest targeted check set?
- [ ] Which milestone deliverable does this relate to? (M1–M6, or none)

Reference the [spec update matrix](03-ai-development-workflow.md#3-spec-update-matrix) to determine required doc updates.

---

## 3. Spec Sync Checklist

After implementation (or alongside it):

- [ ] Every affected spec file is updated with the new behavior.
- [ ] If `AGENTS.md` changed: `CLAUDE.md` still mirrors the non-negotiables,
  both files share the same `Policy-Sync:` token, and `pnpm check:agent-policy`
  passes. The reverse applies when only `CLAUDE.md` changed.
- [ ] If architectural boundary changed: ADR is written or updated in `docs/adr/`.
- [ ] If an implementation default changed: `decisions-log.md` entry updated.
- [ ] If baseline frozen decisions are affected: baseline bump + explicit ADR (not MVP-normal).
- [ ] Cross-references between specs are still correct (no stale links).

---

## 4. E2E / Test Doc Checklist

- [ ] If user-visible or protocol-visible behavior changed: new or updated scenario in [04-e2e-test-plan.md](04-e2e-test-plan.md).
- [ ] If a scenario was added or updated, it follows the template (ID, title,
  preconditions, steps, expected, specs, acceptance, milestone, status).
- [ ] If a scenario was added or updated, the traceability matrix in §8 is current.
- [ ] Unit tests added or updated when the change's risk makes them necessary.
- [ ] Integration tests added or updated when an IPC/RPC contract change or
  cross-component regression risk makes them necessary.
- [ ] The smallest necessary targeted local checks passed, or local validation
  was assessed as unnecessary with no separate approval or waiver required.
- [ ] For a code-bearing change, the relevant E2E suites were selected and run
  against the built change; required validation needs no separate user request.
  Documentation-only changes retain their exemption.
- [ ] E2E reused the host development environment already provisioned in the
  working checkout; no `pnpm install`/`npm install` or second dependency/runtime
  environment was created solely for E2E. Any missing/incompatible-host
  exception is recorded with its reason.
- [ ] Results state the tested source, base, and environment, and the affected
  suites were rerun when the executable content changed. Any required suite not
  run is recorded with its reason, alternative validation, and remaining risk;
  delivery remains incomplete until that gate passes.
- [ ] Hosting-platform E2E jobs were observed and reported; a rerun happened
  when the executable content changed after the gate ran.

---

## 5. Change Hygiene Checklist

- [ ] Change is one logical unit (or split into focused changes).
- [ ] No secrets, tokens, or local data in the diff.
- [ ] No `node_modules/`, build artifacts, or release packages in the diff.
- [ ] No unrelated work was discarded, moved, or overwritten.
- [ ] `git diff --stat` reviewed — nothing unexpected.

---

## 6. Pull/Merge Request Checklist

When the change is delivered as a pull/merge request:

- [ ] For a code-bearing change: the relevant E2E ran against the built
  change, or its `NOT RUN` limitation is recorded with reason, alternative
  validation, and remaining risk.
- [ ] The change contains only this task's work, and the description documents
  impacted specs, E2E scenarios, and validation.
- [ ] Required checks and reviews passed when the platform requires them.
- [ ] No unrelated work was discarded, moved, or overwritten, and a genuine
  blocker was reported rather than bypassed.
- [ ] Issue reference is included when applicable (e.g. `Refs #12` or
  `Closes #12`).

---

## 7. App version release checklist (stable tag)

Required for every stable app version bump / tag (D164). Skip only for
documentation-only work or non-release chores.

- [ ] `packages/shared/src/changelog.ts` has a newest-first entry for the
      release version under `en` and every shipped product locale (no leading
      `v`).
- [ ] Highlight counts match across locales; English is the source of truth.
- [ ] Bullets are short user-facing product notes (not raw PR/commit lists).
- [ ] Pre-release-only versions are omitted from the product catalog unless
      product explicitly ships in-app notes for that channel.
- [ ] `packages/shared/src/changelog.test.ts` lists the new version first.
- [ ] `pnpm --filter @pi-desktop/shared test` passes catalog alignment.
- [ ] `README.md` and `README.zh-CN.md` state the current
      `<major>.<minor>.x` release line and contain no toolchain, command,
      Highlights, or roadmap claim the release invalidates.
- [ ] `node scripts/check-release-docs.mjs` passes (version surfaces,
      shipped-locale catalog, README release line).
- [ ] Documentation is in place **before**
      `node scripts/release.mjs <version> --tag` / `git tag v<version>`.
- [ ] GitHub auto-generated release body is treated as web-only, not the
      in-app source ([06-release-runbook.md §4.1](06-release-runbook.md#41-mandatory-release-version-surface-gate-d164--d260)).

---

## 8. Final Definition-of-Done Gate

Before marking work complete, verify **all applicable** conditions under the
user's delivery scope:

| # | Gate | Source |
|---|---|---|
| 1 | Change is small and coherent, with one logical concern | [R2 — Small, coherent changes](03-ai-development-workflow.md#r2-—-small-coherent-changes) |
| 2 | Code/doc implements the planned change | Step 4 of [development loop](03-ai-development-workflow.md#_2-development-loop) |
| 3 | All impacted specs updated | [R1 — Spec-sync](03-ai-development-workflow.md#r1-—-spec-first-spec-sync) |
| 4 | E2E scenarios documented (or confirmed not needed) | [R3 — E2E coverage doc](03-ai-development-workflow.md#r3-—-e2e-coverage-doc) |
| 5 | Targeted checks follow the risk standard; for a code-bearing change the relevant E2E ran against the built change (or its `NOT RUN` limitation is recorded); required tests need no separate user request | Step 7 of development loop |
| 6 | Verification evidence records the tested source, base, suites, result, and environment | [R4 — Record verification evidence](03-ai-development-workflow.md#r4-—-record-verification-evidence) |
| 7 | BOARD updated if milestone deliverable completed | Step 9 of development loop |
| 8 | No secrets, local data, or generated artifacts in the change | [Change hygiene](03-ai-development-workflow.md#_4-change-hygiene) |
| 9 | Unrelated work was preserved | [Git Usage](03-ai-development-workflow.md#_5-git-usage) |
| 10 | If a GitHub issue was linked: verified before work; commented in the issue language; closed when conclusive | [R5 — Verify linked GitHub issues](03-ai-development-workflow.md#r5-—-verify-linked-github-issues-before-work-then-reply-and-close) |
| 11 | If a GitHub pull request was linked: root-cause bar reviewed; accepted only when it actually fixes the problem with a minimal diff; contributor work not discarded | [R6 — Land a linked pull request only when it fixes the root cause with a minimal diff](03-ai-development-workflow.md#r6-—-land-a-linked-pull-request-only-when-it-fixes-the-root-cause-with-a-minimal-diff) |
| 12 | If launch was requested: the app was built and started | Step 12 of development loop |

If any applicable gate fails, the requested integration is **not Done**; report
the blocker without weakening the gate.
