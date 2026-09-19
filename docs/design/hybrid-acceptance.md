# Hybrid acceptance evidence

## Status

Runtime freeze: **`124ee557`**. Main independently passed format, TypeScript, Biome, Knip, **347 unit +12 integration tests**, **12 global-host integration tests**, and package dry-run. Local host is Pi0.84.2/pi-ai0.84.4; global host is Pi0.85.1. **Independent cumulative review and publication remain pending**; these results alone do not close H5 or earlier82j acceptance.

### Latest repair evidence

Cumulative review of `d780df28` blocked publication despite passing tests. Main `aa3e8a3c` reproduced18 failures; `124ee557` fixes conservative operation/copy admission, current-card health intermediates, saturated usage and label domains, normalized checkpoint outcomes/canonical journal spans, retained replacement-pending state, and overlapping quote grounding. All18 regressions pass, alongside two new completion-envelope guards. **Independent rereview is still required.** Logs `fourth-main-*.log` and reports are retained in the latest task directory. No new paid run was performed for these local invariant repairs; earlier semantic evidence below is labeled with its actual source revision.

The strict v6 runtime adds canonical intercom intake and independent current-activity focus, with no first-open fallback or tool ownership. Accepted phases use reconstructed request replay and phase-specific capacity admission. The full review must independently dispose earlier blockers; test totals do not substitute for this.

- `e6e03191` CI: **12 Jev /6 model calls**,27,503/1,372 Jev tokens,5,078/219 model tokens,$0.06173 reported model cost. Passed with **2/3 reported done**, meeting the specified2/3 floor, not perfect completion.
- `e6e03191` remaining: **14 Jev /4 model calls**,21,570/1,219 Jev tokens,2,339/324 model tokens,$0.03959 reported model cost. Reading, question/answer, parallel completion, withdrawal and settled reload/no-rebilling passed.
- Focus request semantics at `470dab83`: **6/6 real Jev probes**,18,427/1,160 tokens, no extraction-model calls. Explicit switch, immediate commitment, concurrent work, idle, quoted example and completed-task-to-new-focus all passed.
- Intercom: two real Jev gate probes passed; actual-host trigger/steer/follow-up tests pass. Idle non-triggering delivery is intentionally assessed next real turn, not through polling.
- The scalar-only `d780df28` change does not alter paid requests. Earlier failed request-size and numeric capacity tests were preserved, then passed after corrections; thresholds/limits were not relaxed.

Latest local artifacts are under `.agents/plans/20260919T220021--finish-pending-progress-repairs__active/`: `final-*.log`, `hybrid-ci-1789838032255-38f93041-3c9a-4ce0-99f8-986c30e901ad.jsonl`, `hybrid-remaining-1789838075715-4a2dfc6f-ca38-4c49-bb9d-c5d6f7e85d5e.jsonl`, `focus-jev-1789837851181.jsonl`, and `intercom-jev-1789836084473.jsonl`. Earlier rows below remain historical evidence, not the latest freeze. See [batching audit](jev-batching.md).

## Production-path paid runs

No threshold changes, fixture-specific branches, fabricated answers, hidden retries or discarded failed attempts. CI caps32Jev/8model; remaining caps64/16; orgtok cap16/4. Each row is one explicit frozen run.

| Revision / group | Jev / model | Jev input / output | Model input / output | Reported model cost | Outcome |
|---|---:|---:|---:|---:|---|
| `2ec748b0` CI | 3 /1 | 3,868 /328 | 378 /137 | $0.01063 | Failed: inspection+diagnosis merged into2 initial tasks |
| `339503f4` CI | 18 /6 | 40,547 /2,678 | 4,667 /670 | $0.08017 | Failed:3 initial tasks expanded to6 implementation substeps; final2/6 |
| `339503f4` remaining | 19 /4 | 24,602 /1,862 | 1,835 /310 | $0.03385 | Passed all listed cases |
| `d7c703b2` CI | 17 /6 | 30,866 /2,031 | 5,021 /215 | $0.06096 | Passed:3 stable IDs; final3/3, no unresolved scope |
| `d7c703b2` remaining | 19 /3 | 24,602 /1,865 | 1,529 /238 | $0.02719 | Passed all listed cases |
| `d7c703b2` orgtok | 10 /3 | 19,150 /993 | 3,338 /165 | $0.04163 | Passed:0/2→2/2→2/3→3/3; no user-approval tasks |

Total listed: **86Jev /23model calls**, **143,635 /9,757 Jev tokens**, **16,768 /1,735 model tokens**, **$0.25443 reported model cost**, zero reported model cache-read tokens. Jev charges are not included in the cost column. Earlier exploration, completion experiments and orgtok debugging are separate, not hidden in this total.

### What was demonstrated

- Exact six-message CI trace: three separate inspect/diagnose/fix deliverables; no extra implementation substeps; final3/3 (required floor2/3). Inspection completion was recognized only in the final summary, a visible semantic delay.
- Reading-only request containing a path: admitted and completed without treating it as an edit request.
- Substantive question and delivered answer.
- Parallel tasks: later two completed while first remained open; withdrawal reopened only its target and preserved the unrelated completed task.
- Settled OFF/ON/reload: no further paid requests.
- Orgtok **only first two user messages and corresponding responses**: new blocker question admitted after earlier work completed, then completed by its answer; no approvals or third-party work added. No later orgtok work was inspected or replayed.

