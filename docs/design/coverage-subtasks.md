# Coverage subtasks — C00 frozen contract

Status: C00 contract publication. No runtime wiring, checkpoint bump, test/fixture edit, paid dispatch, release, install, or Beads mutation belongs to this change.

This document turns the approved `pi-progress-barroot-0wy` design into implementation constraints. `PRODUCT.md` and `README.md` remain current runtime authority until later tickets implement and document v10. Historical planning documents do not override either file.

## Invariants and scope

`[tag:coverage_not_task_authority]` applies to every type and consumer below:

- Coverage is one optional, one-level group of children under an existing parent deliverable. It is not `HybridTask` nesting and never creates 22 top-level tasks.
- Coverage never changes parent scope, inclusion, revision, completion, health, focus, tool ownership, Beads state, correction eligibility, advisory readiness, or the top-level done/included fraction.
- Existing limits stay fixed: 20 included parents, 200 total parents, six extraction additions, five health fields, 20 health jobs, and one health flight.
- A child status is a reported claim. Access/read evidence is separate. Neither proves understanding, correctness, parent completion, or serial progress inside an opaque tool call.
- No generic hierarchy, tool execution, arbitrary shell/output parser, provider fallback, hidden retry, polling, migration, or new progress command is authorized.

A parent can be `DONE` with incomplete coverage, shown as an explicit coverage qualifier. Conversely, all known children can be reported reviewed while parent synthesis remains open.

## Portable synthetic replay

`__tests__/fixtures/coverage.ts` is synthetic, not customer-workbook evidence. It freezes one complete inventory for `docs/plan.xlsx`:

1. Overview
2. Phase 1
3. Phase 2
4. Catalogue
5. Delivery Plan
6. Questions
7. Risks
8. Decisions
9. Dashboard
10. Sprint Board
11. Gates
12. Obligations
13. Client View
14. Overdue
15. Due Next Week
16. Timeline
17. Capacity
18. Scenario
19. Setup Calendar
20. Setup Gates
21. Setup Config
22. Lookup

Replay chronology is intentionally synthetic:

1. Canonical user intent: `Review every tab in docs/plan.xlsx.`
2. Existing parent `task:1`, revision 1: `Summarize workbook`.
3. Supported complete manifest/extraction inventory exposes the 22 exact key/label pairs in the fixture.
4. Supported matched reads may identify one item or a batch; partial reads are access evidence only.
5. Canonical assistant report `Overview reviewed` can mark only Overview `reported-reviewed` after future accepted classification. `Overview unfinished` can retract it to `pending`.
6. A future accepted, unambiguous whole-set report can mark every *known* child `reported-reviewed`; it never completes the parent.

`__tests__/fixtures/coverage-heldout.json` is a frozen, distinct held-out semantic corpus. It is not tuning input, must not be moved into `coverageTuning` after a failure, and receives no paid replay without later explicit owner authorization and cap.

## Core store contract (`src/core/coverage.ts`, C01)

The pure store owns durable group/child identity and local reductions only. It does not parse tools, read files, call a model, schedule work, mutate `HybridTask`, or use `HealthCoverage`.

### Public reducer surface fixed by the C01 red test

```ts
class CoverageStore {
  admit(input: CoverageAdmission): CoverageAdmissionResult;
  report(input: CoverageReport): CoverageReportResult;
  reconcile(parents: readonly HybridTask[]): void;
  snapshot(): CoverageSnapshot;
}

type CoverageAdmissionResult =
  | { accepted: true }
  | { accepted: false; reason: "invalid" | "capacity" | "stale" };
type CoverageReportResult =
  | { accepted: true }
  | { accepted: false; reason: "invalid" | "stale" | "foreign" };

interface CoverageAdmission {
  parent: HybridTask;
  intent: SourceRef;
  inventory: CoverageInventory;
}

interface CoverageReport {
  groupId: string;
  inventoryRevision: number;
  childIds: string[];
  source: SourceRef;
  status: "pending" | "reported-reviewed" | "reported-blocked";
}
```

`report(...status: "pending")` is the explicit accepted retraction shape. It does not delete receipt history. C05 adds separate atomic `access`, never overloads `report`, and keeps its canonical tool receipt content-free after hashing the runtime call ID:

```ts
interface CoverageAccess {
  groupId: string;
  inventoryRevision: number;
  childIds: string[];
  source: { entryId: string; messageHash: string; callId: string };
}

type CoverageAccessResult =
  | { accepted: true }
  | { accepted: false; reason: "invalid" | "stale" | "foreign" };
```

