# pi-progress-bar

A progress and task-health widget for Pi with advisory status reconciliation. **Jev gates scope and judges completion; your selected Pi model extracts grounded tasks.** Code owns IDs, lifecycle, bounds and counting. It never executes your tasks or blocks tools. Its status reminders can wake the agent to answer.

## Install

Requires Node.js >=22.19.0, a configured selected Pi model, and `TYPESAFE_API_KEY`. This local UI candidate is validated against Pi **0.85.1**. The older development dependency is not a dual-host support promise.

```sh
pi install git:github.com/vedang/pi-progress-bar
# Or use a local checkout:
pi install /absolute/path/to/pi-progress-bar.root
```

Provide `TYPESAFE_API_KEY` through your environment; keep it out of tracked configuration. Installing with the key enables automatic monitoring and paid provider calls. The selected model uses **Pi-managed authentication**, not a second key copied into this extension. After updating an installed package, reload/restart Pi to load the new code.

```text
/progress       Show state, service, separate provider usage and help
/progress on    Enable or resume monitoring
/progress off   Cancel monitoring and hide the widget
```

New sessions default ON, including reconciliation reminders and supported corrective advice; there is no separate advisory toggle. Missing/rejected Jev credentials leave the monitor OFF. A temporarily unavailable selected model holds its pending phase until an explicit model selection, OFF/ON, or reload; it does not silently switch providers. The agent itself continues working.

## How progress works

1. Read whole visible user/assistant messages and inbound `intercom_message` custom messages from the **active canonical branch**, in chronological order. Delegation retains a distinct `intercom` source role; arbitrary custom messages, audit receipts and tool results are not task input. Triggered, steering and follow-up intercom deliveries are observed at normal agent lifecycle boundaries. Pi emits no public extension hook for idle custom delivery without a triggered turn, so that delivery is assessed on the next real turn (no polling).
2. Ask pinned `jev-1.13.0` whether task scope changed. Only confidently **unchanged** skips extraction. Gate confidence must be >=0.5 and selected probability >=0.8; uncertainty remains distinct from a confident negative.
3. When needed, ask the **currently selected Pi model** for a strict grounded task patch. New tasks can be action or response deliverables. A new question after completed work can create a new response task, even on the same topic. User approvals and other people's work are not assistant tasks.
4. Independently ask Jev about each included task. Completion of an earlier task is **not** a prerequisite for completing later tasks. Newly extracted tasks can be assessed in the same observation. Done tasks receive a separate withdrawal judgment.
5. The first completion batch also selects current activity from **all open tasks**. Present activity or an immediate explicit commitment may select one task; no-match, concurrency or uncertainty clears focus rather than guessing. This semantic selector does not treat requests, quoted intent or raw tool bodies as present activity; the separate safe-metadata tool selector is described below. Focus selects displayed activity, never health eligibility, task completion or tool ownership. Each task's health is assessed independently; all-done health can remain explicitly retained.

See the [Jev batching audit](docs/design/jev-batching.md) for call boundaries and durability constraints.

Reported fraction = done / included tasks. It is not effort, ETA, code correctness or an execution lock. Semantic judgments can miss work or abstain; a finite test suite is not an accuracy guarantee.

Task IDs are code-generated. Wording edits preserve completion; changed requirements increment the task revision and reopen its work. Explicit withdrawal reopens only the affected completed task. Archiving removes a task from the denominator without completing it; restoring preserves its identity/history.

## Reconciliation reminders

In live TUI and RPC sessions, an independently started agent run settling with unfinished tasks arms a **60-second** deadline. The extension asks for each pending task's actual status only after task analysis settles; late analysis does not restart the minute. A response solely to this reminder does not rearm it. A later independent run can ask again, even if the board is unchanged.

The reminder is a visible custom conversation message and can **trigger a selected-model turn**, incurring model charges and ordinary Jev/extraction processing of its response. Existing evidence processing and completion thresholds remain unchanged; a reminder never directly marks work done. Uncertain delivery allows up to three attempts, at nominal 0/2/10 seconds; occasional duplicate reminders are possible. Retries and pending reminders are discarded on reload, navigation, shutdown or master OFF. Already-invoked messages cannot be retracted.

Corrective advice can steer an active run immediately, without a cooldown:

