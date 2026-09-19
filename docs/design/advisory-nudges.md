# Immediate advisory nudges — revised implementation plan

Status: PLAN ONLY; revision 2 independently reviewed PASS (no blocking issues). No implementation or new feature Beads are authorized by this document. Implementation requires separate owner authorization; delivery also requires the explicit prerequisite decisions below.

Baseline: accepted runtime `e4dcfe08`, published closure `0102cde4`, jj change `klvwuymrspvmxsrnwlkzouxvwmzqtvws`. UX planner has been notified and owns its workspace/rebase/approved UI work. Reconfirm the runtime and coordinate shared files before implementation; do not overwrite later UX work.

## 1. Product contract

- Deliver a fresh advisory immediately once discovered and assessed. No 15-second cadence, delivery cooldown, candidate TTL, idle polling, or delayed batch of discovered advice.
- The sole intentional nudge delay is unfinished-work reconciliation: a hard-coded `60_000` ms after the main agent settles. Cancel if the agent starts again. Network transport/backoff is not a delivery cadence.
- Advice may ask the agent to reconsider an unnecessary additional failing test or premature review. It never blocks tools, edits code/tests, changes task status, cancels reviews, or overrides explicit user/repository requirements.
- Reconciliation asks for truthful status, not more implementation and not a forced 100% display. Blocked/waiting/no-longer-needed are valid explanations, judged by the existing task pipeline rather than directly applied by advisory code.
- Default ON is the product direction after each capability's safety gates. Provide durable advisory OFF and immediate master-OFF cancellation. Unavailable review advice must not prevent safe reconciliation from shipping.
- Bounded paid Jev evaluation is already authorized by the user. Record frozen inputs, model, attempts, tokens and failures; do not request redundant permission. This plan itself runs no paid calls. Other paid model use is not blanket-authorized.

## 2. Verified seams and limits

| Area | Current evidence | Planning consequence |
|---|---|---|
| Run settlement | `src/index.ts` uses `agent_settled`; Pi docs distinguish it from `agent_end`, which may precede retries/queued continuation | Use settled, not end, as timer origin; prove supported hosts with real-host/faux-provider fixtures |
| Handler order | Current settled handler publishes `Idle` before `observe(ctx)` | Observe the final canonical branch before exposing advisory readiness; activity text is never a settlement signal |
| Board | Monitor owns tasks, pending journals, canonical scans, queues, retry/control state | Add a tiny copied semantic-settlement projection, not another progress state machine |
| Capacity | `hybrid.ts`: 200 total tasks, 20 included; gateway separately caps 20 questions | Project EVERY included unfinished row; never truncate ledger to question count |
| Policy/health | `health.ts` already asks typed `redApplicability`, grounded only in supplied policy | Investigate reuse of fresh typed results; a display label or stale health result is not permission to discourage a test |
| Tool attribution | `Monitor.evidenceLink()` currently returns undefined | Never attach tool activity to focused task automatically |
| Scheduling | Existing `AnalysisScheduler` has bounded coalescing/one-flight/retry; gateway owns auth/backoff | Inspect and extend these seams only if necessary; no new provider framework for Phase A |
| Delivery | `sendMessage` supports custom messages/steer/triggerTurn; API is fire-and-forget | Send-requested is not delivered, read, followed, or acknowledged |
| Queue limits | `isIdle`/`hasPendingMessages` exist; public atomic enqueue/retraction does not | Check before invocation; explicitly disclose irreversible boundary afterward; tests characterize races, not universal cancellation |
| Canonical intake | Ordinary user/assistant plus exact intercom custom type are admitted | Advisory custom/state types remain excluded; assistant echoes require a separate provenance gate |
| Persistence | Progress is strict v6; Pi custom entries advance leaf IDs | Separate bounded advisory receipt/preference schema; never use raw leaf equality as semantic branch identity |

Pinned Pi 0.84.2 and installed 0.85.1 are the initial host matrix. Verify versions again before coding. Public host contracts and measured fixtures are evidence; private queue manipulation is prohibited.

## 3. Smallest useful architecture

