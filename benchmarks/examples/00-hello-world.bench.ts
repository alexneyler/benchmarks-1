/**
 * Hello-world benchmark.
 *
 * This is the smallest possible benchSDK benchmark. It demonstrates:
 *   - exporting a `config` created with `defineBenchmarkConfig`
 *   - exporting a `task` created with `defineTask`
 *   - a single participant
 *   - three named steps (create, exec, destroy)
 *   - attaching metrics with `measure()`
 *   - writing to the worker log artifact with `log()`
 *
 * Run with:
 *   bench run benchmarks/examples/00-hello-world.bench.ts --iterations 3
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { createNoopParticipant } from './participants.js';

/**
 * The benchmark config declares the platform identity and orchestration knobs.
 *
 * - `benchmarkSlug` is the URL-safe identifier used for the platform API and
 *   dashboard (`.../benchmarks/examples-hello-world/runs/...`).
 * - `benchmarkName` is the human-readable name shown in the dashboard.
 * - `iterations` is the total number of times the task runs per participant.
 * - `concurrency` is the maximum number of tasks in flight at once for a single
 *   participant worker.
 * - `participants` lists the providers to benchmark; the same task runs for each.
 */
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-hello-world',
  benchmarkName: 'Examples: Hello World',
  iterations: 3,
  concurrency: 1,
  participants: [createNoopParticipant('noop', 100)],
});

/**
 * The task is the per-iteration workload.
 *
 * `defineTask<NoopParticipant>` tells TypeScript the participant type so the
 * task body can access `participant.createCompute()`. The context also gives
 * `step`, `measure`, and `log`.
 */
export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log }) => {
  // `log` appends a free-form line to the worker log artifact. It is useful for
  // narrating what the task is doing; the return value is not recorded.
  log('starting hello-world iteration');

  // `participant.createCompute()` is specific to the mock provider in this
  // example; a real benchmark would call the provider SDK.
  const compute = participant.createCompute();

  // We capture our own start time because the runner's wall-clock timing
  // includes the `destroy` step; for TTI we want create-through-first-command.
  const start = performance.now();

  // `step(name, fn)` runs `fn`, returns its value, and records a step record
  // with timing, status, and any data measured inside it.
  const sandbox = await step('create', () => compute.sandbox.create());
  try {
    const result = await step('exec', () => sandbox.runCommand('node -v'));

    // `measure(data)` merges JSON into the currently active step, or into the
    // task record if called outside a step. Here we attach the TTI and exit code
    // to the task record's `data`.
    measure({ ttiMs: performance.now() - start, exitCode: result.exitCode });
  } finally {
    // `reportConcurrency: false` tells the worker not to count this step in its
    // concurrency heartbeat samples; cleanup steps typically do not run while
    // other tasks are also being launched.
    await step('destroy', () => sandbox.destroy(), { reportConcurrency: false });
  }
});
