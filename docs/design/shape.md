---
shaping: true
---
# pi-progress-bar — proposed shape

Status: user endorsed overall design direction and requested explicit `Not needed` for red tests. Future nudging is desired if signals prove accurate; implementation details and calibration remain proposed. No extension integration code. A later authorized four-call real-trajectory spike is documented in [spikes.md](spikes.md).

## Requirements

| ID | Requirement | Status |
| --- | --- | --- |
| R0 | Help a human supervise coding-agent work with a persistent, passive display. | Core goal |
| R1 | Show reported completed tasks versus total scoped plan tasks, not estimated effort or time remaining. | Must-have |
| R2 | Show requirements clarity, acceptance criteria/tests, red tests, implementation completeness, meaningful progress, stuck state, and drift for the current task. | Must-have |
| R3 | Refresh every 10 seconds without blocking the agent or requiring a full-transcript inference request. | Must-have |
| R4 | Work with Beads and without it; interpret explicit completion reports for known prose-plan tasks. | Must-have |
| R5 | Distinguish observed facts, reported states, model judgments, and insufficient evidence. | Must-have |
| R6 | Deliver main-session Pi support first while keeping host-specific collection and rendering outside shared logic. | Must-have |
| R7 | Keep v1 display-only: no automatic warnings, steering, blocking, or child/external-worker instrumentation. | Must-have |
| R8 | Teach Jev's role through small runnable examples and inspectable raw answers before relying on all signals. | Core goal |

## R × A fit — before breadboarding

This is a design-mechanism fit, not implementation or accuracy verification. ✅ means a concrete mechanism is described; ❌ means a mechanism still needs resolution. The two open rows are the breadboarding focus.

| Req | Requirement | Status | A |
| --- | --- | --- | :---: |
| R0 | Help a human supervise coding-agent work with a persistent, passive display. | Core goal | ✅ |
| R1 | Show reported completed tasks versus total scoped plan tasks, not estimated effort or time remaining. | Must-have | ✅ |
| R2 | Show requirements clarity, acceptance criteria/tests, red tests, implementation completeness, meaningful progress, stuck state, and drift for the current task. | Must-have | ❌ |
| R3 | Refresh every 10 seconds without blocking the agent or requiring a full-transcript inference request. | Must-have | ✅ |
| R4 | Work with Beads and without it; interpret explicit completion reports for known prose-plan tasks. | Must-have | ❌ |
| R5 | Distinguish observed facts, reported states, model judgments, and insufficient evidence. | Must-have | ✅ |
| R6 | Deliver main-session Pi support first while keeping host-specific collection and rendering outside shared logic. | Must-have | ✅ |
| R7 | Keep v1 display-only: no automatic warnings, steering, blocking, or child/external-worker instrumentation. | Must-have | ✅ |
| R8 | Teach Jev's role through small runnable examples and inspectable raw answers before relying on all signals. | Core goal | ✅ |

- R2: concretize evidence-to-display rules for red-test history, implementation evidence, and temporal signals.
- R4: concretize source selection, stable task identity, prose report mapping, revisions/conflicts and explicit overrides.
- Calibration remains an evaluation gate even after mechanisms are specified. See the breadboard's gap disposition for the proposed resolution; this table preserves the initial fit assessment.

## Proposed shape A: evidence-aware passive monitor

| Part | Mechanism | Remaining uncertainty |
| --- | --- | --- |
| A1 | Pi event collector normalizes finalized messages, tool observations, agent activity, and session lineage into a bounded local evidence store. | Custom tools expose heterogeneous evidence; unsupported formats remain unknown. |
| A2 | Plan resolver selects source spans from current-branch messages and observed plan files, using a bounded Jev Choice only where semantics are needed. | Candidate recall and prose task segmentation require examples. |
| A3 | Task-source adapters read Beads or selected Markdown/conversation plan; source references and explicit status reports produce a revisioned task ledger. | Exact Beads scope selection and prose reconciliation require prototype checks. |
| A4 | Snapshot builder selects goal, active task, criteria, relevant evidence, and rolling-window observations within fixed budgets. | Evidence-selection quality must be evaluated. |
| A5 | Jev evaluates independent narrow questions; code handles unknowns, freshness, temporal persistence, and presentation labels. | Rubrics and thresholds are not calibrated yet. |
| A6 | Named Pi widget displays reported bar plus seven status/meter rows, with source/freshness and on-demand evidence details. | Final layout and command names need user confirmation. |
| A7 | Session-scoped scheduler refreshes locally every 10s, performs single-flight changed-state inference, cancels on shutdown, and rejects cross-session/task results. | End-to-end latency and cost require measurement. |

