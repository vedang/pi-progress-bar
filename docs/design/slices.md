---
shaping: true
---
# Vertical slices — passive progress monitor

**Proposed implementation sequence; none implemented.** Product v1 comprises V1–V7 below. Each slice extends a working Pi UI and includes its own tests, failure behavior and demo. These are not seven product releases. No coding begins until user review/next-step instruction.

Canonical affordance IDs and wiring are in [breadboard.md](breadboard.md); requirements/mechanisms in [shape.md](shape.md). The tables here project those affordances into slices without redefining their wiring. Existing affordances listed under extensions are changed, not reassigned to a new first-delivery slice.

## Slice summary

| Slice | User-visible capability                                       | Shape parts        | Depends on             | Demo                                                                                                                                  |
|-------|---------------------------------------------------------------|--------------------|------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| V1    | Follow a chosen checklist with an honest reported bar         | A1, A3, A6, A7     | —                      | Select plan section/task; check one item; bar updates at next configured refresh (default 15s). Inspect exact source.                 |
| V2    | Learn Jev through clarity and acceptance signals              | A4, A5, A6, A7     | V1                     | Enable analysis after preview; compare vague vs concrete task text; inspect raw answers and unknown states.                           |
| V3    | Discover plan and interpret reports from actual Pi trajectory | A1, A2, A3, A4     | V2                     | Agent states a plan, then reports two tasks done; selected conversation-source bar updates; intentions/quotes do not.                 |
| V4    | Follow scoped Beads exports without br/bv dependency          | A3, A6             | V1; integrate after V3 | Select issue IDs from export; externally update/export status; bar changes with export provenance.                                    |
| V5    | Show useful red-test applicability and evidence               | A1, A4, A5, A6     | V2; integrate after V4 | Planning task shows Not needed; explicit agent claim shows Reported red; actual matching failure upgrades provenance to Observed red. |
| V6    | Assess implementation against selected criteria               | A4, A5, A6         | V2, V5                 | Reported task remains done while unmet or unverified criterion keeps implementation Partial/Unverified.                               |
| V7    | Distinguish advancement, possible loops and drift             | A1, A4, A5, A6, A7 | V3, V5, V6             | Replay useful investigation, repeated failure, long wait and unrelated work; each yields distinct coverage-aware signals.             |

Recommended delivery is sequential V1 → V2 → V3 → V4 → V5 → V6 → V7. The dependencies column also exposes genuinely reusable seams; it is not authorization to run concurrent writers.

## Common delivery contract

- Every slice ends with an observable UI demo. No separate backend-only, framework, testing, or hardening phase.
- Main agent writes behavior-focused failing tests where appropriate, then implementation follows. Documentation edits or speculative fixture catalogs do not need ceremonial red tests.
- Deterministic tests use replay events, fake clocks and injected transport; live Jev evaluation is explicit opt-in, separate from ordinary tests.
- Run repository-native format/check/test gates as they exist after V1 bootstrap. Add packaging/typecheck/test setup only as needed for V1's running demo.
- No installer side effects, hidden project commands, tool-result mutation, messages to agent, task-source edits, automatic alerts, or child-worker observation.
- Preserve unknown/conflict/as-of/offline states and label experimental semantic judgments. A typed answer or high confidence never proves correctness.
- Source selection/consent, cancellation, stale-result rejection, width safety and privacy arrive with the feature needing them—not in a final cleanup slice.
- Each slice reviews the full increment's behavior and existing regressions. This plan does not prescribe starting an independent reviewer after every tiny edit.

## V1 — A selected checklist becomes a reported bar

**User outcome:** useful local-only monitor, no Jev credential required. This is the arithmetic/evidence baseline for the first Jev experiment in V2.

**Entry:** `/progress source` selects an approved workspace file/section and its current task. Initially support a documented unambiguous checklist shape; do not pretend arbitrary Markdown has reliable task boundaries.

### Added affordances

