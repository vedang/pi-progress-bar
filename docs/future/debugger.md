# Future plan: progress debugger

**Status:** Planning only. Requested future capability; no implementation authorized by this document. Last updated: 2026-09-19. Current hybrid build `4a6b79da` is under manual QA and independent re-review, not final acceptance.

## Goal

Explain **why the tracker behaved as it did** without cluttering the normal progress widget. This is separate from the [user-facing task board](ui-changes.md), which explains **what work is being tracked**.

## Confirmed direction

- A live, read-only debugger opened with `/progress debugger on` and closed with `/progress debugger off` or Esc.
- Human-readable processing state and diagnostic counts, not raw internal codes in the normal widget or ordinary command output.
- No reset, retry, task edit, manual completion, monitoring toggle or inference triggered by the debugger.
- Keep meaningful user-facing warnings outside the debugger: catching up, unresolved/previous scope, unavailable service and retained/as-of assessments must remain visible.

## Proposed first version

Show a compact diagnostic summary:

1. Monitor ON/OFF, idle/processing/waiting and historical catch-up qualification.
2. Current service condition and safe rejection/retry explanations.
3. Actual last Jev and selected-model dispatch times, separate from assessment time.
4. Allowlisted aggregate diagnostic counts, clearly labelled as historical occurrences—not current task counts or a chronological event log.

Unknown codes receive generic safe wording. Do not show raw prompts, provider replies/errors, credentials, branch text, tool output or source/session IDs. Do not invent timestamps or event ordering for aggregate counters. Re-inventory actual counter limits and reset semantics before implementation; older research numbers are not the current contract.

## Existing foundation and implementation boundary

The hybrid already exposes copied `Monitor.presentationSnapshot()` and `debugSnapshot()` values. Use these as the starting point; see [presentation seam](../design/hybrid-presentation.md).

[tag:future_debugger_passive] Opening, scrolling, rendering or closing the debugger must not read canonical history, mutate monitor state, persist data, dispatch inference, reset diagnostics or introduce polling. Only view-local state changes.

Feed committed snapshots to one owned modal. Add a narrowly scoped publication/subscription seam only if the accepted runtime lacks one; do not create a new scheduler or duplicate diagnostic store. Guard disposal and late callbacks by UI instance/session generation.

## Decisions and host proofs still needed

- Focused modal versus a surface that leaves the editor usable. In a focused modal, users cannot type `debugger off` through it; Esc must remain reliable.
- Read-only scrolling and short-terminal behavior; reserve a visible close hint where width permits.
- Actual-host proof that closing this overlay cannot close another extension's overlay, strand focus or leave its Promise unresolved.
- Successful branch/session changes should close the old modal; cancelled navigation must not prematurely destroy it.
- Opening while monitoring is OFF must stay read-only. Non-TUI invocation should fail clearly or be a documented no-op, never start hidden UI work.

## Delivery and acceptance

1. Rebase this plan on the accepted hybrid runtime and inventory emitted diagnostics/publications.
2. Prove owned overlay lifecycle on supported Pi hosts before production implementation.
3. Build pure safe projection and singleton read-only UI, then route commands and remove debug-only clutter from ordinary surfaces.
4. Differential tests with debugger open/closed must produce identical task state, provider calls, branch reads, persistence and retry behavior.
5. Test repeated open/close, OFF, reload, branch changes, neighboring overlays, terminal resize, ANSI, wide/combining characters and tiny widths/heights.

No paid model calls are needed merely to validate a diagnostic renderer. Full visual redesign belongs in [UI changes](ui-changes.md); nudges belong in [advisory changes](advisory-changes.md).

## Prior research

Consolidates the architecture worktree's 2026-09-19 debugger-overlay plan. Its interval/v4/span-only assumptions and absence of snapshot APIs are obsolete; its passive rendering and owned-overlay safety requirements remain relevant. This tracked document is the portable future-plan entry point.