These are understood architectural seams, not a claim that automatic plan inference or health judgments have been validated. The proposed mechanisms are detailed in [breadboard.md](breadboard.md) and sequenced in [slices.md](slices.md). This review packet does not authorize implementation.

## Overall progress semantics

[tag:reported_completion_only] Overall bar equals reported completed atomic tasks / total included atomic tasks in the selected plan revision. It never uses a Jev implementation-completeness judgment as a completion event.

- Count selected plan/epic scope, not every issue in the repository.
- Count one level of work items; do not count both epic and its children.
- Equal task weights initially; label `tasks`, not effort, time, or work remaining.
- Unreported/ambiguous task statuses stay in the denominator but are not counted done. Display unknown count separately when useful.
- No trustworthy task list/denominator: `Plan not identified` or `Plan ambiguous`, with no numeric percentage. Zero tasks is not 100% done.
- Explicit cancellation/removal is a scope change, not completion. Show changed denominator and revision notice; progress may legitimately decrease.
- A task disappearing from a cropped response or a bounded source scan is not evidence of removal.
- Contradictory reports are exposed, not averaged or silently resolved. Within one source, clearly scoped later reopen reports replace earlier done reports; ambiguous identity/revision changes require abstention or manual correction.
- Show source: `Beads-reported`, `Checklist-reported`, or `Conversation-reported`. Source discovery and prose interpretation may be model-mediated; status remains a report, not independent proof.
- A completion report must be a current task-status assertion by the user/assistant or an explicit selected tracker status. Quoted examples, hypothetical language, untrusted tool text, future intentions, and completion judgments from this monitor cannot create completion events.

## Jev capability and UI mapping

| Signal | Jev question / code evidence | Recommended display | Limit |
| --- | --- | --- | --- |
| Requirements clarity | Score over defined levels: missing target; target with consequential unresolved behavior; concrete behavior with minor ambiguity; concrete behavior and relevant boundaries resolved. Consider separate ambiguity questions when independently useful. | Small explicitly labeled clarity meter + verbal level; model confidence in details. | Does not prove spec completeness or know unstated expectations. |
| Acceptance criteria/tests | Per requirement: does supplied text describe an observable success condition? Noul for presence with precise criteria; Choice if explicit/partial/absent/unknown distinctions matter. Test artifact presence is separate observed evidence. | `Explicit`, `Partial`, `Not found in supplied context`, or `Unknown`; distinguish criteria from executable tests. | A heading called Acceptance is not proof; seeing no test file does not prove no criteria exist. |
| Red tests | First assess whether a new failing test adds meaningful validation for this task, using task kind, risk, existing coverage, and explicit test policy. An explicit agent assertion is sufficient for reported red; independently observed file/run/assertion/order evidence can establish observed red. Jev judges report meaning and task relevance. | `Not needed (Jev assessment)`, `Reported red`, `Observed red`, `Written; red unreported`, or `Unknown`. | Reported is sufficient under user policy but is not independently verified. Contradictory evidence remains visible. Not needed does not waive validation. A generic process failure or file existence alone is not red evidence. Do not rerun tests from monitor. |
| Implementation | Per criterion Choice: evidence supports / contradicts / insufficient evidence, paired with actual check outcomes if observed. | `Appears complete`, `Partial`, `Unverified`, plus criterion evidence details. | Cannot certify arbitrary code correct or all requirements satisfied from a bounded snapshot. Passing tests may be incomplete or stale. |
| Meaningful progress | Noul or Choice on whether selected changes/observations reduce unresolved work against active goal over a longer window. Include investigation and narrowed hypotheses, not just edits. | `Advancing`, `No advance observed`, `Unclear`, with window label. | Activity, token count, commit count, or lines changed are not progress measures. No meaningful change is not necessarily stuck. |
| Stuck | Code computes elapsed times, repeated failures and activity state. Jev Choice assesses repeated unproductive attempts / explicit blocker / productive exploration / insufficient evidence from a trajectory. | `Possible loop`, `Blocked (reported)`, `No stuck signal`, `Observing`; idle/waiting/tool-running labeled separately. | Inactivity cannot prove stuck. A 10s refresh is not a 10s stuck threshold. Main session cannot judge unseen child internals. |
| Off track | Choice on recent work relation to current goal: direct work / necessary supporting work / unrelated / conflicting / insufficient evidence. | `Aligned`, `Possible drift`, or `Unclear`; evidence available on demand. | A detour can be necessary. Respect user-approved scope changes and task transitions. |

