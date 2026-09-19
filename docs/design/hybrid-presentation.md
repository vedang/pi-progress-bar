# Hybrid presentation seam

Current source: `src/core/monitor.ts`, `src/ui/widget.ts`, `src/ui/commands.ts`.

## Read-only surfaces

`Monitor.presentationSnapshot()` returns detached data:

- `enabled`; progress `{done,total,kind: current|previous|empty}`.
- Optional card: task ID/revision/label, retained/replacementPending, assessedAt, all five copied health labels, optional exact-ID Beads display metadata.
- Activity and allowlisted service status.
- Separate Jev/extraction calls and input/output usage.
- Actual last Jev/extraction dispatch timestamps, distinct from assessment time.

`Monitor.debugSnapshot()` returns enabled, processing state, allowlisted service code/label and capped aggregate diagnostic counts. No transcript, task text, prompts, answers, credentials, raw provider errors or chronological records.

Neither method reads branch history, schedules work, persists state or mutates a card. `paint(ctx, snapshot)` receives no Monitor/branch capability. Theme invalidation and repeated renders initiate no analysis. The host publication callback is invoked after coherent mutation; renderers must not use reads as a mutation hook.

## Invariants for the next UI owner

1. Keep all five health fields and their order; do not collapse unknown into failure or health into reported completion.
2. Keep retained/as-of/replacement-pending provenance distinct from actual request freshness. Do not relabel a retained assessment with a new task label or revision.
3. Never infer focus from the first unfinished task. Focus does not assign tool evidence or block other tasks' completion.
4. Sanitize untrusted strings **before** applying trusted theme SGR. Clip by terminal display width, preserving trusted styling; do not strip ESC and leave literal color fragments. Tests exercise40/80 columns and real ANSI themes.
5. Show previous/unresolved scope without a current percentage. Beads export values are display-only.
6. Snapshots are the supported read seam, not the mutable public core state. A future subscriber API or debugger overlay needs its own lifecycle design; neither exists here.

## Explicitly deferred

`/progress debugger on|off`, a read-only live modal, full responsive redesign, richer event records, observer subscription API, advisory steering and V7 signals. Existing architecture-worktree plans remain research; this delivery supplies a smaller safe foundation, not those features.

## Manual QA after installation

Reload/restart the updated extension, then use a **fresh session**. Ask a question, read the answer, ask a distinct follow-up; each should be admitted and completed independently. Ask for three separate deliverables and report only the latter two: the first should remain open. Check colored40/80-column rendering, retained provenance, OFF/ON, and separate usage. Existing missed messages may already have accepted unchanged gates; updating files does not guarantee retroactive re-evaluation. The installed Git package is a separate checkout, not a symlink to the development worktree.
