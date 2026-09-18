# pi-progress-bar

> **Replacement planned:** Beads epic `pi-progress-barroot-pyp` contains the self-contained implementation backlog for automatic, default-on, key-required Jev monitoring through V6. See [PRODUCT.md](PRODUCT.md) for the corrected contract. The commands below describe the **existing manual-workflow version**, not the new target behavior.

Read-only reported checklist progress with optional, consented experimental Jev
requirements-clarity, acceptance and conversation plan/report signals for Pi (V1–V3). Tested with
`@earendil-works/pi-coding-agent` 0.84.2; Node.js >=22.19.0.
Load with `pi -e ./src/index.ts` or install this directory as a Pi package.

## Commands

- `/progress`: native source/details/interval/analysis picker.
- `/progress source plan.md#Tasks`: draft a source, choose included task numbers
  (blank includes all), select current task (default Unknown), then explicitly Apply.
  Escape or declining confirmation leaves active selection unchanged.
- `/progress source conversation`: choose a consented Jev plan suggestion, use the
  same scope/current-task controls, then explicitly Apply. Apply resets consent;
  enable again to interpret subsequent reports. No guessed denominator or automatic
  source replacement.
- `/progress source conversation#entryId`: narrow discovery to a known visible
  active-branch entry omitted from the shortlist. With consent, wait for its suggestion
  and run the command again. Without consent, enable first.
- `/progress details`: read-only source, scope, task states and current-task inspector,
  plus raw questions/answers, score legend, probabilities, confidence, evidence,
  omissions, model, usage and inference/evidence timestamps.
- `/progress enable`: review third-party transfer, current payload and paid-work
  limits, then explicitly confirm. Declining sends nothing.
- `/progress pause`: abort/invalidate analysis; local counting continues.
- `/progress resume`: retry under existing consent, subject to rate/Retry-After and
  remaining budget. Without consent, use enable first.
- `/progress interval 5`: replace refresh timer. Default 15 seconds; supported range
  0.001–2147483.647 seconds.

Use unindented `- [ ]`, `- [x]` or `- [X]` checklist items under an ATX heading.
Indented criteria do not increase the denominator; fenced examples are ignored.
Without `#Section`, a document must contain one unambiguous direct task list.
Mixed syntax, ambiguous duplicates and scopes over 200 tasks are rejected.
Optional `<!-- progress:id=token -->` anchors preserve identity across renames;
otherwise only unique exact task text preserves identity. The monitor never edits files.

Reads accept workspace-relative regular `.md` files up to 256 KiB. Symlinks,
hidden/private paths and paths outside the workspace are rejected. Failed reads keep
last complete counts explicitly stale. Source additions are excluded after explicit
scope selection until selected again.

TUI shows a theme-aware, width-safe named widget. RPC uses native dialogs but no
terminal widget. Reload and tree navigation re-read current-branch source references;
checkpoints contain IDs/hash mappings, scope and interval metadata, not task bodies.
Missing current-branch checkpoints clear the selection. Current task is manual; never
first unchecked. Widget excerpts and visual rows are bounded. Select a long inspector
row, then an evidence page, for full sanitized raw evidence.

Counts describe file-reported or **Conversation-reported** completion, **not observed
completion or verified correctness**. Health
results never update completion counts. No agent messages, project commands, tool
replacement, scripts or project tests are run by the monitor.

## Optional experimental task signals

Set `TYPESAFE_API_KEY` in Pi's environment, select a source and current task, then
run `/progress enable`. Missing key stays offline without spending an attempt.
Network is disabled until confirmation. The only endpoint is
`https://api.typesafe.ai/v1/systemone`, pinned to `jev-1.13.0`; no SDK, alias fallback,
or second network client. Credentials, consent and raw responses are never persisted.

One request evaluates **clarity on a 0–3 rubric** and **acceptance criteria**
(explicit, partial, not-found-in-context, unknown). These are judgments, not completion
percentages, proof of correctness, or proof executable tests exist/pass. The selected
task is the task-local goal; its full text and owned criteria are included. Broader
project goal, other tasks, implementation and test results are explicitly omitted when
unavailable. Confirmed conversation-source context supplies actual goal/context when
present; otherwise the inspector retains the task-local omission. Unknown current task, stale source or oversized essential evidence yields
Unknown without a request; evidence is never silently clipped.

