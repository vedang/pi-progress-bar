# pi-progress-bar

<!-- impeccable:product-schema 1 -->

## Purpose

A Pi terminal widget with advisory status reconciliation for supervising **reported completion** and task health without reading the entire transcript. It is not an execution controller, correctness oracle, effort estimate or ETA.

## Governing delivery

Hybrid epic `pi-progress-barroot-xkg` supersedes the span-only extraction and Jev-only task-label contracts of the historical `pyp`, `qmi`, `jks` and `82j` implementations. Earlier safety obligations remain acceptance requirements unless explicitly replaced below. The accepted hybrid release is followed by UX epic `pi-progress-barroot-y3h`. This UX candidate is local-only: consolidated QA and independent review precede owner manual acceptance; the owner handles release.

### Semantic pipeline

- Jev `jev-1.13.0` gates scope. Only confidently unchanged skips extraction; uncertain scope is not a negative decision. Confidence >=0.5 and selected probability >=0.8 remain fixed.
- Pi's current selected model generates bounded grounded task patches through the host registry. Host owns authentication. No fallback provider, hidden retries, repair loop or tool execution.
- Code validates atomic patches and owns task IDs, revisions, provenance, lifecycle and counting. Explicit separate user deliverables remain separate; implementation commentary covered by existing work is not a new obligation. Track assistant work, not user approvals or unaccepted conditional offers.
- Jev assesses each included task independently; focus and task order never gate completion. Done tasks receive separate withdrawal judgments. Requirements changes reopen work; wording-only edits preserve completion. Archive/restore preserve identity and history.
- Display done/included fraction, distinguishing unresolved or previous scope. Do not claim inferred work is certainly exhaustive.

### Health and presentation

- Preserve five fields: requirements clarity, acceptance criteria, usefulness of a new red test, red evidence, implementation assessment.
- Red evidence derives Not needed from test applicability without hiding actual reported/observed or contradictory evidence. Implementation Choices are supports, partial, contradicts, insufficient and not-needed. Judge applicability before evidence sufficiency; informational-only work needs no implementation evidence. Positive implementation labels require current passive candidates and accepted task-specific relevance/support judgments, never display-focus attribution or bare self-report. A final completion observation may refresh a coherent retained health card; health still cannot change completion.
- Completion, health, tool evidence and Beads status remain separate. Focus is display/health only, not tool ownership or an execution lock. One first-completion-batch Choice considers all open tasks; present activity/immediate commitment may select, while none/concurrent/uncertain clears focus. When no accepted exclusive focus exists, a last-eligible or oldest-admitted task may be selected as qualified provisional OPEN. This never invents INPROG, completion, or evidence. Safe declared-tool metadata may yield ephemeral provisional focus; final observed membership triggers correction only if its normalized list changed. Unlinked tools cannot establish Observed red.
- Retained cards copy the task label and all five fields coherently at assessment admission, with task/revision/as-of provenance. Actual dispatch timestamps are not assessment times.
- Presentation/debug snapshots are copied, read-only and network-free. No redraw-driven analysis, mutable evidence borrowing or raw provider diagnostics. Trusted colors survive clipping; untrusted controls are sanitized before styling.
- A compact two-row widget, selected-only usage, centered split task board, independent scrolling and task-local debugger are implemented. Right selects only from a safe empty default editor; Enter opens; Escape closes the exact owned overlay. Summary fields have one rendering owner. Static theme-aware styles preserve literal OPEN/INPROG/DONE/ARCHIVED and exact 12-cell progress.
- Optional title/description/acceptance fields are bounded unique canonical quotes, independently Jev-validated at unchanged thresholds. Stale, rejected, hypothetical, inferred and cross-task fields disappear. Optional failures, storage denial and retries never block semantic work. Stuck/drift/meaningful-progress indicators remain deferred.

### Runtime and privacy

