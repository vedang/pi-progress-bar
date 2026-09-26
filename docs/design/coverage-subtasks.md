# Conversation-grounded subtasks — revised design

Status: **implementation authorized; C00 contract freeze underway** (2026-09-26). Owner explicitly authorized restart after independent design/backlog review; restart gate `pi-progress-barroot-0wy.14` is closed. Replaces the workbook-bound C00 contract and original embedded design in `pi-progress-barroot-0wy`. Workbook review was an example, not the product boundary. Baseline source at `29b193d1` does not implement this design. PRODUCT/README distinguish current behavior from this revision. [C00 frozen interfaces](subtask-contracts.md) specify staged API/corpus contracts. No release, installation or push is authorized; paid QA remains subject to the stated cap and frozen manifest.

## 1. Owner requirement and acceptance

Ask Jev: **Does the current conversation indicate that this existing task should be broken into subtasks?** Only an accepted yes permits asking the currently selected Pi model: **If the conversation indicates subtasks for these existing tasks, return the grounded list.** Code validates and admits the result.

This works for implementation, research, writing, document/manual review, operational checklists and workbook review. No file, workbook path, tool invocation, inventory parser, explicit numbered list or literal word “subtask” is required. The LLM may formulate meaningful steps implied by an accepted task and conversation; labels need not be verbatim quotes. Do not invent unrelated deliverables, generic boilerplate for every task, user approvals, another person's work, or conditional offers the assistant has not accepted.

Primary acceptance: a conversation-only request to compare alternatives and write a recommendation can acquire meaningful children under its existing parent, then update them from reported progress. The same flow must handle a named chapter list and the original 22-sheet case. A trivial answer should not get ceremonial children. Generic support is not universal understanding: ambiguity is explicit and semantic calibration remains a gate.

[tag:coverage_not_task_authority] Children are one-level optional sidecar state, not nested `HybridTask`s. They never change parent scope, inclusion, requirements revision, completion, health, focus, tool ownership, Beads, correction eligibility, advisory readiness or the top-level done/included fraction. Twenty included parents, 200 total parents, six parent additions and five health fields remain unchanged. No recursive hierarchy, weights, ETA, execution controller or per-child health jobs.

Parent DONE with open children stays DONE with an incomplete/unconfirmed qualifier. All children done does not finish their parent. These invariants apply to every new consumer. Existing `HealthCoverage` remains unrelated.

## 2. Investigation and rework boundary

[Implementation audit](generic-subtasks-rework.md) records concrete source seams, reusable mechanics, replacement work and historical evidence. Ten old stage closures proved the old narrow contract; they do **not** accept this requirement. Reopen C00–C09 with revised unchecked criteria, retain their old evidence, revise C10–C12, and add a dedicated Jev decomposition-gate stage before selected-model proposals. Block implementation on explicit owner restart.

Keep bounds, atomic admission, detached snapshots, identity allocation, canonical fencing, dispatch accounting, scheduling fairness, host-event proof and read-only navigation where their tests remain applicable. Replace workbook-only semantic admission, mandatory tool-inventory provenance, resource-as-group identity, review-only status vocabulary and dependent schemas. Do not bolt on a parallel manual/document path, weaken a validator to accept arbitrary strings, or migrate the old format.

## 3. End-to-end flow

