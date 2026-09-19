# Reviewed hybrid repair: manual QA

Runtime: `e4dcfe0861fe`, jj change `ztmyrzkzvqonqtlyopknyywxotrmwvoq`.
Cumulative independent review PASS; 378 unit, 12 local-host and 12 global-host integration tests pass. See [acceptance evidence](hybrid-acceptance.md) for revision-labeled paid probes and limitations. No claim that human QA has already passed.

## Load the frozen build

```sh
pi install git:github.com/vedang/pi-progress-bar@e4dcfe0861fe
```

Then restart Pi or run `/reload`. Do not also load a second local copy. Supply `TYPESAFE_API_KEY` through the environment; extraction uses the selected model's Pi authentication. Monitoring can incur provider charges. The publication process does not modify your installed copy automatically.

For an already configured local package, `/reload` loads that checkout's current source; pin the Git package above if the local checkout will keep changing.

## Exercise

1. In a fresh session, request three concrete tasks. Check task admission, counts, and honest uncertainty.
2. Switch explicitly between existing tasks. Check focus switches without adding tasks or claiming completion; concurrent/uncertain activity should not guess a task.
3. Complete a later task while the first remains open. Then retract completion and verify only the affected task reopens.
4. Ask an informational question. Check the delivered answer can complete it and implementation health can honestly say not needed.
5. During analysis, toggle OFF/ON and reload. Accepted phases should resume without rebilling; OFF must suppress new provider dispatch.
6. Switch session-tree branches during pending work. The selected branch's accepted journal must survive; old results must not overwrite it.
7. Confirm all-done retained card, catch-up qualification, usage timestamps, and canonical intercom delivery. Idle non-triggering intercom is assessed on the next real turn, not polled.

Record the pinned build, host version, reproduction, expected/actual behavior, and sanitized `/progress` state/usage. Avoid sharing credentials or private conversation content. Full UX redesign/debugger/advisory changes are not included.

## Roll back

```sh
pi install git:github.com/vedang/pi-progress-bar@0f3eecba3c92
```

Restart Pi and use a fresh session. This is the earlier published health build, not an equivalent repair. Checkpoint compatibility is not promised: strict v6 has no migration or downgrade shim. Keep the current session for diagnosis rather than editing its stored checkpoint.
