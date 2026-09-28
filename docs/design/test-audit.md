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

## Discovery consumed; layer assessment in progress

Main has read all eight discovery ledgers. They cover the140 assigned test files,1240 AST declaration candidates and27 primary support fixtures, with parameter factories manually reviewed by each lane. Discovery was read-only; no test run, paid call or source/test deletion occurred. This is inventory evidence, not automatic acceptance of every retention/deletion recommendation.

Proposed whole-layer retirement targets are orphan `AnalysisScheduler`, the pre-hybrid `core/ledger.ts` reducer, obsolete `enrichBeadsTasks`, and unused `clarityLabel`, together with their test-only consumers. Live `Ledger` types, `HealthCoverage`, Beads filesystem parsing and Monitor presentation remain separate contracts. Other candidates concern duplicate package/association positives, private-property assertions and historical fixture-inventory checks. None is approved merely because a report marks it C/D.

Main identified two discovery-quality caveats:

- The runtime report's claim that175 AST candidates include two `describe` wrappers is inconsistent with the AST script, which only recognizes imported `it`/`test` aliases. A narrow correction has been requested; its283 executed case total agrees with the baseline.
- Imports, construction and dormant scheduler call sites do not establish live legacy semantic authority under strict v11. A second reader is tracing actual entrypoint, restore and queue-population paths. Conversely, the44 failing legacy-fixture tests cannot be deleted without preserving their unique current product contracts, including durable omissions. N00-N04 continuation is intentionally awaiting N05 wiring, not orphan code.

Second read-only assessment has three independent scopes: core/UI obsolete layers and real-host keepers; auxiliary fixture/access redundancy; generic/legacy/health reachability and contract preservation. Main will synthesize exact keeper-first edits and mutation controls after these reports. Source/test baseline remains frozen. In particular, the Beads reader must retain all valid records (not filter backlog), and an empty valid export is not a missing-file failure; proposed fixture repairs must respect the actual reader contract.

## Executed cleanup batches

### B1 — Beads reader keeper, obsolete mutator retirement

The independent second layer confirmed `enrichBeadsTasks` has no shipping caller. Main repaired the direct filesystem keeper first: exact successful record parsing (including unrelated records), valid empty export, actual missing export, malformed JSON/record, duplicate IDs, directory symlink and file symlink. Invalid reads must return no partial records. The unchanged actual Monitor keeper remains the authority proof: closed Beads metadata cannot complete a task or import backlog.

Before deletion, focused keepers passed12/12. Three temporary production-owner controls were caught: removing duplicate rejection failed the duplicate case; bypassing all symlink defenses failed both real-filesystem symlink cases; injecting closed-record completion into `Monitor.refreshBeads` failed the retained Monitor task-status assertion. Both source files were restored byte-identically after each control (Beads SHA256 `31bfd49213f806146a92eb70e7f52a666fce7de6d80532c949875587c7edd460`, Monitor `cf486fc51b525caaed21a9cba3e349eb0847ab02eb3b3cff508e23b28e6901a5`). These are bounded controls, not an exhaustive filesystem race/security proof.

Then Main removed the51-line orphan mutator/import and its redundant test/fixture. Post-removal keepers11/11 pass; format/check pass with the same three historical warnings. Reader and presentation implementation remain unchanged. Full gates and independent cumulative preservation review still follow the cleanup batch; this is not audit completion.

## Completion remains pending

No audit lane or C05-C09 stage is accepted by discovery consumption. Audit results, deletions/keepers, caught mutations, product-defect controls and final LOC/gates will be recorded here as executed. Feature work follows the audit, with final green gates and independent stage acceptance before manual handoff.
