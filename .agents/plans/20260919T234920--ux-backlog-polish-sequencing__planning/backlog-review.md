`★ Insight ─────────────────────────────────────`
Dependency order mostly strong. One rich-detail enablement gate remains ambiguous: implementation precedes required calibration.
Polish scope has acceptance evidence, but missing concrete source/test seams weakens agent handoff.
`─────────────────────────────────────────────────`

## Review

### Correct

- Exact backlog present: epic plus 25 children at `.beads/issues.jsonl:59-84`.
- All 26 records remain `open`; creation scripts only create/update new `y3h` records. Existing repair statuses untouched (`create-backlog.py`, `status-amendment.py`).
- Native containment correct: every child has parent-child edge to epic. No reverse epic blocking edge.
- Serial work graph correct: U00 has no work prerequisite; remaining 24 children each depend on prior child. Index matches actual Beads records.
- A0 correctly treats `124ee557` / `6cc4005e` as review-pending candidates, not accepted base (`descriptions/U00.md:1-8`).
- Test-first ownership correctly alternates main-owned red tests and implementation through functional slices. P01/P02 explicitly require main tests before worker implementation.
- Functional scope includes A0–D, tool focus, and rich details before U19 handoff. Polish starts only after frozen U19 revision.
- Visible status contract covers typed `OPEN`/`INPROG`/`DONE`, stale-focus invalidation, explicit unknown/multiple/pending states, archived distinction, and reachable retained DONE (`status-contract.md:1-8`).
- P02 forbids interpolated completion, animated health, fabricated activity, polling, persisted phase, and leaked timers.
- Q00 waits for actual manual feedback and forbids invented approval.

### Finding: P1 — Rich-detail calibration gate occurs after possible enablement

**Locations**

- `descriptions/U15.md:2`
- `descriptions/U15.md:101`
- `descriptions/U16.md:2`
- `descriptions/U17.md:8`
- `descriptions/U19.md:8`
- `tickets.json:198-223`

**Evidence**

U15 says to enforce thresholds and extend projection/right pane. Same ticket’s copied contract says thresholds are “not approved/calibrated” and must be evaluated before rich sections are enabled. Calibration/confirmation happens only in dependent U16. U16 may merely “record blocker,” while U17 and U19 require complete A0–D and all planned behavior.

Implementer therefore lacks deterministic instruction whether U15 must:

1. ship rich sections enabled before U16 validation,
2. implement them disabled pending U16, or
3. stop without completing U15.

This can expose uncalibrated rich details or leave no explicit post-validation enable/fix step.

**Smallest fix**

Amend U15: implement storage, jobs, validation, projection, and rendering behind disabled gate; no rich section enabled before U16 acceptance.

Amend U16: after policy acceptance, main owns threshold red tests; source worker applies required fixes and enables rich sections; rerun U14/U15 gates. A blocker keeps U16 open and prevents U17. Remove “or record blocker” as a completion path unless explicitly marked unresolved/blocking.

### Finding: P2 — Polish tickets lack concrete file/test/artifact seams

**Locations**

- `descriptions/P00.md:1-8`
- `descriptions/P01.md:1-8`
- `descriptions/P02.md:1-8`
- `descriptions/P03.md:1-8`
- Compare functional file sections listed across `descriptions/U00.md:95` through `descriptions/U16.md:95`.

**Evidence**

Functional tickets name source and test seams. P00–P03 provide behavior and acceptance evidence but no expected files, fixture paths, screenshot/artifact locations, or targeted commands. P01 and P02 both authorize source changes, so workers must rediscover scope despite requirement for standalone agent-ready tickets.

**Smallest fix**

Add per-ticket `Files and evidence` sections after accepted-base inventory:

- P00: design fixture/output paths and decision artifact.
- P01: widget/board/layout/controller seams plus exact visual/theme tests and screenshot directory.
- P02: controller/render timer, preference/control, fake-clock tests, performance artifact, and documentation paths.
- P03: review artifact, gate commands, host-QA evidence, and revision handoff location.

Do not guess paths now if accepted runtime may move; require P00 to record exact pinned-runtime paths before P01 starts.

### Merge verdict: BLOCK

Fix P1 before execution. P2 should also be amended to satisfy standalone agent-ready ticket requirement. No runtime, tests, provider calls, or Beads edits performed.