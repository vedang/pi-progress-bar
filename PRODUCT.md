# pi-progress-bar

<!-- impeccable:product-schema 1 -->

## Platform

Terminal UI: Pi coding-agent extension first. The web/iOS/Android platform taxonomy does not apply to this product.

## Users and purpose

For people supervising a coding agent who want to see reported plan completion and the condition of the current task without continually reading the entire transcript. The initial user also wants to learn Jev's programming model while building the extension.

## Confirmed scope

**Current delivery: automatic plan-v2 replacement plus V4–V6, tracked in Beads epic `pi-progress-barroot-pyp` and children `.1`–`.8`.** Those issues are the portable implementation specification and supersede older manual-workflow design instructions. V7 remains excluded.

- Start monitoring automatically when loaded. Require `TYPESAFE_API_KEY`; missing/blank or rejected credentials produce an error and OFF. No consent or local-only operating mode.
- Use only real TypeSafe Jev calls for runtime semantic judgments. No separate general-purpose/reasoning LLM, generated task descriptions/summaries, or model-written display labels.
- Expose only `/progress on`, `/progress off`, and `/progress interval <seconds>`; bare command shows usage/state, not a menu. Remove manual source/scope/current-task selection and details/enable/pause/resume.
- Interval controls analysis-cycle starts, not only display redraws. Default is 15 seconds, configurable 5–86,400 seconds; no new evidence means no new inference. Process bounded chunks, at most three serial requests per cycle.
- Show overall **reported task completion**, not a model-estimated percentage, effort estimate, or ETA.
- This batch shows requirements clarity, acceptance criteria, red-test applicability/evidence, and implementation assessment for the automatically inferred current task. A coherent retained/as-of task card may preserve display context after completion or while replacement assessment is pending, but never fabricates semantic current work or evidence authority. It freezes task/revision-bound display labels at assessment time rather than retaining live health/evidence references. Meaningful progress, stuck and off-track assessment (V7) remain deferred.
- Map typed Jev answers to readable text in local code. Requirements Score 2.7 renders `Requirements: mostly clear`; display wording never requires another model call.
- Red-test status includes **Not needed**, distinct from missing or unobserved tests. Assess whether a new failing test adds meaningful value for this task; do not demand tests simply because work occurred.
- An explicit agent report of writing a failing regression test is sufficient for **Reported red** even without a matching observed run. Preserve Reported versus Observed provenance; do not relabel a claim as independently verified.
- V1 is passive: display only. No automatic warnings, agent nudges, tool blocking, or workflow changes.
- V1 observes the main Pi session. It does not instrument child agents or external workers.
- Support users with and without Beads. Existing use of Beads in this repository is not an installation requirement for the extension.
- For prose plans, interpret explicit completion reports and map them to known tasks. Do not infer reported completion solely from code activity.
- Use the actual agent trajectory as stored by Pi as primary evidence for both task-health judgments and plan/report extraction. Avoid sending the full conversation to Jev; select and retain relevant trajectory context.
- Automatically reconcile task identities and evolving scope across conversation entries; preserve ordered reports and explicit corrections. Substantive user directives, questions, explanation/status/plan requests and corrections are Jev-evaluated source work from exact spans. Jev classifies task deliverable as action or response; code carries only that derived enum and never guesses it from wording. Scope offers `same`/`revised` only for same-kind tasks, and settled response work cannot transfer answer completion through `same`. Response tasks use one target-local fulfillment request with lifecycle and current-task choices; action tasks remain bounded multi-task report batches, so response work can add one paid request per task. Approvals/clarifications may link existing work without duplicate scope. Preserve legitimate grounded assistant plans; reject empty turns, quotations, reports and hypotheticals as authority. Process each observation in order: grounded candidate discovery/classification, scope/current reconciliation, then same-observation reporting/cursor commit. A future goal must not alter an earlier report. Unclear scope/current task remains unknown, not a configuration prompt.
- Conversation reports own completion in this batch. Automatically recognized Beads IDs and bounded relevant export records enrich identity/context; stale exports cannot silently replace report statuses or pull the whole backlog into scope.
- Keep the design open to Claude, Codex, and OpenCode integrations later; those integrations are not V1 deliverables.

## Principles

1. Distinguish observed evidence, reported status, semantic judgment, and unknown information.
2. Keep counting, state transitions, time windows, and execution in code; use Jev for bounded semantic judgments.
3. Missing evidence is not evidence of failure or success. `unknown`/`unverified` are absence of reliable supplied evidence, not failure; reported completion is separate from implementation support.
4. Passive observation must not silently become agent control.
5. Display retention never becomes semantic current-task or evidence authority.

## Evidence on hand