1. Existing mandatory semantic pipeline processes canonical conversation chronologically and settles current parent tasks. An unchanged parent-scope judgment does not suppress optional subtask analysis.
2. Build bounded, detached context for eligible included parents: current parent identity/revision/grounding, current child list/revision, newest canonical observation, bounded earlier canonical context, and explicit omission metadata. User, assistant and inbound intercom keep their distinct source roles. A task's ordinary creation/requirements source remains mandatory context even when older than the recent window.
3. Jev independently assesses subtask need per eligible parent. Batch up to 20 questions within 24KiB. Each answer is `yes`, `no` or `uncertain`, using pinned `jev-1.13.0`, confidence >=0.5 and chosen probability >=0.8. Only accepted yes authorizes that parent for proposal; low-confidence yes, no, uncertain and unavailable responses never trigger a hidden LLM call. Unlike mandatory scope gating, uncertainty here abstains because the requested optional flow requires yes.
4. Persist a content-free, exact-context gate receipt before proposal dispatch. It binds parent IDs/revisions, existing child-set revisions, canonical context references/hashes/omissions, rubric/model version, request identity, answer scalars and usage. A yes for one parent cannot authorize another. Candidate queue ownership is not semantic permission.
5. Ask the selected Pi model for strict structured child-list proposals for yes-authorized parents only. Supply grounded parent/context, current children, and optional validated evidence metadata. The model may return an empty proposal. It must abstain on unclear attribution, distinguish a suggested decomposition from reported completion, and cannot create top-level tasks or claim completed child work through this channel.
6. Validate source references, gate binding, schema, parent/child indices, limits and currentness. Commit the whole bounded mutation atomically with its receipt before publishing. Code allocates IDs. New or substantively changed children start pending. Invalid, stale, empty, capacity-rejected and failed results leave parent work untouched and retain explicit service/omission outcomes.
7. Separately classify canonical reports against admitted child obligations with Jev. Completed, blocked and retracted claims update child report state only. Local access/activity evidence remains orthogonal. Rendering and reconciliation read detached projections only.

### Context and repeat decisions

Recent context: newest whole canonical observation <=12KiB and at most 16 earlier whole observations within a 12KiB context allocation; parent source and total request bounds still apply. Preserve chronological order, identify omitted earlier messages, and never truncate a message into apparently complete evidence. Parent sources plus required existing children must fit; otherwise split independent parent batches, or mark that parent unavailable when its required context cannot fit. No arbitrary history scan or model summarizer is added. Omission means unknown, not evidence that scope or prior work was absent.

Hash exact supplied context, parent requirements revisions, child-set revisions and versions for deduplication. Reuse both accepted yes and no/uncertain outcomes only for that exact identity. Repeated redraws, unchanged tool events, reload and identical inputs do not reclassify. Later canonical context, changed parent requirements or genuinely new validated metadata can make a new identity; health/selection/usage changes alone cannot. A list admitted from a proposal is marked covered by that transaction: its new child-set revision alone does not recursively requeue another decomposition. Future independent evidence can request refinement.

Optional evidence arrival may wake work only when a current canonical task/conversation already provides its authority. Reassess Jev on the changed combined context before asking the LLM; never bypass the yes gate with an adapter. Gate and proposal request context changes fence the old phase. Negative decisions must not permanently suppress later elaboration of the same task.

## 4. Proposal and child-list lifecycle

One group per `(parentTaskId, parentRequirementsRevision)`; identity is not a resource path. A parent may have children spanning files, documents and non-file work. An optional resource association is child evidence metadata, never group admission authority.

Freeze a strict schema in C00/C03 with these semantics:

- Response lists parent proposals by **supplied parent index**, never arbitrary IDs. Each includes canonical evidence references by supplied context index plus exact supporting ranges; code resolves and hashes them. Evidence supports the task/decomposition, not necessarily the literal generated label. References cannot point outside the request or into tool text as task authority.
- Each proposed child has a bounded meaningful obligation label and supporting canonical references. Existing children can be referenced only by **supplied child index**. Code maps references to stable IDs; model never chooses IDs/keys/revisions or durable resource digests.
- Proposal declares a full current ordered list plus explicit removals of existing children. Every previous child must be retained or explicitly removed; omission is not withdrawal. Empty output means no change, not deleting the group. Duplicate existing references, foreign parents, contradictory operations and unsupported removals reject the entire parent proposal.
- Reordering and wording-only edits preserve child ID/status. A changed obligation is explicit replacement: new code-owned ID, pending status and retained removal evidence. No fuzzy label matching or status carry-over to new work. Exact replay is idempotent. An ambiguous rename/replacement abstains rather than silently transferring completion.
- Adding children can extend a partial list; unlike the old inventory reducer it does not require proof of a complete inventory. List revision increments on admitted structural/label changes; stale proposals/report batches cannot apply to a newer list.
- Removal requires supporting canonical evidence that the step was withdrawn, replaced or was not part of the parent's work; a model's preference for a shorter list alone is insufficient. Retain bounded removal receipts and mark denominator changes visibly. Bounds reject further changes rather than evicting obligations/history silently.
- The list is a **tracked decomposition, not a claim of exhaustiveness**. An ordinary generated plan has unknown total scope even though its current tracked count is known. A complete-set flag/known total is permitted only when the request explicitly enumerates a whole set or a supported validated inventory plus canonical obligation establishes that set, and every member is represented. Count-only “22 items” cannot fabricate 22 labels.

