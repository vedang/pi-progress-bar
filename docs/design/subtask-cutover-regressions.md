# C05 cutover regression accounting

This is scoped cutover accounting, not the deferred comprehensive test audit. C05 remains unaccepted. No test deletion, skip, or compatibility fallback is authorized by this inventory.

## Selected-model recovery keeper ports (2026-09-28)

`subtask-recovery-monitor.test.ts` exercises actual conversation-only Monitor gate→proposal for three charged failures: unknown transport failure, malformed result with known usage, and rejected admission persistence. Same-model named selection does not retry; a genuinely changed selected-model identity permits exactly one fresh gate+proposal, preserves old receipts as superseded history, retains all four charges, admits two grounded children and never re-extracts or re-assesses the parent. Repeating that selection does not rebill. This follows the explicit C07 supersession contract, not the obsolete unconditional same-context intent retry policy.

Initial metadata-based fixture failed because model selection correctly resets ephemeral adapter evidence and the fixture then answered no; it did not establish a production defect. Replaced it with independent conversation-grounded proposals, rather than preserving stale evidence or changing production behavior. Main **61/61** combined recovery/runtime/storage/Monitor/wallet tests and TypeScript pass. Legacy scheduler tests remain present until complete keeper mapping and coherent source retirement.

## Generic storage keeper ports (2026-09-28, retirement pending)

Main added three actual public-Monitor restore keepers in `subtask-storage-monitor.test.ts`: removal of all tool metadata preserves conversation-grounded children, allocator and exhausted wallet through repeated restore while access becomes unavailable; exact canonical child sources survive more than64 later branch entries; a structurally valid but wrong child quote span prunes the group without refunding the wallet or disturbing parent/health/allocator state. Fixture admissions run the real generic gate and selected proposal before restoration. The exhausted wallet is an explicitly supported historical wallet, not fabricated provider receipts.

The existing stronger `coverage-monitor.test.ts` OFF/reload keeper now additionally proves real nonempty health cards and parent tasks survive with no mandatory/optional rebilling; a redundant new restore-positive case was removed before commit. Existing `subtask-wallet-monitor.test.ts` remains the primary real charged-history/older-checkpoint/no-refund owner. Main configured focused **26/26 pass**, TypeScript previously passed the new storage fixture.

Legacy storage's six tool-inventory invalidation rows cannot retain their old semantic-group deletion expectation: C04 makes adapter metadata nonauthoritative for conversation-grounded children. Current `coverage-monitor` metadata-amendment and new metadata-loss restore keepers protect that distinction; adapter protocol guard suites retain malformed/duplicate/call/error evidence checks. No legacy test/source deleted yet. Scheduler recovery/ownership accounting, omission review, coherent legacy retirement and C05–C09 acceptance remain outstanding.

## Host fixture follow-up: paired protocols and exact clock observer

Read-only diagnosis `64baf7d5` separated two fixture problems from correction authority:

- `ReconciliationController.settled()` and `arm()` sample time separately. A valid deadline can register a59,999ms delay; the test watched only60,000. Main freezes `Date.now()` before the prompt through timer capture, then advances that same mocked clock by60,001 before invoking the callback. Exact60,000 observer, exact-one timer, real lifecycle/retry/compaction and delivery assertions remain; no delay window or timeout increase.
- The installed0.87.1 host supplies normalized system messages. The pinned0.84 faux provider cannot serialize their string content and can fail **after** its async response callback, explaining an eligible fact followed by no tool admission. Main now uses the existing paired `coverageHost()` loader for all runtime helpers: ModelRuntime comes from the selected **host**, credentials/faux/messages/tool calls from its **ai**. No shipping compatibility code or runtime upgrade. Positive controls additionally assert one native `tool_execution_start:write` and one `tool_call:write`, without logging arguments/content or manufacturing Monitor attempts.

Main independently executed **20/20 pinned advisory-host**, **4/4 installed correction controls**, **20/20 installed full advisory-host**, and **86/86 full configured integration**. Format/check pass (three historical warnings). Full units remain **1935pass/44 legacy failures**. Logs `c07-host-paired-fixed-{pinned,installed,installed-full,integration,unit,format,check}.log`. Initial fixture edit incorrectly sourced ModelRuntime from ai, producing type/runtime failures in `c07-host-paired-*`; corrected to the host export before successful validation. Failed evidence is retained.

