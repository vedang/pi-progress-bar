# Advisory nudges — canonical revision 3

**Status:** A reconciliation is locally accepted (`839dea0a`), including finite delivery retries and master-control wiring. B/C corrective runtime is implemented; full independent review and final capability acceptance remain in progress. Human manual acceptance remains pending. Existing health rubric and corrective classification have separate bounded live calibration evidence. This revision replaces revision 2; owner decisions and Beads govern remaining scope. No release/install/publish/push is authorized.

**Scope:** three incrementally accepted capabilities, in order: **A reconciliation**, **B test correction**, **C review correction**. No release, install, publish, push, branch, UI redesign, debugger work, Beads mutation, migration, or new user-facing control belongs here.

## 1. Fixed product boundaries

- The existing `/progress on|off` monitor control is sole user-facing master control. Master ON enables every accepted advisory capability; master OFF disables progress and advisory behavior. No advisory ON/OFF command, preference, capability switch, session opt-in, legacy rollout state, or other user-facing advisory configuration may be added.
- Advisory is advisory only. It never edits code or tests, changes task status directly, blocks tools, cancels a review, controls a child, or overrides explicit user/repository requirements.
- Preserve strict progress checkpoint **v8**. No v8 field change or migration is authorized. A conditional evidence/provider change needs its named gate and explicit owner approval; it is not implied by this design.
- Every capability is locally accepted under master ON or remains unavailable. An unavailable later capability never disables an earlier accepted one. Local acceptance is not release authorization.
- Main owns all new/changed deterministic tests and paid Jev work. Characterization may add evidence only. Planning artifacts remain untracked.

`docs/design/ux-acceptance.md` records strict-v8 UX baseline and pending owner manual acceptance; it is not advisory host or capability proof.

## 2. Source basis and known limits

The table records the pre-implementation source basis; current implementation details follow in section 11.

| Initial source fact | Design consequence |
| --- | --- |
| `src/index.ts` restores on session start/tree, stops monitor on shutdown, sends `agent_settled` through `monitor.observe`, and observes canonical state on `context` and `turn_end`. | Advisory lifecycle wiring attaches to those proven local seams only after H0. A response must enter this existing monitor pipeline; advisory never writes board truth. |
| `src/core/monitor.ts` owns enablement, canonical reads, semantic work, semantic-provider retries, ledger state, and detached snapshots. Board projection internally consumes unsettled state for focus; `boardSnapshot()` does not expose advisory readiness, and no advisory settlement projection exists. | A2 adds only a copied semantic-settlement projection. Monitor owns readiness/reason authority, not advisory formatting, advisory timers, advisory provider admission, delivery correlation, or advisory-delivery retries. |
| `src/core/hybrid-checkpoint.ts` validates only version 8; `src/core/hybrid.ts` enforces up to 200 total and 20 included tasks. | Preserve v8. All **included** rows participate; never silently slice a board. Existing numeric caps do not authorize new advisory constants. |
| `src/sources/messages.ts` admits user, assistant, and exact `intercom_message` observations, excludes other custom entries, and excludes aborted/error assistant messages. | A custom advisory itself is not canonical task input, but an assistant echo can be. Owner S0 decision retains existing semantic input unchanged; no echo projection/filter is required. |
| `src/analysis/health.ts` asks existing `redApplicability`; `src/core/monitor.ts` currently reduces it to display health, while `Monitor.evidenceLink()` returns `undefined`. | Q2 authorizes rubric alignment only after BR1 tests/corpus. B0 must prove a fresh typed fact, action-start event, task binding, authority, and transport surface; focus/display labels cannot supply them. |
| `src/core/monitor.ts` constructs four direct Jev gateways; `src/analysis/scheduler.ts` provides separate bounded one-flight/coalescing behavior. | B0 inventories real paths first. T1/T2 exist only if proven reuse is insufficient; no new bypass or claimed global one-flight without all participating paths. |
| `src/analysis/gateway.ts` enforces real 24-KiB/20-question Jev request limits. | B/C pass full included-board bounded inputs once, or abstain before dispatch. They never truncate rows or call once per task. |

### Pi host API sources

