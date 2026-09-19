# Jev completion evaluation — 2026-09-19

## Decision

**Go for a pragmatic hybrid redesign using focused per-task completion questions.** Keep the user's accepted Jev admission gate, selected LLM task extraction, and independent completion updates. This is an engineering prototype decision, not a guarantee of perfect tracking or authorization for advisory intervention.

Completion must never serialize the main agent's work. Multiple tasks may progress or finish concurrently; an earlier incomplete or uncertain task must not prevent a later task from being credited.

## Experiment

- Pinned `jev-1.13.0`; confidence ≥0.5 and selected probability ≥0.8, unchanged.
- 26 frozen standalone fixtures plus five assistant messages from the actual CI conversation.
- Three predeclared trials, alternating comparison order: 62 requests each, 186 total. No retries or prompt tuning after the run began.
- **Multiway:** earlier choice among done, in-progress, reopened, no-change, uncertain.
- **Focused:** independent completion yes/no/uncertain for each task; separate withdrawal question only for an already-completed task.
- A “no new completion claim” retains existing state; only accepted withdrawal reopens it. Raw judgments, threshold abstentions, explicit uncertainty, source message IDs and retained state are recorded separately.
- Every task is assessed independently. Gold expectations are excluded from requests. No LLM or agent tools are used in this experiment.

## Results

| Measure | Multiway | Focused |
|---|---:|---:|
| Newly completed task reports detected | 47/57 (82.5%) | **54/57 (94.7%)** |
| False completions on explicit negative controls | 0/90 | **0/90** |
| Targeted completion withdrawals recognized | 6/6 | **6/6** |
| Exact standalone fixture outcomes | 69/78 | **75/78** |
| Final CI task count, each trial | 3/3 | **3/3** |
| Median request latency | 362 ms | **358 ms** |

The counts repeat the same fixtures three times: 57 positive checks are 19 expected completions repeated three times, not 57 independent examples. No population accuracy or confidence interval is claimed.

Focused questions met the predeclared practical criteria: at least 85% positive recall and withdrawal recall, no false done on explicit negative controls, no premature CI completion outside allowed evidence, terminal CI at least 2/3, independent task updates and median latency below two seconds. Multiway missed the recall criterion.

### Parallel work

Both arms correctly handled all six repeated parallel fixtures:

- Implementation and regression drafting ongoing while validation has finished: credit validation independently.
- First task unfinished while regression and validation are complete: show two completed tasks without waiting for the first.

### Remaining miss

All three focused misses were the same indirect report:

> Unicode normalization and the NFC regression are in place. Running the parser suite is blocked by the missing runtime dependency.

Normalization was credited, execution correctly remained incomplete, and regression completion abstained. In trial one its yes probability was 0.77, below 0.8. Keep this visible as uncertainty; do not lower thresholds or prevent other tasks from updating.

### CI qualification

Both arms reached 3/3 in this completion-only replay. Unlike the earlier hybrid sequence that ended 2/3, this experiment holds the initial generated task labels fixed and does not run a scope gate or scope-refinement LLM. Therefore the result does **not** prove that changing the completion question alone fixed the complete hybrid pipeline. That must be checked end to end during implementation.

## Cost and reproducibility

186 Jev attempts; 284,300 input tokens and 29,149 output tokens. No service failures or LLM calls. No dollar cost claimed.

Local evaluation artifacts reside under `.agents/plans/20260919T125952--evaluate-jev-task-completion__active/`: pre-run fixtures/prompts/runner/dependency hashes, three raw JSONL trial records, deterministic `summarize.py`, and `summary.json`. These intermediate artifacts are intentionally not part of the published package.

The old five-way question and frozen gateway are preserved in the experiment. The gateway enforces bounded response reading; the logger records validated results rather than reading an unbounded clone.

## Redesign implications

1. Keep Jev gating as the user's accepted time/cost tradeoff; no further gating ablation required for this iteration.
2. Let the selected LLM create/refine meaningful tasks; retain stable IDs and explicit source provenance.
3. Assess completion of all affected tasks, not just one selected current task. Newly extracted tasks must also be eligible for completion assessment against the same report.
4. Preserve per-task assessment uncertainty separately from previous state. Persist references for completion, correction and archive events, not only task creation.
5. Keep the current phase passive. Future advisory nudges may elicit better progress reports, but today's tracker must not depend on nudging or constrain agent execution.
6. Aim for the smallest working fresh-session hybrid, then validate real scope updates, parallel completion, lifecycle/reload, bounded calls and retained health display end to end before presenting it as ready.
