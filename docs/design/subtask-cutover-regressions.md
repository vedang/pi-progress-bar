# C05 cutover regression accounting

This is scoped cutover accounting, not the deferred comprehensive test audit. C05 remains unaccepted. No test deletion, skip, or compatibility fallback is authorized by this inventory.

## Invalid parked-owner follow-up (`c9105e86`)

Main independently confirmed the earlier report/Monitor/bounds gate **44/44 passed**. Worker reported full unit1882/50 and integration82/1 (RPC correction blocker remains), not stage acceptance.

Main extended the existing revised-parent scenario with a real HTTP503-parked report before revision. The parent advances to revision2, the gateway delay expires, and an explicit model-selected wake occurs, but fresh proposer calls remain0 vs1. `activeSubtaskReportParentIds()` tests journal state without validating current parent/group/source authority: invalid parked work still locks its parent. Existing no-owner revised and same-scope cases pass. The new assertion also requires old history to become superseded, preserving its one charged attempt and never retrying that invalid report. Do not solve by dropping valid parked ownership, charging an obsolete report, or reopening host readers in physical callbacks.

Artifacts: `c07-active-main-green.log`, `c07-invalid-parked-red.log`. Main owns this additional RED; source repair and full gates remain required.

## Existing-child accounting fixture correction

During the active-owner repair, the worker correctly stopped on Main's same-scope fixture: its request contains22 active children, but the response supplied only two additions. `applySubtaskProposal` requires every existing child to be explicitly retained/reworded/replaced/removed; source must not invent missing operations. Main independently reproduced proposer-called but22-vs24 final labels, then added22 explicit `retain` operations from the request (and asserted zero existing children after parent revision). The two additions and final old22+new2/revised-only2 assertions remain unchanged.

Corrected fixture against baseline `24c6ddf0` source: **3 RED/22 controls passed**. Against paused worker candidate: **25/25 passed**. Worker source restored byte-identically after baseline comparison. No protocol change, no inferred retains, no safety-assertion deletion. Broad validation/source commit and all prior closure blockers still outstanding. Artifacts: `c07-retain-{fixture-diagnostic,candidate-green,baseline-red}.log`.

## Repair review (`9603ef0d`, still unaccepted)

Main confirmed format/checkPASS (three old warnings) and complete unit **1879 passed/50 known coverage failures** before adding the next REDs. Complete pinned integration this time **81 passed/2 failed**: both TUI and RPC builtin attempted-start correction cases report0 vs1 at `advisory-host.integration.test.ts:773`. Earlier83-pass runs do not waive this reproducible intermittent blocker.

The earlier authority/getter tests now pass, but Main froze three additional active-work regressions:
- With a real restored22-child group (not absent optional capability),10,000 blank/thinking entries still cause10,000 payload reads in one canonical boundary, over256. Require bounded discovery AND eventual genuine20+2 coverage; skipping empty optional work alone is insufficient.
- A settled parent revision invalidates its stored group, but raw group-parent membership suppresses new decomposition; proposer calls0 vs1 despite valid new semantic parent authority.
- Even with unchanged parent revision, named refinement followed by a completed neutral report never reaches fresh decomposition; proposer calls0 vs1. Existing-group membership is not a permanent report-owner lock. Preserve ready/parked saved-report priority, but permit retained decomposition opportunities when that owner is finished or invalid.

Focused gate **3 failed/22 passed**, format/checkPASS. Main owns the test additions, including valid proposal dispatch/provenance plumbing; no source patches or timeout/limit changes. Logs `c07-repair-main-{format,check,test,integration}.log`, `c07-active-owner-{format,check,red}.log`. Historical50 ports, host diagnosis, complete reviews and manual acceptance remain ahead.

## Monitor wiring review and gates (`05bef5cf`, unaccepted)

Worker reported674 focused consumer passes and host validation. Main independently ran format/check (pass;3 historical warnings), complete unit **1871 passed/57 failed**, and complete pinned integration **83/83 passed**. Installed-host targeted coverage-live/subtask-drain/subtask-live: **5/5 passed**. Latest full integration pass does not diagnose or erase the prior intermittent TUI failure.

Unit failure accounting, before the additional getter RED: original50 legacy failures +2 newly failing coverage metadata omission controls +4 mandatory bounded-read regressions +1 new cross-parent report RED. Do not label all57 as legacy. Main compared pre-wiring `7135b59f` source against the identical existing bounds/fifth-review/coverage-monitor tests:25 passed/6 old coverage failures; all six newly failing existing controls passed before wiring. Source was restored byte-identically after the comparison.