Consent covers future visible user/assistant text on the active branch and revisions of
the selected source in this session. The disclosure shows bounded discovery, report
and health payloads when available, before any transfer. Enable without a file source
allows conversation discovery. Selecting a
source again, tree navigation, session replacement and reload reset consent. Changed
relevant task evidence invalidates pending results without revoking same-source consent.
Checkbox-only refreshes do not spend another request. Paused or unavailable results
retain an explicit as-of/aged label; cross-task results are discarded.

Limits: 24 KiB serialized requests, 20 questions, 128 KiB response reads, one logical
request in flight, 10-second deadline, at most one dispatch per 15 seconds independent
of display refresh, and 60 attempts per explicit enablement (failures count). Enable
requires confirmation again to renew the budget. Unchanged successes and failures
are not resent on ticks. New relevant evidence or explicit resume permits work;
server Retry-After still applies. No automatic retries. Transport that ignores abort
cannot block the monitor or admit a late response.

Host behavior is tested with injected schema-valid responses, not live accuracy
validation. All semantic signals remain **experimental**. Beads integration, code/test
assessment and child monitoring are not implemented.

## Conversation source and ordered reports

Only `ctx.sessionManager.getBranch()` supplies history: never all entries, siblings or
child logs. Reads refresh on the local timer and agent-settled events. Pi's message-end
hook can run before persistence; it wakes analysis but does not guarantee immediate
capture. Monitor checkpoint appends are not branch switches.

Normalization deduplicates entry IDs and excludes system/thinking/private shell,
all tool bodies, summaries and monitor metadata as authority. Existing compaction
or branch summaries do not invalidate retained original ancestors. Missing parents,
changed IDs, unavailable originals and overflow explicitly mark incomplete coverage.
**Interactive user-answer coverage is excluded**: no verified integration adapter is
available, and a historical tool name or registration is not proof of user authorship.
No silent promotion or synthetic interactive-answer adapter is provided.

Bounds: 512 non-monitor entries / 256 KiB visible text, at most 12 recent plan-bearing
candidates and 200 selected tasks. The shortlist is not a complete-plan claim; use
explicit entry narrowing when needed. Jev chooses only supplied candidates. Direct
numbered/checklist structures segment deterministically; prose and mixed structures
use task/criterion/context/ambiguous Choices on exact supplied spans. Ambiguous spans
require explicit task-number selection. No generated task names or paths are accepted.

After Apply, the selected plan entry starts a persistent report cursor. Each subsequent
visible message is interpreted independently against known included tasks. Intentions,
quotes and examples are not reports; clear later reopen/correction overrides done;
ambiguous reports become Conflict. Cancellation never counts done. Requests preserve
the original report in `state.report.text` and carry task meanings, not IDs alone.
Chunks fit 20 questions / 24 KiB and apply atomically only after all answers validate.
Discovery, health and report notifications share a fair single-flight scheduler;
report evidence stays ordered outside that coalescing notification queue.

Pause, rate limits and service failures do not advance the cursor or lose queued
reports. Pending counts show pending/as-of; unprocessable evidence or history overflow
marks counts stale/unknown and requires original-history recovery and source reselection.
The backlog is bounded by retained trajectory; it is never silently truncated into
current counts. Checkpoints persist reference/hash/ID/status/cursor metadata only.
Restore rehydrates original source spans and verifies original report hashes before
restoring statuses; consent and raw answers are not restored. Latest proof per task
(maximum 200) survives inspector history limits (32 ledger batches, 20 report request
chunks, 12 discovery request chunks). Full raw retained evidence is available on demand;
older remote answer distributions are intentionally not persisted.

## Development

Bun 1.3.14; dependencies must already be installed for these gates:

```sh
make format
make check
make test
```

Checks use Biome, TypeScript and Knip. Default tests exclude live tests. Package
runtime consists of `src`; no global Pi configuration changes are required.
