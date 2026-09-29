# Test audit before feature completion

## Current status (2026-09-29)

The exhaustive audit is **complete**: `pi-progress-barroot-hmv` closed with independent cumulative review `584dfc88` and bookkeeping `d929dcc2`. Subsequent feature repairs and legacy retirement retain their own evidence. The combined implementation QA/review (C11/N07) is also complete at `3a03824d`, and the coordinator notified the owner that it is ready to test; y86 is superseded, not proof of manual testing. See [current scope](semantic-qualification-status.md). No new audit campaign is required.

## Historical owner order (2026-09-28)

The owner explicitly superseded the earlier post-manual-review audit deferral:

1. Audit all tests and delete genuinely useless tests.
2. Complete pending generic subtasks and continuation implementation, QA and independent reviews.
3. Hand off for owner manual review.

At that time, `pi-progress-barroot-hmv` became active and was no longer blocked by feature epics or the manual gate. `pi-progress-barroot-y86` then followed the audit plus both feature epics; the current owner scope above supersedes that sequence. No release, installation, push or branch creation is authorized.

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

## Discovery and second-layer assessment consumed

Main has read all eight discovery ledgers. They cover the140 assigned test files,1240 AST declaration candidates and27 primary support fixtures, with parameter factories manually reviewed by each lane. Discovery was read-only; no test run, paid call or source/test deletion occurred. This is inventory evidence, not automatic acceptance of every retention/deletion recommendation.

Proposed whole-layer retirement targets are orphan `AnalysisScheduler`, the pre-hybrid `core/ledger.ts` reducer, obsolete `enrichBeadsTasks`, and unused `clarityLabel`, together with their test-only consumers. Live `Ledger` types, `HealthCoverage`, Beads filesystem parsing and Monitor presentation remain separate contracts. Other candidates concern duplicate package/association positives, private-property assertions and historical fixture-inventory checks. None is approved merely because a report marks it C/D.

Main identified two discovery-quality caveats:

- The runtime report incorrectly counted two `describe` wrappers. Its correction confirms175 actual declarations,283 parameter-expanded cases and no omitted declaration; wrapper rows were surplus metadata.
- The second reader traced strict-v11 entrypoints, restore validation and queue population: legacy semantic coverage cannot be populated through the shipping lifecycle. The34 scheduler failures stop at removed workbook admission; the10 storage failures inject forbidden v10 coverage metadata into v11. These are obsolete-fixture failures, not44 demonstrated live defects. Their unique current contracts still need generic keepers, including durable omissions, no-refund/deep-source/span restore and selected recovery/owner-order ports. Keep them visible until coherent feature-phase retirement. The adapter and `HealthCoverage` remain live; N00-N04 continuation is deliberately awaiting N05 wiring, not orphan code.

All three second-layer reports are consumed: core/UI obsolete layers and real-host keepers; auxiliary fixture/access redundancy; generic/legacy/health reachability and contract preservation. Main is executing their evidence-backed keeper-first cleanup serially. Their static reachability findings supersede discovery's blanket legacy-liveness claims. In particular, the Beads reader must retain all valid records (not filter backlog), and an empty valid export is not a missing-file failure; proposed fixture repairs must respect the actual reader contract.

## Executed cleanup batches

### B1 — Beads reader keeper, obsolete mutator retirement

The independent second layer confirmed `enrichBeadsTasks` has no shipping caller. Main repaired the direct filesystem keeper first: exact successful record parsing (including unrelated records), valid empty export, actual missing export, malformed JSON/record, duplicate IDs, directory symlink and file symlink. Invalid reads must return no partial records. The unchanged actual Monitor keeper remains the authority proof: closed Beads metadata cannot complete a task or import backlog.

Before deletion, focused keepers passed12/12. Three temporary production-owner controls were caught: removing duplicate rejection failed the duplicate case; bypassing all symlink defenses failed both real-filesystem symlink cases; injecting closed-record completion into `Monitor.refreshBeads` failed the retained Monitor task-status assertion. Both source files were restored byte-identically after each control (Beads SHA256 `31bfd49213f806146a92eb70e7f52a666fce7de6d80532c949875587c7edd460`, Monitor `cf486fc51b525caaed21a9cba3e349eb0847ab02eb3b3cff508e23b28e6901a5`). These are bounded controls, not an exhaustive filesystem race/security proof.

