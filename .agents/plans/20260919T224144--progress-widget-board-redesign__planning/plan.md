# Progress widget and task-board UX plan

**Status:** Ready for owner review; planning only, not implementation authorization. Revised after independent review; corrections below are main-agent decisions, not a claim of independent re-approval. No runtime/tests/provider calls changed or run.

## 1. Product contract

### Widget

Place named widget **below the editor**. Ready/current, unselected state has two rows:

```text
Reported 7/12 · 58%  ███████░░░░░  Jev 10:03:12
Current Task: Handle escaped delimiters in parser
```

Right selects it, under the safe input conditions below. Selection reveals:

```text
Jev · ↓ 10.4K · ↑ 765 tokens • Extraction · ↓ 1425 · ↑ 194 tokens
```

Down = input, up = output. No token usage when unselected. Proposed formatting: integers below 10,000, one-decimal K above; test rounding boundaries. Add selected-only `Enter: task board · Left/Esc: back` hint where space permits. Enter opens board. Left/Esc returns selection to editor; ordinary typing deselects and passes through.

Count is reported task completion, not correctness/effort. Compute 12-cell fill directly from done/total, independently of integer percentage. No invented minimum fill. Empty/unresolved scope gets no percentage/bar. Task identity follows accepted assistant/tool activity, never first unfinished or newest as a focus heuristic.

### Task board

A **bounded modal**, not full-height. Approximate 40/60 split, inspired by screenshot and beads_viewer: dense selected task row left, readable headings/wrapped details right. No priorities, graph analysis, assignees, exports or task mutations.

Left: **all retained tracked tasks**, newest admission first; completed/archived included with distinct status. Newest means immutable admission order, not last update. Scroll/paginate viewport without truncating logical list. Existing retention/capacity limits remain explicit; no unlimited-history promise.

Right: tracked label/identity and lifecycle metadata always visible, followed by:

```text
Summary:
• Requirements: mostly clear
• Acceptance: explicit
• New red test: Not needed
• Red evidence: Not needed
• Implementation: Not needed
```

Actual assessment values only—these example values are not defaults. Unassessed tasks show all five fields as `Unassessed`, distinct from an assessed `Unknown`/`unverified`. Include assessment time and retained/stale/replacement-pending provenance. Optional Task Title, Description and Acceptance Criteria sections appear only with grounded, confidence-accepted fields. The tracked label is always available even when richer title is omitted.

Controls proposed: Up/Down select tasks; PageUp/PageDown/Home/End navigate list; Left/Right or Tab switches active pane; arrows/pages in right pane scroll details. `d` in right pane toggles selected-task Debugger section; Esc closes modal, optional q alias. Footer shows controls. Selection stays on task ID as live state changes; activity highlighting does not move the user's selection.

### Debugger

Only inside right task pane, behind `d`. No standalone debugger modal/command. Show safe task-linked transition facts and assessment provenance. Session-wide processing/service/aggregate counters, if shown here, must be explicitly marked **Session-wide**, not attributed to selected task. No raw prompts, replies/errors, branch content, source IDs/hashes, credentials or tool payloads. Ordinary service/blocking warnings remain visible without debugger.

## 2. Baseline and source evidence

Arch planning workspace `mukwqolr` / `3dd3d381`, parent `b18ca85c` (rewritten from initial `357d51f6`). Root is ahead; **pin accepted root revision before implementation**, not this older source. Root owner reports canonical intercom admission and v6 message-driven Jev focus (`62293575` + `470dab83` candidate at report time), no per-task health map/board projection. Tools currently affect health, not focus. Full root acceptance was pending. Details: `owner-updates.md`.