Start with only three new production modules, splitting later only when responsibilities actually grow:

1. `src/advisory/controller.ts`: ephemeral run intent, one timer, event-driven board updates, mode and cancellation.
2. `src/advisory/state.ts`: strict preferences/receipts, bounded fingerprints, persistence validation and copies.
3. `src/advisory/delivery.ts`: fixed templates, pre-send checks, reservation, custom-message construction and provenance correlation.

Minimal existing seams:
- `src/core/monitor.ts`: copied settlement/board projection and a publication hook already used for view updates.
- `src/index.ts`: lifecycle wiring, final-observation ordering, separate state restore, delivery and command integration.
- `src/ui/commands.ts`: `/progress advisory status|on|off`; keep the always-visible widget unchanged.
- `src/sources/messages.ts` and semantic evidence consumers: only the explicitly tested advisory-origin/echo boundary described below. Do not rewrite ordinary canonical intake.

No new gateway, review adapter, policy engine, debugger UI, or full task-board architecture is needed to deliver deterministic reconciliation. No Jev call is needed for it.

### Copied board seam

Return opaque semantic session/branch/cycle identity, semantic epoch, `settled|processing|waiting|unsafe` with reason, and every included task's ID, revision, status and bounded label. A snapshot read must not read history, persist, dispatch or start timers.

`settled` excludes known work that can alter task truth: control restore/enable, canonical scan/wake, catch-up, active/queued semantic observation, retry/model wait, pending journal, unresolved scope, capacity failure or source mismatch. Health-only/Beads work does not block task settlement because it cannot change the ledger.

Use an accepted UX/monitor cycle identity if available. Otherwise define only the small opaque lifecycle token needed here in coordination with its owner; advisory must not implement or wait for the entire board redesign. No elapsed-time cycle inference.

## 4. End-run controller: deadline survives ordinary settlement

[tag:advisory_run_deadline] The run's deadline is `authoritative agent_settled time + 60_000`. Processing final assistant evidence must not erase that intent or restart its minute.

Sequence:
1. At a genuine main-run `agent_settled`, capture the current external session/semantic branch/cycle and run generation. Observe the final canonical branch FIRST. Ignore duplicate events and settlements attributable solely to an advisory-origin follow-up.
2. If controls are OFF, the run was deliberately stopped, another prompt is pending, or host identity is unsafe, create no intent.
3. Store one in-memory intent containing identity and deadline. If board processing/waiting is outstanding, await real monitor publication; no polling or persisted timer.
4. Normal monitor-owned task additions, revisions, status changes and internal semantic epoch changes REFRESH the candidate board. They do not cancel the run intent. This includes final evidence creating previously unknown tasks.
5. Once a fresh board is settled, inspect all included unfinished rows. If empty, suppress and clear intent. Otherwise arm one timeout for `max(0, deadline-now)`. If the deadline passed, use the settlement event to attempt delivery immediately, without another minute.
6. At timeout, if the board is processing again, retain the deadline and wait for a real settlement event. If settled, take a NEW snapshot; do not rely on the earlier rows. Terminal unsafe/unresolved scope suppresses this opportunity; recoverable waiting remains event-driven until cancellation or safe settlement.
7. Run final delivery checks and stable dedupe against that fresh snapshot. Recheck after any asynchronous boundary. Build and reserve only for the final complete set; no arbitrary omitted rows.

Cancel intent/timer on new user input or run start, master/advisory OFF, shutdown/reload/process restart, session replacement/tree navigation, external semantic-cycle replacement, or proven deliberate abort. Cancellation must run in `before_agent_start` and `agent_start`; also use the earliest proven input event for queued user input. Do not cancel for extension-owned saves or ordinary processing of this same run's final evidence.

Timers/intents are never checkpointed or restored. Restart with an armed timer produces no catch-up wake. A later genuine agent run can form a new intent.

### Abort proof

`AgentSettledEvent` has no abort reason. The host spike must identify a supported signal or exact aborted assistant stop reason usable locally. If ordinary completion cannot be distinguished from explicit stop on a host, automatic reconciliation on that host remains unavailable. No heuristic based on text, duration or lack of output.

