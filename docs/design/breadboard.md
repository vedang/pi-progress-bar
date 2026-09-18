---
shaping: true
---
# Breadboard — evidence-aware passive monitor

**Target design; V1–V3 implemented, V4–V7 proposed.** Tables define conceptual affordances and wiring, not an exact runtime symbol map. See [runtime README](../../README.md) for implemented behavior and limitations, including explicit source confirmation and excluded unverified interactive tool answers. Read [shape](shape.md), [spike findings](spikes.md) and [slices](slices.md) together. V1–V7 below mean implementation slices within product v1.

## Operator journey

A person supervises the main Pi agent, sees reported progress and current-task signals, inspects the supporting trajectory, and corrects monitor source/task scope if necessary. The monitor never modifies the agent's task, runs tests, updates Beads, or sends nudges.

Two state paths stay separate:

- **Reports:** selected source → scoped task ledger → arithmetic → overall bar.
- **Assessments:** selected trajectory/evidence → Jev → coverage/freshness rules → health rows.

[ref:reported_completion_only] There is no assessment-to-completion-ledger wire. Jev-assisted interpretation of an explicit status report is allowed; Jev's judgment that implementation appears complete is not a status report.

## Places

| ID | Place                      | Kind / boundary                                                                                  |
|----|----------------------------|--------------------------------------------------------------------------------------------------|
| P1 | Pi conversation and editor | Existing place; new passive named widget and user-invoked commands. Widget takes no input focus. |
| P2 | Evidence inspector         | New user-invoked read-only overlay; close to return to editor. No automatic opening.             |
| P3 | Source/task selection      | New user-invoked selection dialog; changes monitor scope only, never the underlying plan.        |
| P4 | Jev enablement disclosure  | New user-invoked consent dialog; allow/cancel before network analysis.                           |
| P5 | Monitor engine             | Local backend boundary; no Pi imports in ledger, snapshot, judgment or display-data logic.       |
| P6 | TypeSafe service           | External API boundary; no claim about its internal implementation.                               |

## UI affordances

Wires Out are actions/navigation; Returns To is data output. Display-only rows receive data from code tables. A dash means no outgoing relationship, not no data source.

| ID  | Place | Component / affordance                                            | Control       | Wires Out | Returns To | First slice |
|-----|-------|-------------------------------------------------------------------|---------------|-----------|------------|-------------|
| U1  | P1    | Reported task-count bar / no-plan state                           | render        | —         | —          | V1          |
| U2  | P1    | Active task, selected source and scope revision                   | render        | —         | —          | V1          |
| U3  | P1    | Activity, freshness, coverage and service state                   | render        | —         | —          | V1          |
| U4  | P1    | Requirements clarity meter and label                              | render        | —         | —          | V2          |
| U5  | P1    | Acceptance criteria status                                        | render        | —         | —          | V2          |
| U6  | P1    | Red-test applicability plus Reported/Observed evidence            | render        | —         | —          | V5          |
| U7  | P1    | Per-criterion implementation summary                              | render        | —         | —          | V6          |
| U8  | P1    | Recent meaningful-progress signal with window                     | render        | —         | —          | V7          |
| U9  | P1    | Stuck signal, distinct from idle/waiting/unknown                  | render        | —         | —          | V7          |
| U10 | P1    | Direction/alignment signal                                        | render        | —         | —          | V7          |
| U11 | P1    | `/progress details`                                               | command       | N16       | —          | V1          |
| U12 | P1    | `/progress source`                                                | command       | N19       | —          | V1          |
| U13 | P1    | `/progress enable`                                                | command       | N21       | —          | V2          |
| U14 | P1    | `/progress pause` / `/progress resume`                            | command       | N27       | —          | V2          |
| U15 | P2    | Scoped tasks, reports, conflicts and source references            | render        | —         | —          | V1          |
| U16 | P2    | Signal selection, question/answer distribution and rubric         | select/render | N23       | —          | V2          |
| U17 | P2    | Selected evidence, outbound preview, omissions and as-of revision | render        | —         | —          | V2          |
| U18 | P2    | Close inspector                                                   | Escape        | P1        | —          | V1          |
| U19 | P3    | Source candidates / explicit path and section                     | select/type   | N24       | —          | V1          |
| U20 | P3    | Included task IDs and current-task selection                      | select        | N24       | —          | V1          |
| U21 | P3    | Apply monitor selection                                           | confirm       | N18       | —          | V1          |
| U22 | P3    | Cancel source selection                                           | cancel        | P1        | —          | V1          |
| U23 | P4    | Transfer disclosure and bounded payload preview                   | render        | —         | —          | V2          |
| U24 | P4    | Enable Jev for this session/workspace                             | confirm       | N25       | —          | V2          |
| U25 | P4    | Decline / cancel                                                  | cancel        | P1        | —          | V2          |
| U26 | P1    | `/progress interval <seconds>`                                    | command       | N29       | —          | V1          |

