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
