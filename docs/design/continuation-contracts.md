# Continuation contracts — staged N01 implementation

Companion to [continuation design](continuation-nudge.md). N00 host/policy/corpus freeze is accepted. Main owns all RED tests; workers implement source only. This document freezes the next disconnected layer, not feature acceptance.

## Passive delivery settlement receipt

Add optional `onReconciliationSettled(receipt)` to `ReconciliationDelivery` options. Preserve existing `onAgentSettled()` return value and A/B/C transport behavior. No listener means no receipt construction overhead. No new sends, timers, providers, persistence or runtime index wiring in this slice.

```ts
interface ReconciliationSettlement {
  kind: "reconciliation";
  opportunityId: string;
  sendId: string;
  sessionEpoch: number;
  branchEpoch: number;
  replyRunId: number;
  question: { entryId: string; contentHash: string };
  replies: readonly ObservationRef[];
}
```

`replyRunId` is delivery's correlated final own-run counter, including retry/compaction starts. It is NOT the original independent run ID. N05 joins opportunity UUID + epochs to the original reconciliation controller's independent-run record; receipt alone cannot invent that authorization.

Receipt eligibility requires:

- Reconciliation kind only, successful `advisory-only` correlated settlement, current enabled TUI/RPC opportunity/epochs, idle with no pending input, and no explicit cancellation/lifecycle revocation.
- Exactly one current canonical custom question matching the immutable request and attempted send identity. Revalidate at settlement even after earlier confirmation. Ambiguous duplicate questions/IDs abstain; possible transport duplication remains an acknowledged limitation.
- One or more unique canonical assistant replies after that question, all successful terminal `stop`, with nonempty visible text. Preappend events, earlier replies, errors/abort/nonterminal messages cannot supply evidence.
- Reject substantive tool execution/results within the question/reply suffix without reading tool arguments/results or thinking payloads. Later authority/classifier layers still judge whether text describes a status-only stop; this receipt does not infer actionability.
- Bound receipt construction to64 suffix entries,16 whole reply observations and12KiB serialized visible reply-observation evidence (including IDs/roles/text/hashes). Reject excess rather than truncate; text construction itself must be bounded before hashing. Question content is already bounded by existing transport limits. Use existing canonical normalization where safe; do not change canonical message semantics.
- No revival after uncertain settlement, external/mixed input, OFF, navigation, shutdown or duplicate settlement. Callback receives detached IDs/hashes only, no mutable branch/task pointers or payloads.

Clear the original chain before invoking callback, so a later authorized controller can acquire transport. Contain observer exceptions without changing settlement origin or replaying the callback. No buffered unbounded receipt queue. Existing ordinary transport retries/uncertain cleanup remain intact.

Main REDs: `__tests__/continuation-receipt.test.ts`. Existing delivery/advisory tests remain regression authority. The previously accepted `continuation-policy.ts` helper is unchanged.

## Canonical authority and mandatory frontier

`projectContinuationAuthority(input)` in `src/advisory/continuation-authority.ts` accepts code-owned `receipt, branch, tasks, events, ready, cursor, policy, originalRunId, sessionEpoch, branchEpoch, controlEpoch, model`. `branch` is the full active canonical branch, not recent settledContext. `policy` must have been verified at provider-context preparation by the caller; this helper revalidates its structure/hash/size but cannot substitute for that host observation.

Returns `{available:false, reason:"frontier"|"stale"|"authority"|"capacity"|"no-work"}` or a detached `{available:true, fingerprint, receipt, tasks, context, policy, originalRunId, sessionEpoch, branchEpoch, controlEpoch, model}`. `context` contains canonical `Observation` objects, chronological and whole. `tasks` includes every included parent, including completed rows; copy only task identity/label/kind/basis/status/inclusion/revision/source, not optional health, focus or assessment scalars. Available means complete bounded evidence, never semantic permission.

Revalidate unique current canonical question content/details and all reply refs. Require matching epochs and no later canonical user/intercom/assistant observation beyond the receipt's last reply. The accepted mandatory cursor must exactly match the last reply ID/hash/role and readiness must be true; missing/older cursor is `frontier`, not inferred ready. This deliberately stronger exact-last condition supplies the required covering frontier without trusting a recent-window completeness flag.

For every included task, resolve a unique canonical create event and current source, including role/hash and exact nonempty range/quote hash. Begin at the earliest creation source, not a later label rewrite, retaining every canonical observation through the reply. For assistant/intercom-created tasks, extend conservatively to the earliest canonical user observation preceding creation; without one, authority is unavailable. That user is evidence to be judged, not a code-inferred authorization. This may include unrelated prior instructions rather than silently omit them. Missing/ambiguous creation or supporting history is unavailable. Do not parse tools/thinking or fetch files/child sessions.

All selected visible-text construction and hashing must be bounded. At most16 whole observations /12KiB serialized observation evidence,20 included rows,8KiB policy proof and24KiB total projected output. Reject excess without sampling or truncation; N02 independently caps its full provider request including questions. At least one included unfinished task is required. Fingerprint all copied semantic/source/policy/root/model/control facts, excluding the fingerprint itself and optional UI/cost metadata.

`Monitor.continuationAuthority(binding)` supplies actual current branch, tasks/events, accepted cursor and mandatory readiness to the helper. Binding contains only `receipt, policy, originalRunId, sessionEpoch, branchEpoch, controlEpoch, model`. Getter is read-only: no providers, timers, saves, publication, parent mutation or optional jobs. It may inspect canonical history but never reuse correctionAuthority's recent window. No index/runtime send wiring here.

Main REDs: `__tests__/continuation-authority.test.ts`, `__tests__/continuation-monitor.test.ts`, fixture `__tests__/fixtures/continuation.ts`. The final N01 review covers policy + receipt + projection together. Receipt acceptance is not proof of current user authorization, board readiness, complete historical policy, selected-model freshness, or permission to nudge. [ref:continuation_not_authority]

N02/N03 provider helpers, N04 controller and N05 integration remain later stages; no continuation is enabled here. Generic C02 strict-v11 persistence remains a separate work item and does not gain continuation fields.
