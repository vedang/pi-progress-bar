# Paid hybrid production-path QA

Offline `make test` excludes this directory. Each invocation is one explicitly authorized, frozen, serial run; no test retries or automatic reruns.

```sh
# Create a fresh ignored task artifact directory before running.
PROGRESS_LIVE=1 \
PROGRESS_LIVE_GROUP=ci \
PROGRESS_LIVE_REVISION=<frozen-commit> \
PROGRESS_LIVE_ARTIFACT_DIR=<existing-task-directory> \
PI_PROVIDER=<configured-provider> PI_MODEL=<configured-model> \
make test-live
```

Supply `TYPESAFE_API_KEY` through the environment and configure selected-provider credentials in Pi. Do not put credentials in tracked files or command arguments. Repeat explicitly with `PROGRESS_LIVE_GROUP=remaining` for the other group; each run has its own immutable artifact and budget.

| Group | Jev attempts | Selected-model invocations | Coverage |
|---|---:|---:|---|
| `ci` | 32 | 8 | Exact six-message CI trace; three distinct requested deliverables, stable IDs, no early fix completion, final >=2/3 |
| `remaining` | 64 | 16 | Reading-only request, question/answer, parallel2/3 with first unfinished, targeted withdrawal, settled OFF/ON/reload without rebilling |

Failures and aborted calls count. Model retries are zero. Caps bound attempts, not exact charges; usage includes input/output/cache tokens and reported model cost. Any exhausted cap, transport failure or semantic assertion failure terminates the group. A later corrected rerun needs its reason, frozen revision and new cap recorded, retaining earlier failures.

The suite uses real `Monitor`, request builders, gateway, patch parser and `selectedModelExtractor`, backed by the actual host ModelRuntime/ModelRegistry and host authentication. Wrappers only log/enforce budgets; they do not replace answers. Jev remains pinned to `jev-1.13.0`; thresholds are unchanged. Harness canonical-like message entries do not independently prove host event ordering—that is covered by offline actual-host integration tests.

Artifacts are exclusive-created `hybrid-<group>-<time>-<uuid>.jsonl`: revision/source/fixture/test hashes, provider/model, caps, bounded request inputs, answer scalars, model text, latency, usage, checkpoints, per-observation state and final outcome. They contain fixture excerpts and must remain local ignored QA artifacts. No headers, credentials or raw provider exceptions are logged. Runtime checkpoint privacy is stricter than these explicit opt-in test artifacts.

CI fixture `../fixtures/hybrid-ci.json` preserves six visible messages from the previously authorized CI investigation, frozen from TASK113835. Remaining reading fixture is the bounded sanitized prior reading-request regression; other conversations are synthetic. Separate orgtok regression uses **only the first two user turns and corresponding responses**, never later work.

See [acceptance evidence](../../docs/design/hybrid-acceptance.md) for actual outcomes, failures and limits. This suite is finite release evidence, not universal semantic accuracy or a benchmark tuned to relaxed thresholds. Old trajectory/span-only live suites are retired, not silently counted as passing.
