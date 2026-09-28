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

### Crash-recovery fixture correction

During integration, the existing mid-wave report test captured an early checkpoint but let the same live Monitor complete all work before restoring it. Under the no-resurrection contract that is navigation with known terminal history, not a process crash. Main changed only that test to use a fresh zero-wallet Monitor for recovery. Exact saved-prefix, remaining-child, second-parent, chunk-size and dispatch-accounting assertions remain. Against the paused candidate Monitor repair, the complete report/wallet files pass45/45. Candidate source is not yet accepted; broader gates and cumulative review follow.

### Cumulative review blockers (not accepted)

Independent review of the full codec/history batch through `25303ef7` blocked acceptance on three P1 findings: `restore()` awaited a newly-started abort-ignoring physical flight; target-only report work was not scheduled after a pending replacement drained; pre-adoption persistence wrote older mandatory telemetry before the preserve-controls merge.

Main reproduced all three with configured Monitor tests (3 RED / 45 PASS, types PASS). The pending-target regression additionally exposes a stale one-group passive projection despite a committed two-group target. Its target adds one valid group with unchanged wallet/proofs; no incoming-only owner is entitled to survive an equal-wallet tie. The named restore wake must discover that group's new report work without another wake or disposed-reader access. The lifecycle test restores a genuine saved ready final chunk into a fresh Monitor and holds the new physical transport. The telemetry test compares final durable metadata to the adopted OFF checkpoint after real additional calls. Existing enabled-wallet tests now explicitly settle optional work after lifecycle return, rather than requiring restore itself to await transport. No production repair or acceptance yet.

### Repair candidate awaiting independent re-review

`27fd9f1f` removes the physical-flight await, captures detached pending-target wake authority and projection, and merges preserved mandatory counters/timestamps into prospective metadata before persistence. Main reran135 focused tests and `make check`: PASS, including all three review regressions and veto metadata retention. Worker reports552 broader tests and86 integration tests passing; full configured unit result1958 PASS/46 known residual FAIL (44 legacy fixtures,2 omission Monitor). Independent retained review is pending; these results do not accept the batch or C05–C09.

### Re-review outcome and next regression batch

Retained re-review after timeout recovery confirms the original three findings repaired, but still blocks acceptance on four new findings: cloned adapter evidence loses its private attestation; pending scheduling confuses parked ownership with immediate runnability; saved optional health/details can differ from canonical adoption; detached source capture has no aggregate byte/lifetime bound.

Main has reproduced the optional-health mismatch with an actual health assessment whose supplied revision is stale but strictly codec-valid: disabled restore persists the stale card while its immediate checkpoint omits it. The wallet suite is1 RED/10 PASS and types pass. Remaining findings still need Main regressions. A read-only contract consultation is resolving bounded pending capture and invalidation semantics before source delegation; it must preserve normal deep direct-reference validation and exact original evidence capabilities. No new capture limit or implementation is accepted yet.

### Pending authority transfer bound (supervisor decision)

The next repair uses bounded whole canonical observations, not a new compact-proof interface. Detached pending transfer has a private64KiB aggregate inert UTF-8 canonical-observation budget, deduplicated by entry ID, counting latest/earlier once; equality is allowed. Preserve the original frozen adapter evidence capability rather than cloning its private attestation away. Existing current/parent/evidence structural bounds remain in force. This transfer ceiling must not restrict normal `CanonicalPass` direct/deep source validation or change provider-input/storage limits.

Runtime initialization validates retained store/journal dependencies, so silently omitting unrelated sources from its resolver is unsafe. If the shared initialization dependency closure exceeds the transfer ceiling, defer all optional dispatch for that pending target: retain committed groups, owners, proofs and wallet unchanged. Do not partially initialize/prune, charge, create omission/permanent receipts, retry on a timer, or fall back to host/model readers after disposal. An ordinary later named wake may reconsider under fresh authority. Per-owner progress despite an oversized shared closure is not required in this repair.

Check observation byte size before cloning; unsuccessful capture must not retain oversized or partial source maps. Stop/invalidation clears pending/captured text and evidence capability. Late physical drain may install the durable component but must not revive captured authority or read/dispatch until a new named wake. Unavailable transfer needs an explicit deferred state rather than an `undefined` value that falls through to a live reader. These are implementation requirements, not an acceptance claim; Main regressions and independent re-review remain required.

Private captured-current representation may be tri-state: `undefined` for ordinary live mode selected by a fresh named wake, `null` for blocked/revoked transfer, and a bounded current object for captured authority. Use an explicit branch; nullish fallback would revive host access. Overflow, stop and invalidation revoke to `null`; late installation preserves that revocation.

For parked-owner regression construction, prefer real HTTP503 parked A in live history followed by a different parent's held selected-proposal flight. Restore retains A's same identity/deadline plus newer B. An incoming-only parked job on an equal-wallet target is not a valid parity fixture: live-tie merge correctly supersedes it. If needed, a disclosed same-lineage owner seeded in both live and incoming may test scheduling mechanics, but cannot replace actual503 billing/retry controls.

### Pending-authority regression evidence

Main's combined report/wallet suites now execute55 cases:6 RED/49 PASS; TypeScript passes. REDs cover the stale optional-health save, authentic adapter evidence lost during pending handoff, captured resolver/capability surviving stop and late drain,65,537-byte capture overflow with one source and with two individually smaller sources, and premature decomposition of a real parked report owner. The65,536-byte UTF-8 equality case passes. Capture bytes are the inert JSON observation array (including separators/fields), deduplicated by entry ID; multibyte bodies test byte rather than character counting.

The parked fixture obtains a real ready-yes proposal permission, throws before its first dispatch, adds A's group via the existing disclosed report-fixture admission boundary, receives an actual HTTP503 for A, then holds P's admitted selected-proposal drain. Restore retains the live parked identity/deadline; no incoming-only owner or fabricated billing is involved. The test requires no A decomposition, no timer retry, and A first after deadline plus named wake.

The historical-source boundary fixture settles mandatory canonical bookkeeping while physical optional transport is held; only subsequent drain must avoid disposed readers. It preserves committed groups/history on overflow. Narrow private resolver/state assertions supplement public behavior for capability identity and lifetime, which JSON snapshots alone cannot prove. Source repair of these reproduced findings may proceed; final acceptance still requires Main validation and retained independent re-review.

### Four-finding repair candidate

`3dfe026e` changes Monitor only: original evidence capability retention, pending parked ownership, prospective optional metadata normalization, and bounded/revocable captured authority. Main inspected the225-line diff and reran142 focused tests plus `make check`: PASS. Worker reports559 broader tests and86 integration tests passing; full configured unit result1965 PASS/46 known residual FAIL. The previously six failing review regressions pass. Retained independent re-review is running; candidate results do not accept the batch or overall feature.