Mixed foreign/stale child batches reject before any access mutation. Access only sets the separate observed flag; it cannot alter reported status or a parent.

### Frozen data shape and identity

```ts
type CoverageChildStatus =
  | "pending"
  | "reported-reviewed"
  | "reported-blocked";

interface CoverageInventory {
  resourceKey: string;
  revision: number;
  complete: boolean;
  /** Count-only inventories set this without inventing children. */
  knownTotal?: number;
  /** Required when an existing keyed item is deliberately removed. */
  replacement?: true;
  source: {
    entryId: string;
    messageHash: string;
    /** Runtime call ID is hashed before persistence; this field is fixture-only. */
    callId: string;
  };
  items: Array<{ key: string; label: string }>;
}

interface CoverageChildSnapshot {
  id: string;
  key: string;
  label: string;
  status: CoverageChildStatus;
  /** Separate canonical observed-access receipt, never a review claim. */
  accessed: boolean;
}

interface CoverageGroupSnapshot {
  id: string;
  parentTaskId: string;
  parentRevision: number;
  parentSourceDigest: string;
  intent: SourceRef;
  resourceKey: string;
  inventoryRevision: number;
  complete: boolean;
  knownTotal?: number;
  children: CoverageChildSnapshot[];
  omissions: string[];
}

interface CoverageSnapshot {
  groups: CoverageGroupSnapshot[];
}
```

A concrete group is scoped to `(parentTaskId, parentRevision)` — exactly one group exists for that parent revision. Its first admitted `resourceKey` is immutable group provenance. A competing resource for that same parent revision abstains; it cannot create a second group or merge labels. Only an explicit supported inventory replacement can replace the resource. Different parents may each have a group with same labels or different resources. `resourceKey` is exact validated identity, never a fuzzy path/label match.

The store allocates opaque group and child IDs. A child identity is the group plus exact item key, never item label or array position. A reordered inventory changes displayed child order but preserves IDs. Duplicate inventory keys reject atomically. Same labels under different parent groups stay distinct. Labels must be non-empty, control-free, and at most 240 Unicode scalars.

At most 64 children exist in one group, 200 retained children exist in a store/session, and a projected complete group inventory is at most 32 KiB. Admission is whole-input atomic: capacity or validation failure publishes no partial group, ID allocation, child status, or receipt. A count-only inventory may preserve `knownTotal` and an explicit omission but has zero invented children.

For a new inventory revision:

- Exact same keyed set may reorder without replacement.
- New keys are admitted only in a complete higher revision and visibly enlarge known coverage.
- Missing old keys require `replacement: true`; otherwise reject rather than silently counting removed work as reviewed.
- A replacement never fuzzy-merges renamed keys. It preserves exact unchanged keys, creates new IDs for new keys, and makes removed children unavailable with an explicit omission/receipt.
- A repeated identical admission is a no-op, including IDs and snapshot value.

Every snapshot is a detached deep copy. Callers cannot alter store state through a snapshot or input alias.

### Parent reconciliation and report transitions

`reconcile` matches only parent ID and requirements revision:

- Parent `DONE` retains children and statuses.
- A changed parent revision invalidates every group for that parent; no child can cross requirements revisions.
- Label/source wording-only edits with unchanged parent revision preserve group IDs, children, report receipts, and the original `parentSourceDigest`.
- Archive (`included: false`) retains facts and IDs but makes later coverage work ineligible. Restore preserves those IDs; later runtime wiring must revalidate canonical receipts before reuse.

`parentSourceDigest` is SHA-256 of the exact parent `SourceRef` at group admission. It is provenance, not a second mutable scope gate. Keeping it immutable on wording-only revisions prevents a harmless rewritten label/source reference from silently rewriting authority. Only parent revision change invalidates a group.

A report must name a current group, its exact current inventory revision, and only child IDs belonging to that group. Any stale revision, foreign ID, invalid source, duplicate child ID, or mixed valid/invalid batch rejects atomically. Valid transitions are:

| Prior | Accepted report status | Result |
| --- | --- | --- |
| pending | reported-reviewed | reported-reviewed |
| pending | reported-blocked | reported-blocked |
| reported-reviewed / reported-blocked | pending | explicit retraction |
| any | same status | idempotent receipt/no status change |

Every accepted report stores a bounded receipt: group ID, inventory revision, exact child IDs, transition, canonical `SourceRef`, accepted assessment/request hash when later classifier wiring exists, and a content-free receipt digest. Report text, prompts, model envelopes, and reasoning do not enter the store/checkpoint.