U19 gains automatically found trajectory candidates in V3 and Beads export scope in V4. U20 initially lets the user choose existing checklist items, not author new tasks. No source is selected by an unrelated backlog's mere presence.

## Code affordances

Host event handlers only capture/queue bounded local observations. Network work belongs to the scheduler, never an awaited tool interception hook. N9 is the one shared single-flight gateway for selection, report interpretation and health assessment.

| ID  | Place | Proposed affordance                                                          | Control               | Wires Out                      | Returns To                              | First slice |
|-----|-------|------------------------------------------------------------------------------|-----------------------|--------------------------------|-----------------------------------------|-------------|
| N1  | P1    | `handleSessionLifecycle()` — start/reload/tree/switch                        | host event            | N2, N3, N4, S1                 | —                                       | V1          |
| N2  | P1    | `restoreMonitorCheckpoint()` — branch-scoped metadata                        | call                  | S1, S4                         | N1                                      | V1          |
| N3  | P1    | `stopMonitor()` — clear timer, abort, clear own widget                       | shutdown/transition   | S1, N14                        | N1                                      | V1          |
| N4  | P5    | `refreshTick()` — configured interval (default 15s), coalesce dirty work     | timer/call            | N6, N7, N17, N22, N10, N14, S1 | —                                       | V1          |
| N5  | P1    | `recordHostEvent()` — normalized messages/tool/activity                      | host event            | S1, S2, N28, N22               | —                                       | V1          |
| N6  | P1    | `readSourceSnapshot()` — approved bounded source read                        | call                  | S3, N8, N20 (V4)               | N4, N24                                 | V1          |
| N7  | P5    | `resolvePlanCandidates()` — bounded trajectory selection                     | dirty candidate set   | S3, N9, N8                     | N4                                      | V3          |
| N8  | P5    | `reconcileLedger()` — source/task/report revisions                           | call                  | S4, S5, N15                    | N6, N7, N17, N18                        | V1          |
| N9  | P5    | `evaluateWithJev()` — consent, budgets, single-flight, freshness             | async call            | S1, S7, N26                    | N7, N10, N17                            | V2          |
| N10 | P5    | `assessCurrentTask()` — request eligible health questions                    | call                  | N11, N9, N12, N14              | N4                                      | V2          |
| N11 | P5    | `buildEvidenceSnapshot()` — source refs, omissions, coverage                 | call                  | —                              | N10, N21                                | V2          |
| N12 | P5    | `reduceHealthAnswers()` — preserve uncertainty/provenance                    | call                  | S5                             | N10                                     | V2          |
| N13 | P5    | `calculateReportedCompletion()` — integer counts only                        | call                  | —                              | N14, N23                                | V1          |
| N14 | P1    | `renderMonitor()` — width-safe named widget                                  | call/invalidate       | N13                            | U1, U2, U3, U4, U5, U6, U7, U8, U9, U10 | V1          |
| N15 | P1    | `persistMonitorCheckpoint()` — meaningful transitions only                   | call                  | S8                             | N8, N29                                 | V1          |
| N16 | P1    | `openEvidenceInspector()`                                                    | command               | N23, P2                        | —                                       | V1          |
| N17 | P5    | `interpretExplicitReports()` — per-task claims, not implementation judgments | new report candidates | N9, N8                         | N4                                      | V3          |
| N18 | P3    | `applySourceSelection()` — explicit source/scope/current task override       | confirm               | N8, N4, P1                     | —                                       | V1          |
| N19 | P1    | `openSourceSelector()` — initialize draft from known sources                 | command               | S12, P3                        | U19, U20                                | V1          |
| N20 | P1    | `readBeadsExport()` — read-only JSONL, selected IDs                          | selected source read  | —                              | N6                                      | V4          |
| N21 | P1    | `openAnalysisDisclosure()`                                                   | command               | N11, P4                        | U23                                     | V2          |
| N22 | P5    | `updateTrajectoryWindow()` — code computes time/order/repetition             | event/tick            | S11                            | N4, N5                                  | V7          |
| N23 | P2    | `inspectEvidence()` — local source/answer query; no inference                | open/select           | N13                            | U15, U16, U17                           | V1          |
| N24 | P3    | `editSelectionDraft()` — validate path/section/IDs locally                   | input/select          | N6, S12                        | U19, U20                                | V1          |
| N25 | P4    | `grantSessionConsent()` — mark explicit permission                           | confirm               | S6, N4, P1                     | —                                       | V2          |
| N26 | P6    | `POST /v1/systemone`                                                         | HTTP request          | —                              | N9                                      | V2          |
| N27 | P1    | `setAnalysisPaused()` — pause remote analysis, not agent                     | command               | S1, N14                        | —                                       | V2          |
| N28 | P5    | `recordTestEvidence()` — collect claims/run facts without running tests      | observed event        | S10                            | N5                                      | V5          |
| N29 | P1    | `setRefreshInterval()` — validate seconds and replace timer                  | command               | S1, N4, N14, N15               | —                                       | V1          |