Code can enforce structure, provenance and stable binding; it cannot prove that a generated step is semantically necessary. Model instructions and independent held-out tests cover that risk; exact quotes are not a substitute for semantic accuracy. No extra unrequested per-child LLM/Jev validation loop is introduced.

## 5. General reported progress

Child statuses become `pending`, `reported-completed`, `reported-blocked`. A child has its own obligation: “Review Overview” completes on reported review; “Implement parser” requires a reported implementation completion, not a report that someone read the file. UI says **Reported complete**, not verified or universally reviewed.

Jev choices are completed/retracted/blocked/unchanged/uncertain. Named completed claims update only matching children; explicit retraction returns them to pending. Silence, future plans, access, hypothetical/quoted/sample text, filename mentions and cross-parent statements cannot advance or withdraw work. Ambiguous attribution abstains at unchanged thresholds. A whole-set claim may complete all tracked children only for a currently proven complete set, current list revision and unambiguous parent; otherwise require item-specific evidence. No phantom children or inferred remainder completion.

Report batches preserve <=20 questions/24KiB and adaptive receipt-capacity preflight. Store every assessed outcome, including unchanged and uncertain, so accepted no-change chunks are not rebilled. Retain canonical report receipts, request identity and actual dispatch accounting. Report/source loss drops only affected report facts; no required parent semantic replay.

## 6. Optional tool enrichment, not a creation gate

Existing supported workbook adapters may continue to project bounded labels, exact resource identity and access candidates from canonically confirmed tool results. They remain passive and narrow; no universal parser, filesystem reads, commands, sibling sessions or raw tool-output provider ingestion.

Validated labels/identity/completeness scalars can be supplied as untrusted evidence metadata alongside a canonical task obligation to the Jev→LLM flow. They never directly call semantic child admission or choose a parent based on selected focus. Names-only evidence cannot establish review/completion. Multiple resources under one parent are allowed; ambiguous same-label mappings stay unlinked. Resource-to-child mapping requires a unique validated association with an admitted child and current parent/list revisions. Unsupported mapping leaves generic activity and **access unavailable**, not a false “not accessed” claim for tasks where access is irrelevant.

Existing host proof remains essential: tool end/message_end are preappend candidates, not durable authority. Canonical active-branch result/call identity, final hash, exclusion/error/truncation guards and listener mutation fencing stay intact. Exact end clears only its call; concurrent matches display a batch. Metadata mappings reset on revision, branch/amendment/control changes. Generic conversation-only subtasks must work when no adapter is installed or no tool runs.

## 7. Persistence, scheduling, limits and privacy

### Strict v11, not a v10 compatibility extension

New generic provenance, status vocabulary and two-phase decomposition journal require **strict checkpoint v11**, implemented in C02; this planning edit does not change runtime version. v10 and older stay OFF with fresh-session guidance. No migration, alternate legacy path or historical reconstruction/rebilling. Preserve independent-health and parent fields/invariants.

Admission provenance records canonical refs plus Jev gate and selected-model proposal receipts. A tool source is optional; never fabricate a `callId` to satisfy old schema. Durable phases are gate-ready, gate-decided/proposal-ready and proposal-decided, with explicit parked/permanent failure state. Save accepted gate before LLM; after reload resume only a current unfinished proposal without rebilling gate. Saved accepted list resumes without either call. If refs are stale, discard affected optional authority, preserve charged counters and wait for new eligible canonical work rather than silently replaying history.