Then Main removed the51-line orphan mutator/import and its redundant test/fixture. Post-removal keepers11/11 pass; format/check pass with the same three historical warnings. Reader and presentation implementation remain unchanged. Full gates and independent cumulative preservation review still follow the cleanup batch; this is not audit completion.

### S1/L1/U1 — unreachable source/test layers

Removed `AnalysisScheduler` plus its two suites, the old `core/ledger.ts` reducer plus its suite, and unused `clarityLabel` plus its suite. Source caller searches show no remaining reference to these removed functions. Current Monitor/hybrid/lifecycle/checkpoint/health/widget keepers pass165/165. No old scheduler policy was transplanted and no live health type was removed.

The first check correctly found four newly unused type exports in `src/core/types.ts`. Removed only their `export` modifiers; all definitions and exported live `Ledger` remain unchanged. This is justified declaration cleanup, not a type redesign or Knip exemption. Format/check then passed (three historical warnings).

Cumulative B1+S1/L1/U1 full unit result:1918 pass/44 unchanged legacy-fixture failures; separate integration86/86 pass. The pass-count delta is +4 repaired filesystem rows minus21 parameter-expanded orphan cases. `make test` still fails at the retained44 failures; integration was run separately, not silently skipped. Independent cumulative preservation review remains required. No paid calls, live corpus changes, feature acceptance, release or push.

### Auxiliary consolidation and private-shape checks

Independent cumulative review `b43504f9-4088-4cea-9a1e-5cb6f9bfbf38` passed the entire B1/S1/L1/U1 batch. Main then applied the remaining evidenced candidates:

- Strengthened duplicate/optional association keepers in `subtask-access.test.ts` with explicit parser acceptance and store admission before deleting the two parser-only positives.17/17 passed first. Real parser mutations rejecting duplicate claims and requiring optional links each failed the retained acceptance assertion; source restored byte-identically (SHA256 `37c3698dd3b9557264a6e5e89a60c2954459bba53465b2ba4ae082e475721c53`). Canonical provenance and malformed-index parser controls remain.
- Removed only the historical prose/metadata equality declaration in `manual-advisory-reading.test.ts`; production `completionDecisions` replay and both JSON consumers remain. Removed `continuation-fixtures.test.ts`, which only checked diagnostic corpus inventory. Its original JSON/hash provenance remains unchanged; fresh independent N06 semantic acceptance remains required. Nine focused keeper files passed180/180.
- Removed the redundant1201-observation private-index declaration, keeping the stronger retained-payload/bytes/checkpoint/read-budget tests. A real Monitor mutation caching every settled canonical observation failed the keeper at1201 retained payloads versus66 allowed, then was byte-restored. This does not claim an ID-only metadata-cache bound. Removed only the private `interval` assertion and renamed that idle test; both60-second no-dispatch controls remain. No production timer behavior changed.
- Removed only direct-import factory checking from `package.test.ts`. Actual offline Pi CLI loading remains: non-callable default export and broken `pi.extensions` path mutations each failed the native keeper. Both files were byte-restored (index SHA256 `609851d989c8002da67f1940afe1edbba12596d665239b86d33c35d8d54ab747`, package `445175b86b783ad7db36659c20a0b63b16e116e76ee5937888e109c80204b50c`). Manifest/install safety and all real-host tests remain.

Final candidate gates: format/check pass with three historical warnings; unit1912 pass/44 unchanged legacy-fixture failures; integration86/86 pass.135 test files remain (115 unit,17 integration,3 live unrun).18 declarations retired,1222 remain; the repaired Beads negative table adds five parameter rows, so1979→1956 unit cases is a net23-case reduction. Production code is reduced by500 lines; no support/corpus file removed. These numbers are accounting, not coverage or deletion targets.

## Retained implementation handoff

