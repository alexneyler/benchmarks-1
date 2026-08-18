# benchSDK Examples

These examples are self-contained, runnable demonstrations of the benchSDK. They use a tiny `NoopParticipant` helper that simulates a sandbox provider, so no cloud credentials are required.

## Prerequisites

Build the local packages first (the CLI is not pre-built in the repo):

```sh
pnpm -r --filter "./packages/**" build
```

## Running an example

```sh
bench run benchmarks/examples/00-hello-world.bench.ts --iterations 3
```

Or with `tsx` directly:

```sh
pnpm tsx packages/benchsdk-runner/dist/bin.js run benchmarks/examples/00-hello-world.bench.ts --iterations 3
```

## Dry-run mode (no platform needed)

Every example can be run without a benchmarks platform endpoint or API key by adding `--no-ingest` (or setting `BENCHSDK_NO_INGEST=true`):

```sh
bench run benchmarks/examples/00-hello-world.bench.ts --iterations 3 --no-ingest
```

In dry-run mode the runner executes the tasks locally, prints per-task results, and skips platform upload. This is useful for local development and CI smoke tests.

To run against a real platform, set the endpoint and API key:

```sh
export BENCHMARKS_PLATFORM_URL=http://localhost:3000
export BENCHMARKS_PLATFORM_API_KEY=bp_...
```

See `.agents/skills/local-platform-e2e/SKILL.md` for a full local stack setup.

## Examples

| File | What it demonstrates |
|------|---------------------|
| `00-hello-world.bench.ts` | A single participant, one task with `step`, `measure`, and `log`. |
| `01-multiple-providers.bench.ts` | The same task run against multiple providers, with `--provider` filtering. |
| `02-phases.bench.ts` | Ordered `phases` with per-phase iteration counts and `ctx.phase`. |
| `03-round-robin.bench.ts` | `groupBy: 'round'` interleaving participant tasks. |
| `04-shapes.bench.ts` | `shapes` for named benchmark variants selected with `--shape`. |
| `05-step-options.bench.ts` | Per-step `concurrency` and `timeoutMs` for parallel step invocations. |
| `06-scoring.bench.ts` | `onScore` and the exported `score` helper for weighted composite scoring. |

## What you should see

For each example the CLI prints the resolved knobs, a run URL (unless `--no-ingest`), per-participant progress, and per-task success/failure lines:

```
Examples: Hello World (self-contained)
Date: 2026-08-12T17:30:00.000Z
Knobs: iterations=3, concurrency=1, staggerDelayMs=0, groupBy=participant

Run created: examples-hello-world-... (run-id)
View at: http://localhost:3000/org/.../benchmarks/examples-hello-world/runs/run-id

======================================================================
  Participant: noop
======================================================================
  [noop] Task 1/3: success {"ttiMs": 123, "exitCode": 0}
  [noop] Task 2/3: success {"ttiMs": 145, "exitCode": 0}
  [noop] Task 3/3: success {"ttiMs": 112, "exitCode": 0}
  Done: 3/3 succeeded.

All done. View at: http://localhost:3000/org/.../benchmarks/examples-hello-world/runs/run-id
```

With `--no-ingest` the output is the same except the run URL lines are replaced by `Dry run: no platform ingest or reporting.` and `All done. No platform run created.`.

## Files

- `participants.ts` — the mock provider factory used by every example.
- `*.bench.ts` — standalone benchmark modules, each exporting `config` and `task`.