**Conditional source reads:** N6 calls N20 for selected Beads sources (V4); otherwise reads selected approved file/trajectory snapshot. Before V4 the Beads route is unavailable, not a fake empty plan. The N6 → N20 wire is explicitly marked V4 in the table. Preview reads triggered by N24 only update candidates/draft; they must not reconcile the active ledger until N18 applies selection.

**Question construction:** N7, N10 and N17 read S13. N7 asks a Choice over supplied source spans. N17 asks one report-state question per known task (so one message can complete multiple tasks). N10 asks independent health questions over shared bounded state. Later requests occur only when an earlier selection is needed to build new state.

**Result freshness:** N9 rejects responses for changed session/lineage, selected source revision or task identity before returning to its caller. An older evidence revision within the same identity may only display with explicit as-of/stale status, never as current verification. Losing consent or pausing aborts/discards outstanding inference.

## Data stores

Stores are local unless identified as host-owned source. No credentials or duplicate raw transcript in persisted checkpoint.

| ID  | Place | Store                                                                           | Writers                                                | Returns To / readers                                    | First slice |
|-----|-------|---------------------------------------------------------------------------------|--------------------------------------------------------|---------------------------------------------------------|-------------|
| S1  | P5    | Runtime identity, activity, refresh interval/timer, pause and in-flight request | N1, N2, N3, N4, N5, N9, N27, N29                       | N1, N3, N4, N9, N10, N14, N15, N22, N29                 | V1          |
| S2  | P5    | Bounded actual-trajectory observations with source IDs and provenance           | N5                                                     | N7, N11, N17, N22, N28                                  | V1          |
| S3  | P5    | Candidate source snapshots, exact spans and coverage                            | N6, N7                                                 | N7, N8, N19, N24                                        | V1          |
| S4  | P5    | Selected source, atomic tasks, current task, reports and revision ledger        | N2, N8                                                 | N4, N7, N8, N11, N13, N14, N15, N17, N19, N22, N23, N28 | V1          |
| S5  | P5    | Health answers, applicability/evidence, coverage and freshness                  | N8 invalidation, N12                                   | N14, N23                                                | V2          |
| S6  | P5    | Session/workspace consent                                                       | N25                                                    | N9, N11, N12, N21                                       | V2          |
| S7  | P5    | Ephemeral bounded request/answer provenance, usage, time and errors             | N9                                                     | N23                                                     | V2          |
| S8  | P1    | Pi custom entries containing monitor metadata checkpoints                       | N15                                                    | N2                                                      | V1          |
| S9  | P1    | Host-owned selected plan files / actual Pi trajectory / Beads export            | External user/agent only                               | N2, N5, N6, N20                                         | V1          |
| S10 | P5    | Task-linked test claims and observed test/run facts                             | N28                                                    | N11, N23                                                | V5          |
| S11 | P5    | Task-local rolling observations and gaps                                        | N22                                                    | N11, N23                                                | V7          |
| S12 | P3    | Unapplied source/section/ID/current-task selection draft                        | N19, N24                                               | N18, N24                                                | V1          |
| S13 | P5    | Versioned question definitions, answer rubrics and budget policy                | Package definitions; changes through reviewed releases | N7, N9, N10, N17                                        | V2          |

