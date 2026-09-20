# Execution visibility — deferred implementation plan

**Status: DEFERRED.** Implement only after advisory work completes, this plan is re-anchored on its accepted revision, and Gates 0A–0C pass. Proposed first-version scope: visibility exists only for one live monitoring lifetime. No checkpoint field, migration, replay reconstruction, or cross-reload action history.

## Goal

Keep stable main tasks/statuses on left; show granular fresh activity plus bounded meaningful task-bound history in widget/right pane across multiple agent runs in current monitoring lifetime, with explicit `Since monitoring resumed · history may be incomplete` qualification.

## Requirements and fit

| ID | Requirement                                                                 | Mechanic                                                                                                          | Design fit |
|----|-----------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|:----------:|
| R1 | Main tasks remain semantic rows; bead work may be an action under feature.  | Leave task extraction, `HybridState`, count, completion, focus, and left rows unchanged.                          |  Proposed  |
| R2 | Current doing changes promptly during long work.                            | Provisional assistant-label selection starts at live `message_end`; deterministic tool phase appears immediately. |  Proposed  |
| R3 | Right pane has selected-task Summary, Current Activity, meaningful history. | Detached runtime projection; one Summary; task-bound actions only.                                                |  Proposed  |
| R4 | No fake fact, completion, percentage, or advisory authority.                | Reported/observed wording; visibility has no semantic/advisory write path.                                        |  Proposed  |
| R5 | Tool-only and unchanged-scope work can update without unsafe raw outputs.   | Finite tool phases; post-semantic task binding; commentary path independent of scope gate.                        |  Proposed  |
| R6 | Work is bounded, failure-isolated, and honest about gaps.                   | Fixed queues/history/spend; no sampling; explicit incomplete/unbound/unavailable states.                          |  Proposed  |
| R7 | OFF/reload/tree/amendment never restores stale work.                        | Clear all visibility and begin new qualified lifetime; no backfill.                                               |  Proposed  |
| R8 | Semantic quality is proven before dependent integration.                    | Dual-host event gate, deterministic candidate gate, then bounded paid calibration.                                |  Proposed  |

A read-only audit of the advisory session found all 12 eligible user/assistant/intercom observations consumed; D0/H0 updates were treated as covered work rather than new tasks. This demonstrates the policy mismatch, not broken message intake. It does **not** prove future candidate selection or task-binding quality.

## Chosen shape

Reject semantic subtasks/hierarchy: it changes denominator and completion semantics. Reject durable action state: it creates replay/grounding/version risk beyond owner’s initial need. Reject free-text model summaries: Jev returns typed choices, not arbitrary labels.

Recommend one runtime-only `ExecutionVisibilityStore` owned by `Monitor`:

```ts
interface VisibilityLifetime {
  generation: number;
  coverage: "since-monitoring-resumed" | "incomplete";
  current?: CurrentActivity;
  actions: RuntimeAction[];
  latestCurrent?: CurrentJob;
  historyQueue: HistoryJob[];
  usage: { calls: number; inputTokens: number; outputTokens: number; lastCallAt?: number };
}

interface RuntimeAction {
  id: string;
  order: number;
  task: { id: string; label: string; revision: number; sourceDigest: string };
  grounding: { kind: "reported"; candidate: ExactCandidate; receipt: TypedReceipt };
}
```

Proposed bounds, subject to Gate 0C long-run acceptance: 48 actions total, 16 per task ID, history queue 4, one latest-current slot, one visibility flight, 64 visibility Jev dispatches per monitoring lifetime. Retention drops oldest and permanently sets `coverage: incomplete`. No timer fabricates progress or starts inference. The freshness ceiling is measured from source ingress, including queue time. Current-result admission has a 5-second freshness ceiling; history-result admission requires source among latest eight live eligible assistant observations plus exact task revision/source identity. Stale results drop and mark gap.

Store survives `agent_settled`→next `agent_start`, so history spans multiple independent runs. OFF, restore/reload, `/tree`, source amendment, monitor stop, or source-ID change destroys store/queues/usage, increments generation, and starts a new lifetime qualified `Since monitoring resumed · earlier activity unavailable`. Nothing is persisted or reconstructed.