Main review REDs:
- Capture an actual durable mid-wave checkpoint with parent1's first20 decided and parent2's same-source report not yet dispatched. Reload resumes parent1's last2 but silently omits parent2's22. Source-only `known.some(sameSource)` dedupe crosses parent/group authority; no source-semantic mock change involved.
- Restored-group passive getters read the host four times across four snapshots; they must project without reopening a reader (including after disposal). Snapshot fallback currently calls `beginCanonicalPass`/`subtaskCurrent`.
- Existing blank/thinking payload tests read10000 vs bound256, and duplicate hooks read68 vs bound8. Preserve assertions and bounded canonical work; do not increase limits or fake empty restored projections.
- Existing metadata byte/candidate omission controls now return0 vs positive before wiring; isolate unintended eager optional context/evidence consumption rather than restoring legacy semantic fallback.

Focused new+existing review gate: **6 failed/35 passed**, including the additional getter RED. Source repair and full reruns remain required. Logs: `c07-monitor-main-{format,check,test,integration,installed}.log`, `c07-monitor-{parent-red,review-red,pre-regressions}.log`. No whole-stage acceptance or deferred-audit claim.

## Reporting-layer batch gates and additional host ports

After gateway `8c5c3c4c`, Main independently passed39 gateway tests. `make format`/`make check` pass (three existing warnings). `make test` stops at **1845 passed /50 failed**, exactly coverage-monitor6, coverage-scheduler34 and coverage-storage-monitor10; integration must be run separately.

Separate complete integration run: **76 passed /7 failed**. Main found the actual advisory-host production seed still used the v10 encoder and the canonical host-selected-model index assertion still expected10. Ported only those fixtures/expectations to strict v11; all correction, deadline, lifecycle and canonicality assertions retained. Complete integration after ports: **82 passed /1 failed**. Remaining failure: TUI production correction during builtin attempted start, `correctionCalls`0 vs1 (`advisory-host.integration.test.ts:773`). One bounded targeted diagnostic ran both TUI/RPC correction cases:2/2 passed (other tests excluded by filter). This does NOT establish the remaining failure's cause or waive full integration acceptance; retain it as an unresolved intermittent host blocker, distinct from the older line655 deadline evidence. No arbitrary timeout increase or source workaround introduced.

Artifacts remain in the active task directory: `c07-layer-batch-{format,check,test,integration}.log`, `c05-host-v11-port-{format,check,integration,correction-diagnostic}.log`. Provider semantics/manual acceptance/complete-stage reviews remain outstanding.

## Candidate and drain verification

- Live candidate: `f84b36f6`; physical-drain repair: `6c4cc21e`.
- Main independently passed 66 focused unit tests and 5 actual-host tests on each local and installed Pi.
- The worker's two `fetch is not a spy` failures used `npx vitest run` without the repository config (setup count zero). Main configured reruns pass. Future verification must use `vitest.config.unit.ts` or `vitest.config.integration.ts`, which installs the offline network guard. Do not weaken those assertions.
- Main full unit run before fixture ports: 99 failures, 1622 passes. Integration did not run because `make test` stops after unit failure.

## Mandatory-contract fixture ports

Main retained all tests and safety assertions, replacing v10 codec references in Monitor-facing suites with strict v11 helpers, updating current-version assertions, reading the new restore result's `.state`, and testing v10 plus future v12 as unsupported. These are fixture/API ports, not permission to preserve a second live decoder.

Ported suites: advisory-settlement, hybrid-bounds, hybrid-chunk-resume, hybrid-fifth-review, hybrid-fourth-monitor, hybrid-monitor, hybrid-review-capacity, hybrid-review-followup, hybrid-review-monitor, hybrid-sixth-review, task-details-replay, task-health-recovery, ux-board-projection, ux-final-review, ux-order-restore.

Main format/check pass, with the three existing activity-label warnings. Full unit result after ports: **51 failures, 1671 passes (1722 tests)**. No tests were removed; the unsupported-version matrix gained a future-version case.

## Remaining failures and ownership

| Suite | Failing cases | Classification / next action |
|---|---:|---|
| task-details-replay | 0 after repair | **Confirmed production bug repaired in `087dc4f1`.** Accepted detail receipt transaction wrote v10. Main strengthened the atomic receipt/usage test to require both prior and accepted saves be v11; Main independently passed 69 detail/runtime/envelope tests after repair. Worker full unit result: 1672 passes, exact 50 remaining coverage failures. |
| coverage-monitor | 6 | Workbook-specific integration assertions. Main must map individually to generic admission, passive access, lifecycle, UI and later reconciliation requirements before any rewrite. |
| coverage-scheduler | 34 | Mixed old intent/report scheduling, recovery, capacity and ownership assertions. Main must preserve applicable safety cases and explicitly identify C06/C07/C09 dependencies; not all are harmless obsolete expectations. |
| coverage-storage-monitor | 10 | Inventory-specific restore assertions plus durable wallet/provenance protections. Main must port the safety properties to generic store/journal restore; access links are runtime-only under C04. |

## Mapping status