Factory registers events/commands only. N1 starts resources on `session_start`; shutdown/reload/tree transition invalidates generation before rehydration. S8 is restored from current Pi branch, not every entry in the session. Consent is not restored from S8: reload/replacement returns analysis to off until explicitly enabled. Local reported-count display may still operate. Refresh defaults to 15 seconds; U26/N29 accepts finite positive seconds, rejects invalid input without changing the existing timer, and replaces—not adds—a timer. Interval persists in branch-scoped S8 metadata and is restored by N2. Changing it neither grants consent nor queues extra inference.

## Concrete source/ledger contract — R4

1. **Authority:** one selected source per ledger revision. Manual selection wins over suggestions. Automatic discovery is permitted only after Jev enablement; otherwise explicit checklist/Beads reporting still works. Other sources may be evidence or conflicts, never silent status writers.
2. **Initial checklist:** user selects file and section. Only direct task checklist/list items in that section become candidate work items; nested acceptance criteria are not additional tasks. A plain list has no implicit done status. Ambiguous boundaries produce `Scope needs selection`.
3. **Actual trajectory:** N5 preserves finalized user/assistant entries and approved tool observations. Known, trusted interactive-question integrations expose user-answer provenance; tool name alone is not sufficient authority. No system/thinking/private-shell ingestion. N7 classifies provided blocks/list items/sentences; it cannot generate missing tasks or source paths.
4. **Task IDs:** Beads uses issue ID. For file/conversation sources, locally assigned task ID is separate from source revision and positional span. Preserve across a unique exact content/explicit anchor match within selected scope; reorder alone does not erase identity. Duplicates or ambiguous rename/split/merge require user mapping or fresh unreported identities. Never transfer done by fuzzy similarity alone.
5. **Current task:** explicit user monitor selection, then unambiguous current-task assertion in the selected trajectory, otherwise `Current task unknown`. Do not silently call first unchecked item current. No task-specific healthy assessment while task identity is unknown.
6. **Reports:** structured source markers update selected structured ledger; for conversation-owned status, N17 maps actual scoped assertions to known task IDs. `done`, `reopened`, `not started`, `in progress`, `cancelled`, `not a report`, `ambiguous` are bounded interpretations. Multiple independent per-task questions support multi-task claims. Quotes, hypothetical examples, future plans and this monitor's own output do not count.
7. **Revisions:** checksum/read-generation changes are not necessarily task identity changes. Clearly scoped later reports replace earlier reports within the same identity. Scope change produces new denominator and notice; no monotonic-percentage clamp. Cancellation/removal is not done. Disappearance from partial reads is not removal.
8. **Conflicts:** cross-source discrepancy appears in details but cannot change selected-source count. Conflicting evidence within selected source is `Conflict` until a clear later correction or user override; unknown is not counted done. Show unknown/conflict counts alongside reported total.
9. **Beads:** read complete bounded `.beads/issues.jsonl`, selected issue IDs only. Source mutation/partial read invalidates snapshot rather than dropping tasks. `closed` is a reported terminal state; ambiguous cancellation/close reasons require visible status policy rather than claiming verified delivery. Initial adapter does not traverse unverified epic graphs or run br/bv. Label export observation, not database currency.
10. **Arithmetic:** N13 computes done / included atomic task count from S4 only. No trusted denominator: no percent. Zero included tasks: empty scope, not 100%. A guessed source winner cannot establish a trusted denominator by itself.

## Concrete signal reduction contract — R2

| UI                | Request/evidence                                                        | Mapping and mandatory abstention                                                                                                                                                                                                                                          |
|-------------------|-------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| U4 clarity        | Score over concrete task-specific levels                                | Show level/score with assessment label; no conversion to completion percentage. Missing task text → Unknown before inference.                                                                                                                                             |
| U5 acceptance     | Noul/Choice over supplied task/criteria text                            | Explicit/partial/not found in supplied context/unknown. Criteria and executable-test presence remain separate.                                                                                                                                                            |
| U6 red            | Separate Choice applicability and task-linked claims/observations       | `Not needed` is model assessment, not absence of tests. Explicit scoped agent assertion suffices for `Reported red`; matched assertion-run evidence gives `Observed red`. Generic failure is neither. Preserve both applicability and provenance; contradictions visible. |
| U7 implementation | Per-criterion supports/contradicts/insufficient Choice plus check facts | `Appears complete` only when selected criteria are covered and evidence current; otherwise Partial/Unverified/Conflict. Never writes S4. Incomplete criteria coverage prevents complete label.                                                                            |
| U8 progress       | Bounded task-local trajectory, with meaningful changes/investigation    | Advancing/no advance observed/unclear with window. Not code-volume, token or activity counts. Missing or gapped observation interval → Unclear.                                                                                                                           |
| U9 stuck          | Trajectory plus actual host activity and omissions                      | Possible loop/blocked reported/no stuck signal/observing. Running tool, normal idle/wait, compaction and missing liveness are explicit states. No inactivity-only stuck rule; no healthy winner when runtime coverage absent.                                             |
| U10 direction     | Choice direct/supporting/unrelated/conflicting/insufficient             | Aligned/possible drift/unclear. Failed relevant work can still be aligned. User-approved goal change resets comparison baseline.                                                                                                                                          |

