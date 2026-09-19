# Future plan: advisory nudges

**Status:** Planning only. Future direction is requested; this document does not enable nudges or authorize implementation. Last updated: 2026-09-19. Current hybrid build `4a6b79da` remains passive and is under manual QA/independent re-review.

## Confirmed direction

- Advice is advisory, never tool blocking or automatic changes to code, tests, reviews or task statuses.
- Explore proactive advice; do not require the agent to announce its intent first.
- After safety gates, advisory mode should default ON for new sessions. This supersedes the earlier default-OFF proposal; a clear OFF control is still required.
- Analyze relevant tool activity independently of progress analysis, with approximately 15 seconds as the proposed working cadence. This does not restore polling to passive progress.
- Existing advice topics: avoid unnecessary *new* red tests and defer premature repeated reviews until meaningful work is ready. Explicit user/repository requirements always take precedence.

## New requirement: follow up unfinished work after the run ends

User requirement: **when the agent run ends but the tracker still has pending tasks, wait roughly one minute, then nudge the main agent to talk about those tasks.** The aim is to reconcile the progress board with reality—not coerce a 100% display.

Proposed flow:

1. Observe a supported, authoritative main-agent run-end event. Verify actual Pi event semantics; `agent_run` here describes user intent, not a promised API event name.
2. If included unfinished tasks remain, arm one cancellable delay, initially 60 seconds. No periodic polling or backlog of timer ticks.
3. When the delay expires, recheck the same session/branch/tracking cycle, agent idleness, advisory controls, pending task IDs/revisions and analysis state.
4. If work remains and the evidence is settled, deliver one clearly extension-origin advisory asking the agent to explain each remaining item's status.
5. Let the normal semantic pipeline assess the actual reply. The nudge itself never marks a task complete, archived or cancelled.

Illustrative wording, not a frozen prompt:

> The tracker still lists these tasks as unfinished: […]. Please explain which are complete, still pending, blocked, or no longer required, and clarify any tracking mismatch. Do not claim completion merely to clear the progress bar.

Blocked/waiting work is a valid answer and may remain pending. Do not turn a request for clarification into permission for additional implementation work.

### Proposed safety rules

[tag:future_pending_nudge_freshness] Cancel or invalidate the delay on new user input, resumed agent work, session/branch changes, shutdown or advisory/master OFF. Recheck at delivery; do not send a stale nudge just because a timer fired.

- If all tasks become complete during the grace period, send nothing.
- If progress is still catching up or a relevant phase is unsettled/failed, do not present the unfinished list as authoritative. Re-evaluate on a real settlement event, not an idle inference loop.
- Treat deliberate user interruption/abort separately from ordinary run completion; proposed safe default is no automatic restart after an explicit stop.
- Deduplicate by run/cycle and pending task revisions. The agent's reply to this nudge must not recursively schedule another identical nudge.
- Bound follow-up frequency, attempts and provider spending. The exact cooldown and delay controls remain design decisions; 60 seconds is the user's initial suggestion, not a calibrated value.
- Exclude extension-authored nudges/receipts and simple echoes from new task admission or independent completion evidence. Genuine agent status explanations may still establish completion or withdrawal through the ordinary judgments.

### Delivery design must change from the old plan

The earlier proposal admitted advice only at the next natural model-context boundary and explicitly prohibited waking an idle agent. That cannot satisfy this new run-ended requirement on its own.

A supported, bounded **idle-agent follow-up mechanism** must now be investigated and approved. Prove main-session targeting, explicit extension provenance, cancellation/freshness, user interruption priority and loop suppression. Do not silently impersonate a user message or assume a queued message can be retracted. This is a narrow new requested advisory path, not permission for unlimited autonomous turns.

## Existing red-test and review advice

Keep these separate from the simpler end-of-run reconciliation trigger:

- **Red-test advice:** a judgment that another failing regression would add little value must never waive required tests, existing validation, security checks or repository policy.
- **Review advice:** defer only against a grounded batch/checkpoint. An explicit review request, security risk or genuine blocker overrides deferral. Never infer readiness from issue counts or elapsed time alone.
- Proactive opportunity detection needs bounded actual context and evaluated recall/false-positive behavior; explicit-intent-only detection is not the chosen product direction.
- Tools, health and Beads do not become completion authority. Do not assume the displayed task owns all tool activity.

## Shared design constraints

Maintain clear separation between observation, model assessment, policy, delivery and measured effect. Share provider-wide auth/backoff rules without allowing advisory work to starve progress or bypass quotas. Exact concurrency, inference budgets, delivery controls and persistence still need a current design; numbers from the old planning packet are not approved runtime requirements.

Persist only bounded derived receipts needed for safe deduplication, never raw private tool output or credentials. Distinguish proposed, suppressed, delivered and acknowledged advice; delivery does not prove that the agent read or followed it. Unknown authority/context means abstain, not guess.

## Delivery and acceptance

1. Rebase on the accepted hybrid and manual-QA findings; specify run-end/idle/cancellation events and policy authority.
2. Prove idle follow-up delivery on actual supported Pi hosts, including a user message arriving immediately before delivery.
3. Implement the smallest end-of-run reconciliation slice before broader proactive advice, with explicit controls and one-shot cancellation.
4. Test all-complete/no-task suppression; late completion; still-running analysis; OFF/abort/reload/branch changes; blocked tasks; duplicate end events; self-triggered follow-up loops; and unchanged task state until real evidence arrives.
5. Evaluate red-test/review advice separately with policy/delivery/adapter proofs, bounded paid cases where needed, and preserved failures.
6. Independent review and manual opt-in smoke precede enabling default-ON behavior.

The [UI plan](ui-changes.md) owns completed-run→new-turn board reset and opening the actual board. The [debugger](debugger.md) explains processing; it must not itself trigger advice.

## Prior planning disposition

Consolidates the 2026-09-18 independent-advisory packet plus subsequent user decisions. Obsolete: old span-only runtime baseline, default OFF as product goal, explicit-intent-only opportunities and natural-turn-only delivery for every nudge. Still valuable: policy precedence, bounded evidence, stale-result suppression, privacy, separation from task truth and actual-host delivery proofs.