The orgtok initial review request now decomposes into review and reporting tasks, hence final3/3 rather than the earlier2/2. This is explicit user-request decomposition, not fabricated extra obligations. IDs remain stable after each admission.

### Retained local artifacts

Under `.agents/plans/20260919T130925--redesign-pragmatic-hybrid-progress__planning/`:

- `hybrid-ci-1789814326694-a4fa9dbc-b8d1-42bd-9e5b-2a9fe5de58c1.jsonl` — first failure.
- `hybrid-ci-1789814644461-51909306-6dd4-4766-8703-7d1e81245974.jsonl` — extra-substep failure.
- `hybrid-remaining-1789814962820-4e650417-7eaa-4f4a-8e56-5b36f02f2e3f.jsonl` — earlier remaining pass.
- `hybrid-ci-1789815157480-188d9289-2f2f-4326-a9c4-66670071e949.jsonl` — final CI pass.
- `hybrid-remaining-1789815223386-c2ea52c1-1907-420c-816a-ab6d3a35372a.jsonl` — final remaining pass.

Orgtok task directory `20260919T155100--repair-orgtok-session-regressions__active/pipeline-1789815251137.jsonl` holds final regression evidence. Earlier actor-boundary failure and zero-call model-catalogue preflight failure remain preserved there. These ignored local records are not distributed package contents.

## Safety coverage disposition

The pre-hybrid tests were explicitly archived, not counted as passing. New suites replace the following safety intents:

| Earlier obligation | Current coverage / disposition |
|---|---|
| Post-cutover/513-append/byte-window loss | `hybrid-bounds`, canonical chronological paging; no early cutover |
| No-ledger veto and future direction leaking backward | `hybrid-lifecycle`, `hybrid-bounds`; source-chronological bounded context |
| Unbounded settled caches / full historical payload reads | `hybrid-bounds`; metadata-only scans distinguished from payload reads |
| Accepted partial work rebilled after OFF/reload | `hybrid-chunk-resume`, `hybrid-checkpoint`, `hybrid-retry` |
| Abort/late provider result and canonical amendment races | `hybrid-retry`, `hybrid-bounds`, `hybrid-lifecycle` |
| Malformed checkpoint / obsolete interval | Strict v6 `hybrid-checkpoint`; older versions rejected, no migration |
| Health/Beads/card and publication parity | `hybrid-parity`, `hybrid-beads`, `hybrid-view` |
| Real host authority and selected-model authentication | `host-events.integration`, `selected-model-host.integration` on both supported hosts |
| Response admission, actor ownership and ANSI fragments | `hybrid-orgtok`, `hybrid-view`, first-two-turn paid replay |

Old fresh-message next-cycle latency, span-only/Jev-only labels and memory-only card/timestamp persistence are intentionally superseded. Chronological backlog latency and bounded derived persistence (now v6) are the approved replacements. Full review must independently verify this disposition against **`afdbee79..final`**, not just recent prompt edits.

## Limits of the evidence

Finite single-run semantics are not a reliability guarantee. Jev may confidently miss work or abstain; generated task grouping is probabilistic. No further gate-ablation study is required for this pragmatic delivery. Whole-message/page/state limits can prevent admission; history catch-up is chronological. Provider availability, long histories, broader model families and unsupported tool/Beads formats are not universally proven. Full debugger/redesign/advisory work is excluded.

## Implementation-health correction — `0417a04b`

User-approved scoped health change, not acceptance of outstanding H5/82j durability/authority repairs. Source `00a141cc` wires actual bounded passive candidates and canonical requirements into health, adds partial/not-needed choices, handles final-completion assessment and rejects stale in-flight evidence. `0417a04b` clarifies that applicability is decided before missing evidence. Red-evidence precedence is unchanged. Both user and assistant roles may still affect scope and task state.

Main independently passed format/check, **224 unit +8 integration tests**. The preceding wiring revision also passed8 global-host integration tests and package dry-run. Fifteen dedicated regression tests cover applicability, aggregation, evidence wiring, lack of automatic tool ownership/completion, unsupported claims, canonical reset and in-flight evidence changes.

Bounded semantic check uses production `healthSnapshot`, Jev gateway and implementation aggregation—not a full live Monitor session. First run (`00a141cc`) failed on the informational fixture: insufficient evidence won over not-needed;1 Jev call,1,288 input/217 output tokens. Failure is retained, not counted as a pass.

The corrected frozen run (`0417a04b`) passed all4 cases: informational→not-needed, partial support→partial, full support→appears complete, bare self-report→unverified. **4 Jev calls,0 extraction-LLM calls;5,733 input/859 output tokens.** Confidence/probability thresholds were not lowered. No hidden retry. Total scoped health validation including failure:5 Jev calls,7,021 input/1,076 output tokens.

Artifacts in `.agents/plans/20260919T191131--enable-useful-implementation-health__active/`: `health-live-1789826237763.jsonl` (failed), `health-live-1789826417885.jsonl` (passed), `main-gates.log`, `applicability-main-gates.log`. These finite fixtures demonstrate the new choices, not universal semantic accuracy. Earlier full-batch review blockers remain open and must be resolved separately.
