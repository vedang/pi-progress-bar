# Semantic qualification status

C10 (generic subtasks) and N06 (continuation) remain **unaccepted**. Passing deterministic tests does not establish semantic quality.

## Evidence retained

- Original N06 evaluation: first positive missed; 1 Jev call, no draft.
- Subsequent fresh N06 evaluation, after reviewed calibration: first positive admitted and its draft independently approved; second positive missed at yes probability 0.77 against the unchanged 0.80 admission threshold. Run stopped after 2 Jev calls and 1 draft; 15 cases unrun. Reviewer `f1bb8dfe` confirmed valid expectation and genuine recall failure.
- C10 evaluation: first multi-obligation analytical task rejected. Run stopped after 1 Jev call, no proposal; 11 cases unrun. Reviewer `3567a474` confirmed valid expectation and genuine recall failure.
- Separate continuation development: 112 Jev calls across six frozen comparisons, no drafts. Latest alternative missed 3 of 6 positives versus 2 for current production; neither met its prospective rule. It was not promoted.
- Separate subtask development: 200 Jev calls across seven frozen comparisons, no proposals. Expanded cases cover existing-list refinement, canonical roles, context and omissions. Latest comparisons still missed required positives; none qualified under the former rule.

All development comparisons observed zero unexpected admissions, but this does **not** establish held-out safety or corpus-level acceptance. Paired role variants and reused development cases are not independent acceptance samples.

## Invariants

Model, confidence/probability thresholds, runtime request/response limits, authority boundaries, and no-hidden-retry rules remain unchanged. Frozen manifests and exclusive ledgers retain failed calls and runs. No failed acceptance case was rerun or used as calibration data. Downstream main-agent turns remained mocked.

The current continuation rubric includes the independently reviewed all-supplied-text evidence boundary (`4ce56247`). Under the revised prospective policy, the round-6 subtask rubric is now staged as an **unaccepted candidate** (`112ddb78`), with an exact-byte regression contract. Its prior development result remains a failure under the former rule. No installation, release or push occurred.

## Revised prospective policy

The owner subsequently approved a **≥95% positive-admission gate with zero negative admissions**, on newly frozen full corpora, keeping runtime thresholds and safety rules unchanged. This is prospective only: the failures above are not reclassified as passes. C10 and N06 must qualify separately; successful gate recall does not waive grounding, scope or output-quality requirements. No run under the revised policy has qualified yet.

## Verification and remaining work

Main verification after the latest development work: formatting, static checks, **2,009 unit tests and 111 integration tests passed**. Earlier real-host lifecycle evidence remains separately documented; these latest runs do not claim a new host validation.

Further calibration did not establish the former zero-miss requirement. Execute the newly approved prospective policy before declaring either stage complete or advancing final acceptance/manual handoff. The approval does not authorize changes to evaluator architecture, model, runtime thresholds or safety rules; additional calls alone are not acceptance evidence.

Detailed immutable artifacts remain under the task folders for `validate-fresh-semantic-behavior`, `calibrate-continuation-decision-quality`, `clarify-generic-subtask-decisions`, and `evaluate-fresh-continuation-semantics` in `.agents/plans/`.
