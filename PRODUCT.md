# pi-progress-bar

<!-- impeccable:product-schema 1 -->

## Platform

Terminal UI: Pi coding-agent extension first. The web/iOS/Android platform taxonomy does not apply to this product.

## Users and purpose

For people supervising a coding agent who want to see reported plan completion and the condition of the current task without continually reading the entire transcript. The initial user also wants to learn Jev's programming model while building the extension.

## Confirmed scope

- Refresh the display every 10 seconds.
- Show overall **reported task completion**, not a model-estimated percentage, effort estimate, or ETA.
- Show current-task signals for requirements clarity, acceptance criteria/tests, red tests, implementation completeness, meaningful progress, stuck state, and off-track work.
- Red-test status includes **Not needed**, distinct from missing or unobserved tests. Assess whether a new failing test adds meaningful value for this task; do not demand tests simply because work occurred.
- V1 is passive: display only. No automatic warnings, agent nudges, tool blocking, or workflow changes.
- V1 observes the main Pi session. It does not instrument child agents or external workers.
- Support users with and without Beads. Existing use of Beads in this repository is not an installation requirement for the extension.
- For prose plans, interpret explicit completion reports and map them to known tasks. Do not infer reported completion solely from code activity.
- Avoid sending the full conversation to Jev. Identify and retain relevant plan/task context.
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
- No monitor implementation, representative evaluation results, measured latency, or calibrated thresholds yet.

## Future direction (not v1)

If monitoring proves useful and accurate, the user wants optional guidance that can discourage low-value new red tests or defer review until a meaningful chunk is ready. This is a future aspiration, not authorization to inject advice or control the agent in v1. Review readiness is not an additional required v1 indicator.

Any future guidance should separate observations, model assessments, user/repository policy, and the decision to send a nudge. A judgment that a new red test is unnecessary does not waive existing validation requirements.

## Open decisions

- Proposed: optional Beads adapter, without bundling or auto-installing `br` or `bv`.
- Exact source-selection rules, plan revision/reconciliation behavior, and UI layout need approval and prototype validation.
- Define evidence rubrics, temporal windows, and uncertainty thresholds through representative examples, not arbitrary confidence cutoffs.
- Confirm TypeSafe data-sharing consent and first live-call scope before sending project content.
- Proposed stack: TypeScript ESM, following the reference extension packaging and deterministic-test conventions. Dependencies and minimum Pi version remain implementation decisions.