- **New failing tests:** proven builtin `write`/`edit` attempted starts are assessed against the whole included task board and bounded conversation context. An already accepted, current **Not needed** health judgment is reused; there is no second necessity assessment. An attempted call can qualify even if Pi subsequently blocks it. Explicit test requirements and existing validation remain binding.
- **Premature reviews:** only the installed `nicobailon/pi-subagents` package's named asynchronous `{workflow: "review", args: {...}, async: true}` route is supported, after a correlated successful running-workflow receipt. Foreground calls, raw workflow scripts, generic reviewer names, shell commands and unsupported registrations abstain. Explicit review requests, security/risk checks and blockers protect required review. The extension never launches or cancels a child.

Each correction uses one bounded Jev request covering every included task; unknown, ambiguous, oversized or stale evidence abstains. Duplicate events and continued attempts do not intentionally repeat advice; a genuinely new attempt can. Corrections share the reminder's finite delivery retries and may incur additional Jev and selected-model charges. Advice never directly changes task status or blocks a tool.

`/progress off` disables monitoring and future advice, not an already-running agent. Print/JSON one-shot sessions do not send advice; RPC must remain connected. Advisory capabilities are independently locally accepted; human manual testing remains pending. No release is implied.

## Live execution visibility

The widget now shows changing current activity, while the board keeps stable semantic tasks and adds **Current Activity** and task-local **Meaningful Actions**. Assistant prose is labeled **Agent says** or **Agent reported**, not verified execution. Tool phases are generic and unattributed. Visibility never changes task status, completion counts, health, or advisory authority.

Visibility is runtime-only: **Since monitoring resumed · history may be incomplete**. History survives successive agent runs, but clears on OFF/reload, navigation, source changes or amendments. Nothing is restored or backfilled. It retains at most 48 actions, 16 per task; current reports expire for admission after five seconds. Missing, oversized, stale or ambiguous evidence may be omitted. The owner accepted a known residual ambiguous task assignment in the calibration corpus; this display is not a correctness guarantee.

Optional visibility classification has separate usage accounting and a **1,024-call monitoring-lifetime budget**. At exhaustion, inferred labels/history stop with an explicit warning; local tool activity continues. Existing semantic/activity-focus calls are separate and are not covered by this budget.

**Additional privacy disclosure:** visible assistant prose is sent to Jev for exact-excerpt selection and task binding. Provisional prose may be sent at `message_end` before a later extension changes/removes it; only exact canonical confirmation permits task-bound history. Prose can contain copied code, URLs, output or secrets. Terminal sanitization is not secret redaction. The new tool-phase path sends no provider payload and exposes no raw paths, commands, arguments or outputs; existing activity-focus inference retains its previously documented metadata behavior.

Task ownership confidence is visible without changing semantic task state: Stage-2 binding confidence **≥0.9** is shown normally; **0.8–<0.9** shows `(MAYBE)` beside the current/history task association; below 0.8 stays task-unconfirmed. The selected-probability gate remains **≥0.8** in every band. Stage-1 report selection remains unchanged at confidence **≥0.5** plus probability **≥0.8**.

At the existing 60-second run-end reconciliation, up to eight current-open-task `(MAYBE)` receipts are appended as JSON-escaped, untrusted reported data. The agent is asked which board task, `other`, or `unknown` each concerns, then for actual status. This adds no separate timer/message chain, does not wake an all-done board, and no generic status reply silently resolves an ownership receipt. Runtime/UI and MAYBE clarification are independently locally accepted through `8144d354` (review `73c1b12f`): 917 unit tests and 71 integration tests on each Pi host pass. Human manual testing remains pending; no release is implied.

## Reading the widget

The below-editor widget shows the literal reported fraction, a 12-cell bar, last Jev dispatch time, and a named current task when eligible work exists. An initial selection is qualified **OPEN**, not invented activity. Accepted exclusive focus is **INPROG**; only accepted completion yields **DONE**. Archived tasks remain **ARCHIVED** in the board.

With an empty default editor, **Right** selects the widget and reveals separate provider call/token usage; **Enter** opens the centered task board. **Left/Escape** returns selection. The board shows newest-created tasks first, with independent list/detail scrolling: arrows/PgUp/PgDn navigate, Left/Right/Tab select a pane, **d** toggles task-local diagnostics, and **Escape** closes it. Selection is local and does not edit tasks or trigger analysis. Custom editors and focused overlays retain their input ownership.

