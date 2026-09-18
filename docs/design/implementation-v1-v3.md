# Implementation plan — V1, V2 and V3 together

**Status:** implementation plan, not implemented. User selected V1–V3 as one delivery batch. Execute serial working checkpoints, then deliver the integrated extension; do not stop for new product approval between slices unless a material blocker changes scope. This planning task does not execute the build or authorize more paid Jev calls.

Canonical inputs: [product](../../PRODUCT.md), [breadboard](breadboard.md), [slices](slices.md), [evaluation](evaluation.md), [live spike](spikes.md). Proposed file names and limits below are implementation decisions for review, not claims about existing code.

## 1. End state and boundaries

Deliver one TypeScript Pi extension that:

1. Reads an explicitly selected checklist and displays reported completed / included tasks.
2. Refreshes locally every **15 seconds by default**, configurable with `/progress interval <seconds>`.
3. After user disclosure/consent, shows **requirements clarity** and **acceptance criteria** judgments with raw Jev answers and provenance.
4. Discovers plans in the actual current Pi trajectory, offers source/scope/current-task selection, and interprets explicit completion/reopen reports for known tasks.
5. Survives offline service, malformed evidence, reload, task changes and tree navigation without manufacturing completion or leaking old-task answers.

**Not included:** Beads adapter (V4), red-test assessment (V5), implementation assessment (V6), progress/stuck/drift assessment (V7), child monitoring, other hosts, interventions or test execution by the monitor. Show only supported signals; details may state that later indicators are not implemented. Do not build empty generic frameworks for them.

[ref:reported_completion_only] A health answer cannot update the task ledger. A model-mediated explicit-report interpretation can update it, with the original report reference and `Conversation-reported` label. No trustworthy denominator means no percentage.

## 2. Chosen implementation baseline

| Decision | Plan |
| --- | --- |
| Package | Single TypeScript ESM npm package, explicit `pi.extensions` entry, npm lockfile. No bundler or monorepo. |
| Host dependencies | Current Pi packages use `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`. Follow host peer-dependency convention; verify installed versions/exports before bootstrap and record tested version. No legacy-name compatibility layer. |
| Tests/tooling | Node test runner through `tsx`, `tsc --noEmit`, Prettier, thin `make format`, `make check`, `make test` wrappers. Fake host, clock and transport; no network in default tests. |
| Jev transport | Node `fetch` behind one injected transport seam; fixed `https://api.typesafe.ai/v1/systemone`. Runtime response validation. No SDK needed for two primitives; no alternate endpoint derived from observed text. |
| Model/questions | Pin `jev-1.13.0`, the spike model, and version the question definitions. Missing model is an explicit service error, not silent alias fallback. |
| UI | Pi theme, named widget, native user-invoked selectors/inspector/disclosure. Width-safe text; no custom editor/footer or unsolicited popup. |
| Persistence | Pi custom entries, current branch only; reference/ID/hash/status metadata, not duplicate source bodies. Consent and remote response payloads remain ephemeral. |
| Source discovery | Candidates and confidence are inspectable. Initially **suggest-and-confirm** by default. Automatic application remains opt-in/experimental and gated on real replay evaluation; highest-probability choice alone is not sufficient. |

The suggest-and-confirm default is the conservative rollout permitted by V3's existing evaluation gate—not removal of automatic extraction. Candidate enumeration, task extraction and report interpretation still run automatically after consent; only source authority requires confirmation until auto-selection quality is established.

### Proposed source layout

