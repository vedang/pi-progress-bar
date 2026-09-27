# C05 cutover regression accounting

This is scoped cutover accounting, not the deferred comprehensive test audit. C05 remains unaccepted. No test deletion, skip, or compatibility fallback is authorized by this inventory.

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
- Runtime/Monitor association binding implemented in `325157dc`; Main passed 24 tests. Production `index.ts` still omits passive tool ingress. Main's port of the original 22-child actual-host test reproduces four tool starts expected/zero observed; this remains a C05 blocker. The port uses generic accepted-yes proposals and post-settlement reads, retaining one parent, 22 pending children, exact item/batch access and private-body exclusion.
- Full unit/integration/installed-host verification and independent whole-C05 review remain required.
- Mock/host mechanics do not replace fresh C10 semantic evaluation. No paid calls or release readiness claimed.

Detailed retained logs are in the task folder: `c05-main-full-before-ports.log`, `c05-mandatory-port-final.log`, `c05-mixed-version-red.log`, `c05-drain-main-{unit,host,installed}.log`.
