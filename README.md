# pi-progress-bar

Automatic, passive reported-progress and current-task health widget for Pi. Uses TypeSafe Jev
`jev-1.13.0` for semantic judgments; code owns task IDs, state transitions, counting, provenance,
and every display label. V7 stuck/drift/meaningful-progress signals are not implemented.

## Install and run

Requirements: Node.js >=22.19.0, Pi tested at
`@earendil-works/pi-coding-agent` 0.84.2, and a nonblank `TYPESAFE_API_KEY`.

```sh
export TYPESAFE_API_KEY='...'
pi install /absolute/path/to/pi-progress-bar.root
# or try without installing:
pi -e /absolute/path/to/pi-progress-bar.root
```

Monitoring starts automatically for each new session. Missing, blank, or rejected credentials emit
one error and leave monitoring OFF; there is no local-only fallback. Reload restores current-session
controls. New sessions default ON. Analysis is event-driven from canonical Pi branch observations,
not a periodic poller.

## Commands

```text
/progress                         show state and usage
/progress on                      start/resume automatic catch-up
/progress off                     abort work, stop collection/network, hide widget
```

No source picker, consent dialog, manual checklist/current-task control, details inspector,
enable/pause/resume aliases, or compatibility commands exist.

## What it reports

- **Reported progress:** completed / active automatically discovered tasks. Explicit conversation
  reports own done/reopen/cancel state; cancelled work leaves the active denominator and can re-enter
  when explicitly reopened. Percentage is never effort, ETA, or correctness.
- **Task card:** Jev-selected current work is authoritative for analysis. When that selection is
  unknown, the widget can show a deterministic **Selected task (current unknown)** reference. When
  an assessed task completes or replacement assessment is pending, it keeps a clearly labelled
  **Last task • retained last assessed as-of ...** card. This is display continuity only: it never
  sets `currentTaskId`, changes reported completion, or supplies an evidence link. At assessment
  time its five display labels are copied as immutable presentation values, so later evidence or
  health objects cannot relabel a retained card. Cards are memory-only and disappear when their
  original task span is unavailable on the active branch.
- **Requirements:** task-local Jev clarity score rendered with local labels (`unknown`, `unclear`,
  `partly clear`, `mostly clear`, or `clear`). It measures whether supplied requirements are usable,
  not implementation quality.
- **Acceptance:** task-local Jev judgment of observable success conditions (`explicit`, `partial`,
  `not-found-in-context`, or `unknown`). It does not claim tests exist or pass.
- **New red test:** whether a new failing regression would be useful for this task (`Needed`,
  `Not needed`, or `Unknown`), distinct from whether any test was observed.
- **Red evidence:** task-linked provenance: `Reported red` is an explicit agent assertion;
  `Observed red` is bounded runner evidence; contradiction and unknown remain distinct.
- **Implementation:** per-criterion Jev Choices aggregate locally to `appears complete`, `partial`,
  `contradicted`, or `unverified`. This is evidence assessment, not proof of arbitrary correctness.
  `unknown` and `unverified` mean supplied evidence was insufficient, not failure; a reported-done
  task can therefore remain unverified.
- **Beads:** exact issue IDs already present in admitted tasks may be enriched from the conventional
  workspace `.beads/issues.jsonl`. Export status can show disagreement but never changes reported
  completion or imports the backlog.

- **Last Jev call:** widget and bare `/progress` show the last actual HTTP dispatch for this
  monitoring runtime, as local date/time and age, or `Never`. It updates before every dispatched
  fetch, including failure/timeout, but not on redraws, cached unchanged input, missing credentials,
  or retry-backoff. It is memory-only and resets for a fresh runtime.

Substantive user directives, questions, explanation/status/plan requests and corrections are all
supplied to Jev as possible work using exact source spans. Jev classifies a task as an **action**
deliverable or a **response** deliverable; code never guesses that kind from wording. Jev also
decides whether each is new, revised, same, context, or ambiguous. Approvals/clarifications can
remain linked context; quoted examples, reports, hypotheticals and empty turns do not fabricate
work. Assistant plans remain eligible only with applicable user grounding.

Unknown current task, ambiguous scope, missing originals, stale evidence, unsupported formats, or
overflow remain unknown/stale rather than guessed. `/progress` and the widget show a local
progress state (`Catching up history`, `Scope unresolved`, `Current task unknown`, `No new
evidence`, or transport/controller failure) plus capped aggregate reason-code counts. Bare
`/progress` also shows current service error/backoff wording when present. These diagnostics contain
neither conversation text nor credentials.