- Local reference extensions: `~/src/vedang/pi-ralph-loop/pi-ralph-loop.root/` and `~/src/vedang/pi-exa/pi-exa.root/`.
- Current Pi extension, TUI, package, and session-format documentation.
- Live TypeSafe documentation for Jev primitives, state, confidence, model limits, and verification patterns.
- Four authorized Jev calls on manually selected excerpts from this actual Pi session are recorded in [docs/design/spikes.md](docs/design/spikes.md): 11,269 input tokens, roughly 1.2–1.3 seconds each, estimated total input cost $0.000473298.
- Previous manual V1–V3 checklist/source/consent UX has been removed. Reused ledger, gateway, host and test mechanics now serve the automatic runtime documented in [README](README.md).
- Self-contained Beads epic `pi-progress-barroot-pyp` covers the replacement and V4–V6. V7 remains outside this batch. A fresh independent full-batch review returned ten P1 findings; remediation and main-owned regressions cover the concrete blockers.
- Deterministic tests and an isolated offline Pi package-load check exercise mechanics. Original delivery's bounded live validation used 16 Jev requests total: six direct rubric fixtures, two earlier three-call actual-Pi runs, and one post-review four-call actual-Pi production-path run. That final original-delivery run reached the expected 1/2 reported state with 3,064 input and 590 output tokens. Separate completed repair-validation snapshot used 134 attempts, 162,554 input tokens, and 29,207 output tokens, including two failed runs; user has authorized broader paid evaluation, but each live run still needs an explicit finite cap. The retained-task/conversational-work batch used another 395 attempts, 415,360 input tokens, and 70,355 output tokens, including failed/interrupted runs and diagnostic probes. Its final full suite passed 15/15 with 53 requests (56,701 input / 9,580 output tokens). This remains limited release evidence, not broad accuracy or threshold calibration; one earlier explicit Reported-red fixture was a false negative.

## Future direction (not v1)

If monitoring proves useful and accurate, the user wants optional guidance that can discourage low-value new red tests or defer review until a meaningful chunk is ready. This is a future aspiration, not authorization to inject advice or control the agent in v1. Review readiness is not an additional required v1 indicator.

Any future guidance should separate observations, model assessments, user/repository policy, and the decision to send a nudge. A judgment that a new red test is unnecessary does not waive existing validation requirements.

## Review packet

[docs/design/README.md](docs/design/README.md) links the historical shape, breadboard, slices and evaluation approach. They remain useful for signal semantics, but the current Beads epic governs implementation when activation, source selection or UI instructions conflict. Detailed `plan_v2.md` remains in ignored task artifacts; another machine does not need it because the issue bodies contain the relevant requirements and acceptance checks.

## Open decisions

- Continue validating automatic candidate recall, task identity/revision matching and uncertainty handling on real conversations. Current admission is deliberately conservative and rejects low-concentration results (including the observed weak identity result); the initial safety thresholds are not an accuracy claim and still require broader calibration.
- Verify concrete supported Beads export and passive test/code evidence formats; unsupported observations stay unknown. No universal tool/runner compatibility layer.
- Runtime automatically sends relevant context to TypeSafe when installed with a key; README must disclose costs and privacy. Candidate judgments receive exact source spans, source role, and bounded preceding visible user direction. A user candidate can establish/replace current direction; preceding user direction grounds assistant plans without vetoing a new user goal. Legitimate assistant plans remain eligible. Engineering live evaluation needs a finite recorded request budget, separate from offline default tests.
- Existing widget and bare `/progress` output must distinguish catch-up, unresolved scope, unknown current work, no new evidence, and transport/controller rejection using bounded aggregate reason codes only. Bare help also surfaces current service error and retry/backoff state. They show `Last Jev call` from actual HTTP dispatch (including failed calls), never a tick/cache/redraw or accepted-result proxy; `Never` is truthful before dispatch. No raw conversation, credentials, prompts, model answers, retained task-card text, or dispatch timestamp appear in diagnostics/checkpoints. Retained display cards are memory-only, task/revision bound and discarded if their source is unavailable on the active branch. Reload journals retain canonical IDs/ranges and derived enums only; schema v3 requires every saved source/task work kind and rejects legacy shapes. Their unkeyed digest detects accidental or unrecomputed corruption, not deliberate writable-checkpoint edits that recompute it. Local saved session state is trusted on the same boundary as restored ledger statuses/proofs.
- Existing stack: TypeScript ESM, Bun 1.3.14, Biome, TypeScript, Knip, Vitest unit/integration, Make gates. Node >=22.19.0; previous host tests used `@earendil-works/pi-coding-agent` 0.84.2. Verify actual installed APIs before extending adapters.
