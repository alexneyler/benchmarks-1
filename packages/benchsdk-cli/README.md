# @benchsdk/cli

Benchmark runner framework for building self-contained benchmark scripts that report to the benchmarks platform via [`@benchsdk/client`](../benchsdk).

## What it provides

- **`LogBuffer`** — Accumulates one text log per worker across a sandbox lifecycle's steps (create → exec → destroy) and uploads it once via `runWorker`'s `onFinish` hook as a `coordinator.log` artifact.
- **`uploadWorkerLog`** — Uploads a `LogBuffer` as a `coordinator.log` artifact; never throws.
- **`loggedStep`** — Runs a function through both the platform step reporter and the local log buffer, so failures show up in both places without duplicating try/catch at every call site.
- **`defineBenchmark`** — Declarative config for `npm run bench <config-file>.ts`, an alternative to CLI-flag invocation. Covers the core sandbox modes: `sequential`, `staggered`, `burst`/`concurrent`, and `sandbox-dax`.

## Install

```sh
pnpm add @benchsdk/cli @benchsdk/client
```

## Usage

```ts
import { LogBuffer, loggedStep, uploadWorkerLog, defineBenchmark } from '@benchsdk/cli';

const config = defineBenchmark({
  mode: 'sequential',
  iterations: 100,
});

// Inside a worker:
const logBuffer = new LogBuffer();
await loggedStep(ctx, logBuffer, 'create sandbox', async () => sandbox.create());
await uploadWorkerLog(ctx, logBuffer, 'my-provider');
```

## License

MIT
