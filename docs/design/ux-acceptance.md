# Progress UX — local candidate acceptance

> Historical acceptance evidence below is unchanged. The later `pi-progress-barroot-7rv` change independently schedules per-task health and introduces strict v9 coverage proof; old v8 sessions remain OFF without migration. These earlier test totals/review do not certify that later implementation. See PRODUCT.md and README.md for its current contract; final full-batch verification/review is tracked in `7rv.8`/`7rv.9`.

## Frozen source

- Accepted hybrid baseline: `0102cde4`.
- Reviewed repaired source: `d10cf4e02ce9de4110f51022cdcb512c8be840ad`.
- Stable jj change ID: `qynlrlykutuptlosloynumurxwsyzlru`.
- Independent consolidated review: **APPROVE**, reviewer run `05ae0b1e-f2eb-4313-b938-296a482bf1f5`.
- Owner manual acceptance: **pending**. This is a local testing handoff, not a release.

The full UX batch includes compact widget/board interaction, initial qualified OPEN selection, live lifecycle updates, single-copy Summary, safe provisional/corrected tool focus, grounded optional details, task-local diagnostics, and static theme-aware polish. Advisory nudges are not included.

## Verification

| Gate | Result |
|---|---|
| `make format`, `make check` | PASS |
| Full deterministic unit suite | 664 PASS |
| Integration suite with installed Pi0.85.1 host enabled | 26 PASS |
| Actual Pi0.85.1 UI PTY matrix | 64 PASS |
| Exact owned-overlay/editor restoration probes | 2 PASS before focused repairs; ownership code unchanged |
| Post-repair co-load/theme content equivalence | PASS |
| Tool-focus live Jev calibration | 5 calls; no wrong accepted selection |
| Post-repair rich-detail live Jev calibration | 8 calls, 10 field labels matched; 4406 input / 434 output tokens |

The UI matrix covers dark/light themes; regular/fullscreen modes; both input-listener orders; physical terminal sizes 60×25, 80×24, 120×40 and 160×50; standalone and actual pi-subagents/progress co-load. Co-load exposes registration but invokes no child tools. Probe network attempts were zero. Scripted snapshots and deterministic live-controller tests complement, but do not replace, owner testing.

Local detailed receipts live under `.agents/plans/20260920T024013--implement-approved-progress-ux__active/` and managed subagent outputs. Planning files and raw captures are intentionally untracked.

## Review disposition

Nine main-owned regressions reproduced and now cover the actionable review gaps:

- Activity gateway recovery after canonical amendment.
- New/uncertain activity superseding stale INPROG or retained idle DONE.
- Accepted details surviving bounded semantic-cache aging without UI history reads.
- Conservative receipt-size admission and atomic optional receipt/token rollback.
- Bounded full-context detail requests with deterministic coverage/resume.
- Wide/narrow reachability of per-field source role, validation time, confidence and probability.

Documentation was aligned with actual command behavior and production enablement. The reviewer accepted the existing U11 identity contract: internal call-ID replacement is a changed batch; IDs never enter provider metadata. Confidence thresholds remain unchanged at 0.5/0.8. The earlier manual-session 0/2 result remains valid abstention.

## Load locally

Use Pi0.85.1, the existing `TYPESAFE_API_KEY`, and your configured selected model. From the project you want to test:

```sh
pi --no-extensions -e /Users/vedang/src/vedang/pi-progress-bar/pi-progress-bar.arch/src/index.ts
```

This explicitly loads the candidate without an installed duplicate. It does not install or update packages. An already-running candidate session can use `/reload`; prefer a **fresh session** for end-to-end validation.

Strict v8 rejects v7/older or corrupt checkpoints and leaves monitoring OFF with a fresh-session warning. No migration or historical rebilling occurs. Changed optional request proofs can discard older detail records without rebuilding them. A reload does not promise retrospective enrichment of already-accepted tasks.

## Focused manual checklist

1. Request two distinct deliverables. Confirm a named qualified OPEN task appears before confident activity.
2. Observe semantic/tool-only task switching. INPROG must not imply completion; concurrency/uncertainty must not invent a current activity.
3. Right selects the widget only from an empty default editor; usage appears only while selected. Enter opens the board.
4. Check newest-created ordering, both scrolling panes, one Summary, and `d` diagnostics. Long text and Unicode must remain reachable after resize.
5. When optional details appear, check exact wording and per-field source role/validation time/confidence. Omission is valid; placeholders or inferred criteria are not.
6. Confirm accepted completion, threshold abstention, revision/reopen, archive/restore and OFF behave coherently. Escape must close only this board.
7. Report the candidate/session revision and reproduction steps with any issue. Never paste credentials.

## Limits and rollback

Calibration is finite and does not establish broad semantic accuracy. Paid selected-model generation of rich offers was not exercised; deterministic extraction integration and actual Jev validation were. A remote response accepted just before process/storage failure cannot be guaranteed exactly-once billed before a durable receipt exists.

To stop testing, use `/progress off` or exit the candidate session. Use the owner's unchanged stable installation in a separate fresh session if desired; do not feed a v8 checkpoint to an older build or migrate storage by hand. No publish, tag, deployment, package update or push was performed. The owner decides acceptance and release.
