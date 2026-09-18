# Evaluation and review gates

Status: proposed checks for implementation, not results from a built monitor. A four-call authorized exercise on selected real-session excerpts is reported in [spikes.md](spikes.md). It establishes narrow observations, not general model accuracy or calibrated thresholds; no monitor tests have been implemented or run.

## Separate three kinds of correctness

1. **Observer correctness:** source identity, counting, event order, lifecycle, stale-result rejection, no workflow mutation, and outbound-data limits. Deterministic tests can establish these behaviors.
2. **Interpretation quality:** plan selection, task/report mapping, criteria interpretation, failure relevance, applicability, progress, and drift. Requires representative labeled examples and live Jev evaluation with consent.
3. **User usefulness:** can the human identify active scope, recognize uncertainty, understand what needs attention, and inspect evidence without reading all logs? Requires hands-on Pi sessions.

Typed output validates the interface only. Vendor latency and confidence calibration claims are not results for this extension.

## Contract checks included with relevant slices

| Concern | Proposed acceptance check |
| --- | --- |
| Reported-only percentage | A high implementation judgment never changes task status. `[x]`/explicit accepted reports do. No denominator means no percentage; zero tasks never means 100%. |
| Scope | Two done children under an epic count as two tasks, not three including epic. Unselected backlog items have no effect. Removing/canceling scope is not completion. |
| Prose reports | `I will finish step 2` stays open; `finished steps 2 and 3` maps both; quoted examples and tool-injected claims do not count as agent status assertions. |
| Unknown identity | Ambiguous task/report mapping leaves unknown or conflicting state; no silent reassignment by recency alone. |
| History | Abandoned Pi branches do not contribute completion; fork/tree/reload restore only applicable source state. A compaction summary is not fabricated firsthand test evidence. |
| Active task | Task switch invalidates old task judgments and temporal window. Unknown active task does not inherit last task's healthy meters. |
| API ownership | One request in flight; obsolete identity responses discarded; same-task aged data explicitly marked as-of/stale. No replay backlog from configured refresh ticks (default 15s). |
| Missing service | Structured reported counts remain available without Jev; semantic/prose interpretations show unavailable or clearly aged, not silently refreshed. |
| Consent and privacy | No remote calls before explicit enablement; no source bodies/credentials in debug logs or persisted metadata; private `!!` output excluded. |
| Evidence boundaries | Path resolution, source-read and payload budgets enforced before network; symlinks cannot bypass allowed workspace boundary. Omitted evidence is declared. |
| Testing evidence | An explicit scoped agent report is sufficient for Reported red under user policy; matching run evidence can establish Observed red. Never relabel report as observed. Runner crash is not red test. Preserve contradictory evidence. Old pass becomes stale after relevant change. Monitor never runs tests. |
| Test value | `Not needed` never implies skipping existing checks. Unknown policy/coverage stays uncertain; explicit test-first policy is not waived by model output. |
| Temporal judgments | Long running test/wait for human is not automatically stuck; repeated errors alone do not prove a loop if attempts narrow the cause. |
| UI | All rows fit narrow terminals; no color-only distinctions; input retains focus; other extension widgets/statuses remain intact. |
| Passive behavior | No messages to agent, injected instructions, tool mutation, issue writes, test execution, hidden installs, or external-worker discovery. |

Use fake clocks, normalized replay events and stubbed Jev answers to test these contracts without billable requests. Tests should target decisions and boundaries, not implementation details or arbitrary snapshots of wording. Main agent authors behavior tests before implementation; avoid ceremonial tests for documentation-only changes.

## Small labeled Jev exercise set

Labels below are expected interpretation targets for constructing full examples, not claims that Jev already predicts them. Include complete task/criteria context, relevant evidence and omissions. Freeze prompt/model version before comparison.

| Example | Desired discrimination |
| --- | --- |
| Concrete cancellation requirement with success/error boundaries | Clear requirements and observable acceptance conditions. |
| `Make cancellation better` with no behavior or context | Unclear requirements, insufficient acceptance definition. |
| Two mutually inconsistent timeout requirements | Contradiction not hidden behind high clarity. |
| Old proposed plan plus new explicit selected plan | Select active source or abstain; never mix denominators. |
| Completion assertion, future intention, and quoted completion example | Only actual scoped assertion changes conversation-reported status. |
| Documentation wording change with explicit no-new-test policy | `Not needed` for new red test, existing checks remain applicable. |
| One-line authorization regression | New relevant failing test needed despite small diff. |
| Mechanical refactor with known adequate existing coverage | Distinguish existing validation from need for another new test; uncertainty if coverage absent. |
| New test file without execution record or explicit red assertion | Written, red unreported. |
| Agent explicitly reports writing a failing regression test, no run trace | Reported red is sufficient, with claim provenance; not independently observed. |
| Dependency-install/runner crash before tests execute | No relevant red observed; infrastructure issue separate. |
| Target assertion failing before task implementation edit | Relevant red observed only if identity/order supported. |
| High-confidence agent says done, criterion evidence missing | Reported done may rise; implementation remains unverified. |
| Useful investigation narrows failure to one subsystem, no edits | May constitute meaningful progress. |
| Same unsuccessful attempt repeated without changing evidence | Possible loop, rather than confident proof of stuck. |
| Long-running test or user confirmation wait | Runtime waiting state, not stuck solely due to elapsed time. |
| Shared helper change necessary for active task | Supporting work, not drift merely because filename differs. |
| Unrelated feature work after no approved scope change | Possible drift. |
| Legitimate user changes goal | Reset scope/trajectory; don't accuse new task of drifting from old goal. |

Cover happy paths, insufficient evidence, contradictions, hostile embedded text, temporal ordering, and task switches. Preserve source provenance in fixtures. Use approved bounded actual-trajectory excerpts; the user authorized a billable spike on this conversation. No automatic upload of full transcripts or unrelated sessions. Synthetic contrast cases remain optional and must not be presented as actual trajectory.

## Calibration and release decisions

- Record chosen answer, full distribution, question/model version, source/evidence revision, observed latency, input-token usage and human label. Raw source bodies stay opt-in; prefer references locally.
- Report abstention/unknown rates alongside errors. A monitor that looks accurate by declaring nearly everything unknown may still be useless.
- Treat false `Not needed`, false `Appears complete`, false stuck/drift, and false completion-report mappings separately. Costs differ; don't collapse to one average accuracy number.
- Choose thresholds on a tuning set, then evaluate held-out examples and fresh sessions. Pin model when tuning; rerun comparisons before changing it.
- Do not prescribe universal `0.8`/`0.9` gates or fabricate success targets before baseline results and user risk preferences. First prototype labels judgments experimental and exposes raw distributions; missing-evidence gates remain deterministic.
- Temporal windows and persistence rules are tunable hypotheses. Configured refresh cadence (default 15s) is not evidence of a meaningful stagnation interval.
- The first opted-in live exercise measures actual request usage/latency and checks how Jev interprets examples. Passing deterministic tests is not a claim of semantic accuracy.
- Product release needs both contract checks and an explicitly reviewed interpretation baseline. Future agent nudges need a separate, stricter decision and remain out of product v1.

## Evidence the user should see before implementation approval

- Full shape and boundaries.
- Breadboard with all UI/code/store wiring and proposed commands.
- Vertical slices, each with visible demo, dependencies and acceptance checks.
- Open assumptions and bounded spikes, rather than guessed APIs or calibrated thresholds.
- Explicit statement that implementation has not started.
