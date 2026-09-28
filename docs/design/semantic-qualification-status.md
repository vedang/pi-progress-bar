# Semantic qualification status

C10 (generic subtasks) and N06 (continuation) remain **unaccepted**. Passing deterministic tests does not establish semantic quality.

## Evidence retained

- Original N06 evaluation: first positive missed; 1 Jev call, no draft.
- Subsequent fresh N06 evaluation, after reviewed calibration: first positive admitted and its draft independently approved; second positive missed at yes probability 0.77 against the unchanged 0.80 admission threshold. Run stopped after 2 Jev calls and 1 draft; 15 cases unrun. Reviewer `f1bb8dfe` confirmed valid expectation and genuine recall failure.
- C10 evaluation: first multi-obligation analytical task rejected. Run stopped after 1 Jev call, no proposal; 11 cases unrun. Reviewer `3567a474` confirmed valid expectation and genuine recall failure.
- Separate continuation development: 112 Jev calls across six frozen comparisons, no drafts. Latest alternative missed 3 of 6 positives versus 2 for current production; neither met its prospective rule. It was not promoted.
- Separate subtask development: 200 Jev calls across seven frozen comparisons, no proposals. Expanded cases cover existing-list refinement, canonical roles, context and omissions. Latest comparisons still missed required positives; no subtask rubric change was promoted.

All development comparisons observed zero unexpected admissions, but this does **not** establish held-out safety or corpus-level acceptance. Paired role variants and reused development cases are not independent acceptance samples.

## Invariants

Model, confidence/probability thresholds, runtime request/response limits, authority boundaries, and no-hidden-retry rules remain unchanged. Frozen manifests and exclusive ledgers retain failed calls and runs. No failed acceptance case was rerun or used as calibration data. Downstream main-agent turns remained mocked.

The current continuation rubric includes the independently reviewed all-supplied-text evidence boundary (`4ce56247`). Generic-subtask production wording remains unchanged. No installation, release or push occurred.

## Verification and next decision

Main verification after the latest development work: formatting, static checks, **1,998 unit tests and 111 integration tests passed**. Earlier real-host lifecycle evidence remains separately documented; these latest runs do not claim a new host validation.

Further calibration has not demonstrated satisfaction of the strict positive-admission gate. Do not declare either stage complete or advance final acceptance/manual handoff. Changing the evaluator architecture, model, runtime thresholds, or acceptance policy requires an explicit decision; additional calls alone are not acceptance evidence.

Detailed immutable artifacts remain under the task folders for `validate-fresh-semantic-behavior`, `calibrate-continuation-decision-quality`, `clarify-generic-subtask-decisions`, and `evaluate-fresh-continuation-semantics` in `.agents/plans/`.
