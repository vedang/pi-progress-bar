# Progress UX presentation contract

This local candidate follows accepted hybrid root `0102cde4`. It does not publish, install or update a release. Owner manual acceptance remains separate from automated QA.

## Owned read-only surfaces

- `Monitor.presentationSnapshot()` supplies detached enabled/progress/service/usage/dispatch data.
- `Monitor.boardSnapshot()` supplies all retained tasks, lifecycle status, current-task selection, five health dimensions, qualified provenance, accepted optional detail values and safe transition names.
- `Monitor.debugSnapshot()` exposes only allowlisted service state and capped aggregate diagnostics.
- `src/ui/controller.ts` owns widget selection, subscriptions and its exact board overlay. `src/ui/host.ts` isolates the Pi0.85.1 editor/input/overlay APIs.

Snapshot reads, rendering, selection, scrolling, resize and debugger toggling never read canonical history, save, call providers, retry or poll. Optional detail text is materialized from canonical spans before publication, not during rendering. Untrusted controls are sanitized before trusted theme styling; wrapping preserves graphemes and terminal-width limits.

## Interaction and honest state

The widget shows reported done/included, an instantaneous 12-cell bar, actual last Jev dispatch, and current task. Right selects it only when the default editor is empty and safely focused; usage appears only while selected. Enter opens the centered 94%-width/80%-height board. Left/Escape returns selection.

The board lists newest-created tasks first. Arrows/PgUp/PgDn navigate; Left/Right/Tab switch panes; each pane scrolls independently. `d` toggles local diagnostics, Escape closes only this overlay. Required values remain scroll-reachable on narrow supported layouts. Too-small layouts request resize rather than clipping required information silently.

- **OPEN:** no accepted exclusive activity. Initial/fallback selection is explicitly provisional.
- **INPROG:** accepted exclusive semantic or safe ephemeral tool focus; not evidence or completion.
- **DONE:** accepted reported completion only. A qualified idle display retains the exact eligible previously displayed completed task.
- **ARCHIVED:** retained history excluded from the denominator.

None/concurrent/uncertain, stale generations, source changes and revision changes invalidate or requalify focus; they never invent completion. Manual-session `0/2` is valid threshold abstention, not a defect to hide.

## Summary and richer details

Service and the five health dimensions—Requirements, Acceptance, New red test, Red evidence, Implementation—each have one rendering owner. Roomy layouts pin their values; tight layouts use a single wrapped continuation. Health never establishes completion.

Task Title, Description and Acceptance Criteria are optional unique exact canonical quotes. Selected-model extraction proposes them alongside an otherwise independent mandatory patch. Jev validates them with full bounded canonical context and task-source authority. Only accepted yes judgments at confidence >=0.5 and probability >=0.8 appear. Ambiguous, inferred, hypothetical, cross-task, unsafe, rejected or stale values are omitted. The tracked Task label is never replaced.

Detail caps are 120/800 Unicode scalars and up to six 240-scalar criteria. Strict v8 stores spans/hashes and normalized receipts, not copied source text. Validation runs only after mandatory cursor commit; optional storage/failure cannot block semantic work. Saved receipts prevent rebilling covered candidates after restore; remote acceptance before a local save remains an unavoidable crash window.

## Tool focus and styling

Declared tools permit immediate provisional judgment. Final observed membership permits correction only when normalized identities/members changed. The exact 4KiB safe envelope contains tool names, safe repository-relative paths and fixed shell categories—not commands, arguments, output, secrets or runtime IDs. Focus is ephemeral and never task completion/evidence authority.

Styling is static: real filled cells and INPROG use accent; empty cells and DONE/ARCHIVED use dim; OPEN uses muted; selected rows preserve selected background. No animation was implemented or required. This is a conservative design choice, not a claim that Pi cannot animate.

## Candidate QA scope

The consolidated QA includes deterministic semantics/passivity/replay/capacity tests, Pi0.85.1 offline event integration, and an actual-host PTY matrix covering dark/light themes, regular/fullscreen, both listener orders, four geometries, standalone and actual pi-subagents co-load. Co-load proof registers the subagent tool but does not launch child agents or call providers. Live semantic calibration is separately bounded and covers tool patterns plus positive/negative optional details; it is not a general accuracy guarantee.

Independent review and owner manual acceptance are separately recorded in task tracking. No automated check counts as owner acceptance.

## Local manual testing

Use a fresh session: v7 and older checkpoints deliberately remain OFF; they are not migrated or rebuilt. Load this checkout explicitly rather than installing it over the stable package. Avoid loading both installed and candidate copies.

Test initial named OPEN selection, tool-only switching, reported completion/abstention, single-copy Summary, task-local debugger, long Unicode details, narrow resizing, OFF/ON, custom-editor input ownership and closing the board without disturbing another overlay. The installed Git package remains a separate checkout. Advisory nudges and release are owner-controlled follow-up work.
