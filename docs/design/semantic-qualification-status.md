# Semantic qualification status

## Current owner scope (2026-09-29)

C10 (generic subtasks) and N06 (continuation) formal semantic qualification are **deferred, nonblocking future work**, not passed. The owner explicitly deferred both evaluations while retaining both implemented features and all runtime safeguards. Passing deterministic tests does not establish semantic quality.

The combined implementation QA/review `pi-progress-barroot-0wy.12` (C11/N07) is **complete** for candidate `3a03824d5d139179712478990dc497f5d2282068`. Reviewer `3cb98d33` covered the retained feature batch; its canonical-amendment gateway recovery finding was reproduced and resolved by focused RED→GREEN verification (`6daf4e21` → `3a03824d`), accepted by the coordinator. No second full-batch review was claimed. C12, y86 and Q00 (`y3h.25`) separate handoff/owner-acceptance gates are superseded by the owner's instruction: **“Just let me know and I will test.”** The coordinator notified the owner that the candidate is ready for testing; owner testing has **not** been recorded as performed. No installation, release or push is authorized.

This scope decision supersedes earlier semantic prerequisites and staged handoff sequencing in the design documents and embedded Beads plans. Historical evidence and runtime contracts are unchanged.

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

## Deferred prospective policy

The owner subsequently approved a **≥95% positive-admission gate with zero negative admissions**, on newly frozen full corpora, keeping runtime thresholds and safety rules unchanged. This is prospective only: the failures above are not reclassified as passes. If resumed, C10 and N06 are graded separately; successful gate recall does not waive grounding, scope or output-quality requirements. No run under the revised policy has qualified. The later owner deferral removes both evaluations as delivery prerequisites; it does not reclassify any result.

## Verification and remaining work

Final candidate verification: formatting, static checks, **2,013 unit tests and 111 integration tests passed**, plus package dry-run and **51 existing offline installed-host tests**. Pinned Pi0.84.2/ai0.84.4 and the six-suite installed Pi0.87.1/ai0.87.1 subset used faux providers; this is not model-quality qualification, owner testing or a blanket dual-host promise. Three historical Biome warnings remain. The initial new-test TypeScript failure was corrected and its log retained.

Combined review: `.agents/plans/20260929T085452--verify-retained-feature-batch__active/combined-review.md`. Focused repair and final gate evidence: `.agents/plans/20260929T091718--repair-amendment-gateway-recovery__active/repair-verification.md`. The known N05 B/C competing-chain host-evidence limitation remains nonblocking.

Further calibration did not establish the former zero-miss requirement. No additional calibration, paid evaluation or evaluator repair is required for the current delivery scope. The single combined implementation QA/review is complete; formal model-quality evaluation and tooling remain deferred until later authorization.

Reviewer `18705a11` identified two P1 defects in the **evaluation runners**, not a new runtime finding: schema-valid draft abstain/proposal noop wrongly aborts full-corpus collection; N06 can summarize before physical provider settlement. They are retained in deferred task `pi-progress-barroot-klc` as nonblocking future tooling repairs; C10/N06 depend on that repair only within the deferred evaluation backlog. The runners are not ready for a new qualification run. No new 80-case corpora or paid runs were created under this protocol.

Detailed immutable artifacts remain under the task folders for `validate-fresh-semantic-behavior`, `calibrate-continuation-decision-quality`, `clarify-generic-subtask-decisions`, and `evaluate-fresh-continuation-semantics` in `.agents/plans/`.
