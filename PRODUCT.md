# pi-progress-bar

<!-- impeccable:product-schema 1 -->

## Platform

Terminal UI: Pi coding-agent extension first. The web/iOS/Android platform taxonomy does not apply to this product.

## Users and purpose

For people supervising a coding agent who want to see reported plan completion and the condition of the current task without continually reading the entire transcript. The initial user also wants to learn Jev's programming model while building the extension.

## Confirmed scope

**Current delivery: plan-v2 replacement plus V4–V6, tracked in Beads epic `pi-progress-barroot-pyp` and children `.1`–`.8`.** Those issues are the portable implementation specification and supersede older manual-workflow design instructions. Existing code still implements the previous UX; the new batch is not delivered yet.

- Start monitoring automatically when loaded. Require `TYPESAFE_API_KEY`; missing/blank or rejected credentials produce an error and OFF. No consent or local-only operating mode.
- Use only real TypeSafe Jev calls for runtime semantic judgments. No separate general-purpose/reasoning LLM, generated task descriptions/summaries, or model-written display labels.
- Expose only `/progress on`, `/progress off`, and `/progress interval <seconds>`; bare command shows usage/state, not a menu. Remove manual source/scope/current-task selection and details/enable/pause/resume.
- Interval controls analysis-cycle starts, not only display redraws. Plan-v2 default is 60 seconds, configurable 5–86,400 seconds; no new evidence means no new inference. Process bounded chunks, at most three serial requests per cycle.
- Show overall **reported task completion**, not a model-estimated percentage, effort estimate, or ETA.
- This batch shows requirements clarity, acceptance criteria, red-test applicability/evidence, and implementation assessment for the automatically inferred current task. Meaningful progress, stuck and off-track assessment (V7) remain deferred.
- Map typed Jev answers to readable text in local code. Requirements Score 2.7 renders `Requirements: mostly clear`; display wording never requires another model call.
- Red-test status includes **Not needed**, distinct from missing or unobserved tests. Assess whether a new failing test adds meaningful value for this task; do not demand tests simply because work occurred.
- An explicit agent report of writing a failing regression test is sufficient for **Reported red** even without a matching observed run. Preserve Reported versus Observed provenance; do not relabel a claim as independently verified.
- V1 is passive: display only. No automatic warnings, agent nudges, tool blocking, or workflow changes.
- V1 observes the main Pi session. It does not instrument child agents or external workers.
- Support users with and without Beads. Existing use of Beads in this repository is not an installation requirement for the extension.
- For prose plans, interpret explicit completion reports and map them to known tasks. Do not infer reported completion solely from code activity.
- Use the actual agent trajectory as stored by Pi as primary evidence for both task-health judgments and plan/report extraction. Avoid sending the full conversation to Jev; select and retain relevant trajectory context.
- Automatically reconcile task identities and evolving scope across conversation entries; preserve ordered reports and explicit corrections. Unclear scope/current task remains unknown, not a configuration prompt.
- Conversation reports own completion in this batch. Automatically recognized Beads IDs and bounded relevant export records enrich identity/context; stale exports cannot silently replace report statuses or pull the whole backlog into scope.
- Keep the design open to Claude, Codex, and OpenCode integrations later; those integrations are not V1 deliverables.

## Principles

1. Distinguish observed evidence, reported status, semantic judgment, and unknown information.
2. Keep counting, state transitions, time windows, and execution in code; use Jev for bounded semantic judgments.
3. Missing evidence is not evidence of failure or success.
4. Passive observation must not silently become agent control.

## Evidence on hand

- Local reference extensions: `~/src/vedang/pi-ralph-loop/pi-ralph-loop.root/` and `~/src/vedang/pi-exa/pi-exa.root/`.
- Current Pi extension, TUI, package, and session-format documentation.
- Live TypeSafe documentation for Jev primitives, state, confidence, model limits, and verification patterns.
- Four authorized Jev calls on manually selected excerpts from this actual Pi session are recorded in [docs/design/spikes.md](docs/design/spikes.md): 11,269 input tokens, roughly 1.2–1.3 seconds each, estimated total input cost $0.000473298.
- Previous V1–V3 implementation provides reusable ledger, gateway, host and test code, but its manual checklist/source/consent UX is superseded by the new direction. See [README](README.md) for what currently runs, not the new target contract.
- Self-contained Beads epic `pi-progress-barroot-pyp` covers the replacement and V4–V6. V7 remains outside this batch. The old full-batch reviewer timed out without a verdict.
- Deterministic tests and an isolated offline Pi package-load check exercise mechanics; representative live accuracy, automatic retrieval quality and calibrated thresholds remain unvalidated.

## Future direction (not v1)

If monitoring proves useful and accurate, the user wants optional guidance that can discourage low-value new red tests or defer review until a meaningful chunk is ready. This is a future aspiration, not authorization to inject advice or control the agent in v1. Review readiness is not an additional required v1 indicator.

Any future guidance should separate observations, model assessments, user/repository policy, and the decision to send a nudge. A judgment that a new red test is unnecessary does not waive existing validation requirements.

## Review packet

[docs/design/README.md](docs/design/README.md) links the historical shape, breadboard, slices and evaluation approach. They remain useful for signal semantics, but the current Beads epic governs implementation when activation, source selection or UI instructions conflict. Detailed `plan_v2.md` remains in ignored task artifacts; another machine does not need it because the issue bodies contain the relevant requirements and acceptance checks.

## Open decisions

- Validate automatic candidate recall, task identity/revision matching and uncertainty handling on real conversations. No arbitrary confidence cutoff or highest-probability choice establishes accuracy.
- Verify concrete supported Beads export and passive test/code evidence formats; unsupported observations stay unknown. No universal tool/runner compatibility layer.
- Runtime automatically sends relevant context to TypeSafe when installed with a key; README must disclose costs and privacy. Engineering live evaluation needs a finite recorded request budget, separate from offline default tests.
- Existing stack: TypeScript ESM, Bun 1.3.14, Biome, TypeScript, Knip, Vitest unit/integration, Make gates. Node >=22.19.0; previous host tests used `@earendil-works/pi-coding-agent` 0.84.2. Verify actual installed APIs before extending adapters.
