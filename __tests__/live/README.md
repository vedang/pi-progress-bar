# Paid production-path Jev integration

Offline `make test` never runs this directory. Explicit authorized run:

```sh
PROGRESS_LIVE=1 make test-live
```

Requires an existing `TYPESAFE_API_KEY`; do not put it in tracked files or shell command arguments. The suite uses the production Monitor, trajectory parser, request builders, scheduler, gateway, result validation and ledger. Only the HTTP boundary is wrapped for budget enforcement and logging; answers come from pinned `jev-1.13.0`, not mocks or replacement questions.

One run permits **64 HTTP attempts total**, including failed/aborted requests, at most **24 KiB per request**, no test retries. Set `PROGRESS_LIVE_MAX_ATTEMPTS` to an integer from 1 through 64 to lower a run's cap. Automatic provider retries are not introduced. A cap/timeout/semantic mismatch fails visibly. This bounds attempts and request bytes, not exact provider token charges. Usage and failed attempts are recorded separately. No automatic rerun is authorized by invoking this target once.

Artifacts: ignored task directory `.agents/plans/20260918T230453--retain-tasks-show-freshness__active/live-*.jsonl`. Earlier qmi validation remains in its repair task directory; the expanded jks suite has a larger finite cap under the user's broader paid authorization. Records contain synthetic fixture input/questions, raw answers, model, request bytes, HTTP status, metered token usage and ledger checkpoints. No credentials/headers or actual session transcripts are logged.

The fixture is a sanitized reconstruction of a reported failure, not a verbatim full-session export. It includes an old goal, explanatory Insight, later two-task request, current-work statement and completion. The request and final summary are verbatim visible messages; connector observations are synthetic and identified in the fixture. Assertions cover changed active scope, grounded current work, correct 2/2 reports and no further paid requests for unchanged history. Four additional production-report tests reject completion from intentions, quoted examples and test activity, and accept an independent delivery paraphrase. Additional cases recognize conversational questions/explanations/code directives, ensure approval does not duplicate scope, preserve unfinished implementation during a status question, and require a fresh response when that question is repeated after completion. Actual widget assertions verify named task retention and call freshness. Deterministic tests cover adversarial lifecycle/race cases separately. A passing probabilistic sample is evidence, not a guarantee of universal semantic accuracy.