## 5. Separate freshness, dedupe and receipt identity

[tag:advisory_identity_separation]

**Transient freshness token:** session generation, semantic branch/cycle, current run/controller/policy generations, and exact final board revision snapshot. Used to reject stale assessments/enqueues. It is not a dedupe key.

**Stable reconciliation key:** advisory kind + session/semantic branch/cycle + sorted unfinished task IDs/revisions/statuses. Do NOT include run count, timestamp, raw leaf ID, policy generation, controller restart counter or receipt sequence. Unchanged blocked work stays deduplicated across new runs and reload.

**Proactive key:** kind + exact source-bound task/batch revision + grounded checkpoint/opportunity identity. Policy changes invalidate a result but do not automatically make previously delivered advice a new opportunity.

Derive branch identity from explicit navigation/session events and canonical semantic ancestry, ignoring extension custom/state entries. Appending progress state, advisory reservation, or delivery receipt cannot change semantic branch identity. Ordinary append within the same run is distinct from tree navigation. A return to a previously visited branch restores that branch's receipts.

Mark the agent run attributable to the advisory custom message, using its exact ID/details and measured host ordering. Its own settlement cannot re-arm identical reconciliation. Mixed user/advisory runs must give user input priority and use the stable board key, not guessed origin text.

Reserve at-most-once receipt durably before `sendMessage`. If reservation fails, do not send. Crash after reservation can lose advice; do not retry an uncertain send and risk repeated nudging. This is a deliberate at-most-once trade, not guaranteed delivery.

## 6. Delivery and the host boundary

Use visibly prefixed extension custom messages of type `pi-progress-advisory`, never user-role messages. Reconciliation includes each unfinished task ID and bounded label plus a fixed instruction:

> Status reconciliation only: explain which listed items are complete, pending, blocked, or no longer required, and any tracking mismatch. Do not start or continue work because of this message, and do not claim completion merely to clear the display.

Immediately before reservation/enqueue check effective controls, external identity, fresh settled board, idle host, no pending messages, unchanged final rows and absent stable receipt. No await between final synchronous check and send invocation unless the check is repeated afterward. Receipt append must not invalidate semantic identity.

### Irreversible boundary — explicit product decision, not an imagined API guarantee

Before `sendMessage` invocation: guarantee that known OFF/start/navigation cancels and no stale local work is enqueued.
After invocation: the host may already have accepted a message. Public APIs do not provide retraction or an atomic check-and-enqueue primitive. OFF can prevent NEW invocations but cannot promise removal of a queued/in-flight one. Finite host tests characterize ordering; they do not prove an always-wins user race.

**Decision required before enabling affected delivery:** accept this narrowly documented queue boundary, or keep that capability disabled. Any host API enhancement is separate work requiring explicit authorization; it is not silently included here. Proactive active-run steer and idle triggering delivery get separate host gates. A failed idle gate need not disable a proven active-run capability.

TUI uses an explicit extension renderer. Print/RPC must retain `display:true` plus a plain-text extension prefix and structured custom type/details; test those modes rather than assuming the TUI renderer runs there.

Receipt states: reserved, send-requested, present-in-branch, response-observed, suppressed(reason). Do not report read/acknowledged/complied without additional evidence. Delivery itself cannot affect task completion.

## 7. Echo/provenance gate: do not confuse the nudge with evidence

Custom advisory entries and preference/receipt entries stay outside canonical task-source intake. That alone does not handle assistant copies.

Phase A therefore includes a bounded provenance spike BEFORE enabling real delivery:
- Correlate the exact custom advisory entry with its host-attributed response run, branch and canonical assistant entry IDs; do not taint unrelated future assistant messages by string similarity alone.
- Maintain exact generated-message hashes and exact generated task-row/template span hashes, derived from the actual sent content. No keyword inference or fuzzy matching.
- An exact full-message echo from the correlated response is ineligible as NEW scope/completion/opportunity evidence. It must not create another advisory opportunity.
- Partial copied advisory spans are marked as advisory-origin evidence, retaining the original message and original offsets/hashes. Do not strip/rewrite canonical text, reinterpret roles, truncate authoritative sources or silently invalidate existing journals.
- A genuine new status explanation outside the copied spans remains eligible for the normal judgments. Copied task labels alone do not establish completion or new work.

