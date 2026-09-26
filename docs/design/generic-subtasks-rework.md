# Generic subtasks: implementation audit and rework map

Date: 2026-09-26. Source audited: `29b193d1`; acceptance/bookkeeping through `960b4622`. This is an implementation-seam investigation, **not** the deferred exhaustive test-audit campaign. No source, test or fixture changes made. [Revised design](coverage-subtasks.md) governs future work; implementation stays paused pending owner restart.

## Finding

The implementation builds a workbook-specific coverage system rather than the requested conversation-grounded subtask system. Its mechanics are substantial and often reusable, but changing the filename validator would not repair the architecture.

Concrete evidence:

- `src/analysis/coverage-intent.ts`: `coverageIntentInstructions` directly requests selected-model `{intents}` with an exact repo-relative workbook resource, not a subtask list. `isWorkbookPath` permits xls/xlsx/xlsm/xlsb/ods only. `finish` requires resource to appear exactly once in the latest canonical text and inside the quote. There is no decomposition-need Jev phase here.
- `src/core/coverage.ts`: `CoverageAdmission` requires `CoverageInventory`; that requires `resourceKey` and canonical tool `callId`. Each group has an immutable resource identity unless explicitly replaced. New children can only be added through complete inventories. Generic labels alone do not make this admission mechanism generic.
- `src/core/monitor.ts`: existing intent-job scheduling dispatches the selected-model request directly; its result authorizes pending adapter inventories. The durable queue understands intent and report work, not Jev decision→LLM list phases.
- `src/analysis/coverage-report.ts`: rubric and choices require actual completed **review** of inventory items, and the reducer emits `reported-reviewed`. This is wrong for arbitrary implementation or writing subtasks.
- `src/ui/board.ts` and `src/ui/widget.ts`: stable separate pane/navigation exists, but counts and warnings say Coverage/review. `src/advisory/reconciliation.ts` uses reviewed counts and item gaps. This can be reused only after vocabulary/projection changes and tests.
- `src/core/hybrid-checkpoint.ts`: strict VERSION=10; coverage metadata stores inventory/intent/report jobs and proofs. General provenance and two-phase decision state require a new strict version, not accepting made-up tool receipts or silently relaxing v10 validation.

## Completed evidence versus revised acceptance

C00–C09 were closed under the old contract. C09 acceptance `387eda5a` records 1,181 unit and 75 integration tests plus checks passing; local host lane 23/23. These are historical results, not rerun or generic-subtask acceptance. Three existing activity-label check warnings remain nonfatal.

C10 never passed. The frozen original corpus's h14 expects acceptance for “Review all chapters in the supplied manual.” Offline production-helper preflight returned `abstained / invalid-proposal`; h01 with `docs/plan.xlsx` returned accepted as control. Command exited 1. No provider was involved; no model-accuracy claim is possible. Frozen original fixture must remain unchanged. Probe/log lives under the prior local task directory and the blocker is embedded in `.11` notes.

Paid usage remains 0/96 Jev and 0/16 extraction. C11 has unresolved global advisory timing/lifecycle evidence. Coverage-host success alone does not establish all-host-suite success. Manual acceptance and the separate test audit have not started.

## Reuse/rework matrix

