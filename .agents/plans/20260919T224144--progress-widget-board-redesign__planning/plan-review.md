`★ Insight ─────────────────────────────────────`
- Biggest risks sit at ownership boundaries: host input pipeline, overlay teardown, durable replay.
- Optional inference must fail independently. Otherwise “optional” detail/health work can stall core task tracking.
`─────────────────────────────────────────────────`

## Review

### Correct

- Exact widget copy and token direction preserved in Task 7 (`plan.md:83-89`): two normal rows, requested usage line, input `↓`, output `↑`.
- Newest-first ordering has durable admission ordinals rather than timestamps/render order (`plan.md:26-32`).
- Board remains read-only; `d` acts only in right pane; Summary stays visible (`plan.md:107-115`).
- Display focus remains separate from semantic focus, completion, health, evidence, and tool ownership (`plan.md:71-77`).
- UI actions explicitly cause no inference, persistence, or history reads, with differential coverage planned (`plan.md:90-91`, `101-102`, `120-124`).
- Working-layer order correctly keeps basic widget/board independent from optional rich details.

### Findings

- **Finding: P1 — optional detail enrichment can block mandatory task lifecycle.**  
  **Location:** `plan.md:37-53`.  
  **Evidence:** Task 3 makes `details` a required exact-key member and rejects malformed candidates. Task 4 inserts durable phase `details` immediately after extraction. Current mandatory flow is extraction → persisted patch → completion → cursor commit (`src/core/hybrid.ts:842-903`). Therefore malformed optional detail data or failed detail validation can leave structural task work pending and stop later observations. Near-capacity optional data can also trigger global `capacity: "limit"`, blocking mandatory semantic work.  
  **Correction:** Parse structural operations independently; invalid/absent detail sections become zero candidates, never `invalid-patch`. Finish completion and cursor commit before optional validation. Store detail jobs in a separate replay-safe queue keyed by task ID, revision, and source identity. Accepted batches remain journaled for no-rebilling, but provider failure or optional-capacity denial only parks/drops enrichment. It must not set semantic pending block or global capacity limit.

- **Finding: P1 — `ctx.ui.custom()` cannot provide safe owned teardown under overlay races.**  
  **Location:** `plan.md:99`, `107`, risk at `199`.  
  **Evidence:** Pi’s custom-overlay `done` callback closes through generic `this.ui.hideOverlay()` (`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:2137-2149`). If another overlay is above board during OFF/reload/session teardown, calling `done` can remove wrong overlay. Calling owned `OverlayHandle.hide()` first and then `done` causes `done` to remove next overlay. Not calling `done` strands custom promise. Exact ownership API already exists as `OverlayHandle.hide()` (`node_modules/@earendil-works/pi-tui/dist/tui.d.ts:112-124`).  
  **Correction:** Do not build board through `ctx.ui.custom({overlay:true})`. Use captured TUI’s `showOverlay()` directly, own returned handle, close with `handle.hide()`, and dispose component idempotently. Focused Esc/q may check `handle.isFocused()`; lifecycle teardown may always hide exact owned handle. If direct ownership is disallowed, Task 1 must stop feature rather than proceed with custom overlay.

- **Finding: P1 — bare Right contract is impossible against earlier input transformations as written.**  
  **Location:** `plan.md:18-21`, `97`, `102`.  
  **Evidence:** TUI passes each listener already-transformed `current` data (`node_modules/@earendil-works/pi-tui/dist/tui.js:553-574`). If earlier listener changes another key into Right, this extension cannot distinguish it from physical Right and may consume it. Returning `undefined` preserves current pipeline value, not “exact input” claimed by Task 1 acceptance. Listener priority/original input is unavailable.  
  **Correction:** Define Right as pipeline-visible Right and explicitly document inter-extension transformation limitation, or require new host API carrying original input/priority before enabling bare Right. Test both listener orders and assert pass-through of received data, not unreachable original data. Do not claim collision-free physical-key ownership.

- **Finding: P1 — unsupported checkpoint policy lacks required monitor seam and currently rebills history.**  
  **Location:** `plan.md:24-32`; Task 2 file list.  
  **Evidence:** Current decoder returns only `HybridState | undefined`, collapsing unsupported version, malformed checkpoint, and absent data (`src/core/hybrid-checkpoint.ts:1207-1228`). `Monitor.restore()` responds by resetting state, enabling gateway, saving, and requeueing canonical history (`src/core/monitor.ts:398-423`, `280-303`). That contradicts “no silent history reset/rebilling.” Task 2 does not list `src/core/monitor.ts`, `src/index.ts`, or command/status handling needed to fix this.  
  **Correction:** Add those files to Task 2. Return discriminated restore result: `absent | restored | unsupported-version | corrupt`. Unsupported version must latch monitor OFF/blocked, preserve checkpoint entry, perform zero save/provider dispatch, and expose clear status telling user to use fresh session. Add host-level restore tests checking zero persistence and zero provider calls. Keep strict no-migration policy.