[tag:evidence_not_verification] Typed answers guarantee interface shape, not truth. Choice/Score confidence summarizes distribution concentration; Noul is probability of yes and has no separate confidence. No signal is permission for the extension to act on the agent.

Do not multiply per-criterion probabilities as though independent. Per-request evaluation independence is not statistical independence of correctness. Do not render averaged completeness as a verified percentage. Raw probabilities and source excerpts remain inspectable; do not manufacture free-text reasoning Jev did not supply.

## Red-test applicability and future guidance

[tag:red_test_applicability] Keep two independent fields: **applicability** (`needed`, `not_needed`, `uncertain`) and **evidence** (`relevant_red_observed`, `relevant_red_reported`, `tests_written_red_unreported`, `red_unreported`, `unknown`). A test can have been observed even when its applicability is disputed; preserve both fields in details rather than erasing history.

Use a narrow Choice to assess whether introducing a new failing test would meaningfully validate the stated task, considering existing coverage and known requirements. Keep rationale support as selected source excerpts or bounded concern categories, not generated prose. Missing scope, coverage, or material risk information leads to `uncertain`, not `not_needed`.

- Candidate not-needed cases: documentation wording or mechanical changes already covered by relevant existing tests, subject to explicit project policy and task-specific risks.
- Needed cases: behavior changes, reproducing a bug, regression prevention, security/permission boundaries, or explicit acceptance requirements. These are rubric examples, not a complete deterministic classifier.
- An explicit test-first requirement in selected user/repository policy takes precedence over a contrary model recommendation. Display a conflict in details; do not silently waive policy.
- `Not needed` concerns adding a new red test; it does not mean skip existing tests, typechecking, builds, or other required validation.
- Jev assessment, explicit user waiver, and unavailable history have separate provenance. Do not display model-derived not-needed as an observed fact.
- User explicitly accepts an agent's statement that it wrote a failing regression test as sufficient reported-red status even when execution history is unavailable. Jev can map the assertion to the task; retain the verbatim report and never relabel it observed. Future intentions, quoted examples and unscoped assertions remain insufficient. A directly contradictory observation creates a visible conflict rather than silently accepting the claim.

User's future examples: "dont write red tests for this task, just implement it" and "dont start a reviewer for the work yet, wait for a bigger chunk to be completed".

Keep future architecture as **observations → assessments → explicit policy → optional nudge**. V1 stops at display; do not implement a policy engine, agent-facing tool or message injection now. Retain evidence IDs, question/model version and raw answers so later evaluation can assess false advice. Avoid a single numeric quality score that hides conflicts.

Review timing is a distinct future question: has a coherent reviewable unit landed, with enough evidence for useful feedback, and is an early checkpoint warranted by risk? Do not use line count or elapsed time as review readiness. A small security change can deserve immediate review; five unrelated edits need not form a coherent batch. This is future exploration, not an extra required v1 row.