| IDs                | Added behavior                                                                                    |
|--------------------|---------------------------------------------------------------------------------------------------|
| P1, P2, P3, P5     | Main Pi widget, evidence inspector, source selector and local engine boundary.                    |
| U1, U2, U3         | Reported bar, current task/source, freshness/activity and no-plan state.                          |
| U11, U12, U26      | User-invoked details/source and refresh-interval commands.                                        |
| U15, U18           | Inspect ledger/source references and close inspector.                                             |
| U19, U20, U21, U22 | Draft source/section/scope/task selection, apply or cancel without editing source.                |
| N1, N2, N3         | Session lifecycle, branch-scoped restore, timer/abort/widget cleanup.                             |
| N4, N5, N6         | Configurable local refresh (default 15s), normalized bounded observations, approved source reads. |
| N8, N13            | Revisioned ledger and reported-only integer arithmetic.                                           |
| N14, N15, N16      | Width-safe named widget, metadata persistence, inspector entry.                                   |
| N18, N19, N23, N24 | Apply selection, open selector, inspect data, maintain unapplied draft.                           |
| N29                | Validate and apply refresh interval; replace timer and persist preference.                        |
| S1, S2, S3, S4     | Runtime identity, bounded evidence, candidates, selected ledger.                                  |
| S8, S9, S12        | Pi metadata checkpoint, read-only external sources, selection draft.                              |

**Demo:** choose five direct checklist tasks, two checked. Display `2/5 · 40% reported`. Check another externally; next tick shows `3/5 · 60%`. Reorder unchanged uniquely identified tasks without losing identities. Close/reload and reselect/revalidate as needed; no unrelated Pi branch contributes status.

**Acceptance checks:**
- No plan/empty scope produces no percentage, not 0% or 100% certainty. Nested criteria and parent headings are not extra tasks.
- Preview/cancel source changes do not alter active ledger; Apply does. Unknown current task does not mean first unchecked item.
- Counts come only from selected source. An implementation-looking message has no effect.
- Scope changes are explicit; missing/partial/unreadable source retains aged prior snapshot or unknown, never silently shrinks denominator.
- Refresh defaults to 15s; `/progress interval <seconds>` accepts finite positive seconds, rejects invalid values without mutation, and replaces the existing timer. Saved interval restores from current-branch metadata. Refresh does not block tools or input. Every rendered line fits available width and uses existing Pi theme.
- Shutdown/reload/tree/session replacement cleans own resources and invalidates old state. Restore reads current branch only; stored state is labeled as-of until source revalidated.
- Read boundaries, symlinks, byte limits and private shell exclusion enforced. No network calls or key access needed.

**Defer:** arbitrary prose extraction, automatic discovery, Beads, all Jev judgments. UI explains not-yet-supported signals rather than displaying fake healthy values.

**Learning/demo gate:** validate what percentage actually means before adding model-derived information. V1 has more plumbing than later slices because it owns the one host lifecycle; scope stays one source and one visible workflow.

## V2 — First Jev signals, inspectable and consented

**User outcome:** clarity and acceptance indicators for selected task, with source evidence and raw distributions.

### Added affordances

| IDs                | Added behavior                                                                              |
|--------------------|---------------------------------------------------------------------------------------------|
| P4, P6             | User-invoked transfer disclosure and TypeSafe API boundary.                                 |
| U4, U5             | Clarity and acceptance indicators.                                                          |
| U13, U14           | Enable and pause/resume analysis controls.                                                  |
| U16, U17           | Inspect question/rubric/distribution, selected outbound evidence and omissions.             |
| U23, U24, U25      | Preview transfer scope and explicitly allow/cancel.                                         |
| N9, N10, N11, N12  | Shared bounded Jev gateway, question orchestration, evidence snapshot and health reduction. |
| N21, N25, N26, N27 | Disclosure, session consent, HTTP endpoint, pause/resume.                                   |
| S5, S6, S7, S13    | Health results, consent, ephemeral request provenance, versioned questions/budgets.         |

**Extend:** N4 schedules changed-state analysis; N14 renders U4/U5; N23 shows distributions. Future semantic tasks must reuse N9's gate rather than create a second network loop.

**Demo:** local reported bar works with analysis disabled. User previews selected task text and enables Jev. A vague task and a revised concrete task produce inspectable Score/acceptance answers. Simulate timeout: bar still works, semantic rows show Offline/Stale. Pause stops analysis, not the agent or local counting.