| Files | Responsibility / breadboard mapping |
| --- | --- |
| `src/index.ts`, `src/pi/host.ts` | Register commands/events, normalize host events, lifecycle, current branch and custom-entry checkpoint adapter: N1–N5, N15. |
| `src/core/types.ts`, `ledger.ts` | Task/source identities, reported states, revision reconciliation, integer counts: N8/N13, S4. |
| `src/core/runtime.ts` | Timer, dirty work, consent state, fair single-flight scheduling and identity generations: N4/N27/N29, S1. |
| `src/sources/checklist.ts`, `read-source.ts` | Bounded approved file reads, task/section extraction: N6, S3. |
| `src/ui/widget.ts`, `commands.ts`, `details.ts` | Pure display data plus Pi rendering/interaction; source draft/apply, inspector and interval command: N14/N16/N18/N19/N23/N24/N29. |
| `src/analysis/snapshot.ts`, `questions.ts`, `gateway.ts`, `health.ts` | Evidence selection, rubrics, disclosure/network gate, response validation, clarity/acceptance reduction: N9–N12/N21/N25/N26, S5–S7/S13. |
| `src/sources/trajectory.ts`, `candidates.ts`, `reports.ts` | Current-lineage observations, candidate spans, source selection and explicit report mapping: N7/N17, extensions to N5/N8. |
| `test/*.test.ts`, `test/fixtures/` | Main-agent-owned unit/integration/replay tests and sanitized fixtures. Never copy raw private session JSONL into package. |
| `README.md`, `package.json`, `tsconfig.json`, `Makefile` | Install/use instructions, supported host, scripts and package resources. Root README is final user documentation, not planning scratch. |

These are small modules, not one file per breadboard node. Pi imports stay at host/UI boundaries; ledger, snapshot, source interpretation and reducers run in tests without Pi.

## 3. Contracts to settle before implementation branches out

### Evidence and identity

Define explicit records for `SourceRef`, `Task`, `ReportEvent`, `LedgerSnapshot`, `EvidenceSnapshot`, `HealthResult` and `MonitorCheckpoint`. Include:

- Source/entry ID and span; file path only where applicable; provenance (`file-marker`, `user`, `assistant`, verified `interactive-user`).
- Stable task ID separate from task text, list position and file revision.
- Session identity and **branch epoch**, selected source ID, **scope revision**, **source-content revision**, **report cursor/revision**, optional current-task ID and evidence hash.
- Coverage/omissions and observed-at time. Display refresh time is not inference freshness.
- Report state: done, reopened, not-started, in-progress, cancelled, unknown, conflict. Separate parser outcomes not-a-report and ambiguous from accepted status transitions.

Ordinary leaf advancement and the monitor's own checkpoint append must not increment branch epoch. `/tree`, session replacement and teardown must. Keep structural scope revision separate from checkbox/status changes so report batch application does not invalidate itself.

Reducer interfaces enforce the split: `applyReport(ledger, validatedReport)` versus `reduceHealth(snapshot, answers)`. Health reducer receives no ledger writer. Cross-source reports can create visible conflict metadata, never update selected-source status.

### V1 checklist grammar and reconciliation

- Select a workspace-relative regular Markdown file and one ATX heading section, ending at next heading of equal/lower level; offer whole document only when a single unambiguous direct task list exists.
- Initial task shape: unindented `- [ ] text`, `- [x] text`, `- [X] text`. Ignore fenced code. Indented continuation/criteria belong to preceding task and never increase denominator. Plain prose/list extraction arrives in V3.
- Reject empty tasks, ambiguous/mixed direct task-list syntax and duplicate explicit anchors. Explain unsupported format rather than silently skipping possible tasks.
- Optional existing marker `<!-- progress:id=token -->` supplies an anchor; monitor never inserts it. Otherwise preserve local ID only across unique exact task text, excluding checkbox/anchor. Reorder is safe; fuzzy rename/split/merge transfer is forbidden.
- Ambiguous identity creates fresh unreported tasks or requires user mapping. A current explicit checkbox remains a fresh report for its uniquely identified task; never inherit old status merely from similarity.
- Selected subset defines denominator. Cancellation does not count done; removal/exclusion is a visible scope revision. Interrupted or incomplete reads cannot imply deletion.
- Draft selection and previews cannot affect active ledger before Apply. Unknown current task does not default to first unchecked task.

### V3 extraction and reports

