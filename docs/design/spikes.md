# R2 / R4 spikes — findings and live Jev exercise

Date: 2026-09-18. Model: `jev-1.13.0`. **Four paid inference requests completed** after user approval; authentication separately succeeded via `GET /v1/models`. No extension implementation or SDK installation.

## User decisions obtained during spikes

- Use the **actual Pi-stored agent trajectory** as primary evidence for both task-health assessment and plan/report extraction.
- An explicit agent report of writing a failing regression test is sufficient for **Reported red**, even without matching observed execution. Preserve provenance; this does not establish Observed red.
- **One selected source** owns overall percentage. Auto-select when unambiguous, expose conflicts, allow user override; do not silently merge status sources.
- User authorized a bounded billable exercise using this conversation. No credential was printed, persisted in payloads or committed.

## What was actually tested

Selected visible user/assistant excerpts from this session's JSONL, including actual answers stored by the interactive-question tool. The replay reconstructed ancestry from the last recorded entry. This is an offline spike, not a validated live session collector.

Source IDs retained with every excerpt. Thinking, raw tool execution bodies, images, system prompts, private shell output, and unrelated entries were excluded. Home path was redacted. Inputs were manually selected, not produced by an automatic retrieval system. Consequently these results test interpretation of selected trajectory, **not** retrieval quality, full execution-trace understanding, or live runtime observability.

Human expectations were recorded before each call. No model was asked to generate a plan, rationale, task text, filename, or arbitrary JSON. Questions used Choice, Noul and Score over supplied text.

## R4: select source and interpret completion reports

At checkpoint after the agent's done-versus-pending status response, three candidate source excerpts were supplied:

- `p0`: user's immediate request for breadboarding and vertical slices before their review (entry `2927ba2a`).
- `p1`: assistant's proposed list of eventual implementation slices (entry `0420c792`).
- `p2`: original product-feature request (entry `ce8b6820`).

| Question | Actual answer | Interpretation |
| --- | --- | --- |
| Which source describes immediate requested work? | `p0`; probability 0.73; Choice confidence 0.65 | Matched human reading, but not a decisive distribution. `none` retained probability 0.21. |
| Research explicitly reported done? | Noul 0.97 | Correctly found positive completion report. |
| Breadboard explicitly reported done? | Noul 0.03 | Correctly distinguished promised work from delivered artifact. |
| Full vertical-slice document reported done? | Noul 0.03 | Naming slice ideas was not mistaken for completed document. |
| Extension implementation reported done? | Noul 0.02 | Correctly separated design work from implementation. |

**Fourth-call comparison:** same state and question instructions, with actual candidate text inside Choice definitions rather than indirect descriptions pointing to state fields. Selected `p0` again, but probability decreased to **0.66** and confidence to **0.58**. This small trial **did not demonstrate an improvement**. Question count also changed from five to one, relying on documented independent-question semantics. There was no repeated sampling or controlled evaluation set.

Implication: retain source uncertainty and allow correction. Do not silently pin a source merely because it won. No completion percentage was calculated: this exercise did not establish a complete, agreed atomic task denominator.

## R2: assess the planning task, not future product code

Task: prepare breadboard and vertical slices for user review. At this checkpoint, agent explicitly reported both artifacts unfinished and previous delegation unsuccessful.

| Signal | Actual answer | Design consequence |
| --- | --- | --- |
| Requirements clarity | Score **2.74 on defined 0–3 levels**; confidence 0.74 | Reasonably concrete planning deliverable. Not “91% complete” or probability of correctness. |
| Observable acceptance conditions present? | Noul **0.76** | Conditions existed in user request/agent commitment, but signal was not unequivocal. |
| New failing regression test needed for this planning task? | Choice **not_needed**; confidence 1.00 | Matches documentation-only task. Does not waive document review or future runtime tests. |
| Requested deliverable complete? | Choice **incomplete**; confidence 1.00 | Matches explicit pending status. |
| Advancement toward breadboard/slices during selected interval? | Choice **no_advance_reported**; probability 0.99; confidence 0.98 | A stream of plans/promises is not delivered advancement. This is relative to selected interval and task. |
| Main agent currently stuck? | Winning Choice **not_stuck** at 0.54; **insufficient_evidence** at 0.46; confidence **0.31** | Human expectation was insufficient evidence. Do not render winner as a confident healthy verdict; current liveness/trajectory coverage was absent. |
| Work direction? | Choice **aligned**; confidence 1.00 | Unsuccessful relevant work is not automatically drift. |

