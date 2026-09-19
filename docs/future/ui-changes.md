# Future plan: progress UI and task board

**Status:** Planning only. Requested future behavior; no implementation authorized by this document. Last updated: 2026-09-19. Current hybrid build `4a6b79da` is under manual QA and independent re-review, not final acceptance.

## Goals

Keep the always-visible widget quiet and truthful, while letting users **open the progress bar and inspect the actual task board being tracked**. Clearly separate one finished batch of work from the next.

## Confirmed new requirements

### Open the actual tracked task board

Provide an obvious way to expand/open the progress bar into a task-board view. The entry mechanism—command, keyboard shortcut or supported interaction—is still to be designed; do not assume terminal mouse support.

Show actual admitted tasks and their recorded states, not a second model-generated summary. Proposed contents:

- Task label and action/response kind.
- Not started, reopened or reported done; archived work separated from the active denominator.
- Current versus previous/unresolved scope and catch-up qualification.
- Revision/as-of information and a clear distinction between tracked status and assessed implementation evidence.
- Completed prior boards separately from current work, subject to an explicit retention policy.

Initial board should be read-only. Manual edits, drag-and-drop, completion checkboxes and execution controls are not requested. Debug processing reasons belong in the separate [debugger](debugger.md).

### Start from zero after a completed run

User requirement: **if an agent run ends with all tracked tasks completed, the next new message should start the progress bar from zero.** Do not carry yesterday's completed denominator into newly requested work.

Working interpretation for planning: the trigger is the next **user message starting a new turn**, not every assistant/tool message. Confirm the precise supported host event before implementation.

[tag:future_completed_cycle_reset] Begin a new visible tracking cycle only after the preceding run has ended and its included tasks are authoritatively recorded as complete, with no pending analysis or unresolved scope. Reset the current board/count—not historical truth or task statuses.

Expected progression:

1. Finished run shows its completed board, for example `3/3`.
2. On the next user turn, show an empty/new-work state, not 100% from the previous board.
3. When new tasks are admitted, show `0/N`, unless that same observation genuinely supplies accepted completion evidence.

Display an empty state rather than an invented `0/0` percentage. If unfinished tasks remain, do not silently discard them; preserve and reconcile them with the next request. Their end-of-run follow-up belongs in [advisory changes](advisory-changes.md).

This is a **task lifecycle change**, not merely setting the displayed numerator to zero. Specify how cycle boundaries, prior boards, stable IDs, archive/restore, bounded storage and reload/branch behavior work before coding. Do not clear durable evidence or trigger historical rebilling to simulate a visual reset.

## Always-visible widget direction

- Emphasize reported completion and task identity; reduce decorative noise.
- Preserve all five health fields: requirements, acceptance, usefulness of a new red test, red evidence and implementation assessment.
- Keep unknown, unverified, previous, retained and replacement-pending meanings distinct from success/failure.
- Show actual provider dispatch freshness separately from assessment as-of time.
- Keep focus/display selection separate from task completion and tool ownership.
- Support narrow/wide terminals and Unicode display widths; sanitize untrusted text before trusted theme styling.

Use the existing copied [presentation seam](../design/hybrid-presentation.md). Opening the board must not introduce inference, refresh polling or direct access to mutable monitor state. A new bounded task-board projection will be needed: the existing card snapshot is not the full ledger.

## Decisions still needed

- Board entry/navigation/close mechanism and whether it shares an overlay shell with the debugger while keeping their contents distinct.
- Whether “new message” means every new user turn or a narrower new-goal boundary; the requested default above is every new user turn after a completed run.
- Handling a user message that arrives before final asynchronous completion analysis settles.
- Historical board retention, archive visibility and behavior when task/event/checkpoint caps are reached. Do not promise unlimited boards.
- Whether the old health card stays visibly retained while the new board is empty; never relabel old values as a new assessment.

## Delivery and acceptance

1. Define and test completed-run/new-turn lifecycle independently of visual layout.
2. Add a pure bounded board projection matching authoritative task IDs and statuses.
3. Build the read-only board, then refine the always-visible widget.
4. Test completed→new turn, unfinished→new turn, delayed analysis, cancellation, duplicate hooks, reload and branch changes.
5. Verify no lost unfinished obligations, no fake completion, no task-ID collision or rebilling, and exact agreement between board and progress fraction.
6. Test real terminal navigation/resize/theme behavior and all five health/provenance fields.

Consolidates the architecture worktree's 2026-09-19 always-visible UI/Tufte research. Fullscreen-specific features remain optional research, not a dependency or current implementation promise.
