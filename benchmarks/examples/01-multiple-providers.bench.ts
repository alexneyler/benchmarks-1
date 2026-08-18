/**
 * Multi-provider benchmark.
 *
 * Demonstrates running the same task against several participants. The runner
 * first filters out any participants whose `requiredEnvVars` are missing, then
 * executes the task once per selected provider.
 *
 * Run with all providers:
 *   bench run benchmarks/examples/01-multiple-providers.bench.ts --iterations 5 --concurrency 2
 *
 * Run with a subset:
 *   bench run benchmarks/examples/01-multiple-providers.bench.ts --iterations 5 --provider alpha,beta
 *
 * Add `--no-ingest` to run without a platform endpoint or API key.
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { exampleProviders } from './participants.js';

/**
 * The config reuses `exampleProviders` from `participants.ts`. Each provider
 * gets its own worker on the platform, and the same `task` is invoked for
 * every iteration of every provider.
 *
 * - `iterations: 5` means each provider runs the task 5 times.
 * - `concurrency: 2` means up to 2 of those tasks are in flight at once for a
 *   given provider's worker.
 * - `--provider alpha,beta` would limit the run to just those two names.
 */
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-multiple-providers',
  benchmarkName: 'Examples: Multiple Providers',
  iterations: 5,
  concurrency: 2,
  participants: exampleProviders,
});

/**
 * The task body is identical to the hello-world example, but `participant`
 * changes per worker: the runner first completes all iterations for `alpha`,
 * then `beta`, then `gamma` (default `groupBy: 'participant'`).
 */
export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log }) => {
  // Because the same task runs for every provider, logging the provider name
  // makes the worker log easy to read.
  log(`running on ${participant.name}`);

  const compute = participant.createCompute();
  const start = performance.now();

  const sandbox = await step('create', () => compute.sandbox.create());
  try {
    const result = await step('exec', () => sandbox.runCommand('node -v'));
    measure({ ttiMs: performance.now() - start, exitCode: result.exitCode });
  } finally {
    await step('destroy', () => sandbox.destroy(), { reportConcurrency: false });
  }
});