The board's single-copy Summary has five separate signals, in order:

| Field | Meaning |
|---|---|
| Requirements | Clarity of supplied requirements, not code quality |
| Acceptance | Whether observable success conditions are supplied |
| New red test | Whether a new failing test offers long-term regression value or is explicitly required; never permission to skip existing validation |
| Red evidence | Reported failing-test evidence, not automatically verified execution |
| Implementation | Not needed, appears complete, partial, contradicted or unverified, based on the task's implementation requirements and evidence |

`Unassessed` means no valid assessment has been admitted yet. `Unknown` and `unverified` mean assessed uncertainty or insufficient evidence, not failure. These fields never establish reported completion.

Health no longer requires exclusive focus. Included open tasks refresh after committed observations; new/revised tasks have their own assessment path. Newly done tasks get a terminal-report assessment even when other work remains open. A valid terminal card is not refreshed merely because later reports arrive; reopening, task restore, revision or card loss/invalidation can make it eligible again. Archived tasks retain valid cards but receive no new work. Checkpoint reload is distinct from restoring an archived task.

Coalescing preserves bounded chronological report context: up to 16 whole observations within 4KiB of serialized reports. Missing/oversized coverage is explicit; omitted reports cannot establish that no failing-test report exists. Positive or contradictory red reports still require task-specific judgment. Deterministic tests establish request coverage and isolated result admission—not real Jev linking accuracy.

Red evidence derives **Not needed** from new-red-test applicability when no actual red evidence takes precedence; a reported failing test is not hidden merely because it was unnecessary. For implementation, informational-only tasks can be **Not needed** without code evidence. Implementation work instead requires bounded current code/test facts plus Jev's assessment of their relevance to the exact task and revision. Facts are candidates, not automatically owned by the focused task. Accepted implementation choices require confidence >=0.5 and selected probability >=0.8; bare self-reports, missing/stale facts or red-only evidence cannot produce a positive implementation label. Explicit partial support can represent incomplete implementation of a single deliverable. A completion report can receive a final health assessment, retained coherently afterward; implementation health never marks a task done.

**Focus selects displayed activity, not health eligibility.** It does not assign tools or execution to a task. Unlinked tool output cannot establish Observed red or completion. Exact admitted Beads IDs may receive read-only export metadata; Beads status never imports backlog or changes task completion.

Valid same-revision cards remain coherent **retained / as-of / replacement pending** facts while replacements wait. Changed task revisions/sources immediately lose obsolete health. Background assessments never choose the displayed task, including when all tasks finish. The label and all five fields are copied together. Assessment time is separate from **actual Jev and extraction dispatch time**, including failed attempts. Redraws do not change these facts or initiate requests. Trusted theme colors are preserved; untrusted text controls are sanitized before styling.

Unresolved/previous scope has no misleading current percentage. Bare `/progress` shows service and provider usage; the normal widget does not dump raw diagnostic codes. The task-local debugger is available only inside the board; there is no separate `/progress debugger` command. Styling is static and theme-aware; no animation, polling, or interpolated progress is used.

Optional **Task Title**, **Description**, and **Acceptance Criteria** appear only for unique exact canonical quotes independently accepted by Jev at confidence >=0.5 and probability >=0.8. Inferred, ambiguous, rejected, stale, or cross-task fields are omitted—not filled with placeholders. The tracked task label always remains. Optional detail failure or storage denial never blocks mandatory task tracking.

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
| Safe tool-focus envelope | 4KiB, all-or-nothing |
| Optional quoted details | Title 120; description 800; up to 6 criteria of 240 Unicode scalars each |
| Health jobs / transport flight | 20 included task identities / 1 health flight |
| Health report context | 16 whole observations / 4KiB serialized reports; bounded scan and explicit omissions |

Catch-up is chronological, not a fresh-message priority lane. Large history can therefore delay the newest request. Oversized messages are not partially interpreted. Capacity limits reject further mutation rather than evict accepted obligations. There is no automatic context compaction or unlimited-history promise.

