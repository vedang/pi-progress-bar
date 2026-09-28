# Durable semantic omission summaries (ru7)

Owner approved bounded persisted omission summaries after the test audit; this narrowly supersedes earlier no-new-schema wording. No raw content, automatic retry, legacy facade, or additional report-disable threshold. C05/C07 acceptance remains gated on implementation and real Monitor proof.

## Schema and storage contract

[tag:subtask_omission_summary] Strict v11 Monitor metadata gains optional `subtaskOmissions: { entries: Array<{identity, reason}>, saturated: boolean }`. Identity is lowercase SHA256 hex; reason is exactly `report-oversized`, `coalesced`, or `capacity`. Maximum64 entries, unique by identity alone; first durable reason wins. Exact own-data keys/dense arrays only; reject getters/prototypes and duplicate identities, including conflicting reasons. No text, labels, paths, raw source references, timestamps, provider output, retry state or persisted counters.

Absence means genuine zero state. Present empty/unsaturated is noncanonical and rejected; empty/saturated is valid. Summary can exist without a subtask store/journal and survives group pruning within its session. No version migration or v10 reader.

Measure the shared64KiB optional budget using inert UTF8 JSON of `{...(subtasks ?? {}), ...(summary === undefined ? {} : {subtaskOmissions: summary})}`; both actual512KiB ON/OFF envelopes also include the sibling summary. Standalone store/journal limits and existing report final-growth reserves remain unchanged; equality allowed, one byte over rejected. No fixed64-entry headroom reservation or increased limits. Use identical byte projection for validation and preflight, not summed component lengths.

## Identity and meaning

One identity per eligible parent/group report opportunity: hash domain/version, session sourceId, semantic parent binding, status-free group/list/admission proof and ordered child bindings, validated canonical report source reference, pinned report model/rubric. It must be computable without building an oversized request. Exclude reason, wake/time, mutable child status, selected proposal model, adapter evidence and chunk size. Main freezes the concrete helper signature before Monitor implementation.

Only never-admitted work needs this summary. Existing permanent/superseded report records already preserve charged outcomes. Ready/parked owners are delayed, not omitted. Record oversize only for an otherwise eligible post-admission canonical report with a validated current group; record coalescing for displaced unadmitted B when C replaces it, not A merely retaining priority. Oversized C must not evict eligible B. Capacity needs an explicit validated runtime/queue refusal, not inference from unchanged journal, credentials, cancellation or arbitrary errors. Adaptive prefix success is not loss.

## Saturation and persistence

Append until64 or byte capacity; never evict. First unretainable distinct identity sets sticky saturation. Counts derive from retained entries and become explicit lower bounds; unknown identities after saturation do not cause repeated increments/unchanged-summary writes. Saturation can occur below64 due bytes and must never disable future valid reports or act as retry authority.

Monitor owns summary independently of runtime journal so in-flight report commits cannot erase it. Build detached full-envelope candidate before mutating summary/pending queue. Only internal exact-true synchronous commit permits publication and B→C replacement. Host persist retains its existing synchronous void/throw API; normal return is success, throw vetoes. No new false/Promise-return guarantee.

On veto keep prior summary/B; C remains discoverable via existing named wakes, not a new retry timer. If identity growth cannot fit, a smaller saturation-only transaction may be attempted; if that cannot fit/save, retain prior state and make no durable visibility claim. This is explicitly bounded best-effort visibility under storage failure/capacity. A successful save survives subsequent observer failure; lifecycle revalidation prevents stale queue admission and cross-session leakage.

## Restore and projection

Same-source restore retains live entries first, appends distinct incoming identities up to64, keeps live reason for conflicts, ORs saturation and marks truncated unions saturated. Never sum counters, erase live history on incoming absence, or resurrect semantic jobs from summary. Different source resets isolate history. Failure to persist merged history cannot silently drop live entries or claim durability.

Expose detached `semanticOmissions: {total, byReason, saturated}` alongside—not inside—volatile adapter omissions. No identities in UI and no host/model/credential reads or writes from getters. Render positive counts distinctly; saturated zero must say summary incomplete, not falsely zero loss. Keep adapter and wallet-exhaustion warnings together, including no-group/OFF/reload views.

## Execution layers and required proof