Read-only scout `464ec31e` mapped the original case titles to generic invariants and identified C06 report/C07 scheduler/C09 projection dependencies. This is advisory evidence, not a keeper decision: its claim that positive generic admission/drain/restore tests are missing overlooks the already implemented C05 tests. Main must validate exact keeper coverage and each proposed port. Do not use that report to waive gates, delete or disable tests, or assert that all failures are obsolete.

Oracle `83da0447` confirmed the sequencing constraint: progress may record expected REDs, but that is not acceptance or permission to skip tests. Finish bounded C05 ports/cleanup first. If preserved positive report/recovery/fairness tests still require C06/C07, request an explicit owner sequencing exception before starting blocked stages or changing dependency order. Existing generic atomicity/drain keepers are not substitutes for those report integrations.

## Additional acceptance blockers

- Legacy `CoverageStore`, `coverageSnapshot`, intent/report scheduler methods and v10 codec paths remain in source. Their removal was requested and remains incomplete; this is not an approved fallback.
- Runtime/Monitor association binding implemented in `325157dc`. Host port `b10b490e` exposed missing production ingress; `e0270832` additionally proved ordinary conversation advances dropped access links. Repair `c80f22f0` adds ingress and separates logical invalidation from lifecycle reset. Main passed 47 focused tests and all 5 installed-host admission/drain/access tests. Pinned host passed 4/5, failing the 22-child case before admission. Adapter diagnostics showed 22 mappings and active counts 1/2 when admission succeeded; no adapter change is justified.
- Full unit/integration/installed-host verification and independent whole-C05 review remain required.

## Latest recovery evidence

`6e367f49` implements the initial approved recovery seam. Main verified 133/133 focused tests and 5/5 host tests on each pinned/installed version. This clears the earlier stale-metadata admission RED, not whole-stage acceptance. Follow-up controls found a parent-revision frontier bug: a new parent revision can restart list revision 1 while the old accepted receipt remains nonsuperseded. New regression checks every persisted component, including gate/proposal dispatch writes, and reload history. Repair `3af76198` applies a shared accepted-frontier matcher at every component commit. Main verified 138/138 focused tests, including the parent-revision regression. Ready-yes retirement, proposal-dispatched retirement, lifetime exhaustion and same-parent list refinement controls pass. Remaining legacy coverage failures, cleanup, full scheduling/report work and independent review remain open. C06 reporting implementation is now in progress under the approved overlap.

## Evidenced sequencing blocker: stale gate owns the parent

After `c80f22f0`, Main reproduced the pinned-host pre-admission failure: one gate charged, no proposal, gate-ready/permanent/failed. An installed-host pass does not clear this failure. Worker removal of the new branch-confirmation hook also reproduced it; that experiment alone does not establish every timing cause.

Main froze a deterministic runtime RED, `admits a fresh metadata trigger after a stale gate drains without refunding or replaying its charge` in `subtask-runtime.test.ts`: hold the first dispatched gate, introduce original attested metadata, release the stale result, verify retained charge/permanent failure, then explicitly wake the now-current context. Expected a fresh second gate; observed only one. No host timing or retry is involved. Existing proposal-dispatch fixture assertion remains exactly 2 for historical cases; the new two-gate case requires 3.

`SubtaskRuntime.runFlight` intentionally blocks a new identity while any same-parent record is not complete, with a comment reserving resolution for later policy. C07 owns changed-context reevaluation/supersession/recovery; silently removing that guard would bypass the staged contract. C05 cannot pass this ordinary discovery overlap with its current policy. This makes the sequencing conflict concrete before remaining legacy cleanup is complete.

Latest configured checks: format/check pass (three existing Biome warnings); `make test` stops at unit failure, **1679 pass/51 fail**, comprising the prior 50 coverage regressions plus this new RED. Separate actual-host admission/drain/access checks: pinned **4 pass/1 fail**, installed **5 pass**. No skips, expected-failure annotations or retries used to claim acceptance.

Requested owner exception: permit narrowly identified C06/C07 implementation against unaccepted C05 and explicitly adjust implementation dependencies for that overlap. C05 stays open; all regression gates, independent review, manual acceptance, cleanup and no-legacy-fallback requirements remain. This is not grouped acceptance, a test waiver, or permission for broader reordering. Owner **approved Allow overlap**. Converted C06→C05 and C07→C06 implementation-blocking edges to related links; preserved explicit separate closure prerequisites in acceptance criteria. C07 recovery is now in progress, starting from Main RED `91e34b1e`. No broader dependency order changed; no stage accepted by this authorization.
- Mock/host mechanics do not replace fresh C10 semantic evaluation. No paid calls or release readiness claimed.

Detailed retained logs are in the task folder: `c05-main-full-before-ports.log`, `c05-mandatory-port-final.log`, `c05-mixed-version-red.log`, `c05-drain-main-{unit,host,installed}.log`.