These fixture failures now have scoped explanations and passing actual-host controls, not a pass-only waiver. This is **not C05–C09 acceptance**:44 remaining ports, durable omission contract `ru7`, legacy removal, independent whole-stage reviews and manual prerequisites remain.

## Actual-host correction authority timing proof

Worker read-only diagnosis `bfbf557f` identified a fixture precondition gap: the old success case waited only for a health HTTP dispatch, not accepted task-local authority. Main added bounded passthrough traces (readiness, target-fact flag, coverage enum and identity hash only) and two controlled actual-host cases. Holding health response until correction observation settles produces `ready:true`, complete authority, **target fact absent**, correction dispatch0. Releasing health yields a current fact later but no retry or delivery. Both pinned TUI/RPC cases pass; this directly validates the missing-fact mechanism rather than attributing each historical uninstrumented failure by inference.

The two existing success cases now await a new health dispatch **and** actual current accepted target fact/readiness before releasing their faux assistant tool response; they assert accepted fact at admission and preserve all classifier/delivery/policy/finalized-action/privacy/one-turn assertions. No production change, timeout increase, hidden retry or weakened expected1. Pinned targeted **4/4 pass** (`c07-host-authority-proof.log`); format/check pass. Unit gates remain1935pass/44 existing failures.

**Historical result before the follow-up above:** full pinned integration **85/86**, failing the separate production reconciliation deadline assertion (historical655, now661: expected one60s deadline, got0). All four correction controls passed in that run. An additional installed-host probe failed all four cases: missing initial target fact/timeout in the held controls and no observed correction-admission callback despite a pre-attempt fact in positive controls. This is not explained by the pinned missing-fact diagnosis; installed fixture/API compatibility and lifecycle evidence require separate investigation, not a timeout increase or fallback. Logs `c07-host-proof-{unit,integration,installed,format,check}.log`. No overall host acceptance or assertion that all historical races are resolved.

## First12 Monitor assertion ports executed

Main added live public-ingress fixture `__tests__/fixtures/subtask-metadata-monitor.ts` and ported all12 existing `coverage-monitor.test.ts` cases without production changes. Admission is real need-gate→selected proposal with canonical goal spans, explicit22 resource/item bindings and dispatch/physical-drain callbacks; no seeded store. Reports explicitly answer unchanged.

Executed keeper map (same12 cases, no deletion/skip):

1. Selected-proposer pre-network save veto: positive gate reaches proposer, admission false/network0, no group, prior wallet2 retained.
2. Manifest-triggered22 pending children: parent/health/mandatory counters unchanged, exact extra gate+proposal, supported checkpoint wallet3.
3. Preappend remains provisional; later accepted-group save failure happens after real charged analysis, retains wallet3 but publishes/persists no group.
4. Actual held mandatory extraction: metadata confirmed while parent/group absent; release yields real22 admission with wallet2.
5. Exact individual/batch active-call hashes, unmatched/matched ends, pending child statuses and zero additional calls.
6. OFF/reload retains exact semantic store/allocators and wallet, clears access runtime, calls unchanged and private read body absent from checkpoint. OFF restore exposes an **empty access binding projection**, not a manufactured22-row roster; semantic22 remain visible and missing binding means unavailable, never observed0.
7. Metadata removal retains group/child IDs/statuses and parent/health; links unavailable; exactly one negative optional gate, no proposal/report/mandatory calls; unchanged confirmation no calls.
8. Confirmed distinct-resource pressure: positive retained allocation, omissions, <=64KiB, no direct child admission, one parent, stable confirmation/counters; OFF returns to measured empty allocation overhead.
9. Actual Monitor mixed preconfirmation metadata/read candidates: exactly16, positive pending bytes, overflow omissions, shared bound, no children/no calls.
10. Existing positive omission-without-group board/widget and one-parent assertions retained.
11. Listing alone establishes no-observation; separate confirmed22-path read gives observed22, no billing/status change; detached exact generic reconciliation counts/gaps preserve parent/correction/settlement.
12. Read-only selected-parent board shows Subtasks/22/Overview with unchanged parent/counters.

