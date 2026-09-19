# Approved UX execution

## Authority and baseline
- User authorizes sequential Beads implementation only after root release and exact `jj rebase -b @ -d default@-`.
- Root release notice: accepted runtime e4dcfe08, release/closure change klvwuymrspvmxsrnwlkzouxvwmzqtvws /0102cde4; cumulative review PASS, root378unit+12local+12global gates.
- Ran exact requested rebase successfully:7 commits, no conflicts. Current successor ccb2e74f; user status/count/hint edits preserved in ancestry and current plan.
- Normal br import processed84 rows/updated9; root82j/xkg/6qv closed; y3h+25 retained. Only y3h.1 ready. No stale repair status overwrite.

## Execution
- Claimed epic y3h and U00/y3h.1. No later ticket started.
- U00 read-only source/host inventory delegated to scout98938f93; no source/test mutation authority.
- Main reran baseline make format → make check → make test: PASS,378unit+12integration. Logs in this folder. Source unchanged.
- UX host target: installed Pi0.85.1; local0.84.2 dependency remains repository baseline for now. No unrequested dual-host compatibility promise; actual host proof needed before UI changes.
- Main owns tests, source workers only after explicit red-test handoff. Full functionality includes status/request counts and confidence-gated details before stable manual-QA handoff; polish afterwards while user tests frozen build.
- U00 closed626db091: accepted baseline pinned. Main rejected scout's prompt-input/duck-typing/custom-overlay recommendations; complete installed docs read, direct public TUI API verified.
- U01: added17host adapter reds and opt-in static actual-host fixture. InstalledPi0.85.1 PTY regular+fullscreen PASS: canonical CustomEditor through loader, exact-owned hide under sibling, editor restore, empty/nonempty Right, transformed pipeline Right, shutdown.
- Format/check final PASS. Initial syntax/type/lint issues corrected; premature U01 close immediately reopened until full check passed, then closed with corrected receipt. bun.lock edit denied by policy, no workaround attempted; package edit reverted. pi-tui is explicitly host-provided loader alias, so Knip ignoreDependencies documents that existing runtime supply; package/lock unchanged.
- U02 source boundary: only src/ui/host.ts; main tests/config remain main-owned. No runtime behavior wiring until later tickets.
- U02 source04037091 accepted after main static test import, private unused type cleanup and actualhost fixture wired to production adapter. Main format/check/395unit+12integration PASS; installed0.85.1 PTY regular/fullscreen PASS using actual createUiHost, no providers. No widget/index wiring yet.
- U03 main tests frozen: ux-order-restore15cases (14red/1pass) plus index host2reds/4existingpass; format/checkPASS. Three order cases require pure tasksNewestFirst projection over existing create events; no new ordinal schema requested. Rejected-storage cases cover old/future versions, null/malformed/overcap, no saves/calls, ON/OFF/model/observation/stop latch and fresh restore; supported no-rebill control passes.
- U04 must preserve accepted root canonical amendment reconciliation and metadata/authority invariants: unsupported/malformed STORAGE is not the same as supported source content legitimately amended. Do not reclassify every historical reference mismatch as structural corruption or erase root tests. Main owns any required test changes.

## U04 main acceptance, byte-bound correction and batch review
- Worker source commit `530ef53a`: event-derived newest-first projection; structural checkpoint classification; rejected restore latch with fresh-session guidance and no save/provider path.
- Main switched frozen projection tests to static imports (assertions unchanged) for Knip reachability.
- Main inspection found structurally valid >512KiB storage classified supported. Added two regressions: exact byte-cap and multibyte classification; monitor no-replay one-byte-over boundary. Both failed before fix (`u04-byte-red.log`), 15 original tests passed.
- Main corrected classifier to enforce existing UTF-8 checkpoint ceiling; no schema or canonical-amendment change.
- `make format`, `make check`, `make test` PASS: 412 unit +14 integration. Logs `u04-{format,check,test}.log`.
- U04 stays in_progress until cumulative U00–U04 reviewer acceptance. No later ticket released.

## U04 review resolution
- Cumulative reviewer `c340a32c` found one P1: host optional CustomEntry.data erased entry-presence distinction. Main reproduced missing-data saved entry overwriting/replaying (`u04-missing-data-red.log`: 1 failed/6 passed).
- Host restore now reserves undefined for absent entry, passes null for present missing payload. No compatibility path added.
- Added valid-supported restore clearing latch with settled tasks and no rebilling; renamed absent-boundary test accurately.
- Main reran format/check/test PASS: 413 unit +15 integration (`u04-review-*` logs). Reviewer blocker resolved by exact requested fix and regression. Main accepts U04; review verdict was BLOCK before correction, not a post-fix reviewer PASS.
- Remaining host-proof coverage limits explicitly retained: reverse listener ordering, configured custom editor, and actual pi-subagents co-load permutations are not yet real-host proven. Complete during controller/board integration before functional QA handoff; existing receipts prove only their recorded default-editor/transform-before-listener regular/fullscreen cases.

## Continuous execution authority / U05
- Owner explicitly requests all remaining Beads completed one by one without waiting for further approval. Sequential release, main-owned tests, scoped source delegation, gates/review remain mandatory. Manual feedback is not fabricatable; Q00 awaits actual owner QA.
- Claimed U05/y3h.6 per-task health/board projection red tests. U06 source writes not released until tests frozen.

