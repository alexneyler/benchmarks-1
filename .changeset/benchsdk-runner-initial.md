---
"@benchsdk/runner": patch
---

Initial publication of `@benchsdk/runner`, the benchmark framework (renamed from `@benchsdk/cli`). A `*.bench.ts` file composes a **config** and a **task**: `defineBenchmarkConfig({ benchmarkSlug, iterations, concurrency, ... })` holds the orchestration knobs, and `defineTask(fn)` holds the workload (with named steps via `ctx.step`, closures and `try/finally`). `defineTask` also accepts an optional `defineStep[]` array for simple independent steps. `runBenchmark(config, task, participants, argv)` applies CLI overrides (`--iterations`, `--concurrency`, `--stagger-delay-ms`, `--group-by`, `--provider`) and drives the run against `@benchsdk/client`. Also exports `LogBuffer`, `loggedStep`, `uploadWorkerLog`, `TaskError`, and `NoAvailableParticipantsError`.
