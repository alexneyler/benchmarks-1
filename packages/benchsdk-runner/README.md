# @benchsdk/runner

Benchmark runner framework for building self-contained benchmark scripts that report to the benchmarks platform via [`@benchsdk/client`](../benchsdk).

## What it provides

- **`LogBuffer`** — Accumulates one text log per worker across a sandbox lifecycle's steps (create → exec → destroy) and uploads it once via `runWorker`'s `onFinish` hook as a `coordinator.log` artifact.
- **`uploadWorkerLog`** — Uploads a `LogBuffer` as a `coordinator.log` artifact; never throws.
- **`loggedStep`** — Runs a function through both the platform step reporter and the local log buffer, so failures show up in both places without duplicating try/catch at every call site.
- **`defineBenchmarkConfig`** / **`defineTask`** / **`defineStep`** / **`runBenchmark`** — A `*.bench.ts` file composes a **config** (`defineBenchmarkConfig`, the orchestration knobs) and a **task** (`defineTask`, the workload), which `runBenchmark` turns into platform runs. There is no "mode": the orchestration shape (sequential / staggered / burst) emerges from the `iterations`, `concurrency`, and `staggerDelayMs` knobs, and `groupBy` (`'participant'` | `'round'`) selects the ordering across participants.

## Install

```sh
pnpm add @benchsdk/runner @benchsdk/client
```

## Usage

A benchmark file exports a `config` and a `task`, and hands both to `runBenchmark`:

```ts
import { defineBenchmarkConfig, defineTask, runBenchmark } from '@benchsdk/runner';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-tti-local',
  benchmarkName: 'Sandbox TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 100,   // total tasks per participant
  concurrency: 1,    // 1 = sequential, N = burst
});

// Primary form: named steps via `ctx.step`, so values flow between steps with
// closures and cleanup runs in a `finally`.
export const task = defineTask(async ({ participant, step }) => {
  const sandbox = await step('create', () => participant.createCompute().sandbox.create());
  try {
    await step('exec.task', () => sandbox.runCommand('node -v'));
  } finally {
    await step('destroy', () => sandbox.destroy());
  }
  return { data: { ttiMs } };
});

// CLI flags (--iterations, --concurrency, --stagger-delay-ms, --group-by,
// --provider a,b) override the config defaults.
runBenchmark(config, task, participants, process.argv.slice(2));
```

For simple benchmarks whose steps are independent, `defineTask` also accepts a
`defineStep[]` array (values shared through `ctx.state`):

```ts
import { defineStep, defineTask } from '@benchsdk/runner';

export const task = defineTask([
  defineStep('upload', ({ state }) => { state.key = uploadFile(); }),
  defineStep('download', ({ state }) => downloadFile(String(state.key))),
]);
```

`LogBuffer` / `loggedStep` / `uploadWorkerLog` accumulate one text log per worker and
upload it once as a `coordinator.log` artifact:

```ts
import { LogBuffer, loggedStep, uploadWorkerLog } from '@benchsdk/runner';

const logBuffer = new LogBuffer();
await loggedStep(ctx, logBuffer, 'create sandbox', async () => sandbox.create());
await uploadWorkerLog(ctx, logBuffer, 'my-provider');
```

## License

MIT