## Orchestration watchdog
- Requested 10-minute cadence; valid integer interval =600 seconds /600000 milliseconds.
- Exact master discovered via intercom list/status: `01a0ba83-70b3-7204-9103-c3ee115c18d5`, short `01a0ba83`.
- No background sessions before launch. Spawned fresh Pi outside repository at `/Users/vedang/.pi/agent`, background dispatch session `orchestration-watchdog-01a0ba83`, autoExitOnQuiet=false, quiet/update/grace=600000ms.
- Timer read-only: sends READY then sleeps600 and sends TICK; no repository inspection/writes/delegation. Master retains all decisions and checks intercom, jj state, sole-writer ownership, exact immediate-parent gates and validation on ticks.
- Launch running; READY routing verification pending. Cleanup on orchestration completion or master-ID replacement: `/orchestration-watchdog-stop orchestration-watchdog-01a0ba83`.
- Watchdog verification FAILED: fresh Pi blocked at interactive trust prompt (`Do not trust` / `Do not trust (this session only)`); no intercom registration or WATCHDOG READY received. Did not accept security trust on owner's behalf.
- Dismissed exact background session `orchestration-watchdog-01a0ba83`; listBackground confirms no background sessions. Watchdog NOT active. Owner trust setup required before same-protocol relaunch. No repository/source implementation failure; U05 remains current work.

## U05 frozen red contracts
- Main authored `ux-board-projection.test.ts` (16 cases) and `ux-health-storage.test.ts` (5 cases), changed old optional-health byte-edge assertion from semantic capacity limit to clear, and updated main-owned current-schema pins to strict v7. Persisted per-task health/provenance changes warrant schema bump; v6 becomes unsupported, no migration/decoder.
- Main rejects recon suggestions to expose source IDs/hashes, alias backward compatibility, or map reopened to INPROG. Safe board only role/time/provenance qualifiers; reopened without fresh exclusive focus remains OPEN. Frozen idle qualifier: `Last reported · idle`.
- New board contract: all retained newest-first tasks, exact five health fields with explicit Unassessed, safe provenance, task-local transitions, currentTask identity/status/qualifier, global service separate; no live monitor capability in UI. Full 200-task/1000-event projection stays detached/passive.
- Durable healthCards array keyed by unique taskId, one card per retained task; provenance requires exact taskSource, triggering observation, hashed snapshot/request/evidence identities and codeRevision; no raw request retention. Full map preflight before optional calls; optional denial/failure cannot block semantics.
- Verified targeted initial 22 reds/9 passes; after schema pin updates full unit26reds/409pass, integration1red/14pass. Format/check PASS. Logs `u05-{format,check,red,unit-red,integration-red}.log`.
- U05 acceptance is reproduced reds, not green feature delivery. U06 sole source writer may implement only this slice; main owns all further test/config edits.

## U06 source-complete; review gate
- Worker source `901aa031` (change yymlmwuxwyrskzkvyltxxlzlxtslvmps) implements strict v7 healthCards, isolated health transport/admission, pure board projection and display-status freshness. Three source files only.
- Main fixed missed obsolete-version matrix (reject6/8, accept7), replaced temporary board test types/reflection with direct production boardSnapshot API.
- Independent main format/check/test PASS:436unit+15integration; `u06-{format,check,test}.log`.
- U06 still in_progress pending full U05/U06 review. Main inspection flags scrutiny: source-vs-triggering-observation ID byte envelope; stale report/evidence health falsely current on unchanged focused task; restored idle-DONE identity derived from most recent card rather than exact recorded display; persisted old card fallback paths despite no-compat policy. Reviewer must distinguish real defects and provide exact repro seam.
- While read-only reviewer8b4e9bac checks full U05/U06, main reproduced three projection defects with tests: same-task held replacement health falsely current; code/evidence identity change falsely current; fresh reload resurrects idle DONE invalidated by newer work. `u06-extra-red.log`:3failed/16passed; format/check PASS. Source901aa031 unchanged. U06 acceptance withheld; reviewer notified to incorporate exact evidence.
- Reviewer progress confirmed additional real defects: optional envelope substitutes short task-source ID for unbounded actual report ID; canonical checks omit retained health-only observations. Main added long-ID zero-dispatch and amend/remove report invalidation reds, preserving semantic state/no rebill. Also froze strict-v7 rejection of provenance-free legacy-card-only storage (no compatibility permitted). Combined7reds/21pass; format/check PASS. Old card-only fixtures require main conversion when authoritative representation is finalized; source worker cannot alter tests.

## U06 repair release
- Full reviewer8b4e9bac verdict BLOCK5P1: report/evidence freshness, actual observation byte admission, retained-health canonical boundaries, reload/OFF/control display eligibility, provenance-free legacy card authority.
- Main added OFF/ON resurrection and four syntactically valid but unverified digest/revision restore regressions; converted two old card-only fixtures to exact HealthCard provenance (new fixtureHealthCard), retained saturated dispatch-envelope coverage. Replacement-pending persisted assertion now checks healthCards, forbids durable monitor.card; runtime presentation still required.
- Freeze result:14failed/434passed unit tests (448 total). Final format/check PASS. `u06-repair-red.log`; no source change since901aa031.
- Correction: earlier extra/review check receipts were prematurely described PASS; captured logs actually had a test-helper initial-entry parameter type error from fresh reload fixture. Main now explicitly types monitorHarness initial input unknown[] consistent with internal canonical reader. Final u06-repair-check.log passes TypeScript and Knip; no source weakening.
- Repair worker must remove persisted legacy card authority, maintain runtime presentation by exact health fact/selector only, mark unverifiable restored cards retained, continuously reconcile optional refs without semantic rebuild/rebill, and preserve full root authority/bounds invariants. No tests/config/Beads writes; report exact source-only handoff.