## Evidence and labels

### Assistant-visible commentary

Assistant prose is a **report**, not proof. Render exact accepted text as:

- current: `Agent says: Characterizing delivery behavior across both Pi versions`
- history: `Agent reported: Host characterization passes on both Pi versions`

Even words such as “passed,” “complete,” or “approved” remain inside reported prefix. They never set DONE, INPROG, health, evidence, or advisory readiness.

Candidate generation uses Markdown block boundaries plus `Intl.Segmenter` sentence boundaries and grapheme-safe splitting—not sentence regex. Every non-whitespace source scalar must belong to exactly one candidate. Limits: whole visible assistant message 12 KiB, at most 12 candidates, each at most 240 Unicode scalars. If complete coverage or serialized request exceeds Jev’s 24-KiB limit, abstain, dispatch zero, and mark history incomplete. Never sample.

Use bounded two-stage typed selection:

1. **Stage 1, exact candidate selection:** one request selects `currentCandidate` and `historyCandidate` from supplied IDs plus `none/concurrent/uncertain`. Current means immediate doing; history means one material finding, decision, validation/review report, blocker, or completed intermediate action. Future intention alone is not history.
2. **Stage 2, task binding:** after canonical confirmation and semantic processing, one request receives each selected **fixed candidate reference** `{liveToken,messageHash,start,end,quoteHash}` plus all included tasks `{id,label,revision,sourceDigest}`. Separate questions bind each fixed candidate to one task/none/concurrent/uncertain. Candidate cannot be swapped or paired with an independently selected unrelated task. Record full normalized assessment and request hash in runtime memory.

Both stages use existing confidence `>= .5` and selected probability `>= .8`. Stage 1 output is only an unbound provisional report until exact canonical confirmation; it cannot select a task. Stage 2 sends all included tasks or abstains; no task sampling/chunk winner. Its fixed candidate uses the confirmed canonical hash, never the preappend hash. No extra selected-model/LLM proposer is allowed unless measured candidate recall fails and owner explicitly chooses a separately reviewed escalation.

### Tool activity

New visibility tool processing is local and makes zero provider calls. Its projection contains only finite phase and start/end/error facts, not paths, commands, args, output, call IDs, or arbitrary tool names. Local host identifiers remain available internally for event deduplication. These restrictions apply to the NEW visibility path, not existing activity-focus inference.

| Live evidence | Current | Eligible history |
| --- | --- | --- |
| read/search/edit/write | `Inspecting code` / `Editing code` | None; ephemeral only |
| shell category test | `Running test command` | None; no proven task identity |
| shell category build | `Running build command` | None; no proven task identity |
| proven structured review adapter | `Review in progress` | None; no proven task identity |
| unknown/delegation name alone | `Using a tool` | None |

Terminal events clear the matching current phase. They never assert “tests passed,” “edit applied,” “repository checked,” “review approved,” or “child completed.” Deduplicate duplicate host events for the same live call; never coalesce across turns. No new child-progress subscription or structured review adapter is in scope; show a review phase only if the accepted host already exposes that fact.

Phase-only evidence cannot establish task identity, even with one included task. Skip task-binding inference entirely; keep tool current global/unattributed and omit tool-only history. Mark coverage incomplete when a material terminal phase cannot enter task history. A subsequent canonical assistant report may enter history as reported, not observed. Structured task-linked tool history is a separate future design, not this implementation.

Retain existing `activityFocus` behavior unchanged: its safe paths/tool names, shared Jev telemetry and existing save behavior remain as previously accepted. Those existing calls are outside the NEW visibility budget and must remain separately disclosed/accounted for. Focus cannot authorize new history. Identical provisional/final tool membership must still emit no correction or repeat activity-focus request.

## Timely live ordering and priority

Existing tests establish the negative baseline: `__tests__/index.test.ts:111` proves preappend `message_end` is not canonical; `__tests__/activity-host.integration.test.ts:104` proves a later listener may replace assistant content; `__tests__/host-events.integration.test.ts:174,227,255` proves canonical visibility/order at later hooks. Early text is therefore a listener-relative hint, never committed evidence or safe task-binding input.

Gate 0A must first prove this order on pinned Pi 0.84.2 and external Pi 0.85.1:

1. Live assistant `message_end` exposes provisional visible text before declared tools execute, under both listener-registration orders.
2. A later listener may transform/remove that text; the extension observes and invalidates the mismatch rather than treating early content as final.
3. Tool starts/ends and final `turn_end` membership/order are observable; unchanged tool membership preserves current no-repeat behavior.
4. Canonical assistant observation with exact visible-text hash is confirmable only from active branch at `context` or `turn_end`.
5. Partial, abort, error, settlement, and branch navigation invalidate provisional work correctly.

Runtime sequence after proof:

1. At eligible live `message_end`, capture preappend text/candidates, assign live token, and replace sole latest-current slot. If semantic/advisory work is idle and lifetime budget remains, dispatch Stage 1 asynchronously; never await host hook and never task-bind this early text.
2. An accepted Stage-1 current result may display only as `Agent says (provisional): … · task unconfirmed`, and only when token is latest, agent is active, source-ingress age <=5 seconds, and message has not been invalidated. It cannot enter history or drive task status.
3. Tool declarations publish finite current phase immediately without new inference.
4. At tool start/end/`turn_end`, reconcile actual starts in final source order. Tool events never enter task history or the inference queue; matching terminal events clear local current. Missing task-history coverage is explicit.
5. At `turn_end`/`context`, match the whole provisional visible-text hash to exact canonical observation. Exact match promotes candidate refs to canonical refs. Changed/removed text invalidates current and every early receipt. Changed final text may create a fresh **history-only** candidate job after semantic commit; it never reuses the provisional selection.
6. Existing semantic observation always runs. Visibility capture cannot remove, reorder, delay, or mark a canonical input handled.
7. Only after semantic cursor/task mutation and accepted advisory admission/work are quiescent may optional drain run Stage 2 against confirmed assistant refs. New mandatory semantic/advisory work aborts or supersedes visibility work; it never waits for visibility.
8. Accepted binding applies only to captured exact post-semantic task identity. Current old-revision binding clears; historical report may append only within eight-live-observation admission window.
9. `agent_settled` clears current immediately. A still-fresh, canonically confirmed history job may finish; it cannot resurrect current.

Scheduling: latest-current wins; history FIFO holds up to four admitted material jobs. On fifth, drop oldest not in flight, set gap, keep latest current. No timer retries, cadence calls, or provider retry queue. New evidence may schedule new work. At 64 dispatches, semantic/tool-local current continues, but semantic labels/task-bound history stop with `Visibility budget reached · history incomplete`.

## Telemetry, privacy, and isolation

Create separate runtime `visibilityUsage`; show calls/tokens/last dispatch/budget remaining in selected widget/debug display. New calls do **not** update existing `usage.jev`, `lastJevCallAt`, checkpoint bytes, semantic capacity, advisory budget/cooldown/readiness, or save path. Use a separate gateway/failure state unless completed advisory proof supplies a shared admission seam and explicitly proves counters/admission are display-only. Re-anchor must preserve accepted advisory behavior byte-for-byte.

Privacy claim is narrow and honest:

- the NEW tool visibility path sends no provider payload; its local UI projection excludes paths, commands, args, output, call IDs, and arbitrary names;
- existing activity-focus inference still sends its previously accepted safe paths/tool names and updates existing counters/persistence; this plan does not claim all extension inference is path-free or covered by the new budget;
- exact assistant-visible prose is sent for candidate judgment and may itself contain copied code, output, URLs, tokens, or credentials;
- provisional preappend prose may be sent before later listeners/canonical storage change or remove it; disclosure must state this explicitly;
- terminal sanitization removes controls, **not secrets**; no secret-scrubbing guarantee exists;
- monitoring consent/disclosure must state this extra request use; over-bound messages abstain, not truncate.

Tests cover path/arg/output exclusion and exact handling of inline code, fenced output, URL queries, token-like strings, and quoted examples. Synthetic fixtures contain no real secrets.

## UI contract

Left list remains unchanged. Right pane owns one selected-task `Summary`: task label/status, accepted title/description/criteria, service, and five existing health fields exactly once. `Current Activity` and `Meaningful Actions` are separate.