1. Enumerate exact heading/list/paragraph/sentence spans from bounded actual branch entries. Candidate text remains verbatim and linked to its source; Jev selects/classifies supplied spans, never generates task text or paths.
2. For a selected prose block, classify bounded supplied subspans as task/criterion/context/ambiguous; preserve task-to-criterion ownership. Ambiguous or incomplete segmentation requires scope selection; do not count each sentence as a task.
3. Capture finalized user/assistant entries. Deduplicate live versus persisted entries by entry ID; bind tool observations by toolCallId. Do not treat thinking, system content, private `!!` output, generic tool text, summaries or monitor metadata as authoritative reports.
4. Trusted interactive answers need actual integration/schema and provenance evidence. Current `pi.getAllTools().sourceInfo` can identify a live tool registration, not prove who produced old results. Capture registration-to-call binding for live answers; unsupported historical results require explicit user confirmation or remain excluded with a visible gap. Name-only trust is forbidden.
5. Interpret each new report against known task IDs, one independent Choice per task. All task questions for a given report use the same selected scope revision. Chunk if needed; apply only after complete validated batch. Future intentions, quotes, hypothetical examples and health assessments are not reports.
6. Preserve ordered **unprocessed report entries** behind a cursor. Coalesce scheduling notifications, not report events. A later reopen must not disappear behind “latest state wins.” Apply clear later corrections in lineage order; ambiguous contradiction remains Conflict.
7. Compaction summaries and branch summaries cannot recreate missing original reports. Use original ancestral entries when available; expose gaps otherwise. Never scan sibling sessions/child logs or flatten all session entries.
8. Explicit selected scope may be trusted without scanning the whole session. An incomplete automatic candidate search cannot claim it found the complete plan. Report-history gaps retain prior counts as visibly stale or unknown, not current verified status.

## 4. Scheduler, consent and concrete initial bounds

All request purposes—candidate selection, report mapping, health—share N9. No network call is awaited in a host tool/message hook.

**Scheduling:** local ticks repaint/read selected source; event handlers enqueue bounded dirty work. One in-flight request. Candidate/report/health purposes get fair turns, not an unbounded priority queue. One pending notification per purpose; report entries remain lossless within their bounded queue. On overflow, mark coverage gap and stop claiming current status; require bounded recovery/reselection rather than silently skipping reports. New streamed tokens do not cancel valid same-identity work repeatedly.

**Result admission:** reject mismatched session/branch epoch, selected source/scope, relevant source-content revision, or target task. Reject out-of-order report results. Older same-identity health evidence may be shown only with as-of/stale labeling. Changing interval replaces timer, not scheduler identity; pause/reload revokes outstanding work before abort cleanup.

**Consent:** `/progress enable` discloses future selected task/trajectory transfer, shows current bounded payload/sample for each applicable request purpose, and grants session/workspace-scoped permission. New source outside disclosed boundary requires re-consent. `/progress pause` aborts analysis but retains local counting; resume requires live consent. Reload/session replacement resets consent. No key means no requests. Read key only at transport boundary; never persist or display it.

| Resource | Initial engineering default, to verify in tests |
| --- | --- |
| Local display interval | 15s; user-configurable positive seconds representable safely by timer implementation. Invalid/overflowing input leaves existing timer unchanged. |
| Selected source read | 256 KiB, regular file, approved realpath boundary, stable before/after identity and metadata; reject partial/oversized reads atomically. |
| In-memory trajectory | 512 entries / 256 KiB text, plus bounded references to selected evidence. Coverage flags on eviction. Do not silently truncate essential goal/task text. |
| Candidate plan spans | 12 per selection request; overflow requires explicit scope narrowing, not “complete” claims about a shortlist. |
| Selected tasks | 200 maximum; reject oversized scope rather than count a truncated prefix. |
| Serialized request | 24 KiB including state/questions; at most 20 questions. This byte cap is not a claim about exact tokenization. |
| Network | 10s deadline; one in flight; at most one dispatch per 15s, independent of faster UI cadence; zero automatic retries for this batch. |
| Paid-work budget | 60 dispatch attempts per explicit enablement, including failed attempts. Exhaustion pauses analysis; re-enable must disclose and confirm budget renewal. |
| Failure retry | Changed relevant evidence or explicit user resume can retry; obey server Retry-After before eligibility. Never retry every display tick. |

Keep limits together as named constants with boundary tests, not a new general settings framework. Request preparation rejects essential evidence overflow; chunk per-task questions with stable state/identity rather than clipping task list or criteria. Single-flight and rate cap may delay health during discovery; show Pending/as-of honestly.