Inspected seams:
- `src/ui/widget.ts`: above-editor default placement, multiline single-card display, usage always shown, snapshots only.
- `src/ui/commands.ts`: ON/OFF/help, including aggregate diagnostics currently in ordinary help.
- `src/index.ts`, `src/core/monitor.ts`: event wiring, publication, restore, single retained card, usage and actual dispatch timestamps.
- `src/core/hybrid{,-state,-checkpoint,-proof}.ts`: lifecycle, canonical proofs, durable pending work, bounds.
- `src/analysis/{extractor,completion,health,implementation,gateway}.ts`, `src/sources/evidence.ts`: extraction, judgments, provider and evidence boundaries.
- Local Pi 0.84.2 and installed 0.85.1 docs/source were research references. **Support only the host contract pinned with accepted root**, not an unrequested dual-version compatibility layer.
- pi-subagents ref `9275737c1d780b6830437eb9e661c8262efe2496`, `src/tui/fleet-status.ts`: input listener ownership, selection/viewport/disposal patterns. Do not copy loose editor duck typing.
- beads_viewer ref `473d9e433460bbe70efbd7215801c4b4ebd8d086`, `pkg/ui/model.go`: list/detail hierarchy, navigation, wrapping.
- User screenshot `/tmp/Screenshot 2026-09-19 at 10.28.00 PM.png` inspected successfully. Desktop EPERM superseded. Screenshot informs pane appearance, not modal height.

Reviewer source findings verified/used:
- Pi TUI `dist/tui.js:553-574`: listeners receive pipeline-transformed input, not original physical keys.
- Pi interactive host `dist/modes/interactive/interactive-mode.js:2137-2149`: custom overlay done closes generic top overlay. **Do not use this path for board ownership.**
- Pi TUI `dist/tui.d.ts:112-124`: exact `OverlayHandle.hide()` and `isFocused()` available.
- Current `hybrid-checkpoint.ts:1207-1228` / `monitor.ts:398-423`: restore failure conflates missing/unsupported/corrupt; must distinguish before schema changes.
- `hybrid.ts:842-903`: mandatory extraction/completion/cursor pipeline. Optional details cannot enter as a blocking phase.
- `hybrid.ts:300-313`, `monitor.ts:1498-1506`: task revision/label alone do not establish exact health provenance.

## 3. Architecture and invariants

[tag:ux_passive_views] One UI controller owns cached detached snapshots, below-editor component, input subscription, modal handle and local selection/scroll/debug state. Committed monitor publication updates both surfaces. Opening/rendering/navigation/resize/closing never reads canonical history, persists monitor state, dispatches inference, retries or schedules polling.

[tag:ux_focus_not_evidence] Assistant semantic focus is reused from accepted root. Additional tool activity focus is a display judgment only: no task admission, completion, health ownership, EvidenceLink, or mutation of semantic focus. Board selection is a third, view-local concept.

[tag:ux_optional_isolation] Optional details, health retention and activity analysis have independent failure/capacity outcomes. They must not stall mandatory admission/completion/cursor commit or set semantic global capacity limit.

[tag:ux_owned_overlay] Capture host TUI through widget factory; use `tui.showOverlay(component, options)` and retain its exact handle. Close via that handle's `hide()`, not `ctx.ui.custom({overlay:true})`, generic hideOverlay, or another extension's handle. Component disposal is idempotent and owned separately; no host custom-UI promise exists to strand.

### Input and lifecycle

Activation predicate: enabled TUI widget, board closed, no competing overlay, known main editor focused, no configured custom editor, editor text exactly empty, pipeline-visible non-release Right. Capture editor identity only at a proven host point; unknown identity means do not intercept. `getEditorComponent()` is factory access, not a direct editor instance getter. Host proof must establish reliable identity; never infer it by arbitrary method names.

Right means input **as received after earlier listeners**. Host does not expose original key/priority: another extension transforming keys can affect this. Tests cover both listener orders; pass-through preserves received data, not an impossible original-byte guarantee. Do not register globally unconditional bare Right shortcuts.

While selected: Enter opens one board; Right no-op; Left/Esc deselect; other input deselects and passes through. Loss of focus/empty-editor/overlay preconditions clears selection. Board captures keys only while its exact handle is focused.

Session replacement, successful branch change, OFF, reload, shutdown: invalidate generation; remove owned widget/listener; hide exact board handle and dispose once. Cancelled navigation leaves board intact. Stale publications/results cannot touch new generation. Closing a lower board while another overlay is above must preserve that overlay and focus. If supported host cannot prove these contracts, stop for owner/host decision; no fallback editor replacement/fullscreen shell without approval.

### Normal warnings and small terminals

Ready fixture stays exact. Non-ready first-row priority: unsupported/corrupt restore → semantic capacity block → unresolved/previous scope → catch-up → service unavailable → retry/analysis waiting → ready. Keep two normal rows; drop bar before warning, then percentage, never relabel historical progress current. Bound/clamp fields by display columns; tiny widths use short truthful status, not misleading fragments.