- **Finding: P1 — activity-focus plan duplicates accepted assistant focus and calls non-final message data “final.”**  
  **Location:** `plan.md:72-76`, dependency statement that Task 6 must build on root focus.  
  **Evidence:** Root owner reports accepted message-driven semantic focus already exists. Task 6 adds another provider call from assistant `message_end`. Pi chains message-end transforms through later extensions, so this extension may not see final message (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:610-633`). This creates duplicate cost and stale display judgments.  
  **Correction:** Reuse semantic focus for assistant evidence. New activity-focus inference should trigger only from tool starts. If separate assistant activity later proves necessary, enqueue it from canonical `context`/`turn_end` evidence after transformation, not raw `message_end`.

- **Finding: P1 — tool coalescing has no deterministic batch/freshness algorithm and can lose concurrent evidence.**  
  **Location:** `plan.md:72-76`.  
  **Evidence:** “Coalesce parallel starts into one latest work item” does not define collection boundary. Replacing with only latest start loses earlier tool evidence, making planned `concurrent` result impossible. Immediate drain may dispatch first start before sibling starts arrive, contradicting “exact provider-call coalescing.”  
  **Correction:** Define explicit batch boundary, such as assistant tool-call ID set or bounded scheduling turn. Accumulate all starts in batch before dispatch; preserve each allowlisted tool fact within 4 KiB. Use monotonic activity generation plus session/source/model/semantic generations. Queued newer batch replaces older queued batch; in-flight response commits only when every generation still matches. Specify exact expected call counts for one batch, sequential batches, semantic preemption, and late responses.

- **Finding: P1 — new paid health/activity paths lack concrete whole-checkpoint admission rules.**  
  **Location:** `plan.md:59-76`; capacity requirement appears only generically at `202`.  
  **Evidence:** Existing health admission models replacement of one card (`src/core/monitor.ts:1268-1302`), not adding to a 200-card map. Generic `evaluateJev()` performs no admission itself (`src/core/monitor.ts:1389-1405`). Task 6 persists usage/dispatch metadata but does not require activity admission before dispatch.  
  **Correction:** Task 5 must preflight existing full health map plus maximum new/replacement card before first health request. Task 6 must preflight saturated usage/timestamp metadata before activity dispatch. Optional health/activity denial should skip inference and project `Unassessed`/status warning, not set semantic global capacity limit. Add byte-edge tests proving zero fetch and unchanged task lifecycle.

- **Finding: P1 — task ID/revision/label is insufficient health provenance.**  
  **Location:** `plan.md:59-65`.  
  **Evidence:** Cosmetic revise can preserve revision while replacing task source (`src/core/hybrid.ts:300-313`); same-label revise therefore lets old health pass proposed ID/revision/label validation. Existing exact runtime check also relies on ephemeral `cardHealthIdentity` (`src/core/monitor.ts:1498-1506`), while persisted card validation currently checks only task ID existence (`src/core/hybrid-checkpoint.ts:716-731`).  
  **Correction:** Persist health provenance including task-source identity, triggering observation reference, health snapshot/request identity, and evidence/code revision identities needed for exactness. Include references in canonical amendment validation. Projection must expose only safe role, assessment time, and retained/stale state. Any provenance mismatch projects all five fields as `Unassessed`. Add same-label cosmetic-revise and source-amendment tests.

- **Finding: P1 — status and retained-health freshness can disappear from normal UI.**  
  **Location:** `plan.md:62-64`, `83-90`, `111-112`.  
  **Evidence:** Ready fixture is exact, but no rendering contract exists for capacity exhaustion, unsupported checkpoint, provider waiting, stale/retained assessment, or replacement pending. Board exposes global service/diagnostics only inside debugger, so normal board can look healthy while monitor is blocked. Current presentation distinguishes `previous`, service status, and retained/replacement state; redesign risks dropping that information.  
  **Correction:** Define allowlisted status union and precedence. Ready/current fixture stays byte-exact. Non-ready first row must show concise warning while retaining two-row limit, dropping bar before warning. Board must always show service/blocking status outside Debugger. Health Summary should show safe `assessedAt` plus retained/stale/replacement state. Add snapshots for unsupported, capacity, unresolved scope, provider wait, catch-up, and retained replacement.

- **Finding: P1 — plan still creates unrequested dual-host compatibility policy.**  
  **Location:** `plan.md:8`, `15`, `20-21`, `135`, README compatibility entry.  
  **Evidence:** Goal promises Pi `0.84.2` and `0.85.1`; Task 1 blocks slice if either host fails; Task 11 requires QA on both. This is a compatibility policy despite baseline caveat and explicit no-compatibility-policy constraint.  
  **Correction:** Pin accepted root revision and support that host contract only. Keep older/newer Pi source as reference evidence, not release gate. Remove `PI_COMPAT_HOST`, dual-host acceptance, and README compatibility promise unless owner separately authorizes support matrix.

### Verification

Review-only as requested. No edits, tests, host runs, or paid calls performed.

### Merge verdict

**BLOCK.** Fix ownership, optional-lifecycle isolation, unsupported-state behavior, activity batching, exact health provenance, and capacity/status contracts before implementation.

`★ Insight ─────────────────────────────────────`
- Exact UI copy is strong; hidden lifecycle semantics remain weak point.
- Best repair: make semantic tracking durable authority, then attach board, tool focus, health, and details as independently failing projections/enrichments.
`─────────────────────────────────────────────────`