Access is separate from this transition table: observed read/extraction, partial/unknown mapping, and failed attempt are access facts. Access may identify an item/batch in runtime UI but cannot call `report`, advance child status, or affect a parent. C05 persists at most one canonical hashed tool receipt per accessed child; reload revalidates that receipt and clears only `accessed` when its source is stale. Inventory/source loss still drops its whole optional group.

### C01 frozen test compatibility

`__tests__/coverage-store.test.ts` deliberately imports a missing `CoverageStore`; its missing-module RED is expected until C01. C01 must make its current cases green without test edits:

- admit 22 pending children without mutating parent input;
- no-op duplicate inventory and ID stability across reorder;
- detached snapshots;
- atomic 65-item capacity and invalid duplicate/control-label rejection;
- same-label/different-resource separation across distinct parent groups;
- reviewed/retraction reports without parent status mutation;
- stale/foreign report rejection with no partial change;
- done-parent retention, requirements-revision invalidation, and wording/archive/restore ID preservation.

Future access/replacement/count-only cases require a Main-authored test handoff before C01 source changes. No shim, test weakening, or fixture change is permitted.

## Intent admission when scope gate is unchanged

Coverage intent is optional sidecar admission; it is not a `HybridTask` patch operation. An unchanged mandatory scope gate therefore does **not** block a later canonical coverage intent, inventory, access fact, or report.

An intent is admissible only when all conditions hold:

1. A canonical active-branch `user`, `intercom`, or unconditional `assistant` commitment contains an exact quoted enumerable-work obligation. Conditional offers, examples, quoted instructions, document text, tool arguments/results, UI selection, health focus, and arbitrary custom messages abstain.
2. A selected-model optional proposal returns the exact quote reference and is independently bound to one existing included parent task at its current revision. It supplies no arbitrary parent/group/child IDs and no new parent obligation.
3. Code validates role, active-branch entry ID, message hash, offsets, quote hash, quote equality, parent ID/revision, and supported resource association before calling `CoverageStore.admit`.
4. The dedicated optional intent dispatch is bounded, has a canonical source identity, and is fenced by source/parent revision/branch/control epoch. Mandatory extraction remains independent: an optional failure, rejection, or exhaustion leaves parent semantic work untouched.

When the normal scope gate says unchanged, a canonical wake may enqueue this dedicated optional intent proposal against an existing parent. It must not rerun mandatory extraction merely to manufacture coverage, and it must not admit new parent scope. A captured inventory arriving first remains a bounded pending candidate until the above intent exists; overflow records incomplete coverage rather than silently discarding material or reordering semantic work.

## Supported passive adapter profile (`src/sources/coverage.ts`, later C04/C05)

The adapter is passive, main-session-only, and format-specific. It consumes already-observed matched tool events and later canonical results. It never opens a workbook, reads a path, runs a command, follows another session, or parses arbitrary shell output. It locally recognizes only the literal command grammars below; no generic shell parser is introduced.

Initial supported profiles are deliberately narrow:

| Profile | Exact allowed bash form | Required final canonical result shape | Projection |
| --- | --- | --- | --- |
| `workbook-manifest-xml/v1` | `unzip -p [--] <repo-relative-workbook>.xlsx xl/workbook.xml` — exactly four/five shell words, no redirect, pipe, substitution, glob, extra flag, or member | bounded XML document with one `<workbook><sheets><sheet name="…"/></sheets></workbook>` hierarchy; each sheet has a non-empty control-free `name`; no duplicate projected key | ordered worksheet keys and labels for the invoked workbook, complete only when full result and all declared sheets fit bounds |
| `worksheet-extraction-list/v1` | `bash <attested-repo-relative-script> <same-repo-relative-workbook>.xlsx` — exactly three shell words; the script/write/read/invocation attestation below is mandatory | bounded newline listing; every nonblank line is exactly `<name> rows <positive decimal> nonempty rows <nonnegative decimal> file <repo-relative-extracted-file>`; `<name>` must exactly equal one unique manifest label and each file must be unique | resource-attested item/file mapping and batch access candidates; row counts are display-neutral metadata, never review proof |
| `worksheet-content-read/v1` | `cat <one-or-more-attested-extracted-files>` or `sed -n '<positive decimal>,<positive decimal>p' <one-or-more-attested-extracted-files>` — literal token forms only, all files from one current extraction listing | any final canonical non-error result; its content is not structurally parsed for coverage | observed item/batch access only; it cannot create inventory or mark reviewed |