Prototype reports experimental raw distributions. Probability/confidence display gates and temporal persistence require measured tuning; they are not invented universal thresholds. The live spike's stuck result (0.54 not-stuck vs 0.46 insufficient, confidence 0.31) must not become a confident healthy badge.

[ref:red_test_applicability] `Not needed` concerns a **new failing test**, not skipping existing checks. Explicit selected user/repository test requirements take precedence. If applicable policy/risk evidence is missing, preserve uncertainty rather than grant a waiver. No semantic verdict causes a tool call, test run, warning, or nudge in product v1.

## Traceable journeys

| Journey                        | Control path                                                        | Data return / effect                                                                                                                   |
|--------------------------------|---------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|
| Start with explicit checklist  | N1 → N2 → N4; U12 → N19 → P3; U19/U20 → N24; U21 → N18 → N8         | S4 → N13 → N14 → U1/U2/U3; N15 → S8 preserves metadata.                                                                                |
| Enable first Jev signals       | U13 → N21 → N11 → P4; U24 → N25 → N4 → N10 → N9 → N26               | N26 → N9 → N10 → N12 → S5 → N14 → U4/U5; request provenance → S7.                                                                      |
| Discover conversation plan     | N5 → S2; N4 → N7 → N9 → N26; N7 → N8 if selected source unambiguous | S3/S4 populate U19/U20/U2; uncertain selection leaves no denominator and offers user selection.                                        |
| Interpret explicit done report | N5 → S2; N4 → N17 → N9 → N26; N17 → N8                              | S4 → N13 → U1. Health answers have no route into this update.                                                                          |
| Inspect a judgment             | U11 → N16 → P2; N16/U16 → N23                                       | S4/S5/S7/S10/S11 → N23 → U15/U16/U17; U18 returns to P1, no inference.                                                                 |
| Observe test evidence          | N5 → N28 → S10; N4 → N10 → N11 → N9 → N12                           | S10 supplies facts; S5 retains semantic claim/relevance/applicability → U6 with provenance.                                            |
| Follow trajectory              | N5/N4 → N22 → S11; N10 → N11 → N9 → N12                             | S11 + runtime S1 produce coverage-aware U8/U9/U10.                                                                                     |
| Pause analysis                 | U14 → N27 → S1/N14                                                  | In-flight inference aborted/discarded, semantic rows Paused/as-of; local capture/counting continues. Resume requires existing consent. |
| Change Pi branch/session       | N1 → N3 → N2 → N4                                                   | Abort old generation; restore only current lineage checkpoint, revalidate sources; old health not reused as current.                   |

Arrows in this journey table abbreviate the numbered table relationships; they do not introduce extra nodes. Source-read and rendering internals are intentionally not separate places.

## Fit-gap disposition and remaining gates

- **R2 mechanism gap:** now has U4–U10, N10–N12/N28/N22, source/coverage stores and explicit display reductions, including Reported red and Not needed. Semantic quality and temporal thresholds remain validation gates; no claim of verified accuracy.
- **R4 mechanism gap:** now has a concrete N5/N6/N7/N8/N17 path, one selected source, stable identity separate from revision, per-task report mapping and user correction in P3. Automatic candidate recall, ambiguous prose segmentation and robust file reconciliation require fixtures/live evaluation.
- The breadboard makes these mechanisms reviewable; it does not remove the empirical risks found by the spikes. User authorization covered V1–V3; further slices and paid validation still need approval.

## Wiring checks

Every rendered U has N14, N19/N24, N21 or N23 as a source. Every N has an action or return, every S a reader. Each node has exactly one Place and first slice. N6 → N20 is conditional on the Beads slice. Future-slice wires are inactive until their slice exists; earlier increments show only supported indicators, never fabricated healthy values. By product v1 completion, all seven rows are present.