- Automatic ON in new sessions requires a Jev key; missing/rejected key means OFF. Only `/progress`, `/progress on`, `/progress off` exist.
- Canonical active-branch IDs/hashes and supported Pi events establish source authority. User/assistant text and inbound `intercom_message` custom messages are task input; intercom retains a distinct role. Idle non-triggering intercom delivery is assessed at the next real turn because Pi provides no public extension hook. Preappend `message_end`, raw tools, arbitrary custom messages, siblings and thinking do not establish authority.
- Whole visible messages, bounded chronological paging, semantic-priority processing, separate bounded optional gateways, cancellation epochs and durable accepted phases. Pending-only semantic retries; no idle polling. Optional details retry only on named later wakes. Selected-model failures wait for explicit recovery.
- The former fresh-user priority lane and early scope cutover are intentionally removed. Large historical backlog may delay new requests; bounded chronology is the supported contract.
- Strict v8 checkpoints persist bounded generated labels, refs, assessment scalars, events, journals, usage, timestamps, task-local health and detail receipts. Unsupported/older or corrupt checkpoints remain OFF: no migration, historical rebuild or rebilling. Accepted same-version phases and receipt-covered optional fields resume without rebilling. No raw conversation, prompts, provider envelopes or credentials persist. Optional canonical mismatches discard only optional facts; mandatory amendments retain existing reconciliation rules. Local checkpoints are trusted writable state, not an adversarial security boundary.
- Context goes to TypeSafe and the selected model provider; calls incur provider charges. README lists concrete caps and storage details.
- Main-session only. Never execute tests/commands, mutate Beads, block tools, cancel reviews or follow child workers. Advisory reconciliation and supported test/review corrections may inject visible messages and trigger or steer a selected-model response under master ON; this can incur additional model/Jev/extraction charges.
- Reconciliation waits 60 seconds after independent run settlement and for semantic readiness. Advisory-only responses never rearm; fresh independent runs may ask again. One finite live delivery chain allows three attempts at nominal 0/2/10 seconds, tolerating duplicates. OFF, navigation, shutdown and reload abandon future attempts; already-invoked messages cannot be retracted. No separate advisory control or durable retry state.
- Reconciliation operates in live TUI/RPC sessions, not print/JSON one-shot mode. Its response uses the unchanged semantic pipeline and thresholds. Advisory custom content belongs to Pi session history, not the progress checkpoint.

## Acceptance

Deterministic mechanics, real-host event/auth tests and explicitly capped paid semantic replays are complementary, not interchangeable. The historical [hybrid acceptance report](docs/design/hybrid-acceptance.md) preserves its failures and limitations. The current UX independent review covers the full UX batch after accepted root `0102cde4`, including manual-feedback fixes, tool focus, optional details and static polish. Green test totals alone do not establish semantic accuracy or owner acceptance.

## Future direction

Owner-authorized advisory epic `pi-progress-barroot-q0n` implements reconciliation and narrow test/review corrections locally; independent B/C local acceptance is complete; human manual acceptance remains pending. Test correction observes proven builtin write/edit attempted starts, even if subsequently blocked, and reuses fresh accepted health necessity facts. Review correction passively observes only a correlated running workflow from the installed pi-subagents named asynchronous `review` resource. Unsupported/unknown/ambiguous authority abstains; there is no review launcher, cancellation or generic tool-name inference. Whole-board bounded corrective classification uses one optional Jev request, not one per task. Existing health judges long-term regression value using the same necessity question; explicit test requirements and existing validation remain binding. Claude/Codex/OpenCode integrations remain outside this candidate. The separately authorized execution-visibility runtime/UI now displays reported current activity and bounded task-local history without changing semantic task state or checkpoint v8. Its independent acceptance is pending. Visibility uses a separate 1,024-call lifetime budget and explicitly incomplete runtime-only history; provisional assistant prose may be sent to Jev before later listeners change it. Confidence-band MAYBE labeling and clarification nudges remain experimental, not enabled. The [canonical advisory contract](docs/design/advisory-nudges.md) governs remaining delivery work; no release/install/push is authorized.

## Development

TypeScript ESM, Bun, Biome, TypeScript, Knip and Vitest; Node >=22.19.0. The UI candidate is pinned to Pi0.85.1; the older development SDK is not a dual-host support promise. Historical [design documents](docs/design/README.md) are background, not authority over this contract.
