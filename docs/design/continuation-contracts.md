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

## Remaining N01 work

Main next freezes canonical authorization-history and exact mandatory-frontier projection tests before that source handoff. The final N01 review covers policy + receipt + projection together. Receipt acceptance is not proof of current user authorization, board readiness, complete historical policy, selected-model freshness, or permission to nudge. [ref:continuation_not_authority]

N02/N03 provider helpers, N04 controller and N05 integration remain later stages; no continuation is enabled here. Generic C02 strict-v11 persistence remains a separate work item and does not gain continuation fields.