## Runtime bounds and privacy

The extension reads only finalized visible user/assistant entries from
`ctx.sessionManager.getBranch()`. It excludes siblings/children, system/thinking/private content,
summaries as authority, generic tool bodies, and its own checkpoints. Discovery catches up through
chronological windows of at most 512 entries / 256 KiB, committing a hash/offset cursor; retained
source references are rehydrated only from the live active branch, including after a reload beyond
one discovery window. Exact original offsets are preserved. Partial scope/report journals retain
only canonical source ranges, IDs, enum decisions, and request identities; an unkeyed digest detects
accidental or unrecomputed corruption before replay. Requests are at most 24 KiB and 20 questions; responses at most 128 KiB. Discovery carries
exact source spans, role, and bounded preceding visible user direction. New checkpoints use strict
schema v4 and require explicit `action` or `response` work kinds for every source span and saved
task; v3, obsolete polling fields (including `interval`), and malformed shapes rebuild from the
active branch rather than migrate. A newly observed user candidate keeps its exact ID/hash in a
bounded fresh lane outside the normal history window.
When fresh and historical work both run, no class receives more than two consecutive dispatches.
Only a complete, single-chunk, high-confidence `new-goal` transaction with all-new relations can
replace current scope early; all other outcomes return to chronological reconciliation. Preceding
direction grounds assistant plans without vetoing a new user request. It processes one chronological
observation through selection/classification, scope/current reconciliation, and then that
observation's report cursor; a later goal cannot affect an earlier report. Action-task reports remain bounded multi-task batches. Each Jev-classified response task
uses one small target-local report request with full lifecycle and current-task choices, so an answer
about unfinished implementation is not confused with completing that implementation; this can add
one paid request per response task. Uncertain source, identity, scope, or current-task Choices
abstain instead of mutating state. One request is in flight. Relevant canonical branch and tool
observations coalesce into finite local catch-up, yielding between bounded dispatches; idle redraws,
clocks, and unchanged snapshots dispatch nothing. Transient failures use bounded exponential
backoff, Retry-After, three-attempt bursts, and five-minute cooldown/probe behavior with one
pending-work retry wakeup. There is no lifetime request wall.

Installing with a key automatically sends bounded relevant conversation/task/evidence excerpts to
`https://api.typesafe.ai/v1/systemone`; this may incur TypeSafe charges. Event-driven catch-up can
dispatch more promptly than former cadence-based analysis, so it is not free and users should
expect charges for each bounded semantic transition. Original-delivery live validation used 16
requests. Separate completed repair-validation snapshot used 134 attempts
(162,554 input and 29,207 output tokens, including two failed runs).
Retained-task/conversational-work validation used 395 attempts (415,360 input and
70,355 output tokens), including failed/interrupted runs and diagnostic probes.
The final full suite passed 15/15 with 53 requests (56,701 input / 9,580 output tokens);
No probabilistic accuracy guarantee is implied. User has authorized broader
paid evaluation, but live runs remain explicitly finite and manual. Credentials, raw remote responses, retained card text and last-dispatch timestamps are never
checkpointed. Checkpoints are trusted writable local session state: journal
digests detect accidental or unrecomputed corruption, not deliberate edits that recompute them.
Runtime has no simulated model or provider fallback.

## Supported passive evidence

Live main-session Pi `tool_execution_start/end` pairs are bound by `toolCallId`, tool name, and
order. Current support is intentionally narrow:

- `bash`: recognized test-runner commands plus assertion-failure output for Observed red; a nonzero
  exit, crash, missing dependency, or filename alone is insufficient. Passing output is retained as
  bounded test evidence.
- `edit` / `write`: successful bounded path-level code-change facts and revision aging.
- Conversation assertions can establish Reported red through Jev without observed execution.

Unsupported runners/results remain unknown. The extension never executes commands, tests, `br`/`bd`,
reads arbitrary source files, injects agent messages, replaces tools, mutates issues, or monitors
child/sibling sessions.

## Development

```sh
bun install --frozen-lockfile
make format
make check
make test
npm pack --dry-run
```

Automated tests are offline and use injected schema-valid transport responses. Real-Jev validation
is a separate bounded release gate.