Progression before enabling nudges: offline/labeled trace evaluation, visible recommendations in a later opt-in mode, then user-authorized bounded nudges with scope/freshness checks, policy precedence, deduplication and cooldown. None of these authorize suppressing explicit user instructions or safety-critical validation.

## UX proposal (Operate mode)

Illustrative labels only, not measured Jev output:

```text
Plan  [######----------]  40% reported · 2/5 tasks · conversation
Task  Add cancellation support
  Requirements    clear                    (Jev)
  Acceptance      explicit criteria        (Jev)
  Red tests       relevant red observed    (evidence)
  Implementation  partial                  (Jev)
  Progress        advancing · last 2m      (Jev)
  Stuck           no stuck signal          (Jev)
  Direction       aligned                  (Jev)
Updated 4s ago · /progress details
```

- Keep all seven signals represented by default as requested. Wide terminals may pair rows; narrow terminals stack or shorten labels without changing meaning.
- Use Pi's current theme and text labels; never depend on red/green alone. Avoid replacing footer/editor or taking input focus.
- Overall bar is the only percentage-completion graphic. A clarity score may have a mini-meter, but confidence should not masquerade as task progress.
- `Unknown`, `N/A`, `Stale`, `Offline`, `Waiting`, and `Idle` differ. Missing data never renders as a zero score.
- Per-signal freshness where inputs differ; distinguish display refresh time from last successful inference time.
- Stable layout and measured temporal persistence avoid flickering verdicts. Do not arbitrarily clamp completion to be monotonic.
- Proposed `/progress details` shows original excerpts/evidence references, task scope, full probabilities, question/model version, observed checks, and data coverage. These are supporting evidence, not a generated explanation of Jev's internal reasoning.
- Proposed user controls: inspect/select source, correct scope/current task, hide/show/pause monitor. These change monitor only, not agent workflow.
- No unsolicited popups, alerts, sounds, or agent feedback.

## Beads: optional adapter, no bundled br/bv

Recommendation, not yet explicit user approval:
- Do not install br/bv in package installation hooks, change user PATH, initialize .beads, or modify agent instructions.
- Proposed product-v1 adapter directly reads `.beads/issues.jsonl`, scoped to selected issue IDs. No br/bv executable required. bv is a separate viewer/analysis program; no needed role in v1 progress accounting.
- Never execute br commands, import, flush, initialize, or sync as a monitoring side effect. Nominal CLI reads may auto-import; direct export-file reading keeps this boundary explicit.
- JSONL exports may lag SQLite; label status `Beads export-reported` and show export observation/mtime without claiming database freshness. Reject partial/malformed snapshots without clearing prior good state; show stale/unavailable.
- Epic descendant expansion is deferred until the relationship schema and parent/child counting rules are validated. Initial Beads scope uses explicit issue IDs, with optional suggestions from IDs mentioned in the current session.
- Do not auto-prefer an unrelated Beads backlog over a selected active conversation plan.
- Same ledger contract for Beads, checklists, and conversation sources. No tracker-specific assumptions in evaluator or renderer.

## Bounded automatic plan discovery

The actual Pi-stored trajectory is primary evidence for plan extraction and task judgments. Files and Beads can enrich a selected source but do not replace trajectory context. One selected source owns scope/status; other sources can flag conflicts, not silently change counts.