Important mismatch: raw top choice for stuck was not the human-preferred unknown label. Coverage checks in code must run before favorable health labels; a probability winner is not sufficient. This example motivates explicit coverage/uncertainty states but does not calibrate a threshold.

## Actual user answer versus hypothetical red-test assertion

A later replay included the real interactive question containing hypothetical text “I wrote a failing regression test”, followed by the user's policy answer.

| Question | Actual answer |
| --- | --- |
| Does trajectory actually assert a red test was written for this work? | Noul **0.09** |
| Did user choose that an agent report is sufficient? | Noul **0.97** |
| Which source-authority policy did user select? | **one_selected_source**, confidence 1.00 |
| Which primary evidence source did user request? | **actual_pi_trajectory**, confidence 1.00 |

This distinguishes policy discussion from an actual completion claim in this example. There was **no positive actual red-test report** in this session to test recall against. This is not proof that arbitrary quotes or prompt injection will always be handled correctly.

## Cost and latency observed

| Request | Questions | Input tokens | Wall time |
| --- | ---: | ---: | ---: |
| R4 source/status | 5 | 2,888 | 1,284 ms |
| R2 task health | 7 | 3,071 | 1,214 ms |
| User-policy/provenance | 4 | 2,198 | 1,189 ms |
| R4 candidate comparison | 1 | 3,112 | 1,241 ms |
| **Total** | **17** | **11,269** | — |

Estimated input cost **$0.000473298** (about 0.047 US cents), using published **$0.042 per million input tokens**; output tokens free per current model docs. This is a calculated estimate, not a billing statement. Four successful POST attempts, no retries. Wall times include network/response handling, not just model inference.

These small manual samples fit a ten-second refresh budget in this environment. They do not establish production latency, service availability, calibrated accuracy, or cost for arbitrary session sizes.

## Read-only source findings

### R2

Pi's message/tool/session events supply IDs, ancestry, tool arguments/results, timestamps and error flags. `isError` or nonzero process exit alone cannot identify an assertion failure: runner crash, cancellation, network failure and shell errors can look alike. Parallel tools can finish out of source order. Full test-first provenance needs matching task/file/run history and cannot be reconstructed from an isolated final message.

User policy permits a separate reported-red path. Missing execution history therefore need not block Reported red, but cannot be promoted to Observed red. Selected excerpts and file/version associations still matter for relevance and contradictions.

### R4

The repository's Beads export contained two flat in-progress tasks. No parent/child relationships or export-revision timestamp were available in these records. Record `updated_at` and file mtime are not proof of current database state. A direct JSONL adapter avoids hidden CLI sync/import side effects but must label export provenance and reject partial/malformed reads.

Task identity cannot be based only on list position. Use stable explicit IDs when available; preserve unique exact anchors across reorder; ambiguous rename/split/merge becomes reconciliation-needed rather than inheriting old completion. Candidate omission is not scope removal. Reports may apply to multiple task IDs, so one single-choice report question is insufficient.

A naïve user/assistant-only extractor misses actual user choices: in this session, **four clarification responses were stored as `ask_user_question` tool results**. Known interactive-user-answer provenance must be preserved distinctly from arbitrary tool output. Generic tool content cannot be promoted to user authority.

## Fit disposition

- **R2:** primitive feasibility and several useful interpretations demonstrated on selected real trajectory. Evidence-to-display wiring must preserve Reported/Observed/Unknown and gate missing runtime context. Temporal accuracy remains unvalidated.
- **R4:** source/status interpretation demonstrated; source uncertainty and interactive-answer provenance exposed. Automatic candidate recall, stable identity under revisions and atomic task denominator extraction remain implementation/evaluation work, not proven by this exercise.

These findings inform the breadboard, not an authorization to implement or nudge the agent.

## Artifacts and sources

Exact sanitized requests, responses, source IDs, expectations and spike scripts remain local in `.agents/plans/20260918T122243--probe-jev-session-trajectory__spiking/` (ignored; not published as part of this review packet). Read-only spike notes are in `.agents/plans/20260918T111521--breadboard-progress-monitor-slices__planning/spike-r2-findings.md` and `spike-r4-findings.md`.

Official sources: [HTTP API](https://docs.typesafe.ai/api), [models and pricing](https://docs.typesafe.ai/models), [primitives](https://docs.typesafe.ai/primitives), [confidence](https://docs.typesafe.ai/confidence). Local Pi sources: `docs/extensions.md` and `docs/session-format.md` under `/Users/nejo/.local/share/pi/`.
