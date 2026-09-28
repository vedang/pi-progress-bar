# Test audit before feature completion

## Current owner order (2026-09-28)

The owner explicitly superseded the earlier post-manual-review audit deferral:

1. Audit all tests and delete genuinely useless tests.
2. Complete pending generic subtasks and continuation implementation, QA and independent reviews.
3. Hand off for owner manual review.

`pi-progress-barroot-hmv` is active, no longer blocked by feature epics or manual gate. `pi-progress-barroot-y86` remains open and now follows the audit plus both feature epics. No release, installation, push or branch creation is authorized.

Owner also selected **persist omission summaries**: skipped/coalesced/oversized optional subtask analysis must remain visible after reload. Bounded persistence/schema changes are authorized; Main owns design and verification. No raw content retention or automatic retry. `ru7` remains an implementation requirement, not a useless-test exemption.

## Baseline

Source revision `a3e53359`; authorization-only successor `44755ffc`.

- 140 test files inventoried;137 offline files executed,3 paid live suites inventoried but not run.
- Unit:1935 pass,44 fail (coverage-scheduler34, coverage-storage-monitor10).
- Integration:86 pass,0 fail.
- Production TS:39,206 lines; test TS:39,867; support TS/JSON/MD:3,077. Counts are not deletion targets.
- No audit deletion or source change has occurred at baseline.

Full JSON baseline results, exclusive lane assignments and working evidence live under `.agents/plans/20260928T105034--audit-tests-before-completion__active/` (local supplementary artifacts); this document and Beads retain authoritative decisions/results.

## Ownership and method

Eight read-only declaration lanes: mandatory core/state/scheduling; health/detail/activity; access/tool evidence; subtask storage/admission/proposal; subtask reporting/runtime/gateway; advisory; continuation; UI/extension/package/host surfaces. Mixed suites name the actual production owner per declaration, not merely a filename prefix. Every declaration is assigned exactly once; differing parameter-row dispositions are recorded separately. Related support, CI routing and auxiliary QA scenarios are included. Still-held-out corpus bodies are not exposed during audit.

Each declaration receives R/F/C/D: retain, repair assertion, consolidate, delete. Candidate evidence includes exact name/location, credible detected regression, production owner/non-test callers, stronger remaining keeper (or why no contract exists), history/rationale, source/support deletion unlocked, risk and focused command. Missing evidence means retain pending investigation. Failing, slow or static is not a deletion criterion.

After exhaustive ledgers, a second read-only assessment names strongest keepers and assertions to carry before removal. Main applies serial owner-boundary batches, then independent cumulative preservation review and deliberate production-owner mutations for restored contracts. Mutations restore source byte-for-byte. Unique failing contracts remain visible until repaired; audit must not manufacture an all-green result by deleting product requirements.

Main owns all test edits, validation and acceptance. Children initially read only. No source/test edits while Vitest runs. Prefer real entrypoint/native-host/provider-boundary proof over mocks that supply the asserted ordering or result. Remove obsolete test-only seams only after checking production callers and independent contracts. Strict v11, no compatibility facade or migration.

Repository-native equivalents replace unavailable OpenClaw-specific campaign tooling: configured Vitest/offline guard, Make format/check/test, separate integration when unit fails, Biome/TypeScript/Knip, JJ diffs, independent native read-only preservation reviewers. Paid semantic proof occurs later under existing finite-manifest/ledger authorization; audit does not confer new semantic acceptance.

## Completion remains pending

No audit lane or C05-C09 stage is accepted by baseline capture. Audit results, deletions/keepers, caught mutations, product-defect controls and final LOC/gates will be recorded here as executed. Feature work follows the audit, with final green gates and independent stage acceptance before manual handoff.