- Current bound to selected task: show normally.
- Current bound to another task: show global line `Agent current: <activity> · other task <label>`; never insert into selected task history.
- Unbound current: `Agent current: <activity> · task unconfirmed`; never task-local.
- New commentary never drives board INPROG; existing semantic/activity-focus precedence remains authoritative.
- Critical service/capacity/saved-state warning remains widget first; current is second.
- At action-list top, follow newest. While user is scrolled, anchor by action ID plus wrapped-line offset so prepending does not move viewed content. Task switch resets anchor/top. Removed anchor falls to nearest surviving action and shows gap qualifier.
- Existing unsupported geometry continues `Board too small — resize terminal`; make no reachability claim below current layout gate.

## Tasks

Main writes failing tests before each source slice. No dependent integration starts before 0A–0C.

1. **Gate 0 — re-anchor + host/candidate/calibration proof**
   - Re-anchor on completed advisory revision; run `make format`, `make check`, then `make test`.
   - 0A: extend actual-host characterization for preappend/noncanonical `message_end`, both listener orders and content replacement/removal, canonical confirmation, unchanged-tool-list no-repeat, tool finalization, settlement, partial/abort/error, and branch boundaries on both Pi versions.
   - 0B: main writes failing pure candidate/request builder tests; delegate implementation of `src/analysis/activity-label.ts` here, without production wiring. Cover full coverage, dotted paths, Unicode, compound statements, quotes, negation, conditional offers, atomic fixed-candidate Stage 2, all-20-task 24-KiB admission, zero-call overflow. Freeze tested helper revision before calibration.
   - 0C: future authorized paid run on that frozen helper revision: 16 positive, 8 negative/quoted, 8 ambiguous cases; at most 32 Stage-1 + 32 Stage-2 = **64 dispatches**, one attempt per stage, zero retries. Stage 2 runs only when Stage 1 selects a candidate; an incorrectly accepted negative is still a failure, never hidden by skipping binding. Gate requires zero wrong accepted task bindings, zero accepted negative/quoted claims, safe outcomes for every ambiguous case, and >=12/16 correct accepted positives. Include at least 8 current-activity positives and require >=6/8 correctly accepted within 5 seconds of ingress, not merely within 5 seconds of dispatch. Record ingress/queue/dispatch/response/admission latency and rejection reasons. Failure stops integration; owner chooses narrower scope or a separately reviewed proposer plan.
   - Before Slice 1, replay a representative hours-long trace without paid calls to estimate eligible messages, candidate overflows, calls/hour, history drops, and time to exhaust the proposed 64-call lifetime budget. Report new and existing inference separately. Owner must accept target duration and budget-exhaustion degradation, or approve a revised bounded budget. No silent budget increase; 64 and 5 seconds are proposals, not proven product-fit figures.

2. **Slice 1 — runtime engine and timely current**
   - Files: integrate the Gate-0B `src/analysis/activity-label.ts`; add `src/core/execution-visibility.ts`; update `src/core/monitor.ts`, `src/index.ts`. Reuse existing safe phase classification without changing activity-focus inference.
   - Add live-token confirmation, two-stage queue, finite tool phases, bounds, stale admission, lifetime spend, separate gateway/usage. No checkpoint imports or save calls.
   - Acceptance: semantic/advisory events preempt without loss; current appears during tool work in host trace; reported/observed wording exact.

3. **Slice 2 — detached projection and complete UX**
   - Files: `src/core/board-projection.ts`, `src/ui/widget.ts`, `src/ui/board.ts`, `src/ui/controller.ts`.
   - Add qualified lifetime/current/task-local history projections, mismatch wording, warning priority, ID scroll anchor, single Summary.
   - Acceptance: stable left rows/count; no visibility-driven INPROG; one Summary/five health rows; wide/narrow supported layouts; resize notice below gate.

4. **Slice 3 — boundaries, regression, and acceptance**
   - Tests: runtime store/monitor, activity label, widget/board/controller, lifecycle, accepted advisory regression, dual-host integration, frozen live calibration.
   - OFF/reload/tree/amendment tests clear everything and show resumed/incomplete qualifier; historical restore/catch-up creates zero visibility calls; no backfill.
   - Run `make format`, `make check`, then `make test`, both-host integration command, authorized calibration, `npm pack --dry-run`, manual TUI trace, then independent review. Reviewer finding requires main-owned regression before fix.