1. Strict codec/schema/shared byte-capacity support; keep existing product working. Main codec REDs precede source-only implementation.
2. Main freezes concrete identity/merge/projection APIs and authors pure plus actual public-Monitor REDs: oversize/no-provider/reload, saved A + B→C coalescing, save veto, lifecycle/concurrent-flight preservation, saturation/continued admission, capacity classification and passive UI. Separate report authority from newest-source size eligibility so oversized C cannot invalidate saved A.
3. Separate actual Monitor older-checkpoint wallet no-refund RED/fix; summary does not solve usage accounting. Never independently max usage call buckets into an invalid journal.
4. Execute retained R1–R9 ports and legacy keeper mappings before old semantic/codecs removal and stage acceptance.

Permanent generic phase failures do not retry on unchanged `modelSelected`. Changed selected model/context is a new identity after physical drain, not a compatibility retry. Invalid overlapping report/decomposition ownership is rejected by schema, not normalized into a legacy queue. These source-grounded corrections supersede tentative audit handoff questions.

No ru7/C05–C09 acceptance is claimed by this freeze; no paid semantic evidence or manual acceptance.

## Implementation evidence (in progress)

Codec source `11b66ebd` plus typed-input repair `cd09645f` passes Main's61 configured envelope tests and format/check. The initial worker widened public metadata inputs to unknown; Main rejected that and added compile-time contract proof (`95bb7d11`). Negative fixtures now explicitly cross the untrusted boundary; production inputs remain typed. This is codec validation, not ru7 acceptance.

Actual public-ingress Monitor REDs now establish two missing runtime behaviors: oversized canonical report omission persistence and summary-only saturated restore/projection. A separate real-dispatch wallet regression builds22 children through host metadata/gate/proposal ingress, charges a new negative gate plus two report chunks, then navigates to an older same-source checkpoint: wallet drops6→4. No synthetic journal counters were used. Both accounting rollback and any unnecessary restoration dispatch need scoped investigation; no blanket max of independent usage buckets.

Main full gates with these intentional REDs:1930 unit pass/47 fail (44 retained legacy fixtures plus3 new Monitor regressions),86 integration pass, format/check pass with three historical warnings. No paid calls or stage acceptance.

### Wallet fixture correction and policy clarification

Source-grounded consultation showed enabled restore intentionally clears ephemeral metadata. Goal + current22-child group + no metadata is a new exact gate context, so one new negative gate is legitimate; suppressing it would change policy. Main split the regression: OFF restore must retain wallet6 exactly (currently3); enabled restore must retain6 then charge the distinct gate to7 (currently4), with exact fresh identity/trigger proof and no repeated same-context calls. The previous unchanged-call expectation for enabled restore is superseded, not implemented as suppression.

Same-source lifetime accounting is independent of `preserveControls`. A restore repair must choose a real componentwise-dominant cumulative wallet vector, preserve coherent bounded identity/receipt history and terminal suppression, and never independently max call buckets, invent tokens or rebase dispatch ordinals. Incomparable/contradictory proofs, conflicting surviving ownership or an unpersistable history union must refuse adoption: remain OFF, retain prior ledger, no write/dispatch, truthful bounded diagnostics—not silent history loss or fake exhaustion. Include same-source canonical-reset paths that would otherwise bypass preservation; never carry a different source's ledger. Concrete transaction/helper design and additional REDs remain pending advisor completion.

### Restore-history prerequisite accepted

The historical wallet rollback above is repaired through `dd93c0a6` and accepted as a prerequisite batch after independent reviewer `922dee76` returned OK with notes. Main145 focused tests/checks pass; worker fullunit1968 PASS/46 known FAIL and86 integration PASS. Same-source restore/reset/drain now retains coherent wallet/history atomically. This supersedes the earlier pending-advisor/repair status only: omission detection, summary merge/ownership, capacity classification and passive UI remain unfinished, with two genuine Monitor REDs. ru7 and C05–C09 remain unaccepted.

## Pure summary layer API

Before identity/detection integration, `src/core/subtask-omissions.ts` provides pure candidate construction for **already codec-validated, canonical typed** summaries and internally constructed valid identity/reason entries. This layer is not an untrusted-input decoder and grants no report authority. Preserve typed inputs; do not widen public metadata to unknown or duplicate a schema/migration layer.