The installed Pi extension documentation says `agent_settled` is the lifecycle point after retry, compaction retry, and queued continuations; `sendMessage` injects a custom message and can trigger an idle turn; and mode behavior differs across TUI, print, JSON, and RPC. See `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (§§ agent events, `pi.sendMessage`, mode behavior) and `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`. Those documented APIs are not host-matrix proof for this feature. H0 must characterize pinned Pi 0.84.2 and `PROGRESS_PI_HOST_ROOT` Pi 0.85.1 before any affected delivery is enabled.

## 3. Shared authority, safety, and data rules

### Authority and response processing

1. Monitor is sole task-board and semantic-settlement authority. Advisory receives copied, detached facts; it does not read history, persist, dispatch providers, start timers, or mutate task truth from a projection.
2. Reconciliation asks for actual task status, not more implementation. A truthful complete/pending/blocked/no-longer-required answer may be processed by existing extraction/Jev/completion paths and update the board where those paths support it, under unchanged accepted completion/extraction thresholds. Never relax thresholds merely to clear the board. A blocked answer need not change board state.
3. Owner S0 decision: rely on existing Jev interpretation to distinguish a question from evidence of work. Keep existing conversation intake, context bounds, semantic requests, grounding, thresholds, and replay unchanged. Do not add echo filtering, masking, span projection, or a provenance framework. H1 characterization demonstrated structural acceptance with adversarial provider fixtures, not a live Jev failure. S1/S2 are not needed by owner decision, not because deterministic copy rejection was proven. Delivery correlation remains necessary only for retry control and preventing advisory-only runs from recursively rearming.
4. Deterministic reconciliation triggering uses zero Jev. This does not bypass ordinary response processing and does not assert that a response requires zero Jev.
5. Explicit user/repository test requirements veto test advice. Explicit review requirements, security/audit/risk, genuine blocker, and other proven protected review conditions veto review deferral. Unknown authority, binding, readiness, or attempt classification abstains.

### Bounded inputs and privacy

- A semantic B/C request receives whole included board plus bounded relevant policy/conversation/activity and prior-attempt context. It may independently bind an activity to each supported task; it must not assign an activity to every row, use focus/name/shell heuristics, mine child transcripts, copy wholesale tool outputs/file contents/shell commands, or emit per-task calls. Dispatch fresh accepted advice immediately without delayed batch cadence.
- Complete input must fit real gateway limits or abstain before dispatch. B1/B2 independently prove worst-case 20-row bounds and unknown/oversize abstention before B acceptance; oversized complete requests produce zero provider calls and zero nudge. C1/C2 exercise all 20 included rows, worst-case bounded labels/Unicode, task/batch/checkpoint metadata, policy, and previous-attempt context. No arbitrary row truncation.
- Persist no advisory timer/retry queue across reload/restart. Store no raw tool output, shell commands, file contents, child transcripts, credentials, or provider envelopes for advisory inference. Any later durable data must have a separately proven strict bounded contract without v8 changes.

### Delivery boundary and retry policy

- Before `sendMessage` invocation, known master OFF, start/input, navigation/session replacement, stale opportunity, irrelevance, or unsafe host state cancels. After invocation, no retraction is promised. No private queue API or silent host rewrite is allowed.
- In one live supported session, uncertain/failed delivery gets a finite R0-defined retry policy. Recheck master/session/current opportunity/relevance before each retry. Positive delivery or response evidence stops retries; unchanged board is not delivery failure. Occasional duplicates are acceptable; at-least-once attempt policy is not guaranteed delivery.
- Reload/restart abandons old timer and retry work. It never restores a retry queue. A later independent run or genuinely new correction attempt may form a new opportunity.
- H0 measures exact event/branch/custom-entry order and usable provenance across TUI-compatible, print, JSON, and RPC surfaces. It also establishes whether any visible 0.85.1 RPC `clear_queue` surface is **not** ExtensionAPI authority. Until that evidence exists, no host delivery claim is made.

## 4. Capability A — reconciliation

### Contract

1. At an authoritative independent main-agent `agent_settled`, observe final canonical state before advisory readiness. The deadline is that settlement time plus **60,000 ms**.
2. If board readiness arrives at +20 seconds, delivery is eligible at +60 seconds. If readiness arrives at +80 seconds, delivery is eligible then. Same-run semantic work refreshes copied rows but neither cancels nor restarts deadline. Never send while task analysis is unfinished.
3. A fresh settled board with included unfinished rows creates one delivery request for that independent run opportunity. An unchanged pending board can be nudged again on a later independent run. Deterministic duplicate event protection applies inside opportunity handling; there is no cross-run stable-board dedupe.
4. A run solely answering advisory does not rearm reconciliation. In a mixed run, genuine external/user input wins. New external input or new main-run start cancels an old opportunity.
5. At final eligibility, use a fresh copied board. No included unfinished rows, unsafe/unresolved authority, incomplete analysis, or formatter-owned full-message bound failure suppresses delivery. Do not omit rows to force a message.
6. The status response returns through existing canonical observation and task pipeline; advisory emits no direct status change and no forced completion.

### Ownership split

| Owner | Required responsibility | Forbidden responsibility |
| --- | --- | --- |
| **Monitor / A2** | Pure copied semantic-settlement snapshot, every included row, finite reason codes/invariants. | Timers, host reads, provider/history reads, persistence, task mutation, rendered-message bytes. |
| **Controller / A3-A4** | One in-memory run intent, 60-second deadline, event-driven snapshot refresh, cancellation, whole-board fixed message formatting and exact message byte bound; emit one delivery request per opportunity. | Host API calls, persistence, polling/cadence, cross-run board key, delivery retries/correlation. |
| **Delivery / R0, A5-A6** | H0-proven custom `sendMessage` invocation, final lifecycle checks, correlation/origin handling, bounded live retries and their cancellation. | Task mutation, new user control, queue manipulation/retraction guarantee, restoring old retries. |

A3 freezes the exact reconciliation template and deterministic controller cases before A4; this design intentionally does not invent new reconciliation text.

### A delivery gates

- **H0** proves source event/order/host surface. **H1** proves response evidence contract. **R0** freezes finite live retry/reload behavior from H0 measurements. **S0** records the owner decision to retain existing Jev processing; **S1/S2** are not needed.
- A5 adds main-owned delivery, retry, index integration, response-pipeline, blocked-status, master-OFF, reload, and four-surface tests against H0/H1/R0 evidence.
- A6 implements only tested delivery/lifecycle wiring without an additional evidence seam. It exposes no advisory control and preserves v8.
- A7 requires deterministic regressions, package dry-run, relevant dual-host checks, manual TUI/print/RPC smoke marked pending or recorded truthfully, and independent review. A may ship under master ON while B/C remain absent; it still has no release authority.

## 5. Capability B — test correction

### Contract

- Reuse a **fresh existing** typed Jev `redApplicability: not-needed` fact. No second necessity assessment is introduced. BR1 freezes deterministic request/rubric tests and semantic corpus and main runs bounded live Jev calibration against the existing rubric. BR2 aligns existing rubric with long-term regression value without changing accepted thresholds, unrelated health behavior, v8, or policy vetoes; main then verifies the retained corpus with bounded paid Jev, retaining failures. Rubric calibration is separate from B1 task/attempt-classifier evaluation.
- Trigger on a proven builtin `write`/`edit` **attempted** `tool_execution_start`, then semantically bind it to a new failing test for a supported task. Owner explicitly accepts that Pi can subsequently block execution. This is correction, not prevention: started action is not a reason to suppress the nudge. Exact registration/schema and safe relative path identify the attempted action; task, new-vs-continued attempt and authority judgments are never inferred from focus or tool/action name alone.
- Correct once per distinct test-writing attempt. Duplicate tool events and continued edits in one attempt do not repeat; a genuinely new attempt may nudge again. Exact event dedupe and freshness are deterministic; Jev may classify same/new/unknown attempt. Unknown abstains.
- Exact owner message, with `X` bound only by demonstrated task association:

  > Task X does not need a failing test, as the test will not provide any long-term value. Please directly start with the implementation instead.

- Agent decides response. Extension does not cancel, undo, block, or waive existing validation. Explicit user/repository test requirement vetoes contrary advice.

### Characterization and conditional provider work

B0 must produce explicit `supported(interface/evidence)` or `unavailable(reason)`, covering fresh health fact, write/edit/custom-tool start schemas, bounded task/attempt metadata, authority, four direct gateways, scheduler inventory, and both host surfaces. Unsupported B0 parks B1-B4/T1-T2 with exact reason; it is not a passing capability gate. Q2/BR1/BR2 remains independently owner-authorized rubric work when needed health-source evidence exists, even if test-action adapter is unavailable.

B1 performs one whole-board bounded paid Jev evaluation after supported B0, with frozen model/input hashes/attempts/tokens/failures/thresholds. T1/T2 add a shared admission seam only when B0 proves current reuse insufficient; otherwise close as not needed. B2 writes failing source contracts before B3. B3 uses proven adapter, fresh fact, authority, task/attempt binding, exact wording, and existing delivery path. B4 is local validation/host/semantic/manual/review gate; rejected B does not roll back A.

## 6. Capability C — review correction

### Contract

- C0 must prove exactly one structured registered review adapter: source info, parameter schema, post-start event, duplicate identity behavior, batch/checkpoint fields, and explicit protected authority. No shell/name heuristic, TUI parsing, or child-transcript mining.
- Trigger **after** premature review starts. Correct per distinct review attempt; duplicate events/continued work do not repeat, a genuinely new attempt can. Missing adapter, unsupported metadata, ambiguous binding, or unknown readiness abstains.
- Exact owner message:

  > Reviewing the work done so far is premature. Please cancel the review and continue with the implementation. It is better to review the work when a bigger chunk of it has been completed.

- Main agent handles any cancellation. Extension never contacts or cancels a child/review. Explicit review request, security/audit/risk, genuine blocker, or other proven requirement vetoes deferral.

C1 freezes bounded whole-board task/batch binding and premature-review corpus only after C0 has explicit supported evidence. C2 adds deterministic red contracts, including all-row gateway-boundary abstention. C3 implements only adapter/readiness/attempt assessment and delivery reuse proven by C0-C2. C4 is local full validation, active-steer host checks, bounded semantic evidence, truthful manual smoke status, and independent review. C unavailability leaves accepted A/B enabled.

## 7. Actual 30-child Beads graph

The graph below is descriptive only; this document does not modify Beads. `Main` means main-owned tests/paid semantic work. `Conditional` closes not-needed when source evidence suffices. Q1/Q2 are closed owner decisions.

| Bead | Owner/work | Depends on / outcome |
| --- | --- | --- |
| D0 `.1` | Canonical revision-3 doc and review. | This document; blocks H0. |
| Q1 `.2` | **Closed:** reload abandons old retries; live failed/uncertain sends prefer bounded retry. | Inputs R0. |
| Q2 `.3` | **Closed:** existing health rubric assesses long-term regression value; no second necessity call. | Inputs BR1. |
| H0 `.4` | Main host characterization on both Pi hosts. | D0; blocks H1, R0, A1. |
| H1 `.5` | Main advisory-origin/evidence proof spike. | H0; blocks S0 and A5. |
| R0 `.6` | Freeze finite live retry state diagram/constants from H0. | H0 + Q1; blocks A5. |
| S0 `.7` | Decide whether minimal evidence prerequisite exists. | H1; blocks conditional S1. |
| S1 `.8` | Main red tests for owner-approved prerequisite, if any. | S0; otherwise not needed. |
| S2 `.9` | Narrow approved prerequisite source change, if any. | S1; otherwise not needed; blocks A5 only when needed. |
| A1 `.10` | Main failing copied-settlement snapshot tests. | H0; blocks A2. |
| A2 `.11` | Monitor pure copied snapshot. | A1; blocks A3. |
| A3 `.12` | Main reconciliation-controller reds, including deadline/whole-message bounds. | A2; blocks A4. |
| A4 `.13` | Pure reconciliation controller/formatter. | A3; blocks A5. |
| A5 `.14` | Main delivery/retry/index/host integration reds. | A4 + H1 + R0 + conditional S2; blocks A6. |
| A6 `.15` | Reconciliation delivery and lifecycle wiring. | A5; blocks A7. |
| A7 `.16` | Reconciliation local acceptance. | A6; gates B0. |
| B0 `.17` | Main health/action/authority/transport characterization. | A7; explicit supported or unavailable outcome; gates B delivery path and BR1 source evidence. |
| BR1 `.18` | Main long-term-red rubric tests, frozen corpus, and pre-edit bounded live calibration. | B0 + Q2; rubric authority survives unavailable action adapter. |
| BR2 `.19` | Narrow existing health rubric alignment; main post-edit bounded paid retained-corpus verification, failures retained. | BR1; blocks B1. |
| T1 `.20` | Main tests for conditional provider admission seam. | B0; not needed if proven reuse suffices. |
| T2 `.21` | Conditional approved provider admission implementation. | T1; blocks B2 only when needed. |
| B1 `.22` | Main whole-board test-attempt corpus/evaluation. | BR2 + supported B0; blocks B2. |
| B2 `.23` | Main failing test-correction contracts. | B1 + conditional T2; blocks B3. |
| B3 `.24` | Narrow test correction implementation. | B2; blocks B4. |
| B4 `.25` | Test-correction local acceptance. | B3; gates C0. |
| C0 `.26` | Main one structured review-adapter characterization. | B4; explicit supported or unavailable outcome. |
| C1 `.27` | Main whole-board premature-review corpus/evaluation. | supported C0; blocks C2. |
| C2 `.28` | Main failing review-correction contracts. | C1; blocks C3. |
| C3 `.29` | Narrow review correction implementation. | C2; blocks C4. |
| C4 `.30` | Review-correction local acceptance. | C3; no release/push authority. |

## 8. Required proof and review disposition

Each accepted capability needs its named deterministic tests, relevant real-host delivery matrix, bounded Jev evidence where named, package dry-run, independent review of whole capability batch, and manual smoke recorded as pass/fail/pending rather than invented. Review findings require a main-owned failing regression before a source fix.

H0 is characterized on both hosts, with limits recorded in section9; this is not capability acceptance. H1 found a copy-only evidence gap and returned a prerequisite to S0. Section9 freezes R0 engineering retry constants separately from the owner-approved60,000-ms reconciliation deadline. Owner resolved S0 by declining additional evidence machinery and retaining existing Jev processing; S1/S2 are not needed. A7 is locally accepted. B0 is supported for attempted builtin starts by explicit owner decision. T1/T2 are not needed: existing bounded gateway machinery is reused, without a provider-wide scheduler redesign. B/C runtime exists; their final host/semantic/independent-review gates remain in progress.

## 9. R0 — finite live reconciliation delivery contract

Engineering constants below select bounded best-effort behavior; they are not host latency guarantees. H0 measured fast local admission below 2 ms on both hosts, with exact custom identity available by `context`, not `agent_start`. Three attempts with wider windows tolerate delayed local admission while bounding duplicates.

- One in-memory Phase A chain, one timer, maximum three invocations. Initial send immediately after final guard; retries **2,000 ms** after first invocation and **8,000 ms** after second. After third, **8,000 ms** final evidence grace, then exhausted with no timer. Nominal calls at 0/2/10 seconds, exhaustion at18 seconds. Delays use actual invocation time; late callbacks never produce catch-up bursts.
- Chain holds one immutable message, one UUID-v4 opportunity ID, at most three fresh UUID-v4 send IDs, local session/branch/run generations and baseline branch anchor. No chain/timer/retry restore or durable advisory preference. Later B/C sharing requires its own bounded integration, not a general provider framework here.
- Exact message: `customType: "pi-progress-advisory"`, `display: true`, immutable string content, details exactly `{kind: "reconciliation", opportunityId, sendId}`. Options exactly `{deliverAs: "steer", triggerTurn: true}`. IDs are canonical lowercase 36-byte UUID-v4 strings, generated and recorded before invocation.
- Positive evidence is an exact matching custom `message_end` or canonical branch entry (type/content/display/all details); it stops retries. It proves host acceptance/presence, not reading/compliance. Canonical entry confirmation is required to bind response provenance. An unrelated assistant response, unchanged board, undefined send return, or absent entry at `agent_start` is not success/failure evidence. A synchronous throw consumes an attempt and uses the same schedule.
- Before every invocation synchronously inspect current branch for confirmation, then require master ON, matching session/branch/current opportunity, still relevant settled board, valid complete message, no external invalidation, and no known pending user messages. Initial send requires idle; retry may run in its own candidate advisory run. `hasPendingMessages() === true` vetoes known user queues; false cannot establish absence of custom queues. No await between final checks and invocation.
- Before calling send, establish candidate-own-run identity. Own start cannot cancel before the custom entry becomes visible. User `input` cancels future retries; exact external `intercom_message` or user entry in the post-baseline branch makes the run external/mixed at the next context boundary. Never use prompt-text guessing. Unconfirmed candidate-only settlement suppresses recursion but may retain bounded scheduled retries.
- Settlement origin is advisory-only, mixed/external, independent, or uncertain-advisory. Controller/index retain latest-started and last-consumed run generations separately from chain cleanup: a duplicate settled event cannot become independent after its own chain is freed. Its settlement API returns `SettlementOrigin | undefined`, where undefined ignores duplicate/no-new-run events. Both mixed-external and external outcomes are handed to the controller as eligible external-origin settlements; advisory-only and uncertain-advisory do not rearm. A new independently started run may nudge unchanged work again.
- OFF/input/stale identity/irrelevance/new external run/navigation/shutdown prevent subsequent invocations. Keep only bounded origin tracking after cancellation when needed for already-invoked work; navigation/session disposal erases it. Confirmation/exhaustion leaves no retry timer; late exact evidence may refine origin but never causes a fourth attempt. Every timer captures chain generation and rechecks it after synchronous host callbacks.
- Formatter, not Monitor, admits every included unfinished row. Maximum20 rows, each existing valid label at most240 code points, task ID `task:<positive safe integer>` at most21 UTF-8 bytes. Complete content limits:24,576 UTF-8 bytes and32,768 bytes for JSON string body (excluding surrounding quotes). Overflow suppresses all rows, never truncates.20 four-byte labels require19,200 bytes plus420 for IDs, leaving4,956 raw framing bytes;20 lone-surrogate labels can require28,800 JSON bytes, leaving3,548 encoded framing bytes. A3 freezes/measures exact prose inside both remaining budgets.
- H0 proves actual print/JSON one-shot shutdown before the armed60s deadline; Phase A direct requests in these modes suppress as unsupported. Live RPC and TUI-compatible lifecycle can support A while active. Plain print preserves custom model/session provenance but does not render its content. No host lifetime or stdout shim. Actual TUI rendering remains A5/A7 proof.

A3 tests formatter limits and same-run deadline retention. A5 owns fake-clock retry/exhaustion, synchronous throw/evidence races, positive and mismatched identities, stale callback/disposal, pending-user veto, duplicate settlement after chain cleanup, mixed intercom/user origin, response-failure versus delivery-success, unchanged blocked board, and pinned/global wiring tests. Owner S0 decision requires no additional evidence prerequisite or request/proof changes; delivery correlation does not filter semantic input.

## 10. Canonical citations

- Owner authority and decisions: `.agents/plans/20260920T232515--implement-advisory-nudges-sequentially__active/owner-contract.txt`.
- Actual child scopes/dependencies: `.agents/plans/20260920T232515--implement-advisory-nudges-sequentially__active/beads-initial.txt` (D0 through C4).
- Current runtime seams: `src/index.ts`, `src/core/monitor.ts`, `src/core/hybrid.ts`, `src/core/hybrid-checkpoint.ts`, `src/sources/messages.ts`, `src/analysis/health.ts`, `src/analysis/gateway.ts`, and `src/analysis/scheduler.ts`.
- Pi public extension/runtime behavior: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` and `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`.
- Existing v8 UX baseline, not advisory proof: `docs/design/ux-acceptance.md`.