## Reproducible traces

| Trace                                                                                                  | Required result                                                                                                                                                                   |
|--------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Owner advisory run: umbrella feature + specification/review/host-test reports; semantic gate unchanged | Left/count unchanged; timely `Agent says`; task-bound `Agent reported` history; no D0/H0 rows.                                                                                    |
| Tool-only read/edit/test with sensitive path/args/output                                               | Generic unattributed current; zero new tool provider calls; no tool-only task history; coverage qualifier explicit. Existing activity-focus payload/accounting remains unchanged. |
| Candidate A mentions task A, candidate B task B                                                        | Fixed-candidate Stage 2 cannot cross-pair; ambiguous binding abstains.                                                                                                            |
| 503, low confidence, >12 candidates, >24 KiB, queue 5, call 65                                         | No stale ownership; zero-call overflow; explicit gap/budget state; semantic/advisory unchanged.                                                                                   |
| Selected task differs; user scrolled on action ID; new action arrives                                  | Other-task wording; no task-local leak; same action remains anchored.                                                                                                             |
| OFF→ON, reload, tree, amendment, historical catch-up                                                   | Empty new lifetime, resumed/incomplete qualifier, zero historical calls/backfill, old replies fenced.                                                                             |

## Files to Modify

- `src/index.ts`, `src/core/monitor.ts` — live ingress, local finite phases, scheduling, isolation. Reuse `src/analysis/activity-focus.ts` helpers; preserve its inference behavior and payload contract.
- `src/core/board-projection.ts`, `src/ui/widget.ts`, `src/ui/board.ts`, `src/ui/controller.ts` — copied projection, Summary/current/history, ID anchoring.
- Relevant activity/host/UI/lifecycle/advisory-regression tests — main-owned gates and regressions.
- `docs/design/hybrid-presentation.md`, `docs/design/ux-acceptance.md`, `README.md` — accepted behavior, privacy, bounds, manual limits.

Explicitly unchanged: `src/core/hybrid-state.ts`, `src/core/hybrid-checkpoint.ts`, semantic reducers/gate/extractor/completion, Beads, task arithmetic, existing semantic/advisory telemetry, checkpoint version/schema, and advisory authority/delivery.

## New Files

- `src/analysis/activity-label.ts` — lossless candidates and two-stage typed requests.
- `src/core/execution-visibility.ts` — runtime-only bounded lifetime reducer/store.
- Focused unit, dual-host, frozen trace, and live-calibration fixtures.

## Dependencies

Re-anchor precedes 0A/0B. Gate 0C depends on deterministic 0B. Slice 1 depends on 0A–0C passing. Slice 2 depends on Slice 1 projection. Slice 3 depends on all prior slices. Main commits failing tests before each delegated source slice; paid calibration and independent review remain main-owned.

## Review resolutions

Two independent review passes identified grounding, latency, isolation, scope, and evaluation issues. Parent incorporated these concrete corrections:

- Runtime-only history removes checkpoint/replay complexity; canonical confirmation fences provisional text.
- Fixed-candidate binding prevents cross-pairing; tool phase alone never authorizes task history.
- Existing activity-focus disclosure/accounting remains explicit and unchanged.
- Calibration budget covers the full 32-case matrix (at most 64 calls), including latency acceptance.
- Pure helper implementation precedes calibration; long-run budget fitness requires owner acceptance before integration.

These are design provisions, not claims of empirical validation. Future implementation remains gated below.

## Risks

- Post-advisory event/admission seams require re-anchor; current `AnalysisScheduler` remains presumed inactive until proven otherwise.
- Two-stage semantic quality is unproven until Gate 0C; current live policy evidence cannot substitute.
- Assistant-visible prose transfer has residual sensitivity risk despite tool-payload minimization.
- A 64-call/48-action lifetime may be too small or costly; manual and recorded usage decide later tuning, never silent expansion.
- Runtime-only history intentionally disappears at lifecycle boundaries. Qualifier is product behavior, not defect hidden by reconstruction.