Board shows global service/blocking banner outside Debugger. Summary shows safe assessment time/provenance beside all five labels. Unknown is not failure; provider failure does not alter task judgment. Selected token line may wrap on narrow terminals. Modal proposed width 94%, max-height 80%, centered, one-cell margin. Exact options/minimum size proven on host. At unusable dimensions show explicit size notice with functional Esc; do not silently remove health dimensions.

## 4. Dependency-ordered implementation slices

Main agent creates failing tests before each behavior change; implementation subagents never author tests. Each slice has its own jj commit, no branch creation. Deliver working layers, not one giant schema/UI cutover.

### A0 — Freeze accepted runtime and prove host controls

Files: `src/ui/host.ts` (new), `__tests__/ui-host-contract.test.ts`, static host-probe fixture.
- Pin accepted root and its supported host. Reconcile existing focus/intercom changes; read host extension/TUI/keybinding docs completely before implementation.
- Prove belowEditor placement, widget TUI capture, editor identity, pipeline Right behavior, exact showOverlay/hide ownership, resize and listener lifecycle.
- Static snapshots only, no provider/network. Test empty vs nonempty editor, custom editor, sibling overlays, listener orders, release events, OFF/reload/branch cancellation and tiny dimensions.
**Gate:** no broad Right interception, no wrong-overlay close, no focus/promise leaks. Unsupported host capability is a blocker, not a guessed workaround.

### A1 — Stable task ordering and safe strict restore

Files: `hybrid-state.ts`, `hybrid.ts`, `hybrid-checkpoint.ts`, `hybrid-proof.ts`, `monitor.ts`, `index.ts`, `ui/commands.ts`; checkpoint/replay/monitor/host tests.
- Prefer existing durable create order if it is provably immutable/complete; otherwise add immutable admissionOrdinal plus next counter. Add assigns; revise/restore/archive/reopen preserve. Descending ordinal, ID tie-breaker. All retained tasks remain reachable (currently 200-task cap; re-inventory accepted runtime).
- Strict new checkpoint schema only when necessary; **no migration or compatibility decoder**. Distinguish restore results absent/restored/unsupported-version/corrupt. Absent is fresh; unsupported/corrupt preserves stored entry, latches monitor blocked/OFF, performs zero save or dispatch and cannot be bypassed by ordinary ON. Explain fresh-session rollout in status/help. Do not silently rebuild/rebill history.
- Include new state in exact undo/replay/hashes/admission; interrupted current-version replay must not rebill.
**Red cases:** multi-add order, later adds, revise/restore stability, malformed/old schema with zero writes/calls, byte-edge current schema, branch/reload.

### A2 — Task-specific health and pure board projection

Files: `monitor.ts`, `hybrid-state.ts`, `hybrid-checkpoint.ts`, new `core/board-projection.ts`; health/view/projection/checkpoint tests.
- Store at most one accepted card per retained task, with exact assessment provenance: task source identity, triggering observation, health request/snapshot identity, relevant evidence/code identities. Include canonical refs in amendment validation. Safe output exposes only role/time/retained/stale/replacement qualifiers, never raw IDs/hashes.
- Same-label cosmetic revise or source amendment must not keep falsely current health. Provenance mismatch → all five Unassessed (or explicitly separated historical assessment, never current Summary).
- Preserve existing semantic health scheduling; selecting any task never requests assessment. Tasks never assessed remain Unassessed.
- Before health request, preflight whole checkpoint including existing card map plus worst-case new/replacement card and saturated usage/timestamps. Optional denial skips call, preserves semantic lifecycle, exposes safe status. New card map remains byte-bounded as well as task-count-bounded.
- `boardSnapshot()` detached all-task projection: label, kind, status, inclusion/archive, order, safe exact health/provenance, task transitions and clearly separated global status. Optional details absent initially. Never derive per-task reasons from global aggregate counters.
**Red cases:** two distinct cards, source amendments/cosmetic revisions, archived/done, no assessment, returned-object mutation, sentinel leakage, 200 tasks/1,000 events, byte edges zero fetch, reads causing zero side effects.

### A3 — Two-row widget and local selection