1. Collect actual current-branch user/assistant text and successful observed file read/write/edit references. Known interactive-question results may contain actual user answers (confirmed in the live spike) and must preserve that provenance; never promote arbitrary tool output to user authority. Treat other tool output/quoted external text as evidence, not instructions.
2. Split candidate source blocks in code (headings, list items, paragraphs), assign opaque IDs and bounded excerpts. Jev selects among supplied candidates; include none/ambiguous. It does not invent tasks, filenames, or a summary.
3. For prose, classify/select source spans and map explicit subsequent reports to known task IDs. Multi-task reports need one question per candidate task, not a Choice that can select only one.
4. Retain a local plan index with source entry/path/span, source revision, task IDs/text, status-report references, active-task evidence, and coverage/uncertainty. Prefer verbatim snippets over recursive model summaries.
5. Detect file revisions and new plan-bearing messages; invalidate only affected interpretations. Plan/task switches reset temporal windows and cannot inherit old health judgments.
6. For old sessions, bounded local branch indexing can find plan references without submitting the whole transcript to Jev. If relevant history falls outside scan bounds or candidates omit the plan, abstain and offer explicit selection. Absence from a bounded scan is not absence from the session.
7. If candidate volume exceeds budget, local shortlist then bounded selection; follow-up request only when selected source must be fetched/segmented. The selector is not responsible for generating future evaluation state.

Snapshot contains active goal, full relevant task text/criteria, known task IDs for report mapping, relevant code/test excerpts, current runtime state, recent changes plus a longer trajectory summary computed in code, evidence IDs, coverage and omissions. Do not use only last ten seconds of diff: many judgments require earlier task evidence.

Current live Jev docs: 64k total request tokens and 32k for state plus longest question. Target substantially smaller, record token usage, and cap candidate/evidence/question counts. Do not silently truncate away the only goal or key criterion; emit insufficient coverage.

## Portable architecture, no speculative framework

One TypeScript package first, with small separate modules:

- **Pi adapter**: subscribe to host events, normalize main-session evidence, persist/recover branch-scoped monitor state, render widget.
- **Task sources**: Beads / Markdown / conversation sources become common scoped plan records.
- **Core**: task ledger, reported count, source selection policy, evidence windows, freshness and status reduction; no Pi imports.
- **Jev client/evaluator**: bounded state/questions and typed judgments; injectable client/clock for tests.
- **View model**: structured display data; Pi renderer consumes it. Future hosts use same engine but may need different UI surfaces.

No daemon, MCP server, multi-package monorepo, or speculative implementations for other hosts in v1. Claude/Codex/OpenCode event and UI feasibility remain future adapter research, not promised parity.

## Verified Pi integration seams

- `ctx.ui.setWidget(key, ...)` adds named widget above/below editor; don't replace footer. `ctx.mode === 'tui'` guards custom components; `hasUI` also includes RPC and is not enough for terminal-only factories.
- Consume `message_end` and tool execution events without returning replacements or doing network work in awaited event handlers. Deduplicate observations across tool-result and message events by event/tool IDs.
- Main-session lifecycle from `agent_start`, tool start/end, and `agent_settled` / `ctx.isIdle()`. `agent_end` alone is not final idle.
- Start session resources in `session_start`, not factory; stop timers, abort requests, clear widget on `session_shutdown`. Rebuild on session replacement and `/tree`; invalidate inference on task/plan/session changes.
- `getBranch()` follows active Pi conversation lineage; `getEntries()` includes other paths. `buildContextEntries()` is compaction-applied context, not full historical source evidence. These are distinct from repository branches.
- `pi.appendEntry()` persists extension-only metadata without injecting it into model context. Persist meaningful source/ledger transitions, not a full duplicate transcript every tick; reconstruct only entries on active branch.
- Custom widgets implement width-safe `render(width)`, `invalidate()`, and request render on updates. Match Pi theme at render/invalidation time.

Reference patterns: Ralph status clearing and lifecycle; Exa bounded, injected network transport and separate opt-in live tests; current Pi package manifest convention (`pi.extensions`, peer dependencies for Pi packages; Jev SDK as runtime dependency if chosen).

## Scheduler, privacy, and failure semantics