**Acceptance checks:**
- No billable requests before explicit consent; reload/replacement resets consent. No credential in state, logs, metadata or inspector.
- One in-flight request, bounded payload/deadline/retry policy, no tick backlog. Unchanged evidence is not re-sent merely because a refresh tick passed.
- Unknown task, missing goal or omitted essential evidence is gated before inference. Unknown is not a zero score.
- Old session/task/source responses cannot overwrite new identity. Same-task older evidence is explicitly as-of, not silently current. Pause/withdrawal invalidates outstanding work.
- Exact question text includes meaning; question IDs are bookkeeping. Score is not completion or correctness percentage; Noul has no separate confidence.
- Approved small live replay records request usage/latency and mismatch notes. Deterministic gates use stubbed transport; no live calls in normal tests.

**Defer:** overall model-estimated completion forever under current product scope; source discovery, test evidence, implementation/temporal signals to later slices.

## V3 — Actual trajectory yields plan and reported progress

**User outcome:** no required plan file or Beads. Agent's real plan statements and explicit reports become a selected, inspectable task ledger.

### Added affordances

| IDs | Added behavior                                                                    |
|-----|-----------------------------------------------------------------------------------|
| N7  | Bounded source candidate selection from actual Pi trajectory.                     |
| N17 | Per-known-task interpretation of explicit completion/reopen/cancellation reports. |

**Extend existing visible affordances:** U19 shows discovered source spans and ambiguity; U20 allows scope/current-task correction; U1/U2/U3 show conversation-reported progress and provenance. Extend N5/S2 with known trusted interactive-answer provenance, N8 identity reconciliation, S3 candidates, S13 source/report questions. No new UI place or independent network client.

**Demo:** Pi records a three-task plan. Monitor proposes/selects it when unambiguous. Agent explicitly says tasks one and two finished; bar becomes `2/3 reported`. “I will finish task three” and a quoted completion example do not change count. Introduce a competing plan: source conflict remains visible; explicit user selection resolves it without editing the agent's plan.

**Acceptance checks:**
- Extraction uses real persisted entries/current lineage plus live events; no manually authored summary is mistaken for automatic retrieval.
- Ordinary user/assistant text and known interactive-user-answer tool results retain distinct provenance; arbitrary tool content is not promoted to user authority.
- N7 selects/classifies supplied spans only, with none/ambiguous outcomes. Over-budget or incomplete candidate scan cannot establish a trustworthy denominator.
- Task ID is independent of position/source revision. Unique exact anchors preserve reorder; duplicates, rename/split/merge ambiguities do not inherit done by similarity alone.
- One report can update multiple task IDs through independent questions. Future intentions, quotations, model health judgments and unrelated reports do not count.
- Manual selected source wins over suggestions. Other source reports can flag conflict, never silently update its ledger.
- Current task requires explicit selection or unambiguous scoped assertion; unknown task yields unknown health and resets temporal ownership.
- Retractions/reopens and genuine scope revisions update count honestly. Losing a source from a cropped read is not scope removal.

**Spike/evaluation gate:** actual live R4 exercise demonstrated interpretation after manual excerpt selection, not automatic retrieval. Before enabling auto-selection by default, evaluate candidate recall, wrong-source selection and denominator errors on actual replay fixtures. Until gate passes, mark auto mode experimental and keep explicit selection available.

**Defer:** automatic mixed-source merged plans, fuzzy identity transfer, inferred completion from activity.

## V4 — Beads export as an optional selected source

**User outcome:** Beads users get scoped reported counts without installing or running tracker tools through this extension.

### Added affordances

| IDs | Added behavior                                                        |
|-----|-----------------------------------------------------------------------|
| N20 | Read/validate selected IDs from bounded `.beads/issues.jsonl` export. |
|     |                                                                       |

**Extend:** N6 calls N20 for selected Beads source. U19/U20 expose export and explicit issue-ID scope; U1/U2/U3 show `Beads export-reported` and file observation/mtime. S3/S4 retain per-record provenance. Other sources still cannot change selected Beads statuses.

**Demo:** select two real exported task IDs. Another actor updates and exports one task; next refresh reflects export status. Remove br/bv from PATH: monitor still works. Corrupt/partially rewrite export: display stale/unavailable rather than a smaller or empty plan.

