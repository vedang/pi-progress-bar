# pi-progress-bar

A passive progress and task-health widget for Pi. **Jev gates scope and judges completion; your selected Pi model extracts grounded tasks.** Code owns IDs, lifecycle, bounds and counting. It never executes your tasks or controls the agent.

## Install

Requires Node.js >=22.19.0, a configured selected Pi model, and `TYPESAFE_API_KEY`. Host integration is tested with Pi **0.84.2** (pi-ai0.84.4) and **0.85.1**.

```sh
pi install git:github.com/vedang/pi-progress-bar
# Or use a local checkout:
pi install /absolute/path/to/pi-progress-bar.root
```

Provide `TYPESAFE_API_KEY` through your environment; keep it out of tracked configuration. Installing with the key enables automatic monitoring and paid provider calls. The selected model uses **Pi-managed authentication**, not a second key copied into this extension. After updating an installed package, reload/restart Pi to load the new code.

```text
/progress       Show state, separate provider usage, diagnostics and help
/progress on    Enable or resume monitoring
/progress off   Cancel monitoring and hide the widget
```

New sessions default ON. Missing/rejected Jev credentials leave the monitor OFF. A temporarily unavailable selected model holds its pending phase until an explicit model selection, OFF/ON, or reload; it does not silently switch providers. The agent itself continues working.

## How progress works

1. Read whole visible user/assistant messages and inbound `intercom_message` custom messages from the **active canonical branch**, in chronological order. Delegation retains a distinct `intercom` source role; arbitrary custom messages, audit receipts and tool results are not task input. Triggered, steering and follow-up intercom deliveries are observed at normal agent lifecycle boundaries. Pi emits no public extension hook for idle custom delivery without a triggered turn, so that delivery is assessed on the next real turn (no polling).
2. Ask pinned `jev-1.13.0` whether task scope changed. Only confidently **unchanged** skips extraction. Gate confidence must be >=0.5 and selected probability >=0.8; uncertainty remains distinct from a confident negative.
3. When needed, ask the **currently selected Pi model** for a strict grounded task patch. New tasks can be action or response deliverables. A new question after completed work can create a new response task, even on the same topic. User approvals and other people's work are not assistant tasks.
4. Independently ask Jev about each included task. Completion of an earlier task is **not** a prerequisite for completing later tasks. Newly extracted tasks can be assessed in the same observation. Done tasks receive a separate withdrawal judgment.

Reported fraction = done / included tasks. It is not effort, ETA, code correctness or an execution lock. Semantic judgments can miss work or abstain; a finite test suite is not an accuracy guarantee.

Task IDs are code-generated. Wording edits preserve completion; changed requirements increment the task revision and reopen its work. Explicit withdrawal reopens only the affected completed task. Archiving removes a task from the denominator without completing it; restoring preserves its identity/history.

## Reading the widget

The task card has five separate signals, in order:

| Field | Meaning |
|---|---|
| Requirements | Clarity of supplied requirements, not code quality |
| Acceptance | Whether observable success conditions are supplied |
| New red test | Whether a new failing regression test would be useful |
| Red evidence | Reported failing-test evidence, not automatically verified execution |
| Implementation | Not needed, appears complete, partial, contradicted or unverified, based on the task's implementation requirements and evidence |

`Unknown` and `unverified` mean insufficient evidence, not failure. These health fields never establish reported completion.

Red evidence derives **Not needed** from new-red-test applicability when no actual red evidence takes precedence; a reported failing test is not hidden merely because it was unnecessary. For implementation, informational-only tasks can be **Not needed** without code evidence. Implementation work instead requires bounded current code/test facts plus Jev's assessment of their relevance to the exact task and revision. Facts are candidates, not automatically owned by the focused task. Accepted implementation choices require confidence >=0.5 and selected probability >=0.8; bare self-reports, missing/stale facts or red-only evidence cannot produce a positive implementation label. Explicit partial support can represent incomplete implementation of a single deliverable. A completion report can receive a final health assessment, retained coherently afterward; implementation health never marks a task done.