- Refresh display every 10s. Mark relevant evidence dirty as events arrive; skip duplicate inference for unchanged semantics. A time-window transition can change state even without an edit.
- One request in flight; cap deadline/retries, coalesce new work, respect retry-after/backoff, and never accumulate tick backlog.
- Snapshot carries session/lineage generation, plan revision, task ID, evidence revision, and observation time. Discard cross-identity results. Same-task older snapshot may only display with explicit as-of/stale status; do not present it as current verification. Avoid starvation from invalidating on every streamed token.
- API unavailable/missing credentials: reported structured progress remains available; semantic judgments show unavailable. Conversation-derived interpretations may remain last-known with age but cannot be refreshed without Jev.
- Do not execute project tests/scripts just to observe progress. Only collect results agent already produced or approved structured sources.
- Before first live use, disclose third-party transfer of selected plan/source/tool text and obtain consent; allow inspection of outbound snapshot. User approved this session's bounded live spike; that approval does not extend to other users or unrelated sessions. No background inference during installation. Keep credentials out of persisted state.
- Read within approved workspace/source boundaries, enforce realpath/size limits, exclude secret files and private `!!` output, and acknowledge redaction cannot guarantee removal of every secret.
- Avoid request-body debug logging. Raw tool/file text is untrusted and must not control code actions, network destinations, or source reads outside policy.
- Stuck/drift displays are advisory. Waiting for user, running tests, compaction, retries, and invisible delegated work should not be treated as observed failure.

## First runnable experiment (recommendation, not approved implementation plan)

The first experiment spans two runnable slices: first a small explicitly selected checklist and reported-completion bar, then two Jev signals (requirements clarity and acceptance criteria). This keeps every increment working while separating observed counting from the first model call. Compare a few labeled clear/vague/contradictory/missing-evidence examples and inspect raw answers. Establish Pi widget and ten-second refresh in the first slice; add consent, state budget and nonblocking/unknown inference behavior with the first Jev slice.

Then extend the same working product with automatic plan/report selection and optional Beads sourcing; add observed red-test history and per-criterion implementation judgments; finally evaluate temporal progress/stuck/drift. The detailed proposed sequence is in [slices.md](slices.md); all slices remain unimplemented.

Acceptance probes before broad use:
- `[x]` updates count; no plan yields no percentage; scope revision changes denominator honestly.
- Prose `I will finish step 2` never becomes done; `finished steps 2 and 3` can map both; quoted examples and retracted reports do not count.
- Plan source omitted/ambiguous, unknown current task, and insufficient history remain explicit.
- Relevant assertion failure before implementation is distinguished from runner crash; missing historical run is unknown.
- Documentation wording can assess `Not needed`; one-line authorization changes cannot be waved through on size alone. Existing validation requirements remain intact. Missing task/risk information stays uncertain; explicit test-first requirements override a model's not-needed recommendation.
- Tests running for minutes are not automatically stuck; repeated unproductive attempts differ from productive investigation.
- Task switch, tree navigation, reload, stale response, API failure, secret exclusions, and narrow terminal width behave safely.
- Main agent proceeds unmodified with monitor on/off; no message injection or hidden test runs.

## Source notes and corrections to research reports

The raw researcher report is evidence, not design authority. Corrections:
- Reject 'stuck is fully deterministic': inactivity/repetition are facts; stuck is contextual inference.
- Reject 'only per-window delta' as universal input: retain task/criteria and relevant historical evidence.
- Do not claim 10s end-to-end cadence validated from vendor typical-latency statement.
- Do not describe evidence display as reconstructed internal rationale; show excerpts and judgment only.
- Count confidence/uncertainty separately from missing evidence.
- Scout line references were approximate; parent read extensions.md, tui.md, session-format.md and packages.md in full and checked source patterns.

Sources: [Jev models](https://docs.typesafe.ai/models), [primitives](https://docs.typesafe.ai/primitives), [confidence](https://docs.typesafe.ai/confidence), [jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13), [citation verification](https://docs.typesafe.ai/cookbooks/citation_check), [br](https://github.com/Dicklesworthstone/beads_rust), [bv](https://github.com/Dicklesworthstone/beads_viewer). Local Pi docs: `/Users/nejo/.local/share/pi/docs/{extensions,tui,session-format,packages}.md`; example `examples/extensions/widget-placement.ts`.