Persist only bounded generated labels/IDs, parent/list revisions, canonical hashes/ranges, scalar assessments, allocation/omission state, content-free phase/dispatch proofs and optional hashed tool evidence. No prompts, raw conversation/tool bodies, reasoning, provider envelopes, credentials or raw runtime call IDs. Labels may contain sensitive user terms or paths: document that generated labels are stored/displayed and sent to providers; sanitization is not secret redaction.

### Reuse bounded scheduler, extend its phase machine

One optional subtask provider flight across gate/proposal/report; <=20 parent-owner jobs with ordered coalescing. Ready mandatory semantics and health retain priority; subtask work and details rotate ready opportunities. Currentness fences before charging, before network and after response. Parent/source/list/branch/control changes supersede stale jobs even at exhaustion or when jobs are parked/unqueued. OFF cancels future work; archive retains facts without scheduling; restore requires current authority. No per-child health queues, timers, redraw calls, polling, hidden retries or provider fallback.

Shared optional lifetime allowance **1,024 dispatches** now counts decomposition Jev gates, selected-model proposals and report batches, including failures/cancellations after dispatch. Charge durably before each network attempt; storage failure means no dispatch. Local mapping/rendering costs zero. Exhaustion must prevent an LLM call even when the last allowed Jev request says yes. Save a recoverable/service outcome, never reset budget to get past it. Crashes after remote acceptance and before local receipt can still cause charges on explicit recovery; do not promise exactly-once billing.

Keep 64 active children/group, 200 retained children/session, 200 groups including empty, 240 Unicode scalars/label, 32KiB list/proposal projection, 64KiB optional allocation inside 512KiB whole checkpoint, and existing 16-candidate/64KiB tool queue. Removed/replaced retained child identities count toward retained bounds until their safely bounded retirement policy is specified and tested; no silent eviction. Both ON/OFF envelopes must fit. Whole-mutation admission only; visible omission/capacity state, not a truncated authoritative list. Do not enlarge limits to avoid design work. Receipt-count ceilings and byte fit must be independently tested, including tiny adaptive report chunks.

## 8. Presentation and reconciliation

Rename user-facing Coverage to **Subtasks** and reviewed to **Reported complete**. Keep independent scrolling, stable child anchor on updates, reset on parent change, sanitization, narrow geometry, parent Summary ownership, debugger/MAYBE/history and exact 12-cell parent progress. Show tracked count separately from exhaustive/unknown total; no inferred percentage of the entire parent. Optional access/current item or batch appears only with evidence and is never a prerequisite for a generic child row.

Grouped reconciliation preserves every unfinished parent row and admitted MAYBE receipt. Append bounded per-parent reported child counts/gaps with exact parent revision and explicit omission labels; all labels are JSON-escaped untrusted data. Preserve baseline on overflow, <=24576 raw UTF-8 bytes and <=32768 JSON string-body bytes. Optional subtask work never delays readiness. No child correction authority, per-child nudge, all-DONE wake, new timer or separate toggle.

## 9. Reworked implementation backlog and exit gates

Existing epic remains `pi-progress-barroot-0wy`; its embedded design must match this file. The **owner restart gate** was closed on explicit authorization after design/backlog review. C00 and subsequent stages now execute in dependency order; prior historical closures still do not accept revised behavior.

