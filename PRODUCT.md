# pi-progress-bar

<!-- impeccable:product-schema 1 -->

## Purpose

A passive Pi terminal widget for supervising **reported completion** and task health without reading the entire transcript. It is not an execution controller, correctness oracle, effort estimate or ETA.

## Governing delivery

Hybrid epic `pi-progress-barroot-xkg` supersedes the span-only extraction and Jev-only task-label contracts of the historical `pyp`, `qmi`, `jks` and `82j` implementations. Earlier safety obligations remain acceptance requirements unless explicitly replaced below. H5 independent acceptance/publication remains pending until its issue closes.

### Semantic pipeline

- Jev `jev-1.13.0` gates scope. Only confidently unchanged skips extraction; uncertain scope is not a negative decision. Confidence >=0.5 and selected probability >=0.8 remain fixed.
- Pi's current selected model generates bounded grounded task patches through the host registry. Host owns authentication. No fallback provider, hidden retries, repair loop or tool execution.
- Code validates atomic patches and owns task IDs, revisions, provenance, lifecycle and counting. Explicit separate user deliverables remain separate; implementation commentary covered by existing work is not a new obligation. Track assistant work, not user approvals or unaccepted conditional offers.
- Jev assesses each included task independently; focus and task order never gate completion. Done tasks receive separate withdrawal judgments. Requirements changes reopen work; wording-only edits preserve completion. Archive/restore preserve identity and history.
- Display done/included fraction, distinguishing unresolved or previous scope. Do not claim inferred work is certainly exhaustive.

### Health and presentation

- Preserve five fields: requirements clarity, acceptance criteria, usefulness of a new red test, red evidence, implementation assessment.
- Red evidence derives Not needed from test applicability without hiding actual reported/observed or contradictory evidence. Implementation Choices are supports, partial, contradicts, insufficient and not-needed. Judge applicability before evidence sufficiency; informational-only work needs no implementation evidence. Positive implementation labels require current passive candidates and accepted task-specific relevance/support judgments, never display-focus attribution or bare self-report. A final completion observation may refresh a coherent retained health card; health still cannot change completion.
- Completion, health, tool evidence and Beads status remain separate. Focus is display/health only, not tool ownership or an execution lock. One first-completion-batch Choice considers all open tasks; present activity/immediate commitment may select, while none/concurrent/uncertain clears focus. No first-open/newest-task fallback. Unlinked tools cannot establish Observed red.
- Retained cards copy the task label and all five fields coherently at assessment admission, with task/revision/as-of provenance. Actual dispatch timestamps are not assessment times.
- Presentation/debug snapshots are copied, read-only and network-free. No redraw-driven analysis, mutable evidence borrowing or raw provider diagnostics. Trusted colors survive clipping; untrusted controls are sanitized before styling.
- Full debugger modal, always-visible UI redesign and V7 stuck/drift/meaningful-progress indicators are deferred.

### Runtime and privacy

- Automatic ON in new sessions requires a Jev key; missing/rejected key means OFF. Only `/progress`, `/progress on`, `/progress off` exist.
- Canonical active-branch IDs/hashes and supported Pi events establish source authority. User/assistant text and inbound `intercom_message` custom messages are task input; intercom retains a distinct role. Idle non-triggering intercom delivery is assessed at the next real turn because Pi provides no public extension hook. Preappend `message_end`, raw tools, arbitrary custom messages, siblings and thinking do not establish authority.
- Whole visible messages, bounded chronological paging, one controlled analysis flight, cancellation epochs and durable accepted phases. Pending-only retries; no idle polling. Selected-model failures wait for explicit recovery.
- The former fresh-user priority lane and early scope cutover are intentionally removed. Large historical backlog may delay new requests; bounded chronology is the supported contract.
- Strict v6 checkpoints persist bounded generated labels, refs, assessment scalars including focus, events, journals, usage and timestamps. Older versions rebuild without migration; accepted same-version phases resume without rebilling. No raw conversation, prompts, provider envelopes or credentials. Canonical amendments invalidate stale derived references. Local checkpoints are trusted writable state, not an adversarial security boundary.
- Context goes to TypeSafe and the selected model provider; calls incur provider charges. README lists concrete caps and storage details.
- Main-session only. Never execute tests/commands, mutate Beads, inject messages, nudge/block agents or follow child workers.

## Acceptance

Deterministic mechanics, real-host event/auth tests and explicitly capped paid semantic replays are complementary, not interchangeable. The current [acceptance report](docs/design/hybrid-acceptance.md) preserves failures and limitations. Independent review must cover the entire change from `afdbee79`, including equivalent disposition of unfinished `82j` repairs; green replacement test totals alone are insufficient.

## Future direction

User-approved exploration of proactive, default-on advisory steering remains a separate future delivery, gated by policy/delivery/review-adapter work. No current passive judgment authorizes a nudge or waives repository validation. Claude/Codex/OpenCode integrations, debugger UI and semantic calibration are not this release's deliverables.

## Development

TypeScript ESM, Bun, Biome, TypeScript, Knip and Vitest; Node >=22.19.0. Actual-host proofs cover local Pi0.84.2/pi-ai0.84.4 and global Pi0.85.1. Historical [design documents](docs/design/README.md) are background, not authority over this contract.
