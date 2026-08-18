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
 *
 * Add `--no-ingest` to run without a platform endpoint or API key.
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { exampleProviders } from './participants.js';

/**
 * `groupBy: 'round'` changes execution order:
 *
 *   Round 0: alpha task 0, beta task 0, gamma task 0
 *   Round 1: alpha task 1, beta task 1, gamma task 1
 *   ...
 *
 * This is useful when you want the Nth iteration of every provider to start at
 * roughly the same wall-clock time, rather than finishing all iterations for
 * one provider before moving to the next.
 *
 * `concurrency` is set to 1 here because the round-robin path runs one task per
 * round; the ordering is the primary concern, not per-participant burst.
 */
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-round-robin',
  benchmarkName: 'Examples: Round Robin',
  iterations: 4,
  concurrency: 1,
  groupBy: 'round',
  participants: exampleProviders,
});

/**
 * `taskIndex` is the zero-based slot index within the participant's assignment.
 * In round mode it effectively represents the round number, so we log it to
 * make the ordering visible in the worker log.
 */
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
