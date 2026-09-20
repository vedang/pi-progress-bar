# When Pi Progress Bar calls Jev and Extraction

**Source snapshot:** `7d7d9e0e` in `pi-progress-bar.root`, inspected 2026-09-20. This describes implemented behavior, not the advisory roadmap or another worktree's newer changes. No runtime code or model calls were needed to produce this walkthrough.

## Diagrams

1. [Core inference pipeline](core.html): canonical observation → Jev scope gate → conditional Extraction → Jev status/focus → saved state and UI.
2. [Additional Jev calls](optional.html): tool focus, grounded detail validation, and task health.

Both are standalone Archify HTML files with light/dark mode and interactive inspection. **Layout limitation:** the core diagram passes deterministic artifact checks but fails desktop first-screen containment; it requires vertical scrolling and its right-hand routes are visually crowded. The optional diagram passes both artifact and browser checks. See [receipts](receipts.json). Neither diagram implies that a returned model result is accepted without validation.

## The mental model in one sentence

**Every newly admitted canonical text observation can cause Jev scope and task-status judgments; only a changed or uncertain scope decision causes selected-model Extraction. Three other optional paths also call Jev.**

It is **not** “user messages → Extraction, assistant messages → Jev.” Both roles take the same semantic path. Canonical `intercom_message` custom messages also enter it with distinct `intercom` provenance.

## 1. What starts the work?