Semantic work has priority over optional health, tool-focus, and grounded-detail jobs. Optional jobs, including corrective classification, use separate bounded gateway state; this is not a single global provider-flight guarantee. New semantic evidence fences stale optional work. Accepted gate/patch/completion phases are checkpointed so eligible retries resume unfinished work rather than rebilling accepted phases. Semantic Jev failures use pending-only backoff/Retry-After. Health has no retry timer: transient failures require both deadline expiry and a later canonical commit, validated passive-evidence change, or ON/restore/model recovery. Idle failures may remain parked until that event; redraws never poll. Invalid input/result and capacity failures are terminal for their input/state identity until changed input/capacity or explicit recovery; permanent health failures require explicit recovery. No extraction repair loop or hidden model retry is used.

After semantic work settles, ready health runs fairly before optional details; parked health does not block details. Every ready job gets an attempt before a task gets a second, subject to gateway-wide backoff/capacity. Eventual assessment requires monitoring ON, valid authority, finite settled semantic work, available provider and admissible capacity. There is no wall-clock guarantee during endless semantic backlog.

Health cost per settled observation is the sum of bounded request batches for eligible tasks—not necessarily one call per task. Coalescing reduces overlapping pending work only; sequential observations can each refresh all open tasks. Retries, preemption and crash-before-receipt can add charges. **No lifetime health-call/spend cap exists**; queue/request bounds and the separate visibility budget are not health spend caps.

Each visible observation may incur a Jev gate plus completion/health requests. Extraction also incurs your selected provider's charges. Tool-only/thinking-only/blank messages do not trigger semantic task analysis. Declared tools can trigger an immediate optional provisional focus judgment; final observed tool membership triggers a correction only when its normalized list changed. Unchanged lists cause no duplicate judgment. Only tool names, safe repository-relative paths and fixed shell categories are sent—never raw commands, arguments, results, errors or runtime call IDs. This ephemeral focus cannot complete tasks or establish evidence. `/progress off` stops extension analysis, not the main agent.

## Privacy and storage

Bounded conversation/task excerpts go to **TypeSafe** (`https://api.typesafe.ai/v1/systemone`) and, when extraction is needed, to **your selected Pi model provider**. This is not local-only processing.

Strict **v9** checkpoints persist bounded generated task labels, IDs/revisions, source hashes/ranges, assessment scalars, immutable mutation events, pending-phase journals, usage, dispatch timestamps, task-local health facts, bounded report-coverage references/hashes/omissions, and optional detail validation receipts. They do **not** persist full source messages, prompts, provider envelopes, reasoning, tool bodies or credentials. Advisory attempt history, health-eligibility copies, delivery identities and timers are ephemeral; reload abandons them. Source references must resolve against the active branch. Checkpoints are trusted writable local state, not cryptographic protection against deliberate tampering.

Older checkpoints, including v8, and corrupt storage leave monitoring **OFF** with a fresh-session warning—**no migration or historical rebuilding/rebilling**. Test this candidate in a fresh session. Accepted same-version phases and saved detail receipts resume without rebilling covered work. Matching health coverage reloads as retained, not live proof, without rebilling merely because runtime evidence was lost. Missing/stale open cards recover from the canonical cursor; missing/stale done cards use their completion report. Optional coverage changes invalidate only affected health, not accepted semantic phases. Every new checkpoint must also fit its OFF representation. A same-version checkpoint that fits only while ON remains effectively OFF, preserving accepted work and telemetry. Canonical amendments invalidate stale derived references; optional-only detail mismatches drop those details without semantic replay. No local receipt can prevent remote billing if the process dies after provider acceptance but before the receipt is saved.

The extension does not run commands/tests, mutate Beads, replace or block tools, cancel reviews, or follow child/sibling sessions. It does inject the reconciliation questions described above. Their content and answers may be retained in Pi's canonical session history; this is separate from the bounded v9 progress checkpoint.

## Development and evidence

```sh
bun install --frozen-lockfile
make format
make check
make test
npm pack --dry-run --json
```

Default tests are offline. Actual-host tests use a faux provider and synthetic in-memory credentials, exercising canonical events and real selected-model/auth dispatch. Separate paid replay is explicitly capped and opt-in: see [live QA instructions](__tests__/live/README.md).

[Local UX candidate acceptance](docs/design/ux-acceptance.md) records the reviewed revision, QA results, load command and manual checklist. [Historical hybrid acceptance evidence](docs/design/hybrid-acceptance.md) records earlier tested cases, failures and limitations. [Presentation handoff](docs/design/hybrid-presentation.md) documents the read-only UI/debugger seam. Historical design documents describe older releases; [PRODUCT.md](PRODUCT.md) governs the current hybrid contract.