**Bounded implementation decision:** current completion judgments use whole-observation references, so partial-span provenance is not already enforced. The spike must demonstrate an explicit evidence-consumer contract (e.g. validated source spans plus advisory-origin exclusions) that rejects advice-only support while accepting independent status claims. If that requires modifying request/proof/checkpoint shape, return a separately scoped, test-first contract proposal; do not opportunistically modify strict v6, add compatibility paths, or claim provenance is solved by a prompt sentence. No implementation may proceed under an undefined taint flag.

Deliverable from this spike: exact types/entry IDs/span binding, replay/no-rebill implications, and deterministic full-echo/partial-echo/independent-status tests. If the separation cannot be safely demonstrated, delivery remains off; shadow reconciliation still runs. This is an explicit prerequisite, not a claim of universal natural-language plagiarism detection.

## 8. Persistence, bounds and privacy

Separate `pi-progress-advisory-state` custom-entry schema v1 for preference and derived receipts. Strict version/field/enum/number/byte validation; no progress-v6 field additions or migrations. Unknown/corrupt state fails effective OFF without automatic overwrite. Explicit ON may start new current-version state only after warning about lost dedupe history; the current unchanged board is suppressed until a genuinely new opportunity, rather than immediately resent.

Persist no timer, pending assessment, raw tool arguments/output, credentials, raw policy files or conversation transcript. Receipts contain hashes, bounded IDs/kinds/states and safe counters/timestamps. Host transcript already stores the explicitly delivered custom message; disclose this rather than promising advice content is never stored.

Project every included row. Assert the actual included-task invariant (currently20); if violated or the exact rendered all-row message exceeds a tested byte limit, suppress with a reason. Never slice to20 or omit tasks while claiming to reconcile all work. Test200 total/20included, excluded unfinished rows, reopened tasks and worst-case Unicode.

Set receipt count/byte limits from worst-case serialized schema proof during implementation planning, not arbitrary reserves. On exhaustion suppress further delivery without evicting receipts that protect current-cycle dedupe. Explicit preference OFF must remain representable at the boundary. Reuse the accepted capacity discipline, not sampled maxima.

Privacy promise is precise: no raw tool output/commands/write contents/absolute paths or credentials deliberately collected for advisory inference. Task labels and bounded approved source/policy excerpts CAN contain sensitive user content and, if included, are sent to TypeSafe just as existing progress excerpts are. Do not promise universal secret detection. Document exact fields, allow local-only controls/abstention, test known secret sentinels in excluded fields, and never persist provider envelopes.

## 9. Later capability: immediate unnecessary-new-test advice

Do not add a duplicate inference pipeline before examining existing `healthSnapshot`/`redApplicability` results and scheduler.

A reusable result must retain typed choice, confidence, exact task revision, evidence refs, policy provenance and freshness. Existing display `not-needed` is not sufficient; explicit required red tests always veto contrary advice. Health presence must never delay Phase A.

Supported authority must be explicit: structured local requirements where available, plus bounded user/repository excerpts whose semantic classification may use Jev under existing authorization. Hashes establish identity, not meaning. Unknown, conflicting or unavailable relevant authority yields abstention. A later extension/provider rewrite outside the supported authority surface is an explicitly unsupported configuration, not a proof of universal policy completeness.

Open opportunities from real task/checkpoint or verified coverage events, not a 15-second poll. Focus, tool name, elapsed time, issue count and model-selected target alone never establish tool ownership. Binding requires exact canonical task-source refs and a structured task/checkpoint association; if absent, abstain rather than borrowing `evidenceLink()` which currently returns undefined.

Observe tools without awaiting assessment or blocking/mutating them. A new-test write already admitted closes any prevention opportunity as missed; do not advise stopping that already finished action. Unsupported shell/custom-tool paths are measured misses, not guessed by command regex.