Audit does not revive obsolete workbook/v10 semantics. Keep the44 failing fixtures until the following required generic proofs/product changes support coherent removal:

| Requirement | Existing partial/current keeper | Required feature-phase action |
|---|---|---|
| Coalesced/oversized skipped semantic work survives reload | Generic report size rejection/coalescing, not durable loss | Implement approved `ru7`: bounded content-free identity/count, once-only projection, no provider for oversize, no automatic retry; port scheduler317/476. |
| End-to-end wallet exhaustion and stale result fence | Report journal1024 cap; Monitor diagnostics; runtime stale-result guard | Carry exact Monitor1023→1024 dispatch/pending-tail/reload and replacement-authority assertions, not diagnostics alone. |
| Explicit selected-model recovery without parent re-extraction | Runtime stale-flight/charge controls | Resolve current generic phase recovery policy from contracts, then preserve charged failed phase → named model-selected wake → at most one current retry, no refund or parent extraction. |
| Generic gate/proposal versus report ownership and overlap restore | Pure shared-owner journal, latest report coalescing | Port actual Monitor ordering/overlap normalization and bounded loss; do not resurrect resource-intent ownership. |
| Restore isolation with health and no unnecessary billing | Envelope/runtime/report restore | Actual v11 Monitor with groups/journal/health cards; no gate/proposal/report/extraction/health rebill. |
| Adapter loss versus canonical semantic-source loss | Generic metadata amendment/access tests; pure source pruning | Keep groups/IDs/wallet independent of ephemeral tool metadata; prune only stale canonical authority without refund. |
| Deep source, no refund, exact quote span | Partial bounded restored-read and bridge-drift tests | Three v11 Monitor proofs: source beyond64-entry tail; older same-source checkpoint cannot lower wallet; structurally valid wrong quote/span/hash rejected while unrelated valid state remains. |
| Legacy source/codecs after ports | Live generic wave/retry/drain/fairness/save-fence keepers | Remove unreachable semantic coverage source/tests together; retain adapter and HealthCoverage. Rehome mandatory codec contracts before removing old v10 codec; no migration/facade. |

Existing generic Monitor/runtime tests already cover20+2 waves, saved-prefix recovery, deadline plus named wake, durable pre/post-dispatch save fences, detail fairness, all report roles and physical drain. Reuse those real keepers rather than adding disconnected duplicates. C05-C09 remain unaccepted; N05, C10/N06 semantic QA and owner manual review remain later gates.

## Final preservation follow-up

Review `2d5e16c9-b845-4e9d-9336-9e9918aafc36` found no lost contract, but blocked closure on missing idle-periodic-dispatch mutation evidence. Main supplied the control without changing shipping code/tests: a temporary30-second timer in `Monitor.turnOn` called the real scope-gate builder and real gateway with the current consent identity. The retained60-second no-fetch assertion failed with exactly two mocked provider calls. Source was byte-restored to the recorded Monitor SHA256; the full focused Monitor file then passed15/15 and the source/test tree was clean.

The first attempt supplied source ID rather than gateway consent identity, so the gateway correctly rejected it before dispatch and the test passed. That attempt is retained as invalid mutation evidence, not credited as proof. The corrected fault and its diff/log are recorded separately. All calls stayed behind the offline fixture; paid calls remain zero.

## Audit accepted; feature completion resumes

Final independent cumulative review `584dfc88-dcea-41b8-a919-dae9c930f241` passed after the idle-mutation follow-up. Main accepts the completed audit and its retained-requirement handoff; `hmv` may close. All planned evidence-backed cleanup candidates are applied. Final sizes: production38,706 lines (−500), tests39,393 (−474), support3,077 unchanged. The source/test candidate remains `29c8b69f`; later commits record evidence/closure only.

Full product gates remain red until feature completion:1912 unit pass/44 retained obsolete-fixture failures,86 integration pass, format/check pass with three historical warnings. C05-C09, N05 and fresh C10/N06 semantic acceptance remain open. Owner manual review follows both completed features. No release, install, push, paid semantic proof or manual acceptance is claimed.