Main configured **51/51 focused** (12 ports plus existing generic/report Monitor cases), **1935 unit passes/44 remaining failures** (scheduler34, storage10), **83/84 integration** (known TUI correction `:773`), format/check pass with three historical warnings. Logs `c05-monitor-port-{green,test,integration,format,check}.log`. Initial fixture corrections were readonly snapshot assignment, OFF-access shape and unused export; no source repair or weakened safety assertion. C05–C09 remain unaccepted; `ru7`, remaining ports/legacy removal, host diagnosis, independent reviews and manual prerequisites remain.

## Remaining Monitor ports and semantic-omission blockers

Read-only oracle `4903fb75` returned a first12-case Monitor port plan using only public APIs. Main approved: separate mandatory/need/proposal/report counters; live22 proposal admission with original metadata associations and canonical goal spans; goal-first wallet1 then manifest +2, versus genuinely held mandatory extraction with metadata-first wallet2. Listing establishes mapping/no-observation; a separate canonically confirmed read of all22 mapped paths establishes observed22 with no extra billing or semantic changes. Metadata-removal named wake may spend exactly one negative gate under the controlled fixture, never a proposer/report or mandatory call. Passive reads, unchanged confirmation and access-only events do not share that exception. Any differing execution must be diagnosed, not accommodated with widened expectations.

Pre-network proposal-save refusal and post-analysis group-publication refusal must remain different exercised paths. Pending16 mixed preconfirmation candidates and confirmed shared64KiB allocation using distinct resource paths are separate Monitor positives; OFF compares retained bytes with actual empty wrapper overhead. No pure-adapter substitution for Monitor proof.

**Blocking issue `pi-progress-barroot-ru7`**, explicitly blocking C05 and C07 closure: preserve executable `coverage-scheduler.test.ts` cases “retains coalescing omissions through same-version reload” (historical317) and “oversized canonical report records one durable omission without a provider call” (historical476). Generic journal has no durable semantic-omission equivalent. First requires positive semantic-work loss visibility surviving reload; second requires exactly one increment, provider0, and reload/wake dedupe. Adapter omissions and latest-only pending-source coalescing are not equivalent keepers. No schema extension authorized. Supporting legacy graph deletion and affected-stage acceptance remain blocked until a narrow bounded persistence/identity/projection decision, Main REDs, implementation and review.

Next scheduler subset may port real20+2, covered/no rebill, saved20/final2 recovery, deadline AND named wake (including before-deadline and repeated-failure controls), live1023→1024 cap, detail fairness, user reports, save failures and physical drain. Preserve explicit advisory-ready/OFF-late-result positives, not just one-flight mechanics. Storage ports must distinguish metadata invalidation from conversation-source invalidation, actual old-checkpoint no-refund, beyond64 source resolution and exact quote-span rejection. Passing pure legacy tests/imports also need executed keeper mapping before deletion. This is cutover work, not the deferred comprehensive audit.

## C08 UI repairs independently verified

Main inspected `b62fda7d` and independently verified **30/30 focused UI**, **1929 unit passes/50 known legacy failures**, **84/84 integration**, format/check pass with three historical warnings. Logs `c08-ui-fixed-main-{focused,test,integration,format,check}.log`. Worker separately reported876 broad passes and83/84 integration. Unavailable access no longer implies zero, positive partial observations remain visible, widget warnings coexist, and pane rows are not duplicated. C05–C09 remain unaccepted: remaining Monitor/scheduler/storage assertion ports, legacy semantic/v10 removal, host-race diagnosis and independent whole-stage reviews are still required.

## C08 UI source review and repair REDs

Main inspected `7bd4f943` and independently passed all25 frozen UI units (including the minimal generic control). Review found matched full-roster unavailable access rendered as observed0, widget exhaustion hiding omission warnings, and duplicate active-access/group-omission rows within the same subtask pane. Main froze **4 RED/26 passing controls**: all-unavailable and mixed unavailable/no-observation must not infer zero; actual all-no-observation zero and partial positive observed1 remain passing controls; widget must retain both warnings; pane rows appear once. Logs `c08-ui-review-red.log`, format/check pass in `c08-ui-repair-*`.

The extra legacy failure reported by worker was the existing positive omission-without-group test. Main ported that assertion to generic groups/access/diagnostics, retaining both board/widget text and parent-count checks. `coverage-monitor.test.ts` independently returns to **6 known failures/6 passes** (`c08-ui-omission-port.log`); the other legacy cases are not silently waived. Worker full1923pass/51fail and84integration are worker-only evidence at this point. C08 remains unaccepted.