Ask typed `needed|not-needed|unknown` only for the additional NEW failing regression; never suggest skipping existing tests or validation. Fresh accepted advice is sent immediately at the supported context boundary, with no additional timer/cooldown. Recheck policy, identity and action-not-started after each async boundary.

### Provider scheduling only if reuse is insufficient

Audit actual Monitor calls and `AnalysisScheduler` first; direct transaction calls may bypass scheduler, so merely adding a second gateway is unsafe. Share auth/backoff/Retry-After and one local transport lease if a new lane is required. Use one precise algorithm: FIFO within each bounded lane, alternate nonempty progress/advisory lanes when both are waiting; serve the sole nonempty lane otherwise. No preemption or invented reserved capacity. Lane-local schema errors must not disable progress; verified auth failure is shared. All paths must participate in the lease or the purported global one-flight guarantee is false.

This refactor is conditional Phase B work, independently reviewed and regression-tested against accepted progress barriers; it does not block deterministic reconciliation.

## 10. Later capability: immediate premature-review advice

One proven structured adapter only. Inspect actual main-session delegation tool schemas; no shell/TUI parsing, child-transcript mining or name-containing-review heuristics.

Bind to an explicit canonical batch/checkpoint/release requirement. A model may judge readiness but may not invent ownership or a milestone. Explicit review request, security/audit/risk, or genuine blocker always overrides deferral.

Proactive assessment can precede a launch. If review already starts before the result, suppress as missed, never cancel the review or pretend it was prevented. Send once per stable task/batch/checkpoint key, immediately when fresh. Missing adapter disables REVIEW ONLY, not reconciliation or test advice.

## 11. Dependency-ordered delivery slices

Main owns tests; workers receive scoped production changes only. No implementation before owner approval of this plan and a dependency-ordered backlog. Each behavior change starts with a real failing test; pure host characterization may be an evidence spike rather than a manufactured red.

| Slice | Scope/files | Main proof before/with implementation | Exit |
|---|---|---|---|
| A0 host/provenance decision packet | New real-host advisory fixture, docs/artifacts only | Settled vs retry/compaction; abort; user-at-deadline order; queued OFF/tree; restart; correlated full/partial echo; TUI/print/RPC | Explicit supported behavior, queue-boundary owner decision, exact echo contract or delivery blocked |
| A1 copied settlement seam | monitor.ts, index.ts; reuse UX small seam | Observe-before-ready, active/pending/retry/scans/unresolved vs health-only, immutable full included rows | No added history reads, task truth unchanged |
| A2 pure controller/state | advisory/controller.ts + state.ts | Deadline retained through task updates; one timer; restart discards intent; stable receipts/own append; exact capacity/OFF proof | Shadow end-to-end useful and provider-free |
| A3 controls/delivery | advisory/delivery.ts, index.ts, commands.ts, approved provenance seam | Freshness, reservation failure/crash, own custom exclusion, echo contract, idle race limits, branch return | Opt-in reconciliation only on supported/proven hosts |
| A4 reconciliation acceptance | Docs plus isolated default change | Full regression, dual-host, independent review, manual opt-in smoke | DefaultON for genuinely new sessions if A gates and owner boundary decision pass; no dependency on B/C/debugger |
| B0 reuse/authority spike | health.ts, scheduler.ts, gateway.ts inspection and tests | Typed health result freshness; exact policy/ownership surface; gateway bypass inventory | Choose reuse or minimal shared-lane change with explicit scopes |
| B1 shadow test advice | Small advisory policy/opportunity/assessment modules only as needed | Required tests veto, unknown abstain, exact source binding, privacy, stale/started-action suppression | No delivery; finite bounded Jev corpus with failures retained |
| B2 test advice acceptance | Proven delivery path and conditional provider seam | Active/idle boundaries, fair lanes if introduced, no added cadence, provenance/no selfloop | Independent opt-in/default capability gate |
| C review adapter/advice | One adapter plus typed readiness | Explicit review/risk veto, exact checkpoint, launched-action miss, unsupported adapter abstention | Independent opt-in/default capability gate; failure does not roll back A/B |
| D optional debugger integration | Copied safe snapshot only | Reads do not alter timers/history/provider/state | Optional; never blocks A/B/C defaults |