Files: `ui/widget.ts`, new `ui/controller.ts`, `ui/host.ts`, `index.ts`, `ui/commands.ts`; renderer/controller/index tests.
- Persistent below-editor component; render copied snapshot plus selected flag. Exact product copy/usage above; all five health fields leave widget for board.
- Implement A0 input contract and selected hint. Keep controls discoverable through `/progress` help. Remove debug aggregates from normal help; no standalone debugger commands.
- One controller per UI generation, one input unsubscribe; monitor publication refreshes cached views, not component replacement on every update.
**Red cases:** exact 7/12 copy/fill/usage, rounding, 40/80/120 columns, previous/empty/warnings, ANSI/wide/combining text, repeated selection/typing/publication, stale callbacks, zero provider/history/save deltas.

### A4 — Bounded board and board-local debugger

Files: new `ui/board.ts`, `ui/layout.ts`; controller wiring; board/layout/navigation tests.
- Own direct TUI overlay handle per [ref:ux_owned_overlay]. Bounded 40/60 panes, selected row contrast, status/label columns, detail headings/bullets and footer.
- Default selection: valid current display task, then newest as **navigation default only**, never inferred activity. Preserve ID on refresh; if removed choose nearest retained neighbor. Separate list viewport/detail scroll. All retained tasks reachable.
- Right pane identity + always-visible service banner + five-field Summary/provenance. `d` toggles task debugger only here, with explicit global-counter label. Summary not replaced; long content scrolls.
**Red cases:** 0/1/max tasks, page edges, new insertions without cursor jumps, live status changes, repeated open/close, neighboring overlay during teardown, no stale task cross-link, resize/themes/unicode, UI differential equivalence.
**Layer A usable result:** requested basic widget, selectable usage, board/health/debugger, using accepted message focus. Tool-driven focus follows next; do not call whole UX done yet.

### B — Tool-driven current-task judgment

Files: new `analysis/activity-focus.ts`, `monitor.ts`, `index.ts`; focus/host/privacy/admission tests.
- Reuse canonical assistant message focus; **no duplicate raw message_end focus call**. New inference uses tool-start evidence only. Do not call transformed in-flight assistant text final.
- At host-proven finalized assistant tool-call set, assign an activity batch and expected tool-call IDs. Accumulate starts into that batch before dispatch; close at all expected starts or turn_end for partial/cancelled sets. Validate actual host order in A0/B proof. If exact call-set access is unsupported, stop and specify an alternative with owner—do not silently use last-start-wins or timers.
- One batch contains every started member, bounded by 4 KiB. Proposed privacy envelope: tool name, repo-relative file path for known read/write/edit tools, shell category (test/build/search/vcs/other), no raw shell text/arbitrary args/results/errors/secrets. Unknown tools disclose name only. Overflow yields explicit insufficient activity/uncertain, not silently dropped members. Validate this minimal evidence can distinguish tasks; richer fields require explicit policy decision.
- One queued latest complete batch, one active request. New batch replaces queued older batch, not facts inside a batch. Use monotonic session/semantic/source/model/activity generations; response applies only if all match. Semantic work has priority; preempt stale optional work. Batches are event-driven, no interval polling.
- Expected calls: one completed isolated batch → one Jev call; two sequential batches after settlement → two; two queued before dispatch → latest only; semantic preemption before dispatch → zero for obsolete batch; already dispatched stale result consumes recorded usage but never changes focus. Parallel batch can yield concurrent.
- Preflight entire checkpoint's saturated usage/dispatch metadata before optional call; denial skips activity inference, not semantic tracking. Track actual calls even on failure; UI interaction causes none.
- Outcomes exclusive/none/concurrent/uncertain. Never force first/newest. New pending evidence marks old display result stale/pending inline rather than calling it fresh. New abstention clears exclusivity; valid semantic focus is fallback only when no newer tool judgment/pending evidence supersedes it. Task close/revise invalidates exact focus; OFF/session/branch clears ephemeral activity focus. Do not persist/replay raw tool activity.
**Red cases:** A→B tools, parallel A+B, unknown tool, >4KiB, no/uncertain, rapid batches, late response, semantic preemption, closed/revised task, zero metadata capacity, OFF/reload and sentinel leakage.
**Live evaluation:** bounded real-Jev fixtures for actual tool patterns, labels and parallel work; report abstention/correct-focus and latency, not just mocked correctness. Jev permission exists; no extra selected-model authorization inferred. [ref:ux_focus_not_evidence]