| Order | Existing/new stage | Deliverable and smallest passing increment |
|---|---|---|
| 0 | Owner restart gate (new) | Explicit owner approval after revised design/backlog notification; not implied by this revision request |
| 1 | C00 `.1` reopen | Freeze generic contracts, main-owned REDs and genuinely fresh held-out corpus before any prompt tuning; preserve old fixture/failure |
| 2 | C01 `.2` reopen | Generic conversation-backed store/list lifecycle and pending/completed/blocked statuses, no required resource/tool source; pure reducer proof |
| 3 | C02 `.3` reopen | Strict v11 and durable gate/proposal phases, preserved parent/health semantics and atomic byte/budget controls |
| 4 | C03a new | Bounded per-parent Jev need gate, exact-context positive/negative receipts, no/uncertain/no-key paths, tests prove zero LLM dispatch |
| 5 | C03 `.4` reopen | Grounded selected-model list proposals only for accepted yes parents; identity-preserving edits, explicit removal, no task-scope mutation |
| 6 | C04 `.5` reopen | Demote workbook adapters to optional metadata/access enrichment, separate resource identity from child identity; no adapter gate |
| 7 | C05 `.6` reopen | Working actual-host conversation-only vertical slice: Jev yes→LLM children, no path/tool; workbook case uses same path |
| 8 | C06 `.7` reopen | Generic obligation-aware reported completion/retraction/blocking, unchanged thresholds and exact child binding |
| 9 | C07 `.8` reopen | Full two-phase fairness/durability/recovery/cap/coalescing integration and adversarial lifecycle proof |
| 10 | C08 `.9` reopen | Generic Subtasks UI, unknown scope, access unavailable, real TUI no-file and 22-child navigation |
| 11 | C09 `.10` reopen | Generic reported-child reconciliation without parent/MAYBE loss or authority changes |
| 12 | C10 `.11` revise | Production-path held-out semantic evaluation of BOTH gate and proposer plus reports; no tuning on held-out failures |
| 13 | C11 `.12` revise | Full QA/package/independent review; resolve or block on global advisory host failures and current installed-host evidence |
| 14 | C12 `.13` revise | Fresh-v11 manual checklist for software/research/manual/workbook/no-subtask cases; explicit owner acceptance remains separate |

Each stage retains old successful safety regressions unless the owner-approved contract explicitly supersedes them. Main authors tests/fixtures and reproduces REDs before worker source changes; workers do not edit tests. Independent review examines full stage changes. Keep logical jj commits; no branch creation or release/install/push. Do not split “generic” into a whitelist of document types.

## 10. Evaluation and handoff

C00 freezes a new corpus and expected outcomes covering implicit decomposition without pre-listed children, explicit lists, trivial no, uncertain need, negative then elaborated positive, mixed parents with one yes, tool-free research/software work, manual chapters, multi-resource parent, workbook 22 names, count-only/incomplete inventories, quoted instructions, unaccepted conditional offers, third-party work and same-label ambiguity. Include add/reorder/relabel/replacement/removal, late/no-op report, retraction/blocking, whole-set and stale-source cases. Track gate quality, proposal quality/parent correctness, status quality, dispatch counts, tokens and latency separately.

Preserve `coverage-heldout.json` and h14's failed preflight as original evidence. They are now observed cases, not a fresh held-out quality gate. No relabeling h14 as a passing abstention. Fresh evaluation must not be used as tuning data; failures require owner-approved revision and another fresh gate.

Original authorization was96 Jev +16 selected-model requests, with zero used when this plan was published. Owner subsequently authorized paid calls as needed to finish both tracks and explicitly requested no further spend-permission prompts. That latest authorization supersedes the original QA ceiling, not runtime budgets or semantic acceptance gates. C10 still freezes finite per-request manifests for both phases/report chunks and all failed attempts; keep generic and continuation ledgers separate. No hidden retries, accidental other live suites or scope-gate calls omitted from ledger. Failed cases remain evidence, not reusable held-out acceptance after tuning; freeze fresh evaluations when repairs require them.

Required QA: main-owned deterministic guards, real-host mocked provider flow, actual TUI, strict reload/branch/OFF and storage faults, format/check/unit/integration/package gates, independent full-batch review, and separate capped real-provider evaluation. Local SDK and installed Pi versions must be recorded as actually tested; the previously observed 0.84.2 versus 0.87.1 mismatch is not proof of causality or compatibility. Keep global advisory timing/lifecycle failures visible until resolved.

Deferred test audit `pi-progress-barroot-hmv` remains blocked on the **entire revised epic**, including new stages, and explicit post-feature owner manual-review gate `pi-progress-barroot-y86`. Revision does not authorize that audit, test cleanup, or deletion. This design review is not implementation or manual acceptance.
