# pi-progress-bar

Scaffold only (0.1.0). The TypeScript Pi extension factory is intentionally inert:
no progress UI, commands, event handlers, timers, network calls, or V1 behavior.

## Development

Requires Bun 1.3.14 and Node.js >=22.19.0.

```sh
bun install --ignore-scripts
make format
make check
make test
```

Checks use Biome, TypeScript, and Knip. Tests run unit then integration suites;
there are currently no integration tests, and an empty integration suite is allowed.
Both default suites exclude live tests; no live target exists.

Pi loads `./src/index.ts` directly via the package manifest. Only `src` is selected
as runtime source for packaging. No global installation or configuration is needed
for these development gates.