Checkpoints retain selected refs/IDs/hash mappings, report status/reference/cursor, interval and revision metadata. No source text, transcript, credentials, consent or raw Jev payloads. On restore, rehydrate/revalidate referenced evidence; unavailable evidence leaves Unknown or explicitly aged reported metadata, never fabricated freshness.

## 5. Execution work packages

All test names below are proposed, not existing. Main agent writes relevant failing tests first. A scoped implementer may write production code but not create/change tests; return test gaps to main. Keep one writer per working copy and use `jj` logical commits, no branch creation.

| Step | Work and proposed commit boundary | Main-owned failing tests first | Runnable exit |
| --- | --- | --- | --- |
| 1 · V1 | Bootstrap package/tooling plus minimal ledger/checklist path; `feat: add reported checklist ledger` | `checklist.test.ts`, `ledger.test.ts`: strict task boundaries, 2/5 count, empty/unknown scope, task IDs, reorder/rename/conflict, removal vs incomplete read | Local parser→ledger→display-data fixture works; scripts load and typecheck. This is a short internal step, not separate delivered backend slice. |
| 2 · V1 | Host lifecycle, safe reads, source draft/apply, details, widget, interval/checkpoint; `feat: add Pi checklist progress monitor` | `source-read.test.ts`, `host.test.ts`, `ui.test.ts`: traversal/symlinks/mutation; apply/cancel; timer replacement; branch restore; Unicode width; no network | **V1 checkpoint:** running Pi widget 2/5→3/5, inspectable source, reload and narrow-width demo. |
| 3 · V2 | Snapshot/rubrics, validated transport, shared scheduler, consent/pause and signal/details UI; `feat: add consented Jev task signals` | `gateway.test.ts`, `runtime.test.ts`, `health.test.ts`: no consent/no key, budgets/deadline, malformed outputs, identity races, unchanged evidence, raw score never ledger | **V2 checkpoint:** real UI with injected transport; clarity/acceptance distributions, offline/paused states; V1 stays functional. |
| 4 · V3 | Actual-lineage normalization, provenance, candidate/task spans, source proposals; `feat: discover plans from Pi trajectory` | `trajectory.test.ts`, `candidates.test.ts`: ancestors vs siblings, compaction, live/persisted dedupe, spoofed tool, overflow, prose task/criteria segmentation | Source selector displays actual entry-linked plan candidates; explicit Apply establishes correct scope; no generated tasks. |
| 5 · V3 | Per-task report interpretation, ordered cursor/chunks, reconciliation, uncertainty/conflict UI; `feat: track explicit trajectory task reports` | `reports.test.ts`, `replay.test.ts`: multi-task done, reopen, cancellation, intentions/quotes, source isolation, chunk atomicity, backlog/fairness and stale responses | **V3 checkpoint:** actual replay yields 2/3, quotes unchanged, reopen lowers count; V1/V2 regressions pass. |
| 6 · Batch | Integrated packaging/manual demo, complete-diff review, accepted fixes and user docs; fix commits only for real findings | Full deterministic suite plus negative passivity/privacy assertions; main adds regression tests for accepted bugs | One usable V1–V3 package, documented commands/limitations, clean working copy and final commit. |

Do not treat missing-module/import errors as the only red-test evidence: once bootstrap loads, demonstrate failing behavior assertions before each implementation batch. Tests/demos are engineering work by us; the extension itself never runs user-project checks.

### V2 question contract

- **Clarity Score, 0–3:** missing concrete target; consequential unresolved behavior; concrete behavior with minor ambiguity; concrete behavior and relevant boundaries resolved. Missing task/goal/essential coverage is preflight Unknown, not score zero. Show score on its rubric scale, raw probabilities/legend and confidence—not percent complete.
- **Acceptance Choice:** explicit, partial, not-found-in-supplied-context, unknown. Descriptions require observable success conditions. Keep executable-test presence distinct; this slice does not prove tests exist/pass.
- Put full task-specific meaning in instructions, not question IDs. Ask independent health questions together. A later request is justified only when source selection changes the state needed for evaluation.
- Validate response model, required answer IDs/types, legal choice keys, finite bounds/distributions and Score legend against request. Treat malformed/incomplete responses as service errors; do not apply partial report batches. No generated rationale or raw server-body error logging.