**Acceptance checks:**
- No br/bv commands, installs, initialization, import, flush or writes; no direct database mutation.
- Scope is explicitly selected task IDs, not entire backlog or parent plus children. Missing selected IDs produce incomplete-snapshot state, not silent deletion.
- Duplicate IDs, malformed records, interrupted writes and status values outside supported schema produce explicit diagnostics/unknown state.
- File metadata does not claim live SQLite freshness. Closed/cancelled ambiguity is surfaced according to explicit status policy; no claim of verified implementation.
- Beads selection does not silently override a chosen conversation plan. Changing source is a visible ledger revision.

**Defer:** epic dependency traversal, arbitrary bd compatibility, live DB querying and task creation/update. Verify a supported export schema with fixtures rather than implementing speculative compatibility layers.

## V5 — Red tests: Not needed, Reported and Observed

**User outcome:** avoids both useless test demands and false claims that an unobserved run was verified.

### Added affordances

| IDs | Added behavior                                                                 |
|-----|--------------------------------------------------------------------------------|
| U6  | Combined applicability/evidence row with distinct labels.                      |
| N28 | Record task-linked test reports and observable run/file facts from trajectory. |
| S10 | Claim/run history with source IDs, ordering and revision coverage.             |

**Extend:** N10/N11/S13 ask applicability and relevance questions; N12 maps results without erasing raw evidence; N23 inspects report versus observed proof. Agent reports enter from actual trajectory, not a synthetic monitor status API.

**Demo:** planning/documentation task gives `Not needed · assessment`. For a behavior task, agent explicitly reports writing a failing regression test: `Reported red`. Matching test assertion output, task and source/run order yields `Observed red`. Runner crash does not upgrade provenance. Existing checks still apply even when a new test is unnecessary.

**Acceptance checks:**
- Applicability and evidence are independent fields; a test may be reported/observed even when judged unnecessary.
- Actual scoped agent assertion suffices for Reported red under confirmed user policy. Hypothetical quoted assertion does not. Direct contradiction is visible rather than suppressed.
- `isError`, nonzero exit, test filename or code write alone cannot establish observed assertion failure. Unsupported test output remains unclassified/unknown.
- Test-first sequence requires trustworthy observation order and matching task/source history; final text or absent historical events cannot prove ordering.
- Small size alone cannot justify Not needed; one-line permission change remains high-stakes. Explicit user/project requirements override contrary model assessment.
- Monitor never runs tests or edits task policy. No new-test-needed decision becomes an agent instruction.

**Evaluation gate:** this session had no positive actual red-test report or run. Capture approved real positive/negative examples during implementation; test claim extraction, runner errors and stale history separately from applicability quality.

**Defer:** universal test-runner parser, inferred out-of-band history, automatic test suppression.

## V6 — Implementation evidence stays separate from reported completion

**User outcome:** a task can be reported done while implementation remains partial, contradicted or unverified.

### Added affordances

| IDs | Added behavior                                               |
|-----|--------------------------------------------------------------|
| U7  | Per-criterion implementation summary with evidence coverage. |
|     |                                                              |

**Extend:** S13 per-criterion Choice questions; N11 selects criterion-linked trajectory/code/test excerpts; N10 batches independent comparisons; N12 preserves supports/contradicts/insufficient states; N23 displays criterion rows and source references. No new completion-state writer.

**Demo:** selected task is reported done, so overall count reflects report. One acceptance criterion has relevant passing evidence; another lacks evidence or is contradicted. Implementation row remains Partial/Unverified. After relevant source changes, old passing evidence becomes stale without rewriting the historical report.

**Acceptance checks:**
- N12/S5 never updates S4 or overall count. No multiplied confidence masquerades as chance entire task is correct.
- A partial/truncated criteria list cannot yield Appears complete for the whole task.
- Distinguish implementation evidence from agent's self-report; expose contradictions rather than merging into average score.
- Evidence budget omissions, stale checks, unknown source linkage and insufficient context remain visible.
- No fake generated rationale: show selected source excerpts, criterion and typed answer.

