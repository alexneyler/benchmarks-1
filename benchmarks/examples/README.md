# benchSDK Examples

These examples are self-contained, runnable demonstrations of the benchSDK. They use a tiny `NoopParticipant` helper that simulates a sandbox provider, so no cloud credentials are required — but they still need a benchmarks platform endpoint to report results.

## Prerequisites

Build the local packages first (the CLI is not pre-built in the repo):

```sh
pnpm -r --filter "./packages/**" build
```

Set the platform endpoint and API key. For a local platform:

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

## Running an example

```sh
bench run benchmarks/examples/00-hello-world.bench.ts --iterations 3
```

Or with `tsx` directly:

```sh
pnpm tsx packages/benchsdk-runner/dist/bin.js run benchmarks/examples/00-hello-world.bench.ts --iterations 3
```

## What you should see

For each example the CLI prints the resolved knobs, a run URL, per-participant progress, and per-task success/failure lines:

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

## Files

- `participants.ts` — the mock provider factory used by every example.
- `*.bench.ts` — standalone benchmark modules, each exporting `config` and `task`.
