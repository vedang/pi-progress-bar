# Jev call batching audit

## Current independent-health addendum (`pi-progress-barroot-7rv`)

The focus-gated health conclusions below describe the historical runtime, not the current contract. Health now assesses each eligible task independently after semantic settlement, without guessing an exclusive focus. Open tasks refresh per committed observation; newly done tasks receive terminal-report health; valid terminal cards wait for lifecycle/card invalidation rather than unrelated later reports.

One health flight drains at most 20 task-keyed jobs before optional details. Coalescing retains bounded chronological context (16 whole reports / 4KiB serialized reports), with explicit omissions, task-specific judgments and atomic five-field admission. Fairness applies among ready jobs after finite semantic settlement. Transient health retry requires a backoff deadline and a real canonical/evidence/control wake; there is no health timer or idle polling.

Cost per settled observation is the sum of eligible task request batches; request packing is unchanged. Sequential observations, retries and cancelled flights can add cost. Neither queue bounds nor the separate visibility-call budget cap lifetime health spend.

Strict v9 checkpoints add bounded coverage proof. Matching coverage restores retained without rebilling, even when ephemeral evidence is lost; stale/missing open and terminal work is reconstructed without semantic replay. Older versions, including v8, remain OFF without migration or automatic rebuilding. Deterministic replay establishes local mechanics only; real model linkage accuracy needs separately approved paid evaluation.

## Historical audit (preserved evidence)

Runtime inspected: `d780df28`. Scope: `pi-progress-barroot-knq`. Batch independent judgments sharing evidence and lifecycle; do not minimize calls at the expense of correctness.

| Call | Existing natural batch | Why separate from next phase |
|---|---|---|
| Scope gate | One scope-change Choice per canonical observation | Its accepted answer decides whether extraction runs. Combining with downstream judgments would use the wrong task state when extraction changes scope. |
| Selected-model extraction | One bounded atomic task patch; **not a Jev call** | Requires gate outcome and host-selected model/auth. Code validates resulting task IDs, revisions and lifecycle before completion. |
| Completion / withdrawal | Independent per-task questions, bounded to20 questions and24KiB per request | Each chunk has a durable accepted result; later chunks depend on committed journal state for exact replay and capacity admission. |
| Current activity focus | One extra Choice in the **first completion chunk**, over every open task; remaining19 slots may carry task decisions | Same canonical observation and post-patch task state: natural batching. Candidate labels occur once in `state.openTasks`; candidate coverage is not truncated to completion chunk membership. Later chunks must not repeat or overwrite this decision. |
| Task health | Core health questions plus as many independent criterion judgments as fit; overflow in resumable bounded batches | Needs committed selected task/revision, canonical requirements and current passive evidence. Independent focus can change the target; combining health with focus would assess a guessed task or spend calls on every possible target. |

## Result

The worthwhile missing batch was current activity with completion, delivered by `6qv`. No extra standalone focus request. Scope gate, extraction and health remain separate for actual data/evidence dependencies. No speculative cross-observation queue, concurrent provider flight or cross-phase mega-request.

No call-count guarantee: scope changes, payload size, task count, health freshness and abstentions change total calls. A request may carry only one judgment when that is all the current phase needs.

## Safety and evidence

- `src/analysis/completion.ts`: same-state question building, all-open candidate coverage, 20-question/24KiB bounds; no inferred focus from order, tool use or newly created tasks.
- `src/analysis/health.ts`: core/criterion packing and independent criterion overflow.
- `src/core/hybrid.ts`, `hybrid-checkpoint.ts`: strict v6 accepted-phase journal, reconstructed request replay, focus undo and conservative per-phase admission. Older versions rebuild, not migrate.
- `hybrid-focus.test.ts`, `hybrid-focus-monitor.test.ts`: switch/clear/concurrent/thresholds, retained health, stale-result rejection, exact replay, partial resume, full-length candidate requests and numeric capacity regression.
- Main deterministic validation:327 unit+12 local-host integration tests; global-host12 also passed before final scalar-only bound correction. Six real Jev focus cases passed (switch, immediate commitment, concurrent, idle, quotation, completion then switch). Final production CI/remaining replays passed on preceding source with identical request semantics.

Finite semantic samples demonstrate behavior, not calibrated accuracy. Richer tool-driven focus and redesigned UI are separate planning-only work.
