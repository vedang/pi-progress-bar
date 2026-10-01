# Legacy semantic coverage retirement

## Scope and evidence

Follow-up to the accepted test audit and generic cutover, not permission to remove live adapter or health behavior. `ru7` accepted through5d0e8cfa; mandatory codec ports2fcb195b and final scheduler ports19f1f1de are verified. Main reread all ten retiring suites and the accepted second-layer trace (`layers/generic-health.md` in the audit task folder). Main ran43 retained files: **924 tests PASS** before deletion.

Shipping `Monitor.checkpoint()` writes v11, restore validates v11, and adapter confirmation feeds generic metadata/access rather than `CoverageStore` admission. Legacy intent jobs have no fresh creator; their only population path requires forbidden v10 metadata. Empty constructed objects and mutually calling dead methods are not a live semantic producer. Remove that graph, not its live adapter ingress or shared mandatory validators.

Two scout outputs are not retirement authority: first used stale active-v10/missing-ru7 claims and failed a protected artifact write; corrected output still inferred reachability from member/import existence and confused JJ's empty change with colocated Git's parent. Main relies on the accepted audit trace, actual code, and executed keeper evidence.

## Keeper/disposition map

All paths below are under `__tests__/`. These dispositions preserve product contracts, not obsolete implementation vocabulary.

| Retired suite / assertions | Retained owner-boundary evidence / intentional replacement |
|---|---|
| `coverage-scheduler`: recovery of transport/malformed/persistence failure without parent extraction | `subtask-recovery-monitor`: `recovers a charged %s proposal only under a new selected-model identity without re-extracting parents or refunding history`. Same-context permanent work does not retry; changed model creates one fresh paid gate/proposal per approved C07. |
| scheduler: backlog/coalescing/omission reload/oversized report/saturation | `subtask-omission-monitor`: `saves unadmitted B's coalescing receipt before C replaces it, without counting parked A`; `keeps B on coalescing-save veto and reconsiders C only on a named wake`; `persists one oversized report omission through OFF/reload without a report call or raw body`; `saturates retained omissions once without disabling later valid report admission`. Capacity refusal and controls live in `subtask-capacity-omission-monitor`. |
| scheduler: report versus later intent, overlap restore, cached stale ownership | `subtask-report-monitor`: `keeps a real parked report owner ahead of decomposition during a different parent's proposal drain`; `revokes an invalid pending wake and recovers identical generic work on the next named wake`; revised-parent/parked-owner cases. `subtask-report-journal`: `shares unfinished parent ownership across decomposition and reporting` rejects structurally overlapping unfinished owners; v11 does not normalize an invalid v10 queue into authority. |
| scheduler: newest report/intent supersession, old crash window, late response at1024 | Current approved policy: admitted ready/parked A retains saved-source priority over newer corrective B. `subtask-report-monitor` parked unrelated/corrective table, `unknown failed A never retries but genuinely newer B may supersede it`, and final1024 complete/newer-candidate/OFF table. Invalid source/parent/list authority remains fenced in runtime/currentness tests. No prose-triggered semantic retraction. |
| scheduler: selected intent receipt privacy/time | `subtask-journal` strict phase/proof/wallet validation and `subtask-runtime` admitted gate/proposal history tests. `subtask-report-monitor`: `records report dispatch time rather than delayed response completion time`; finite wave keeper checks privacy/accounting. |
| scheduler:20+2, accepted positive/negative no-rebill, partial retry, deadline+named wake, detail fairness, canonical user report | Existing exact `subtask-report-monitor` finite20+2, covered outcomes reload, saved20/final2, detail interleaving and user/intercom tests; `subtask-report-runtime` certified-failure/deadline/unknown-result controls. |
| scheduler: pre-network save veto, final receipt write veto, readiness/OFF, physical drain | `subtask-report-monitor`: `refused report dispatch persistence causes no fetch, charge or child publication`; `failed final save keeps charged proof and does not publish or retry after Monitor reload`; `keeps advisory ready during held report flight and fences %s while draining`. |
| scheduler: inventory arrival authorizes children, accepted resource intent survives before inventory, second workbook intent | Removed product model. Generic `subtask-monitor` tool-free decomposition and optional metadata cases, `coverage-monitor` held mandatory extraction,22-child gate/proposal, and metadata amendment preserve real ingress/currentness. Metadata never itself admits semantic children. |
| `coverage-storage-monitor`: semantic/health no-rebill, deep source, quote span, old checkpoint wallet | `coverage-monitor` OFF/reload keeper includes nonempty health and parent preservation; `subtask-storage-monitor` deep64-tail and wrong child span; `subtask-wallet-monitor` real charged older-restore table and full reentrancy/ON/OFF/no-rebill cases. |
| storage: six invalid tool-inventory variants erase children but retain allocator/wallet | Durable inventory authority intentionally removed. `subtask-storage-monitor` removal of all tool metadata retains generic children/allocator/exhausted wallet; `coverage-monitor` metadata amendment makes access unavailable without child loss. Live adapter malformed/error/excluded/duplicate/call guards stay. Canonical conversation source invalidation still prunes semantic authority. |
| `coverage-store`: parent isolation, replay, IDs/reorder, explicit removal/replacement, bounds, labels, currentness, detached state, non-parent completion | `subtasks-store` generic admission/replay/refinement/removal/retirement/report/reconcile/limits suites, plus `subtasks-checkpoint` allocator and provenance roundtrip. File/resource-derived identity and one-resource-per-parent constraints intentionally replaced by explicit grounded generic child identity. |
| `coverage-checkpoint`: detached roundtrip, allocators, stale group/report provenance, raw/schema rejection,64KiB/512KiB and wallet | `subtasks-checkpoint`: roundtrip generic provenance, allocator continuity, local stale group pruning, stale report status reset, hidden-key and byte limits. `subtask-envelope`: exact whole envelope and shared component budgets; `subtask-journal` exact dispatch/provider accounting. v10 acceptance intentionally removed; v10 rejection remains. |
| `coverage-access`: durable access and atomic stale/foreign association | Runtime-only access replaces durable access. `subtask-access`, `subtask-runtime` explicit committed linkage and reload/reset controls, `coverage-monitor` exact access and OFF/reload. No persisted access reconstruction. |
| `coverage-report`: batching, thresholds, individual/set/retraction/blocked, privacy, first chunk, stale bindings, immutable provenance, long/oversized input | `subtask-report` no-tool22-child20+2; assessed complete-set behavior; item/set threshold and ambiguity matrices; model/request/source/list fences; immutable provenance; no truncation and long context; Monitor real waves. Review-only choices become obligation-aware generic choices, not aliases. |
| `coverage-intent`, `coverage-intent-journal`, `coverage-intent-guards`: grounding, malformed output, currentness, bounded reservation/receipts, negative no-rebill, detached state, canonical parent identity | `subtask-gate`, `subtask-proposal`, `subtask-journal`, `subtask-runtime` and actual `subtask-monitor`/`subtask-recovery-monitor`. Gate yes required before generated list, exact spans/model/parent/list binding, currentness and detached input, explicit noop/negative suppression, shared20-owner/200-receipt/1024-call limits. Resource-path/kind/parentIndices intent protocol retired. |
| `coverage-receipt-capacity`: old40-child/20-parent receipt shape fits fixed byte budget | Old schema-specific size positive is not a new-schema capacity guarantee. Generic envelope exact shared64KiB controls and runtime `adaptively fits one child using real candidates and conservative final growth, not fake assessments` preserve safe dispatch; history is evicted only under capacity pressure ([ref:subtask_capacity_eviction]). Bounds remain unchanged; incomplete work stays visible. |