## C08 generic UI/navigation RED freeze

Main ported all13 historical board cases and both real-TUI cases onto generic groups, separate C04 access and diagnostics. The fixture uses `SubtaskStore`, not `CoverageStore`, and contains no legacy `coverage` facade. Existing parent OPEN/DONE/fraction, provenance, unknown scope, independent scrolling, mid-list anchoring, parent switching, health headings, Escape, widths56/80/160, sanitization, detached updates and every-child reachability assertions remain executable.

Explicit projection change: old `coverage.current` report-batch rows are not in the approved generic DTO. Those dynamic-row tests now exercise declared active access from C04 `activeCallHashes`, separately from durable reported-completed status. Active access is **not** claimed to be an in-flight Jev report batch. The dynamic-row anchoring and non-completion assertions are preserved, not removed.

Added11 board cases: prepend/list-revision child-ID anchoring, same-revision wording/source-digest continuity versus revision reset, knownTotal1000 and count-only scope, omissions without groups/exhaustion, five stale/foreign access bindings and unavailable-versus-zero access. Added production-index wiring test with mocked readonly projections (mechanics only), asserting real widget omission text and zero provider calls.

Configured unit **24 RED/1 passing existing generic control**. Configured integration **3 RED/29 passing index controls**: two real TUI navigation failures plus missing production diagnostics wiring. Format/check pass (three historical warnings). Logs `c08-ui-{red,host-red,format,check}.log`. Index tests run in the integration config, not unit. No UI source implementation or stage acceptance yet.

## C08 diagnostic repair independently verified

Main inspected `9863447a`: diagnostic failures invalidate only optional owner facts, successful persistence remains successful, and the original proposer return type is restored. Independent results: **48 focused passes**, **1913 unit passes/50 known coverage-port failures**, **83/83 integration**, format/check pass with three historical warnings. Logs `c08-fixed-main-{focused,test,integration,format,check}.log`. Worker separately reported893 broad passes and82/83 integration. The variable host correction failure remains undiagnosed and unwaived. C08 producer repair is verified, not stage acceptance; UI/navigation and remaining Monitor/legacy ports follow.

## C08 producer review: post-save capture blocker

Main verified the original47 focused cases on `b3b162a9`, then reproduced a new durability failure: a real save callback accepts the dispatched checkpoint and makes the canonical reader unavailable. Added diagnostic capture throws after persistence, causing the runtime to decline adoption of the already saved charge: persisted dispatches1, live journal0, transport0. New batch **1 RED/47 passing controls** (`c08-capture-red.log`). Diagnostics must invalidate unavailable owner facts without changing commit success or losing durable charges. No acceptance.

Correction to the original freeze's gate claim: `c08-diagnostics-check.log` actually contains a TypeScript failure because Main's invalid-proposal fixture omitted the required `requestHash`. Worker widened the production proposer return type to `unknown` and cast it back internally. Main corrected the fixture to carry its request hash and requests removal of that unrelated type widening. Current format/check pass (`c08-repair-{format,check}.log`); the old freeze was not a clean check pass.

A pre-producer source-swap comparison was blocked before execution by the sandbox (`path-outside-project-write: dynamic write target cannot be verified as inside the project`); no bypass or baseline proof claimed. Source remains unchanged. Worker reports1912 unit pass/50 legacy failures and81/83 integration (known correction failures); Main has not independently rerun those full gates on this candidate.

## C08 diagnostic producer RED freeze

Main froze **13 RED/34 passing controls** across real Monitor/report and exact adapter-budget suites. New cases exercise passive/detached empty diagnostics, supported v11 wallets at1023/1024, charged invalid-proposal permanent ownership, and stop-time authority invalidation with wallet retention. Existing parked-A/newer-B, permanent-A/superseded history and real capacity-refusal tests retain their original assertions and now inspect truthful diagnostic counts. The decomposition fixture explicitly calls dispatch admission and returns a malformed proposal with known usage; an unknown-usage throw deliberately leaves dispatched proof, so it is not mislabeled permanent in this test.

