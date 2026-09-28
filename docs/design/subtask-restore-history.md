# Same-source generic restore history

[tag:subtask_restore_no_refund] Same-source navigation and canonical reset preserve cumulative generic charges, terminal history and allocator high-watermarks, independently of `preserveControls`. Other session sources remain isolated. This is not authority to import live semantic groups/statuses into an older target.

## Pure boundary

Implement `mergeSubtaskRestoreHistory` in `src/core/subtask-restore-history.ts`:

```ts
(input: {
  live: Readonly<SubtaskRuntimeCheckpoint>;
  incoming: Readonly<SubtaskRuntimeCheckpoint>;
  targetStore: Readonly<SubtaskCheckpoint>;
}) =>
  | {kind: "merged"; component: SubtaskRuntimeCheckpoint}
  | {kind: "refused"; reason: "invalid-history" | "accounting-conflict" | "proof-conflict" | "owner-conflict" | "capacity"}
```

Caller establishes same session source. Helper has no reader/provider/clock/persistence callbacks. Validate and detach bounded own-data inputs, including original accepted-record/store coherence before target pruning. Never turn a raw incoherent accepted record into trusted superseded proof. `targetStore` is independently canonical-restored incoming state; full source/currentness checks remain caller-owned.

Wallet is one indivisible existing vector: dispatches, both provider call counts and all token totals. Select a componentwise dominating input vector unchanged; equal vectors prefer live for owner eligibility. Incomparability refuses. Never sum wallets, independently max buckets, infer totals from retained receipts or renumber dispatch ordinals. Selected vector must cover merged receipt proof and retain calls-sum=dispatches<=1024.

Union histories by identity with immutable bindings equal. Select one coherent proof extension for shared identity: earlier dispatched placeholder may become the matching saved finalized receipt; finalized outcomes never change. New proposal receipts/report attempts must extend valid preceding proof. Reject conflicting finals and unrelated reuse of dispatch ordinals. Bound records/receipts by existing200 caps, standalone journal/store/shared optional64KiB; no eviction.

Terminal live suppression outranks permission: complete/permanent/superseded must not become resumable. Compatible richer proof may require superseded representation rather than permanent shape. Only selected-wallet-side unfinished owners may survive; ties prefer live. Loser-only unfinished owners become superseded history. Remaining owner conflict refuses. Caller subsequently applies existing target-currentness/crash-dispatch rules; helper does not reconstruct raw queues or fabricate outcomes.

Output contains only target groups/statuses, with max live/incoming/target allocator high-watermarks. Target allocator lower than allocated target IDs is invalid, not repairable input. Known-valid accepted history whose group vanished from target may supersede without dropping charge/proof. No input mutation or retained references.

## Monitor integration (later layer)

Capture authoritative live component before runtime invalidation/replacement. Preserve physical-drain reservation. Validate incoming v11 and canonical target, merge, normalize eligible owners, then preflight complete ON/OFF512KiB envelopes (including omission bytes). Save synchronously before adopting target state or publishing/scheduling. Exact true belongs to internal seam; host persist remains void/throw.

On conflict/capacity/persist refusal: no target adoption/write/provider dispatch, locally OFF with prior ledger and truthful bounded failure diagnostic. Do not pretend retained old semantic state is validated against the selected branch or fake wallet exhaustion. An external partially written failure is not made atomic by this contract.

A committed target waiting for old physical drain is the authoritative accounting floor for subsequent restores. Old finalizers cannot overwrite it or read disposed host context. Same-source `resetState(source,false)` must also preserve wallet/history/allocators while retiring invalid semantic authority. Different source resets fresh.

## Main test interpretation

Public ingress creates22children and real wallet3. Later report costs one new negative gate plus two report chunks =>6. OFF old-checkpoint navigation must retain6; enabled navigation may charge one new goal/current-group/no-metadata gate =>7. Trigger hashes exclude group, so that new gate may share the initial no-metadata trigger; its full identity/context must be new and its trigger must differ from metadata-backed admission. No policy to suppress this legitimate named wake is introduced.

First layer: pure helper tests, then source-only helper implementation; Monitor integration follows additional actual restore/save/drain/reset REDs. Existing public OFF/ON tests remain RED until integration. No stage acceptance or paid proof is implied.

## Implementation evidence (in progress)

Pure helper `84c63854` passes Main145 configured helper/journal/envelope checks; it is not yet wired into Monitor. Main's public restore suite now covers OFF/ON crossed with both preserveControls values, thrown persistence refusal, valid-but-incomparable supplied accounting, different-source isolation, same-source canonical reset, and two restores during abort-ignoring physical transport. These reach actual22-child public ingress and real provider dispatch accounting, not seeded groups. The supplied-accounting conflict is explicitly adversarial data, not a claim of actual fixture calls.

Current focused result:8 integration REDs/29 controls PASS (16 pure helper,12 existing public metadata Monitor,1 new source-isolation control); TypeScript passes. Held transport preserves the visible floor until drain, then incorrectly falls7→3—so preserving only the draining runtime is insufficient. Source-only Monitor integration may now proceed within this contract; omission scheduling/UI and feature acceptance remain separate.