[Event hooks](../../../src/index.ts#L83) do not directly equate to provider calls:

| Pi event | Local action | Potential inference |
|---|---|---|
| `context` | Read the active canonical branch | Process newly eligible observations |
| `turn_end` | Reconcile actual tool starts, then read the branch | Changed tool-focus batch; canonical processing |
| `agent_settled` | Mark activity idle, then read the branch | Catch up canonical processing; not an unconditional call |
| `message_end` | Capture the declared tool-call batch | Optional provisional tool-focus Jev; **not** direct semantic Extraction |
| `tool_execution_start` | Record safe activity metadata and passive evidence start | No direct provider call |
| `tool_execution_end` | Record passive facts and invalidate stale health display | No direct provider call; does not itself enqueue a new health assessment |
| `agent_start` | Set activity text | No provider call |
| `session_start`, `session_tree` | Restore and reconcile checkpoint against branch | Resume/catch up if enabled and eligible; not unconditional rebilling |
| `model_select` | Wake/reconcile selected-model work | Can retry blocked Extraction; not unconditional Extraction |
| Board open, navigation, widget repaint | Read presentation snapshots | **Zero** provider calls |
| OFF / shutdown | Invalidate and abort runtime work | No new dispatch |

The [canonical reader](../../../src/sources/messages.ts#L16) accepts nonempty visible text from user/assistant messages, excluding error/aborted messages, plus `custom_message` entries with `customType: intercom_message`. It does not make tool-result bodies, thinking blocks, arbitrary custom messages, or images into semantic observations. A tool-only assistant message can still use the separate tool-focus path.

Observations have an entry ID, role, and text hash. Re-observing the same settled branch is not a new transaction. An amended earlier message can invalidate derived state and cause canonical replay. Idle intercom delivery has no dedicated hook in this extension: its stored message is discovered on the next branch-observation wake.

## 2. Core pipeline, in execution order

Implementation: [Monitor.drain/processOne](../../../src/core/monitor.ts#L2180) and [processObservation](../../../src/core/hybrid.ts#L1026).

### A. Admit an observation locally

The monitor must be ON, have current canonical authority, and have room to persist the worst-case next transition. One canonical observation is processed at a time, in branch order. Pending phases resume before later observations.

Bounds are not arbitrary text truncation: an oversized latest message (>12 KiB) becomes an unresolved overflow without a fresh gate call. Requests also have byte/question limits; failed admission can stop dispatch. Missing API key, invalid restored state, capacity limits, or unresolved branch authority can prevent work.

### B. Jev call: scope gate

[gateRequest/gateResult](../../../src/analysis/gate.ts) supplies:

- Latest observation: ID, role, complete admitted visible text, hash.
- Up to two prior observations, bounded to 4 KiB total.
- All included task summaries, including status and revision.
- One choice question: `changed`, `unchanged`, or `uncertain`.

[Choice acceptance](../../../src/core/hybrid-proof.ts#L41) requires **confidence ≥ 0.5 and chosen probability ≥ 0.8**.

| Gate result | Next step |
|---|---|
| Accepted `unchanged` | Skip Extraction; continue to task-status judgments |
| Accepted `changed` | Call Extraction |
| `uncertain`, or valid response below either threshold | Call Extraction |
| Transport/response-validation failure | Failure/retry path; **not** an automatic Extraction fallback |

The gate's accepted phase is persisted before proceeding.

### C. Conditional Extraction call: Pi's currently selected model

[Adapter](../../../src/core/selected-model.ts#L42), [schema/input/grounding](../../../src/analysis/extractor.ts).

This is **not Jev**. The extension invokes `context.modelRegistry.complete(context.model, ...)` using Pi's selected model and authentication. Input contains bounded latest/prior text and task summaries, not the full chat or raw tool output. Included tasks are retained; recent archived summaries are admitted within a separate bound.

- Strict JSON output: `add`, `revise`, `archive`, `restore`, `unresolved`.
- New tasks can be action work or conversational response deliverables.
- Each mandatory operation needs an exact quote occurring once in the latest message; IDs and targets are validated locally.
- Extraction does **not** decide completion, health, or tool ownership.
- Optional title, description, and acceptance-criterion quote candidates may be returned in the same response. They do not cause a second Extraction call.
- `tools: []`, `maxTokens: 2048`, `maxRetries: 0`, 60-second deadline.
- A valid no-op or valid unresolved empty patch can continue to completion checks. Invalid JSON/grounding/targets block this observation before completion; no fabricated replacement patch.

A valid patch is saved before status processing. This is why the diagram's final checkpoint box is a simplification: persistence also occurs after the gate, patch, and each accepted status chunk.

### D. Jev call(s): completion, withdrawal, and semantic focus

[completionRequest](../../../src/analysis/completion.ts#L80), [chunk loop](../../../src/core/hybrid.ts#L1190).

After scope handling, every included task is eligible for a status question—including tasks just added or revised:

- Open task: `complete:<id>` asks whether the latest message actually establishes completion.
- Done task: `withdraw:<id>` asks whether the latest message actually contradicts/withdraws its earlier completion.
- Accepted `yes` completes an open task or reopens a done task. `no`, uncertainty, or threshold abstention preserves status.
- First chunk additionally asks `focus` over **all open candidates**. Its answer can be one task ID, `none`, `concurrent`, or `uncertain`. This question shares the status call; it is not a separate semantic focus request.
- Maximum 20 questions/request; focus uses one slot. Byte limits can split chunks earlier. With small inputs: first chunk fits 19 tasks plus focus, later chunks up to 20 status questions.
- If no included tasks exist, this phase makes **zero** calls.

New tasks may complete in the same observation if that message itself delivers the requested result. Completion is based on accepted visible evidence, not proof that every underlying tool/test succeeded. Health remains a separate assessment.

### E. Commit cursor; render locally

After all required phases settle, the observation cursor advances. Widget and board read local snapshots. Their task count remains **done / included total**, not a within-task percentage or effort estimate. INPROG focus can change without changing that fraction.

## 3. The three additional Jev paths

These are separate gateways, not additional uses of the Extraction model.

### Tool focus: “Which open task does this tool batch serve?”

[Declaration/reconciliation](../../../src/core/monitor.ts#L438), [dispatch](../../../src/core/monitor.ts#L2083).

1. `message_end` captures a safe declared tool-call batch. If ready, it can request a provisional Jev judgment immediately.
2. Tool starts are collected locally.
3. `turn_end` reconciles declarations against observed starts. **Only a changed observed call list permits another inference request.** Unchanged lists do not duplicate the provisional call.
4. The batch must still be current, have open candidates, pass capacity checks, and encounter no pending canonical work.
5. One `activityFocus` question compares safe metadata against all open task summaries. Raw shell results and arbitrary argument text are not sent as activity evidence.
6. Accepted single-task answers update display focus; abstention clears superseded focus. This does not complete tasks or establish tool-evidence ownership.

Canonical work preempts/invalidates optional activity. A changed batch is eligible for another call, not guaranteed to get one. Additional activity while a flight exists retains the newer queued batch.

### Grounded details: “Is this exact quote suitable for this field?”

[processDetails](../../../src/core/monitor.ts#L2466), [detail request builder](../../../src/analysis/task-details.ts).

Only runs when Extraction has supplied grounded optional candidates for a current task revision. Production enables this path (`richDetailsEnabled: true`). It requests uncovered candidate keys, selecting the largest fitting nonempty prefix. Accepted receipts and quote references are saved; rejected/unknown fields stay absent. A task with no candidates incurs no detail call.

Candidates include title, description, and up to six acceptance criteria. Fields are not freely generated by Jev. Optional parse, capacity, transport, or persistence failures do not invalidate the mandatory task patch; work can be parked until a named later wake.

### Health: “How well supported is the focused task?”

[scheduleHealth](../../../src/core/monitor.ts#L2585), [projectedHealth](../../../src/core/monitor.ts#L3201), [assessHealth](../../../src/core/monitor.ts#L3287).

A settled canonical observation schedules health for the semantic open focus. If all tasks have just finished, the previously focused completed task can receive the retained final assessment. No eligible focus means no health call. Newer semantic observations can replace pending health; processing every message does **not** guarantee one health call per message.

Health input combines the exact task-source quote, latest canonical report, bounded passive facts, and a task/revision/evidence identity. Identical current health can be skipped. Tool completion can invalidate health freshness without immediately scheduling a replacement call.

**Important current-code detail:** `projectedHealth` supplies `criteria: [task.label]`. The generic health builder supports many criterion batches, but this runtime projection normally produces **one Jev request with five questions**:

1. `clarity` — requirements clarity score.
2. `acceptance` — whether observable acceptance conditions exist.
3. `redApplicability` — whether a new failing regression test adds value.
4. `redReport` — whether a task-linked failing-test assertion was actually reported.
5. `criterion:0` — implementation support for the task label.

The rich acceptance-criterion quotes displayed in task details are **not** currently wired in as the health criterion list. This distinction matters when comparing the board to your mental model.

The five displayed signals are requirements, acceptance, new-red-test necessity, red evidence, and implementation. These do not mark the task DONE. Passive facts are candidate evidence, not automatically owned by the focused task.

## 4. Ordering and concurrency

- Core order within an observation: **gate → optional Extraction → sequential status chunks**.
- `drain()` selects queued canonical work first, then eligible detail work, then pending health.
- Tool activity scheduling is a separate path and refuses to dispatch while canonical work is pending.
- Each of four Jev gateway instances allows one in-flight request of its own: semantic, activity, details, health.
- **Selection priority is not a global mutex.** Optional flights can overlap; do not interpret the diagrams as one total order across every provider call. Authority, epoch, task revision and flight checks control result acceptance; new canonical observations cancel health/activity as appropriate.
- `src/analysis/scheduler.ts` exists but is not imported/constructed by the active extension. Its coalescing/cache behavior is not this runtime's behavior.
- No periodic progress inference loop or advisory nudge dispatch is active in this snapshot. Retry timers and bounded canonical-scan continuation wakes are not periodic analysis polling.

## 5. Retries and the counters you see

[Jev transport](../../../src/analysis/gateway.ts), [Monitor retry handling](../../../src/core/monitor.ts#L2350), [dispatch accounting](../../../src/core/monitor.ts#L3070).

Jev uses `jev-1.13.0`, `https://api.typesafe.ai/v1/systemone`, `TYPESAFE_API_KEY`, ≤24 KiB/request, ≤20 questions/request, and a 10-second deadline. Invalid response/network/service failure backs off 10s, then 20s, then a 5-minute cooldown after three burst failures, unless `Retry-After` controls the next eligible time. The semantic monitor schedules the retry wake; optional gateways do not imply autonomous repeating jobs. A permanent semantic 4xx (except 408/429) turns monitoring OFF; a permanent optional-gateway error does not turn off core tracking.

Selected-model failure parks semantic work (`waitingForWake`) for a model-selection/control wake instead of using the Jev retry timer. Its adapter performs no SDK automatic retries.

Saved accepted gate/patch/status phases are replay-validated before reuse. Resume continues from the missing phase/chunk. Canonical amendments can discard stale proof and require new calls. Live gateway calls use `allowDuplicate=true`: avoiding duplicate accepted work comes from monitor identity/cursor/journal checks, not a universal gateway request-hash cache.

**Calls/last-call times count actual dispatch attempts, including attempts that later fail. Tokens are accounted from validated provider responses along the relevant path.** One request can contain many questions. Thus the Jev counter is neither a task counter nor a message counter, and a dispatch count need not have matching accepted token usage.

## 6. Concrete examples

Assume ON, valid authority, small inputs, no retries, and two included open tasks unless stated otherwise. Optional calls are additional, not included in the core totals.

| Observation | Core Jev calls | Extraction calls | Why |
|---|---:|---:|---|
| Fresh user request adds one task; gate says changed | 2 | 1 | Gate, then completion + focus after patch |
| Assistant reports progress; accepted unchanged | 2 | 0 | Gate still precedes status + focus |
| User changes requirements; gate uncertain | 2 | 1 | Uncertainty deliberately takes the Extraction path |
| All included tasks already done; unchanged scope | 2 | 0 | Gate + withdrawal questions, without open-task focus |
| No tasks; accepted unchanged | 1 | 0 | Gate only; no status candidates |
| Extracted response is invalid JSON | 1 | 1 | Gate + attempted Extraction; status phase blocked |
| Tool-only assistant turn, unchanged reconciled batch | 0 | 0 | No semantic text; optional activity Jev may still add 1 |
| Tool batch changes at turn end | 0 attributable to batch | 0 attributable to batch | Provisional and corrected activity requests may add up to 2; canonical text is processed separately |
| Board opened or repainted | 0 | 0 | Local snapshots only |
| Exact accepted transaction restored, no new text | 0 new core calls | 0 | Reuse saved semantic result; unfinished optional work may still be eligible |

Optional additions: grounded details need candidates; health needs an eligible focus and changed valid snapshot; activity needs a safe current batch with no canonical work. Therefore there is no honest fixed “N calls per agent turn.”

## Mental-model checklist

- [ ] Both user and assistant text can change scope **and** complete/withdraw work.
- [ ] Jev uncertainty can increase Extraction calls; transport failure does not authorize bypassing the gate.
- [ ] Unchanged scope does not mean “no more inference.”
- [ ] Completion/focus questions can share one Jev request.
- [ ] Tool focus is optional display inference, not task creation or proof of ownership.
- [ ] Health is focused-task assessment, not a whole-board completion pass.
- [ ] Rich detail criteria and the current single-label health criterion are different inputs.
- [ ] Existing checkpoints can suppress repeated paid phases, but branch changes can require replay.
- [ ] UI calls nothing; its usage panel aggregates several different inference purposes.
- [ ] Advisory behavior is not included in this source snapshot.