Adapter fixtures execute mixed preconfirmation metadata/read candidates:16 retained, overflow omissions, stable unchanged confirmation, shared64KiB budget, reset emptiness and unchanged semantic store. Read-only measurement reuses the documented inert budget projection, including exact65536-byte pending/manifest/receipt boundaries; inherited-hook tests now call the diagnostic snapshot while hooks are installed. This is producer-layer evidence, not a completed replacement of the old Monitor post-confirm buffer test: actual Monitor OFF/confirmed allocation and UI omission/navigation ports remain required.

Format/check pass with three historical warnings. Logs `c08-diagnostics-{red,format,check}.log`; C08 source/UI implementation and acceptance remain open.

## C09 scoped source verification (not acceptance)

`0d69583e` replaces legacy reconciliation summaries with generic `subtasks` in Monitor and the formatter. Main inspected both source files and independently verified **56/56 focused**, **1906 unit pass/50 existing coverage-port failures**, **83/83 integration**, format/check pass (three historical warnings). Logs `c09-main-{green,test,integration,format,check}.log`. Worker separately reported886 broad passes. The integration pass does not diagnose or waive the historical TUI/RPC correction race. C09 remains unaccepted pending C08 closure, remaining assertion ports/legacy removal, complete gates and independent whole-stage review.

## C09 generic reconciliation RED freeze

Under approved C08/C09 implementation overlap, Main ported all seven historical `coverage-reconciliation.test.ts` cases to the new `subtasks` summary schema, retaining20 parent rows,8 MAYBE receipts, malicious-label escaping, both byte limits/whole-block fallback, stale/foreign/DONE filtering and no all-DONE wake. Added excluded-parent, count-only knownTotal1000,240-scalar astral gap, duplicate parent/group, total200/per-group64 limits and malformed-scope/access/omission controls. Overflow fixtures have unique groups and exactly200 tracked children, so fallback tests real byte overflow rather than accidental identity/count invalidity.

Main added real Monitor no-file pending→reported-complete projection, detached-mutation/no-reader/no-provider/unchanged-parent/correction controls, exact access-binding negatives and observed-access assertions in the existing mapped-access cases. No legacy snapshot facade or fabricated semantic completion.

Configured freeze: **27 failed/29 passed (56 cases)**. Format/check pass, with only three historical warnings. Source not yet changed for C09. Logs `c09-projection-{red,format,check}.log`. C09 formatter/Monitor implementation must precede acceptance; C08 diagnostics/UI, remaining scheduler/storage ports, legacy removal, host diagnosis and whole-stage reviews remain open.

## Verified parked-owner repair and remaining sequencing gate

Source `b961ab21` validates report-owner authority at named canonical wakes and consumes captured ownership during physical settlement. Main independently passed **45/45** report/Monitor/bounds tests (`c07-invalid-owner-main-green.log`). Worker reported680 broad passes,1883 unit passes/50 original coverage failures, and83 integration passes; these do not constitute whole-stage acceptance or resolve the historically intermittent correction failure.

The remaining assertion-level ports include C08/C09 functionality, not just fixture syntax. `coverage-monitor.test.ts` preserves omitted-work UI, selected-parent child presentation and detached bounded reconciliation gaps; production generic UI is only the minimal C05 projection, and `advisorySettlementSnapshot()` still obtains its optional rows from legacy `reconciliationCoverage()`. C08 owns generic presentation/omissions and C09 owns exact-parent generic reconciliation. Strict removal of the legacy store/scheduler/v10 graph must preserve these assertions in their real generic consumers, not a compatibility wrapper or disconnected keeper.

The prior owner exception authorizes only C06/C07 implementation overlap with unaccepted C05. It explicitly does not authorize broader reorder. Main requests an additional **C08/C09 implementation-only overlap** to complete the preserved ports and remove obsolete paths. C05–C09 retain separate closure criteria, full gates, independent whole-stage review and manual prerequisites; no test omission, acceptance waiver or C10/N06 semantic shortcut is proposed. Owner **approved Allow overlap**. C08→C07 and C09→C08 implementation-blocking edges are now `related`; explicit separate closure prerequisites were added to both acceptance checklists. C08/C09 implementation may proceed, with Main-owned assertion ports/REDs before source work. N05/C10/N06 ordering and all remaining acceptance requirements are unchanged.

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