### C — Optional confidence-gated rich details

Files: `analysis/extractor.ts`, new `analysis/task-details.ts`, state/checkpoint/proof/monitor, board projection; parser/grounding/detail/replay/admission tests.
- Inspect already-sent Jev/extraction state first: reuse supported grounded facts rather than invent prose. Separate structural operation parsing from optional candidates. Absent/invalid detail data produces zero candidates, never invalidates valid task operations.
- Finish mandatory extraction, completion and cursor commit **before** optional validation. Persist separate bounded enrichment jobs keyed by task ID/revision/source identity. They do not enter mandatory pending phase or block later observations. Requirement changes invalidate prior detail jobs/results; cosmetic source changes require provenance revalidation.
- Candidate text must be grounded by exact unique source quote, task-scoped, bounded and safe. Proposed caps title120, description800, six criteria240 Unicode scalars; no forced fields. Display tracked label regardless.
- Jev validates independent candidates in natural batches (proposed max20 questions). Store exact accepted request/result receipts before advancing each job; interrupted accepted batches are not rebilled. Stale jobs discarded safely. Network failure parks optional jobs; optional byte-cap denial drops/parks enrichment with no semantic limit state.
- Full checkpoint/job/result/usage worst-case admission **before** each optional request. Do not assume number-of-tasks cap alone proves byte capacity.
- Proposed acceptance confidence≥0.5 AND chosen probability≥0.8 AND yes (not uncertain); these are **not approved/calibrated**. Approve and evaluate policy before enabling rich sections. Render only accepted per-field results, safe source role/time/confidence; rejected/unknown sections entirely absent.
**Red cases:** malformed optional data + valid structural task, provider failure/near-capacity + subsequent user task, stale source/revision, interrupted batch no rebilling, cross-task leakage, exact threshold boundaries, optional read-only projection.
**Layer C optional:** can remain disabled without blocking A+B delivery. [ref:ux_optional_isolation]

### D — Acceptance and documentation

- Differential replay: same canonical/task/tool activity, board absent versus repeated selection/open/navigate/debug/resize/close. Identical semantic state/checkpoint, provider bodies/counts, usage, retries, history reads, persistence. UI generation/local selection differences only. [ref:ux_passive_views]
- Main gates after batches: `make format`, `make check`, `make test` (Makefile contains all; test runs unit then integration). Provider/live suite remains separate. Missing future targets recorded unavailable with native alternative; real failures block release.
- Static real-host QA on pinned supported host: 120×40,80×24,60×20,40×16; light/dark/monochrome; long CJK/combining labels; default/custom editor; pi-subagents alongside; sibling overlays; OFF/ON; shutdown/reload; successful/cancelled branch/session change; asynchronous publications. No provider work needed for this QA.
- Full batch independent review after implementation. Real Jev needed for changed semantic judgments, not modal appearance.
- Update README, PRODUCT, `docs/design/hybrid-presentation.md`, three future UX docs. Record controls, status meanings, task bounds, strict-schema fresh-session rollout, optional details and privacy. Supersede standalone debugger and always-visible health proposals. Do not label implementation delivered during planning.

## 5. Scope and decisions

**Explicitly excluded:** completed-run→next-turn fresh cycle (separate lifecycle proposal), task editing/checkboxes, execution controls, advisory nudges, historic rebuilding, compatibility/migrations, fullscreen requirement, unlimited board history, importing Beads as authoritative task state.

**Proposed defaults to confirm during plan approval:** Right only from empty standard editor; d/right-pane debugger; 94%×80% modal; detail thresholds/field bounds; tool metadata allowlist and overflow abstention. Host focus/overlay and batch-boundary proofs are engineering gates, not tested facts.

Main acceptance risks: safe bare-key activation cannot be guaranteed for arbitrary key-transforming extensions; captured editor identity needs real-host proof; minimal tool metadata may be insufficient for useful focus; all durable additions need whole-checkpoint byte proof; existing root source is moving. Stop on unresolved proof rather than silently widening authority or hiding uncertainty.