The local grammar recognizes ASCII spaces only, rejects control characters/quotes other than the literal `sed` range quotes, and permits no shell operators. Workbook, script, and extracted-file paths must be repository-relative after normalization, contain no controls, stay within project root, and match a current attestation. The parser persists validated resource/file identity digests, never raw command text or paths. Only the attested script `read` is supported; all other `read`, arbitrary `bash`, shell snippets, generated filenames without attestation, arbitrary XML, count-only prose, cell values, comments, formulas, tool partials, and unknown tool names abstain.

The extraction-list producer is attested, not inferred from a script filename. Before list admission, one active canonical branch must prove this chain for one workbook resource:

1. a successful canonical `write` or `edit` declaration writes the script path and its content digest is captured locally;
2. a later successful canonical `read` of that exact script path has final content whose digest equals the write/edit declaration digest;
3. the exact allowed `bash <script> <workbook>` invocation uses that read-validated script path and the same normalized workbook path as the accepted manifest invocation;
4. the final canonical listing passes its line grammar and every listed name resolves exactly once to that manifest.

The script body and command/path values are used transiently for local digest/equality validation only. Script declaration and final script-read content are each whole, at most 32 KiB, and reject truncation/omission. They are never persisted or sent to a provider. A write/read mismatch, altered script, missing canonical declaration, different workbook argument, unknown extracted file, or unproven origin/resource association abstains. It does not make a generated filename a worksheet.

Result guards apply before structural parse: whole final text only; maximum 32 KiB; no `excludeFromContext`; no truncation/incomplete marker; no host error; exact profile/resource binding; and all-or-nothing parse. The manifest itself is capped at 64 names × 240 scalars; extraction listing at 64 records × 240 scalars. A claimed count with no names records `knownTotal`/inventory-unavailable when safely attributable, never 22 synthetic children. Adapter output retains only validated labels, keys, completeness/omission scalar, resource/file identity digests, and row-count scalars.

## Canonical tool authority proof and adapter receipt

Main's frozen real-host faux-provider test is `__tests__/coverage-host.integration.test.ts`, committed in parent `qqkzpmnz` (`81362acb`). It passed on global Pi 0.85.1: **1/1 PASS**. It proves this sequence for both one successful and one failed `read`:

1. `tool_execution_start` receives each unique `toolCallId`.
2. `tool_execution_end` for each result sees no matching result in current branch: it is preappend and non-authoritative.
3. The later `message_end` for that `toolResult` also sees no matching canonical result in current branch.
4. A later extension listener replaces successful result content before Pi commits the final canonical entry.
5. After prompt completion, active branch contains exactly paired canonical results: successful result has replacement content; failed result retains `isError: true`.
6. Branching back to root excludes these result entries from active branch while global entry storage still contains them.

Therefore `tool_execution_end`, `message_end`, tool partials, and raw event result bodies are **candidate-only**. End precedes the tool-result `message_end`; both are preappend. Future ingress may use start/end to pair ephemeral calls and clear runtime current activity, but durable inventory/access admission must wait for a named canonical wake (`context`, `turn_end`, or `agent_settled`) that re-reads the active branch after the event frontier.

A durable tool receipt requires all of these facts in one atomic admission:

- matching unique started call ID and terminal result call ID, same supported tool name, nondecreasing local order, and no duplicate terminal acceptance;
- final result entry currently exists once on active canonical branch, is after saved frontier, has same call ID/tool name, and passes profile/result guards;
- parent current revision plus accepted coverage intent and unambiguous resource mapping are current;
- final canonical content hash and parsed inventory/access projection agree with the candidate; listener-time content is never trusted over this hash;
- source amendment, navigation, OFF/control epoch, parent revision change, error, excluded result, failed/truncated parse, or branch disappearance fences the candidate.

Persist `CoverageToolReceipt`, not a raw event/tool body:

```ts
interface CoverageToolReceipt {
  profile: "workbook-manifest-xml/v1" | "worksheet-extraction-list/v1";
  resourceDigest: string;
  finalEntryId: string;
  finalContentHash: string;
  callBindingDigest: string; // hash of call ID + tool name + allowed metadata
  inventoryRevision: number;
  complete: boolean;
  omissions: string[];
}
```

Raw call ID is transient for matching and is hashed before persistence. Raw command/arguments/result content, paths, cell data, formulas, comments, provider payloads, and credentials never persist or enter a provider request. `finalEntryId`/hash must validate against active branch on restore; invalid optional coverage is dropped/marked incomplete only and never causes semantic replay or health rebilling.