- `appendSubtaskOmission(live, entry)` returns `{summary, changed}`. Identity-only dedupe; first reason wins. At64 entries, a distinct65th sets saturation without eviction. Once saturated (including byte saturation below64), new unknown detail is frozen: no refill or repeated writes.
- `saturateSubtaskOmissions(live)` returns a smaller saturation-only candidate, including `{entries:[], saturated:true}` from absence. Existing saturation is a no-op.
- `mergeSubtaskOmissions(live, incoming)` returns `{summary: SubtaskOmissionSummary | undefined, changed}`. Live-first union; first reason wins;64-entry truncation saturates; OR saturation. Already durable incoming entries may extend a saturated live summary, unlike newly observed unknown detail. Incoming absence never drops live history.
- `projectSubtaskOmissions(summary)` returns detached `{total, byReason:{"report-oversized",coalesced,capacity}, saturated}` with explicit zero reason counts, no identities. Empty saturated remains incomplete, not exact zero.

Inputs are `Readonly<SubtaskOmissionSummary> | undefined`; append entry is a readonly summary-entry type. Append/saturate always return a present summary. `changed` compares the candidate to live state, never to incoming. Every result is detached even on no-op; no mutation, storage, byte-admission callback, reader, clock, provider, retry or scheduling effect. Monitor later applies full-envelope byte preflight and atomic commit before publishing any candidate. Session matching is a caller precondition for merge.

Main added12 declarations/14 expanded pure cases. Initial configured run is collection-RED because the module is absent;61 existing envelope cases pass. This is not14 executed failures. Identity hashing and Monitor/UI integration remain separate unfinished layers.

### Summary implementation verified; identity API frozen

Pure summary source `b12616d2` passes Main75 configured summary/envelope cases and `make check`; source inspected. This is helper verification, not Monitor integration or ru7 acceptance.

Next export in `src/analysis/subtask-report.ts`:

```ts
subtaskReportOmissionIdentity(input: {
  sourceId: string;
  parent: Readonly<HybridTask>;
  group: Readonly<SubtaskGroupSnapshot>;
  reportSource: Readonly<SourceRef>;
}): string | undefined
```

This pure content-free fingerprint takes canonical bindings already validated by the caller. It does not admit work, validate live provenance, read bodies/resolvers, or classify size/capacity. Monitor must validate current parent/group and exact canonical report reference plus post-admission order before counting. Isolated binding-mutation tests exercise hashing distinctions, not claims of actual admitted changed groups.

Use inert hashing with domain `subtask-report-omission:v1`, session sourceId, and the existing pinned report `MODEL` and rubric. Semantic projection mirrors existing job identity's parent (`id,label,revision,source`) and subtasks (`parentTaskId,parentRevision,groupId,parentSourceDigest,listRevision,source,proof,complete,knownTotal?`, ordered active children `id,label,source`), replacing the whole report observation with `reportSource` only. Omit mutable parent/child statuses, retired/diagnostic group history, reason, time, selected proposal model, adapter evidence and chunk selection. Use original pinned model/rubric constants, not copies that can drift. Keep existing report job/request identities and request validation/limits unchanged; a golden existing-job fixture guards accidental identity reordering.

Main26 identity cases include25 REDs for the absent export and a passing old-job identity guard; summary/report controls bring the configured run to25 RED/62 PASS. A100KiB report cannot build a report request but has a hashable content-free reference. Inherited serialization hooks must remain inert. No source identity implementation or production omission detection is accepted yet.

### Monitor ownership layer (before detection)

Identity helper `10639289` is Main-verified with147 focused tests and `make check`; existing report identity remains unchanged. Next implement only Monitor-owned summary storage/restore and passive diagnostic counts, using the verified pure operations. Always project an explicit zero count when absent. Do not introduce an empty generic sidecar for summary-only history.

Same-source restore—including incoming absence and canonical group reset—unions live-first independent of `preserveControls`; cross-source restore adopts only target history. Count-bound union truncation marks saturation. Preflight and persist the normalized full candidate before adopting summary; failed save keeps prior summary and remains OFF. Successful writes must be lifecycle-fenced before publication so a reentrant source switch cannot adopt the obsolete source's summary. All subsequent Monitor/runtime checkpoint paths preserve owned summary. Getters remain detached, content-free and passive.

Main's ownership batch has10 RED/26 PASS across omission Monitor, wallet and pure-summary files; TypeScript passes. These include the two existing Monitor REDs plus eight new ownership REDs. A reentrant source-switch keeper already passes and must remain passing. The oversized-report RED remains intentionally outside this ownership-only layer; detection/coalescing/capacity and UI follow with their own tests before implementation. No ru7 or stage acceptance.
