# Progress monitor — review packet

**Status: proposed design and implementation sequence. No extension implementation has started.** The user will review this packet and decide next steps. No source code, test execution, SDK installation, or live Jev call is implied by the acceptance checks below.

## Read in this order

1. [Confirmed product scope](../../PRODUCT.md) — what the user has asked for and approved so far.
2. [Shape](shape.md) — requirements, signal semantics, UX, source discovery, boundaries and future direction.
3. [Breadboard](breadboard.md) — proposed UI/code/store affordances, control/data wiring and user journeys.
4. [Vertical slices](slices.md) — small working increments, dependencies, demos, acceptance checks and deferrals.
5. [Spike findings](spikes.md) — R2/R4 source research plus four actual Jev calls on this session, including mismatches, uncertainty, usage and limitations.
6. [Evaluation](evaluation.md) — how to distinguish observer correctness from Jev interpretation quality and user usefulness.

The shape owns requirements and mechanisms. Breadboard tables own affordance IDs and wiring. Slices reference those IDs and own implementation order. When changing one, update the others in the same task.

## Proposed delivery sequence

| Slice | Visible increment                                                              |
|-------|--------------------------------------------------------------------------------|
| V1    | Explicit checklist → reported bar and source inspection.                       |
| V2    | Consent → first Jev clarity/acceptance signals and raw answers.                |
| V3    | Actual Pi trajectory → plan discovery and explicit report mapping.             |
| V4    | Scoped Beads export → reported counts without br/bv installation.              |
| V5    | Red-test applicability → Not needed / Reported red / Observed red.             |
| V6    | Criterion evidence → implementation assessment independent of reported status. |
| V7    | Task trajectory → meaningful progress, possible stuck state and direction.     |

V1 plus V2 is the first end-to-end Jev learning experiment. Every slice includes its own safety/failure handling and acceptance checks; there is no deferred horizontal hardening phase.

## Non-negotiable boundaries

- Overall percentage is **reported completed tasks / scoped total tasks**, not effort, ETA, or model-estimated completeness.
- Product v1 is **display-only, main Pi session only**. No automatic nudges, alerts, tool blocking, issue updates or child-agent instrumentation.
- **Not needed** is a first-class assessment for adding a new red test; it is not missing evidence and does not waive existing validation or explicit test policy. Explicit agent assertion suffices for **Reported red**; label it separately from **Observed red**.
- No trustworthy denominator means no percentage. Unknown, stale, offline, waiting, not-needed and failed are distinct states.
- Beads is optional. Proposed initial adapter reads exported JSONL without installing or invoking br/bv; export freshness is not database freshness.
- No outbound project content without explicit Jev enablement/consent. Credentials and private shell output are not monitoring evidence.
- Future nudges are a separate opt-in product decision after accuracy and usefulness are established.

## Terminology

**Product v1** means the intended first release of the passive monitor. **V1, V2, ...** in the slice document mean sequential implementation increments within that release, not separate product versions.

**Observed** means the monitor has direct evidence. **Reported** means a selected source asserts a status. **Assessed** means Jev interpreted supplied evidence. These are not interchangeable.

## Review focus

- Does the first slice teach Jev while producing something useful end to end?
- Are plan selection, scope changes, task identity and unknown states understandable?
- Do the seven task signals use appropriate semantics rather than interchangeable percentages?
- Is the `Not needed` rule useful without becoming permission to avoid important validation?
- Are every slice's demo and acceptance checks concrete enough to approve or reject?
- Which open assumptions should be changed before implementation?

No future-host adapter or identical UI parity is promised. Core evidence/assessment logic stays independent of Pi; Claude, Codex and OpenCode integration feasibility is a later task.
