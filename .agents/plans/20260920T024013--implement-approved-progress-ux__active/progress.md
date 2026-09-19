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