## Mandatory codec consumers retained and ported

`advisory-origin`, `hybrid-checkpoint`, `hybrid-focus`, `hybrid-fourth-review`, `hybrid-journal-replay`, `hybrid-review-core`, `hybrid-review-third` and `subtask-envelope`: **171 PASS** on strict v11. No mandatory assertion deleted. Current/future/obsolete version policy, exact replay/undo/event/focus proofs and no-rebilling survive codec removal.

## Deliberate preservation controls

Each mutation was applied individually, executed against retained tests, then source restored byte-for-byte:

- Skip child canonical-source validation in `SubtaskStore.restore`: wrong-child-quote Monitor keeper fails (stale group retained).
- Bypass dispatch persistence in `Monitor.commitSubtaskCandidate`: pre-network veto keeper fails (2 report calls instead of0).
- Drop omission metadata from v11 projection: oversized omission table fails both rows (summary missing).
- Replace live history with incoming history in restore merge: all four real-wallet older-restore rows fail (refund).
- Return empty active report-parent set: three of four parked-report/decomposition ordering rows fail (forbidden gate runs); the fourth remains a negative control.

Restored SHA256: Monitor `4f4978acf5edfe869f803470a9be8da5d3ab96bfbbbb52c5fff70c781e6e2db6`; SubtaskStore `b6e4929da5c3ecc772b9e923a8cbedc9010563a60cec2bf90134a1cc8ab68168`. All43 keeper files then pass924 tests; no mutation left in shipping source.

## Removal boundary

Main removes only the ten named obsolete semantic suites and unused legacy-only fixture helpers. Keep `coverageNames` and frozen diagnostic corpus unchanged. Keep all adapter, generic Monitor/UI/reconciliation/host, mandatory, health and continuation tests.

Source worker removes old semantic store/intent/report, Monitor fields/methods/gateway/queue/telemetry and old-v10 codec surface as one coherent candidate. Rehome shared passive adapter data types and mandatory validators in their live owner; no facade, migration, fallback, aliases or weakened bounds. Main owns any further test edit. Whole gates and independent cumulative preservation review remain mandatory before accepting retirement or C05–C09.

## Source cleanup verification

Worker3527ce16 removes the three legacy modules and their Monitor/v10 codec graph (5308 deleted lines). Main ports six remaining capacity-test imports to the existing `subtaskCheckpointBytes` v11 helper, without aliases or assertion changes. Main removes the unused public export on the adapter-local inventory type.

Full gates caught a real deletion regression: `hybrid-fourth-monitor` extraction saturation restored output tokens as0 instead of the saved maximum (1985PASS/1FAIL). Cleanup had accidentally removed the mandatory output-token assignment adjacent to the obsolete graph. Main restores that assignment; the retained regression now passes. Final `make format`, `make check`, `make test`: **1986 unit /86 integration PASS**, with three historical Biome warnings. Independent full-stage review remains pending; no C05–C09 acceptance or continuation/semantic-QA claim follows from this green run.
