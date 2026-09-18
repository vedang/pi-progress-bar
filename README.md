# pi-progress-bar

Local, read-only reported checklist progress for Pi. Tested with
`@earendil-works/pi-coding-agent` 0.84.2; Node.js >=22.19.0.
Load with `pi -e ./src/index.ts` or install this directory as a Pi package.

## Commands

- `/progress`: native source/details/interval picker.
- `/progress source plan.md#Tasks`: draft a source, choose included task numbers
  (blank includes all), select current task (default Unknown), then explicitly Apply.
  Escape or declining confirmation leaves active selection unchanged.
- `/progress details`: read-only source, scope, task states and current-task inspector.
- `/progress interval 5`: replace refresh timer. Default 15 seconds; supported range
  0.001–2147483.647 seconds.

Use unindented `- [ ]`, `- [x]` or `- [X]` checklist items under an ATX heading.
Indented criteria do not increase the denominator; fenced examples are ignored.
Without `#Section`, a document must contain one unambiguous direct task list.
Mixed syntax, ambiguous duplicates and scopes over 200 tasks are rejected.
Optional `<!-- progress:id=token -->` anchors preserve identity across renames;
otherwise only unique exact task text preserves identity. The monitor never edits files.

Reads accept workspace-relative regular `.md` files up to 256 KiB. Symlinks,
hidden/private paths and paths outside the workspace are rejected. Failed reads keep
last complete counts explicitly stale. Source additions are excluded after explicit
scope selection until selected again.

TUI shows a theme-aware, width-safe named widget. RPC uses native dialogs but no
terminal widget. Reload and tree navigation re-read current-branch source references;
checkpoints contain IDs/hash mappings, scope and interval metadata, not task bodies.
Missing current-branch checkpoints clear the selection. Current task is never inferred.

Counts describe file-reported completion, **not verified correctness**. No network,
agent messages, project commands, tools, scripts or remote judgments are used.

## Development

Bun 1.3.14; dependencies must already be installed for these gates:

```sh
make format
make check
make test
```

Checks use Biome, TypeScript and Knip. Default tests exclude live tests. Package
runtime consists of `src`; no global Pi configuration changes are required.