Runtime resource-to-item mappings last while their parent task ID/revision, group inventory revision, exact `CoverageToolReceipt`, active canonical branch, and monitor epoch remain current. Clear mappings on amendment, navigation, OFF, shutdown, source change, or explicit inventory replacement. A matching tool end clears only that call's current activity; it does not clear its validated resource-to-item mapping. Concurrent matching calls show a batch/concurrent qualifier; unmatched or ambiguous calls remain generic activity.

## Optional dispatch budget and receipts

Coverage owns one isolated optional gateway and a **1,024-dispatch budget per persisted v10 monitoring lifetime**. It is not the execution-visibility 1,024 budget, not mandatory Jev/extraction usage, and not health spend.

A monitoring lifetime is all valid continuations of one v10 checkpoint/source identity. Its coverage usage and accepted receipts survive reload and same-version restore after canonical validation. `/progress off` cancels future coverage work but does not reset that durable budget or erase receipts; `/progress on` resumes the same source lifetime. A new source/session identity starts a new lifetime at zero. Branch/control/revision changes fence stale queued/in-flight work but do not erase charged dispatch history. Unsupported v9/older/corrupt checkpoints remain OFF with no migration, reconstruction, or rebilling.

Count one coverage dispatch when gateway dispatch starts, before network I/O:

- optional selected-model coverage-intent proposals count one;
- optional Jev child-review/retraction/block/whole-set classification batches count one per actual bounded request;
- failed, cancelled-after-dispatch, timed-out, and crash-before-receipt attempts still count;
- local XML/list parsing, tool pairing, UI projection, queue replacement before dispatch, and existing mandatory extraction count zero against coverage;
- existing mandatory extraction is never double-charged merely because its canonical task later supports coverage intent.

At 1,024, no further coverage provider request starts. Retained facts remain visible with explicit exhausted/incomplete service state; parent semantics, health, details fairness, and reconciliation continue.

Coverage work has at most one in-flight request and at most 20 parent-keyed pending jobs. It drains only after finite mandatory semantic work and ready health. It rotates with optional details after each ready opportunity, preserves coalesced position, has no timer/polling, and retries only after a named canonical/evidence/control wake plus applicable expiry. It is never an advisory-settlement prerequisite.

Every queued request has this coalescing identity:

```text
kind + parentTaskId + parentRevision + groupId + inventoryRevision
+ canonical target/reference digest + coverage-control/branch epoch
```

Equal identities coalesce before dispatch and produce at most one counted request. A changed canonical reference, report, inventory, revision, branch, or control epoch is a different identity and fences old work. Accepted results retain a content-free `CoverageDispatchReceipt` containing the identity digest, request hash, dispatch ordinal, timestamp, input/output token counts, outcome scalar, and every accepted report receipt it authorized. No result may be reused for a different identity. Receipt persistence occurs atomically before durable child advancement; crash after provider acceptance but before receipt can still re-bill, as with existing provider work.

## Later checkpoint boundary

C00 adds no checkpoint fields. C02 must introduce strict v10 for groups, tool/report/dispatch receipts, coverage usage, and explicit omissions while preserving all v9 health fields/invariants. v9 and older remain OFF; no migration, historical inventory discovery, or replay/rebilling. Coverage receives at most 64 KiB inside existing 512 KiB whole-checkpoint admission and must fit both ON and OFF representations. Reject extra optional coverage with explicit omission count; never evict accepted obligations/items silently.

## Main-owned test and handoff needs

Main owns all test additions/changes and Beads acceptance. Before any source ticket, Main must provide a red/updated test handoff for its narrow behavior. Worker changes source/docs only and returns exact change/revision, commands, results, and residual limits.

C00 frozen test status:

- `coverage-store.test.ts`: intentional missing-module RED; no implementation exists.
- `coverage.ts`: synthetic 22-item tuning fixture, untouched.
- `coverage-heldout.json`: frozen held-out corpus, untouched and never tuning input.
- `coverage-host.integration.test.ts`: coverage-specific global Pi 0.85.1 faux-provider proof passed 1/1; Main also reports 13 global host tests PASS. The coverage proof establishes end-then-message_end preappend timing, late replacement, success/failure pairing, and active-branch exclusion.

Required future Main test handoffs include adapter profile parsing/guards, canonical confirmation/amendment/branch cases, duplicate/replacement/count-only behavior, access-vs-review isolation, budget/reset/receipt/coalescing behavior, v10 restore limits, UI/advisory isolation, and semantic corpus evaluation. Paid held-out evaluation remains blocked until its ticket records explicit authorization, question/model version, cases, and call cap.
