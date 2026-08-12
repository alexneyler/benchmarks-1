/**
 * Round-robin benchmark.
 *
 * Demonstrates `groupBy: 'round'`. In this mode every participant runs its Nth
 * task before any participant starts its (N+1)th, so the Nth tasks of all
 * providers happen back-to-back under the same conditions. The runner builds
 * the task records manually and streams them to the platform via a reporter.
 *
 * Run with:
 *   bench run benchmarks/examples/03-round-robin.bench.ts --iterations 4 --concurrency 1 --group-by round
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { exampleProviders } from './participants.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-round-robin',
  benchmarkName: 'Examples: Round Robin',
  iterations: 4,
  concurrency: 1,
  groupBy: 'round',
  participants: exampleProviders,
});

export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log, taskIndex }) => {
  log(`round ${taskIndex + 1} for ${participant.name}`);

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