**Evaluation gate:** representative supported/contradicted/missing-evidence examples; false Appears complete tracked separately from ordinary uncertainty.

**Defer:** proof of arbitrary code correctness, executing acceptance checks, review-readiness/nudging.

## V7 — Meaningful progress, possible stuck state and direction

**User outcome:** distinguish aligned-but-unproductive work, useful investigation, normal waits and actual drift.

### Added affordances

| IDs         | Added behavior                                                  |
|-------------|-----------------------------------------------------------------|
| U8, U9, U10 | Meaningful progress, stuck and direction rows.                  |
| N22         | Bounded task-local rolling observation windows and gap markers. |
| S11         | Window observations, time/order/repetition facts and coverage.  |

**Extend:** N5/N4 feed window changes; N11 includes selected task trajectory and runtime coverage; S13 temporal questions; N12 coverage/uncertainty/persistence reduction; N23 shows the interval and underlying events. Configured display refresh remains independent of assessment interval.

**Demo:** replay four trajectories: useful investigation without edits; same unsuccessful attempt without new information; long-running relevant test; unrelated feature work. Then change the user's goal: old task windows and judgments cannot bleed into new task. The live-spike example should display aligned/no advance and uncertain current stuck status—not a confident healthy result from the top choice alone.

**Acceptance checks:**
- Time arithmetic, ordering and window membership happen in code; Jev evaluates meaning of supplied observations.
- Missing runtime coverage, gapped history or unseen child activity cannot produce a confident current stuck/not-stuck judgment.
- Normal idle/wait, tool-running, retry and compaction states are distinct. Inactivity alone never means stuck.
- Investigation can count as advancement; edit/commit/token count alone cannot. Failed relevant work can remain aligned.
- Scope/task changes reset ownership. Old as-of answers are never shown as current task health.
- Temporal persistence/cooldowns affect display stability only; no messages, alerts, interruption or nudges.
- All seven requested indicators are now present with readable narrow-width layout and evidence drilldown.

**Evaluation gate:** tune windows and display thresholds on labeled real traces, inspect false stuck/drift/healthy rates plus abstention, then test held-out sessions. No universal confidence cutoff or “stuck after one refresh” rule.

**Defer:** child/external worker monitoring, intervention policy, review timing, adaptive task steering, Claude/Codex/OpenCode adapters.

## Coverage and review gates

| Requirement                                   | Slices supplying mechanism  | Remaining verification                                                              |
|-----------------------------------------------|-----------------------------|-------------------------------------------------------------------------------------|
| R0 passive supervision                        | V1–V7                       | Hands-on scanability and evidence inspection.                                       |
| R1 reported completion only                   | V1, V3, V4                  | Counting, scope identity, source/revision and report fixtures.                      |
| R2 seven task indicators                      | V2, V5, V6, V7              | Per-signal quality/coverage gates; especially false Not needed and temporal claims. |
| R3 configurable nonblocking refresh           | V1, V2, V7                  | Fake-clock/lifecycle tests and opted-in latency/usage observation.                  |
| R4 Beads and non-Beads reports                | V1, V3, V4                  | Real trajectory candidate/report recall and export-schema fixtures.                 |
| R5 fact/report/assessment/unknown distinction | Every slice                 | Provenance/freshness/omission checks and user comprehension.                        |
| R6 Pi-first portable logic                    | V1, V2                      | Core tests without Pi; no promise of other-host UI parity.                          |
| R7 display-only/main-session                  | Every slice                 | Negative tests for messages, tool mutation, source writes and worker discovery.     |
| R8 learn Jev incrementally                    | V2 then each semantic slice | Exact state/questions/answers inspectable; record mistaken predictions and costs.   |

## User review decisions before implementation

- Approve/reorder the seven increments; V1 plus V2 is the first Jev learning experiment.
- Confirm proposed commands/dialog layout and initial supported checklist format.
- Confirm export-only Beads scope versus deferring it until after task-health signals.
- Review unknown/conflict handling and identity rules, especially ambiguous task rewrites.
- Set initial semantic evaluation goals and acceptable error/abstention tradeoffs after baseline examples, not fabricated accuracy targets.

Do not create implementation tickets with implicit approval, install dependencies, or begin building merely because these slices now exist.