## 6. Required demos and batch acceptance

### Deterministic automated gates

Run `make format`, `make check`, `make test` at V1/V2/V3 checkpoints and after final fixes. `check` includes format verification and TypeScript checking. Default suite denies network and external project commands. Packaging check: `npm pack --dry-run` includes only intended runtime/docs, not `.agents`, raw fixtures with sensitive data or credentials.

Critical assertions across the suite:

- No calls to agent message injection, tool replacement, project commands/tests, source writes, worker discovery or Beads APIs.
- Ledger source selection is exclusive; all health outcomes leave counts unchanged.
- File reads and evidence selectors stay inside approved source/workspace bounds. Private shell, thinking, images and untrusted tool bodies are excluded from outbound requests.
- No simultaneous inference, duplicate timers, repeated unchanged request, stale cross-task display, report loss through coalescing, or permanently starved eligible work.
- Cancellation and teardown invalidate before late results resolve. Own checkpoint appends never cause feedback loops.

### Hands-on integrated demo

Load local extension in a temporary Pi configuration, without changing global installation/settings. Confirm:

1. File with five tasks/two checked shows 40% reported; external third check updates at next tick. Details show exact source; Cancel does not change scope.
2. Change interval, resize terminal, reload and navigate tree. No overflow, leaked timer, inherited consent or wrong-branch statuses.
3. Enable with reviewed payload and stubbed responses; clarity/acceptance appear. Offline/pause leaves local bar usable, semantic rows visibly aged/unavailable.
4. Replay a sanitized **actual Pi trajectory** with three scoped tasks and one explicit two-task completion report. Source proposal→Apply→2/3; a quoted/future claim does nothing; reopen reduces count. Competing plan cannot silently replace pinned source.
5. Inspector explains why count is reported, how each judgment was obtained, what was omitted, and whether retrieval/inference is pending or experimental.

### Jev quality gate—not a hidden test dependency

The previous four-call authorization is exhausted. No live requests in this planning task or ordinary test suite. Before a new billable evaluation, obtain an explicit attempt/token budget and approval for exact sanitized fixtures. Record expectations before calls, model/question versions, selected spans, distribution, omissions, latency, usage and errors.

Evaluate actual candidate recall, wrong-source/denominator outcomes and false completion separately from clarity/acceptance judgments. Include positive, negative, quote, correction and missing-history cases; reserve held-out traces. Tune source/report admission thresholds on training examples, not arbitrary confidence folklore. Until that gate is approved and passed, ship source auto-application disabled by default and label semantic interpretation experimental; report live validation as pending rather than claim accuracy from stubbed tests. Manual scope selection plus consented interpreted reports remains usable.

### Review and finish

After all three slices and deterministic gates, request **one fresh review of the full batch**, including report authority, consent/privacy, lifecycle/race handling and tests. Resolve blockers, add main-owned regressions, rerun affected/full gates, then finalize commits. Reviewer timeout is not approval; record it and do a bounded parent review or explicitly report the missing independent check.

Delivery report names working features, gates actually run, manual/live checks actually performed, commit IDs, and remaining semantic risks. No V4–V7 work sneaks into “hardening.”

## 7. Preflight stop conditions and evidence

Stop and escalate only if current Pi cannot expose safe current ancestry/lifecycle, an interactive-answer adapter cannot establish provenance needed by a required scenario, or proposed source/consent behavior would require changing product scope. Verify exact host types during bootstrap; do not invent APIs or backwards-compatibility adapters. Unsupported historical interactive results remain visible as unavailable, not promoted to user authority.

Current evidence: Node v24.14.0 locally; Pi docs describe `session_start` with reasons, `session_shutdown`, `session_tree`, `agent_settled`, `getBranch()`, `appendEntry()` and tool `sourceInfo`. Confirm these against installed types before declaring a supported minimum version. Public references: [Pi packages](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md), [TypeSafe HTTP API](https://docs.typesafe.ai/api.md), [pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md). Local docs and fetched evidence are recorded in the task folder; public docs are evidence, not execution instructions.