| Stage / source boundary | Reuse, subject to regression proof | Rework needed / decisive new evidence |
|---|---|---|
| C00 contracts, `__tests__/fixtures/coverage*` | Synthetic 22-item scenario and frozen original failure; canonical-host authority evidence | Generic behavior contracts and fresh held-out split. Tool-free implicit breakdown must be a primary positive, not a peripheral manual test. Main owns tests; no fixtures changed in planning. |
| C01 `src/core/coverage.ts` | One group per parent revision, opaque IDs, atomic mutation, detached projections, bounds, parent isolation | Conversation-backed list admission; optional resource metadata; generic status; additions to partial lists; stable indexed references; explicit removal/replacement receipts. Test no tool call ID/resource required. |
| C02 `src/core/hybrid-checkpoint.ts`, Monitor restore | Strict validation, pre-publication persistence, envelope checks, stale-fact isolation, allocator/spend retention | v11 gate/proposal journals and canonical proposal provenance. No fake tool receipt, migration, old enum alias or parallel v10 reader. Crash between yes and proposal must not rebill yes. |
| NEW C03a decomposition gate | `src/analysis/gateway.ts` request/result validation, pinned model, batching/threshold conventions | Need judgment per existing parent; only yes permits LLM; bounded canonical context and exact-context receipt. Prove no/uncertain/failed/other-parent yes do not dispatch. |
| C03 `src/analysis/coverage-intent.ts`, selected-model seam | Host-selected transport/auth, strict JSON parsing, stale parent/source rejection, proposal dedupe | Replace resource intent with generated child-list proposal, supporting refs, existing-child index mapping and explicit updates. Generic no-path request must work. Remove old workbook-only proposer, do not keep as fallback. |
| C04 `src/sources/coverage.ts` | Narrow passive workbook metadata parser, canonical attestation, candidate byte/count bounds, access not completion | Adapter metadata becomes optional input to generic flow, not admission authority. Multi-resource mappings under one parent; unsupported/ambiguous mappings stay unavailable. Test tool-free path and no bypass of Jev yes. |
| C05 `src/core/monitor.ts`, `src/index.ts`, actual-host fixtures | Canonical event ingress, listener mutation/branch checks, selected-model transport proof | Wire generic Jev→LLM→store before report enrichment. Actual extension host must show meaningful no-file children under one task; negative gate must show zero extraction. Workbook 22-item path uses same pipeline. |
| C06 `src/analysis/coverage-report.ts` | Bounded per-child batching, report/source/list binding, retraction, block, all assessed receipts | Obligation-aware reported completion rather than blanket review. Reading a source file cannot finish implementing it. Named/whole-set report semantics and ambiguity negatives across domains. |
| C07 Monitor optional scheduler and journals | Single flight, ordered coalescing/shared owners, fairness, supersession, exhaustion, explicit recovery, dispatch/receipt capacity controls | Introduce persisted two-phase jobs, count both providers, dedupe negatives, changed-context reevaluation, prevent self-requeue after list admission. Re-prove crash/charge/result faults and stale jobs after new gate/list revision. |
| C08 board/widget/controller | Independent scrolling/anchors, no network on render, label sanitization, narrow layout, Summary and parent fraction | Subtasks/reported complete language, tracked vs exhaustive denominator, provenance from conversation, optional access unavailable. Real TUI for no-file and 22-child cases. |
| C09 Monitor projection / reconciliation | Detached exact-parent summaries, all parent/MAYBE rows, dual byte caps, baseline fallback, no new wake | Generic completed counts and child gaps; no required inventory/resource fields. Preserve lifecycle/correction/readiness invariants. |
| C10 live harness/corpora | Frozen old fixture and documented h14 failure; bounded live conventions | New production-shaped gate+proposal+report calibration, genuinely fresh held-out cases, per-phase quality and budget ledger. No helper-only semantic claims. |
| C11 whole feature / host QA | Existing local/global faux-provider harnesses, package exclusion, safety regressions | Revalidate all generic seams and v11; resolve prior global advisory failures, record current host versions, independent full-batch review. |
| C12 docs/manual handoff | Fresh-session and no-release discipline | No-file software/research, chapter list, workbook, no-subtask, revisions/reload examples; v11 guidance. Human signoff remains separate. |

Existing coverage tests are regression assets, not a mandate to retain superseded workbook-only behavior. At implementation, Main must identify each changed assertion's old contract and new replacement proof. This is not permission for broad test deletion or the deferred audit.

## Backlog disposition

Tracking IDs: planning/audit `pi-progress-barroot-syd`; owner restart `pi-progress-barroot-0wy.14`; new Jev gate C03a `pi-progress-barroot-0wy.15`. The chain is `.14 → .1 → .2 → .3 → .15 → .4 … .13`. Arrows mean prerequisite before successor; parent-child containment is not an execution prerequisite.

- Keep epic `pi-progress-barroot-0wy`, retitle for generic conversation-grounded subtasks, replace its embedded design with the revised authoritative document.
- Reopen `.1`–`.10` and replace their active scope/checklists. Preserve prior description, criteria and evidence in appended historical notes; do not report “10/13 done” for the revised requirement.
- Revise `.11`–`.13`, preserving C10 failed preflight and C11 global-host risks. C10's workbook mismatch is now assigned upstream rework, not waived as an accepted abstention.
- Add **C03a Jev decomposition gate**, between C02 and C03, with explicit downstream dependencies.
- Add **owner restart gate**, prerequisite of C00; no implementation task becomes actionable just because design revision is done.
- Add a planning/audit tracking task for this revision. It can close after design/backlog review and graph validation without opening the restart gate.
- Keep the serial incremental build: pure store/persistence/gate/proposer → first generic host slice → reported status → full durability/UI/advisory → semantic/full QA → manual handoff.
- Update `pi-progress-barroot-y86` and deferred `pi-progress-barroot-hmv` to require the whole revised epic including added stages, not a stale fixed thirteen-stage count. Their dependencies and manual-confirmation requirement remain.

The owner restart gate and later owner manual-review gate are different: first authorizes development after this plan; second permits the deferred test audit only after feature completion and human review.