**Focus is display/health selection only.** It does not assign tools or execution to a task. Unlinked tool output cannot establish Observed red or completion. Exact admitted Beads IDs may receive read-only export metadata; Beads status never imports backlog or changes task completion.

Completed or replaced tasks retain a coherent **retained / as-of / replacement pending** card until a new assessment is admitted. The label and all five fields are copied together. Assessment time is separate from **actual Jev and extraction dispatch time**, including failed attempts. Redraws do not change these facts or initiate requests. Trusted theme colors are preserved; untrusted text controls are sanitized before styling.

Unresolved/previous scope has no misleading current percentage. Bare `/progress` exposes safe, capped diagnostic counts; the normal widget does not dump raw diagnostic codes. The full debugger modal and wider UI redesign are **not implemented**.

## Limits and costs

| Boundary | Limit |
|---|---|
| Included / total tasks | 20 / 200 |
| Immutable mutation events / checkpoint | 1,000 / 512KiB |
| Generated label | 240 characters |
| Canonical page | 64 messages / 256KiB |
| Latest whole message | 12KiB |
| Earlier context | At most 2 messages / 4KiB |
| Jev request | 24KiB / 20 questions |
| Jev response / deadline | 128KiB / 10 seconds |
| Extraction input / output text | 24KiB / 32KiB |
| Extraction output tokens / owned deadline | 2,048 / 60 seconds |
| Patch operations | 6 additions; 12 each revisions, archives and restores |

Catch-up is chronological, not a fresh-message priority lane. Large history can therefore delay the newest request. Oversized messages are not partially interpreted. Capacity limits reject further mutation rather than evict accepted obligations. There is no automatic context compaction or unlimited-history promise.

One controlled analysis flight is active across semantic and optional health work. New semantic evidence takes priority over stale optional health. Accepted gate/patch/completion phases are checkpointed so eligible retries resume unfinished work rather than rebilling accepted phases. Jev transient failures use pending-only backoff/Retry-After; idle time and redraws never poll. No extraction repair loop or hidden model retry is used.

Each visible observation may incur a Jev gate plus completion/health requests. Extraction also incurs your selected provider's charges. Tool-only/thinking-only/blank messages do not trigger semantic analysis. `/progress off` stops extension analysis, not the main agent.

## Privacy and storage

Bounded conversation/task excerpts go to **TypeSafe** (`https://api.typesafe.ai/v1/systemone`) and, when extraction is needed, to **your selected Pi model provider**. This is not local-only processing.

Strict **v5** checkpoints persist bounded generated task labels, IDs/revisions, source hashes/ranges, assessment scalars, immutable mutation events, pending-phase journals, usage, dispatch timestamps and retained health-card metadata. They do **not** persist full source messages, prompts, provider envelopes, reasoning, tool bodies or credentials. Source references must resolve against the active branch. Checkpoints are trusted writable local state, not cryptographic protection against deliberate tampering.

Old v4 checkpoints are rejected and rebuilt from canonical history—**no migration**. Canonical source amendments invalidate stale derived references and trigger bounded reconciliation. v5 intentionally supersedes the old reference-only/no-generated-label privacy contract.

The extension does not run commands/tests, mutate Beads, inject conversation messages, replace tools, follow child/sibling sessions, or send advisory nudges.

## Development and evidence

```sh
bun install --frozen-lockfile
make format
make check
make test
npm pack --dry-run --json
```

Default tests are offline. Actual-host tests use a faux provider and synthetic in-memory credentials, exercising canonical events and real selected-model/auth dispatch. Separate paid replay is explicitly capped and opt-in: see [live QA instructions](__tests__/live/README.md).

[Hybrid acceptance evidence](docs/design/hybrid-acceptance.md) records exact tested cases, failures and limitations. [Presentation handoff](docs/design/hybrid-presentation.md) documents the read-only UI/debugger seam. Historical design documents describe older releases; [PRODUCT.md](PRODUCT.md) governs the current hybrid contract.