New modules are justified by completed slices, not created as empty scaffolding. Keep host/provenance prerequisites explicit; do not call a shadow-only branch a shipped nudge feature.

## 12. Acceptance matrix

- **Clock:** settled at t0; final evidence settles before60s → send at60s; settles after60s → send on that settlement; task mutations during catch-up neither lose intent nor restart minute.
- **Cancellation:** new user/run, OFF, shutdown/reload/restart, navigation/cycle change, deliberate abort; no restored timer and no idle scanning. Include late callbacks after disposal.
- **Fresh board:** no tasks/all done/excluded-only → no message; included reopened/blocked → honest status request; invariant violation/oversize → explicit suppression, no truncation.
- **Identity:** progress saves/reservation/delivery entries do not invalidate; new run with identical board does not redeliver; task revision/checkpoint or actual cycle can create a new opportunity; return to branch restores its receipts.
- **Origin:** full and partial correlated echoes cannot supply new task/completion authority alone; genuine independent status claims remain eligible; no advisory-origin recursion.
- **Delivery:** explicit extension custom provenance in TUI/print/RPC; no user message; pre-invocation freshness holds; post-invocation inability to retract documented and accepted or disabled.
- **Policy:** explicit tests/review/security/blocker requirements veto; ambiguous/unsupported policy or task binding abstains. No universal unseen-policy guarantee.
- **Provider:** zero Jev for A; B/C no duplicate gateways or backoff bypass; exact async owner/freshness checks; fair finite queues where required, no polling/cadence.
- **Privacy:** excluded tool/credential fields never leave process or appear in receipts/debug; included excerpt disclosure accurate; no impossible universal secret-free claim.
- **Durability:** strict versions, byte/number bounds, reserve-before-send, restart dedupe, invalid-state OFF, representable OFF at capacity, no migrations.
- **Passivity:** rendering/status/debug never observes history, dispatches, persists or starts timers; advisory cannot mutate task truth directly.

Implementation gates: `make format`, `make check`, `make test`, package dry-run; actual pinned/global Pi integration fixtures with faux provider. Main runs format only with exclusive writer ownership. Bounded live Jev semantics use already-authorized calls, frozen corpus/model/thresholds and retained failures; other paid providers need separate authority. Finite semantic results are evidence, not a zero-error guarantee.

## 13. Rollout and decisions still open

Roll out EACH capability as OFF → explicit shadow/opt-in → reviewed/manual-smoke → defaultON for truly new sessions. Existing sessions without advisory state stay OFF, with no legacy migration. Explicit OFF persists. Missing optional capability does not prevent another passing its gate.

Only two product/scope decisions are genuinely blocking delivery, not drafting this plan:
1. Accept documented post-send queue irreversibility, or keep affected delivery disabled. No silent host API project.
2. If partial-echo evidence separation requires changing semantic proof/request/checkpoint contracts, approve that narrow prerequisite after A0 provides exact design/tests, or keep delivery shadow-only. Do not force it through as a receipt-only change.

Technical spikes (abort event, supported policy surface, exact review adapter, provenance binding, shared scheduler inventory) should return bounded pass/fail evidence and concrete interfaces, not ask the owner to solve implementation details. Unsupported hosts/adapters remain visibly unavailable.

UX coordination is limited to copied board/cycle identity and command/debug composition. It does not authorize this lane to modify UX plans, manage its rebase or redefine task cycles. Subsequent implementation must rebase conceptually on accepted UX/runtime state and re-run source-grounding first.

## 14. Review disposition

Revision2 corrects all first-review categories: existing Jev permission; settlement clock/cancellation; stable dedupe versus transient freshness; own-append identity; explicit echo prerequisite; honest host boundary; actual included-task invariant; independent minimal rollout; supported policy authority; explicit tool binding; accurate privacy disclosure; reuse/precise fairness; abort/restart/multi-mode host coverage.

This is a detailed plan with gated technical prerequisites, not a runtime delivery guarantee or authorization to start coding.
