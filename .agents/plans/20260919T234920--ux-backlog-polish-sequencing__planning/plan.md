# Approved UX backlog and beautification sequencing

User approved UX plan and asks for detailed Beads, not runtime implementation in this turn.

Source: `.agents/plans/20260919T224144--progress-widget-board-redesign__planning/plan.md`, including pre-existing hint edits preserved in parent jj change95996db3.

1. Create one native parent epic and detailed dependency-ordered child tasks covering complete functional A0–D plan, test-first ownership and exact acceptance evidence.
2. Full functional version includes tool focus AND confidence-gated rich details before manual-QA handoff. Earlier possibility of deferring rich details no longer defines the full-plan handoff.
3. After accepted functional handoff, allow user manual testing and optional visual polish work concurrently. Never mutate the exact manual-QA build in place; preserve revision/load instructions and identify polished candidate separately.
4. Beautification: theme-aware contrast/color/spacing first; bounded optional animation only if host proof shows no inference/history/persistence side effects, no artificial progress, no blocking input, no leaked redraw timers. Honor reduced-motion setting; static default unless user chooses otherwise. Do not animate health or interpolate task completion. Unicode block glyphs are not ASCII; supply documented plain fallback where needed, not guessed terminal detection.
5. Existing plan adds `→ to inspect` and `enter to see board`: treat as discoverability requirement. Two data rows plus explicit hint row by default; selected state adds requested usage and enter hint. Reconcile stale exact-two-total-rows wording in implementation docs/tests; do not delete supplied hints.
6. Beads native parent-child only for containment; blocking edges only among work items. No reverse epic→child blocking edges.
7. Verify descriptions/acceptance coverage and dependency graph; independent full-backlog review; sync and commit. No implementation, test execution, provider calls or branch changes.
