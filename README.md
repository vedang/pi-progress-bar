# pi-progress-bar

Read-only reported checklist progress with optional, consented experimental Jev
requirements-clarity and acceptance signals for Pi (V1 + V2). Tested with
`@earendil-works/pi-coding-agent` 0.84.2; Node.js >=22.19.0.
Load with `pi -e ./src/index.ts` or install this directory as a Pi package.

## Commands

- `/progress`: native source/details/interval/analysis picker.
- `/progress source plan.md#Tasks`: draft a source, choose included task numbers
  (blank includes all), select current task (default Unknown), then explicitly Apply.
  Escape or declining confirmation leaves active selection unchanged.
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
Missing current-branch checkpoints clear the selection. Current task is never inferred.

Counts describe file-reported completion, **not verified correctness**. Health
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
project goal, conversation, other tasks, implementation and test results are explicitly
omitted. Unknown current task, stale source or oversized essential evidence yields
Unknown without a request; evidence is never silently clipped.

Consent covers future revisions of the selected source in this session. Selecting a
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

V2 host behavior is tested with injected schema-valid responses, not live accuracy
validation. Signals remain **experimental**. Conversation discovery/report interpretation
(V3), Beads integration, code/test assessment and child monitoring are not implemented.

## Development

Bun 1.3.14; dependencies must already be installed for these gates:

```sh
make format
make check
make test
```

Checks use Biome, TypeScript and Knip. Default tests exclude live tests. Package
runtime consists of `src`; no global Pi configuration changes are required.