## 11. Implemented B/C runtime contract

- `src/advisory/correction-adapter.ts` authenticates registered source metadata and schema. Builtin schema annotations (`description`, `~kind`) are accepted without weakening argument-shape checks. Only safe repository-relative paths survive; raw contents, replacements, review task arguments and child outputs never enter corrective requests.
- B returns an attempted action immediately. C stores only the exact named foreground `review` declaration from the installed git pi-subagents package, then requires its own parent tool-call ID, workflow run ID, resolved named-resource provenance and a running child with a real run ID from `tool_execution_update`. Declarations alone never trigger C. Background, raw scripts, generic agents and mismatched receipts abstain. The adapter does not start or cancel anything.
- `src/advisory/corrections.ts` serializes bounded optional classifications (20 queued attempts, 256 exact event IDs). One request covers every included row, at most 20 questions and 24 KiB total; overflow suppresses the entire request. B requires a copied current-revision existing `not-needed` fact at confidence ≥0.5 and probability ≥0.8. It never re-asks necessity.
- B/C require exactly one confidently supported target; every other row must confidently be unrelated. Any required/unknown/ambiguous row vetoes advice. Existing-validation obligations do not imply a new failing test is mandatory; a later required review does not imply review is required now. Explicit current requirements, security/audit/risk and blockers remain protected. Classification is probabilistic, not an authority override.
- Monitor owns bounded existing conversation context, full copied board, current accepted health facts, usage accounting and post-await freshness. A separate optional `JevGateway` reuses existing bounded provider behavior; there is no global one-flight guarantee. Inputs, navigation, shutdown, OFF and changed identity revoke stale inference. No checkpoint fields change.
- B/C emit the exact owner strings in sections 5/6. They reuse the single section-9 delivery chain with `kind: "test-correction" | "review-correction"`; no second retry queue is created. Unlike A's initial idle-only send, correction may steer an active run. A pre-existing independently started run remains external/mixed after correction so its genuine settlement is still eligible for reconciliation. Correction cannot replace an already live advisory opportunity. No cooldown, periodic polling or restored retries.
- Genuine later attempts can be assessed again; repeated event IDs and continued same-attempt edits are suppressed. Bounded history is ephemeral, not a durable exactly-once guarantee. Positive delivery evidence stops transport retries; unchanged board does not trigger retries. OFF cannot retract already-invoked messages.
